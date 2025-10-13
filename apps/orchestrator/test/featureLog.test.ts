import { describe, it, beforeAll, afterAll, expect, beforeEach, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import { consentReference, setConsentFixtureEnv } from './consentFixture';

let server: import('http').Server;
let baseUrl: () => string;
let getFeatureStoreForTest: () => import('@onecare/ports').FeatureStore | null;
let setBusReadyForTest: (ready: boolean) => void;

describe('feature logging endpoint', () => {
  beforeAll(async () => {
    process.env.FEATURE_LOGGING = '1';
    process.env.FEATURE_LOG_API_KEY = 'feature-test-key';
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
    delete process.env.FEATURE_LOG_API_KEY;
    delete process.env.CONSENT_CACHE;
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  beforeEach(() => {
    setBusReadyForTest(true);
    setConsentFixtureEnv();
  });

  afterEach(() => {
    const store = getFeatureStoreForTest();
    const candidate = store as { clear?: () => void } | null;
    if (candidate?.clear) {
      candidate.clear();
    }
  });

  it('accepts feature log payloads and stores them when enabled', async () => {
    const consentRef = consentReference('patient-123', 'analytics-lite');
    const res = await fetch(`${baseUrl()}/feature-log`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': 'feature-test-key',
        'x-auth-scope': 'analytics:feature:write',
        'x-consent-reference': consentRef,
        'x-correlation-id': 'corr-123',
      },
      body: JSON.stringify({
        source: 'safety',
        entityId: 'patient-123',
        patientId: 'patient-123',
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
      metadata: { practiceId: 'demo', consentReference: consentRef },
      patientId: 'patient-123',
    });
  });

  it('rejects feature payloads containing nested data', async () => {
    const res = await fetch(`${baseUrl()}/feature-log`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': 'feature-test-key',
        'x-auth-scope': 'analytics:feature:write',
        'x-consent-reference': consentReference('patient-123', 'analytics-lite'),
      },
      body: JSON.stringify({
        source: 'triage',
        patientId: 'patient-123',
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
        'x-api-key': 'feature-test-key',
        'x-auth-scope': 'analytics:feature:write',
        'x-consent-reference': consentReference('patient-123', 'analytics-lite'),
      },
      body: JSON.stringify({
        source: 'triage',
        patientId: 'patient-123',
        metadata: 42,
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body?.error?.code).toBe('invalid_input');
  });
});
