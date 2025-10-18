import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createCounter, createHistogram, startSpan } from '@onecare/observability';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import type { ErrorObject } from 'ajv';
import {
  connect,
  consumerOpts,
  headers as createHeaders,
  credsAuthenticator,
  type Authenticator,
  type ConnectionOptions,
  type DeliveryInfo,
  type JetStreamClient,
  type JetStreamPublishOptions,
  type JsMsg,
  type MsgHdrs,
  type NatsConnection,
} from 'nats';
import type { Handler, MessageBus, Subscription } from './types';
import { MemoryBus } from './memoryBus';
import { unwrapGuardedBus } from './guardedBus';
const dlqSchemaPath = resolve(__dirname, '../../../schemas/common/dlq-event.json');
const dlqSchema = JSON.parse(readFileSync(dlqSchemaPath, 'utf8')) as Record<string, unknown>;
const publishLatencyMetric = createHistogram('bus.nats.publish.latency_ms');
const handlerLatencyMetric = createHistogram('bus.nats.handler.latency_ms');
const publishErrorMetric = createCounter('bus.nats.publish.errors');
const handlerErrorMetric = createCounter('bus.nats.handler.errors');
const dlqPublishMetric = createCounter('bus.nats.dlq.published');
const dlqErrorMetric = createCounter('bus.nats.dlq.errors');
const retryScheduledMetric = createCounter('bus.nats.retries.scheduled');
const backpressureMetric = createCounter('bus.nats.backpressure.events');
const dlqBacklogMetric = createHistogram('bus.nats.pending_lag');
const dlqPoisonMetric = createCounter('bus.nats.dlq.poison');
const failureCategoryMetric = createCounter('bus.nats.failures');
const quotaBlockMetric = createCounter('bus.quota.block');
const tenantThroughputMetric = createCounter('bus.tenant.throughput');
const messageTooLargeMetric = createCounter('bus.msg.too_large');
const messageCompressedMetric = createCounter('bus.msg.compressed');
const partitionHotKeyMetric = createCounter('bus.partition.hot_key');
const TRUNCATED_ERROR_MESSAGE_LENGTH = Number(process.env.NATS_DLQ_MESSAGE_LIMIT ?? 256);
const IS_PRODUCTION = (process.env.NODE_ENV ?? '').trim().toLowerCase() === 'production';
const VALIDATION_CODES = new Set(['invalid_input', 'validation_error', 'schema_violation']);
const SECURITY_CODES = new Set(['unauthorized', 'forbidden', 'auth_failed', 'not_authorized']);
const NON_RETRYABLE_CODES = new Set(['invalid_input', 'validation_error', 'schema_violation', 'bad_request']);

export interface NatsBusOptions {
  url?: string;
  connection?: NatsConnection;
  queueGroup?: string;
  deadLetterTopic?: string;
  maxDeliveries?: number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
  retryJitterRatio?: number;
  partitionCount?: number;
  partitionKeyResolver?: PartitionKeyResolver;
  maxMessageBytes?: number;
  pendingLagThreshold?: number;
  healthCacheMs?: number;
  flowControlEnabled?: boolean;
  idleHeartbeatMs?: number;
  tenantRateLimit?: TenantRateLimitOptions;
  compressionThresholdBytes?: number;
  partitionHotKeyWindowMs?: number;
  partitionHotKeyRateTps?: number;
}

export interface NatsBusDiagnostics {
  isConnected: boolean;
  published: number;
  subscribed: number;
  reconnects: number;
  disconnects: number;
  retriesScheduled: number;
  dlqPublished: number;
  dlqPublishFailures: number;
  pendingLag: number;
  inFlight: number;
  backpressure: boolean;
  partitions: number;
  maxMessageBytes: number;
  pendingLagThreshold: number;
  lastPublishLatencyMs: number;
  lastHandlerLatencyMs: number;
}

const DEFAULT_QUEUE_GROUP = process.env.NATS_QUEUE_GROUP || 'onecare-workers';
const DEFAULT_DLQ_TOPIC = process.env.NATS_DLQ_TOPIC || 'broker.dlq';
const DEFAULT_ACK_WAIT_MS = Number(process.env.NATS_ACK_WAIT_MS ?? 30_000);
const DEFAULT_MAX_ACK_PENDING = Number(process.env.NATS_MAX_ACK_PENDING ?? 512);
const DEFAULT_MAX_DELIVERIES = Number(process.env.NATS_MAX_DELIVERIES ?? 5);
const DEFAULT_RETRY_BASE_DELAY_MS = Number(process.env.NATS_RETRY_BASE_DELAY_MS ?? 500);
const DEFAULT_RETRY_MAX_DELAY_MS = Number(process.env.NATS_RETRY_MAX_DELAY_MS ?? 30_000);
const DEFAULT_RETRY_JITTER_RATIO = Number(process.env.NATS_RETRY_JITTER_RATIO ?? 0.2);
const DEFAULT_PARTITION_COUNT = Number(process.env.NATS_PARTITIONS ?? 1);
const DEFAULT_MAX_MESSAGE_BYTES = Number(process.env.NATS_MAX_MESSAGE_BYTES ?? 512 * 1024);
const DEFAULT_PENDING_LAG_THRESHOLD = Number(process.env.NATS_PENDING_LAG_THRESHOLD ?? 500);
const DEFAULT_HEALTH_CACHE_MS = Number(process.env.NATS_HEALTH_CACHE_MS ?? 2_000);
const DEFAULT_IDLE_HEARTBEAT_MS = Number(process.env.NATS_IDLE_HEARTBEAT_MS ?? 15_000);
const DEFAULT_FLOW_CONTROL = parseBoolean(process.env.NATS_FLOW_CONTROL ?? 'true');
const MESSAGE_ID_HEADER = 'x-message-id';
const IDEMPOTENCY_HEADER = 'x-idempotency-key';
const NATS_MSG_ID_HEADER = 'nats-msg-id';
const PARTITION_HEADER = 'x-partition-key';
const COMPRESSION_FLAG = '__compressed';
const COMPRESSION_ENCODING = 'gzip+json';
const DEFAULT_COMPRESSION_THRESHOLD_BYTES = Math.max(
  0,
  Number(process.env.NATS_COMPRESSION_THRESHOLD_BYTES ?? 256 * 1024),
);
const DEFAULT_PARTITION_HOT_KEY_WINDOW_MS = Math.max(
  1_000,
  Number(process.env.NATS_PARTITION_HOT_KEY_WINDOW_MS ?? 60_000),
);
const DEFAULT_PARTITION_HOT_KEY_RATE_TPS = Math.max(
  0,
  Number(process.env.NATS_PARTITION_HOT_KEY_RATE_TPS ?? 250),
);

type JetStreamSubscription = AsyncIterable<JsMsg> & {
  unsubscribe(): Promise<void> | void;
};

const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: false });
addFormats(ajv);
const validateDlqEvent = ajv.compile<Record<string, unknown>>(dlqSchema as unknown as Record<string, unknown>);

type AjvValidationError = ErrorObject & {
  instancePath?: string;
  dataPath?: string;
};

type PartitionKeyResolver = (input: {
  topic: string;
  payload: unknown;
  headers?: Record<string, string>;
}) => string | undefined;

type TenantResolver = (input: {
  topic: string;
  payload: unknown;
  headers?: Record<string, string>;
}) => string | undefined;

interface TenantRateOverride {
  rate: number;
  burst?: number;
}

interface TenantRateLimitOptions {
  defaultRatePerSecond?: number;
  defaultBurst?: number;
  overrides?: Record<string, TenantRateOverride>;
  tenantResolver?: TenantResolver;
}

interface TenantRateOverrideResolved {
  rate: number;
  burst: number;
}

interface TenantRateLimitResolved {
  defaultRate: number;
  defaultBurst: number;
  overrides: Map<string, TenantRateOverrideResolved>;
  resolver?: TenantResolver;
  enabled: boolean;
}

interface PartitionUsageTrackerOptions {
  windowMs: number;
  hotKeyThresholdPerSecond: number;
}

const DEFAULT_TENANT_RESOLVER: TenantResolver = ({ payload, headers }) => extractTenantId(payload, headers);

export class NatsBus implements MessageBus {
  readonly url: string;
  private readonly queueGroup: string;
  private readonly deadLetterTopic: string;
  private readonly encoder = new TextEncoder();
  private readonly decoder = new TextDecoder();
  private readonly ackWaitMs: number;
  private readonly maxAckPending: number;
  private readonly maxDeliveries: number;
  private readonly retryBaseDelayMs: number;
  private readonly retryMaxDelayMs: number;
  private readonly retryJitterRatio: number;
  private readonly partitionCount: number;
  private readonly partitionKeyResolver?: PartitionKeyResolver;
  private readonly maxMessageBytes: number;
  private readonly pendingLagThreshold: number;
  private readonly healthCacheMs: number;
  private readonly flowControlEnabled: boolean;
  private readonly idleHeartbeatNs: number;
  private readonly tenantRateDefault: number;
  private readonly tenantBurstDefault: number;
  private readonly tenantOverrides: Map<string, TenantRateOverrideResolved>;
  private readonly tenantResolver?: TenantResolver;
  private readonly quotaEnabled: boolean;
  private readonly tenantBuckets = new Map<string, TokenBucket>();
  private readonly partitionUsageTracker: PartitionUsageTracker;
  private readonly compressionThresholdBytes: number;
  private connectionPromise?: Promise<NatsConnection>;
  private jsClient?: JetStreamClient;
  private statusMonitor?: Promise<void>;
  private closedMonitor?: Promise<void>;
  private connected = false;
  private publishedCount = 0;
  private subscribedCount = 0;
  private reconnectsCount = 0;
  private disconnectsCount = 0;
  private retriesScheduledCount = 0;
  private dlqPublishedCount = 0;
  private dlqPublishFailuresCount = 0;
  private pendingLag = 0;
  private lastPublishLatencyMs = 0;
  private lastHandlerLatencyMs = 0;
  private backpressureActive = false;
  private inFlightCount = 0;
  private lastErrorTimestamp = 0;
  private lastAckTimestamp = 0;
  private lastHealthCheckAt = 0;
  private lastHealthSnapshot?: NatsBusHealth;

  constructor(private readonly opts: NatsBusOptions = {}) {
    this.url = (opts.url ?? process.env.NATS_URL ?? 'nats://localhost:4222').trim();
    this.queueGroup = opts.queueGroup ?? DEFAULT_QUEUE_GROUP;
    this.deadLetterTopic = opts.deadLetterTopic ?? DEFAULT_DLQ_TOPIC;
    this.ackWaitMs = Number.isFinite(DEFAULT_ACK_WAIT_MS) && DEFAULT_ACK_WAIT_MS > 0 ? DEFAULT_ACK_WAIT_MS : 30_000;
    this.maxAckPending =
      Number.isFinite(DEFAULT_MAX_ACK_PENDING) && DEFAULT_MAX_ACK_PENDING > 0 ? DEFAULT_MAX_ACK_PENDING : 512;
    const normalizedMaxDeliveries = Number.isFinite(opts.maxDeliveries)
      ? Number(opts.maxDeliveries)
      : Number.isFinite(DEFAULT_MAX_DELIVERIES)
        ? DEFAULT_MAX_DELIVERIES
        : 5;
    this.maxDeliveries = Math.max(1, Math.floor(normalizedMaxDeliveries));
    const baseDelayCandidate = Number.isFinite(opts.retryBaseDelayMs)
      ? Number(opts.retryBaseDelayMs)
      : Number.isFinite(DEFAULT_RETRY_BASE_DELAY_MS)
        ? DEFAULT_RETRY_BASE_DELAY_MS
        : 500;
    this.retryBaseDelayMs = Math.max(50, Math.floor(baseDelayCandidate));
    const maxDelayCandidate = Number.isFinite(opts.retryMaxDelayMs)
      ? Number(opts.retryMaxDelayMs)
      : Number.isFinite(DEFAULT_RETRY_MAX_DELAY_MS)
        ? DEFAULT_RETRY_MAX_DELAY_MS
        : 30_000;
    this.retryMaxDelayMs = Math.max(this.retryBaseDelayMs, Math.floor(maxDelayCandidate));
    const jitterCandidate = Number.isFinite(opts.retryJitterRatio)
      ? Number(opts.retryJitterRatio)
      : Number.isFinite(DEFAULT_RETRY_JITTER_RATIO)
        ? DEFAULT_RETRY_JITTER_RATIO
        : 0.2;
    this.retryJitterRatio = Math.min(1, Math.max(0, jitterCandidate));
    const partitionCandidate = Number(opts.partitionCount ?? DEFAULT_PARTITION_COUNT);
    this.partitionCount = Number.isFinite(partitionCandidate) && partitionCandidate > 0 ? Math.floor(partitionCandidate) : 1;
    this.partitionCount = Math.max(1, this.partitionCount);
    this.partitionKeyResolver = opts.partitionKeyResolver;
    const maxBytesCandidate = Number(opts.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES);
    this.maxMessageBytes =
      Number.isFinite(maxBytesCandidate) && maxBytesCandidate > 0 ? Math.floor(maxBytesCandidate) : 512 * 1024;
    const lagThresholdCandidate = Number(opts.pendingLagThreshold ?? DEFAULT_PENDING_LAG_THRESHOLD);
    this.pendingLagThreshold =
      Number.isFinite(lagThresholdCandidate) && lagThresholdCandidate >= 0 ? Math.floor(lagThresholdCandidate) : 500;
    const healthCacheCandidate = Number(opts.healthCacheMs ?? DEFAULT_HEALTH_CACHE_MS);
    this.healthCacheMs =
      Number.isFinite(healthCacheCandidate) && healthCacheCandidate > 0 ? Math.floor(healthCacheCandidate) : 2_000;
    const idleHeartbeatCandidate = Number(opts.idleHeartbeatMs ?? DEFAULT_IDLE_HEARTBEAT_MS);
    const idleHeartbeatMs =
      Number.isFinite(idleHeartbeatCandidate) && idleHeartbeatCandidate > 0
        ? Math.floor(idleHeartbeatCandidate)
        : DEFAULT_IDLE_HEARTBEAT_MS;
    this.idleHeartbeatNs = Math.max(1, idleHeartbeatMs) * 1_000_000;
    this.flowControlEnabled =
      typeof opts.flowControlEnabled === 'boolean' ? opts.flowControlEnabled : DEFAULT_FLOW_CONTROL;
    this.lastAckTimestamp = Date.now();
    const envTenantRate = parseTenantRateEnv();
    const mergedTenantRate = mergeTenantRateOptions(envTenantRate, opts.tenantRateLimit);
    const resolvedTenantRate = normalizeTenantRateLimit(mergedTenantRate);
    this.tenantRateDefault = resolvedTenantRate.defaultRate;
    this.tenantBurstDefault = resolvedTenantRate.defaultBurst;
    this.tenantOverrides = resolvedTenantRate.overrides;
    this.tenantResolver = resolvedTenantRate.resolver ?? DEFAULT_TENANT_RESOLVER;
    this.quotaEnabled = resolvedTenantRate.enabled;
    const compressionThresholdCandidate = Number(
      opts.compressionThresholdBytes ?? DEFAULT_COMPRESSION_THRESHOLD_BYTES,
    );
    this.compressionThresholdBytes = Number.isFinite(compressionThresholdCandidate)
      ? Math.max(0, Math.floor(compressionThresholdCandidate))
      : DEFAULT_COMPRESSION_THRESHOLD_BYTES;
    const hotKeyWindowCandidate = Number(opts.partitionHotKeyWindowMs ?? DEFAULT_PARTITION_HOT_KEY_WINDOW_MS);
    const hotKeyRateCandidate = Number(opts.partitionHotKeyRateTps ?? DEFAULT_PARTITION_HOT_KEY_RATE_TPS);
    const partitionWindowMs = Number.isFinite(hotKeyWindowCandidate)
      ? Math.max(1_000, Math.floor(hotKeyWindowCandidate))
      : DEFAULT_PARTITION_HOT_KEY_WINDOW_MS;
    const partitionHotThreshold = Number.isFinite(hotKeyRateCandidate)
      ? Math.max(0, Number(hotKeyRateCandidate))
      : DEFAULT_PARTITION_HOT_KEY_RATE_TPS;
    this.partitionUsageTracker = new PartitionUsageTracker({
      windowMs: partitionWindowMs,
      hotKeyThresholdPerSecond: partitionHotThreshold,
    });

    if (opts.connection) {
      this.connectionPromise = Promise.resolve(opts.connection);
      this.jsClient = opts.connection.jetstream();
      this.connected = true;
      this.statusMonitor = this.monitorConnection(opts.connection).catch(() => undefined);
      this.closedMonitor = opts.connection.closed().then((err) => {
        this.connected = false;
        this.connectionPromise = undefined;
        this.statusMonitor = undefined;
        this.jsClient = undefined;
        if (err) {
          console.error('[NatsBus] connection closed with error', err.message);
        }
      });
    }
    const now = Date.now();
    this.lastHealthSnapshot = this.computeHealth(now);
    this.lastHealthCheckAt = now;
  }

  async publish<T>(topic: string, payload: T, headers?: Record<string, string>): Promise<void> {
    const started = performance.now();
    const span = startSpan('bus.nats.publish', {
      attributes: {
        'messaging.system': 'nats',
        'messaging.destination.base': topic,
        'messaging.operation': 'publish',
      },
    });
    try {
      const tenantId = this.resolveTenantId(topic, payload, headers);
      if (this.quotaEnabled) {
        this.consumeTenantQuota(tenantId, topic);
      }
      const resolution = this.resolvePublishSubject(topic, payload, headers);
      const normalizedHeaders = this.ensurePartitionHeader(headers, resolution.partitionKey);
      const { payload: envelopeForWire, compressed } = maybeCompressEnvelopePayload(
        payload,
        this.compressionThresholdBytes,
        topic,
      );
      const js = await this.getJetStream();
      const data = this.encoder.encode(JSON.stringify(envelopeForWire));
      if (data.byteLength > this.maxMessageBytes) {
        messageTooLargeMetric.add(1, {
          topic,
          compressed: compressed ? 'true' : 'false',
        });
        const error = createMessageSizeError(data.byteLength, this.maxMessageBytes, topic);
        publishErrorMetric.add(1, { topic, reason: 'size_exceeded' });
        span.setAttribute('messaging.result', 'error');
        span.recordException(error);
        throw error;
      }
      span.setAttribute('messaging.destination', resolution.subject);
      span.setAttribute('messaging.destination.partition', resolution.partition);
      if (resolution.partitionKey) {
        span.setAttribute('messaging.destination.partition_key', resolution.partitionKey);
      }

      const publishOptions: Partial<JetStreamPublishOptions> = {};
      if (normalizedHeaders && Object.keys(normalizedHeaders).length > 0) {
        publishOptions.headers = this.toMsgHeaders(normalizedHeaders);
      }
      const messageId = this.deriveMessageId(payload, normalizedHeaders);
      if (messageId) {
        publishOptions.msgID = messageId;
        span.setAttribute('messaging.message_id', messageId);
      }
      await js.publish(resolution.subject, data, publishOptions);
      this.publishedCount += 1;
      const duration = performance.now() - started;
      this.lastPublishLatencyMs = duration;
      publishLatencyMetric.record(duration, { topic, subject: resolution.subject, result: 'success' });
      span.setAttribute('messaging.result', 'success');
      span.setAttribute('messaging.payload_size_bytes', data.byteLength);
      tenantThroughputMetric.add(1, {
        tenant: tenantId ?? 'unknown',
        topic,
      });
      this.recordPartitionUsage(topic, resolution.partition, resolution.partitionKey, tenantId);
    } catch (err) {
      this.connected = false;
      const duration = performance.now() - started;
      this.lastPublishLatencyMs = duration;
      publishLatencyMetric.record(duration, { topic, result: 'error' });
      publishErrorMetric.add(1, { topic });
      span.setAttribute('messaging.result', 'error');
      span.recordException(err instanceof Error ? err : new Error(String(err)));
      this.invalidateHealthCache();
      this.updateBackpressureState();
      throw err;
    } finally {
      span.end();
    }
  }

  async subscribe<T>(topic: string, handler: Handler<T>): Promise<Subscription> {
    const js = await this.getJetStream();
    const queue = this.queueGroupFor(topic);
    const opts = consumerOpts();
    opts.durable(this.durableName(topic));
    opts.manualAck();
    opts.ackExplicit();
    opts.ackWait(this.ackWaitMs * 1_000_000);
    opts.maxAckPending(this.maxAckPending);
    opts.queue(queue);
    opts.deliverAll();
    opts.maxDeliver(this.maxDeliveries);
    if (this.flowControlEnabled) {
      opts.flowControl();
    }
    opts.idleHeartbeat(this.idleHeartbeatNs);

    const subject = this.subscriptionSubject(topic);
    const subscription = (await js.subscribe(subject, opts)) as JetStreamSubscription;
    this.subscribedCount += 1;
    const consumePromise = this.consume(subscription, handler, topic);
    return {
      unsubscribe: async () => {
        try {
          subscription.unsubscribe();
          await consumePromise;
        } catch {
          /* noop */
        }
      },
    };
  }

  get isConnected(): boolean {
    return this.connected;
  }

  get published(): number {
    return this.publishedCount;
  }

  get subscribed(): number {
    return this.subscribedCount;
  }

  setConnected(connected: boolean): void {
    this.connected = connected;
    if (connected) {
      this.lastAckTimestamp = Date.now();
    }
    this.invalidateHealthCache();
    this.updateBackpressureState();
  }

  getAckWaitMs(): number {
    return this.ackWaitMs;
  }

  getMaxAckPending(): number {
    return this.maxAckPending;
  }

  getDiagnostics(): NatsBusDiagnosticsExtended {
    return this.createDiagnostics();
  }

  getHealthSnapshot(maxAgeMs?: number): NatsBusHealth {
    const now = Date.now();
    const ttl = typeof maxAgeMs === 'number' && maxAgeMs > 0 ? Math.floor(maxAgeMs) : this.healthCacheMs;
    if (this.lastHealthSnapshot && now - this.lastHealthCheckAt <= ttl) {
      return this.lastHealthSnapshot;
    }
    const snapshot = this.computeHealth(now);
    this.lastHealthSnapshot = snapshot;
    this.lastHealthCheckAt = now;
    return snapshot;
  }

  private createDiagnostics(): NatsBusDiagnosticsExtended {
    return {
      isConnected: this.connected,
      published: this.publishedCount,
      subscribed: this.subscribedCount,
      reconnects: this.reconnectsCount,
      disconnects: this.disconnectsCount,
      retriesScheduled: this.retriesScheduledCount,
      dlqPublished: this.dlqPublishedCount,
      dlqPublishFailures: this.dlqPublishFailuresCount,
      pendingLag: this.pendingLag,
      inFlight: this.inFlightCount,
      backpressure: this.backpressureActive,
      partitions: this.partitionCount,
      maxMessageBytes: this.maxMessageBytes,
      pendingLagThreshold: this.pendingLagThreshold,
      lastPublishLatencyMs: this.lastPublishLatencyMs,
      lastHandlerLatencyMs: this.lastHandlerLatencyMs,
      ackWaitMs: this.ackWaitMs,
      maxAckPending: this.maxAckPending,
      maxDeliveries: this.maxDeliveries,
    };
  }

  private computeHealth(now: number): NatsBusHealth {
    const diagnostics = this.createDiagnostics();
    const pendingWithinThreshold =
      this.pendingLagThreshold <= 0 || diagnostics.pendingLag <= this.pendingLagThreshold;
    const inflightWithinLimit = this.maxAckPending <= 0 || diagnostics.inFlight < this.maxAckPending;
    const backpressure = this.isBackpressured();
    const isReady =
      diagnostics.isConnected &&
      diagnostics.subscribed > 0 &&
      pendingWithinThreshold &&
      inflightWithinLimit &&
      !backpressure;
    return {
      computedAt: now,
      isConnected: diagnostics.isConnected,
      backpressure,
      pendingLag: diagnostics.pendingLag,
      inFlight: diagnostics.inFlight,
      lastErrorAt: this.lastErrorTimestamp || null,
      lastAckAt: this.lastAckTimestamp || null,
      partitions: this.partitionCount,
      subscribed: diagnostics.subscribed,
      isReady,
      diagnostics,
    };
  }

  private resolvePublishSubject(
    topic: string,
    payload: unknown,
    headers: Record<string, string> | undefined,
  ): { subject: string; partition: number; partitionKey?: string } {
    if (this.partitionCount <= 1) {
      return { subject: topic, partition: 0 };
    }
    const partitionKey =
      this.partitionKeyResolver?.({ topic, payload, headers }) ?? extractPartitionKey(payload, headers, topic);
    if (!partitionKey) {
      return { subject: `${topic}.p0`, partition: 0 };
    }
    const partition = partitionIndexFor(partitionKey, this.partitionCount);
    return {
      subject: `${topic}.p${partition}`,
      partition,
      partitionKey,
    };
  }

  private subscriptionSubject(topic: string): string {
    if (this.partitionCount <= 1) {
      return topic;
    }
    return `${topic}.>`;
  }

  private baseTopicForSubject(subject: string, fallback: string): string {
    if (this.partitionCount <= 1) {
      return subject || fallback;
    }
    if (!subject) return fallback;
    const match = subject.match(/^(.*)\.p\d+$/);
    if (match && match[1]) {
      return match[1];
    }
    return subject;
  }

  private ensurePartitionHeader(
    headers: Record<string, string> | undefined,
    partitionKey: string | undefined,
  ): Record<string, string> | undefined {
    if (!partitionKey) {
      return headers;
    }
    const trimmed = partitionKey.trim();
    if (trimmed.length === 0) {
      return headers;
    }
    if (!headers) {
      return { [PARTITION_HEADER]: trimmed };
    }
    const found = findHeaderInsensitive(headers, PARTITION_HEADER);
    if (!found) {
      return {
        ...headers,
        [PARTITION_HEADER]: trimmed,
      };
    }
    if (found.value === trimmed) {
      return headers;
    }
    const next = { ...headers };
    delete next[found.key];
    next[PARTITION_HEADER] = trimmed;
    return next;
  }

  private recordPartitionUsage(
    topic: string,
    partition: number,
    partitionKey: string | undefined,
    tenantId: string | undefined,
  ): void {
    if (!partitionKey) return;
    const result = this.partitionUsageTracker.record(partitionKey);
    if (result.hot) {
      partitionHotKeyMetric.add(1, {
        topic,
        partition,
        tenant: tenantId ?? 'unknown',
      });
    }
  }

  private resolveTenantId(
    topic: string,
    payload: unknown,
    headers: Record<string, string> | undefined,
  ): string | undefined {
    const resolver = this.tenantResolver ?? DEFAULT_TENANT_RESOLVER;
    try {
      return resolver({ topic, payload, headers });
    } catch {
      return extractTenantId(payload, headers);
    }
  }

  private resolveTenantQuota(tenantId: string | undefined): TenantRateOverrideResolved | null {
    const override = tenantId ? this.tenantOverrides.get(tenantId) : undefined;
    const rate = override?.rate ?? this.tenantRateDefault;
    if (!rate || rate <= 0) {
      return null;
    }
    const burst = override?.burst ?? this.tenantBurstDefault;
    return {
      rate,
      burst: burst > 0 ? burst : Math.max(rate, 1),
    };
  }

  private consumeTenantQuota(tenantId: string | undefined, topic: string): void {
    const config = this.resolveTenantQuota(tenantId);
    if (!config) return;
    const bucketKey = tenantId ?? '__default__';
    let bucket = this.tenantBuckets.get(bucketKey);
    if (!bucket) {
      bucket = new TokenBucket(config.rate, config.burst);
      this.tenantBuckets.set(bucketKey, bucket);
    }
    if (!bucket.tryRemoveTokens(1)) {
      quotaBlockMetric.add(1, { tenant: tenantId ?? 'unknown', topic });
      throw createTenantQuotaError(topic, tenantId);
    }
  }

  private isBackpressured(): boolean {
    const pendingExceeded = this.pendingLagThreshold > 0 && this.pendingLag >= this.pendingLagThreshold;
    const inflightExceeded = this.maxAckPending > 0 && this.inFlightCount >= this.maxAckPending;
    return this.connected && (pendingExceeded || inflightExceeded);
  }

  private updateBackpressureState(): void {
    const active = this.isBackpressured();
    if (active === this.backpressureActive) {
      return;
    }
    this.backpressureActive = active;
    this.invalidateHealthCache();
    const payload = {
      pendingLag: this.pendingLag,
      pendingLagThreshold: this.pendingLagThreshold,
      inFlight: this.inFlightCount,
      maxAckPending: this.maxAckPending,
    };
    if (active) {
      backpressureMetric.add(1, { state: 'engaged' });
      console.warn('[NatsBus] backpressure engaged', payload);
    } else {
      backpressureMetric.add(1, { state: 'cleared' });
      console.info('[NatsBus] backpressure cleared', payload);
    }
  }

  private invalidateHealthCache(): void {
    this.lastHealthCheckAt = 0;
  }

  async refreshSecurityMaterial(): Promise<void> {
    const current = this.connectionPromise;
    this.connectionPromise = undefined;
    this.jsClient = undefined;
    this.connected = false;
    this.invalidateHealthCache();
    this.updateBackpressureState();
    if (!current) {
      return;
    }
    try {
      const conn = await current;
      await conn?.close();
    } catch (err) {
      console.warn('[NatsBus] failed to close connection during security refresh', err);
    }
  }

  private loadAuthenticator(): Authenticator | undefined {
    const credsPath = normalizePathEnv(process.env.NATS_CREDS_PATH);
    if (credsPath) {
      const creds = safeReadFileBinary(credsPath);
      return credsAuthenticator(creds);
    }
    return undefined;
  }

  private isTlsEnabled(servers: string[]): boolean {
    const flag = normalizeOptionalString(process.env.NATS_TLS_ENABLED);
    if (flag !== undefined) {
      return parseBoolean(flag);
    }
    return servers.some((server) =>
      server.startsWith('tls://') || server.startsWith('wss://') || server.startsWith('nats+tls://'),
    );
  }

  private isTlsRequired(): boolean {
    const flag = normalizeOptionalString(process.env.NATS_TLS_REQUIRED);
    if (flag !== undefined) {
      return parseBoolean(flag);
    }
    return IS_PRODUCTION;
  }

  private loadTlsOptions(): ConnectionOptions['tls'] | undefined {
    const caPath = normalizePathEnv(process.env.NATS_TLS_CA_PATH);
    const certPath = normalizePathEnv(process.env.NATS_TLS_CERT_PATH);
    const keyPath = normalizePathEnv(process.env.NATS_TLS_KEY_PATH);
    const rejectUnauthorizedEnv = normalizeOptionalString(process.env.NATS_TLS_REJECT_UNAUTHORIZED);
    const insecure = parseBoolean(process.env.NATS_TLS_INSECURE);
    const tls: Record<string, unknown> = {};
    if (caPath) tls.ca = [safeReadFileUtf8(caPath)];
    if (certPath) tls.cert = safeReadFileUtf8(certPath);
    if (keyPath) tls.key = safeReadFileUtf8(keyPath);
    if (rejectUnauthorizedEnv !== undefined) {
      tls.rejectUnauthorized = parseBoolean(rejectUnauthorizedEnv);
    }
    if (insecure) {
      tls.rejectUnauthorized = false;
    }
    if (
      !tls.ca && !tls.cert && !tls.key && tls.rejectUnauthorized === undefined && !insecure
    ) {
      return undefined;
    }
    return tls as ConnectionOptions['tls'];
  }

  getReconnects(): number {
    return this.reconnectsCount;
  }

  getDisconnects(): number {
    return this.disconnectsCount;
  }

  getRetriesScheduled(): number {
    return this.retriesScheduledCount;
  }

  getDlqPublished(): number {
    return this.dlqPublishedCount;
  }

  getDlqPublishFailures(): number {
    return this.dlqPublishFailuresCount;
  }

  getPendingLag(): number {
    return this.pendingLag;
  }

  getLastPublishLatencyMs(): number {
    return this.lastPublishLatencyMs;
  }

  getLastHandlerLatencyMs(): number {
    return this.lastHandlerLatencyMs;
  }

  private deriveMessageId(payload: unknown, headers: Record<string, string> | undefined): string | undefined {
    if (payload && typeof payload === 'object') {
      const candidate = (payload as { id?: unknown }).id;
      const fromPayload = normalizeIdCandidate(candidate);
      if (fromPayload) {
        return fromPayload;
      }
    }
    if (!headers) {
      return undefined;
    }
    const headerMatch =
      findHeaderInsensitive(headers, MESSAGE_ID_HEADER) ??
      findHeaderInsensitive(headers, IDEMPOTENCY_HEADER) ??
      findHeaderInsensitive(headers, NATS_MSG_ID_HEADER);
    if (!headerMatch) {
      return undefined;
    }
    return normalizeIdCandidate(headerMatch.value);
  }

  private computeRetryDelayMs(deliveryCount: number): number {
    const attempt = Math.max(1, deliveryCount);
    const exponential = Math.min(
      this.retryMaxDelayMs,
      this.retryBaseDelayMs * Math.pow(2, attempt - 1),
    );
    if (this.retryJitterRatio <= 0) {
      return exponential;
    }
    const jitterSpan = Math.max(1, Math.floor(exponential * this.retryJitterRatio));
    const min = Math.max(1, exponential - jitterSpan);
    const max = exponential + jitterSpan;
    return Math.round(min + Math.random() * (max - min));
  }

  private queueGroupFor(topic: string): string {
    if (this.queueGroup) return this.queueGroup;
    return topic.replace(/[^a-zA-Z0-9]/g, '_') || 'onecare';
  }

  private durableName(topic: string): string {
    const sanitized = topic.replace(/[^a-zA-Z0-9]/g, '_');
    return `${this.queueGroup}_${sanitized}`.slice(0, 255);
  }

  private async getJetStream(): Promise<JetStreamClient> {
    const conn = await this.getConnection();
    if (!this.jsClient) {
      this.jsClient = conn.jetstream();
    }
    return this.jsClient;
  }

  private async getConnection(): Promise<NatsConnection> {
    if (!this.connectionPromise) {
      this.connectionPromise = this.createConnection();
    }
    try {
      const conn = await this.connectionPromise;
      this.connected = true;
      if (!this.statusMonitor) {
        this.statusMonitor = this.monitorConnection(conn).catch(() => undefined);
      }
      if (!this.closedMonitor) {
        this.closedMonitor = conn.closed().then((err) => {
          this.connected = false;
          this.connectionPromise = undefined;
          this.statusMonitor = undefined;
          this.jsClient = undefined;
          if (err) {
            console.error('[NatsBus] connection closed with error', err.message);
          }
        });
      }
      return conn;
    } catch (err) {
      this.connectionPromise = undefined;
      this.connected = false;
      this.invalidateHealthCache();
      this.updateBackpressureState();
      throw err;
    }
  }

  private async createConnection(): Promise<NatsConnection> {
    const options: ConnectionOptions = this.buildConnectionOptions();
    const conn = await connect(options);
    this.jsClient = conn.jetstream();
    return conn;
  }

  private buildConnectionOptions(): ConnectionOptions {
    const servers = this.url
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const options: ConnectionOptions = { servers };
    this.applyBasicAuth(options);
    this.applyAdvancedAuth(options);
    this.applyTlsOptions(options, servers);
    const timeoutMs = Number(process.env.NATS_CONNECT_TIMEOUT_MS ?? '');
    if (!Number.isNaN(timeoutMs) && timeoutMs > 0) {
      options.timeout = timeoutMs;
    }
    const maxReconnect = Number(process.env.NATS_MAX_RECONNECT_ATTEMPTS ?? '');
    if (!Number.isNaN(maxReconnect) && maxReconnect >= 0) {
      options.maxReconnectAttempts = maxReconnect;
    }
    const reconnectWait = Number(process.env.NATS_RECONNECT_TIME_WAIT_MS ?? '');
    if (!Number.isNaN(reconnectWait) && reconnectWait > 0) {
      options.reconnectTimeWait = reconnectWait;
    }
    return options;
  }

  private applyBasicAuth(options: ConnectionOptions): void {
    const user = process.env.NATS_USER?.trim();
    const pass = process.env.NATS_PASS?.trim();
    const token = process.env.NATS_TOKEN?.trim();
    if (user) options.user = user;
    if (pass) options.pass = pass;
    if (token) options.token = token;
  }

  private applyAdvancedAuth(options: ConnectionOptions): void {
    const authenticator = this.loadAuthenticator();
    if (authenticator) {
      options.authenticator = authenticator;
      delete (options as { user?: string }).user;
      delete (options as { pass?: string }).pass;
      delete (options as { token?: string }).token;
    }
  }

  private applyTlsOptions(options: ConnectionOptions, servers: string[]): void {
    const tlsEnabled = this.isTlsEnabled(servers);
    const tlsRequired = this.isTlsRequired();
    if (tlsEnabled) {
      const tlsOptions = this.loadTlsOptions();
      if (tlsOptions) {
        options.tls = tlsOptions;
      } else {
        options.tls = {};
      }
    } else if (tlsRequired) {
      throw new Error('[NatsBus] TLS is required for broker connections');
    }
  }

  private async monitorConnection(conn: NatsConnection): Promise<void> {
    try {
      for await (const status of conn.status()) {
        if (status.type === 'reconnect') {
          this.reconnectsCount += 1;
          this.connected = true;
          this.invalidateHealthCache();
          this.updateBackpressureState();
        } else if (
          status.type === 'disconnect' ||
          status.type === 'error' ||
          status.type === 'reconnecting' ||
          status.type === 'staleConnection'
        ) {
          this.disconnectsCount += 1;
          this.connected = false;
          this.invalidateHealthCache();
          this.updateBackpressureState();
        }
      }
    } catch (err) {
      console.error('[NatsBus] status monitor error', err instanceof Error ? err.message : err);
    }
  }

  private async consume<T>(
    subscription: JetStreamSubscription,
    handler: Handler<T>,
    topic: string,
  ): Promise<void> {
    for await (const msg of subscription) {
      await this.processMessage(msg, handler, topic);
    }
  }

  private async processMessage<T>(msg: JsMsg, handler: Handler<T>, fallbackTopic: string): Promise<void> {
    const messageSubject = msg.subject || fallbackTopic;
    const baseTopic = this.baseTopicForSubject(messageSubject, fallbackTopic);
    const raw = this.decoder.decode(msg.data);
    let payload: unknown = raw;
    try {
      payload = JSON.parse(raw);
    } catch {
      // keep raw string
    }
    const decompressed = maybeDecompressEnvelopePayload(payload);
    payload = decompressed.payload;
    const headers = msg.headers ? this.fromMsgHeaders(msg.headers) : undefined;
    const info = (msg as JsMsg & { info?: DeliveryInfo }).info;
    if (info && typeof info.pending === 'number' && Number.isFinite(info.pending)) {
      this.pendingLag = info.pending;
      dlqBacklogMetric.record(info.pending, { topic: baseTopic });
      this.invalidateHealthCache();
      this.updateBackpressureState();
    }
    const correlationId = extractCorrelationIdFrom(payload, headers);
    const messageId = this.deriveMessageId(payload, headers);
    const partitionKey = extractPartitionKey(payload, headers, baseTopic) ?? messageId;
    const tenantId = extractTenantId(payload, headers);
    const consumeSpan = startSpan('bus.nats.consume', {
      attributes: {
        'messaging.system': 'nats',
        'messaging.destination': messageSubject,
        'messaging.destination.base': baseTopic,
        'messaging.operation': 'process',
      },
    });
    if (messageId) {
      consumeSpan.setAttribute('messaging.message_id', messageId);
    }
    if (correlationId) {
      consumeSpan.setAttribute('messaging.correlation_id', correlationId);
    }
    if (partitionKey) {
      consumeSpan.setAttribute('messaging.destination.partition_key', partitionKey);
    }
    if (tenantId) {
      consumeSpan.setAttribute('messaging.tenant_id', tenantId);
    }
    this.inFlightCount += 1;
    this.invalidateHealthCache();
    this.updateBackpressureState();
    const handlerStarted = performance.now();
    try {
      await handler({
        topic: baseTopic,
        payload: payload as T,
        headers,
        tenantId,
        partitionKey,
      });
      const duration = performance.now() - handlerStarted;
      this.lastHandlerLatencyMs = duration;
      handlerLatencyMetric.record(duration, { topic: baseTopic, result: 'success' });
      consumeSpan.setAttribute('messaging.result', 'success');
      await msg.ack();
      this.lastAckTimestamp = Date.now();
      this.invalidateHealthCache();
    } catch (err) {
      const duration = performance.now() - handlerStarted;
      this.lastHandlerLatencyMs = duration;
      handlerLatencyMetric.record(duration, { topic: baseTopic, result: 'error' });
      handlerErrorMetric.add(1, { topic: baseTopic });
      consumeSpan.setAttribute('messaging.result', 'error');
      consumeSpan.recordException(err instanceof Error ? err : new Error(String(err)));
      this.lastErrorTimestamp = Date.now();
      this.invalidateHealthCache();
      await this.handleFailure(msg, baseTopic, payload, headers, err);
    } finally {
      this.inFlightCount = Math.max(0, this.inFlightCount - 1);
      this.updateBackpressureState();
      consumeSpan.end();
    }
  }

  private async handleFailure(
    msg: JsMsg,
    topic: string,
    payload: unknown,
    headers: Record<string, string> | undefined,
    err: unknown,
  ): Promise<void> {
    console.error('[NatsBus] handler error', err);
    this.lastErrorTimestamp = Date.now();
    this.invalidateHealthCache();
    if (topic === this.deadLetterTopic) {
      await msg.ack();
      this.lastAckTimestamp = Date.now();
      this.updateBackpressureState();
      return;
    }

    const correlationId = extractCorrelationIdFrom(payload, headers);
    const info = (msg as JsMsg & { info?: DeliveryInfo }).info;
    const deliveries = info?.deliveryCount ?? info?.redeliveryCount ?? 1;
    const disposition = classifyFailure(err);
    const errorCode = disposition.code ?? this.extractErrorCode(err);
    failureCategoryMetric.add(1, {
      category: disposition.category,
      retryable: disposition.retryable ? 'true' : 'false',
      code: errorCode ?? 'unknown',
    });
    let attempts = deliveries;
    if (!disposition.retryable) {
      attempts = this.maxDeliveries;
      dlqPoisonMetric.add(1, { category: disposition.category, code: errorCode ?? 'unknown' });
    }
    if (attempts < this.maxDeliveries) {
      const delayMs = this.computeRetryDelayMs(deliveries);
      this.retriesScheduledCount += 1;
      retryScheduledMetric.add(1, { topic, attempt: deliveries, delayMs });
      try {
        msg.nak(delayMs);
      } catch (nakErr) {
        console.error('[NatsBus] failed to schedule retry', nakErr);
      }
      this.updateBackpressureState();
      return;
    }

    const dlqEvent: Record<string, unknown> = {
      originalTopic: topic,
      ts: new Date().toISOString(),
      errorCode,
      errorMessage: disposition.message,
    };
    if (correlationId) {
      dlqEvent.correlationId = correlationId;
    }
    const messageId = this.deriveMessageId(payload, headers);
    const partitionKey = extractPartitionKey(payload, headers, topic) ?? messageId;
    const payloadRef: Record<string, unknown> = {
      deliveries,
      maxDeliveries: this.maxDeliveries,
      hasHeaders: Boolean(headers && Object.keys(headers).length > 0),
      attempts,
      retryable: disposition.retryable,
      category: disposition.category,
      lastAttemptAt: new Date().toISOString(),
      errorMessage: disposition.message,
    };
    if (messageId) {
      payloadRef.messageId = messageId;
      payloadRef.envelopeId = messageId;
    }
    if (partitionKey) {
      payloadRef.partitionKey = partitionKey;
    }
    if (info && typeof info.pending === 'number') {
      payloadRef.pending = info.pending;
    }
    if (disposition.retryable && deliveries < this.maxDeliveries) {
      payloadRef.nextRetryDelayMs = this.computeRetryDelayMs(deliveries);
    }
    dlqEvent.payloadRef = payloadRef;

    if (!validateDlqEvent(dlqEvent)) {
      const issues = (validateDlqEvent.errors ?? []).map((err) => formatAjvError(err as AjvValidationError)).join('; ');
      console.error('[NatsBus] DLQ event failed validation', issues);
      await msg.ack();
      return;
    }

    try {
      const envelope = buildDeadLetterEnvelope(this.deadLetterTopic, dlqEvent, correlationId);
      const dlqHeaders = buildDeadLetterHeaders(topic, correlationId, partitionKey, disposition, errorCode);
      await this.publish(this.deadLetterTopic, envelope, dlqHeaders);
      this.dlqPublishedCount += 1;
      dlqPublishMetric.add(1, { topic });
      await msg.ack();
      this.lastAckTimestamp = Date.now();
    } catch (dlqError) {
      console.error('[NatsBus] failed to publish to DLQ', dlqError);
      this.dlqPublishFailuresCount += 1;
      dlqErrorMetric.add(1, { topic });
      const delayMs = this.computeRetryDelayMs(this.maxDeliveries);
      try {
        msg.nak(delayMs);
      } catch (nakErr) {
        console.error('[NatsBus] failed to reschedule after DLQ publish error', nakErr);
      }
    }
    this.invalidateHealthCache();
    this.updateBackpressureState();
  }

  private extractErrorCode(err: unknown): string | undefined {
    if (!err) return undefined;
    if (typeof err === 'string') return err;
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string' && code.trim().length > 0) {
      return code;
    }
    if (err instanceof Error) {
      return err.name || 'Error';
    }
    return undefined;
  }

  private toMsgHeaders(record: Record<string, string>): MsgHdrs {
    const hdrs = createHeaders();
    for (const [key, value] of Object.entries(record)) {
      hdrs.set(key, value);
    }
    return hdrs;
  }

  private fromMsgHeaders(hdrs: MsgHdrs): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [key, values] of hdrs) {
      if (Array.isArray(values) && values.length > 0) {
        result[key] = values[0];
      }
    }
    return result;
  }
}

function formatAjvError(err: AjvValidationError): string {
  const path = err.instancePath || err.schemaPath || err.dataPath || '';
  const message = err.message ?? 'invalid';
  return `${path}: ${message}`;
}

function normalizeCorrelationId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeIdCandidate(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function extractCorrelationIdFrom(
  payload: unknown,
  headers: Record<string, string> | undefined,
): string | undefined {
  if (payload && typeof payload === 'object') {
    const candidate = (payload as { correlationId?: unknown }).correlationId;
    const fromPayload = normalizeCorrelationId(candidate);
    if (fromPayload) {
      return fromPayload;
    }
  }
  if (!headers) {
    return undefined;
  }
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === 'x-correlation-id') {
      const fromHeader = normalizeCorrelationId(value);
      if (fromHeader) {
        return fromHeader;
      }
    }
  }
  return undefined;
}

function findHeaderInsensitive(
  headers: Record<string, string>,
  name: string,
): { key: string; value: string } | undefined {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) {
      return { key, value };
    }
  }
  return undefined;
}

type FailureCategory = 'transient' | 'validation' | 'security' | 'fatal';

interface FailureDisposition {
  retryable: boolean;
  category: FailureCategory;
  code?: string;
  message: string;
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  if (value === undefined || value === null) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizePathEnv(value: string | undefined): string | undefined {
  const normalized = normalizeOptionalString(value);
  if (!normalized) return undefined;
  return resolve(normalized);
}

function safeReadFileUtf8(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(`[NatsBus] failed to read file: ${path} - ${err instanceof Error ? err.message : String(err)}`);
  }
}

function safeReadFileBinary(path: string): Buffer {
  try {
    return readFileSync(path);
  } catch (err) {
    throw new Error(`[NatsBus] failed to read file: ${path} - ${err instanceof Error ? err.message : String(err)}`);
  }
}

function classifyFailure(err: unknown): FailureDisposition {
  const message = sanitizeErrorMessage(err);
  const code = sanitizeErrorCode(err);
  const status = extractStatusCode(err);
  const retryableFlag = (err as { retryable?: unknown })?.retryable;
  const fatalFlag = (err as { fatal?: unknown })?.fatal;

  if (retryableFlag === false || fatalFlag === true) {
    return {
      retryable: false,
      category: pickFailureCategory(code, status, false),
      code,
      message,
    };
  }

  if (status !== undefined && status >= 400 && status < 500 && status !== 429) {
    return {
      retryable: false,
      category: pickFailureCategory(code, status, false),
      code,
      message,
    };
  }

  if (code && NON_RETRYABLE_CODES.has(code)) {
    return {
      retryable: false,
      category: pickFailureCategory(code, status, false),
      code,
      message,
    };
  }

  return {
    retryable: true,
    category: pickFailureCategory(code, status, true),
    code,
    message,
  };
}

function sanitizeErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return truncate(err.message, TRUNCATED_ERROR_MESSAGE_LENGTH);
  }
  if (typeof err === 'string') {
    return truncate(err, TRUNCATED_ERROR_MESSAGE_LENGTH);
  }
  try {
    return truncate(JSON.stringify(err), TRUNCATED_ERROR_MESSAGE_LENGTH);
  } catch {
    return 'unknown_error';
  }
}

function sanitizeErrorCode(err: unknown): string | undefined {
  const candidate = (err as { code?: unknown })?.code ?? (err as { statusCode?: unknown })?.statusCode;
  if (typeof candidate === 'number') {
    return String(candidate);
  }
  if (typeof candidate === 'string') {
    const trimmed = candidate.trim();
    return trimmed.length > 0 ? trimmed.toLowerCase() : undefined;
  }
  return undefined;
}

function extractStatusCode(err: unknown): number | undefined {
  const candidate = (err as { status?: unknown })?.status ?? (err as { statusCode?: unknown })?.statusCode;
  if (typeof candidate === 'number' && Number.isFinite(candidate)) {
    return candidate;
  }
  if (typeof candidate === 'string') {
    const parsed = Number(candidate);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function pickFailureCategory(code: string | undefined, status: number | undefined, retryable: boolean): FailureCategory {
  if (code && SECURITY_CODES.has(code)) return 'security';
  if (code && VALIDATION_CODES.has(code)) return 'validation';
  if (!retryable) return 'fatal';
  if (status && status >= 500) return 'fatal';
  return 'transient';
}

function truncate(value: string, limit: number): string {
  if (value.length <= limit) {
    return value;
  }
  return `${value.slice(0, limit)}…`;
}

function createMessageSizeError(actual: number, limit: number, topic: string): Error {
  const error = new Error(`message_size_limit_exceeded: topic=${topic} actual=${actual} limit=${limit}`);
  (error as { code?: string }).code = 'message_size_limit_exceeded';
  (error as { actual?: number }).actual = actual;
  (error as { limit?: number }).limit = limit;
  (error as { topic?: string }).topic = topic;
  return error;
}

class TokenBucket {
  private tokens: number;
  private lastRefillMs: number;

  constructor(private readonly ratePerSecond: number, private readonly burst: number) {
    this.tokens = Math.max(0, burst);
    this.lastRefillMs = Date.now();
  }

  tryRemoveTokens(count: number, now: number = Date.now()): boolean {
    this.refill(now);
    if (this.tokens >= count) {
      this.tokens -= count;
      return true;
    }
    return false;
  }

  private refill(now: number): void {
    if (now <= this.lastRefillMs) return;
    const elapsedMs = now - this.lastRefillMs;
    const added = (elapsedMs / 1000) * this.ratePerSecond;
    if (added > 0) {
      this.tokens = Math.min(this.burst, this.tokens + added);
      this.lastRefillMs = now;
    }
  }
}

class PartitionUsageTracker {
  private readonly entries = new Map<string, { count: number; windowStart: number }>();

  constructor(private readonly options: PartitionUsageTrackerOptions) {}

  record(partitionKey: string, now: number = Date.now()): { rate: number; hot: boolean } {
    const windowMs = this.options.windowMs;
    let entry = this.entries.get(partitionKey);
    if (!entry || now - entry.windowStart >= windowMs) {
      entry = { count: 1, windowStart: now };
      this.entries.set(partitionKey, entry);
      this.trim(now);
    } else {
      entry.count += 1;
    }
    const elapsedMs = Math.max(1, now - entry.windowStart);
    const ratePerSecond = (entry.count / elapsedMs) * 1000;
    const hot = this.options.hotKeyThresholdPerSecond > 0 && ratePerSecond >= this.options.hotKeyThresholdPerSecond;
    return { rate: ratePerSecond, hot };
  }

  private trim(now: number): void {
    const expiry = now - this.options.windowMs * 2;
    for (const [key, entry] of this.entries.entries()) {
      if (entry.windowStart < expiry) {
        this.entries.delete(key);
      }
    }
  }
}

function createTenantQuotaError(topic: string, tenantId: string | undefined): Error {
  const error = new Error('tenant_quota_exceeded');
  (error as { code?: string }).code = 'tenant_quota_exceeded';
  (error as { topic?: string }).topic = topic;
  (error as { tenant?: string | undefined }).tenant = tenantId;
  return error;
}

function maybeCompressEnvelopePayload(
  envelope: unknown,
  thresholdBytes: number,
  topic: string,
): { payload: unknown; compressed: boolean } {
  if (thresholdBytes <= 0) return { payload: envelope, compressed: false };
  if (!envelope || typeof envelope !== 'object') return { payload: envelope, compressed: false };
  const record = envelope as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(record, 'payload')) {
    return { payload: envelope, compressed: false };
  }
  try {
    const rawJson = JSON.stringify(record.payload);
    if (Buffer.byteLength(rawJson, 'utf8') <= thresholdBytes) {
      return { payload: envelope, compressed: false };
    }
    const compressed = gzipSync(Buffer.from(rawJson, 'utf8'));
    if (compressed.byteLength >= Buffer.byteLength(rawJson, 'utf8')) {
      return { payload: envelope, compressed: false };
    }
    const clone: Record<string, unknown> = { ...record };
    clone.payload = compressed.toString('base64');
    clone[COMPRESSION_FLAG] = COMPRESSION_ENCODING;
    messageCompressedMetric.add(1, { topic });
    return { payload: clone, compressed: true };
  } catch {
    return { payload: envelope, compressed: false };
  }
}

function maybeDecompressEnvelopePayload(envelope: unknown): { payload: unknown; decompressed: boolean } {
  if (!envelope || typeof envelope !== 'object') {
    return { payload: envelope, decompressed: false };
  }
  const record = envelope as Record<string, unknown>;
  if (record[COMPRESSION_FLAG] !== COMPRESSION_ENCODING) {
    return { payload: envelope, decompressed: false };
  }
  try {
    const base64Payload = record.payload;
    if (typeof base64Payload !== 'string') {
      return { payload: envelope, decompressed: false };
    }
    const buffer = Buffer.from(base64Payload, 'base64');
    const json = gunzipSync(buffer).toString('utf8');
    const decompressedPayload = JSON.parse(json);
    const clone: Record<string, unknown> = { ...record };
    delete clone[COMPRESSION_FLAG];
    clone.payload = decompressedPayload;
    return { payload: clone, decompressed: true };
  } catch {
    return { payload: envelope, decompressed: false };
  }
}

function parseTenantRateEnv(): TenantRateLimitOptions {
  const result: TenantRateLimitOptions = {};
  const rateEnv = Number(process.env.NATS_TENANT_RATE_TPS);
  if (Number.isFinite(rateEnv) && rateEnv >= 0) {
    result.defaultRatePerSecond = rateEnv;
  }
  const burstEnv = Number(process.env.NATS_TENANT_RATE_BURST);
  if (Number.isFinite(burstEnv) && burstEnv >= 0) {
    result.defaultBurst = burstEnv;
  }
  const overridesRaw = (process.env.NATS_TENANT_RATE_OVERRIDES ?? '').trim();
  const overrides = parseTenantOverrides(overridesRaw);
  if (overrides) {
    result.overrides = overrides;
  }
  return result;
}

function mergeTenantRateOptions(
  base: TenantRateLimitOptions,
  override?: TenantRateLimitOptions,
): TenantRateLimitOptions {
  if (!override) return { ...base };
  return {
    defaultRatePerSecond: override.defaultRatePerSecond ?? base.defaultRatePerSecond,
    defaultBurst: override.defaultBurst ?? base.defaultBurst,
    overrides: {
      ...(base.overrides ?? {}),
      ...(override.overrides ?? {}),
    },
    tenantResolver: override.tenantResolver ?? base.tenantResolver,
  };
}

function parseTenantOverrides(raw: string): Record<string, TenantRateOverride> | undefined {
  if (!raw) return undefined;
  let parsed: Record<string, TenantRateOverride> | undefined;
  if (raw.trim().startsWith('{')) {
    try {
      const json = JSON.parse(raw.trim()) as Record<string, unknown>;
      const result: Record<string, TenantRateOverride> = {};
      for (const [tenant, value] of Object.entries(json)) {
        if (!tenant) continue;
        if (typeof value === 'number') {
          result[tenant] = { rate: value };
          continue;
        }
        if (value && typeof value === 'object') {
          const rateCandidate =
            (value as { rate?: unknown }).rate ??
            (value as { tokensPerSecond?: unknown }).tokensPerSecond ??
            (value as { tps?: unknown }).tps;
          const rate = Number(rateCandidate);
          if (!Number.isFinite(rate) || rate <= 0) continue;
          const burstCandidate =
            (value as { burst?: unknown }).burst ?? (value as { capacity?: unknown }).capacity;
          const burst = Number(burstCandidate);
          const override: TenantRateOverride = { rate };
          if (Number.isFinite(burst) && burst > 0) {
            override.burst = burst;
          }
          result[tenant] = override;
        }
      }
      parsed = Object.keys(result).length > 0 ? result : undefined;
    } catch {
      parsed = undefined;
    }
  }
  if (parsed) return parsed;
  const entries = raw.split(',').map((entry) => entry.trim()).filter(Boolean);
  if (entries.length === 0) return undefined;
  const result: Record<string, TenantRateOverride> = {};
  for (const entry of entries) {
    const [tenantPart, values] = entry.split('=');
    if (!tenantPart || !values) continue;
    const [ratePart, burstPart] = values.split(':');
    const rate = Number(ratePart);
    if (!Number.isFinite(rate) || rate <= 0) continue;
    const override: TenantRateOverride = { rate };
    const burst = Number(burstPart);
    if (Number.isFinite(burst) && burst > 0) {
      override.burst = burst;
    }
    result[tenantPart.trim()] = override;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function normalizeTenantRateLimit(options: TenantRateLimitOptions): TenantRateLimitResolved {
  const defaultRate = Number.isFinite(options.defaultRatePerSecond ?? NaN)
    ? Math.max(0, Number(options.defaultRatePerSecond))
    : 0;
  let defaultBurst = Number.isFinite(options.defaultBurst ?? NaN)
    ? Math.max(0, Number(options.defaultBurst))
    : 0;
  if (defaultBurst <= 0 && defaultRate > 0) {
    defaultBurst = defaultRate;
  }
  const overrides = new Map<string, TenantRateOverrideResolved>();
  if (options.overrides) {
    for (const [tenant, override] of Object.entries(options.overrides)) {
      if (!tenant) continue;
      const rate = Number(override?.rate);
      if (!Number.isFinite(rate) || rate <= 0) continue;
      let burst = Number((override?.burst ?? NaN));
      if (!Number.isFinite(burst) || burst <= 0) {
        burst = rate;
      }
      overrides.set(tenant, { rate, burst });
    }
  }
  const enabled = defaultRate > 0 || overrides.size > 0;
  return {
    defaultRate,
    defaultBurst: defaultBurst > 0 ? defaultBurst : defaultRate,
    overrides,
    resolver: options.tenantResolver,
    enabled,
  };
}

function extractTenantId(
  payload: unknown,
  headers: Record<string, string> | undefined,
): string | undefined {
  if (headers) {
    const tenantHeader = findHeaderInsensitive(headers, 'x-tenant-id');
    if (tenantHeader) {
      const normalized = normalizeIdCandidate(tenantHeader.value);
      if (normalized) return normalized;
    }
    const practiceHeader = findHeaderInsensitive(headers, 'x-practice-id');
    if (practiceHeader) {
      const normalized = normalizeIdCandidate(practiceHeader.value);
      if (normalized) return normalized;
    }
  }
  if (payload && typeof payload === 'object') {
    const candidate = normalizeIdCandidate((payload as { tenantId?: unknown }).tenantId);
    if (candidate) return candidate;
    if ('payload' in payload) {
      const inner = (payload as { payload?: unknown }).payload;
      if (inner && typeof inner === 'object') {
        const preferred = ['tenantId', 'practiceId', 'accountId', 'organisationId'];
        for (const key of preferred) {
          const innerCandidate = normalizeIdCandidate((inner as Record<string, unknown>)[key]);
          if (innerCandidate) return innerCandidate;
        }
      }
    }
  }
  return undefined;
}

function extractPartitionKey(
  payload: unknown,
  headers: Record<string, string> | undefined,
  topic: string,
): string | undefined {
  if (headers) {
    const explicit = findHeaderInsensitive(headers, PARTITION_HEADER);
    if (explicit) {
      const normalized = normalizeIdCandidate(explicit.value);
      if (normalized) return normalized;
    }
    const tenant = findHeaderInsensitive(headers, 'x-tenant-id');
    if (tenant) {
      const normalized = normalizeIdCandidate(tenant.value);
      if (normalized) return normalized;
    }
    const practice = findHeaderInsensitive(headers, 'x-practice-id');
    if (practice) {
      const normalized = normalizeIdCandidate(practice.value);
      if (normalized) return normalized;
    }
  }
  if (payload && typeof payload === 'object') {
    const direct = normalizeIdCandidate((payload as { partitionKey?: unknown }).partitionKey);
    if (direct) return direct;
    const envelopeCorrelation = normalizeIdCandidate((payload as { correlationId?: unknown }).correlationId);
    if (envelopeCorrelation) return envelopeCorrelation;
    const envelopeId = normalizeIdCandidate((payload as { id?: unknown }).id);
    if (envelopeId) return envelopeId;
    if ('payload' in payload) {
      const inner = (payload as { payload?: unknown }).payload;
      if (inner && typeof inner === 'object') {
        const preferredKeys = ['partitionKey', 'tenantId', 'practiceId', 'patientId', 'entityId', 'id', 'key'];
        for (const key of preferredKeys) {
          const candidate = normalizeIdCandidate((inner as Record<string, unknown>)[key]);
          if (candidate) return candidate;
        }
      }
    }
  }
  if (headers) {
    const correlationHeader = findHeaderInsensitive(headers, 'x-correlation-id');
    if (correlationHeader) {
      const normalized = normalizeIdCandidate(correlationHeader.value);
      if (normalized) return normalized;
    }
  }
  return normalizeIdCandidate(topic);
}

function partitionIndexFor(key: string, partitions: number): number {
  if (!key || partitions <= 1) return 0;
  const digest = createHash('sha1').update(key).digest();
  let value = 0;
  for (let i = 0; i < 4; i += 1) {
    value = (value << 8) | digest[i];
  }
  return Math.abs(value) % partitions;
}

function parseBoolean(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function buildDeadLetterEnvelope(
  topic: string,
  payload: unknown,
  correlationId: string | undefined,
): { id: string; topic: string; timestamp: string; payload: unknown; correlationId?: string } {
  const envelope: { id: string; topic: string; timestamp: string; payload: unknown; correlationId?: string } = {
    id: randomUUID(),
    topic,
    timestamp: new Date().toISOString(),
    payload,
  };
  if (correlationId) {
    envelope.correlationId = correlationId;
  }
  return envelope;
}

function buildDeadLetterHeaders(
  originalTopic: string,
  correlationId: string | undefined,
  partitionKey: string | undefined,
  failure: FailureDisposition,
  failureCode?: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    'x-original-topic': originalTopic,
  };
  if (correlationId) {
    headers['x-correlation-id'] = correlationId;
  }
  if (partitionKey) {
    headers[PARTITION_HEADER] = partitionKey;
  }
  headers['x-retryable'] = String(failure.retryable);
  headers['x-failure-category'] = failure.category;
  if (failureCode) {
    headers['x-error-code'] = failureCode;
  }
  return headers;
}

export function getBus(opts?: NatsBusOptions): MessageBus {
  const impl = (process.env.BUS_IMPL ?? '').trim().toLowerCase();
  if (impl === 'memory' && !opts?.connection) {
    return new MemoryBus();
  }
  const rawUrl = opts?.url ?? process.env.NATS_URL;
  if (rawUrl && rawUrl.trim().length > 0) {
    return new NatsBus({ ...opts, url: rawUrl.trim() });
  }
  return new MemoryBus();
}

export interface NatsBusDiagnosticsExtended extends NatsBusDiagnostics {
  ackWaitMs: number;
  maxAckPending: number;
  maxDeliveries: number;
}

export function getNatsBusDiagnostics(bus: MessageBus): NatsBusDiagnosticsExtended | null {
  const inner = unwrapGuardedBus(bus);
  if (inner instanceof NatsBus) {
    return inner.getDiagnostics();
  }
  return null;
}

export interface NatsBusHealth {
  computedAt: number;
  isConnected: boolean;
  backpressure: boolean;
  pendingLag: number;
  inFlight: number;
  lastErrorAt: number | null;
  lastAckAt: number | null;
  partitions: number;
  subscribed: number;
  isReady: boolean;
  diagnostics: NatsBusDiagnosticsExtended;
}

export function getNatsBusHealth(bus: MessageBus, options?: { maxAgeMs?: number }): NatsBusHealth | null {
  const inner = unwrapGuardedBus(bus);
  if (inner instanceof NatsBus) {
    return inner.getHealthSnapshot(options?.maxAgeMs);
  }
  return null;
}

export function markNatsBusConnected(bus: MessageBus, connected: boolean): void {
  const inner = unwrapGuardedBus(bus);
  if (inner instanceof NatsBus) {
    inner.setConnected(connected);
  }
}

export async function refreshNatsBusSecurity(bus: MessageBus): Promise<void> {
  const inner = unwrapGuardedBus(bus);
  if (inner instanceof NatsBus) {
    await inner.refreshSecurityMaterial();
  }
}
