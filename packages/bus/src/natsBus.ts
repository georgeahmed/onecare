import type { Handler, MessageBus, Subscription } from './types';
import { MemoryBus } from './memoryBus';

export interface NatsBusOptions {
  url?: string;
}

/**
 * Skeleton implementation of a NATS-backed MessageBus. This currently records
 * configuration only; networking will be introduced in later tasks.
 */
export class NatsBus implements MessageBus {
  readonly url: string;
  private connected: boolean;
  private publishedCount = 0;
  private subscribedCount = 0;

  constructor(opts: NatsBusOptions = {}) {
    this.url = opts.url ?? process.env.NATS_URL ?? 'nats://localhost:4222';
    this.connected = Boolean(opts.url ?? process.env.NATS_URL);
  }

  async publish<T>(_topic: string, _payload: T, _headers?: Record<string, string>): Promise<void> {
    this.publishedCount += 1;
    // Stub: network integration TBD.
  }

  async subscribe<T>(_topic: string, _handler: Handler<T>): Promise<Subscription> {
    this.subscribedCount += 1;
    // Stub subscription; returns a no-op unsubscribe.
    return {
      unsubscribe: async () => {
        /* no-op */
      },
    };
  }

  setConnected(connected: boolean): void {
    this.connected = connected;
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
}

export function getBus(): MessageBus {
  const rawUrl = process.env.NATS_URL;
  if (rawUrl && rawUrl.trim().length > 0) {
    return new NatsBus({ url: rawUrl.trim() });
  }
  return new MemoryBus();
}

export interface NatsBusDiagnostics {
  isConnected: boolean;
  published: number;
  subscribed: number;
}

export function getNatsBusDiagnostics(bus: MessageBus): NatsBusDiagnostics | null {
  if (bus instanceof NatsBus) {
    return {
      isConnected: bus.isConnected,
      published: bus.published,
      subscribed: bus.subscribed,
    };
  }
  return null;
}

export function markNatsBusConnected(bus: MessageBus, connected: boolean): void {
  if (bus instanceof NatsBus) {
    bus.setConnected(connected);
  }
}
