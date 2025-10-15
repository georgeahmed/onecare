import { describe, expect, it } from 'vitest';

import { InMemoryOnlineFeatureStore } from '../src/inMemoryOnlineStore';

const baseRecord = {
  featureSet: 'triage-core',
  entityId: 'patient-123',
  payload: { schemaVersion: 'v1.0.0', generatedAt: '2025-01-12T08:00:00.000Z', acuity: 0.2 },
  asOf: '2025-01-12T08:00:00.000Z',
};

describe('InMemoryOnlineFeatureStore', () => {
  it('stores and retrieves the latest feature snapshot', async () => {
    const store = new InMemoryOnlineFeatureStore();
    await store.upsert(baseRecord);

    const result = await store.get({ featureSet: 'triage-core', entityId: 'patient-123' });
    expect(result).not.toBeNull();
    expect(result?.acuity).toBe(0.2);
  });

  it('supports as-of queries', async () => {
    const store = new InMemoryOnlineFeatureStore();
    await store.upsert(baseRecord);
    await store.upsert({
      ...baseRecord,
      asOf: '2025-01-12T09:00:00.000Z',
      payload: { ...baseRecord.payload, generatedAt: '2025-01-12T09:00:00.000Z', acuity: 0.6 },
    });

    const earlier = await store.get({
      featureSet: 'triage-core',
      entityId: 'patient-123',
      asOf: '2025-01-12T08:30:00.000Z',
    });
    expect(earlier?.acuity).toBe(0.2);

    const latest = await store.get({
      featureSet: 'triage-core',
      entityId: 'patient-123',
      asOf: '2025-01-12T09:30:00.000Z',
    });
    expect(latest?.acuity).toBe(0.6);
  });

  it('honours ttlSeconds for expiry and purgeExpired', async () => {
    let now = Date.parse('2025-01-12T08:00:00.000Z');
    const store = new InMemoryOnlineFeatureStore({ clock: () => now });

    await store.upsert({ ...baseRecord, ttlSeconds: 60 });
    expect(await store.get({ featureSet: 'triage-core', entityId: 'patient-123' })).not.toBeNull();

    now += 120_000;
    expect(await store.get({ featureSet: 'triage-core', entityId: 'patient-123' })).toBeNull();
    expect(store.purgeExpired()).toBeGreaterThan(0);
  });

  it('reports healthy status', async () => {
    const store = new InMemoryOnlineFeatureStore();
    const health = await store.health();
    expect(health.status).toBe('ok');
    const readiness = await store.readiness();
    expect(readiness.ready).toBe(true);
  });
});
