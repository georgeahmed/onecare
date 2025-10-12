import type { MessageBus, Subscription } from '@onecare/bus';
import { getBus } from '@onecare/bus';
import { Topics, type TypedEnvelope } from '@onecare/events';
import type { Metric } from '@onecare/events/src/contracts/metric';
import { validate } from '@onecare/domain';
import { logger } from '@onecare/observability';
import type { AnalyticsSink } from './sink/fileSink';
import { createFileSink } from './sink/fileSink';

const METRIC_SCHEMA_ID = 'https://onecare/schemas/analytics/metric.json';

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
    if (this.subscription) {
      return;
    }
    this.subscription = await this.bus.subscribe<TypedEnvelope<Metric>>(Topics.analytics.metric, async (message) => {
      await this.handleEnvelope(message.payload);
    });
    logger.info('analytics consumer subscribed', { topic: Topics.analytics.metric });
  }

  async stop(): Promise<void> {
    if (!this.subscription) return;
    await this.subscription.unsubscribe();
    this.subscription = null;
  }

  private async handleEnvelope(envelope: TypedEnvelope<Metric>): Promise<void> {
    const correlationId = envelope.correlationId;
    const metric = envelope.payload;
    const validation = validate(this.schemaId, metric);
    if (!validation.ok) {
      logger.warn('analytics.metric payload failed validation', {
        correlationId,
        errors: validation.errors,
      });
      const error = new Error('analytics.metric payload failed validation');
      error.name = 'AnalyticsMetricValidationError';
      throw error;
    }
    await this.sink.write(metric);
    logger.info('analytics metric persisted', {
      correlationId,
      metricName: metric.name,
      labelKeys: Object.keys(metric.labels ?? {}),
    });
  }
}

export async function startAnalyticsConsumer(options?: AnalyticsConsumerOptions): Promise<AnalyticsConsumer> {
  const consumer = new AnalyticsConsumer(options);
  await consumer.start();
  return consumer;
}
