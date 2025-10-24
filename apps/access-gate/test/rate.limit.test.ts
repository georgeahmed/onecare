import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { AccessGateConfig } from '@onecare/config';
import { resetMetrics, getCounterRecords } from '@onecare/observability';

import {
  createAccessGateHandler,
  createAccessGateServer,
  resetPortalSchedulerForHealth,
  setPortalSchedulerForHealth,
} from '../src/index';

function buildConfig(overrides?: Partial<AccessGateConfig>): AccessGateConfig {
  return {
    rateLimit: {
      tenant: {
        capacity: 50,
        refillPerSecond: 5,
        ttlSeconds: 600,
        maxEntries: 100,
        ...(overrides?.rateLimit?.tenant ?? {}),
      },
      account: {
        capacity: 20,
        refillPerSecond: 2,
        ttlSeconds: 600,
        maxEntries: 1000,
        ...(overrides?.rateLimit?.account ?? {}),
      },
    },
  };
}

function createMockRequest(headers: Record<string, string>): IncomingMessage {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    normalized[key.toLowerCase()] = value;
  }
  return { headers: normalized } as unknown as IncomingMessage;
}

interface MockResponseState {
  statusCode: number;
  headers: Record<string, string>;
  body: string | null;
}

function createMockResponse(): { res: ServerResponse; state: MockResponseState } {
  const state: MockResponseState = {
    statusCode: 200,
    headers: {},
    body: null,
  };
  const res = {
    headersSent: false,
    writableEnded: false,
    get statusCode() {
      return state.statusCode;
    },
    set statusCode(value: number) {
      state.statusCode = value;
    },
    setHeader(name: string, value: string) {
      state.headers[name.toLowerCase()] = value;
    },
    getHeader(name: string) {
      return state.headers[name.toLowerCase()];
    },
    end(chunk?: string) {
      state.body = chunk ?? '';
      this.headersSent = true;
      this.writableEnded = true;
    },
  } as unknown as ServerResponse;
  return { res, state };
}

describe('Access Gate rate limiter', () => {
  beforeEach(() => {
    resetMetrics();
    resetPortalSchedulerForHealth();
  });

  it('returns 429 with retry-after when tenant limit exceeded', () => {
    const now = 0;
    const config = buildConfig({
      rateLimit: {
        tenant: {
          capacity: 2,
          refillPerSecond: 1,
          ttlSeconds: 600,
          maxEntries: 10,
        },
        account: {
          capacity: 100,
          refillPerSecond: 50,
          ttlSeconds: 600,
          maxEntries: 100,
        },
      },
    });
    const handler = createAccessGateHandler(
      { config, now: () => now },
      (_req, res) => {
        res.statusCode = 204;
        res.setHeader('content-type', 'application/json');
        res.end('ok');
      },
    );

    let mock = createMockResponse();
    handler(
      createMockRequest({
        'x-practice-id': 'demo',
        'x-actor-id': 'patient-1',
        'x-correlation-id': 'corr-1',
      }),
      mock.res,
    );
    expect(mock.state.statusCode).toBe(204);
    expect(mock.state.body).toBe('ok');
    expect(mock.state.headers['x-correlation-id']).toBe('corr-1');

    mock = createMockResponse();
    handler(
      createMockRequest({
        'x-practice-id': 'demo',
        'x-actor-id': 'patient-1',
        'x-correlation-id': 'corr-2',
      }),
      mock.res,
    );
    expect(mock.state.statusCode).toBe(204);

    const blocked = createMockResponse();
    handler(
      createMockRequest({
        'x-practice-id': 'demo',
        'x-actor-id': 'patient-1',
        'x-correlation-id': 'corr-3',
      }),
      blocked.res,
    );
    expect(blocked.state.statusCode).toBe(429);
    expect(blocked.state.headers['x-correlation-id']).toBe('corr-3');
    expect(blocked.state.headers['retry-after']).toBe('1');
    expect(blocked.state.body).toBeTruthy();
    const payload = JSON.parse(blocked.state.body ?? '{}');
    expect(payload.error).toMatchObject({ code: 'rate_limited', correlationId: 'corr-3' });

    const hitRecords = getCounterRecords('rate.limit.hit');
    const tenantHits = hitRecords.filter((record) => record.attributes?.scope === 'tenant');
    const accountHits = hitRecords.filter((record) => record.attributes?.scope === 'account');
    expect(tenantHits).toHaveLength(2);
    expect(accountHits).toHaveLength(2);

    const blockRecords = getCounterRecords('rate.limit.block');
    expect(blockRecords).toHaveLength(1);
    expect(blockRecords[0].attributes).toMatchObject({ scope: 'tenant', tenant: 'demo' });
  });

  it('enforces account-level limit independently of tenant bucket', () => {
    const now = 0;
    const config = buildConfig({
      rateLimit: {
        tenant: {
          capacity: 10,
          refillPerSecond: 10,
          ttlSeconds: 600,
          maxEntries: 10,
        },
        account: {
          capacity: 1,
          refillPerSecond: 0.5,
          ttlSeconds: 600,
          maxEntries: 100,
        },
      },
    });
    const handler = createAccessGateHandler(
      { config, now: () => now },
      (_req, res) => {
        res.statusCode = 202;
        res.end('accepted');
      },
    );

    const mock = createMockResponse();
    handler(
      createMockRequest({
        'x-practice-id': 'demo',
        'x-actor-id': 'patient-42',
      }),
      mock.res,
    );
    expect(mock.state.statusCode).toBe(202);

    const blocked = createMockResponse();
    handler(
      createMockRequest({
        'x-practice-id': 'demo',
        'x-actor-id': 'patient-42',
      }),
      blocked.res,
    );
    expect(blocked.state.statusCode).toBe(429);
    expect(blocked.state.headers['retry-after']).toBe('2');
    const blockRecords = getCounterRecords('rate.limit.block');
    expect(blockRecords).toHaveLength(1);
    expect(blockRecords[0].attributes).toMatchObject({ scope: 'account', tenant: 'demo' });
  });

  it('evicts buckets after TTL allowing requests to succeed again', () => {
    let now = 0;
    const config = buildConfig({
      rateLimit: {
        tenant: {
          capacity: 1,
          refillPerSecond: 0,
          ttlSeconds: 2,
          maxEntries: 5,
        },
        account: {
          capacity: 5,
          refillPerSecond: 5,
          ttlSeconds: 2,
          maxEntries: 5,
        },
      },
    });
    const handler = createAccessGateHandler(
      { config, now: () => now },
      (_req, res) => {
        res.statusCode = 200;
        res.end('ok');
      },
    );

    const mock = createMockResponse();
    handler(createMockRequest({ 'x-practice-id': 'demo' }), mock.res);
    expect(mock.state.statusCode).toBe(200);

    const blocked = createMockResponse();
    handler(createMockRequest({ 'x-practice-id': 'demo' }), blocked.res);
    expect(blocked.state.statusCode).toBe(429);
    expect(blocked.state.headers['retry-after']).toBe('2');

    now = 3_000;
    const postTtl = createMockResponse();
    handler(createMockRequest({ 'x-practice-id': 'demo' }), postTtl.res);
    expect(postTtl.state.statusCode).toBe(200);
  });

  it('wires middleware through access gate server', () => {
    const now = 0;
    const config = buildConfig({
      rateLimit: {
        tenant: {
          capacity: 1,
          refillPerSecond: 0,
          ttlSeconds: 10,
          maxEntries: 5,
        },
        account: {
          capacity: 5,
          refillPerSecond: 5,
          ttlSeconds: 10,
          maxEntries: 5,
        },
      },
    });
    const server = createAccessGateServer({
      config,
      now: () => now,
      ingress: (_req, res) => {
        res.statusCode = 204;
        res.end('ok');
      },
    });

    const first = createMockResponse();
    server.emit(
      'request',
      createMockRequest({ 'x-practice-id': 'demo', 'x-actor-id': 'patient-1', 'x-correlation-id': 'corr-srv-1' }),
      first.res,
    );
    expect(first.state.statusCode).toBe(204);

    const blocked = createMockResponse();
    server.emit(
      'request',
      createMockRequest({ 'x-practice-id': 'demo', 'x-actor-id': 'patient-1', 'x-correlation-id': 'corr-srv-2' }),
      blocked.res,
    );
    expect(blocked.state.statusCode).toBe(429);
    expect(blocked.state.headers['retry-after']).toBe('10');
  });
});

describe('Access Gate probes', () => {
  let server: ReturnType<typeof createAccessGateServer> | undefined;

  const startServer = async (): Promise<string> => {
    server = createAccessGateServer({ config: buildConfig() });
    await new Promise<void>((resolve) => {
      server!.listen(0, resolve);
    });
    const address = server!.address();
    if (!address || typeof address === 'string') {
      throw new Error('Server not listening');
    }
    return `http://127.0.0.1:${(address as AddressInfo).port}`;
  };

  afterEach(async () => {
    resetPortalSchedulerForHealth();
    if (server && server.listening) {
      await new Promise<void>((resolve, reject) => {
        server!.close((err) => (err ? reject(err) : resolve()));
      });
    }
    server = undefined;
  });

  it('returns ok for liveness probe', async () => {
    const baseUrl = await startServer();
    const response = await fetch(`${baseUrl}/healthz`);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store, max-age=0');
    const body = await response.text();
    expect(body).toBe('ok');
  });

  it('reports readiness based on scheduler status', async () => {
    const scheduler = {
      cancel: () => {},
      drain: async () => 'completed' as const,
      status: () => ({ ready: false, inflight: 0, draining: false, consecutiveFailures: 0 }),
    };
    setPortalSchedulerForHealth(scheduler);
    const baseUrl = await startServer();

    let response = await fetch(`${baseUrl}/readyz`);
    expect(response.status).toBe(503);
    const notReady = (await response.json()) as { status: string };
    expect(notReady.status).toBe('not_ready');

    scheduler.status = () => ({ ready: true, inflight: 0, draining: false, consecutiveFailures: 0 });
    response = await fetch(`${baseUrl}/readyz`);
    expect(response.status).toBe(200);
    const ready = (await response.json()) as { status: string };
    expect(ready.status).toBe('ready');
  });
});
