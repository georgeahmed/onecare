import type { ResolvedConfig } from '@onecare/config';
import { SCORE_COMPONENTS, type TriageFeatureVector } from './scoring';

type ScoreComponent = (typeof SCORE_COMPONENTS)[number];

interface NormalizationRule {
  min?: number;
  max?: number;
  default?: number;
}

type NormalizationConfig = Partial<Record<ScoreComponent, NormalizationRule>>;

interface TriageNormalizationConfig {
  features?: NormalizationConfig;
}

const DEFAULT_RULE: Required<NormalizationRule> = Object.freeze({
  min: 0,
  max: 1,
  default: 0,
});

const COMPONENT_ALIASES: Record<string, ScoreComponent> = {
  acuity: 'acuity',
  risk: 'risk',
  complexity: 'complexity',
  time: 'time',
  timePressure: 'time',
  capacity: 'capacity',
  capacityPressure: 'capacity',
};

function coerceNumber(value: unknown): number | undefined {
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

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function normalizeValue(value: unknown, rule: NormalizationRule | undefined): number {
  const effectiveRule = rule ?? DEFAULT_RULE;
  const min = Number.isFinite(effectiveRule.min) ? (effectiveRule.min as number) : DEFAULT_RULE.min;
  const max =
    Number.isFinite(effectiveRule.max) && (effectiveRule.max as number) > min
      ? (effectiveRule.max as number)
      : DEFAULT_RULE.max;
  const raw = coerceNumber(value);
  const base = raw ?? effectiveRule.default ?? DEFAULT_RULE.default;
  const clamped = clamp(base, min, max);
  if (max === min) {
    return max === 0 ? 0 : 1;
  }
  const normalised = (clamped - min) / (max - min);
  return clamp(normalised, 0, 1);
}

function readNormalizationConfig(config: ResolvedConfig): NormalizationConfig {
  const raw = (config.triage as { normalization?: TriageNormalizationConfig } | undefined)?.normalization;
  if (!raw || typeof raw !== 'object') {
    return {};
  }
  if (!raw.features || typeof raw.features !== 'object') {
    return {};
  }
  const rules: NormalizationConfig = {};
  for (const key of Object.keys(raw.features)) {
    const component = key as ScoreComponent;
    if (!SCORE_COMPONENTS.includes(component)) continue;
    const candidate = raw.features[component];
    if (!candidate || typeof candidate !== 'object') continue;
    const min = coerceNumber(candidate.min);
    const max = coerceNumber(candidate.max);
    const def = coerceNumber(candidate.default);
    rules[component] = {
      min: min ?? undefined,
      max: max ?? undefined,
      default: def ?? undefined,
    };
  }
  return rules;
}

function copyAdditionalFeatures(
  source: Record<string, unknown>,
  target: TriageFeatureVector,
  reservedKeys: Set<string>,
): void {
  for (const [key, value] of Object.entries(source)) {
    if (reservedKeys.has(key)) continue;
    const numericValue = coerceNumber(value);
    if (numericValue === undefined) {
      target[key] = undefined;
    } else {
      target[key] = numericValue;
    }
  }
}

export function extractFeatures(
  rawFeatures: Record<string, unknown> | null | undefined,
  config: ResolvedConfig,
): TriageFeatureVector {
  const features: TriageFeatureVector = {};
  const normalization = readNormalizationConfig(config);
  const entries = rawFeatures ?? {};

  for (const component of SCORE_COMPONENTS) {
    const rule = normalization[component];
    let sourceValue: unknown = entries[component];
    if (sourceValue === undefined) {
      // attempt alias fallback (e.g., timePressure -> time)
      for (const [alias, mapped] of Object.entries(COMPONENT_ALIASES)) {
        if (mapped === component && entries[alias] !== undefined) {
          sourceValue = entries[alias];
          break;
        }
      }
    }

    features[component] = normalizeValue(sourceValue, rule);
  }

  const reserved = new Set<string>([...SCORE_COMPONENTS, ...Object.keys(COMPONENT_ALIASES)]);
  copyAdditionalFeatures(entries, features, reserved);
  return features;
}

export function normalizeFeatures(features: TriageFeatureVector, config: ResolvedConfig): TriageFeatureVector {
  return extractFeatures(features, config);
}
