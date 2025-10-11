import type { Handler, MessageBus, Subscription } from './types';
import { MemoryBus } from './memoryBus';

export interface NatsBusOptions {
  url?: string;
  /** @deprecated placeholder for future connection injection */
  nats?: unknown;
}

/**
 * Skeleton implementation of a NATS-backed MessageBus. This currently records
 * configuration only; networking will be introduced in later tasks.
 */
export class NatsBus implements MessageBus {
  readonly url: string;

  constructor(opts: NatsBusOptions = {}) {
    this.url = opts.url ?? process.env.NATS_URL ?? 'nats://localhost:4222';
  }

  async publish<T>(_topic: string, _payload: T, _headers?: Record<string, string>): Promise<void> {
    // Stub: network integration TBD.
  }

  async subscribe<T>(_topic: string, _handler: Handler<T>): Promise<Subscription> {
    // Stub subscription; returns a no-op unsubscribe.
    return {
      unsubscribe: async () => {
        /* no-op */
      },
    };
  }
}

export function createBusFromEnv(opts?: NatsBusOptions): MessageBus {
  if ((process.env.BUS_IMPL ?? '').toLowerCase() === 'nats') {
    return new NatsBus(opts);
  }
  return new MemoryBus();
}
