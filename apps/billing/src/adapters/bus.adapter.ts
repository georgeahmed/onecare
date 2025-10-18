import { setTimeout as sleep } from 'node:timers/promises';
import type { MessageBus } from '@onecare/bus';
import { withMessageGuards } from '@onecare/bus';
import { Topics, createEnvelope, type BillingClaim, type BillingResponse } from '@onecare/events';
import { summariseForDlq } from '@onecare/observability';

export interface PublishOptions {
  timeoutMs?: number;
  maxRetries?: number;
  baseDelayMs?: number;
}

export interface DLQEnvelope<T = unknown> {
  originalTopic: string;
  payload: T;
  correlationId?: string;
  error?: string;
  ts: string;
}

const BILLING_ALLOWED_TOPICS = new Set<string>([
  Topics.billing.claim,
  Topics.billing.response,
  Topics.broker.deadLetter,
]);

const DEFAULT_TIMEOUT_MS = 500;
const DEFAULT_BASE_DELAY_MS = 25;
const DEFAULT_MAX_RETRIES = 2;

export async function publishBillingClaim(
  bus: MessageBus,
  claim: BillingClaim,
  correlationId?: string,
  options: PublishOptions = {},
): Promise<void> {
  const envelope = createEnvelope(Topics.billing.claim, claim, correlationId);
  await publishWithGuard(bus, envelope.topic, envelope, correlationId, options);
}

export async function publishBillingResponse(
  bus: MessageBus,
  response: BillingResponse,
  correlationId?: string,
  options: PublishOptions = {},
): Promise<void> {
  const envelope = createEnvelope(Topics.billing.response, response, correlationId);
  await publishWithGuard(bus, envelope.topic, envelope, correlationId, options);
}

async function publishWithGuard<T extends { topic: string }>(
  bus: MessageBus,
  topic: string,
  payload: T,
  correlationId: string | undefined,
  options: PublishOptions,
): Promise<void> {
  const guardedBus = withMessageGuards(bus, { allowedTopics: BILLING_ALLOWED_TOPICS });
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const headers: Record<string, string> = {};
  if (correlationId && correlationId.trim().length > 0) {
    headers['x-correlation-id'] = correlationId;
  }

  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      await publishWithTimeout(guardedBus, topic, payload, headers, timeoutMs);
      return;
    } catch (error) {
      lastError = error;
      if (attempt === maxRetries) {
        break;
      }
      const backoff = Math.min(5, attempt + 1) * baseDelayMs;
      const jitter = Math.random() * baseDelayMs;
      await sleep(backoff + jitter);
    }
  }

  const dlqPayload: DLQEnvelope<unknown> = {
    originalTopic: topic,
    payload: summariseForDlq ? summariseForDlq(payload) : fallbackDlqSummary(payload),
    correlationId,
    error: lastError instanceof Error ? lastError.message : String(lastError ?? 'unknown_error'),
    ts: new Date().toISOString(),
  };
  const dlqEnvelope = createEnvelope(Topics.broker.deadLetter, dlqPayload, correlationId);
  const dlqHeaders: Record<string, string> = {
    ...headers,
    'x-original-topic': topic,
  };
  await guardedBus.publish(dlqEnvelope.topic, dlqEnvelope, dlqHeaders);
}

function fallbackDlqSummary(payload: unknown): unknown {
  if (!payload || typeof payload !== 'object') {
    return payload;
  }
  const summary: Record<string, string> = {};
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    summary[key] = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
  }
  return { redacted: true, fields: summary };
}

async function publishWithTimeout<T>(
  bus: MessageBus,
  topic: string,
  payload: T,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<void> {
  if (!timeoutMs || timeoutMs <= 0 || !Number.isFinite(timeoutMs)) {
    await bus.publish(topic, payload, headers);
    return;
  }
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      bus.publish(topic, payload, headers),
      new Promise<void>((_, reject) => {
        timer = setTimeout(() => reject(new Error('publish_timeout')), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
