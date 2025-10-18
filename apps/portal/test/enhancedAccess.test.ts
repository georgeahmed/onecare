/// <reference types="vitest/globals" />

import {
  getEnhancedAccessConfig,
  resolveEnhancedAccessConfig,
  minutesToTimeLabel,
  dayIndexToLabel,
} from '../src/lib/enhancedAccess';

describe('enhanced access config', () => {
  it('falls back to defaults when env is empty', () => {
    const config = resolveEnhancedAccessConfig({});
    expect(config.timezone).toBe('Europe/London');
    expect(config.windows).toHaveLength(2);
  });

  it('parses custom configuration when valid', () => {
    const env = {
      VITE_ENHANCED_ACCESS_WINDOWS: JSON.stringify({
        timezone: 'Europe/Paris',
        windows: [
          { name: 'evening', days: [1, 2], start: '19:00', end: '21:00' },
          { name: 'sunday_morning', days: [7], start: '08:00', end: '10:00' },
        ],
      }),
    };
    const config = resolveEnhancedAccessConfig(env);
    expect(config.timezone).toBe('Europe/Paris');
    expect(config.windows).toHaveLength(2);
    expect(config.windows[0]).toMatchObject({
      name: 'evening',
      days: [1, 2],
      startMinutes: 19 * 60,
      endMinutes: 21 * 60,
    });
  });

  it('ignores invalid windows and keeps defaults when parsing fails', () => {
    const env = {
      VITE_ENHANCED_ACCESS_WINDOWS: JSON.stringify({
        timezone: 'America/New_York',
        windows: [{ name: 'broken', days: [9], start: 'notatime', end: 'also-bad' }],
      }),
    };
    const config = resolveEnhancedAccessConfig(env);
    expect(config.timezone).toBe('Europe/London');
    expect(config.windows).toHaveLength(2);
  });
});

describe('helpers', () => {
  it('formats minutes to time labels', () => {
    expect(minutesToTimeLabel(0)).toBe('00:00');
    expect(minutesToTimeLabel(9 * 60 + 15)).toBe('09:15');
    expect(minutesToTimeLabel(23 * 60 + 59)).toBe('23:59');
  });

  it('returns friendly day labels', () => {
    expect(dayIndexToLabel(1)).toBe('Monday');
    expect(dayIndexToLabel(7)).toBe('Sunday');
    expect(dayIndexToLabel(99)).toBe('Day');
  });
});

describe('getEnhancedAccessConfig', () => {
  it('returns a config when executed in browser env', () => {
    expect(() => getEnhancedAccessConfig()).not.toThrow();
  });
});
