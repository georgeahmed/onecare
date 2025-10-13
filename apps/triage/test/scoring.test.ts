import { describe, it, expect } from 'vitest';
import type { ResolvedConfig } from '@onecare/config';
import { computeTriageScore } from '../src/application/scoring';

function buildConfig(weights: Partial<Record<string, number>>): ResolvedConfig {
  return {
    practiceId: 'test-practice',
    triage: { score_weights: weights },
  };
}

describe('computeTriageScore', () => {
  it('combines features using configured weights', () => {
    const config = buildConfig({
      acuity: 1.0,
      risk: 0.5,
      complexity: 0.25,
      time: 0.75,
      capacity: 0.1,
    });

    const score = computeTriageScore(config, {
      acuity: 0.8,
      risk: 0.6,
      complexity: 0.4,
      time: 0.5,
      capacity: 0.9,
    });

    const expected =
      1.0 * 0.8 +
      0.5 * 0.6 +
      0.25 * 0.4 +
      0.75 * 0.5 +
      0.1 * 0.9;

    expect(score).toBeCloseTo(expected, 6);
  });

  it('falls back to zero for missing weights or features', () => {
    const config = buildConfig({
      acuity: 1.0,
    });

    const score = computeTriageScore(config, {
      acuity: 0.9,
      risk: 0.7,
      time: 0.4,
    });

    expect(score).toBeCloseTo(0.9, 6);
  });
});
