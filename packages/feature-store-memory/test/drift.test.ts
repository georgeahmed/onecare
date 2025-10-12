import { describe, it, expect, vi } from 'vitest';

import { evaluateDistributionDrift, populationStabilityIndex } from '../src/drift';

describe('populationStabilityIndex', () => {
  it('returns zero when distributions are identical', () => {
    const baseline = [1, 2, 3, 4, 5];
    const current = [1, 2, 3, 4, 5];

    const psi = populationStabilityIndex(baseline, current);

    expect(psi).toBeCloseTo(0, 6);
  });

  it('increases when distributions diverge', () => {
    const baseline = [0, 0, 0, 0, 0];
    const current = [1, 1, 1, 1, 1];

    const psi = populationStabilityIndex(baseline, current);

    expect(psi).toBeGreaterThan(0.5);
  });
});

describe('evaluateDistributionDrift', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('computes metrics without triggering alert when under thresholds', () => {
    const baseline = [1, 1.1, 0.9, 1.05, 0.95];
    const current = [1, 0.98, 1.02, 1.01, 0.99];

    const logger = vi.fn();
    const result = evaluateDistributionDrift(baseline, current, {
      psiThreshold: 0.5,
      meanDiffThreshold: 0.5,
      stdDiffThreshold: 0.5,
      logger,
      featureName: 'acuity',
    });

    expect(result.alertTriggered).toBe(false);
    expect(logger).not.toHaveBeenCalled();
  });

  it('logs warning when PSI exceeds threshold', () => {
    const baseline = [0, 0, 0, 0, 0];
    const current = [5, 5, 5, 5, 5];

    const logger = vi.fn();
    const result = evaluateDistributionDrift(baseline, current, {
      psiThreshold: 0.1,
      logger,
      featureName: 'riskScore',
    });

    expect(result.alertTriggered).toBe(true);
    expect(result.triggeredOn).toContain('psi');
    expect(logger).toHaveBeenCalledWith(
      'feature drift detected',
      expect.objectContaining({
        featureName: 'riskScore',
        psi: result.psi,
      })
    );
  });

  it('throws when arrays are empty', () => {
    expect(() => evaluateDistributionDrift([], [1, 2, 3])).toThrow('Baseline window must contain at least one numeric value');
    expect(() => evaluateDistributionDrift([1, 2, 3], [])).toThrow('Current window must contain at least one numeric value');
  });

  it('throws when encountering non numeric values', () => {
    expect(() => evaluateDistributionDrift([1, Number.NaN], [1, 2])).toThrow(/baseline window contains non-finite value/);
  });
});
