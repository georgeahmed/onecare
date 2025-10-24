import { withMessageGuards } from '@onecare/bus';
import type { MessageBus } from '@onecare/bus';
import { createEnvelope, Topics, type DlqEvent, type PortalNotify, type TypedEnvelope } from '@onecare/events';
import { createCounter, logger } from '@onecare/observability';
import { validate, type ValidationError } from '@onecare/domain/src/schema/validator';

import { computePortalNotifyKey } from '../util/idempotency';

const PORTAL_NOTIFY_SCHEMA_ID = 'https://onecare/schemas/portal/notify.json';
const DLQ_SCHEMA_ID = 'https://onecare.example/schemas/common/dlq-event.json';

type SleepFn = (ms: number) => Promise<void>;
type RandomFn = () => number;
type NowFn = () => Date;

const defaultSleep: SleepFn = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const defaultNow: NowFn = () => new Date();

const portalEventRetryCounter = createCounter('event.retry_total');
const portalEventDlqCounter = createCounter('event.dlq_total');
const portalEventPublishErrorCounter = createCounter('event.publish_error_total');

export type PortalNotifyPublishRequest = PortalNotify & { correlationId?: string };

export interface PortalNotifyPublisher {
  publish(request: PortalNotifyPublishRequest): Promise<void>;
}

export class PortalNotifyValidationError extends Error {
  constructor(public readonly details: ValidationError[]) {
    super('portal.notify payload failed validation');
    this.name = 'PortalNotifyValidationError';
  }
}

export interface ReliablePortalNotifyPublisherOptions {
  bus: MessageBus;
  dlqTopic?: string;
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  random?: RandomFn;
  sleep?: SleepFn;
  now?: NowFn;
}

export class ReliablePortalNotifyPublisher implements PortalNotifyPublisher {
  private readonly bus: MessageBus;
  private readonly dlqTopic: string;
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly random: RandomFn;
  private readonly sleep: SleepFn;
  private readonly now: NowFn;

  constructor(opts: ReliablePortalNotifyPublisherOptions) {
    if (!opts.bus) {
      throw new Error('portal_notify_bus_missing');
    }
    this.dlqTopic = opts.dlqTopic ?? Topics.broker.deadLetter;
    this.bus = withMessageGuards(opts.bus, {
      allowedTopics: new Set([Topics.portal.notify, this.dlqTopic]),
    });
    this.maxAttempts = Math.max(1, opts.maxAttempts ?? 3);
    this.baseDelayMs = Math.max(0, opts.baseDelayMs ?? 200);
    this.maxDelayMs = Math.max(this.baseDelayMs, opts.maxDelayMs ?? 2_000);
    this.random = opts.random ?? Math.random;
    this.sleep = opts.sleep ?? defaultSleep;
    this.now = opts.now ?? defaultNow;
  }

  public async publish(request: PortalNotifyPublishRequest): Promise<void> {
    const payload: PortalNotify = {
      practiceId: request.practiceId,
      state: request.state,
      reasonCode: request.reasonCode,
      at: request.at,
    };

    const result = validate(PORTAL_NOTIFY_SCHEMA_ID, payload);
    if (!result.ok) {
      throw new PortalNotifyValidationError(result.errors);
    }

    const correlationId = normalizeCorrelationId(request.correlationId);
    const firstSeenAt = this.now().toISOString();
    const envelope = createEnvelope(Topics.portal.notify, payload, correlationId, {
      attempt: 0,
      firstSeenAt,
    });
    const idempotencyKey = computePortalNotifyKey(payload.practiceId, payload.state, payload.at);
    const headers = this.buildHeaders(correlationId, idempotencyKey);

    let attempt = 0;
    let lastError: unknown;

    while (attempt < this.maxAttempts) {
      attempt += 1;
      envelope.metadata = {
        attempt,
        firstSeenAt,
      };
      headers['x-attempt'] = String(attempt);
      headers['x-first-seen-at'] = firstSeenAt;
      try {
        await this.bus.publish(Topics.portal.notify, envelope, headers);
        logger.info('portal.notify.published', {
          practiceId: payload.practiceId,
          state: payload.state,
          attempt,
          idempotencyKey,
          correlationId,
        });
        return;
      } catch (error) {
        lastError = error;
        const retryable = this.isRetryable(error);
        const errorCode = this.extractErrorCode(error) ?? 'unknown';
        portalEventPublishErrorCounter.add(1, {
          topic: Topics.portal.notify,
          code: errorCode,
        });
        logger.warn('portal.notify.publish_failed', {
          practiceId: payload.practiceId,
          state: payload.state,
          attempt,
          retryable,
          correlationId,
          code: errorCode,
        });

        if (!retryable || attempt >= this.maxAttempts) {
          break;
        }

        portalEventRetryCounter.add(1, {
          topic: Topics.portal.notify,
          code: errorCode,
        });
        const delay = this.computeBackoff(attempt);
        if (delay > 0) {
          await this.sleep(delay);
        }
      }
    }

    if (lastError) {
      const dlqCode = this.extractErrorCode(lastError) ?? 'unknown';
      portalEventDlqCounter.add(1, {
        topic: Topics.portal.notify,
        code: dlqCode,
      });
      await this.publishDlq(envelope, idempotencyKey, request, lastError).catch((dlqError) => {
        logger.error('portal.notify.dlq_publish_failed', {
          practiceId: request.practiceId,
          state: request.state,
          correlationId,
          reason: this.errorMessage(dlqError),
        });
      });
    }
  }

  private buildHeaders(correlationId: string | undefined, idempotencyKey: string): Record<string, string> {
    const headers: Record<string, string> = {
      'x-idempotency-key': idempotencyKey,
    };
    if (correlationId) {
      headers['x-correlation-id'] = correlationId;
    }
    return headers;
  }

  private computeBackoff(attempt: number): number {
    if (this.baseDelayMs === 0) {
      return 0;
    }
    const exponential = this.baseDelayMs * Math.pow(2, attempt - 1);
    const jitter = Math.floor(this.random() * this.baseDelayMs);
    const delay = exponential + jitter;
    return Math.min(delay, this.maxDelayMs);
  }

  private isRetryable(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;

    const retryableFlag = (error as { retryable?: boolean }).retryable;
    if (typeof retryableFlag === 'boolean') {
      return retryableFlag;
    }

    const code = this.extractErrorCode(error);
    if (!code) return false;

    const normalised = code.toLowerCase();
    return (
      normalised.includes('timeout') ||
      normalised.includes('temporarily_unavailable') ||
      normalised.includes('econnreset') ||
      normalised.includes('etimedout') ||
      normalised.includes('eai_again') ||
      normalised.includes('503') ||
      normalised.includes('429')
    );
  }

  private extractErrorCode(error: unknown): string | undefined {
    if (!error || typeof error !== 'object') return undefined;
    const code = (error as { code?: unknown }).code ?? (error as { name?: unknown }).name;
    return typeof code === 'string' && code.trim().length > 0 ? code : undefined;
  }

  private errorMessage(error: unknown): string | undefined {
    if (!error) return undefined;
    if (typeof error === 'string') return error;
    if (error instanceof Error) return error.message;
    return undefined;
  }

  private async publishDlq(
    envelope: TypedEnvelope<PortalNotify>,
    idempotencyKey: string,
    request: PortalNotifyPublishRequest,
    error: unknown,
  ): Promise<void> {
    const errorMessage = this.errorMessage(error);
    const corr = envelope.correlationId ?? request.correlationId;
    const payloadRef: Record<string, unknown> = {
      practiceId: request.practiceId,
      state: request.state,
      at: request.at,
      idempotencyKey,
      envelopeId: envelope.id,
    };
    if (request.reasonCode) {
      payloadRef.reasonCode = request.reasonCode;
    }

    const dlqPayload: DlqEvent = {
      originalTopic: Topics.portal.notify,
      correlationId: corr,
      errorCode: this.extractErrorCode(error),
      errorMessage: errorMessage ? truncate(errorMessage, 256) : undefined,
      payloadRef,
      ts: this.now().toISOString(),
    };

    const validation = validate(DLQ_SCHEMA_ID, dlqPayload);
    if (!validation.ok) {
      throw new PortalNotifyValidationError(validation.errors);
    }

    const headers = this.buildDlqHeaders(corr, Topics.portal.notify);
    const dlqEnvelope = createEnvelope(this.dlqTopic, dlqPayload, corr);
    await this.bus.publish(dlqEnvelope.topic, dlqEnvelope, headers);

    logger.error('portal.notify.routed_to_dlq', {
      practiceId: request.practiceId,
      state: request.state,
      correlationId: corr,
      idempotencyKey,
      dlqTopic: this.dlqTopic,
      code: this.extractErrorCode(error),
    });
  }

  private buildDlqHeaders(correlationId: string | undefined, originalTopic: string): Record<string, string> {
    const headers: Record<string, string> = {
      'x-original-topic': originalTopic,
    };
    if (correlationId) {
      headers['x-correlation-id'] = correlationId;
    }
    return headers;
  }
}

function truncate(input: string, max: number): string {
  if (input.length <= max) {
    return input;
  }
  if (max <= 3) {
    return '.'.repeat(max);
  }
  return `${input.slice(0, max - 3)}...`;
}

function normalizeCorrelationId(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
