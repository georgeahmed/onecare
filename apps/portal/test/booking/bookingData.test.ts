/// <reference types="vitest/globals" />

import { BookingCache } from '../../src/lib/bookingData';

describe('BookingCache', () => {
  const sampleFilters = { modality: 'phone' as const, from: '2025-01-01', to: '2025-01-07' };
  const sampleSlots = [
    {
      id: 'slot-1',
      start: '2025-01-02T09:00:00Z',
      end: '2025-01-02T09:15:00Z',
      modality: 'phone' as const,
      location: 'Remote',
    },
  ];

  it('stores and retrieves entries within TTL', () => {
    const cache = new BookingCache({ ttlMs: 1_000 });
    cache.put(sampleFilters, sampleSlots);
    expect(cache.get(sampleFilters)).toEqual(sampleSlots);
  });

  it('expires cache entries after TTL', () => {
    const cache = new BookingCache({ ttlMs: 1 });
    cache.put(sampleFilters, sampleSlots);
    return new Promise((resolve) => {
      setTimeout(() => {
        expect(cache.get(sampleFilters)).toBeNull();
        resolve(null);
      }, 10);
    });
  });

  it('evicts oldest entries when exceeding max', () => {
    const cache = new BookingCache({ maxEntries: 2 });
    cache.put({ modality: 'phone' }, sampleSlots);
    cache.put({ modality: 'all' }, sampleSlots);
    cache.put({ modality: 'in_person' }, sampleSlots);
    expect(cache.get({ modality: 'phone' })).toBeNull();
    expect(cache.get({ modality: 'all' })).not.toBeNull();
  });
});
