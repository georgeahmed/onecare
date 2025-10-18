/// <reference types="vitest/globals" />

import { getFairnessConfig, resolveFairnessConfig } from '../src/lib/fairness';

describe('fairness config', () => {
  it('uses defaults when env is empty', () => {
    const config = resolveFairnessConfig({});
    expect(config.telephoneMinFraction).toBeCloseTo(0.15, 3);
  });

  it('parses decimal fractions', () => {
    const config = resolveFairnessConfig({ VITE_BOOKING_TELEPHONE_MIN_FRACTION: '0.25' });
    expect(config.telephoneMinFraction).toBe(0.25);
  });

  it('parses percentage inputs larger than one as percentages', () => {
    const config = resolveFairnessConfig({ VITE_BOOKING_TELEPHONE_MIN_FRACTION: '30' });
    expect(config.telephoneMinFraction).toBeCloseTo(0.3, 3);
  });

  it('ignores invalid values and falls back to default', () => {
    const config = resolveFairnessConfig({ VITE_BOOKING_TELEPHONE_MIN_FRACTION: 'banana' });
    expect(config.telephoneMinFraction).toBeCloseTo(0.15, 3);
  });
});

describe('getFairnessConfig', () => {
  it('returns a config without throwing', () => {
    expect(() => getFairnessConfig()).not.toThrow();
  });
});
