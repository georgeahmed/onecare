import { describe, it, expect } from 'vitest';
import type { ResolvedConfig } from '@onecare/config';
import { computeTriageScore } from '../src/application/scoring';
import { determinePriority } from '../src/application/triage.state';
import type { TriageFeatureVector } from '../src/application/scoring';

interface ScoreConfigOptions {
  weights: Partial<Record<string, number>>;
  calibration?: Record<string, number>;
  tieBreaker?: Record<string, number>;
  thresholds?: Record<string, number>;
}

function buildConfig(options: ScoreConfigOptions): ResolvedConfig {
  return {
    practiceId: 'test-practice',
    triage: {
      score_weights: options.weights,
      score_calibration: options.calibration,
      priority_tiebreaker: options.tieBreaker,
    },
    priority_thresholds: options.thresholds,
  };
}

describe('computeTriageScore', () => {
  it('combines features using configured weights', () => {
    const config = buildConfig({
      weights: {
        acuity: 1.0,
        risk: 0.5,
        complexity: 0.25,
        time: 0.75,
        capacity: 0.1,
      },
      calibration: {
        min: 0,
        max: 5,
        slope: 1,
        intercept: 0,
      },
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
      weights: {
        acuity: 1.0,
      },
    });

    const score = computeTriageScore(config, {
      acuity: 0.9,
      risk: 0.7,
      time: 0.4,
    });

    expect(score).toBeCloseTo(0.9, 6);
  });

  it('clamps calibrated scores and records upper bound hits', () => {
    const config = buildConfig({
      weights: {
        acuity: 1.0,
        risk: 0.5,
      },
      calibration: {
        slope: 1,
        intercept: 0,
        min: 0,
        max: 1,
      },
    });

    const score = computeTriageScore(config, { acuity: 1, risk: 1 });
    expect(score).toBe(1);
  });
});

describe('determinePriority', () => {
  const defaultThresholds = {
    stat: 0.9,
    urgent: 0.7,
    soon: 0.4,
    routine: 0,
  };

  const tieBreaker = {
    epsilon: 0.02,
    acuity_promotion: 0.8,
  };

  it('promotes near-threshold scores to the next band when acuity is high', () => {
    const config = buildConfig({
      weights: { acuity: 1 },
      calibration: { slope: 1, intercept: 0, min: 0, max: 1 },
      tieBreaker,
      thresholds: defaultThresholds,
    });

    const features: TriageFeatureVector = { acuity: 0.95 };
    const priority = determinePriority(config, 0.89, features);
    expect(priority).toBe('STAT');
  });

  it('keeps lower priority when acuity is below promotion threshold', () => {
    const config = buildConfig({
      weights: { acuity: 1 },
      calibration: { slope: 1, intercept: 0, min: 0, max: 1 },
      tieBreaker,
      thresholds: defaultThresholds,
    });

    const features: TriageFeatureVector = { acuity: 0.4 };
    const priority = determinePriority(config, 0.69, features);
    expect(priority).toBe('SOON');
  });

  it('raises routine cases to soon when close to threshold and acuity high', () => {
    const config = buildConfig({
      weights: { acuity: 1 },
      calibration: { slope: 1, intercept: 0, min: 0, max: 1 },
      tieBreaker,
      thresholds: defaultThresholds,
    });

    const priority = determinePriority(config, 0.39, { acuity: 0.92 });
    expect(priority).toBe('SOON');
  });
});
