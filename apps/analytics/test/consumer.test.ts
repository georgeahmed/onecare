import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MemoryBus } from '@onecare/bus';
import type { Message } from '@onecare/bus';
import { Topics, createEnvelope } from '@onecare/events';
import type { Metric } from '@onecare/events';
import type { IdempotencyStore } from '@onecare/ports';
import { getHistogramRecords, resetMetrics } from '@onecare/observability';
import {
  AnalyticsConsumer,
} from '../src/consumer';

describe('AnalyticsConsumer', () => {
  let bus: MemoryBus;
  let write: ReturnType<typeof vi.fn>;
  let dlqEvents: Message<Record<string, unknown>>[];

  beforeEach(() => {
    bus = new MemoryBus();
    write = vi.fn().mockResolvedValue(undefined);
    dlqEvents = [];
    void bus.subscribe(Topics.broker.deadLetter, (msg) => {
      dlqEvents.push(msg as Message<Record<string, unknown>>);
    });
    resetMetrics();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function createIdempotencyStore(): IdempotencyStore {
    const keys = new Map<string, boolean>();
    return {
      exists: async (key: string) => keys.has(key),
      put: async (key: string) => {
        keys.set(key, true);
      },
      reserve: async (key: string) => {
        if (keys.has(key)) return 'exists';
        keys.set(key, true);
        return 'reserved';
      },
      delete: async (key: string) => {
        keys.delete(key);
      },
    };
  }

  function extractDlqPayload(message: Message<Record<string, unknown>> | undefined): Record<string, unknown> {
    if (!message) return {};
    const envelope = message.payload as Record<string, unknown>;
    if (!envelope || typeof envelope !== 'object') return {};
    const inner = envelope.payload;
    if (inner && typeof inner === 'object') {
      return inner as Record<string, unknown>;
    }
    return {};
  }

  it('writes valid metrics to the sink', async () => {
    const consumer = new AnalyticsConsumer({ bus, sink: { write } });
    await consumer.start();

    const metric: Metric = {
      name: 'requests_total',
      value: 42,
      labels: { service: 'booking' },
      timestamp: new Date().toISOString(),
    };
    const envelope = createEnvelope(Topics.analytics.metric, metric, 'cid-123');

    await bus.publish(Topics.analytics.metric, envelope, { 'x-correlation-id': envelope.correlationId ?? '' });

    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0][0]).toEqual(metric);

    await consumer.stop();
  });

  it('publishes invalid metrics to the DLQ without attempting sink writes', async () => {
    const consumer = new AnalyticsConsumer({ bus, sink: { write } });
    await consumer.start();

    const invalidMetric = { value: 1 } as unknown as Metric;
    const envelope = createEnvelope(Topics.analytics.metric, invalidMetric, 'cid-456');

    await bus.publish(Topics.analytics.metric, envelope, { 'x-correlation-id': envelope.correlationId ?? '' });
    expect(write).not.toHaveBeenCalled();
    expect(dlqEvents).toHaveLength(1);
    const dlqPayload = extractDlqPayload(dlqEvents[0]);
    expect(dlqPayload).toMatchObject({
      originalTopic: Topics.analytics.metric,
      correlationId: envelope.correlationId,
      errorCode: 'analytics.metric.validation_failed',
      attempts: 1,
    });
    expect(dlqPayload.payloadRef).toMatchObject({
      cause: 'analytics.metric.validation_failed',
      metricName: 'unknown',
    });

    await consumer.stop();
  });

  it('retries transient sink failures before succeeding', async () => {
    const error = new Error('disk full');
    write.mockRejectedValueOnce(error);
    write.mockResolvedValueOnce(undefined);
    const consumer = new AnalyticsConsumer({
      bus,
      sink: { write },
      retryPolicy: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 },
    });
    await consumer.start();

    const metric: Metric = {
      name: 'requests_total',
      value: 1,
    };
    const envelope = createEnvelope(Topics.analytics.metric, metric, 'cid-789');

    await bus.publish(Topics.analytics.metric, envelope, { 'x-correlation-id': envelope.correlationId ?? '' });
    expect(write).toHaveBeenCalledTimes(2);
    expect(dlqEvents).toHaveLength(0);

    await consumer.stop();
  });

  it('publishes to DLQ when the sink fails after all retries', async () => {
    write.mockRejectedValue(new Error('disk full'));
    const consumer = new AnalyticsConsumer({
      bus,
      sink: { write },
      retryPolicy: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 },
    });
    await consumer.start();

    const metric: Metric = { name: 'requests_total', value: 7 };
    const envelope = createEnvelope(Topics.analytics.metric, metric, 'cid-dlq');

    await bus.publish(Topics.analytics.metric, envelope, { 'x-correlation-id': envelope.correlationId ?? '' });

    expect(write).toHaveBeenCalledTimes(2);
    expect(dlqEvents).toHaveLength(1);
    const dlqPayload = extractDlqPayload(dlqEvents[0]);
    expect(dlqPayload).toMatchObject({
      originalTopic: Topics.analytics.metric,
      correlationId: envelope.correlationId,
      errorCode: 'sink_error',
      attempts: 2,
    });
    expect(dlqPayload.payloadRef).toMatchObject({
      cause: 'analytics.metric.persistence_failed',
      metricName: metric.name,
      details: { attempt: 2 },
    });
    await consumer.stop();
  });

  it('suppresses duplicate metric writes when envelopes replayed', async () => {
    const store = createIdempotencyStore();
    const consumer = new AnalyticsConsumer({ bus, sink: { write }, idempotencyStore: store, idempotencyTtlSeconds: 60 });
    await consumer.start();

    const metric: Metric = {
      name: 'requests_total',
      value: 5,
      timestamp: new Date().toISOString(),
    };
    const envelope = createEnvelope(Topics.analytics.metric, metric, 'cid-idem');

    await bus.publish(Topics.analytics.metric, envelope, { 'x-correlation-id': envelope.correlationId ?? '' });
    await bus.publish(Topics.analytics.metric, envelope, { 'x-correlation-id': envelope.correlationId ?? '' });

    expect(write).toHaveBeenCalledTimes(1);
    await consumer.stop();
  });

  it('sanitizes labels before writing to the sink', async () => {
    const consumer = new AnalyticsConsumer({ bus, sink: { write } });
    await consumer.start();

    const metric: Metric = {
      name: 'requests_total',
      value: '12',
      labels: {
        service: ' booking ',
        status: 'OK',
        patientId: '12345',
        token: 'sk-1234567890123456789012',
      },
    };
    const envelope = createEnvelope(Topics.analytics.metric, metric, 'cid-sanitize');

    await bus.publish(Topics.analytics.metric, envelope, { 'x-correlation-id': envelope.correlationId ?? '' });

    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0][0]).toEqual({
      name: 'requests_total',
      value: '12',
      labels: {
        service: 'booking',
        status: 'OK',
      },
    });

    await consumer.stop();
  });

  it('normalizes retry policy values to sensible defaults', () => {
    const consumer = new AnalyticsConsumer({
      bus,
      sink: { write },
      retryPolicy: {
        maxAttempts: 0,
        baseDelayMs: Number.NaN,
        maxDelayMs: 50,
      },
    });

    const policy = (consumer as unknown as {
      retryPolicy: { maxAttempts: number; baseDelayMs: number; maxDelayMs: number; jitterRatio: number };
    }).retryPolicy;

    expect(policy.maxAttempts).toBe(3);
    expect(policy.baseDelayMs).toBe(100);
    expect(policy.maxDelayMs).toBe(100);
    expect(policy.jitterRatio).toBeCloseTo(0.2, 5);
  });

  it('clamps ingest lag to zero when metrics arrive from the future', async () => {
    const fixedNow = Date.parse('2025-01-10T00:00:00.000Z');
    vi.spyOn(Date, 'now').mockReturnValue(fixedNow);

    const consumer = new AnalyticsConsumer({ bus, sink: { write } });
    await consumer.start();

    const metric: Metric = {
      name: 'requests_total',
      value: 1,
      timestamp: new Date(fixedNow + 60_000).toISOString(),
    };
    const envelope = createEnvelope(Topics.analytics.metric, metric, 'cid-future');

    await bus.publish(Topics.analytics.metric, envelope, { 'x-correlation-id': envelope.correlationId ?? '' });

    const records = getHistogramRecords('analytics_ingest_lag_ms');
    expect(records).toHaveLength(1);
    expect(records[0]?.value).toBe(0);

    await consumer.stop();
  });

  it('does not over-redact labels that contain punctuation', async () => {
    const consumer = new AnalyticsConsumer({ bus, sink: { write } });
    await consumer.start();

    const metric: Metric = {
      name: 'job_status',
      value: 1,
      labels: { status: 'job:12345678901234567890' },
    };
    const envelope = createEnvelope(Topics.analytics.metric, metric, 'cid-punct');

    await bus.publish(Topics.analytics.metric, envelope, { 'x-correlation-id': envelope.correlationId ?? '' });

    expect(write).toHaveBeenCalledTimes(1);
    const written = write.mock.calls[0][0] as Metric;
    expect(written.labels?.status).toBe('job:12345678901234567890');

    await consumer.stop();
  });

  it('redacts access tokens that match the expected pattern', async () => {
    const consumer = new AnalyticsConsumer({ bus, sink: { write } });
    await consumer.start();

    const metric: Metric = {
      name: 'token_usage',
      value: 1,
      labels: { result: 'abcdEFGHijklMNOPqrstUVWX' },
    };
    const envelope = createEnvelope(Topics.analytics.metric, metric, 'cid-token');

    await bus.publish(Topics.analytics.metric, envelope, { 'x-correlation-id': envelope.correlationId ?? '' });

    expect(write).toHaveBeenCalledTimes(1);
    const written = write.mock.calls[0][0] as Metric;
    expect(written.labels?.result).toBe('[redacted-token]');

    await consumer.stop();
  });
});
