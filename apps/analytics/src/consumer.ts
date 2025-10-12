import type { MessageBus, Subscription } from '@onecare/bus';
import { getBus } from '@onecare/bus';
import { Topics, type TypedEnvelope } from '@onecare/events';
import type { Metric } from '@onecare/events/src/contracts/metric';
import { validate, type ValidationError } from '@onecare/domain';
import { logger, setCorrelationId, withCorrelationContext } from '@onecare/observability';
import type { AnalyticsSink } from './sink/fileSink';
import { createFileSink } from './sink/fileSink';

const METRIC_SCHEMA_ID = 'https://onecare/schemas/analytics/metric.json';

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
}

export class AnalyticsConsumer {
  private readonly bus: MessageBus;
  private readonly sink: AnalyticsSink;
  private readonly schemaId: string;
  private subscription: Subscription | null = null;

  constructor(options: AnalyticsConsumerOptions = {}) {
    this.bus = options.bus ?? getBus();
    this.sink = options.sink ?? createFileSink();
    this.schemaId = options.schemaId ?? METRIC_SCHEMA_ID;
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
      });
    });
  }
}

export async function startAnalyticsConsumer(options?: AnalyticsConsumerOptions): Promise<AnalyticsConsumer> {
  const consumer = new AnalyticsConsumer(options);
  await consumer.start();
  return consumer;
}
