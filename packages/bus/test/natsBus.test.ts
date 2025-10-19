import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { gzipSync } from 'node:zlib';
import { resetMetrics, getHistogramRecords, getCounterRecords } from '@onecare/observability';
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
import { NatsBus, getBus } from '../src/natsBus';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
    close: vi.fn().mockResolvedValue(undefined),
  };
  return { connection: connection as unknown as Parameters<typeof NatsBus>[0], jsClient, publishMock };
}

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const SECURITY_ENV_KEYS = [
  'NATS_TLS_ENABLED',
  'NATS_TLS_REQUIRED',
  'NATS_TLS_CA_PATH',
  'NATS_TLS_CERT_PATH',
  'NATS_TLS_KEY_PATH',
  'NATS_TLS_INSECURE',
  'NATS_TLS_REJECT_UNAUTHORIZED',
  'NATS_CREDS_PATH',
  'BUS_READY_PENDING_LAG',
  'BUS_IMPL',
];

function resetSecurityEnv(): void {
  for (const key of SECURITY_ENV_KEYS) {
    delete process.env[key];
  }
  process.env.NODE_ENV = ORIGINAL_NODE_ENV;
}

describe('NatsBus publish dedupe', () => {
  beforeEach(() => {
    vi.useRealTimers();
    resetMetrics();
  });

  afterEach(() => {
    resetSecurityEnv();
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
    expect(publishMock.mock.calls[0][0]).toBe('demo.topic');
    const [, , options] = publishMock.mock.calls[0];
    expect(options?.msgID).toBe('env-123');
    const publishRecords = getHistogramRecords('bus.nats.publish.latency_ms');
    expect(publishRecords.length).toBe(1);
    expect(publishRecords[0].attributes?.topic).toBe('demo.topic');
    expect(publishRecords[0].attributes?.result).toBe('success');
  });

  it('falls back to idempotency header when envelope id is not present', async () => {
    const publishMock = vi.fn().mockResolvedValue({ seq: 1 });
    const { connection } = createConnectionStub(publishMock);
    const bus = new NatsBus({ connection: connection as any });
    const payload = { topic: 'demo.topic', timestamp: new Date().toISOString(), payload: { ok: true } };

    await bus.publish('demo.topic', payload, { 'x-idempotency-key': 'idem-456' });

    expect(publishMock.mock.calls[0][0]).toBe('demo.topic');
    const [, , options] = publishMock.mock.calls[0];
    expect(options?.msgID).toBe('idem-456');
  });

  it('routes to partitioned subject when partitions configured', async () => {
    const publishMock = vi.fn().mockResolvedValue({ seq: 1 });
    const { connection } = createConnectionStub(publishMock);
    const bus = new NatsBus({ connection: connection as any, partitionCount: 4 });
    const envelope = {
      id: 'env-777',
      topic: 'demo.topic',
      timestamp: new Date().toISOString(),
      payload: { ok: true },
      partitionKey: 'tenant-42',
    };

    await bus.publish('demo.topic', envelope);

    expect(publishMock).toHaveBeenCalledTimes(1);
    expect(publishMock.mock.calls[0][0]).toMatch(/^demo\.topic(?:\.p[0-3])$/);
  });

  it('rejects payloads larger than configured max size', async () => {
    const publishMock = vi.fn().mockResolvedValue({ seq: 1 });
    const { connection } = createConnectionStub(publishMock);
    const bus = new NatsBus({ connection: connection as any, maxMessageBytes: 16 });
    const envelope = {
      id: 'env-big',
      topic: 'demo.topic',
      timestamp: new Date().toISOString(),
      payload: 'a'.repeat(128),
    };

    await expect(bus.publish('demo.topic', envelope)).rejects.toThrow(/message_size_limit_exceeded/);
    expect(publishMock).not.toHaveBeenCalled();
  });
});

describe('getBus', () => {
  afterEach(() => {
    resetSecurityEnv();
  });

  it('returns NatsBus when connection provided without url', () => {
    const { connection } = createConnectionStub();
    const bus = getBus({ connection: connection as any });
    expect(bus).toBeInstanceOf(NatsBus);
  });

  it('prefers provided connection even when BUS_IMPL forces memory', () => {
    process.env.BUS_IMPL = 'memory';
    const { connection } = createConnectionStub();
    const bus = getBus({ connection: connection as any });
    expect(bus).toBeInstanceOf(NatsBus);
  });
});

describe('NatsBus security', () => {
  afterEach(() => {
    resetSecurityEnv();
  });

  it('throws when TLS is required but not enabled', () => {
    process.env.NODE_ENV = 'production';
    process.env.NATS_TLS_REQUIRED = 'true';
    const bus = new NatsBus({ url: 'nats://localhost:4222' });
    expect(() => (bus as any).buildConnectionOptions()).toThrow(/TLS is required/);
  });

  it('loads TLS options when certificate paths are provided', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'natsbus-tls-'));
    const caPath = join(tmpDir, 'ca.pem');
    const certPath = join(tmpDir, 'client.pem');
    const keyPath = join(tmpDir, 'client.key');
    writeFileSync(caPath, '-----BEGIN CERTIFICATE-----\nFAKE\n-----END CERTIFICATE-----');
    writeFileSync(certPath, '-----BEGIN CERTIFICATE-----\nFAKE\n-----END CERTIFICATE-----');
    writeFileSync(keyPath, 'fake-private-key-content');
    process.env.NATS_TLS_ENABLED = 'true';
    process.env.NATS_TLS_CA_PATH = caPath;
    process.env.NATS_TLS_CERT_PATH = certPath;
    process.env.NATS_TLS_KEY_PATH = keyPath;
    const bus = new NatsBus({ url: 'nats://localhost:4222' });
    const options = (bus as any).buildConnectionOptions();
    expect(options.tls).toBeDefined();
    expect(typeof options.tls.ca?.[0]).toBe('string');
    expect(typeof options.tls.cert).toBe('string');
    expect(typeof options.tls.key).toBe('string');
    rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe('NatsBus health snapshots', () => {
  it('reports readiness false when no subscriptions yet', () => {
    const { connection } = createConnectionStub();
    const bus = new NatsBus({ connection: connection as any });
    const health = bus.getHealthSnapshot();
    expect(health.isConnected).toBe(true);
    expect(health.subscribed).toBe(0);
    expect(health.isReady).toBe(false);
  });
});

describe('NatsBus failure handling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(global.Math, 'random').mockReturnValue(0); // deterministic jitter
    resetMetrics();
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
    const retryRecords = getCounterRecords('bus.nats.retries.scheduled');
    expect(retryRecords.length).toBe(1);
    expect(retryRecords[0].attributes?.attempt).toBe(1);
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

    expect(publishSpy).toHaveBeenCalledTimes(1);
    const [subject, envelopeArg, headersArg] = publishSpy.mock.calls[0];
    expect(subject).toBe('broker.dlq');
    expect(envelopeArg.payload).toMatchObject({
      originalTopic: 'demo.topic',
      payloadRef: expect.objectContaining({ partitionKey: 'c2', retryable: true }),
    });
    expect(headersArg).toMatchObject({
      'x-correlation-id': 'c2',
      'x-original-topic': 'demo.topic',
      'x-partition-key': 'c2',
      'x-retryable': 'true',
    });
    expect(ack).toHaveBeenCalledTimes(1);
    expect(nak).not.toHaveBeenCalled();
    expect(bus.getDlqPublished()).toBe(1);
    const dlqRecords = getCounterRecords('bus.nats.dlq.published');
    expect(dlqRecords.length).toBe(1);
    expect(dlqRecords[0].attributes?.topic).toBe('demo.topic');
  });

  it('routes non-retryable failures directly to DLQ', async () => {
    const { connection } = createConnectionStub();
    const bus = new NatsBus({ connection: connection as any, maxDeliveries: 5 });
    const publishSpy = vi.spyOn(bus as any, 'publish').mockResolvedValue(undefined);
    const { msg, nak, ack } = buildMessageStub(1);
    const error = Object.assign(new Error('invalid input'), { retryable: false, code: 'invalid_input' });

    await (bus as any).handleFailure(msg, 'demo.topic', { id: 'env-1', correlationId: 'c-non-retry' }, undefined, error);

    expect(nak).not.toHaveBeenCalled();
    expect(ack).toHaveBeenCalledTimes(1);
    expect(publishSpy).toHaveBeenCalledTimes(1);
    const [, envelopeArg, headersArg] = publishSpy.mock.calls[0];
    expect(envelopeArg.payload).toMatchObject({
      payloadRef: expect.objectContaining({ retryable: false, category: 'validation' }),
    });
    expect(headersArg).toMatchObject({
      'x-retryable': 'false',
      'x-failure-category': 'validation',
    });
  });
});

describe('NatsBus tenant quotas', () => {
  beforeEach(() => {
    resetMetrics();
  });

  it('enforces per-tenant rate limits and records metrics', async () => {
    const publishMock = vi.fn().mockResolvedValue({ seq: 1 });
    const bus = new NatsBus({
      tenantRateLimit: {
        defaultRatePerSecond: 1,
        defaultBurst: 1,
      },
    });
    vi.spyOn(bus as any, 'getJetStream').mockResolvedValue({
      publish: publishMock,
    });

    const envelope = (id: string) => ({
      id,
      topic: 'demo.topic',
      timestamp: new Date().toISOString(),
      payload: { ok: true },
    });

    await bus.publish('demo.topic', envelope('env-1'), { 'x-tenant-id': 'tenant-a' });
    await expect(
      bus.publish('demo.topic', envelope('env-2'), { 'x-tenant-id': 'tenant-a' }),
    ).rejects.toMatchObject({ code: 'tenant_quota_exceeded' });

    expect(publishMock).toHaveBeenCalledTimes(1);
    const blocks = getCounterRecords('bus.quota.block');
    expect(blocks.length).toBe(1);
    expect(blocks[0]?.attributes?.tenant).toBe('tenant-a');

    const throughput = getCounterRecords('bus.tenant.throughput');
    const tenantRecords = throughput.filter((record) => record.attributes?.tenant === 'tenant-a');
    expect(tenantRecords.length).toBe(1);
  });

  it('honours tenant-specific overrides', async () => {
    const publishMock = vi.fn().mockResolvedValue({ seq: 1 });
    const bus = new NatsBus({
      tenantRateLimit: {
        defaultRatePerSecond: 1,
        defaultBurst: 1,
        overrides: {
          'tenant-b': { rate: 2, burst: 2 },
        },
      },
    });
    vi.spyOn(bus as any, 'getJetStream').mockResolvedValue({
      publish: publishMock,
    });

    const envelope = (id: string) => ({
      id,
      topic: 'demo.topic',
      timestamp: new Date().toISOString(),
      payload: { ok: true },
    });

    await bus.publish('demo.topic', envelope('env-10'), { 'x-tenant-id': 'tenant-b' });
    await bus.publish('demo.topic', envelope('env-11'), { 'x-tenant-id': 'tenant-b' });
    await expect(
      bus.publish('demo.topic', envelope('env-12'), { 'x-tenant-id': 'tenant-b' }),
    ).rejects.toMatchObject({ code: 'tenant_quota_exceeded' });

    expect(publishMock).toHaveBeenCalledTimes(2);
  });
});

describe('NatsBus compression & message sizing', () => {
  beforeEach(() => {
    resetMetrics();
  });

  it('compresses envelope payloads when threshold exceeded', async () => {
    const publishMock = vi.fn().mockResolvedValue({ seq: 1 });
    const bus = new NatsBus({
      compressionThresholdBytes: 256,
      maxMessageBytes: 32 * 1024,
    });
    vi.spyOn(bus as any, 'getJetStream').mockResolvedValue({
      publish: publishMock,
    });

    const envelope = {
      id: 'env-compress',
      topic: 'demo.topic',
      timestamp: new Date().toISOString(),
      payload: { blob: 'x'.repeat(1024) },
    };

    await bus.publish('demo.topic', envelope);

    expect(publishMock).toHaveBeenCalledTimes(1);
    const [, dataBuffer] = publishMock.mock.calls[0];
    const encoded = new TextDecoder().decode(dataBuffer);
    const body = JSON.parse(encoded);
    expect(body.__compressed).toBe('gzip+json');
    const compressedMetric = getCounterRecords('bus.msg.compressed');
    expect(compressedMetric.length).toBe(1);
  });

  it('records too-large metric when payload exceeds max bytes', async () => {
    const publishMock = vi.fn().mockResolvedValue({ seq: 1 });
    const bus = new NatsBus({
      compressionThresholdBytes: 0,
      maxMessageBytes: 256,
    });
    vi.spyOn(bus as any, 'getJetStream').mockResolvedValue({
      publish: publishMock,
    });

    const envelope = {
      id: 'env-too-big',
      topic: 'demo.topic',
      timestamp: new Date().toISOString(),
      payload: { blob: 'y'.repeat(2048) },
    };

    await expect(bus.publish('demo.topic', envelope)).rejects.toThrow(/message_size_limit_exceeded/);
    const tooLargeMetric = getCounterRecords('bus.msg.too_large');
    expect(tooLargeMetric.length).toBe(1);
  });

  it('decompresses payload before invoking handler', async () => {
    const bus = new NatsBus({});
    const handler = vi.fn();
    const originalPayload = { id: 'env', topic: 'demo.topic', timestamp: new Date().toISOString(), payload: { ok: true } };
    const compressedPayload = gzipSync(Buffer.from(JSON.stringify(originalPayload.payload), 'utf8')).toString('base64');
    const messageBody = {
      ...originalPayload,
      payload: compressedPayload,
      __compressed: 'gzip+json',
    };
    const msg: any = {
      subject: 'demo.topic',
      data: new TextEncoder().encode(JSON.stringify(messageBody)),
      headers: undefined,
      ack: vi.fn(),
      nak: vi.fn(),
      info: {
        deliveryCount: 1,
        pending: 0,
      },
    };

    await (bus as any).processMessage(msg, handler, 'demo.topic');

    expect(handler).toHaveBeenCalledTimes(1);
    const invocation = handler.mock.calls[0][0];
    expect(invocation.payload.payload).toEqual({ ok: true });
  });
});

describe('NatsBus partitioning', () => {
  it('spreads keys across partitions and flags hot keys', async () => {
    resetMetrics();
    const publishMock = vi.fn().mockResolvedValue({ seq: 1 });
    const bus = new NatsBus({
      partitionCount: 4,
      partitionHotKeyRateTps: 1,
      partitionHotKeyWindowMs: 1_000,
      tenantRateLimit: { defaultRatePerSecond: 0 },
    });
    vi.spyOn(bus as any, 'getJetStream').mockResolvedValue({ publish: publishMock });

    const partitions = new Set<number>();
    for (let i = 0; i < 20; i += 1) {
      const tenantId = `tenant-${i}`;
      const envelope = {
        id: `env-${i}`,
        topic: 'demo.topic',
        timestamp: new Date().toISOString(),
        payload: { tenantId },
      };
      const resolution = (bus as any).resolvePublishSubject('demo.topic', envelope, { 'x-tenant-id': tenantId });
      partitions.add(resolution.partition);
    }
    expect(partitions.size).toBeGreaterThan(1);

    const hotEnvelope = {
      id: 'env-hot',
      topic: 'demo.topic',
      timestamp: new Date().toISOString(),
      payload: { tenantId: 'hot-tenant' },
    };
    for (let i = 0; i < 4; i += 1) {
      await bus.publish('demo.topic', hotEnvelope, { 'x-tenant-id': 'hot-tenant' });
    }
    const hotRecords = getCounterRecords('bus.partition.hot_key');
    expect(hotRecords.length).toBeGreaterThan(0);
  });
});
