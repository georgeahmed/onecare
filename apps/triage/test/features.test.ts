import { describe, it, expect } from 'vitest';
import type { ResolvedConfig } from '@onecare/config';
import { extractFeatures } from '../src/application/features';

function buildConfig(overrides: Record<string, unknown>): ResolvedConfig {
  return {
    practiceId: 'demo-practice',
    triage: overrides,
  } as ResolvedConfig;
}

describe('extractFeatures', () => {
  it('normalizes core components to the configured range', () => {
    const config = buildConfig({
      normalization: {
        features: {
          acuity: { min: -1, max: 1, default: 0 },
          risk: { min: 0, max: 10, default: 5 },
        },
      },
    });

    const result = extractFeatures(
      {
        acuity: 0.2,
        risk: 7.5,
      },
      config,
    );

    expect(result.acuity).toBeCloseTo(0.6, 6);
    expect(result.risk).toBeCloseTo(0.75, 6);
  });

  it('falls back to defaults when values are missing', () => {
    const config = buildConfig({
      normalization: {
        features: {
          complexity: { min: 0, max: 100, default: 25 },
        },
      },
    });

    const result = extractFeatures({}, config);

    expect(result.complexity).toBeCloseTo(0.25, 6);
  });

  it('supports alias mappings for time and capacity pressure', () => {
    const config = buildConfig({});

    const result = extractFeatures(
      {
        timePressure: 0.4,
        capacityPressure: '0.9',
      },
      config,
    );

    expect(result.time).toBeCloseTo(0.4, 6);
    expect(result.capacity).toBeCloseTo(0.9, 6);
  });

  it('retains additional numeric feature entries', () => {
    const config = buildConfig({});

    const result = extractFeatures(
      {
        acuity: 0.8,
        customSignal: 5,
        another: '3.5',
      },
      config,
    );

    expect(result.acuity).toBeCloseTo(0.8, 6);
    expect(result.customSignal).toBe(5);
    expect(result.another).toBeCloseTo(3.5, 6);
  });
});
