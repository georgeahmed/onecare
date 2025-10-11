import type { ResolvedConfig } from '@onecare/config';

const SCORE_COMPONENTS = ['acuity', 'risk', 'complexity', 'time', 'capacity'] as const;

type ScoreComponent = (typeof SCORE_COMPONENTS)[number];

export type TriageFeatureVector = Partial<Record<ScoreComponent, number>> & Record<string, number | undefined>;

export interface ScoreWeights extends Record<ScoreComponent, number> {}

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

export function computeTriageScore(config: ResolvedConfig, features: TriageFeatureVector): number {
  const weights = extractWeights(config);
  let score = 0;

  for (const key of SCORE_COMPONENTS) {
    const featureValue = sanitizeNumber(features[key]);
    score += weights[key] * featureValue;
  }

  return score;
}

export { SCORE_COMPONENTS, extractWeights as getScoreWeights };
