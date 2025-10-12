import { describe, expect, it, vi } from 'vitest';

import { InMemoryFeatureStore } from '../src/index';

const sampleFeatures = {
  riskScore: 0.82,
  flags: { chronicCondition: true },
};

describe('InMemoryFeatureStore', () => {
  it('returns the same features that were stored', async () => {
    const store = new InMemoryFeatureStore();
    await store.putFeatures('member-123', sampleFeatures);

    const result = await store.getFeatures('member-123');
    expect(result).toEqual(sampleFeatures);
  });

  it('clones stored features so callers cannot mutate internal state', async () => {
    const store = new InMemoryFeatureStore();
    await store.putFeatures('member-123', sampleFeatures);

    const fetched = await store.getFeatures('member-123');
    expect(fetched).not.toBeNull();
    fetched!.riskScore = 0.1;
    (fetched!.flags as { chronicCondition: boolean }).chronicCondition = false;

    const secondRead = await store.getFeatures('member-123');
    expect(secondRead).toEqual(sampleFeatures);
  });

  it('honours ttlMs by expiring entries after the configured window', async () => {
    vi.useFakeTimers();
    const clock = () => Date.now();
    const store = new InMemoryFeatureStore({ ttlMs: 10, clock });

    await store.putFeatures('member-123', sampleFeatures);
    vi.advanceTimersByTime(9);
    expect(await store.getFeatures('member-123')).not.toBeNull();

    vi.advanceTimersByTime(2);
    expect(await store.getFeatures('member-123')).toBeNull();
    vi.useRealTimers();
  });

  it('purgeExpired removes stale entries eagerly', async () => {
    let now = 0;
    const store = new InMemoryFeatureStore({ ttlMs: 5, clock: () => now });

    await store.putFeatures('member-1', sampleFeatures);
    await store.putFeatures('member-2', sampleFeatures);

    now = 6;
    store.purgeExpired();

    expect(await store.getFeatures('member-1')).toBeNull();
    expect(await store.getFeatures('member-2')).toBeNull();
  });
});
