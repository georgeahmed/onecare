import type { Message, MessageBus, Subscription } from '@onecare/bus';
import type { IdempotencyStore, OnlineFeatureStore, OnlineFeatureRecord } from '@onecare/ports';
import {
  getDefaultTtlSeconds,
  getFeatureSchemaId,
  isFeatureSetRegistered,
  validateFeaturePayload,
} from '@onecare/ports';

type Logger = Pick<typeof console, 'debug' | 'info' | 'warn' | 'error'>;

export interface FeatureIngestionMapping<TPayload = Record<string, unknown>> {
  topic: string;
  featureSet: string;
  deriveEntityId(payload: TPayload, message: Message<TPayload>): string;
  deriveAsOf(payload: TPayload, message: Message<TPayload>): string;
  mapPayload(payload: TPayload, message: Message<TPayload>): Record<string, unknown>;
  ttlSeconds?: number;
  shouldProcess?(payload: TPayload, message: Message<TPayload>): boolean;
}

export interface FeatureIngestionMetrics {
  processed: number;
  skipped: number;
  retries: number;
  dlq: number;
  failed: number;
}

export interface FeatureIngestionWorkerOptions {
  retries?: number;
  backoffMs?: number;
  jitterMs?: number;
  dlqTopic?: string;
  logger?: Logger;
  idempotencyTtlSeconds?: number;
}

const DEFAULT_OPTIONS: Required<Pick<FeatureIngestionWorkerOptions, 'retries' | 'backoffMs' | 'jitterMs' | 'dlqTopic'>> = {
  retries: 3,
  backoffMs: 100,
  jitterMs: 50,
  dlqTopic: 'features.ingest.dlq',
};

const sleep = async (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export class FeatureIngestionWorker<TPayload = Record<string, unknown>> {
  private readonly bus: MessageBus;
  private readonly featureStore: OnlineFeatureStore;
  private readonly idempotency: IdempotencyStore;
  private readonly mappings: FeatureIngestionMapping<TPayload>[];
  private readonly options: FeatureIngestionWorkerOptions;
  private readonly logger: Logger;
  private readonly metrics: FeatureIngestionMetrics = {
    processed: 0,
    skipped: 0,
    retries: 0,
    dlq: 0,
    failed: 0,
  };
  private subscriptions: Subscription[] = [];

  constructor(
    deps: {
      bus: MessageBus;
      featureStore: OnlineFeatureStore;
      idempotency: IdempotencyStore;
      mappings: FeatureIngestionMapping<TPayload>[];
    },
    options: FeatureIngestionWorkerOptions = {}
  ) {
    this.bus = deps.bus;
    this.featureStore = deps.featureStore;
    this.idempotency = deps.idempotency;
    this.mappings = deps.mappings;
    this.options = options;
    this.logger = options.logger ?? console;

    for (const mapping of this.mappings) {
      if (!isFeatureSetRegistered(mapping.featureSet)) {
        throw new Error(`Unknown feature set configured for ingestion: ${mapping.featureSet}`);
      }
      if (!getFeatureSchemaId(mapping.featureSet)) {
        throw new Error(`Schema not registered for feature set: ${mapping.featureSet}`);
      }
    }
  }

  async start(): Promise<void> {
    for (const mapping of this.mappings) {
      const subscription = await this.bus.subscribe(mapping.topic, (message) =>
        this.handleMessage(mapping, message as Message<TPayload>)
      );
      this.subscriptions.push(subscription);
    }
  }

  async stop(): Promise<void> {
    await Promise.all(
      this.subscriptions.map(async (subscription) => {
        await subscription.unsubscribe();
      })
    );
    this.subscriptions = [];
  }

  getMetrics(): FeatureIngestionMetrics {
    return { ...this.metrics };
  }

  private async handleMessage(mapping: FeatureIngestionMapping<TPayload>, message: Message<TPayload>): Promise<void> {
    const payload = message.payload;
    if (mapping.shouldProcess && !mapping.shouldProcess(payload, message)) {
      this.metrics.skipped += 1;
      return;
    }

    const correlationId = message.headers?.['x-correlation-id'];
    let entityId: string;
    let asOf: string;
    try {
      entityId = mapping.deriveEntityId(payload, message);
      asOf = mapping.deriveAsOf(payload, message);
    } catch (err) {
      this.logger.warn('[feature-ingest] unable to determine entityId/asOf', { topic: mapping.topic, err });
      this.metrics.failed += 1;
      await this.publishDlq(mapping, message, err);
      return;
    }

    const idempotencyKey = `${mapping.featureSet}::${entityId}::${asOf}`;
    const idempotencyTtl = mapping.ttlSeconds ?? this.options.idempotencyTtlSeconds ?? 60 * 60;
    const reserved = await this.reserveIdempotency(idempotencyKey, idempotencyTtl);
    if (!reserved) {
      this.metrics.skipped += 1;
      return;
    }

    try {
      await this.processWithRetry(mapping, message, {
        entityId,
        asOf,
        correlationId,
      });
      this.metrics.processed += 1;
    } catch (err) {
      this.metrics.failed += 1;
      this.logger.error('[feature-ingest] failed to process message after retries', {
        topic: mapping.topic,
        err,
      });
      if (this.idempotency.delete) {
        await this.idempotency.delete(idempotencyKey);
      }
      await this.publishDlq(mapping, message, err);
    }
  }

  private async processWithRetry(
    mapping: FeatureIngestionMapping<TPayload>,
    message: Message<TPayload>,
    context: { entityId: string; asOf: string; correlationId?: string }
  ): Promise<void> {
    const retries = this.options.retries ?? DEFAULT_OPTIONS.retries;
    const baseBackoff = this.options.backoffMs ?? DEFAULT_OPTIONS.backoffMs;
    const jitter = this.options.jitterMs ?? DEFAULT_OPTIONS.jitterMs;

    let attempt = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        const payload = mapping.mapPayload(message.payload, message);
        const validation = validateFeaturePayload(mapping.featureSet, payload);
        if (!validation.ok) {
          throw new Error(`Feature payload failed validation: ${JSON.stringify(validation.errors)}`);
        }

        const ttlSeconds = mapping.ttlSeconds ?? getDefaultTtlSeconds(mapping.featureSet) ?? undefined;
        const record: OnlineFeatureRecord = {
          featureSet: mapping.featureSet,
          entityId: context.entityId,
          asOf: context.asOf,
          payload,
          ttlSeconds,
          correlationId: context.correlationId,
          metadata: { busTopic: mapping.topic },
        };
        await this.featureStore.upsert(record);
        return;
      } catch (err) {
        attempt += 1;
        if (attempt > retries) {
          throw err;
        }
        this.metrics.retries += 1;
        const delay = baseBackoff * attempt + Math.floor(Math.random() * jitter);
        this.logger.warn('[feature-ingest] retrying feature ingestion', {
          attempt,
          delay,
          topic: mapping.topic,
          reason: (err as Error).message,
        });
        // eslint-disable-next-line no-await-in-loop
        await sleep(delay);
      }
    }
  }

  private async reserveIdempotency(key: string, ttlSeconds: number): Promise<boolean> {
    if (typeof this.idempotency.reserve === 'function') {
      const result = await this.idempotency.reserve(key, ttlSeconds);
      return result === 'reserved';
    }
    if (await this.idempotency.exists(key)) {
      return false;
    }
    await this.idempotency.put(key, ttlSeconds);
    return true;
  }

  private async publishDlq(mapping: FeatureIngestionMapping<TPayload>, message: Message<TPayload>, err: unknown): Promise<void> {
    const dlqTopic = this.options.dlqTopic ?? DEFAULT_OPTIONS.dlqTopic;
    this.metrics.dlq += 1;
    await this.bus.publish(dlqTopic, {
      originalTopic: mapping.topic,
      payload: message.payload,
      headers: message.headers,
      error: err instanceof Error ? { message: err.message, stack: err.stack } : { message: String(err) },
    });
  }
}
