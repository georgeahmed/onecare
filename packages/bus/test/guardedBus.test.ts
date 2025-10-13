import { describe, it, expect } from 'vitest';
import { MemoryBus } from '../src/memoryBus';
import { withMessageGuards } from '../src/guardedBus';

function buildEnvelope<T>(topic: string, payload: T, correlationId?: string) {
  return {
    id: 'env-' + Math.random().toString(36).slice(2),
    topic,
    timestamp: new Date().toISOString(),
    payload,
    correlationId,
  };
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

    await bus.publish('demo.topic', buildEnvelope('demo.topic', { ok: true }, 'corr-123'));
    expect(seenHeaders?.['x-correlation-id']).toBe('corr-123');
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
});
