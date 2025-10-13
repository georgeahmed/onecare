import { describe, it, beforeAll, afterAll, expect, beforeEach, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';

let server: import('http').Server;
let baseUrl: () => string;
let getFeatureStoreForTest: () => import('@onecare/ports').FeatureStore | null;
let setBusReadyForTest: (ready: boolean) => void;

describe('feature logging endpoint', () => {
  beforeAll(async () => {
    process.env.FEATURE_LOGGING = '1';
    process.env.BUS_IMPL = 'memory';
    const mod = await import('../src/index');
    server = mod.server;
    getFeatureStoreForTest = mod.getFeatureStoreForTest;
    setBusReadyForTest = mod.setBusReadyForTest;
    baseUrl = () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('Server not listening');
      }
      return `http://127.0.0.1:${(address as AddressInfo).port}`;
    };
    await new Promise<void>((resolve) => {
      server.listen(0, resolve);
    });
  });

  afterAll(async () => {
    delete process.env.FEATURE_LOGGING;
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  beforeEach(() => {
    setBusReadyForTest(true);
  });

  afterEach(() => {
    const store = getFeatureStoreForTest();
    const candidate = store as { clear?: () => void } | null;
    if (candidate?.clear) {
      candidate.clear();
    }
  });

  it('accepts feature log payloads and stores them when enabled', async () => {
    const res = await fetch(`${baseUrl()}/feature-log`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-correlation-id': 'corr-123',
      },
      body: JSON.stringify({
        source: 'safety',
        entityId: 'patient-123',
        features: { probEmergency: 0.9 },
        metadata: { practiceId: 'demo' },
      }),
    });

    expect(res.status).toBe(202);

    const store = getFeatureStoreForTest();
    expect(store).toBeTruthy();
    const record = await store!.getFeatures('safety:patient-123:corr-123');
    expect(record).toBeTruthy();
    expect(record).toMatchObject({
      source: 'safety',
      features: { probEmergency: 0.9 },
      metadata: { practiceId: 'demo' },
    });
  });

  it('rejects feature payloads containing nested data', async () => {
    const res = await fetch(`${baseUrl()}/feature-log`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        source: 'triage',
        features: { nested: { invalid: true } },
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body?.error?.code).toBe('invalid_input');
  });

  it('rejects metadata that is not an object', async () => {
    const res = await fetch(`${baseUrl()}/feature-log`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        source: 'triage',
        metadata: 42,
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body?.error?.code).toBe('invalid_input');
  });
});
