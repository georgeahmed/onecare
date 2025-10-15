import type { MessageBus, Subscription } from '@onecare/bus';
import { getBus, withMessageGuards } from '@onecare/bus';
import { Topics, type TypedEnvelope } from '@onecare/events';
import type { IdempotencyStore } from '@onecare/ports';
import { executeWithIdempotency } from '@onecare/ports';
import type { Metric } from '@onecare/events';
import { validate, type ValidationError } from '@onecare/domain';
import { logger, setCorrelationId, withCorrelationContext, ensureTracing } from '@onecare/observability';
import type { AnalyticsSink } from './sink/fileSink';
import { createFileSink } from './sink/fileSink';

ensureTracing('analytics-consumer');

const METRIC_SCHEMA_ID = 'https://onecare/schemas/analytics/metric.json';
const ANALYTICS_ALLOWED_TOPICS = new Set<string>([Topics.analytics.metric]);

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
}

export class AnalyticsConsumer {
  private readonly bus: MessageBus;
  private readonly sink: AnalyticsSink;
  private readonly schemaId: string;
  private subscription: Subscription | null = null;
  private readonly idempotencyStore?: IdempotencyStore;
  private readonly idempotencyTtlSeconds: number;

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
        throw new AnalyticsMetricValidationError(correlationId, validation.errors);
      }

      const idempotencyKey = this.deriveIdempotencyKey(envelope);
      await executeWithIdempotency({
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
            if (err instanceof AnalyticsMetricSinkError) {
              throw err;
            }
            throw new AnalyticsMetricSinkError(correlationId, err);
          }

          logger.info('analytics metric persisted', {
            correlationId,
            metricName: metric.name,
            labelKeys: Object.keys(metric.labels ?? {}),
            idempotencyKey,
          });
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
}

export async function startAnalyticsConsumer(options?: AnalyticsConsumerOptions): Promise<AnalyticsConsumer> {
  const consumer = new AnalyticsConsumer(options);
  await consumer.start();
  return consumer;
}
