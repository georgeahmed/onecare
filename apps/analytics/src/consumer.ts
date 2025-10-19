import type { MessageBus, Subscription } from '@onecare/bus';
import { getBus, withMessageGuards } from '@onecare/bus';
import { Topics, type TypedEnvelope, createEnvelope } from '@onecare/events';
import type { IdempotencyStore } from '@onecare/ports';
import { executeWithIdempotency } from '@onecare/ports';
import type { Metric } from '@onecare/events';
import { validate, type ValidationError } from '@onecare/domain';
import {
  logger,
  setCorrelationId,
  withCorrelationContext,
  ensureTracing,
  createCounter,
  createHistogram,
} from '@onecare/observability';
import type { AnalyticsSink } from './sink/fileSink';
import { createFileSink } from './sink/fileSink';

ensureTracing('analytics-consumer');

const METRIC_SCHEMA_ID = 'https://onecare/schemas/analytics/metric.json';
const ANALYTICS_ALLOWED_TOPICS = new Set<string>([Topics.analytics.metric, Topics.broker.deadLetter]);
const LABEL_ALLOWLIST = new Set<string>(['service', 'topic', 'status', 'outcomeCode', 'result', 'source']);
const MAX_LABEL_VALUE_LENGTH = 120;
const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const PHONE_PATTERN = /\b(?:\+?\d[\d\s-]){7,}\d\b/;
const TOKEN_PATTERN = /\b[A-Za-z0-9-_]{20,}\b/;

const ingestOkCounter = createCounter('analytics.ingest.ok');
const ingestErrorCounter = createCounter('analytics.ingest.error');
const ingestRetryCounter = createCounter('analytics.ingest.retry');
const ingestDlqCounter = createCounter('analytics.ingest.dlq');
const ingestLagHistogram = createHistogram('analytics.ingest.lag_ms');
const sinkLatencyHistogram = createHistogram('analytics.sink.latency_ms');

interface RetryPolicyOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitterRatio?: number;
}

interface NormalizedRetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitterRatio: number;
}

const DEFAULT_RETRY_POLICY: NormalizedRetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 100,
  maxDelayMs: 1000,
  jitterRatio: 0.2,
};

export class AnalyticsMetricValidationError extends Error {
  constructor(
    public readonly correlationId: string | undefined,
    public readonly errors: ValidationError[]
  ) {
    super('analytics.metric payload failed validation');
    this.name = 'AnalyticsMetricValidationError';
  }
}

export class AnalyticsMetricSinkError extends Error {
  constructor(
    public readonly correlationId: string | undefined,
    public readonly cause: unknown
  ) {
    super('failed to persist analytics.metric payload');
    this.name = 'AnalyticsMetricSinkError';
  }
}

interface AnalyticsConsumerOptions {
  bus?: MessageBus;
  sink?: AnalyticsSink;
  schemaId?: string;
  idempotencyStore?: IdempotencyStore;
  idempotencyTtlSeconds?: number;
  retryPolicy?: RetryPolicyOptions;
}

export class AnalyticsConsumer {
  private readonly bus: MessageBus;
  private readonly sink: AnalyticsSink;
  private readonly schemaId: string;
  private subscription: Subscription | null = null;
  private readonly idempotencyStore?: IdempotencyStore;
  private readonly idempotencyTtlSeconds: number;
  private readonly retryPolicy: NormalizedRetryPolicy;

  constructor(options: AnalyticsConsumerOptions = {}) {
    const baseBus = options.bus ?? getBus();
    this.bus = withMessageGuards(baseBus, {
      allowedTopics: ANALYTICS_ALLOWED_TOPICS,
    });
    this.sink = options.sink ?? createFileSink();
    this.schemaId = options.schemaId ?? METRIC_SCHEMA_ID;
    this.idempotencyStore = options.idempotencyStore;
    const ttl = options.idempotencyTtlSeconds;
    this.idempotencyTtlSeconds = typeof ttl === 'number' && Number.isFinite(ttl) && ttl > 0 ? ttl : 5 * 60;
    this.retryPolicy = normalizeRetryPolicy(options.retryPolicy);
  }

  async start(): Promise<void> {
    if (this.subscription) return;
    this.subscription = await this.bus.subscribe<TypedEnvelope<Metric>>(Topics.analytics.metric, async ({ payload }) => {
      await this.processEnvelope(payload);
    });
    logger.info('analytics consumer subscribed', { topic: Topics.analytics.metric });
  }

  async stop(): Promise<void> {
    if (!this.subscription) return;
    await this.subscription.unsubscribe();
    this.subscription = null;
    logger.info('analytics consumer unsubscribed', { topic: Topics.analytics.metric });
  }

  private async processEnvelope(envelope: TypedEnvelope<Metric>): Promise<void> {
    await withCorrelationContext(async () => {
      const correlationId = envelope.correlationId;
      if (correlationId) {
        setCorrelationId(correlationId);
      }

      const metric = envelope.payload;
      const validation = validate(this.schemaId, metric);
      if (!validation.ok) {
        logger.warn('analytics.metric payload failed validation', {
          correlationId,
          errors: validation.errors,
        });
        ingestErrorCounter.add(1, { metricName: metric?.name ?? 'unknown', reason: 'validation_failed' });
        await this.publishToDlq('validation_failed', envelope, {
          errors: validation.errors.slice(0, 5),
        });
        return;
      }

      const sanitizedMetric = sanitizeMetric(metric);
      const ingestLag = computeLagMs(sanitizedMetric.timestamp);
      if (ingestLag !== null) {
        ingestLagHistogram.record(ingestLag, {
          metricName: sanitizedMetric.name,
        });
      }

      const idempotencyKey = this.deriveIdempotencyKey(envelope);
      await this.persistWithRetry({
        envelope,
        metric: sanitizedMetric,
        idempotencyKey,
        correlationId,
      });
    });
  }

  private deriveIdempotencyKey(envelope: TypedEnvelope<Metric>): string {
    if (envelope.id) {
      return `analytics:${envelope.id}`;
    }
    const metric = envelope.payload;
    const timestamp = metric.timestamp ?? 'unknown-ts';
    return `analytics:${metric.name}:${timestamp}`;
  }

  private async persistWithRetry(input: {
    envelope: TypedEnvelope<Metric>;
    metric: Metric;
    idempotencyKey: string;
    correlationId?: string;
  }): Promise<void> {
    const { envelope, metric, idempotencyKey, correlationId } = input;
    const attributes = {
      metricName: metric.name,
    };

    for (let attempt = 1; attempt <= this.retryPolicy.maxAttempts; attempt += 1) {
      const attemptStart = Date.now();
      try {
        const result = await executeWithIdempotency({
          store: this.idempotencyStore,
          key: idempotencyKey,
          ttlSeconds: this.idempotencyTtlSeconds,
          execute: async () => {
            try {
              await this.sink.write(metric);
            } catch (err: unknown) {
              logger.error('analytics metric persistence failed', {
                correlationId,
                metricName: metric.name,
                error: err instanceof Error ? err.message : err,
              });
              throw new AnalyticsMetricSinkError(correlationId, err);
            }
            return true;
          },
          onDuplicate: () => {
            logger.warn('analytics.metric.duplicate_suppressed', {
              correlationId,
              metricName: metric.name,
              idempotencyKey,
            });
          },
          onError: (error) => {
            logger.error('analytics.metric.idempotency_failed', {
              correlationId,
              metricName: metric.name,
              idempotencyKey,
              reason: error instanceof Error ? error.message : 'unknown_error',
            });
          },
        });

        if (result.status === 'skipped') {
          ingestOkCounter.add(1, { ...attributes, duplicate: true });
          return;
        }

        const latency = Date.now() - attemptStart;
        sinkLatencyHistogram.record(latency, attributes);
        ingestOkCounter.add(1, { ...attributes, attempt });
        logger.info('analytics metric persisted', {
          correlationId,
          metricName: metric.name,
          labelKeys: Object.keys(metric.labels ?? {}),
          idempotencyKey,
          attempt,
        });
        return;
      } catch (error) {
        const retryable = this.isRetryableError(error);
        const finalAttempt = attempt >= this.retryPolicy.maxAttempts || !retryable;
        if (!finalAttempt) {
          ingestRetryCounter.add(1, { ...attributes, attempt });
          const delay = calculateDelay(this.retryPolicy, attempt);
          logger.warn('analytics.metric.retry_scheduled', {
            correlationId,
            metricName: metric.name,
            attempt,
            delayMs: delay,
          });
          await sleep(delay);
          continue;
        }

        ingestErrorCounter.add(1, { ...attributes, attempt, reason: classifyError(error) });
        ingestDlqCounter.add(1, { ...attributes, attempt, reason: classifyError(error) });
        await this.publishToDlq('persistence_failed', envelope, {
          attempt,
          error: error instanceof Error ? error.message : 'unknown_error',
        });
        return;
      }
    }
  }

  private isRetryableError(error: unknown): boolean {
    if (error instanceof AnalyticsMetricValidationError) {
      return false;
    }
    return true;
  }

  private async publishToDlq(
    cause: 'validation_failed' | 'persistence_failed',
    sourceEnvelope: TypedEnvelope<Metric>,
    details: Record<string, unknown>
  ): Promise<void> {
    const correlationId = sourceEnvelope.correlationId;
    const dlqPayload = {
      cause: `analytics.metric.${cause}`,
      originalTopic: sourceEnvelope.topic,
      envelopeId: sourceEnvelope.id,
      correlationId,
      metricName: sourceEnvelope.payload.name,
      details,
    };
    const dlqEnvelope = createEnvelope(Topics.broker.deadLetter, dlqPayload, correlationId);
    try {
      await this.bus.publish(
        Topics.broker.deadLetter,
        dlqEnvelope,
        correlationId ? { 'x-correlation-id': correlationId } : undefined
      );
      logger.warn('analytics.metric.dlq_published', {
        correlationId,
        metricName: sourceEnvelope.payload.name,
        cause,
      });
    } catch (err) {
      logger.error('analytics.metric.dlq_publish_failed', {
        correlationId,
        metricName: sourceEnvelope.payload.name,
        cause,
        error: err instanceof Error ? err.message : err,
      });
    }
  }
}

export async function startAnalyticsConsumer(options?: AnalyticsConsumerOptions): Promise<AnalyticsConsumer> {
  const consumer = new AnalyticsConsumer(options);
  await consumer.start();
  return consumer;
}

function normalizeRetryPolicy(policy?: RetryPolicyOptions): NormalizedRetryPolicy {
  if (!policy) {
    return DEFAULT_RETRY_POLICY;
  }

  const sanitizeFinite = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) ? value : undefined;

  const attemptsCandidate = sanitizeFinite(policy.maxAttempts);
  const maxAttempts = Math.max(
    1,
    Math.min(6, Math.floor(attemptsCandidate ?? DEFAULT_RETRY_POLICY.maxAttempts))
  );

  const baseDelayCandidate = sanitizeFinite(policy.baseDelayMs);
  const baseDelayMs = Math.max(
    0,
    Math.floor(baseDelayCandidate ?? DEFAULT_RETRY_POLICY.baseDelayMs)
  );

  const maxDelayCandidate = sanitizeFinite(policy.maxDelayMs);
  const maxDelayMs = Math.max(
    baseDelayMs,
    Math.floor(maxDelayCandidate ?? DEFAULT_RETRY_POLICY.maxDelayMs)
  );

  const jitterCandidate = sanitizeFinite(policy.jitterRatio);
  const jitterRatio = Math.max(
    0,
    Math.min(1, jitterCandidate ?? DEFAULT_RETRY_POLICY.jitterRatio)
  );

  return {
    maxAttempts,
    baseDelayMs,
    maxDelayMs,
    jitterRatio,
  };
}

function calculateDelay(policy: NormalizedRetryPolicy, attempt: number): number {
  const exponential = policy.baseDelayMs * 2 ** (attempt - 1);
  const capped = Math.min(exponential, policy.maxDelayMs);
  if (policy.jitterRatio <= 0) {
    return capped;
  }
  const jitterWindow = capped * policy.jitterRatio;
  const min = Math.max(0, capped - jitterWindow);
  const max = capped + jitterWindow;
  return Math.round(min + Math.random() * (max - min));
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function computeLagMs(timestamp?: string): number | null {
  if (!timestamp) return null;
  const parsed = Date.parse(timestamp);
  if (Number.isNaN(parsed)) return null;
  return Date.now() - parsed;
}

function sanitizeMetric(metric: Metric): Metric {
  const sanitizedLabels = sanitizeLabels(metric.labels);
  const next: Metric = {
    name: metric.name,
    value: metric.value,
  };
  if (metric.timestamp) {
    next.timestamp = metric.timestamp;
  }
  if (sanitizedLabels) {
    next.labels = sanitizedLabels;
  }
  return next;
}

function sanitizeLabels(labels?: Record<string, string>): Record<string, string> | undefined {
  if (!labels) return undefined;
  const sanitized: Record<string, string> = {};
  for (const [key, originalValue] of Object.entries(labels)) {
    if (!LABEL_ALLOWLIST.has(key)) continue;
    if (typeof originalValue !== 'string') continue;
    let value = originalValue.trim();
    if (!value) continue;
    value = applyRedaction(value);
    if (!value) continue;
    if (value.length > MAX_LABEL_VALUE_LENGTH) {
      value = `${value.slice(0, MAX_LABEL_VALUE_LENGTH)}…`;
    }
    sanitized[key] = value;
  }
  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

function applyRedaction(value: string): string {
  if (EMAIL_PATTERN.test(value)) {
    return '[redacted-email]';
  }
  if (PHONE_PATTERN.test(value)) {
    return '[redacted-phone]';
  }
  if (TOKEN_PATTERN.test(value)) {
    return '[redacted-token]';
  }
  return value;
}

function classifyError(error: unknown): string {
  if (error instanceof AnalyticsMetricValidationError) {
    return 'validation_failed';
  }
  if (error instanceof AnalyticsMetricSinkError) {
    return 'sink_error';
  }
  if (error instanceof Error) {
    return error.name ?? 'error';
  }
  return 'unknown';
}
