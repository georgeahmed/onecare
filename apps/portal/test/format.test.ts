/// <reference types="vitest/globals" />

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetStoredPreferencesForTests,
  formatAccessibleDateTime,
  formatDateTime,
  formatNumber,
  formatTime,
  formatTimeRange,
  fromIsoDay,
  getWeekdaySequence,
  formatTimeZoneName,
  resolveLocalePreferences,
  toIsoDay,
} from '../src/lib/format';
import { installMockDom } from './support/mockDom';

const normalizeSpaces = (value: string): string =>
  value.replace(/\u00a0/g, ' ').replace(/\u202f/g, ' ').replace(/\u2009/g, ' ');

describe('locale formatting helpers', () => {
  beforeEach(() => {
    __resetStoredPreferencesForTests();
    const backing = new Map<string, string>();
    const localStorage: Storage = {
      getItem: (key: string) => backing.get(key) ?? null,
      setItem: (key: string, value: string) => {
        backing.set(key, value);
      },
      removeItem: (key: string) => {
        backing.delete(key);
      },
      clear: () => {
        backing.clear();
      },
      key: (index: number) => Array.from(backing.keys())[index] ?? null,
      get length() {
        return backing.size;
      },
    };
    installMockDom({ localStorage });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    __resetStoredPreferencesForTests();
  });

  it('detects defaults for US locale', () => {
    const preferences = resolveLocalePreferences('en-US');

    expect(preferences.locale).toBe('en-US');
    expect(preferences.hourCycle).toBe('h12');
    expect(preferences.firstDayOfWeek).toBe(0);
    expect(typeof preferences.timeZone).toBe('string');
    expect(preferences.timeZone.length).toBeGreaterThan(0);
  });

  it('detects defaults for GB locale', () => {
    const preferences = resolveLocalePreferences('en-GB');

    expect(preferences.locale).toBe('en-GB');
    expect(['h23', 'h24']).toContain(preferences.hourCycle);
    expect(preferences.firstDayOfWeek).toBe(1);
  });

  it('honours stored overrides', () => {
    window.localStorage.setItem(
      'onecare.portal.preferences',
      JSON.stringify({
        hourCycle: 'h24',
        firstDayOfWeek: 2,
        timeZone: 'Europe/Madrid',
      }),
    );

    __resetStoredPreferencesForTests();

    const preferences = resolveLocalePreferences('en-US');

    expect(preferences.hourCycle).toBe('h24');
    expect(preferences.firstDayOfWeek).toBe(2);
    expect(preferences.timeZone).toBe('Europe/Madrid');
  });

  it('formats time respecting hour cycle', () => {
    const twelveHour = normalizeSpaces(
      formatTime('2025-03-01T18:15:00Z', { locale: 'en-US', timeZone: 'UTC' }),
    );
    const twentyFourHour = normalizeSpaces(
      formatTime('2025-03-01T18:15:00Z', { locale: 'en-GB', timeZone: 'UTC' }),
    );

    expect(twelveHour).toContain('6:15');
    expect(twelveHour).toMatch(/PM$/);
    expect(twentyFourHour).toBe('18:15');
  });

  it('formats time ranges with fallback when formatRange is available', () => {
    const usRange = normalizeSpaces(
      formatTimeRange('2025-03-01T13:00:00Z', '2025-03-01T15:30:00Z', {
        locale: 'en-US',
        timeZone: 'UTC',
      }),
    );
    const gbRange = normalizeSpaces(
      formatTimeRange('2025-03-01T13:00:00Z', '2025-03-01T15:30:00Z', {
        locale: 'en-GB',
        timeZone: 'UTC',
      }),
    );

    expect(usRange).toBe('1:00 – 3:30 PM');
    expect(gbRange).toBe('13:00–15:30');
  });

  it('produces accessible date-time strings with time zone names', () => {
    const label = normalizeSpaces(
      formatAccessibleDateTime('2025-03-01T13:00:00Z', { locale: 'en-US', timeZone: 'UTC' }),
    );

    expect(label).toContain('Coordinated Universal Time');
  });

  it('supports localized numbers', () => {
    expect(formatNumber(12345.6, { locale: 'en-US', maximumFractionDigits: 1 })).toBe('12,345.6');
    expect(formatNumber(12345.6, { locale: 'es-ES', maximumFractionDigits: 1 })).toBe('12.345,6');
  });

  it('formats time zone labels', () => {
    expect(formatTimeZoneName('UTC', { locale: 'en-US' })).toContain('Universal Time');
    expect(formatTimeZoneName('UTC', { locale: 'en-US', type: 'short' })).toBe('UTC');
  });

  it('exposes helpers for week sequencing and ISO conversions', () => {
    expect(getWeekdaySequence(1)).toEqual([1, 2, 3, 4, 5, 6, 0]);
    expect(getWeekdaySequence(0)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(toIsoDay(0)).toBe(7);
    expect(toIsoDay(1)).toBe(1);
    expect(fromIsoDay(7)).toBe(0);
    expect(fromIsoDay(1)).toBe(1);
  });

  it('returns empty string for invalid dates', () => {
    const raw = formatDateTime('not-a-date', { locale: 'en-US' });

    expect(raw).toBe('');
  });
});
