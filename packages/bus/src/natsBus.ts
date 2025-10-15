import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import type { ErrorObject } from 'ajv';
import {
  connect,
  consumerOpts,
  headers as createHeaders,
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

export interface NatsBusOptions {
  url?: string;
  connection?: NatsConnection;
  queueGroup?: string;
  deadLetterTopic?: string;
  maxDeliveries?: number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
  retryJitterRatio?: number;
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
}

const DEFAULT_QUEUE_GROUP = process.env.NATS_QUEUE_GROUP || 'onecare-workers';
const DEFAULT_DLQ_TOPIC = process.env.NATS_DLQ_TOPIC || 'broker.dlq';
const DEFAULT_ACK_WAIT_MS = Number(process.env.NATS_ACK_WAIT_MS ?? 30_000);
const DEFAULT_MAX_ACK_PENDING = Number(process.env.NATS_MAX_ACK_PENDING ?? 512);
const DEFAULT_MAX_DELIVERIES = Number(process.env.NATS_MAX_DELIVERIES ?? 5);
const DEFAULT_RETRY_BASE_DELAY_MS = Number(process.env.NATS_RETRY_BASE_DELAY_MS ?? 500);
const DEFAULT_RETRY_MAX_DELAY_MS = Number(process.env.NATS_RETRY_MAX_DELAY_MS ?? 30_000);
const DEFAULT_RETRY_JITTER_RATIO = Number(process.env.NATS_RETRY_JITTER_RATIO ?? 0.2);
const MESSAGE_ID_HEADER = 'x-message-id';
const IDEMPOTENCY_HEADER = 'x-idempotency-key';
const NATS_MSG_ID_HEADER = 'nats-msg-id';

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
  }

  async publish<T>(topic: string, payload: T, headers?: Record<string, string>): Promise<void> {
    try {
      const js = await this.getJetStream();
      const data = this.encoder.encode(JSON.stringify(payload));
      const publishOptions: JetStreamPublishOptions = {};
      const messageId = this.deriveMessageId(payload, headers);
      if (headers && Object.keys(headers).length > 0) {
        publishOptions.headers = this.toMsgHeaders(headers);
      }
      if (messageId) {
        publishOptions.msgID = messageId;
      }
      await js.publish(topic, data, publishOptions);
      this.publishedCount += 1;
    } catch (err) {
      this.connected = false;
      throw err;
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

    const subscription = (await js.subscribe(topic, opts)) as JetStreamSubscription;
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
  }

  getAckWaitMs(): number {
    return this.ackWaitMs;
  }

  getMaxAckPending(): number {
    return this.maxAckPending;
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
    const user = process.env.NATS_USER;
    const pass = process.env.NATS_PASS;
    const token = process.env.NATS_TOKEN;
    if (user) options.user = user;
    if (pass) options.pass = pass;
    if (token) options.token = token;
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

  private async monitorConnection(conn: NatsConnection): Promise<void> {
    try {
      for await (const status of conn.status()) {
        if (status.type === 'reconnect') {
          this.reconnectsCount += 1;
          this.connected = true;
        } else if (
          status.type === 'disconnect' ||
          status.type === 'error' ||
          status.type === 'reconnecting' ||
          status.type === 'staleConnection'
        ) {
          this.disconnectsCount += 1;
          this.connected = false;
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
    const messageTopic = msg.subject || fallbackTopic;
    const raw = this.decoder.decode(msg.data);
    let payload: unknown = raw;
    try {
      payload = JSON.parse(raw);
    } catch {
      // keep raw string
    }
    const headers = msg.headers ? this.fromMsgHeaders(msg.headers) : undefined;
    const info = (msg as JsMsg & { info?: DeliveryInfo }).info;
    if (info && typeof info.pending === 'number' && Number.isFinite(info.pending)) {
      this.pendingLag = info.pending;
    }
    try {
      await handler({
        topic: messageTopic,
        payload: payload as T,
        headers,
      });
      await msg.ack();
    } catch (err) {
      await this.handleFailure(msg, messageTopic, payload, headers, err);
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
    if (topic === this.deadLetterTopic) {
      await msg.ack();
      return;
    }

    const correlationId = extractCorrelationIdFrom(payload, headers);
    const info = (msg as JsMsg & { info?: DeliveryInfo }).info;
    const deliveries = info?.deliveryCount ?? info?.redeliveryCount ?? 1;
    if (deliveries < this.maxDeliveries) {
      const delayMs = this.computeRetryDelayMs(deliveries);
      this.retriesScheduledCount += 1;
      try {
        msg.nak(delayMs);
      } catch (nakErr) {
        console.error('[NatsBus] failed to schedule retry', nakErr);
      }
      return;
    }

    const dlqEvent: Record<string, unknown> = {
      originalTopic: topic,
      ts: new Date().toISOString(),
      errorCode: this.extractErrorCode(err),
      errorMessage: err instanceof Error ? err.message : String(err),
    };
    if (correlationId) {
      dlqEvent.correlationId = correlationId;
    }
    const messageId = this.deriveMessageId(payload, headers);
    const payloadRef: Record<string, unknown> = {
      deliveries,
      maxDeliveries: this.maxDeliveries,
      hasHeaders: Boolean(headers && Object.keys(headers).length > 0),
    };
    if (messageId) {
      payloadRef.messageId = messageId;
    }
    if (info && typeof info.pending === 'number') {
      payloadRef.pending = info.pending;
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
      const dlqHeaders = buildDeadLetterHeaders(topic, correlationId);
      await this.publish(this.deadLetterTopic, envelope, dlqHeaders);
      this.dlqPublishedCount += 1;
      await msg.ack();
    } catch (dlqError) {
      console.error('[NatsBus] failed to publish to DLQ', dlqError);
      this.dlqPublishFailuresCount += 1;
      const delayMs = this.computeRetryDelayMs(this.maxDeliveries);
      try {
        msg.nak(delayMs);
      } catch (nakErr) {
        console.error('[NatsBus] failed to reschedule after DLQ publish error', nakErr);
      }
    }
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
): Record<string, string> {
  const headers: Record<string, string> = {
    'x-original-topic': originalTopic,
  };
  if (correlationId) {
    headers['x-correlation-id'] = correlationId;
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
}

export function getNatsBusDiagnostics(bus: MessageBus): NatsBusDiagnosticsExtended | null {
  const inner = unwrapGuardedBus(bus);
  if (inner instanceof NatsBus) {
    return {
      isConnected: inner.isConnected,
      published: inner.published,
      subscribed: inner.subscribed,
      ackWaitMs: inner.getAckWaitMs(),
      maxAckPending: inner.getMaxAckPending(),
      reconnects: inner.getReconnects(),
      disconnects: inner.getDisconnects(),
      retriesScheduled: inner.getRetriesScheduled(),
      dlqPublished: inner.getDlqPublished(),
      dlqPublishFailures: inner.getDlqPublishFailures(),
      pendingLag: inner.getPendingLag(),
    };
  }
  return null;
}

export function markNatsBusConnected(bus: MessageBus, connected: boolean): void {
  const inner = unwrapGuardedBus(bus);
  if (inner instanceof NatsBus) {
    inner.setConnected(connected);
  }
}
