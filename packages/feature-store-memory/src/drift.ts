export interface DriftCheckOptions {
  /**
   * Number of histogram buckets when estimating PSI.
   * Default: 10
   */
  bins?: number;
  /**
   * Small smoothing value used when either baseline or current bucket probability is zero.
   * Default: 1e-6
   */
  epsilon?: number;
  /**
   * Threshold that will trigger an alert when the population stability index exceeds it.
   * Default: 0.2 (common early warning threshold).
   */
  psiThreshold?: number;
  /**
   * Absolute difference in means that should raise an alert.
   * Default: 0.1
   */
  meanDiffThreshold?: number;
  /**
   * Absolute difference in standard deviations that should raise an alert.
   * Default: 0.1
   */
  stdDiffThreshold?: number;
  /**
   * Optional feature name for logging context.
   */
  featureName?: string;
  /**
   * Custom logger invoked when threshold is exceeded.
   * Defaults to console.warn.
   */
  logger?: (message: string, context: DriftAlertContext) => void;
}

export interface DriftMetrics {
  psi: number;
  meanBaseline: number;
  meanCurrent: number;
  stdBaseline: number;
  stdCurrent: number;
  meanDiff: number;
  stdDiff: number;
  alertTriggered: boolean;
  triggeredOn: DriftTrigger[];
}

export interface DriftAlertContext extends Omit<DriftMetrics, 'alertTriggered' | 'triggeredOn'> {
  triggeredOn: DriftTrigger[];
  featureName?: string;
}

export type DriftTrigger = 'psi' | 'mean' | 'std';

/**
 * Compute PSI, mean/std deltas, and evaluate against thresholds.
 * Throws when either distribution is empty or contains non-finite numbers.
 */
export function evaluateDistributionDrift(
  baseline: readonly number[],
  current: readonly number[],
  options: DriftCheckOptions = {}
): DriftMetrics {
  if (!Array.isArray(baseline) || baseline.length === 0) {
    throw new Error('Baseline window must contain at least one numeric value');
  }
  if (!Array.isArray(current) || current.length === 0) {
    throw new Error('Current window must contain at least one numeric value');
  }

  const baselineValues = validateNumericArray(baseline, 'baseline');
  const currentValues = validateNumericArray(current, 'current');

  const meanBaseline = mean(baselineValues);
  const meanCurrent = mean(currentValues);
  const stdBaseline = standardDeviation(baselineValues, meanBaseline);
  const stdCurrent = standardDeviation(currentValues, meanCurrent);

  const meanDiff = Math.abs(meanCurrent - meanBaseline);
  const stdDiff = Math.abs(stdCurrent - stdBaseline);

  const psi = populationStabilityIndex(baselineValues, currentValues, options);

  const triggeredOn: DriftTrigger[] = [];
  const psiThreshold = options.psiThreshold ?? 0.2;
  const meanThreshold = options.meanDiffThreshold ?? 0.1;
  const stdThreshold = options.stdDiffThreshold ?? 0.1;

  if (psiThreshold >= 0 && psi >= psiThreshold) triggeredOn.push('psi');
  if (meanThreshold >= 0 && meanDiff >= meanThreshold) triggeredOn.push('mean');
  if (stdThreshold >= 0 && stdDiff >= stdThreshold) triggeredOn.push('std');

  const metrics: DriftMetrics = {
    psi,
    meanBaseline,
    meanCurrent,
    stdBaseline,
    stdCurrent,
    meanDiff,
    stdDiff,
    alertTriggered: triggeredOn.length > 0,
    triggeredOn,
  };

  if (metrics.alertTriggered) {
    const logger = options.logger ?? defaultLogger;
    logger('feature drift detected', {
      ...metrics,
      featureName: options.featureName,
    });
  }

  return metrics;
}

/**
 * Calculate the population stability index between two numeric samples.
 * PSI = sum( (curr - base) * ln(curr/base) ), where proportions are computed per histogram bucket.
 */
export function populationStabilityIndex(
  baseline: readonly number[],
  current: readonly number[],
  options: Pick<DriftCheckOptions, 'bins' | 'epsilon'> = {}
): number {
  const values = [...baseline, ...current];
  const stats = computeRange(values);
  const binCount = Number.isFinite(options.bins) && options.bins && options.bins > 0 ? Math.floor(options.bins) : 10;
  const epsilon = typeof options.epsilon === 'number' && options.epsilon > 0 ? options.epsilon : 1e-6;

  const baseBuckets = histogram(baseline, stats.min, stats.max, binCount, epsilon);
  const currBuckets = histogram(current, stats.min, stats.max, binCount, epsilon);

  let psi = 0;
  for (let i = 0; i < binCount; i += 1) {
    const b = baseBuckets[i];
    const c = currBuckets[i];
    psi += (c - b) * Math.log(c / b);
  }
  return Number.isFinite(psi) ? psi : 0;
}

function histogram(
  values: readonly number[],
  min: number,
  max: number,
  bins: number,
  epsilon: number
): number[] {
  const counts = new Array<number>(bins).fill(epsilon);
  if (min === max) {
    counts[0] += values.length;
  } else {
    const range = max - min;
    const width = range / bins;
    for (const value of values) {
      const idx = Math.min(bins - 1, Math.max(0, Math.floor((value - min) / width)));
      counts[idx] += 1;
    }
  }

  const total = counts.reduce((sum, count) => sum + count, 0);
  return counts.map((count) => (total > 0 ? count / total : 0));
}

function mean(data: readonly number[]): number {
  const total = data.reduce((sum, value) => sum + value, 0);
  return total / data.length;
}

function standardDeviation(data: readonly number[], precomputedMean?: number): number {
  const m = typeof precomputedMean === 'number' ? precomputedMean : mean(data);
  if (data.length === 1) return 0;
  const variance =
    data.reduce((sum, value) => {
      const diff = value - m;
      return sum + diff * diff;
    }, 0) / data.length;
  return Math.sqrt(variance);
}

function validateNumericArray(values: readonly number[], label: string): number[] {
  const cleaned = values.map((value, index) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`${label} window contains non-finite value at index ${index}`);
    }
    return value;
  });
  return cleaned;
}

function computeRange(values: readonly number[]): { min: number; max: number } {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    if (value < min) min = value;
    if (value > max) max = value;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    throw new Error('Unable to compute range for drift evaluation');
  }
  if (min === max) {
    // Avoid zero width bins.
    min -= 0.5;
    max += 0.5;
  }
  return { min, max };
}

function defaultLogger(message: string, context: DriftAlertContext): void {
  // eslint-disable-next-line no-console
  console.warn(message, context);
}
