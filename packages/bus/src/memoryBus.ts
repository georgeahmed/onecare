import { Handler, Message, MessageBus, Subscription } from './types';

export class MemoryBus implements MessageBus {
  private handlers: Map<string, Set<Handler<unknown>>> = new Map();

  async publish<T>(topic: string, payload: T, headers?: Record<string, string>): Promise<void> {
    const handlers = this.handlers.get(topic);
    if (!handlers) return;
    const msg: Message<T> = { topic, payload, headers };
    for (const handler of handlers) {
      await (handler as Handler<T>)(msg);
    }
  }

  async subscribe<T>(topic: string, handler: Handler<T>): Promise<Subscription> {
    const typedHandler = handler as Handler<unknown>;
    const set = this.handlers.get(topic) ?? new Set<Handler<unknown>>();
    set.add(typedHandler);
    this.handlers.set(topic, set);
    return {
      unsubscribe: async () => {
        const current = this.handlers.get(topic);
        if (!current) return;
        current.delete(typedHandler);
        if (current.size === 0) this.handlers.delete(topic);
      },
    };
  }
}
