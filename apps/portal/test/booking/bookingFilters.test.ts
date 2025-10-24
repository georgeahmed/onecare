/// <reference types="vitest/globals" />

import { describe, expect, it } from 'vitest';
import {
  applyFromFilter,
  applyToFilter,
  filterSlots,
  resolveFilterBounds,
  slotMatchesFilters,
} from '../../src/lib/bookingFilters';
import type { BookingFilterState, BookingSlot } from '../../src/lib/booking';

const baseFilters = (overrides: Partial<BookingFilterState> = {}): BookingFilterState => ({
  modality: 'all',
  from: undefined,
  to: undefined,
  serviceType: undefined,
  location: undefined,
  ...overrides
});

const demoSlot = (overrides: Partial<BookingSlot> = {}): BookingSlot => ({
  id: 'slot-1',
  start: '2025-06-10T09:00:00.000Z',
  end: '2025-06-10T09:30:00.000Z',
  modality: 'phone',
  serviceType: 'gp-consult',
  location: 'Remote',
  ...overrides
});

describe('applyFromFilter', () => {
  it('moves the end date forward when the new start date exceeds it', () => {
    const previous = baseFilters({ from: '2025-06-01', to: '2025-06-05' });
    const next = applyFromFilter(previous, '2025-06-10');

    expect(next.from).toBe('2025-06-10');
    expect(next.to).toBe('2025-06-10');
  });

  it('ignores invalid date inputs', () => {
    const previous = baseFilters({ from: '2025-06-01', to: '2025-06-05' });
    const next = applyFromFilter(previous, 'not-a-date');

    expect(next).toBe(previous);
  });
});

describe('applyToFilter', () => {
  it('moves the start date back when the end becomes earlier', () => {
    const previous = baseFilters({ from: '2025-06-04', to: '2025-06-06' });
    const next = applyToFilter(previous, '2025-06-02');

    expect(next.from).toBe('2025-06-02');
    expect(next.to).toBe('2025-06-02');
  });

  it('preserves the existing filter when the input is invalid', () => {
    const previous = baseFilters({ from: '2025-06-01', to: '2025-06-05' });
    const next = applyToFilter(previous, '2025-06-05');

    expect(next).toBe(previous);
  });
});

describe('slotMatchesFilters', () => {
  it('includes slots that fall within the inclusive day range', () => {
    const filters = baseFilters({ from: '2025-06-10', to: '2025-06-10' });
    const slot = demoSlot({ start: '2025-06-10T23:45:00.000Z' });

    expect(slotMatchesFilters(slot, filters)).toBe(true);
  });

  it('excludes slots that start after the end day', () => {
    const filters = baseFilters({ from: '2025-06-10', to: '2025-06-12' });
    const slot = demoSlot({ start: '2025-06-13T00:01:00.000Z' });

    expect(slotMatchesFilters(slot, filters)).toBe(false);
  });

  it('filters by modality when specified', () => {
    const filters = baseFilters({ modality: 'in_person' });
    const slot = demoSlot({ modality: 'phone' });

    expect(slotMatchesFilters(slot, filters)).toBe(false);
  });

  it('filters by service type when provided', () => {
    const filters = baseFilters({ serviceType: 'gp-consult' });
    const slot = demoSlot({ serviceType: 'pharmacy' });

    expect(slotMatchesFilters(slot, filters)).toBe(false);
  });

  it('filters by location when provided', () => {
    const filters = baseFilters({ location: 'clinic-a' });
    const slot = demoSlot({ location: 'Clinic-A' });

    expect(slotMatchesFilters(slot, filters)).toBe(true);

    const mismatched = demoSlot({ location: 'Clinic-B' });
    expect(slotMatchesFilters(mismatched, filters)).toBe(false);
  });
});

describe('resolveFilterBounds', () => {
  it('returns null bounds when filters are unset', () => {
    const bounds = resolveFilterBounds(baseFilters());
    expect(bounds).toEqual({ from: null, to: null });
  });

  it('computes inclusive end-of-day timestamp for the to filter', () => {
    const bounds = resolveFilterBounds(baseFilters({ from: '2025-06-01', to: '2025-06-01' }));
    expect(bounds.from).toBe(Date.parse('2025-06-01T00:00:00.000Z'));
    expect(bounds.to).toBe(Date.parse('2025-06-01T23:59:59.999Z'));
  });
});

describe('filterSlots', () => {
  it('returns slots matching the provided filters', () => {
    const slots = [
      demoSlot({ id: 'slot-early', start: '2025-06-10T08:00:00.000Z' }),
      demoSlot({ id: 'slot-late', start: '2025-06-12T20:00:00.000Z', modality: 'in_person' }),
    ];
    const filters = baseFilters({ from: '2025-06-10', to: '2025-06-12', modality: 'in_person' });
    const result = filterSlots(slots, filters);
    expect(result).toEqual([slots[1]]);
  });

  it('treats the end day as inclusive up to the last millisecond', () => {
    const slots = [
      demoSlot({ id: 'slot-on-end', start: '2025-06-12T23:59:59.900Z' }),
      demoSlot({ id: 'slot-after', start: '2025-06-13T00:00:00.000Z' }),
    ];
    const filters = baseFilters({ from: '2025-06-10', to: '2025-06-12' });
    const result = filterSlots(slots, filters);
    expect(result.map((slot) => slot.id)).toEqual(['slot-on-end']);
  });
});
