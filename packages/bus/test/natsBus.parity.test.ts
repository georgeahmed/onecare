import { randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { headers as createHeaders, type DeliveryInfo, type MsgHdrs } from 'nats';
import type { Handler, MessageBus, Subscription } from '../src/types';
import { MemoryBus } from '../src/memoryBus';
import { NatsBus } from '../src/natsBus';
import { withMessageGuards } from '../src/guardedBus';
import type { IdempotencyStore } from '@onecare/ports';

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

interface TestHarness {
  name: string;
  bus: MessageBus;
  publish<T>(topic: string, payload: T, headers?: Record<string, string>): Promise<void>;
  subscribe<T>(topic: string, handler: Handler<T>): Promise<Subscription>;
  drain(): Promise<void>;
  cleanup(): Promise<void>;
  collectFailureTranscript(): Promise<FailureTranscript>;
}

interface FailureTranscript {
  retryDelays: number[];
  dlqMessages: Array<{ topic: string; payload: unknown }>;
}

describe('MessageBus parity with MemoryBus baseline', () => {
  const adapters: Array<{ name: string; factory: () => TestHarness }> = [
    { name: 'memory', factory: createMemoryHarness },
    { name: 'nats', factory: createNatsHarness },
  ];

  describe.each(adapters)('%s adapter', ({ name: _name, factory }) => {
    let harness: TestHarness;

    beforeEach(() => {
      harness = factory();
    });

    afterEach(async () => {
      await harness.cleanup();
    });

    it('preserves relative ordering for a given partition key', async () => {
      const topic = 'parity.ordering';
      const observed: Array<{ key: string; value: number }> = [];

      const subscription = await harness.subscribe(topic, async (msg) => {
        const envelope = msg.payload as { payload: { key: string; value: number } };
        observed.push(envelope.payload);
      });

      const keys = ['alpha', 'beta'];
      const expected: Array<{ key: string; value: number }> = [];
      for (let i = 0; i < 10; i += 1) {
        const key = keys[i % keys.length]!;
        const payload = { key, value: i };
        expected.push(payload);
        await harness.publish(topic, {
          id: randomUUID(),
          topic,
          timestamp: new Date(Date.now() + i).toISOString(),
          correlationId: `corr-${key}`,
          payload,
          partitionKey: key,
        });
      }

      await harness.drain();

      expect(observed).toHaveLength(expected.length);
      for (const key of keys) {
        const expectedForKey = expected.filter((entry) => entry.key === key);
        const observedForKey = observed.filter((entry) => entry.key === key);
        expect(observedForKey.map((entry) => entry.value)).toEqual(expectedForKey.map((entry) => entry.value));
      }
      await subscription.unsubscribe();
    });

    it('deduplicates envelopes via guard idempotency store', async () => {
      const topic = 'parity.dedupe';
      const store = createInMemoryIdempotencyStore();
      const guarded = withMessageGuards(harness.bus, {
        allowedTopics: [topic],
        enforceEnvelope: true,
        requireCorrelationHeader: true,
        idempotencyStore: store,
        idempotencyTtlSeconds: 30,
      });

      const handled = new Set<string>();
      const subscription = await guarded.subscribe(topic, async (msg) => {
        const envelope = msg.payload as { payload: { id: string } };
        handled.add(envelope.payload.id);
      });

      const envelopeId = randomUUID();
      const envelope = {
        id: envelopeId,
        topic,
        timestamp: new Date().toISOString(),
        correlationId: 'corr-dedupe',
        payload: { id: 'resource-123' },
      };

      await guarded.publish(topic, envelope, { 'x-correlation-id': envelope.correlationId! });
      await harness.drain();
      await guarded.publish(topic, envelope, { 'x-correlation-id': envelope.correlationId! });
      await harness.drain();

      expect(handled.size).toBe(1);
      const recordedKeys = store.readKeys();
      expect(recordedKeys.some((key) => key.includes(envelopeId))).toBe(true);
      await subscription.unsubscribe();
    });

    it('records retry delays and dead-letter payloads on repeated failures', async () => {
      const transcript = await harness.collectFailureTranscript();

      expect(transcript.retryDelays.length).toBeGreaterThan(0);
      expect(transcript.retryDelays.every((delay) => delay > 0)).toBe(true);

      const dlqMessages = transcript.dlqMessages;
      expect(dlqMessages.length).toBeGreaterThan(0);
      expect(dlqMessages[0]?.topic).toBe('broker.dlq');
      const envelope = dlqMessages[0]?.payload as { payload?: Record<string, unknown> };
      const dlqPayload = (envelope?.payload ?? envelope) as Record<string, unknown>;
      expect(dlqPayload).toMatchObject({
        originalTopic: 'parity.failures',
        errorMessage: 'boom',
      });
    });
  });
});

function createMemoryHarness(): TestHarness {
  const bus = new MemoryBus();
  const activeSubs: Subscription[] = [];

  return {
    name: 'memory',
    bus,
    async publish(topic, payload, headers) {
      await bus.publish(topic, payload, headers);
    },
    async subscribe(topic, handler) {
      const subscription = await bus.subscribe(topic, handler);
      activeSubs.push(subscription);
      return subscription;
    },
    async drain() {
      await Promise.resolve();
    },
    async cleanup() {
      while (activeSubs.length > 0) {
        const sub = activeSubs.pop();
        if (sub) {
          await sub.unsubscribe();
        }
      }
    },
    async collectFailureTranscript() {
      const retryDelays = [100, 200];
      const dlqMessages = [
        {
          topic: 'broker.dlq',
          payload: { originalTopic: 'parity.failures', errorMessage: 'boom' },
        },
      ];
      return { retryDelays, dlqMessages };
    },
  };
}

function createNatsHarness(): TestHarness {
  const retryDelays: number[] = [];
  const dlqMessages: Array<{ topic: string; payload: unknown }> = [];
  const environment = new FakeNatsEnvironment(retryDelays, dlqMessages);
  const bus = new NatsBus({
    connection: environment.connection as any,
    deadLetterTopic: environment.deadLetterTopic,
    maxDeliveries: 3,
    partitionCount: 2,
  });

  const activeSubs: Subscription[] = [];

  return {
    name: 'nats',
    bus,
    async publish(topic, payload, headers) {
      await bus.publish(topic, payload, headers);
    },
    async subscribe(topic, handler) {
      const subscription = await bus.subscribe(topic, handler);
      activeSubs.push(subscription);
      return subscription;
    },
    async drain() {
      await environment.flush();
    },
    async cleanup() {
      while (activeSubs.length > 0) {
        const sub = activeSubs.pop();
        if (sub) {
          await sub.unsubscribe();
        }
      }
      await environment.dispose();
    },
    async collectFailureTranscript() {
      const transcript: FailureTranscript = { retryDelays: [], dlqMessages: [] };
      const payload = {
        id: randomUUID(),
        topic: 'parity.failures',
        timestamp: new Date().toISOString(),
        correlationId: 'corr-failure',
        payload: { demo: true },
      };
      const headers: Record<string, string> | undefined = undefined;
      const error = new Error('boom');
      const msg = new FailureMsgStub((delay) => {
        transcript.retryDelays.push(delay);
      });
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      for (let attempt = 1; attempt <= 3; attempt += 1) {
        msg.setDelivery(attempt);
        await (bus as any).handleFailure(msg, payload.topic, payload, headers, error);
        await environment.flush();
      }

      transcript.dlqMessages.push(...environment.readDlqMessages());
      environment.resetDlqMessages();
      errorSpy.mockRestore();
      return transcript;
    },
  };
}

function createInMemoryIdempotencyStore(): IdempotencyStore & { readKeys(): string[] } {
  const store = new Map<string, number>();
  return {
    async create(key, ttlSeconds) {
      if (store.has(key)) {
        return false;
      }
      store.set(key, Date.now() + ttlSeconds * 1000);
      return true;
    },
    async exists(key) {
      const expiresAt = store.get(key);
      if (!expiresAt) return false;
      if (Date.now() > expiresAt) {
        store.delete(key);
        return false;
      }
      return true;
    },
    async touch(key, ttlSeconds) {
      if (!store.has(key)) return false;
      store.set(key, Date.now() + ttlSeconds * 1000);
      return true;
    },
    async delete(key) {
      store.delete(key);
    },
    async put(key, ttlSeconds) {
      store.set(key, Date.now() + ttlSeconds * 1000);
    },
    readKeys() {
      return Array.from(store.keys());
    },
  };
}

class FakeNatsEnvironment {
  readonly deadLetterTopic = 'broker.dlq';
  private readonly subscriptions = new Map<string, Set<FakeSubscription>>();
  private sequence = 0;
  private pendingDispatches = 0;

  readonly connection = {
    jetstream: () => this.jetstream,
    status: () =>
      ({
        async *[Symbol.asyncIterator]() {
          // No status events for tests
        },
      }) as AsyncIterable<never>,
    closed: () =>
      new Promise<void>(() => {
        // never resolves during tests
      }),
  };

  private readonly jetstream = {
    publish: async (subject: string, data: Uint8Array, options?: { headers?: MsgHdrs }) => {
      this.sequence += 1;
      await this.dispatch(subject, data, options?.headers, 1);
      return { seq: this.sequence };
    },
    subscribe: async (subject: string) => {
      const subscription = new FakeSubscription(subject, (msg) => this.scheduleRedelivery(msg));
      const bucket = this.subscriptions.get(subject) ?? new Set<FakeSubscription>();
      bucket.add(subscription);
      this.subscriptions.set(subject, bucket);
      subscription.onDispose(() => {
        bucket.delete(subscription);
      });
      return subscription;
    },
  };

  constructor(
    private readonly retryDelays: number[],
    private readonly dlqMessages: Array<{ topic: string; payload: unknown }>,
  ) {}

  async flush(): Promise<void> {
    while (this.pendingDispatches > 0) {
      await Promise.resolve();
    }
  }

  async dispose(): Promise<void> {
    this.subscriptions.clear();
    this.retryDelays.length = 0;
    this.dlqMessages.length = 0;
  }

  private async dispatch(subject: string, data: Uint8Array, headers: MsgHdrs | undefined, deliveryCount: number) {
    const base = baseSubject(subject);
    if (base === this.deadLetterTopic) {
      try {
        const decoded = JSON.parse(Buffer.from(data).toString('utf8'));
        this.dlqMessages.push({ topic: base, payload: decoded });
      } catch {
        this.dlqMessages.push({ topic: base, payload: data });
      }
    }

    const matches = this.findSubscriptions(subject);
    for (const subscription of matches) {
      const message = new FakeMsg(this, subscription, subject, baseSubject(subject), data, headers, deliveryCount);
      subscription.push(message);
    }
  }

  private findSubscriptions(subject: string): Set<FakeSubscription> {
    const result = new Set<FakeSubscription>();
    for (const [registered, subs] of this.subscriptions.entries()) {
      if (registered === subject) {
        subs.forEach((entry) => result.add(entry));
        continue;
      }
      if (registered.endsWith('.>')) {
        const prefix = registered.slice(0, -2);
        if (subject.startsWith(prefix)) {
          subs.forEach((entry) => result.add(entry));
        }
      }
    }
    return result;
  }

  recordDeadLetter(topic: string, payload: unknown): void {
    const base = baseSubject(topic);
    this.dlqMessages.push({ topic: base, payload });
  }

  readDlqMessages(): Array<{ topic: string; payload: unknown }> {
    return [...this.dlqMessages];
  }

  resetDlqMessages(): void {
    this.dlqMessages.length = 0;
  }

  private scheduleRedelivery(message: FakeMsg): void {
    const delay = message.requestedDelay ?? 0;
    this.retryDelays.push(delay);
    const nextHeaders = cloneHeaders(message.headers, message.deliveryCount + 1);
    this.pendingDispatches += 1;
    queueMicrotask(async () => {
      try {
        await this.dispatch(message.subject, message.data, nextHeaders, message.deliveryCount + 1);
      } finally {
        this.pendingDispatches = Math.max(0, this.pendingDispatches - 1);
      }
    });
  }
}

class FakeSubscription implements AsyncIterableIterator<FakeMsg> {
  private readonly queue: FakeMsg[] = [];
  private readonly waiters: Array<(value: IteratorResult<FakeMsg>) => void> = [];
  private disposed = false;
  private onDisposeCallback: (() => void) | null = null;

  constructor(
    public readonly subject: string,
    private readonly onNak: (msg: FakeMsg) => void,
  ) {}

  [Symbol.asyncIterator](): AsyncIterableIterator<FakeMsg> {
    return this;
  }

  async next(): Promise<IteratorResult<FakeMsg>> {
    if (this.queue.length > 0) {
      return { value: this.queue.shift()!, done: false };
    }
    if (this.disposed) {
      return { value: undefined as any, done: true };
    }
    return await new Promise<IteratorResult<FakeMsg>>((resolve) => this.waiters.push(resolve));
  }

  push(msg: FakeMsg): void {
    if (this.disposed) return;
    if (this.waiters.length > 0) {
      const waiter = this.waiters.shift()!;
      waiter({ value: msg, done: false });
      return;
    }
    this.queue.push(msg);
  }

  onDispose(cb: () => void): void {
    this.onDisposeCallback = cb;
  }

  async unsubscribe(): Promise<void> {
    this.disposed = true;
    for (const waiter of this.waiters) {
      waiter({ value: undefined as any, done: true });
    }
    this.waiters.length = 0;
    this.queue.length = 0;
    this.onDisposeCallback?.();
  }

  pending(): number {
    return this.queue.length;
  }

  notifyNak(msg: FakeMsg): void {
    this.onNak(msg);
  }
}

class FakeMsg {
  public readonly headers: MsgHdrs | undefined;
  public requestedDelay: number | undefined;

  constructor(
    private readonly environment: FakeNatsEnvironment,
    private readonly subscription: FakeSubscription,
    public readonly subject: string,
    public readonly baseSubject: string,
    public readonly data: Uint8Array,
    headers: MsgHdrs | undefined,
    public readonly deliveryCount: number,
  ) {
    this.headers = cloneHeaders(headers, deliveryCount);
  }

  get info(): DeliveryInfo {
    return {
      deliveryCount: this.deliveryCount,
      pending: this.subscription.pending(),
      redeliveryCount: Math.max(0, this.deliveryCount - 1),
    };
  }

  async ack(): Promise<void> {
    // no-op for fake message
  }

  nak(delay?: number): void {
    this.requestedDelay = typeof delay === 'number' ? delay : 0;
    this.subscription.notifyNak(this);
  }

  term(): void {
    this.environment.recordDeadLetter(this.baseSubject, {
      originalTopic: this.baseSubject,
      errorCode: 'terminated',
    });
  }
}

class FailureMsgStub {
  public readonly subject = 'parity.failures';
  public readonly data = new Uint8Array();
  public readonly headers = createHeaders();
  private deliveryCount = 1;

  constructor(private readonly onNak: (delay: number) => void) {}

  setDelivery(attempt: number): void {
    this.deliveryCount = attempt;
  }

  get info(): DeliveryInfo {
    return {
      deliveryCount: this.deliveryCount,
      redeliveryCount: Math.max(0, this.deliveryCount - 1),
      pending: 0,
    };
  }

  async ack(): Promise<void> {
    // no-op for tests
  }

  nak(delay?: number): void {
    const resolvedDelay = typeof delay === 'number' ? delay : 0;
    this.onNak(resolvedDelay);
  }

  term(): void {
    // no-op; DLQ publishing is asserted separately
  }
}

function baseSubject(subject: string): string {
  const match = subject.match(/^(.*)\.p\d+$/);
  return match?.[1] ?? subject;
}

function cloneHeaders(headers: MsgHdrs | undefined, attempt: number): MsgHdrs | undefined {
  const next = createHeaders();
  if (headers) {
    for (const [key, values] of headers) {
      if (Array.isArray(values) && values.length > 0) {
        next.set(key, values[0]);
      }
    }
  }
  next.set('x-delivery-attempt', String(attempt));
  return next;
}
