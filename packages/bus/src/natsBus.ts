import type { MessageBus, Handler, Subscription } from './types';

export interface NatsLikeConn {
  publish(subject: string, data: Uint8Array): void | Promise<void>;
  subscribe(subject: string, opts?: { queue?: string; durable?: string }): AsyncIterable<{ subject: string; data: Uint8Array }>;
  drain?(): Promise<void>;
  close?(): Promise<void>;
}

export class NatsBus implements MessageBus {
  constructor(private readonly conn: NatsLikeConn) {}

  async publish<T>(topic: string, payload: T, headers?: Record<string, string>): Promise<void> {
    // Minimal: ignore headers for now; rely on envelope payload for correlation
    const bytes = new TextEncoder().encode(JSON.stringify(payload));
    await this.conn.publish(topic, bytes);
  }

  async subscribe<T>(topic: string, handler: Handler<T>): Promise<Subscription> {
    let active = true;
    const sub = this.conn.subscribe(topic);
    (async () => {
      for await (const msg of sub) {
        if (!active) break;
        const text = new TextDecoder().decode(msg.data);
        let payload: unknown;
        try { payload = JSON.parse(text); } catch { payload = text; }
        await handler({ topic, payload: payload as T });
      }
    })();
    return {
      unsubscribe: async () => {
        active = false;
        if (this.conn.drain) await this.conn.drain();
      },
    };
  }
}

export function createBusFromEnv(opts?: { nats?: NatsLikeConn }): MessageBus {
  if (process.env.BUS_IMPL === 'nats' && opts?.nats) return new NatsBus(opts.nats);
  // Default to in-memory for dev/test
  const { MemoryBus } = require('./memoryBus');
  return new MemoryBus();
}

