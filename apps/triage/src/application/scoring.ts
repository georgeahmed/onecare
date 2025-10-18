import type { ResolvedConfig } from '@onecare/config';
import { createCounter } from '@onecare/observability';

const SCORE_COMPONENTS = ['acuity', 'risk', 'complexity', 'time', 'capacity'] as const;

type ScoreComponent = (typeof SCORE_COMPONENTS)[number];

export type TriageFeatureVector = Partial<Record<ScoreComponent, number>> & Record<string, number | undefined>;

export interface ScoreWeights extends Record<ScoreComponent, number> {}

interface ScoreCalibration {
  slope: number;
  intercept: number;
  min: number;
  max: number;
}

const scoreClampCounter = createCounter('triage.score.clamped');

function sanitizeNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function extractWeights(config: ResolvedConfig): ScoreWeights {
  const triageConfig = (config.triage as { score_weights?: Record<string, unknown> } | undefined)?.score_weights ?? {};
  const weights: Partial<Record<ScoreComponent, number>> = {};

  for (const key of SCORE_COMPONENTS) {
    weights[key] = sanitizeNumber(triageConfig[key]);
  }

  return weights as ScoreWeights;
}

function extractCalibration(config: ResolvedConfig): ScoreCalibration {
  const raw = ((config.triage as { score_calibration?: Record<string, unknown> } | undefined)?.score_calibration ??
    {}) as Record<string, unknown>;

  const hasSlope = Object.prototype.hasOwnProperty.call(raw, 'slope');
  const hasIntercept = Object.prototype.hasOwnProperty.call(raw, 'intercept');
  const hasMin = Object.prototype.hasOwnProperty.call(raw, 'min');
  const hasMax = Object.prototype.hasOwnProperty.call(raw, 'max');

  const slope = hasSlope ? sanitizeNumber(raw.slope) : 1;
  const intercept = hasIntercept ? sanitizeNumber(raw.intercept) : 0;
  const min = hasMin && Number.isFinite(raw.min as number) ? Number(raw.min) : 0;
  const maxCandidate = hasMax && Number.isFinite(raw.max as number) ? Number(raw.max) : 1;
  const max = maxCandidate > min ? maxCandidate : Math.max(1, min);

  return {
    slope,
    intercept,
    min,
    max,
  };
}

function clampScore(value: number, min: number, max: number): { value: number; clamped: boolean; bound?: 'floor' | 'ceiling' } {
  if (value < min) {
    return { value: min, clamped: true, bound: 'floor' };
  }
  if (value > max) {
    return { value: max, clamped: true, bound: 'ceiling' };
  }
  return { value, clamped: false };
}

export function computeTriageScore(config: ResolvedConfig, features: TriageFeatureVector): number {
  const weights = extractWeights(config);
  const calibration = extractCalibration(config);
  let score = 0;

  for (const key of SCORE_COMPONENTS) {
    const featureValue = sanitizeNumber(features[key]);
    score += weights[key] * featureValue;
  }

  const calibrated = score * calibration.slope + calibration.intercept;
  const { value, clamped, bound } = clampScore(calibrated, calibration.min, calibration.max);
  if (clamped) {
    scoreClampCounter.add(1, { bound: bound ?? 'unknown' });
  }
  return value;
}

export { SCORE_COMPONENTS, extractWeights as getScoreWeights, extractCalibration as getScoreCalibration };
