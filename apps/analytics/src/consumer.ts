import type { MessageBus, Subscription } from '@onecare/bus';
import { getBus, withMessageGuards, isGuardedBus } from '@onecare/bus';
import { Topics, type TypedEnvelope, createEnvelope } from '@onecare/events';
import type { IdempotencyStore } from '@onecare/ports';
import { executeWithIdempotency } from '@onecare/ports';
import type { Metric } from '@onecare/events';
import { validate, type ValidationError } from '@onecare/domain';
import { createInMemoryIdempotencyStore } from './idempotencyStore';
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
const DEFAULT_LABEL_KEYS = ['service', 'topic', 'status', 'outcomeCode', 'result', 'source'];
const { allowAllLabels: ALLOW_ALL_LABELS, keys: LABEL_ALLOWLIST } = buildLabelPolicy(
  process.env.ANALYTICS_LABEL_ALLOWLIST ?? ''
);
const MAX_LABEL_VALUE_LENGTH = 120;
const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const PHONE_PATTERN = /\b(?:\+?\d[\d\s-]){7,}\d\b/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{20,}$/;

const ingestOkCounter = createCounter('analytics_ingest_ok_total');
const ingestErrorCounter = createCounter('analytics_ingest_error_total');
const ingestRetryCounter = createCounter('analytics_ingest_retry_total');
const ingestDuplicateCounter = createCounter('analytics_ingest_duplicate_total');
const ingestDlqCounter = createCounter('analytics_ingest_dlq_total');
const ingestLagHistogram = createHistogram('analytics_ingest_lag_ms');
const sinkLatencyHistogram = createHistogram('analytics_sink_latency_ms');

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

const DEFAULT_IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;

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

export class AnalyticsMetricDlqPublishError extends Error {
  constructor(
    public readonly correlationId: string | undefined,
    public readonly cause: unknown
  ) {
    super('failed to publish analytics.metric payload to DLQ');
    this.name = 'AnalyticsMetricDlqPublishError';
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
  private readonly idempotencyStore: IdempotencyStore;
  private readonly idempotencyTtlSeconds: number;
  private readonly retryPolicy: NormalizedRetryPolicy;

  constructor(options: AnalyticsConsumerOptions = {}) {
    this.idempotencyStore = options.idempotencyStore ?? createInMemoryIdempotencyStore();
    const ttl = options.idempotencyTtlSeconds;
    this.idempotencyTtlSeconds =
      typeof ttl === 'number' && Number.isFinite(ttl) && ttl > 0 ? Math.floor(ttl) : DEFAULT_IDEMPOTENCY_TTL_SECONDS;
    this.sink = options.sink ?? createFileSink();
    this.schemaId = options.schemaId ?? METRIC_SCHEMA_ID;
    this.retryPolicy = normalizeRetryPolicy(options.retryPolicy);

    const baseBus = options.bus ?? getBus();
    this.bus = isGuardedBus(baseBus)
      ? baseBus
      : withMessageGuards(baseBus, {
          allowedTopics: ANALYTICS_ALLOWED_TOPICS,
        });
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
          errorCount: validation.errors.length,
          errors: sanitizeValidationErrors(validation.errors),
        });
        ingestErrorCounter.add(1, { metricName: metric?.name ?? 'unknown', reason: 'validation_failed' });
        await this.publishToDlq({
          cause: 'validation_failed',
          sourceEnvelope: envelope,
          attempts: 1,
          metricName: metric?.name ?? 'unknown',
          payloadDetails: {
            errors: sanitizeValidationErrors(validation.errors),
          },
          attributes: {
            metricName: metric?.name ?? 'unknown',
            reason: 'validation_failed',
          },
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

  private deriveIdempotencyKey(envelope: TypedEnvelope<Metric>): string | undefined {
    if (envelope.id && envelope.id.trim().length > 0) {
      return `analytics:${envelope.id.trim()}`;
    }
    return undefined;
  }

  private async persistWithRetry(input: {
    envelope: TypedEnvelope<Metric>;
    metric: Metric;
    idempotencyKey?: string;
    correlationId?: string;
  }): Promise<void> {
    const { envelope, metric, idempotencyKey, correlationId } = input;
    const attributes = {
      metricName: metric.name,
    };

    for (let attempt = 1; attempt <= this.retryPolicy.maxAttempts; attempt += 1) {
      const attemptStart = Date.now();
      try {
        const result = await this.executePersist(metric, {
          idempotencyKey,
          correlationId,
        });

        if (result.status === 'skipped') {
          ingestDuplicateCounter.add(1, { ...attributes });
          logger.warn('analytics.metric.duplicate_suppressed', {
            correlationId,
            metricName: metric.name,
            idempotencyKey,
          });
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
          logger.warn('analytics.metric.retry_deferred', {
            correlationId,
            metricName: metric.name,
            attempt,
          });
          continue;
        }

        const reason = classifyError(error);
        ingestErrorCounter.add(1, { ...attributes, attempt, reason });
        await this.publishToDlq({
          cause: 'persistence_failed',
          sourceEnvelope: envelope,
          attempts: attempt,
          metricName: metric.name,
          errorMessage: error instanceof Error ? error.message : 'unknown_error',
          errorCode: reason,
          payloadDetails: {
            attempt,
          },
          attributes: {
            ...attributes,
            attempt,
            reason,
          },
        });
        return;
      }
    }
  }

  private async executePersist(
    metric: Metric,
    context: { idempotencyKey?: string; correlationId?: string }
  ): Promise<{ status: 'executed' | 'skipped' }> {
    if (!context.idempotencyKey) {
      try {
        await this.sink.write(metric);
        return { status: 'executed' };
      } catch (err: unknown) {
        logger.error('analytics metric persistence failed', {
          correlationId: context.correlationId,
          metricName: metric.name,
          error: err instanceof Error ? err.message : err,
        });
        throw new AnalyticsMetricSinkError(context.correlationId, err);
      }
    }

    return executeWithIdempotency({
      store: this.idempotencyStore,
      key: context.idempotencyKey,
      ttlSeconds: this.idempotencyTtlSeconds,
      execute: async () => {
        try {
          await this.sink.write(metric);
        } catch (err: unknown) {
          logger.error('analytics metric persistence failed', {
            correlationId: context.correlationId,
            metricName: metric.name,
            error: err instanceof Error ? err.message : err,
          });
          throw new AnalyticsMetricSinkError(context.correlationId, err);
        }
        return true;
      },
      onError: (error) => {
        logger.error('analytics.metric.idempotency_failed', {
          correlationId: context.correlationId,
          metricName: metric.name,
          idempotencyKey: context.idempotencyKey,
          reason: error instanceof Error ? error.message : 'unknown_error',
        });
      },
    });
  }

  private isRetryableError(error: unknown): boolean {
    if (error instanceof AnalyticsMetricValidationError) {
      return false;
    }
    return true;
  }

  private async publishToDlq(input: {
    cause: 'validation_failed' | 'persistence_failed';
    sourceEnvelope: TypedEnvelope<Metric>;
    attempts: number;
    metricName: string;
    errorCode?: string;
    errorMessage?: string;
    payloadDetails?: Record<string, unknown>;
    attributes?: Record<string, string | number | boolean>;
  }): Promise<void> {
    const { cause, sourceEnvelope, attempts, metricName, errorCode, errorMessage, payloadDetails, attributes } = input;
    const correlationId = sourceEnvelope.correlationId;
    const payloadRef: Record<string, unknown> = {
      cause: `analytics.metric.${cause}`,
      metricName,
    };
    if (sourceEnvelope.id) {
      payloadRef.envelopeId = sourceEnvelope.id;
    }
    if (payloadDetails && Object.keys(payloadDetails).length > 0) {
      payloadRef.details = payloadDetails;
    }
    const dlqPayload: Record<string, unknown> = {
      originalTopic: sourceEnvelope.topic,
      ts: new Date().toISOString(),
      attempts,
      payloadRef,
    };
    if (correlationId) {
      dlqPayload.correlationId = correlationId;
    }
    if (errorCode) {
      dlqPayload.errorCode = errorCode;
    } else {
      dlqPayload.errorCode = `analytics.metric.${cause}`;
    }
    if (errorMessage) {
      dlqPayload.errorMessage = errorMessage;
    } else {
      dlqPayload.errorMessage =
        cause === 'validation_failed' ? 'analytics.metric payload failed validation' : 'analytics.metric persistence failed';
    }

    const dlqEnvelope = createEnvelope(Topics.broker.deadLetter, dlqPayload, correlationId);
    try {
      await this.bus.publish(
        Topics.broker.deadLetter,
        dlqEnvelope,
        correlationId ? { 'x-correlation-id': correlationId } : undefined
      );
      ingestDlqCounter.add(1, { metricName, cause, ...(attributes ?? {}) });
      logger.warn('analytics.metric.dlq_published', {
        correlationId,
        metricName,
        cause,
      });
    } catch (err) {
      logger.error('analytics.metric.dlq_publish_failed', {
        correlationId,
        metricName,
        cause,
        error: err instanceof Error ? err.message : err,
      });
      throw new AnalyticsMetricDlqPublishError(correlationId, err);
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
  const attemptsSource =
    attemptsCandidate !== undefined && attemptsCandidate > 0
      ? attemptsCandidate
      : DEFAULT_RETRY_POLICY.maxAttempts;
  const maxAttempts = Math.max(1, Math.min(6, Math.floor(attemptsSource)));

  const baseDelayCandidate = sanitizeFinite(policy.baseDelayMs);
  const baseDelaySource =
    baseDelayCandidate !== undefined && baseDelayCandidate >= 0
      ? baseDelayCandidate
      : DEFAULT_RETRY_POLICY.baseDelayMs;
  const baseDelayMs = Math.max(0, Math.floor(baseDelaySource));

  const maxDelayCandidate = sanitizeFinite(policy.maxDelayMs);
  const maxDelaySource =
    maxDelayCandidate !== undefined && maxDelayCandidate >= 0
      ? maxDelayCandidate
      : DEFAULT_RETRY_POLICY.maxDelayMs;
  const maxDelayMs = Math.max(baseDelayMs, Math.floor(maxDelaySource));

  const jitterCandidate = sanitizeFinite(policy.jitterRatio);
  const jitterSource =
    jitterCandidate !== undefined && jitterCandidate >= 0
      ? jitterCandidate
      : DEFAULT_RETRY_POLICY.jitterRatio;
  const jitterRatio = Math.max(0, Math.min(1, jitterSource));

  return {
    maxAttempts,
    baseDelayMs,
    maxDelayMs,
    jitterRatio,
  };
}

function computeLagMs(timestamp?: string): number | null {
  if (!timestamp) return null;
  const parsed = Date.parse(timestamp);
  if (Number.isNaN(parsed)) return null;
  return Math.max(0, Date.now() - parsed);
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
    if (!ALLOW_ALL_LABELS && !LABEL_ALLOWLIST.has(key)) continue;
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
  if (error instanceof AnalyticsMetricDlqPublishError) {
    return 'dlq_publish_failed';
  }
  if (error instanceof Error) {
    return error.name ?? 'error';
  }
  return 'unknown';
}

function sanitizeValidationErrors(errors: ValidationError[]): Array<{ path: string; keyword: string }> {
  return errors.slice(0, 5).map((err) => ({
    path: err.path,
    keyword: err.keyword,
  }));
}

function buildLabelPolicy(config: string): { allowAllLabels: boolean; keys: Set<string> } {
  const base = new Set<string>(DEFAULT_LABEL_KEYS);
  const raw = config
    .split(',')
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
  let allowAll = false;
  for (const token of raw) {
    if (token === '*') {
      allowAll = true;
      continue;
    }
    base.add(token);
  }
  return {
    allowAllLabels: allowAll,
    keys: base,
  };
}
