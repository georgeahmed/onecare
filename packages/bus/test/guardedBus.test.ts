import { describe, it, expect, vi } from 'vitest';
import { MemoryBus } from '../src/memoryBus';
import { withMessageGuards } from '../src/guardedBus';
import type { IdempotencyStore } from '@onecare/ports';

function buildEnvelope<T>(topic: string, payload: T, correlationId?: string, id?: string) {
  return {
    id: id ?? 'env-' + Math.random().toString(36).slice(2),
    topic,
    timestamp: new Date().toISOString(),
    payload,
    correlationId,
  };
}

class SimpleIdempotencyStore implements IdempotencyStore {
  private readonly keys = new Set<string>();

  async reserve(key: string, _ttlSeconds: number): Promise<'reserved' | 'exists'> {
    if (this.keys.has(key)) {
      return 'exists';
    }
    this.keys.add(key);
    return 'reserved';
  }

  async exists(key: string): Promise<boolean> {
    return this.keys.has(key);
  }

  async put(key: string, _ttlSeconds: number): Promise<void> {
    this.keys.add(key);
  }

  async delete(key: string): Promise<void> {
    this.keys.delete(key);
  }

  readKeys(): string[] {
    return Array.from(this.keys);
  }
}

describe('withMessageGuards', () => {
  it('rejects publishes to disallowed topics', async () => {
    const bus = withMessageGuards(new MemoryBus(), { allowedTopics: ['allowed.topic'] });
    await expect(async () => {
      await bus.publish('blocked.topic', buildEnvelope('blocked.topic', { ok: true }));
    }).rejects.toThrow(/topic_not_allowlisted/);
  });

  it('propagates correlationId headers when publishing envelopes', async () => {
    const bus = withMessageGuards(new MemoryBus(), { allowedTopics: ['demo.topic'] });
    let seenHeaders: Record<string, string> | undefined;

    await bus.subscribe('demo.topic', (message) => {
      seenHeaders = message.headers;
    });

    const envelope = buildEnvelope('demo.topic', { ok: true }, 'corr-123', 'env-fixed');
    await bus.publish('demo.topic', envelope);
    expect(seenHeaders?.['x-correlation-id']).toBe('corr-123');
    expect(seenHeaders?.['x-message-id']).toBe(envelope.id);
  });

  it('throws when envelope topic mismatches publish topic', async () => {
    const bus = withMessageGuards(new MemoryBus(), { allowedTopics: ['demo.topic'] });
    await expect(async () => {
      await bus.publish('demo.topic', buildEnvelope('other.topic', { ok: true }));
    }).rejects.toThrow(/envelope_topic_mismatch/);
  });

  it('fails inbound delivery without correlation header when required', async () => {
    const inner = new MemoryBus();
    const bus = withMessageGuards(inner, { allowedTopics: ['demo.topic'] });
    await bus.subscribe('demo.topic', async () => {
      /* noop */
    });

    await expect(async () => {
      await inner.publish('demo.topic', buildEnvelope('demo.topic', { ok: true }, 'corr-inbound'));
    }).rejects.toThrow(/correlation_header_missing/);
  });

  it('rejects publishes when message id header mismatches envelope', async () => {
    const bus = withMessageGuards(new MemoryBus(), { allowedTopics: ['demo.topic'] });
    const envelope = buildEnvelope('demo.topic', { ok: true }, 'corr-1', 'env-expected');
    await expect(async () => {
      await bus.publish('demo.topic', envelope, { 'x-message-id': 'env-other' });
    }).rejects.toThrow(/message_id_mismatch/);
  });

  it('skips duplicate deliveries when idempotency store present', async () => {
    const store = new SimpleIdempotencyStore();
    const bus = withMessageGuards(new MemoryBus(), { allowedTopics: ['demo.topic'], idempotencyStore: store });
    const handler = vi.fn();

    await bus.subscribe('demo.topic', async (message) => {
      handler(message);
    });

    const envelope = buildEnvelope('demo.topic', { ok: true }, 'corr-dup', 'dup-key');
    await bus.publish('demo.topic', envelope);
    await bus.publish('demo.topic', envelope);

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('processes all deliveries when no idempotency key can be derived', async () => {
    const store = new SimpleIdempotencyStore();
    const bus = withMessageGuards(new MemoryBus(), {
      allowedTopics: ['demo.topic'],
      enforceEnvelope: false,
      requireCorrelationHeader: false,
      idempotencyStore: store,
    });
    const handler = vi.fn();

    await bus.subscribe('demo.topic', async (message) => {
      handler(message);
    });

    const payload = { ok: true };
    await bus.publish('demo.topic', payload);
    await bus.publish('demo.topic', payload);

    expect(handler).toHaveBeenCalledTimes(2);
    expect(store.readKeys().length).toBe(0);
  });
});
