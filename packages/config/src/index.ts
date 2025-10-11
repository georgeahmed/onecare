import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parse as parseYaml } from 'yaml';

export interface CoreHours { start: string; end: string }

export interface SafetyGateConfig {
  red_flag_threshold?: number;
  emergency_confidence?: number;
  acuity_threshold_emergency?: number;
  timeout_ms?: number;
  fallback?: 'rules' | 'none';
  [key: string]: unknown;
}

export interface IdempotencyConfig {
  ttlSeconds: number;
}

export interface ResolvedConfig {
  practiceId: string;
  core_hours?: CoreHours;
  safety_gate?: SafetyGateConfig;
  idempotency?: IdempotencyConfig;
  [key: string]: unknown;
}

export interface LoadConfigOptions {
  /**
   * Overrides applied after defaults and before safety floors/ceilings are enforced.
   */
  overrides?: Partial<ResolvedConfig>;
  /**
   * Optional config root (defaults to <repo>/config). Handy for tests.
   */
  configRoot?: string;
}

interface StrategyMap { [path: string]: MergeStrategy }

interface LayerMeta {
  arrayMerge?: Record<string, MergeStrategy>;
  pcn?: string;
  ics?: string;
}

interface ConfigLayer {
  source: string;
  data: Record<string, unknown>;
  meta: LayerMeta;
}

type MergeStrategy = 'additive' | 'replace';

const DEFAULT_CONFIG_FILENAME = 'nhs_gp_defaults.yaml';
const GLOBAL_CONFIG_FILENAME = 'global.yaml';
const PRACTICES_DIR = 'practices';
const PCN_DIR = 'pcn';
const ICS_DIR = 'ics';
const METADATA_KEY = '__meta';
const ARRAY_MERGE_KEY = 'arrayMerge';

const SAFETY_GATE_TIMEOUT_DEFAULT = 800;
const SAFETY_GATE_TIMEOUT_MIN = 400;
const SAFETY_GATE_TIMEOUT_MAX = 2_000;
const SAFETY_GATE_RED_FLAG_DEFAULT = 0.65;
const SAFETY_GATE_RED_FLAG_MIN = 0.5;
const SAFETY_GATE_RED_FLAG_MAX = 0.9;
const SAFETY_GATE_EMERGENCY_DEFAULT = 0.7;
const SAFETY_GATE_EMERGENCY_MIN = 0.6;
const SAFETY_GATE_EMERGENCY_MAX = 0.95;
const SAFETY_GATE_ACUITY_EMERGENCY_DEFAULT = 0.75;
const SAFETY_GATE_ACUITY_EMERGENCY_MIN = 0.6;
const SAFETY_GATE_ACUITY_EMERGENCY_MAX = 0.97;
const SAFETY_GATE_FALLBACK_DEFAULT: SafetyGateConfig['fallback'] = 'rules';

const IDEMPOTENCY_TTL_DEFAULT = 600;
const IDEMPOTENCY_TTL_MIN = 30;
const IDEMPOTENCY_TTL_MAX = 86_400;

export interface MergeConfigOptions {
  arrayStrategies?: StrategyMap;
}

export function mergeConfig<T extends Record<string, unknown>>(
  base: T,
  override: Partial<T>,
  options?: MergeConfigOptions,
): T {
  const strategies = options?.arrayStrategies ?? {};
  const baseRecord = isPlainObject(base) ? base : {};
  const overrideRecord = isPlainObject(override) ? override : {};
  return mergeRecords(baseRecord, overrideRecord, strategies, '') as T;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === null || proto === Object.prototype;
}

function cloneValue<T>(value: T): T {
  if (Array.isArray(value)) {
    return (value as unknown[]).map((item) => cloneValue(item)) as unknown as T;
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = cloneValue(v);
    }
    return out as unknown as T;
  }
  return value;
}

function resolveConfigRoot(root?: string): string {
  if (root) return root;
  if (process.env.CONFIG_ROOT && process.env.CONFIG_ROOT.trim().length > 0) {
    return process.env.CONFIG_ROOT.trim();
  }
  return join(process.cwd(), 'config');
}

function readYamlConfig(filePath: string): Record<string, unknown> {
  const raw = readFileSync(filePath, 'utf8');
  if (!raw.trim()) {
    return {};
  }
  const data = parseYaml(raw);
  if (!isPlainObject(data)) {
    return {};
  }
  return data;
}

function parseLayerMeta(meta: unknown): LayerMeta {
  if (!isPlainObject(meta)) return {};
  const layerMeta: LayerMeta = {};

  if (typeof meta.pcn === 'string' && meta.pcn.trim().length > 0) {
    layerMeta.pcn = meta.pcn.trim();
  }
  if (typeof meta.ics === 'string' && meta.ics.trim().length > 0) {
    layerMeta.ics = meta.ics.trim();
  }

  const rawStrategies = meta[ARRAY_MERGE_KEY];
  if (isPlainObject(rawStrategies)) {
    const normalised: Record<string, MergeStrategy> = {};
    for (const [path, raw] of Object.entries(rawStrategies)) {
      if (raw === 'additive' || raw === true) {
        normalised[path] = 'additive';
      } else if (raw === 'replace' || raw === false) {
        normalised[path] = 'replace';
      }
    }
    if (Object.keys(normalised).length > 0) {
      layerMeta.arrayMerge = normalised;
    }
  }

  return layerMeta;
}

function loadLayer(filePath: string): ConfigLayer | undefined {
  if (!filePath || !existsSync(filePath)) {
    return undefined;
  }
  const fileData = readYamlConfig(filePath);
  const metaRaw = fileData[METADATA_KEY];
  const data: Record<string, unknown> = { ...fileData };
  delete data[METADATA_KEY];
  return { source: filePath, data, meta: parseLayerMeta(metaRaw) };
}

function identifierSegments(identifier: string): string[] {
  if (typeof identifier !== 'string') {
    throw new Error('identifier_must_be_string');
  }
  const trimmed = identifier.trim();
  if (!trimmed) {
    throw new Error('identifier_empty');
  }
  if (trimmed.startsWith('/') || trimmed.startsWith('\\')) {
    throw new Error('identifier_must_be_relative');
  }
  return trimmed
    .replace(/\\/g, '/')
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
    .map((segment) => {
      if (segment === '.' || segment === '..') {
        throw new Error('identifier_segment_invalid');
      }
      return segment;
    });
}

function buildLayerPath(root: string, category: string, identifier?: string): string | undefined {
  if (!identifier) return undefined;
  const segments = identifierSegments(identifier);
  const directories = segments.slice(0, -1);
  let fileName = segments[segments.length - 1];
  if (fileName.endsWith('.yaml')) {
    fileName = fileName.slice(0, -5);
  }
  if (!fileName) {
    throw new Error('identifier_filename_invalid');
  }
  return join(root, category, ...directories, `${fileName}.yaml`);
}

function updateArrayStrategies(target: StrategyMap, directives?: Record<string, MergeStrategy>): void {
  if (!directives) return;
  for (const [path, strategy] of Object.entries(directives)) {
    if (strategy === 'additive') {
      target[path] = 'additive';
    } else if (strategy === 'replace') {
      delete target[path];
    }
  }
}

function mergeRecords(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
  arrayStrategies: StrategyMap,
  path: string,
): Record<string, unknown> {
  const baseRecord = isPlainObject(base) ? base : {};
  const overrideRecord = isPlainObject(override) ? override : {};
  const result: Record<string, unknown> = { ...baseRecord };

  for (const [key, overrideValue] of Object.entries(overrideRecord)) {
    const currentPath = path ? `${path}.${key}` : key;
    const baseValue = result[key];

    if (Array.isArray(overrideValue)) {
      const strategy = arrayStrategies[currentPath];
      const overrideArray = cloneValue(overrideValue) as unknown[];
      if (strategy === 'additive' && Array.isArray(baseValue)) {
        const baseArray = cloneValue(baseValue) as unknown[];
        result[key] = [...baseArray, ...overrideArray];
      } else {
        result[key] = overrideArray;
      }
      continue;
    }

    if (isPlainObject(overrideValue)) {
      const baseObj = isPlainObject(baseValue) ? (baseValue as Record<string, unknown>) : {};
      result[key] = mergeRecords(baseObj, overrideValue, arrayStrategies, currentPath);
      continue;
    }

    result[key] = overrideValue;
  }

  return result;
}

function parseTtl(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const num = Number(value.trim());
    if (Number.isFinite(num)) return num;
  }
  return undefined;
}

function applySafetyGatePolicies(raw?: SafetyGateConfig): SafetyGateConfig {
  const working: SafetyGateConfig & Record<string, unknown> = { ...(raw ?? {}) };
  const timeout = typeof working.timeout_ms === 'number'
    ? clamp(working.timeout_ms, SAFETY_GATE_TIMEOUT_MIN, SAFETY_GATE_TIMEOUT_MAX)
    : SAFETY_GATE_TIMEOUT_DEFAULT;
  working.timeout_ms = timeout;

  const fallback = working.fallback === 'none' ? 'none' : SAFETY_GATE_FALLBACK_DEFAULT;
  working.fallback = fallback;

  const redFlag =
    typeof working.red_flag_threshold === 'number'
      ? clamp(working.red_flag_threshold, SAFETY_GATE_RED_FLAG_MIN, SAFETY_GATE_RED_FLAG_MAX)
      : SAFETY_GATE_RED_FLAG_DEFAULT;
  working.red_flag_threshold = redFlag;

  let emergency =
    typeof working.emergency_confidence === 'number'
      ? clamp(working.emergency_confidence, SAFETY_GATE_EMERGENCY_MIN, SAFETY_GATE_EMERGENCY_MAX)
      : SAFETY_GATE_EMERGENCY_DEFAULT;
  if (emergency < redFlag) {
    emergency = redFlag;
  }
  working.emergency_confidence = emergency;

  let acuity =
    typeof working.acuity_threshold_emergency === 'number'
      ? clamp(working.acuity_threshold_emergency, SAFETY_GATE_ACUITY_EMERGENCY_MIN, SAFETY_GATE_ACUITY_EMERGENCY_MAX)
      : SAFETY_GATE_ACUITY_EMERGENCY_DEFAULT;
  if (acuity < emergency) {
    acuity = emergency;
  }
  working.acuity_threshold_emergency = acuity;

  return working;
}

function applyIdempotencyConfig(raw: unknown): IdempotencyConfig {
  const envOverride = parseTtl(process.env.IDEMPOTENCY_TTL_SECONDS ?? process.env.IDEMPOTENCY_TTL_SEC);
  const source = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : undefined;
  const configValue = source ? parseTtl(source.ttlSeconds ?? source.ttl_seconds) : undefined;
  let ttl = envOverride ?? configValue ?? IDEMPOTENCY_TTL_DEFAULT;
  ttl = clamp(ttl, IDEMPOTENCY_TTL_MIN, IDEMPOTENCY_TTL_MAX);
  return { ttlSeconds: ttl };
}

function normalisePracticeId(practiceId: string): string {
  if (typeof practiceId !== 'string') {
    throw new Error('practice_id_invalid');
  }
  const trimmed = practiceId.trim();
  if (!trimmed) {
    throw new Error('practice_id_required');
  }
  return trimmed;
}

function normaliseIdentifier(value?: string): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function safeBuildLayerPath(root: string, category: string, identifier?: string, label?: string): string | undefined {
  if (!identifier) return undefined;
  try {
    return buildLayerPath(root, category, identifier);
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unknown';
    throw new Error(`${label ?? category}_identifier_invalid:${reason}`);
  }
}

export function loadConfig(practiceId: string, options?: LoadConfigOptions): ResolvedConfig {
  const trimmedPracticeId = normalisePracticeId(practiceId);
  const configRoot = resolveConfigRoot(options?.configRoot);

  const defaultsLayer = loadLayer(join(configRoot, DEFAULT_CONFIG_FILENAME));
  const globalLayer = loadLayer(join(configRoot, GLOBAL_CONFIG_FILENAME));

  const practicePath = safeBuildLayerPath(configRoot, PRACTICES_DIR, trimmedPracticeId, 'practice');
  const practiceLayer = practicePath ? loadLayer(practicePath) : undefined;

  let pcnId = normaliseIdentifier(practiceLayer?.meta.pcn);
  let icsId = normaliseIdentifier(practiceLayer?.meta.ics);

  let pcnLayer: ConfigLayer | undefined;
  if (pcnId) {
    const pcnPath = safeBuildLayerPath(configRoot, PCN_DIR, pcnId, 'pcn');
    pcnLayer = pcnPath ? loadLayer(pcnPath) : undefined;
    if (pcnLayer && !icsId) {
      icsId = normaliseIdentifier(pcnLayer.meta.ics);
    }
  }

  let icsLayer: ConfigLayer | undefined;
  if (icsId) {
    const icsPath = safeBuildLayerPath(configRoot, ICS_DIR, icsId, 'ics');
    icsLayer = icsPath ? loadLayer(icsPath) : undefined;
  }

  const orderedLayers: ConfigLayer[] = [];
  if (defaultsLayer) orderedLayers.push(defaultsLayer);
  if (globalLayer) orderedLayers.push(globalLayer);
  if (icsLayer) orderedLayers.push(icsLayer);
  if (pcnLayer) orderedLayers.push(pcnLayer);
  if (practiceLayer) orderedLayers.push(practiceLayer);

  const arrayStrategies: StrategyMap = {};
  const mergedSources: string[] = [];
  let mergedConfig: Record<string, unknown> = {};

  for (const layer of orderedLayers) {
    updateArrayStrategies(arrayStrategies, layer.meta.arrayMerge);
    mergedConfig = mergeRecords(mergedConfig, layer.data, arrayStrategies, '');
    mergedSources.push(layer.source);
  }

  if (options?.overrides) {
    mergedConfig = mergeRecords(
      mergedConfig,
      options.overrides as unknown as Record<string, unknown>,
      arrayStrategies,
      '',
    );
  }

  const resolved: ResolvedConfig = { ...(mergedConfig as ResolvedConfig), practiceId: trimmedPracticeId };
  resolved.safety_gate = applySafetyGatePolicies(resolved.safety_gate as SafetyGateConfig | undefined);

  const idempotencyRaw = (mergedConfig as Record<string, unknown>).idempotency;
  resolved.idempotency = applyIdempotencyConfig(idempotencyRaw ?? resolved.idempotency);

  if (pcnId || icsId || mergedSources.length > 0) {
    const lineage: Record<string, unknown> = {};
    if (icsId) lineage.ics = icsId;
    if (pcnId) lineage.pcn = pcnId;
    if (mergedSources.length > 0) {
      lineage.sources = mergedSources.map((src) => {
        try {
          return relative(configRoot, src);
        } catch {
          return src;
        }
      });
    }
    resolved._lineage = lineage;
  }

  return resolved;
}
