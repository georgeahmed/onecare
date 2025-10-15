import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('ajv/dist/2020', () => ({
  default: class MockAjv2020 {
    compile() {
      return () => true;
    }
  },
}));
vi.mock('ajv-formats', () => ({
  default: () => undefined,
}));
import { NatsBus } from '../src/natsBus';

function createConnectionStub(publishMock = vi.fn()) {
  const jsClient = {
    publish: publishMock,
    subscribe: vi.fn(),
  };
  const connection = {
    jetstream: () => jsClient,
    status: () =>
      ({
        async *[Symbol.asyncIterator]() {
          // no status events
        },
      }) as AsyncIterable<never>,
    closed: () => Promise.resolve(undefined),
  };
  return { connection: connection as unknown as Parameters<typeof NatsBus>[0], jsClient, publishMock };
}

describe('NatsBus publish dedupe', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('derives message id from envelope id when publishing', async () => {
    const publishMock = vi.fn().mockResolvedValue({ seq: 1 });
    const { connection } = createConnectionStub(publishMock);
    const bus = new NatsBus({ connection: connection as any });
    const envelope = {
      id: 'env-123',
      topic: 'demo.topic',
      timestamp: new Date().toISOString(),
      payload: { ok: true },
      correlationId: 'corr-123',
    };

    await bus.publish('demo.topic', envelope);

    expect(publishMock).toHaveBeenCalledTimes(1);
    const [, , options] = publishMock.mock.calls[0];
    expect(options?.msgID).toBe('env-123');
  });

  it('falls back to idempotency header when envelope id is not present', async () => {
    const publishMock = vi.fn().mockResolvedValue({ seq: 1 });
    const { connection } = createConnectionStub(publishMock);
    const bus = new NatsBus({ connection: connection as any });
    const payload = { topic: 'demo.topic', timestamp: new Date().toISOString(), payload: { ok: true } };

    await bus.publish('demo.topic', payload, { 'x-idempotency-key': 'idem-456' });

    const [, , options] = publishMock.mock.calls[0];
    expect(options?.msgID).toBe('idem-456');
  });
});

describe('NatsBus failure handling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(global.Math, 'random').mockReturnValue(0); // deterministic jitter
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function buildMessageStub(deliveryCount: number) {
    const nak = vi.fn();
    const ack = vi.fn();
    const msg: any = {
      subject: 'demo.topic',
      data: new TextEncoder().encode(JSON.stringify({ ok: true })),
      headers: undefined,
      ack,
      nak,
    };
    Object.assign(msg, {
      info: {
        deliveryCount,
        pending: 2,
      },
    });
    return { msg: msg as any, ack, nak };
  }

  it('schedules retry with backoff before max deliveries', async () => {
    const { connection } = createConnectionStub();
    const bus = new NatsBus({
      connection: connection as any,
      maxDeliveries: 3,
      retryBaseDelayMs: 100,
      retryMaxDelayMs: 1_000,
      retryJitterRatio: 0,
    });
    const { msg, nak, ack } = buildMessageStub(1);

    await (bus as any).handleFailure(msg, 'demo.topic', { correlationId: 'c1' }, undefined, new Error('boom'));

    expect(nak).toHaveBeenCalledWith(100);
    expect(ack).not.toHaveBeenCalled();
    expect(bus.getRetriesScheduled()).toBe(1);
  });

  it('publishes to DLQ when deliveries exceed threshold', async () => {
    const { connection } = createConnectionStub();
    const bus = new NatsBus({
      connection: connection as any,
      deadLetterTopic: 'broker.dlq',
      maxDeliveries: 3,
      retryBaseDelayMs: 100,
      retryMaxDelayMs: 1_000,
      retryJitterRatio: 0,
    });
    const publishSpy = vi.spyOn(bus as any, 'publish').mockResolvedValue(undefined);
    const { msg, nak, ack } = buildMessageStub(3);

    await (bus as any).handleFailure(msg, 'demo.topic', { id: 'env-789', correlationId: 'c2' }, undefined, 'fail');

    expect(publishSpy).toHaveBeenCalledWith(
      'broker.dlq',
      expect.objectContaining({
        payload: expect.objectContaining({
          originalTopic: 'demo.topic',
        }),
      }),
      expect.any(Object),
    );
    expect(ack).toHaveBeenCalledTimes(1);
    expect(nak).not.toHaveBeenCalled();
    expect(bus.getDlqPublished()).toBe(1);
  });
});
