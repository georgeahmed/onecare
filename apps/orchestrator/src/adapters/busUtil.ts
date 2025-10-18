import { setTimeout as delay } from 'node:timers/promises';
import type { MessageBus } from '@onecare/bus';
import { Topics, type TypedEnvelope, createEnvelope } from '@onecare/events';
import type { DlqEvent } from '@onecare/events/src/contracts/dlq-event';
import { validate } from '@onecare/domain';
import { createCounter, createHistogram, logger } from '@onecare/observability';

const publishOkCounter = createCounter('publish.ok');
const publishRetryCounter = createCounter('publish.retry');
const publishFailCounter = createCounter('publish.fail');
const publishDurationHistogram = createHistogram('publish.duration');

const DLQ_SCHEMA_ID = 'https://onecare/schemas/common/dlq-event.json';

class PublishTimeoutError extends Error {
  constructor() {
    super('publish_timeout');
    this.name = 'PublishTimeoutError';
  }
}

export interface PublishRetryOptions<TPayload> {
  bus: MessageBus;
  envelope: TypedEnvelope<TPayload>;
  headers?: Record<string, string>;
  correlationId?: string;
  idempotencyKey?: string;
  timeoutMs: number;
  maxAttempts: number;
  baseDelayMs: number;
  payloadRef?: Record<string, unknown> | string;
}

function buildHeaders(
  envelope: TypedEnvelope<unknown>,
  headers: Record<string, string> | undefined,
  correlationId: string | undefined,
  idempotencyKey: string | undefined,
): Record<string, string> {
  const merged: Record<string, string> = { ...(headers ?? {}) };
  if (correlationId && !merged['x-correlation-id']) {
    merged['x-correlation-id'] = correlationId;
  }
  if (!merged['x-message-id']) {
    merged['x-message-id'] = envelope.id;
  }
  const key = idempotencyKey ?? envelope.id;
  if (!merged['x-idempotency-key']) {
    merged['x-idempotency-key'] = key;
  }
  return merged;
}

function extractErrorCode(err: unknown): string | undefined {
  if (err && typeof err === 'object') {
    const withCode = err as { code?: unknown; name?: unknown };
    const value = withCode.code ?? withCode.name;
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }
  if (typeof err === 'string' && err.trim().length > 0) {
    return err.trim();
  }
  return undefined;
}

async function publishOnce<T>(
  bus: MessageBus,
  envelope: TypedEnvelope<T>,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<void> {
  if (timeoutMs <= 0) {
    await bus.publish(envelope.topic, envelope, headers);
    return;
  }

  let timedOut = false;
  const publishPromise = bus.publish(envelope.topic, envelope, headers);
  let timeoutHandle: NodeJS.Timeout | undefined;

  try {
    await Promise.race([
      publishPromise,
      new Promise<void>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          timedOut = true;
          reject(new PublishTimeoutError());
        }, timeoutMs);
      }),
    ]);
  } catch (error) {
    if (timedOut) {
      // Prevent unhandled rejection on the original promise.
      publishPromise.catch(() => {});
      throw error;
    }
    throw error;
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
  // Surface any rejection from the original publish.
  await publishPromise;
}

async function publishDlq(
  bus: MessageBus,
  originalTopic: string,
  correlationId: string | undefined,
  attempts: number,
  error: unknown,
  payloadRef: Record<string, unknown> | string | undefined,
): Promise<void> {
  const dlqPayload: DlqEvent = {
    originalTopic,
    correlationId,
    errorCode: extractErrorCode(error),
    errorMessage: error instanceof Error ? error.message : undefined,
    attempts,
    payloadRef,
    ts: new Date().toISOString(),
  };

  const validation = validate(DLQ_SCHEMA_ID, dlqPayload);
  if (!validation.ok) {
    logger.error('publish.dlq.invalid', {
      originalTopic,
      correlationId,
      errors: validation.errors.slice(0, 3),
    });
    return;
  }

  try {
    const dlqEnvelope = createEnvelope(Topics.broker.deadLetter, dlqPayload, correlationId);
    const headers: Record<string, string> = {
      'x-message-id': dlqEnvelope.id,
      'x-idempotency-key': `${originalTopic}:${dlqEnvelope.id}`,
    };
    if (correlationId) {
      headers['x-correlation-id'] = correlationId;
    }
    await bus.publish(dlqEnvelope.topic, dlqEnvelope, headers);
  } catch (dlqError) {
    logger.error('publish.dlq.failed', {
      originalTopic,
      correlationId,
      reason: dlqError instanceof Error ? dlqError.message : String(dlqError),
    });
  }
}

export async function publishWithRetry<TPayload>(options: PublishRetryOptions<TPayload>): Promise<void> {
  const {
    bus,
    envelope,
    correlationId,
    timeoutMs,
    maxAttempts,
    baseDelayMs,
    payloadRef,
  } = options;
  const headers = buildHeaders(envelope, options.headers, correlationId, options.idempotencyKey);
  const attempts = Math.max(1, maxAttempts);
  const start = process.hrtime.bigint();

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await publishOnce(bus, envelope, headers, timeoutMs);
      const durationMs = Number(process.hrtime.bigint() - start) / 1_000_000;
      publishDurationHistogram.record(durationMs, { topic: envelope.topic });
      publishOkCounter.add(1, { topic: envelope.topic, attempts: attempt });
      return;
    } catch (error) {
      if (attempt < attempts) {
        publishRetryCounter.add(1, {
          topic: envelope.topic,
          attempt,
          reason: extractErrorCode(error),
        });
        const exponential = baseDelayMs * 2 ** (attempt - 1);
        const jitter = Math.floor(Math.random() * baseDelayMs);
        const delayMs = Math.min(exponential + jitter, 10_000);
        await delay(delayMs);
        continue;
      }

      publishFailCounter.add(1, {
        topic: envelope.topic,
        attempts: attempt,
        reason: extractErrorCode(error),
      });
      await publishDlq(bus, envelope.topic, correlationId, attempt, error, payloadRef);
      throw error;
    }
  }
}
