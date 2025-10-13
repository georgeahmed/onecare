import type { Handler, MessageBus, Subscription } from './types';
import { MemoryBus } from './memoryBus';
import { unwrapGuardedBus } from './guardedBus';
import {
  connect,
  headers as createHeaders,
  type ConnectionOptions,
  type Msg,
  type MsgHdrs,
  type NatsConnection,
  type Subscription as NatsSubscription,
} from 'nats';

export interface NatsBusOptions {
  url?: string;
  connection?: NatsConnection;
  queueGroup?: string;
  deadLetterTopic?: string;
}

export interface NatsBusDiagnostics {
  isConnected: boolean;
  published: number;
  subscribed: number;
}

const DEFAULT_QUEUE_GROUP = process.env.NATS_QUEUE_GROUP || 'onecare-workers';
const DEFAULT_DLQ_TOPIC = process.env.NATS_DLQ_TOPIC || 'broker.dlq';

export class NatsBus implements MessageBus {
  readonly url: string;
  private readonly queueGroup: string;
  private readonly deadLetterTopic: string;
  private readonly encoder = new TextEncoder();
  private readonly decoder = new TextDecoder();
  private connectionPromise?: Promise<NatsConnection>;
  private statusMonitor?: Promise<void>;
  private closedMonitor?: Promise<void>;
  private connected = false;
  private publishedCount = 0;
  private subscribedCount = 0;

  constructor(private readonly opts: NatsBusOptions = {}) {
    this.url = (opts.url ?? process.env.NATS_URL ?? 'nats://localhost:4222').trim();
    this.queueGroup = opts.queueGroup ?? DEFAULT_QUEUE_GROUP;
    this.deadLetterTopic = opts.deadLetterTopic ?? DEFAULT_DLQ_TOPIC;
    if (opts.connection) {
      this.connectionPromise = Promise.resolve(opts.connection);
      this.connected = true;
      this.statusMonitor = this.monitorConnection(opts.connection).catch(() => undefined);
      this.closedMonitor = opts.connection.closed().then((err) => {
        this.connected = false;
        this.connectionPromise = undefined;
        this.statusMonitor = undefined;
        if (err) {
          console.error('[NatsBus] connection closed with error', err.message);
        }
      });
    }
  }

  async publish<T>(topic: string, payload: T, headers?: Record<string, string>): Promise<void> {
    try {
      const conn = await this.getConnection();
      const data = this.encoder.encode(JSON.stringify(payload));
      const publishOptions = headers ? { headers: this.toMsgHeaders(headers) } : undefined;
      conn.publish(topic, data, publishOptions);
      await conn.flush();
      this.publishedCount += 1;
    } catch (err) {
      this.connected = false;
      throw err;
    }
  }

  async subscribe<T>(topic: string, handler: Handler<T>): Promise<Subscription> {
    const conn = await this.getConnection();
    const queue = this.queueGroupFor(topic);
    const subscription = conn.subscribe(topic, { queue }) as NatsSubscription;
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

  private queueGroupFor(topic: string): string {
    if (this.queueGroup) return this.queueGroup;
    return topic.replace(/[^a-zA-Z0-9]/g, '_') || 'onecare';
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
          this.connected = true;
        } else if (
          status.type === 'disconnect' ||
          status.type === 'error' ||
          status.type === 'reconnecting' ||
          status.type === 'staleConnection'
        ) {
          this.connected = false;
        }
      }
    } catch (err) {
      console.error('[NatsBus] status monitor error', err instanceof Error ? err.message : err);
    }
  }

  private async consume<T>(subscription: NatsSubscription, handler: Handler<T>, topic: string): Promise<void> {
    for await (const msg of subscription) {
      await this.processMessage(msg, handler, topic);
    }
  }

  private async processMessage<T>(msg: Msg, handler: Handler<T>, fallbackTopic: string): Promise<void> {
    const messageTopic = msg.subject || fallbackTopic;
    const raw = this.decoder.decode(msg.data);
    let payload: unknown = raw;
    try {
      payload = JSON.parse(raw);
    } catch {
      // keep raw string
    }
    const headers = msg.headers ? this.fromMsgHeaders(msg.headers) : undefined;
    try {
      await handler({
        topic: messageTopic,
        payload: payload as T,
        headers,
      });
    } catch (err) {
      console.error('[NatsBus] handler error', err);
      if (messageTopic !== this.deadLetterTopic) {
        const dlqPayload = {
          originalTopic: messageTopic,
          receivedAt: new Date().toISOString(),
          payload,
          headers,
          error: err instanceof Error ? err.message : String(err),
        };
        try {
          await this.publish(this.deadLetterTopic, dlqPayload);
        } catch (dlqError) {
          console.error('[NatsBus] failed to publish to DLQ', dlqError);
        }
      }
    }
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

export function getBus(opts?: NatsBusOptions): MessageBus {
  const rawUrl = opts?.url ?? process.env.NATS_URL;
  if (rawUrl && rawUrl.trim().length > 0) {
    return new NatsBus({ ...opts, url: rawUrl.trim() });
  }
  return new MemoryBus();
}

export function getNatsBusDiagnostics(bus: MessageBus): NatsBusDiagnostics | null {
  const inner = unwrapGuardedBus(bus);
  if (inner instanceof NatsBus) {
    return {
      isConnected: inner.isConnected,
      published: inner.published,
      subscribed: inner.subscribed,
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
