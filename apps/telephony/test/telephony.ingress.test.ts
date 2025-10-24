import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';

import { getCounterRecords, resetMetrics } from '@onecare/observability';
import type { MessageBus } from '@onecare/bus';

import { createTelephonyServer, type TelephonyIngressOptions } from '../src/index';

interface TestResponse<T = unknown> {
  status: number;
  body: T;
  headers: Record<string, string>;
}

function createTestBus(): MessageBus {
  return {
    publish: vi.fn(async () => undefined),
    subscribe: vi.fn(async () => ({ unsubscribe: async () => undefined })),
  };
}

function listen(server: ReturnType<typeof createTelephonyServer>): Promise<number> {
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo | null;
      if (!address) {
        reject(new Error('server_address_unavailable'));
        return;
      }
      resolve(address.port);
    });
  });
}

async function postJson<T>(port: number, path: string, payload: unknown): Promise<TestResponse<T>> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = (await response.json()) as T;
  const headers = Object.fromEntries(response.headers.entries());
  return { status: response.status, body, headers };
}

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('telephony ingress server', () => {
  let server: ReturnType<typeof createTelephonyServer> | null = null;

  beforeEach(() => {
    resetMetrics();
    vi.useRealTimers();
  });

  afterEach(async () => {
    if (server) {
      await server.initiateShutdown?.();
      server = null;
    }
  });

  it('records http request metrics with status labels', async () => {
    const bus = createTestBus();
    const transcribe = vi.fn(async () => ({ text: 'transcribed' }));
    const classify = vi.fn(async () => ({ intent: 'telephony.callback' }));

    server = createTelephonyServer({ bus, asrClient: { transcribe }, intentClassifier: { classify } });
    const port = await listen(server);

    const payload = {
      callId: 'metrics-001',
      audioRef: 'memory://metrics-001',
      metadata: { callerId: '+15550000001', practiceId: 'demo-practice' },
    };

    const accepted = await postJson(port, '/calls', payload);
    expect(accepted.status).toBe(202);

    const notFoundResponse = await fetch(`http://127.0.0.1:${port}/missing`, { method: 'GET' });
    expect(notFoundResponse.status).toBe(404);
    await notFoundResponse.json();

    const records = getCounterRecords('telephony.http.requests');
    const outcomes = records.map((record) => record.attributes);
    expect(outcomes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: '202', path: '/calls', method: 'POST', outcome: 'accepted' }),
        expect.objectContaining({ status: '404', path: '/missing', method: 'GET', outcome: 'not_found' }),
      ]),
    );

    const metricsResponse = await fetch(`http://127.0.0.1:${port}/metrics`);
    expect(metricsResponse.status).toBe(200);
    const metricsText = await metricsResponse.text();
    expect(metricsText).toMatch(/telephony_http_duration_ms_count\{method="POST",path="\/calls"\} \d+/);
    expect(metricsText).toContain('telephony_http_requests_total{method="POST",path="/calls",status="202",outcome="accepted"} 1');
  });

  it('returns 503 over_capacity when concurrency limit is reached', async () => {
    const bus = createTestBus();
    const deferred = createDeferred<void>();
    const transcribe = vi.fn(async () => {
      await deferred.promise;
      return { text: 'caller transcript' };
    });
    const classify = vi.fn(async () => ({ intent: 'telephony.callback', confidence: 0.9 }));

    const options: TelephonyIngressOptions = {
      bus,
      maxConcurrency: 1,
      asrClient: { transcribe },
      intentClassifier: { classify },
    };

    server = createTelephonyServer(options);
    const port = await listen(server);

    const requestPayload = {
      callId: 'call-001',
      audioRef: 'memory://call-001',
      metadata: { callerId: '+15550000001', practiceId: 'demo-practice' },
    };

    const firstRequest = postJson(port, '/calls', requestPayload);
    // Allow the first request to reach the ASR stage
    await new Promise((resolve) => setTimeout(resolve, 20));

    const second = await postJson<{ error: { code: string } }>(port, '/calls', requestPayload);
    expect(second.status).toBe(503);
    expect(second.body.error.code).toBe('over_capacity');
    expect(second.headers['x-correlation-id']).toBeDefined();

    deferred.resolve();
    const first = await firstRequest;
    expect(first.status).toBe(202);
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(classify).toHaveBeenCalledTimes(1);
  });

  it('enforces caller rate limits and emits retry-after header', async () => {
    const bus = createTestBus();
    const transcribe = vi.fn(async () => ({ text: 'rate limited call' }));
    const classify = vi.fn(async () => ({ intent: 'telephony.callback' }));

    const options: TelephonyIngressOptions = {
      bus,
      rateLimit: {
        caller: {
          capacity: 1,
          refillPerSecond: 0,
          ttlSeconds: 600,
          maxEntries: 100,
        },
      },
      asrClient: { transcribe },
      intentClassifier: { classify },
    };

    server = createTelephonyServer(options);
    const port = await listen(server);

    const payload = {
      callId: 'call-rl-1',
      audioRef: 'memory://call-rl-1',
      metadata: { callerId: '+15550000077', practiceId: 'demo-practice' },
    };

    const first = await postJson(port, '/calls', payload);
    expect(first.status).toBe(202);

    const second = await postJson<{ error: { code: string } }>(port, '/calls', payload);
    expect(second.status).toBe(429);
    expect(second.body.error.code).toBe('rate_limited');
    expect(Number.parseInt(second.headers['retry-after'] ?? '0', 10)).toBeGreaterThanOrEqual(1);
    expect(second.headers['x-correlation-id']).toBeDefined();
  });
});
