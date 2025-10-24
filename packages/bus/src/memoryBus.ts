import { Handler, Message, MessageBus, Subscription } from './types';
import { extractPartitionKey, extractTenantId } from './messageMetadata';

export class MemoryBus implements MessageBus {
  private handlers: Map<string, Set<Handler<unknown>>> = new Map();

  async publish<T>(topic: string, payload: T, headers?: Record<string, string>): Promise<void> {
    const handlers = this.handlers.get(topic);
    if (!handlers) return;
    const sourceHeaders = headers ? { ...headers } : undefined;
    const tenantId = extractTenantId(payload, sourceHeaders);
    const partitionKey = extractPartitionKey(payload, sourceHeaders, topic);
    for (const handler of handlers) {
      const message: Message<T> = {
        topic,
        payload: clonePayload(payload),
        headers: sourceHeaders ? { ...sourceHeaders } : undefined,
        tenantId,
        partitionKey,
      };
      try {
        await (handler as Handler<T>)(message);
      } catch (err) {
        console.error('[MemoryBus] handler error', err);
      }
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

function clonePayload<T>(payload: T): T {
  if (payload === null || typeof payload !== 'object') {
    return payload;
  }
  try {
    return JSON.parse(JSON.stringify(payload)) as T;
  } catch {
    if (Array.isArray(payload)) {
      return [...payload] as unknown as T;
    }
    return { ...(payload as Record<string, unknown>) } as T;
  }
}
