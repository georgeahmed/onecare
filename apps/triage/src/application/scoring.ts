import type { ResolvedConfig } from '@onecare/config';
import { createCounter } from '@onecare/observability';
import { normalizeText } from './text-normalize';

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
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return 0;
    }
    const parsed = Number(trimmed);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return 0;
}

function coerceNumeric(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return undefined;
    }
    const parsed = Number(trimmed);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
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
  const defaultMax = 1;
  const maxCandidate = hasMax && Number.isFinite(raw.max as number) ? Number(raw.max) : defaultMax;
  const max = maxCandidate > min ? maxCandidate : Math.max(min, defaultMax);

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

const DEFAULT_FALLBACK_CONFIG = Object.freeze({
  enabled: true,
  timeBudgetMs: 120,
  scoreDeltaTolerance: 0.15,
  maxReasons: 5,
});

const MAX_REASON_SEGMENT_LENGTH = 48;

const clamp01 = (value: number): number => {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
};

export interface PriorityThresholds {
  STAT: number;
  URGENT: number;
  SOON: number;
  ROUTINE: number;
}

export function resolvePriorityThresholds(config: ResolvedConfig): PriorityThresholds {
  const raw = (config.priority_thresholds as Record<string, unknown> | undefined) ?? {};
  const thresholds: PriorityThresholds = {
    STAT: clamp01(coerceNumeric(raw.stat ?? raw.STAT) ?? 0.9),
    URGENT: clamp01(coerceNumeric(raw.urgent ?? raw.URGENT) ?? 0.7),
    SOON: clamp01(coerceNumeric(raw.soon ?? raw.SOON) ?? 0.4),
    ROUTINE: clamp01(coerceNumeric(raw.routine ?? raw.ROUTINE) ?? 0),
  };
  if (thresholds.URGENT > thresholds.STAT) thresholds.URGENT = thresholds.STAT;
  if (thresholds.SOON > thresholds.URGENT) thresholds.SOON = thresholds.URGENT;
  if (thresholds.ROUTINE > thresholds.SOON) thresholds.ROUTINE = thresholds.SOON;
  return thresholds;
}

function toReasonSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, MAX_REASON_SEGMENT_LENGTH);
}

function appendReason(reasons: Set<string>, namespace: string, rawValue: string, maxReasons: number): boolean {
  if (reasons.size >= maxReasons) {
    return false;
  }
  const slug = toReasonSlug(rawValue);
  if (!slug) {
    return reasons.size < maxReasons;
  }
  reasons.add(`rule:${namespace}:${slug}`);
  return reasons.size < maxReasons;
}

interface CollectRedFlagOptions {
  narrative?: string;
  redFlags: readonly string[];
  maxReasons: number;
  timeBudgetMs: number;
  reasons: Set<string>;
}

function collectRedFlagReasons(options: CollectRedFlagOptions): string[] {
  const { narrative, redFlags, maxReasons, timeBudgetMs, reasons } = options;
  if (!narrative || redFlags.length === 0) {
    return [];
  }

  const hits = new Set<string>();
  const normalizedNarrative = narrative.normalize('NFKC').toLowerCase();
  const tokenized = normalizeText(narrative);
  const normalizedTokens = tokenized.normalized;
  const startedAt = Date.now();
  let budgetExceeded = false;

  for (const rawFlag of redFlags) {
    if (Date.now() - startedAt > timeBudgetMs) {
      budgetExceeded = true;
      break;
    }
    if (typeof rawFlag !== 'string') continue;
    const trimmed = rawFlag.trim().toLowerCase();
    if (!trimmed) continue;
    const slug = toReasonSlug(trimmed);
    if (!slug || hits.has(slug)) continue;
    const normalizedFlag = trimmed.replace(/\s+/g, ' ');
    if (!normalizedNarrative.includes(trimmed) && !normalizedTokens.includes(normalizedFlag)) {
      continue;
    }
    hits.add(slug);
    if (reasons.size < maxReasons) {
      appendReason(reasons, 'red_flag', slug, maxReasons);
    }
    if (reasons.size >= maxReasons) {
      break;
    }
  }

  if (budgetExceeded) {
    appendReason(reasons, 'fallback', 'time_budget_hit', maxReasons);
  }

  return Array.from(hits);
}

export interface RulesFallbackOptions {
  config: ResolvedConfig;
  features: TriageFeatureVector;
  narrative?: string;
  cause?: string;
  redFlags?: readonly string[];
  baselineScore?: number;
}

export interface RulesFallbackResult {
  applied: boolean;
  score: number;
  reasons: string[];
  redFlagHits: string[];
  deltaExceeded: boolean;
}

export function computeRulesFallback(options: RulesFallbackOptions): RulesFallbackResult {
  const fallbackConfig = {
    ...DEFAULT_FALLBACK_CONFIG,
    ...(options.config.triageFallback ?? {}),
  };
  let score = computeTriageScore(options.config, options.features);

  if (!fallbackConfig.enabled) {
    return {
      applied: false,
      score,
      reasons: [],
      redFlagHits: [],
      deltaExceeded: false,
    };
  }

  const reasons = new Set<string>();
  if (options.cause) {
    appendReason(reasons, 'fallback', options.cause, fallbackConfig.maxReasons);
  }

  const redFlagHits = collectRedFlagReasons({
    narrative: options.narrative,
    redFlags: options.redFlags ?? options.config.red_flag_set ?? [],
    maxReasons: fallbackConfig.maxReasons,
    timeBudgetMs: fallbackConfig.timeBudgetMs,
    reasons,
  });

  if (redFlagHits.length > 0) {
    const thresholds = resolvePriorityThresholds(options.config);
    score = Math.max(score, thresholds.STAT);
  }

  let deltaExceeded = false;
  if (typeof options.baselineScore === 'number' && Number.isFinite(options.baselineScore)) {
    const delta = Math.abs(score - options.baselineScore);
    if (delta > fallbackConfig.scoreDeltaTolerance) {
      deltaExceeded = true;
      appendReason(reasons, 'fallback', 'delta_exceeded', fallbackConfig.maxReasons);
    }
  }

  const reasonList = Array.from(reasons).slice(0, fallbackConfig.maxReasons);
  return {
    applied: reasonList.length > 0 || redFlagHits.length > 0,
    score,
    reasons: reasonList,
    redFlagHits,
    deltaExceeded,
  };
}

export { SCORE_COMPONENTS, extractWeights as getScoreWeights, extractCalibration as getScoreCalibration };
