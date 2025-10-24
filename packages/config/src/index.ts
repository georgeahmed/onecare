import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parse as parseYaml } from 'yaml';

export interface CoreHours { start: string; end: string }

export interface SafetyGateShadowConfig {
  enabled: boolean;
  endpoint?: string;
  sampleRate: number;
  variant?: string;
  timeoutMs?: number;
  maxRetries?: number;
  baseDelayMs?: number;
  auditEvent: string;
}

export interface SafetyGateConfig {
  red_flag_threshold?: number;
  emergency_confidence?: number;
  acuity_threshold_emergency?: number;
  timeout_ms?: number;
  fallback?: 'rules' | 'none';
  shadow?: SafetyGateShadowConfig;
  [key: string]: unknown;
}

export interface IdempotencyConfig {
  ttlSeconds: number;
}

export interface TokenBucketRateLimitConfig {
  capacity: number;
  refillPerSecond: number;
  ttlSeconds: number;
  maxEntries: number;
}

export interface AccessGateRateLimitConfig {
  tenant: TokenBucketRateLimitConfig;
  account: TokenBucketRateLimitConfig;
}

export interface AccessGateConfig {
  rateLimit: AccessGateRateLimitConfig;
}

export interface CpcsRetryConfig {
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitterRatio?: number;
}

export interface CpcsCircuitBreakerConfig {
  failureThreshold?: number;
  cooldownMs?: number;
}

export interface CpcsSlotlessFallbackConfig {
  enabled?: boolean;
  auditReason?: string;
}

export interface BookingConfig {
  availabilityTimeoutMs: number;
}

export interface IcsTlsConfig {
  ca?: string;
  cert?: string;
  key?: string;
  rejectUnauthorized?: boolean;
}

export interface IcsRouteConfig {
  endpoint: string;
  apiKey?: string;
  authRef?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  retry?: CpcsRetryConfig;
  circuitBreaker?: CpcsCircuitBreakerConfig;
  correlationHeader?: string;
  tls?: IcsTlsConfig;
  rateLimitPerMinute?: number;
}

export interface IcsOrganisationPolicy {
  endpoint: string;
  authRef?: string;
  rateLimit?: number;
}

export type PharmacyPatientSex = 'male' | 'female' | 'other' | 'unknown';

export interface PharmacyEligibilityAgeRule {
  min?: number;
  max?: number;
}

export interface PharmacyEligibilitySeverityRule {
  allowed?: string[];
  blocked?: string[];
}

export interface PharmacyEligibilityRule {
  age?: PharmacyEligibilityAgeRule;
  sex?: PharmacyPatientSex[];
  severity?: PharmacyEligibilitySeverityRule;
  exclusions?: string[];
}

export interface PharmacyEligibilityRuleset {
  defaultRule?: PharmacyEligibilityRule;
  conditions?: Record<string, PharmacyEligibilityRule>;
}

export interface PharmacyConfig {
  eligibility?: PharmacyEligibilityRuleset;
}

export interface IcsConfig {
  routes: Record<string, IcsRouteConfig>;
  default?: IcsRouteConfig;
}

export interface BillingConfig {
  endpoint?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  retry?: CpcsRetryConfig;
  circuitBreaker?: CpcsCircuitBreakerConfig;
  correlationHeader?: string;
  tls?: IcsTlsConfig;
}

export interface CpcsConfig {
  endpoint?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  retry?: CpcsRetryConfig;
  circuitBreaker?: CpcsCircuitBreakerConfig;
  slotlessFallback?: CpcsSlotlessFallbackConfig;
  correlationHeader?: string;
}

export interface TriageFallbackConfig {
  enabled: boolean;
  timeBudgetMs: number;
  scoreDeltaTolerance: number;
  maxReasons: number;
}

export interface TelephonyAudioConfig {
  retention_days?: number;
  retention_seconds?: number;
  content_type?: string;
}

export interface TelephonyAsrConfig {
  endpoint?: string;
  timeout_ms?: number;
  max_retries?: number;
  base_delay_ms?: number;
  host_allowlist?: string[];
  cb_failure_threshold?: number;
  cb_cooldown_ms?: number;
  lang_detect?: boolean;
  diarization?: boolean;
}

export interface TelephonyCallbackWindow {
  code: string;
  label?: string;
}

export interface TelephonyRateLimitConfig {
  caller?: TokenBucketRateLimitConfig;
  practice?: TokenBucketRateLimitConfig;
}

export interface TelephonyConcurrencyConfig {
  max_concurrent_transcriptions?: number;
}

export interface TelephonyConfig {
  ivr_intent_classifier?: string;
  max_callback_retries?: number;
  emergency_transfer_enabled?: boolean;
  audio?: TelephonyAudioConfig;
  asr?: TelephonyAsrConfig;
  callback_windows_by_priority?: Record<string, TelephonyCallbackWindow[]>;
  rate_limit?: TelephonyRateLimitConfig;
  concurrency?: TelephonyConcurrencyConfig;
  [key: string]: unknown;
}

export interface ResolvedConfig {
  practiceId: string;
  core_hours?: CoreHours;
  safety_gate?: SafetyGateConfig;
  idempotency?: IdempotencyConfig;
  booking?: BookingConfig;
  cpcs?: CpcsConfig;
  ics?: IcsConfig;
  billing?: BillingConfig;
  pharmacy?: PharmacyConfig;
  triage?: Record<string, unknown>;
  red_flag_set?: string[];
  red_flag_source?: string;
  triageFallback?: TriageFallbackConfig;
  access_gate?: AccessGateConfig;
  telephony?: TelephonyConfig;
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
const RED_FLAGS_DIR = 'red_flags';
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
const DEFAULT_RED_FLAG_SOURCE = 'core';

const TRIAGE_FALLBACK_ENABLED_DEFAULT = true;
const TRIAGE_FALLBACK_TIME_BUDGET_MS_DEFAULT = 120;
const TRIAGE_FALLBACK_TIME_BUDGET_MS_MIN = 20;
const TRIAGE_FALLBACK_TIME_BUDGET_MS_MAX = 1_000;
const TRIAGE_FALLBACK_SCORE_DELTA_DEFAULT = 0.15;
const TRIAGE_FALLBACK_SCORE_DELTA_MIN = 0.01;
const TRIAGE_FALLBACK_SCORE_DELTA_MAX = 0.5;
const TRIAGE_FALLBACK_MAX_REASONS_DEFAULT = 5;
const TRIAGE_FALLBACK_MAX_REASONS_MIN = 1;
const TRIAGE_FALLBACK_MAX_REASONS_MAX = 10;

const IDEMPOTENCY_TTL_DEFAULT = 600;
const IDEMPOTENCY_TTL_MIN = 30;
const IDEMPOTENCY_TTL_MAX = 86_400;

const BOOKING_AVAILABILITY_TIMEOUT_DEFAULT = 2_000;
const BOOKING_AVAILABILITY_TIMEOUT_MIN = 200;
const BOOKING_AVAILABILITY_TIMEOUT_MAX = 10_000;

const ACCESS_GATE_TENANT_CAPACITY_DEFAULT = 120;
const ACCESS_GATE_TENANT_CAPACITY_MIN = 10;
const ACCESS_GATE_TENANT_CAPACITY_MAX = 10_000;
const ACCESS_GATE_TENANT_REFILL_DEFAULT = 2;
const ACCESS_GATE_TENANT_REFILL_MIN = 0.1;
const ACCESS_GATE_TENANT_REFILL_MAX = 1_000;
const ACCESS_GATE_TENANT_TTL_DEFAULT = 600;
const ACCESS_GATE_TENANT_TTL_MIN = 60;
const ACCESS_GATE_TENANT_TTL_MAX = 3_600;
const ACCESS_GATE_TENANT_MAX_ENTRIES_DEFAULT = 2_000;
const ACCESS_GATE_TENANT_MAX_ENTRIES_MIN = 10;
const ACCESS_GATE_TENANT_MAX_ENTRIES_MAX = 200_000;

const ACCESS_GATE_ACCOUNT_CAPACITY_DEFAULT = 12;
const ACCESS_GATE_ACCOUNT_CAPACITY_MIN = 1;
const ACCESS_GATE_ACCOUNT_CAPACITY_MAX = 2_000;
const ACCESS_GATE_ACCOUNT_REFILL_DEFAULT = 0.3;
const ACCESS_GATE_ACCOUNT_REFILL_MIN = 0.05;
const ACCESS_GATE_ACCOUNT_REFILL_MAX = 200;
const ACCESS_GATE_ACCOUNT_TTL_DEFAULT = 600;
const ACCESS_GATE_ACCOUNT_TTL_MIN = 60;
const ACCESS_GATE_ACCOUNT_TTL_MAX = 3_600;
const ACCESS_GATE_ACCOUNT_MAX_ENTRIES_DEFAULT = 10_000;
const ACCESS_GATE_ACCOUNT_MAX_ENTRIES_MIN = 100;
const ACCESS_GATE_ACCOUNT_MAX_ENTRIES_MAX = 500_000;

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

function applySafetyGateShadowConfig(raw: unknown): SafetyGateShadowConfig | undefined {
  const source = isPlainObject(raw) ? (raw as Record<string, unknown>) : undefined;

  const envEnabled = parseBooleanish(
    process.env.SAFETY_GATE_SHADOW_ENABLED ?? process.env.SAFETY_GATE_SHADOW ?? process.env.SHADOW_MODE,
  );
  const configEnabled = parseBooleanish(source?.enabled ?? source?.mode);
  const enabled = envEnabled ?? configEnabled ?? false;

  const sampleRateCandidate = parseNumberish(
    process.env.SAFETY_GATE_SHADOW_SAMPLE_RATE ??
      process.env.SAFETY_GATE_SHADOW_FRACTION ??
      process.env.SAFETY_GATE_SHADOW_PERCENT ??
      source?.sampleRate ??
      source?.sample_rate ??
      source?.fraction ??
      source?.traffic_fraction,
  );
  const normalisedSampleRate = sampleRateCandidate !== undefined ? clamp(sampleRateCandidate, 0, 1) : undefined;

  const endpoint = pickString(
    process.env.PY_SAFETY_GATE_SHADOW_URL,
    source?.endpoint,
    source?.url,
    source?.baseUrl,
    source?.base_url,
  );

  const variant = pickString(
    process.env.SAFETY_GATE_SHADOW_VARIANT,
    source?.variant,
    source?.modelVariant,
    source?.model_variant,
  );

  const timeoutCandidate = parseNumberish(
    process.env.SAFETY_GATE_SHADOW_TIMEOUT_MS ?? source?.timeoutMs ?? source?.timeout_ms ?? source?.timeout,
  );
  const timeoutMs =
    timeoutCandidate !== undefined ? clamp(timeoutCandidate, SAFETY_GATE_TIMEOUT_MIN, SAFETY_GATE_TIMEOUT_MAX) : undefined;

  const maxRetriesCandidate = parseNumberish(
    process.env.SAFETY_GATE_SHADOW_MAX_RETRIES ?? source?.maxRetries ?? source?.max_retries,
  );
  const maxRetries =
    maxRetriesCandidate !== undefined ? Math.max(0, Math.min(Math.round(maxRetriesCandidate), 3)) : undefined;

  const baseDelayCandidate = parseNumberish(
    process.env.SAFETY_GATE_SHADOW_BASE_DELAY_MS ?? source?.baseDelayMs ?? source?.base_delay_ms,
  );
  const baseDelayMs = baseDelayCandidate !== undefined ? Math.max(0, Math.min(baseDelayCandidate, 2_000)) : undefined;

  const auditEvent =
    pickString(source?.auditEvent, source?.audit_event, process.env.SAFETY_GATE_SHADOW_AUDIT_EVENT) ??
    'orchestrator.safety.shadow';

  const activeSampleRate = normalisedSampleRate ?? (enabled ? 1 : 0);

  if (!enabled || activeSampleRate <= 0) {
    return undefined;
  }

  const shadow: SafetyGateShadowConfig = {
    enabled: true,
    endpoint,
    sampleRate: clamp(activeSampleRate, 0, 1),
    variant,
    timeoutMs,
    maxRetries,
    baseDelayMs,
    auditEvent,
  };

  return shadow;
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

  const shadow = applySafetyGateShadowConfig(working.shadow);
  if (shadow) {
    working.shadow = shadow;
  } else {
    delete working.shadow;
  }

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

function applyBookingConfig(raw: unknown): BookingConfig {
  const source = isPlainObject(raw) ? (raw as Record<string, unknown>) : undefined;
  const envOverride = parseNumberish(process.env.BOOKING_AVAILABILITY_TIMEOUT_MS);
  const configValue = parseNumberish(
    source?.availabilityTimeoutMs ?? source?.availability_timeout_ms
  );
  let timeout = envOverride ?? configValue ?? BOOKING_AVAILABILITY_TIMEOUT_DEFAULT;
  timeout = clamp(timeout, BOOKING_AVAILABILITY_TIMEOUT_MIN, BOOKING_AVAILABILITY_TIMEOUT_MAX);
  return { availabilityTimeoutMs: timeout };
}

interface TokenBucketBounds {
  capacityMin: number;
  capacityMax: number;
  refillMin: number;
  refillMax: number;
  ttlMin: number;
  ttlMax: number;
  maxEntriesMin: number;
  maxEntriesMax: number;
}

function applyTokenBucketConfig(
  raw: unknown,
  defaults: TokenBucketRateLimitConfig,
  bounds: TokenBucketBounds,
): TokenBucketRateLimitConfig {
  const source = isPlainObject(raw) ? (raw as Record<string, unknown>) : undefined;

  const capacityCandidate = parseNumberish(
    readRecordValue(source, 'capacity') ??
      readRecordValue(source, 'burst') ??
      readRecordValue(source, 'maxTokens') ??
      readRecordValue(source, 'max_tokens'),
  );
  let capacity =
    capacityCandidate !== undefined && Number.isFinite(capacityCandidate)
      ? Number(capacityCandidate)
      : defaults.capacity;
  if (!Number.isFinite(capacity)) capacity = defaults.capacity;
  capacity = clamp(capacity, bounds.capacityMin, bounds.capacityMax);
  capacity = Math.max(bounds.capacityMin, Math.floor(capacity));

  const refillCandidate = parseNumberish(
    readRecordValue(source, 'refillPerSecond') ??
      readRecordValue(source, 'refill_per_second') ??
      readRecordValue(source, 'tokensPerSecond') ??
      readRecordValue(source, 'tokens_per_second') ??
      readRecordValue(source, 'ratePerSecond') ??
      readRecordValue(source, 'rate_per_second') ??
      readRecordValue(source, 'rate'),
  );
  let refill =
    refillCandidate !== undefined && Number.isFinite(refillCandidate)
      ? Number(refillCandidate)
      : defaults.refillPerSecond;
  if (!Number.isFinite(refill)) refill = defaults.refillPerSecond;
  refill = clamp(refill, bounds.refillMin, bounds.refillMax);

  const ttlCandidate = parseNumberish(
    readRecordValue(source, 'ttlSeconds') ?? readRecordValue(source, 'ttl_seconds') ?? readRecordValue(source, 'ttl'),
  );
  let ttl =
    ttlCandidate !== undefined && Number.isFinite(ttlCandidate) ? Number(ttlCandidate) : defaults.ttlSeconds;
  if (!Number.isFinite(ttl)) ttl = defaults.ttlSeconds;
  ttl = clamp(ttl, bounds.ttlMin, bounds.ttlMax);
  ttl = Math.max(bounds.ttlMin, Math.round(ttl));

  const maxEntriesCandidate = parseNumberish(
    readRecordValue(source, 'maxEntries') ??
      readRecordValue(source, 'max_entries') ??
      readRecordValue(source, 'cacheSize') ??
      readRecordValue(source, 'cache_size'),
  );
  let maxEntries =
    maxEntriesCandidate !== undefined && Number.isFinite(maxEntriesCandidate)
      ? Number(maxEntriesCandidate)
      : defaults.maxEntries;
  if (!Number.isFinite(maxEntries)) maxEntries = defaults.maxEntries;
  maxEntries = clamp(maxEntries, bounds.maxEntriesMin, bounds.maxEntriesMax);
  maxEntries = Math.max(bounds.maxEntriesMin, Math.round(maxEntries));

  return {
    capacity,
    refillPerSecond: refill,
    ttlSeconds: ttl,
    maxEntries,
  };
}

function applyAccessGateConfig(raw: unknown): AccessGateConfig {
  const source = isPlainObject(raw) ? (raw as Record<string, unknown>) : undefined;
  const rateLimitSource: Record<string, unknown> =
    (isPlainObject(source?.rateLimit) ? (source?.rateLimit as Record<string, unknown>) : undefined) ??
    (isPlainObject(source?.rate_limit) ? (source?.rate_limit as Record<string, unknown>) : undefined) ??
    (source ?? {});

  const tenantDefaults: TokenBucketRateLimitConfig = {
    capacity: ACCESS_GATE_TENANT_CAPACITY_DEFAULT,
    refillPerSecond: ACCESS_GATE_TENANT_REFILL_DEFAULT,
    ttlSeconds: ACCESS_GATE_TENANT_TTL_DEFAULT,
    maxEntries: ACCESS_GATE_TENANT_MAX_ENTRIES_DEFAULT,
  };
  const accountDefaults: TokenBucketRateLimitConfig = {
    capacity: ACCESS_GATE_ACCOUNT_CAPACITY_DEFAULT,
    refillPerSecond: ACCESS_GATE_ACCOUNT_REFILL_DEFAULT,
    ttlSeconds: ACCESS_GATE_ACCOUNT_TTL_DEFAULT,
    maxEntries: ACCESS_GATE_ACCOUNT_MAX_ENTRIES_DEFAULT,
  };

  const tenant = applyTokenBucketConfig(
    readRecordValue(rateLimitSource, 'tenant'),
    tenantDefaults,
    {
      capacityMin: ACCESS_GATE_TENANT_CAPACITY_MIN,
      capacityMax: ACCESS_GATE_TENANT_CAPACITY_MAX,
      refillMin: ACCESS_GATE_TENANT_REFILL_MIN,
      refillMax: ACCESS_GATE_TENANT_REFILL_MAX,
      ttlMin: ACCESS_GATE_TENANT_TTL_MIN,
      ttlMax: ACCESS_GATE_TENANT_TTL_MAX,
      maxEntriesMin: ACCESS_GATE_TENANT_MAX_ENTRIES_MIN,
      maxEntriesMax: ACCESS_GATE_TENANT_MAX_ENTRIES_MAX,
    },
  );

  const account = applyTokenBucketConfig(
    readRecordValue(rateLimitSource, 'account'),
    accountDefaults,
    {
      capacityMin: ACCESS_GATE_ACCOUNT_CAPACITY_MIN,
      capacityMax: ACCESS_GATE_ACCOUNT_CAPACITY_MAX,
      refillMin: ACCESS_GATE_ACCOUNT_REFILL_MIN,
      refillMax: ACCESS_GATE_ACCOUNT_REFILL_MAX,
      ttlMin: ACCESS_GATE_ACCOUNT_TTL_MIN,
      ttlMax: ACCESS_GATE_ACCOUNT_TTL_MAX,
      maxEntriesMin: ACCESS_GATE_ACCOUNT_MAX_ENTRIES_MIN,
      maxEntriesMax: ACCESS_GATE_ACCOUNT_MAX_ENTRIES_MAX,
    },
  );

  return {
    rateLimit: {
      tenant,
      account,
    },
  };
}

function parseHeadersRecord(raw: unknown): Record<string, string> {
  if (!isPlainObject(raw)) return {};
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string' && value.trim().length > 0) {
      headers[key] = value;
    }
  }
  return headers;
}

function parseEnvHeaderOverrides(prefix = 'CPCS'): Record<string, string> {
  const headers: Record<string, string> = {};
  const name = process.env[`${prefix}_HEADER_NAME`]?.trim();
  const value = process.env[`${prefix}_HEADER_VALUE`]?.trim();
  if (name && value) {
    headers[name] = value;
  }
  const extra = process.env[`${prefix}_EXTRA_HEADERS`];
  if (extra) {
    try {
      const parsed = JSON.parse(extra) as Record<string, unknown>;
      for (const [key, candidate] of Object.entries(parsed)) {
        if (typeof candidate === 'string' && candidate.trim().length > 0) {
          headers[key] = candidate;
        }
      }
    } catch {
      // ignore invalid overrides to avoid leaking secrets in logs
    }
  }
  return headers;
}

function pickString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed.length > 0) return trimmed;
    }
  }
  return undefined;
}

function parseNumberish(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function parseBooleanish(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (value === 1) return true;
    if (value === 0) return false;
  }
  if (typeof value === 'string') {
    const lowered = value.trim().toLowerCase();
    if (!lowered) return undefined;
    if (['true', '1', 'yes', 'y', 'on'].includes(lowered)) return true;
    if (['false', '0', 'no', 'n', 'off'].includes(lowered)) return false;
  }
  return undefined;
}

function parseStringArray(raw: unknown, options?: { lowercase?: boolean }): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  const values = Array.isArray(raw) ? raw : [raw];
  const collected: string[] = [];
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (!trimmed) continue;
    collected.push(options?.lowercase ? trimmed.toLowerCase() : trimmed);
  }
  if (collected.length === 0) return undefined;
  return Array.from(new Set(collected));
}

function normaliseSexValue(value: string): PharmacyPatientSex | undefined {
  const lowered = value.trim().toLowerCase();
  if (!lowered) return undefined;
  if (['male', 'm'].includes(lowered)) return 'male';
  if (['female', 'f'].includes(lowered)) return 'female';
  if (['other', 'o', 'non-binary', 'nonbinary'].includes(lowered)) return 'other';
  if (['unknown', 'u', 'unspecified'].includes(lowered)) return 'unknown';
  return undefined;
}

function parseSexArray(raw: unknown): PharmacyPatientSex[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  const values = Array.isArray(raw) ? raw : [raw];
  const out: PharmacyPatientSex[] = [];
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const normalised = normaliseSexValue(value);
    if (!normalised) continue;
    if (!out.includes(normalised)) {
      out.push(normalised);
    }
  }
  return out.length > 0 ? out : undefined;
}

function normaliseConditionKey(value: string): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.toLowerCase() : undefined;
}

function readRecordValue(source: Record<string, unknown> | undefined, key: string): unknown {
  return source ? source[key] : undefined;
}

function applyCpcsConfig(raw: unknown): CpcsConfig | undefined {
  const source = isPlainObject(raw) ? (raw as Record<string, unknown>) : undefined;
  const endpoint = pickString(
    source?.endpoint,
    source?.url,
    source?.base_url,
    process.env.CPCS_URL,
  );

  const apiKey = pickString(
    process.env.CPCS_API_KEY,
    source?.apiKey,
    source?.api_key,
    source?.token,
  );

  const headers = {
    ...parseHeadersRecord(source?.headers ?? source?.defaultHeaders),
    ...parseEnvHeaderOverrides(),
  };

  const timeoutMs = parseNumberish(
    process.env.CPCS_TIMEOUT_MS ?? source?.timeoutMs ?? source?.timeout_ms ?? source?.timeout,
  );

  const retrySource = isPlainObject(source?.retry)
    ? (source?.retry as Record<string, unknown>)
    : isPlainObject(source?.retry_policy)
      ? (source?.retry_policy as Record<string, unknown>)
      : undefined;
  const retry: CpcsRetryConfig = {};
  const retryAttempts = parseNumberish(
    readRecordValue(retrySource, 'attempts') ?? readRecordValue(retrySource, 'max_attempts'),
  );
  if (retryAttempts !== undefined) retry.attempts = Math.round(retryAttempts);
  const retryBaseDelay = parseNumberish(
    readRecordValue(retrySource, 'baseDelayMs') ?? readRecordValue(retrySource, 'base_delay_ms'),
  );
  if (retryBaseDelay !== undefined) retry.baseDelayMs = retryBaseDelay;
  const retryMaxDelay = parseNumberish(
    readRecordValue(retrySource, 'maxDelayMs') ?? readRecordValue(retrySource, 'max_delay_ms'),
  );
  if (retryMaxDelay !== undefined) retry.maxDelayMs = retryMaxDelay;
  const retryJitter = parseNumberish(
    readRecordValue(retrySource, 'jitterRatio') ?? readRecordValue(retrySource, 'jitter_ratio'),
  );
  if (retryJitter !== undefined) retry.jitterRatio = retryJitter;

  const circuitSource = isPlainObject(source?.circuitBreaker)
    ? (source?.circuitBreaker as Record<string, unknown>)
    : isPlainObject(source?.circuit_breaker)
      ? (source?.circuit_breaker as Record<string, unknown>)
      : undefined;
  const circuit: CpcsCircuitBreakerConfig = {};
  const failureThreshold = parseNumberish(
    readRecordValue(circuitSource, 'failureThreshold') ?? readRecordValue(circuitSource, 'failure_threshold'),
  );
  if (failureThreshold !== undefined) circuit.failureThreshold = Math.round(failureThreshold);
  const cooldownMs = parseNumberish(
    readRecordValue(circuitSource, 'cooldownMs') ?? readRecordValue(circuitSource, 'cooldown_ms'),
  );
  if (cooldownMs !== undefined) circuit.cooldownMs = cooldownMs;

  const fallbackSource = isPlainObject(source?.slotlessFallback)
    ? (source?.slotlessFallback as Record<string, unknown>)
    : isPlainObject(source?.slotless_fallback)
      ? (source?.slotless_fallback as Record<string, unknown>)
      : undefined;
  const fallback: CpcsSlotlessFallbackConfig = {};
  const fallbackEnabled = parseBooleanish(
    process.env.CPCS_SLOTLESS_FALLBACK_ENABLED ??
      process.env.CPCS_SLOTLESS_FALLBACK ??
      readRecordValue(fallbackSource, 'enabled') ??
      readRecordValue(fallbackSource, 'enable'),
  );
  if (fallbackEnabled !== undefined) fallback.enabled = fallbackEnabled;
  const fallbackReason = pickString(
    readRecordValue(fallbackSource, 'auditReason'),
    readRecordValue(fallbackSource, 'audit_reason'),
  );
  if (fallbackReason) fallback.auditReason = fallbackReason;

  const correlationHeader = pickString(
    source?.correlationHeader,
    source?.correlation_header,
    process.env.CPCS_CORRELATION_HEADER,
  );

  const config: CpcsConfig = {};
  if (endpoint) config.endpoint = endpoint;
  if (apiKey) config.apiKey = apiKey;
  if (Object.keys(headers).length > 0) config.headers = headers;
  if (timeoutMs !== undefined) config.timeoutMs = timeoutMs;
  if (Object.values(retry).some((value) => value !== undefined)) config.retry = retry;
  if (Object.values(circuit).some((value) => value !== undefined)) config.circuitBreaker = circuit;
  if (Object.values(fallback).some((value) => value !== undefined)) config.slotlessFallback = fallback;
  if (correlationHeader) config.correlationHeader = correlationHeader;

  return Object.keys(config).length > 0 ? config : undefined;
}

function applyBillingConfig(raw: unknown): BillingConfig | undefined {
  const source = isPlainObject(raw) ? (raw as Record<string, unknown>) : undefined;
  const endpoint = pickString(
    readRecordValue(source, 'endpoint'),
    readRecordValue(source, 'url'),
    readRecordValue(source, 'base_url'),
    process.env.BILLING_ENDPOINT,
  );
  const apiKey = pickString(
    process.env.BILLING_API_KEY,
    process.env.BILLING_TOKEN,
    readRecordValue(source, 'apiKey'),
    readRecordValue(source, 'api_key'),
    readRecordValue(source, 'token'),
  );
  const headers = {
    ...parseHeadersRecord(source?.headers ?? source?.defaultHeaders),
    ...parseEnvHeaderOverrides('BILLING'),
  };
  const timeoutMs = parseNumberish(
    process.env.BILLING_TIMEOUT_MS ??
      readRecordValue(source, 'timeoutMs') ??
      readRecordValue(source, 'timeout_ms') ??
      readRecordValue(source, 'timeout'),
  );

  const retrySource = isPlainObject(source?.retry)
    ? (source?.retry as Record<string, unknown>)
    : isPlainObject(source?.retry_policy)
      ? (source?.retry_policy as Record<string, unknown>)
      : undefined;
  const retry: CpcsRetryConfig = {};
  const retryAttempts = parseNumberish(
    readRecordValue(retrySource, 'attempts') ?? readRecordValue(retrySource, 'max_attempts'),
  );
  if (retryAttempts !== undefined) retry.attempts = Math.round(retryAttempts);
  const retryBase = parseNumberish(
    readRecordValue(retrySource, 'baseDelayMs') ?? readRecordValue(retrySource, 'base_delay_ms'),
  );
  if (retryBase !== undefined) retry.baseDelayMs = retryBase;
  const retryMax = parseNumberish(
    readRecordValue(retrySource, 'maxDelayMs') ?? readRecordValue(retrySource, 'max_delay_ms'),
  );
  if (retryMax !== undefined) retry.maxDelayMs = retryMax;
  const retryJitter = parseNumberish(
    readRecordValue(retrySource, 'jitterRatio') ?? readRecordValue(retrySource, 'jitter_ratio'),
  );
  if (retryJitter !== undefined) retry.jitterRatio = retryJitter;

  const circuitSource = isPlainObject(source?.circuitBreaker)
    ? (source?.circuitBreaker as Record<string, unknown>)
    : isPlainObject(source?.circuit_breaker)
      ? (source?.circuit_breaker as Record<string, unknown>)
      : undefined;
  const circuit: CpcsCircuitBreakerConfig = {};
  const failures = parseNumberish(
    readRecordValue(circuitSource, 'failureThreshold') ?? readRecordValue(circuitSource, 'failure_threshold'),
  );
  if (failures !== undefined) circuit.failureThreshold = Math.round(failures);
  const cooldown = parseNumberish(
    readRecordValue(circuitSource, 'cooldownMs') ?? readRecordValue(circuitSource, 'cooldown_ms'),
  );
  if (cooldown !== undefined) circuit.cooldownMs = cooldown;

  const correlationHeader = pickString(
    readRecordValue(source, 'correlationHeader'),
    readRecordValue(source, 'correlation_header'),
    process.env.BILLING_CORRELATION_HEADER,
  );

  const tls = parseTlsConfig(source?.tls, 'BILLING');

  const config: BillingConfig = {};
  if (endpoint) config.endpoint = endpoint;
  if (apiKey) config.apiKey = apiKey;
  if (Object.keys(headers).length > 0) config.headers = headers;
  if (timeoutMs !== undefined) config.timeoutMs = timeoutMs;
  if (Object.values(retry).some((value) => value !== undefined)) config.retry = retry;
  if (Object.values(circuit).some((value) => value !== undefined)) config.circuitBreaker = circuit;
  if (correlationHeader) config.correlationHeader = correlationHeader;
  if (tls) config.tls = tls;

  return Object.keys(config).length > 0 ? config : undefined;
}

function applyPharmacyConfig(raw: unknown): PharmacyConfig | undefined {
  const source = isPlainObject(raw) ? (raw as Record<string, unknown>) : undefined;
  if (!source) return undefined;
  const ruleset = parsePharmacyEligibilityRuleset(source.eligibility ?? source.rules);
  const config: PharmacyConfig = {};
  if (ruleset) config.eligibility = ruleset;
  return Object.keys(config).length > 0 ? config : undefined;
}

function applyTriageFallbackConfig(raw: unknown): TriageFallbackConfig {
  const source = isPlainObject(raw) ? (raw as Record<string, unknown>) : undefined;

  let enabled = TRIAGE_FALLBACK_ENABLED_DEFAULT;
  if (source && typeof source.enabled === 'boolean') {
    enabled = source.enabled;
  } else if (source && typeof source.mode === 'string') {
    enabled = source.mode.trim().toLowerCase() !== 'none';
  }

  const rawBudget =
    source && source.time_budget_ms !== undefined ? Number(source.time_budget_ms) : Number(source?.timeBudgetMs);
  let timeBudget =
    rawBudget !== undefined && Number.isFinite(rawBudget) ? Number(rawBudget) : TRIAGE_FALLBACK_TIME_BUDGET_MS_DEFAULT;
  timeBudget = clamp(timeBudget, TRIAGE_FALLBACK_TIME_BUDGET_MS_MIN, TRIAGE_FALLBACK_TIME_BUDGET_MS_MAX);

  const rawDelta =
    source && source.score_delta_tolerance !== undefined
      ? Number(source.score_delta_tolerance)
      : Number(source?.scoreDeltaTolerance);
  let scoreDelta =
    rawDelta !== undefined && Number.isFinite(rawDelta) ? Number(rawDelta) : TRIAGE_FALLBACK_SCORE_DELTA_DEFAULT;
  scoreDelta = clamp(scoreDelta, TRIAGE_FALLBACK_SCORE_DELTA_MIN, TRIAGE_FALLBACK_SCORE_DELTA_MAX);

  const rawMaxReasons =
    source && source.max_reasons !== undefined
      ? Number(source.max_reasons)
      : Number(source?.maxReasons ?? source?.max_reason_count);
  let maxReasons =
    rawMaxReasons !== undefined && Number.isFinite(rawMaxReasons)
      ? Math.floor(Number(rawMaxReasons))
      : TRIAGE_FALLBACK_MAX_REASONS_DEFAULT;
  maxReasons = clamp(maxReasons, TRIAGE_FALLBACK_MAX_REASONS_MIN, TRIAGE_FALLBACK_MAX_REASONS_MAX);

  return {
    enabled,
    timeBudgetMs: timeBudget,
    scoreDeltaTolerance: scoreDelta,
    maxReasons,
  };
}

function parsePharmacyEligibilityRuleset(raw: unknown): PharmacyEligibilityRuleset | undefined {
  const source = isPlainObject(raw) ? (raw as Record<string, unknown>) : undefined;
  if (!source) return undefined;
  const defaultRule = parsePharmacyEligibilityRule(source.defaultRule ?? source.default);
  const conditionsSource = isPlainObject(source.conditions) ? (source.conditions as Record<string, unknown>) : undefined;
  const conditions: Record<string, PharmacyEligibilityRule> = {};
  if (conditionsSource) {
    for (const [name, value] of Object.entries(conditionsSource)) {
      const parsed = parsePharmacyEligibilityRule(value, defaultRule);
      if (!parsed) continue;
      const key = normaliseConditionKey(name);
      if (!key) continue;
      conditions[key] = parsed;
    }
  }
  if (!defaultRule && Object.keys(conditions).length === 0) {
    return undefined;
  }
  const ruleset: PharmacyEligibilityRuleset = {};
  if (defaultRule) ruleset.defaultRule = defaultRule;
  if (Object.keys(conditions).length > 0) ruleset.conditions = conditions;
  return ruleset;
}

function parsePharmacyEligibilityRule(
  raw: unknown,
  defaults?: PharmacyEligibilityRule,
): PharmacyEligibilityRule | undefined {
  const source = isPlainObject(raw) ? (raw as Record<string, unknown>) : undefined;
  if (!source && !defaults) return undefined;
  const rule: PharmacyEligibilityRule = {};

  const ageSource = isPlainObject(source?.age) ? (source?.age as Record<string, unknown>) : undefined;
  const minAge = parseNumberish(
    readRecordValue(ageSource, 'min') ??
      readRecordValue(ageSource, 'minAge') ??
      readRecordValue(source, 'minAge') ??
      defaults?.age?.min,
  );
  const maxAge = parseNumberish(
    readRecordValue(ageSource, 'max') ??
      readRecordValue(ageSource, 'maxAge') ??
      readRecordValue(source, 'maxAge') ??
      defaults?.age?.max,
  );
  if (minAge !== undefined || maxAge !== undefined) {
    rule.age = {};
    if (minAge !== undefined) rule.age.min = Math.max(0, Math.round(minAge));
    if (maxAge !== undefined) rule.age.max = Math.max(0, Math.round(maxAge));
  } else if (defaults?.age) {
    rule.age = { ...defaults.age };
  }

  const sexValues = readRecordValue(source, 'sex') ?? readRecordValue(source, 'sexes');
  const parsedSexes = parseSexArray(sexValues) ?? defaults?.sex;
  if (parsedSexes && parsedSexes.length > 0) {
    rule.sex = [...parsedSexes];
  }

  const severitySource = isPlainObject(source?.severity) ? (source?.severity as Record<string, unknown>) : undefined;
  const severityAllowed = parseStringArray(
    readRecordValue(severitySource, 'allowed') ?? readRecordValue(source, 'severityAllowed'),
    { lowercase: true },
  );
  const severityBlocked = parseStringArray(
    readRecordValue(severitySource, 'blocked') ?? readRecordValue(source, 'severityBlocked'),
    { lowercase: true },
  );
  const defaultSeverity = defaults?.severity;
  if (severityAllowed || severityBlocked || defaultSeverity) {
    rule.severity = {};
    if (severityAllowed) rule.severity.allowed = severityAllowed;
    else if (defaultSeverity?.allowed) rule.severity.allowed = [...defaultSeverity.allowed];
    if (severityBlocked) rule.severity.blocked = severityBlocked;
    else if (defaultSeverity?.blocked) rule.severity.blocked = [...defaultSeverity.blocked];
  }

  const overrideExclusions = parseStringArray(
    readRecordValue(source, 'exclusions') ?? readRecordValue(source, 'exclusionCodes'),
    { lowercase: true },
  );
  const baseExclusions = defaults?.exclusions ?? [];
  if ((overrideExclusions && overrideExclusions.length > 0) || baseExclusions.length > 0) {
    const combined = new Set<string>();
    for (const value of baseExclusions) combined.add(value);
    if (overrideExclusions) {
      for (const value of overrideExclusions) combined.add(value);
    }
    rule.exclusions = Array.from(combined);
  }

  if (
    !rule.age &&
    !rule.sex &&
    !rule.severity &&
    (!rule.exclusions || rule.exclusions.length === 0)
  ) {
    return defaults ? { ...defaults } : undefined;
  }
  return rule;
}

function parseTlsConfig(raw: unknown, envPrefix: string): IcsTlsConfig | undefined {
  const source = isPlainObject(raw) ? (raw as Record<string, unknown>) : undefined;
  const ca = pickString(source?.ca, process.env[`${envPrefix}_TLS_CA`]);
  const cert = pickString(source?.cert, process.env[`${envPrefix}_TLS_CERT`]);
  const key = pickString(source?.key, process.env[`${envPrefix}_TLS_KEY`]);
  const rejectUnauthorized = parseBooleanish(source?.rejectUnauthorized ?? process.env[`${envPrefix}_TLS_REJECT_UNAUTH`]);
  const tls: IcsTlsConfig = {};
  if (ca) tls.ca = ca;
  if (cert) tls.cert = cert;
  if (key) tls.key = key;
  if (rejectUnauthorized !== undefined) tls.rejectUnauthorized = rejectUnauthorized;
  return Object.keys(tls).length > 0 ? tls : undefined;
}

function parseIcsRoute(key: string, raw: unknown, defaults?: IcsRouteConfig): IcsRouteConfig | undefined {
  const source = isPlainObject(raw) ? (raw as Record<string, unknown>) : undefined;
  const endpoint = pickString(source?.endpoint, source?.url, source?.base_url, defaults?.endpoint);
  if (!endpoint) return undefined;
  const apiKey = pickString(source?.apiKey, source?.api_key, source?.token, defaults?.apiKey);
  const authRef = pickString(source?.authRef, source?.auth_ref, defaults?.authRef);
  const headers = {
    ...parseHeadersRecord(defaults?.headers),
    ...parseHeadersRecord(source?.headers ?? source?.defaultHeaders),
    ...parseEnvHeaderOverrides(`ICS_${key.toUpperCase()}`),
  };
  const timeoutMs = parseNumberish(
    readRecordValue(source, 'timeoutMs') ??
      readRecordValue(source, 'timeout_ms') ??
      readRecordValue(source, 'timeout') ??
      defaults?.timeoutMs,
  );

  const retrySource = isPlainObject(source?.retry)
    ? (source?.retry as Record<string, unknown>)
    : isPlainObject(source?.retry_policy)
      ? (source?.retry_policy as Record<string, unknown>)
      : undefined;
  const retry: CpcsRetryConfig = {};
  const retryAttempts = parseNumberish(
    readRecordValue(retrySource, 'attempts') ??
      readRecordValue(retrySource, 'max_attempts') ??
      defaults?.retry?.attempts,
  );
  if (retryAttempts !== undefined) retry.attempts = Math.round(retryAttempts);
  const retryBaseDelay = parseNumberish(
    readRecordValue(retrySource, 'baseDelayMs') ??
      readRecordValue(retrySource, 'base_delay_ms') ??
      defaults?.retry?.baseDelayMs,
  );
  if (retryBaseDelay !== undefined) retry.baseDelayMs = retryBaseDelay;
  const retryMaxDelay = parseNumberish(
    readRecordValue(retrySource, 'maxDelayMs') ??
      readRecordValue(retrySource, 'max_delay_ms') ??
      defaults?.retry?.maxDelayMs,
  );
  if (retryMaxDelay !== undefined) retry.maxDelayMs = retryMaxDelay;
  const retryJitter = parseNumberish(
    readRecordValue(retrySource, 'jitterRatio') ??
      readRecordValue(retrySource, 'jitter_ratio') ??
      defaults?.retry?.jitterRatio,
  );
  if (retryJitter !== undefined) retry.jitterRatio = retryJitter;

  const circuitSource = isPlainObject(source?.circuitBreaker)
    ? (source?.circuitBreaker as Record<string, unknown>)
    : isPlainObject(source?.circuit_breaker)
      ? (source?.circuit_breaker as Record<string, unknown>)
      : undefined;
  const circuit: CpcsCircuitBreakerConfig = {};
  const failureThreshold = parseNumberish(
    readRecordValue(circuitSource, 'failureThreshold') ??
      readRecordValue(circuitSource, 'failure_threshold') ??
      defaults?.circuitBreaker?.failureThreshold,
  );
  if (failureThreshold !== undefined) circuit.failureThreshold = Math.round(failureThreshold);
  const cooldownMs = parseNumberish(
    readRecordValue(circuitSource, 'cooldownMs') ??
      readRecordValue(circuitSource, 'cooldown_ms') ??
      defaults?.circuitBreaker?.cooldownMs,
  );
  if (cooldownMs !== undefined) circuit.cooldownMs = cooldownMs;
  const correlationHeader = pickString(
    readRecordValue(source, 'correlationHeader'),
    readRecordValue(source, 'correlation_header'),
    defaults?.correlationHeader,
  );
  const tls = parseTlsConfig(source?.tls, `ICS_${key.toUpperCase()}`) ?? defaults?.tls;
  const rateLimitPerMinute = parseNumberish(
    readRecordValue(source, 'rateLimitPerMinute') ?? readRecordValue(source, 'rate_limit_per_minute'),
  );
  const rateLimit = parseNumberish(
    readRecordValue(source, 'rateLimit') ?? readRecordValue(source, 'rate_limit'),
  );

  const route: IcsRouteConfig = {
    endpoint,
    apiKey: apiKey ?? undefined,
    authRef: authRef ?? undefined,
    headers: Object.keys(headers).length > 0 ? headers : undefined,
    timeoutMs: timeoutMs ?? defaults?.timeoutMs,
    retry: Object.values(retry).some((value) => value !== undefined) ? retry : defaults?.retry,
    circuitBreaker: Object.values(circuit).some((value) => value !== undefined) ? circuit : defaults?.circuitBreaker,
    correlationHeader,
    tls,
    rateLimitPerMinute: rateLimitPerMinute ?? rateLimit ?? defaults?.rateLimitPerMinute,
  };
  return route;
}

function applyIcsConfig(raw: unknown): IcsConfig | undefined {
  const source = isPlainObject(raw) ? (raw as Record<string, unknown>) : undefined;
  const routesSource = isPlainObject(source?.routes) ? (source?.routes as Record<string, unknown>) : undefined;
  const defaultSource = source?.default ?? source?.defaultRoute;
  const defaultRoute = parseIcsRoute('default', defaultSource);

  const envDefaultEndpoint = pickString(process.env.ICS_DEFAULT_ENDPOINT, process.env.ICS_ENDPOINT);
  const envDefaultApiKey = pickString(process.env.ICS_API_KEY, process.env.ICS_TOKEN);
  const envDefaultRoute = envDefaultEndpoint
    ? {
        endpoint: envDefaultEndpoint,
        apiKey: envDefaultApiKey,
        headers: parseEnvHeaderOverrides('ICS'),
        timeoutMs: parseNumberish(process.env.ICS_TIMEOUT_MS),
        correlationHeader: pickString(process.env.ICS_CORRELATION_HEADER),
        tls: parseTlsConfig(undefined, 'ICS'),
      }
    : undefined;

  const routes: Record<string, IcsRouteConfig> = {};
  if (routesSource) {
    for (const [org, value] of Object.entries(routesSource)) {
      const parsed = parseIcsRoute(org, value, defaultRoute ?? envDefaultRoute);
      if (parsed) {
        routes[org] = parsed;
      }
    }
  }

  const config: IcsConfig = {
    routes,
    default: defaultRoute ?? envDefaultRoute,
  };

  if (Object.keys(config.routes).length === 0 && !config.default) {
    return undefined;
  }
  return config;
}

export function getIcsOrganisationPolicies(config: ResolvedConfig): Record<string, IcsOrganisationPolicy> {
  const routes = config.ics?.routes ?? {};
  const policies: Record<string, IcsOrganisationPolicy> = {};
  for (const [org, route] of Object.entries(routes)) {
    if (!route?.endpoint) continue;
    policies[org] = {
      endpoint: route.endpoint,
      authRef: route.authRef ?? undefined,
      rateLimit: route.rateLimitPerMinute ?? undefined,
    };
  }
  return policies;
}

export function getPharmacyEligibilityRules(config: ResolvedConfig): PharmacyEligibilityRuleset | undefined {
  const ruleset = config.pharmacy?.eligibility;
  if (!ruleset) return undefined;
  const cloned: PharmacyEligibilityRuleset = {};
  if (ruleset.defaultRule) cloned.defaultRule = clonePharmacyRule(ruleset.defaultRule);
  if (ruleset.conditions) {
    const mapped: Record<string, PharmacyEligibilityRule> = {};
    for (const [key, rule] of Object.entries(ruleset.conditions)) {
      mapped[key] = clonePharmacyRule(rule);
    }
    cloned.conditions = mapped;
  }
  return cloned;
}

function clonePharmacyRule(rule: PharmacyEligibilityRule): PharmacyEligibilityRule {
  const cloned: PharmacyEligibilityRule = {};
  if (rule.age) {
    cloned.age = { ...rule.age };
  }
  if (rule.sex) {
    cloned.sex = [...rule.sex];
  }
  if (rule.severity) {
    cloned.severity = {
      allowed: rule.severity.allowed ? [...rule.severity.allowed] : undefined,
      blocked: rule.severity.blocked ? [...rule.severity.blocked] : undefined,
    };
  }
  if (rule.exclusions) {
    cloned.exclusions = [...rule.exclusions];
  }
  return cloned;
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

  const pcnId = normaliseIdentifier(practiceLayer?.meta.pcn);
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
  const cpcsRaw = (mergedConfig as Record<string, unknown>).cpcs ?? resolved.cpcs;
  resolved.cpcs = applyCpcsConfig(cpcsRaw);
  const icsRaw = (mergedConfig as Record<string, unknown>).ics ?? resolved.ics;
  resolved.ics = applyIcsConfig(icsRaw);
  const billingRaw = (mergedConfig as Record<string, unknown>).billing ?? resolved.billing;
  resolved.billing = applyBillingConfig(billingRaw);
  const bookingRaw = (mergedConfig as Record<string, unknown>).booking ?? resolved.booking;
  resolved.booking = applyBookingConfig(bookingRaw);
  const pharmacyRaw = (mergedConfig as Record<string, unknown>).pharmacy ?? resolved.pharmacy;
  resolved.pharmacy = applyPharmacyConfig(pharmacyRaw);
  const accessGateRaw = (mergedConfig as Record<string, unknown>).access_gate ?? resolved.access_gate;
  resolved.access_gate = applyAccessGateConfig(accessGateRaw);
  const triageRaw = (mergedConfig as Record<string, unknown>).triage;
  const triageSection =
    triageRaw && isPlainObject(triageRaw)
      ? { ...(triageRaw as Record<string, unknown>) }
      : resolved.triage && typeof resolved.triage === 'object'
        ? { ...(resolved.triage as Record<string, unknown>) }
        : {};
  const fallbackConfig = applyTriageFallbackConfig(triageSection.fallback);
  resolved.triageFallback = fallbackConfig;
  triageSection.fallback = fallbackConfig;
  resolved.triage = triageSection;

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

  resolveRedFlagSet(resolved, mergedConfig as Record<string, unknown>, configRoot);

  return resolved;
}

function resolveRedFlagSet(resolved: ResolvedConfig, mergedConfig: Record<string, unknown>, configRoot: string): void {
  const rawSource = (mergedConfig.red_flag_source ?? resolved.red_flag_source) as unknown;
  const sourceId = typeof rawSource === 'string' && rawSource.trim().length > 0 ? rawSource.trim() : DEFAULT_RED_FLAG_SOURCE;
  const base = loadRedFlagSource(configRoot, sourceId);

  const rawExtras = mergedConfig.red_flag_set;
  const extras = Array.isArray(rawExtras) ? toStringList(rawExtras) : [];
  const combined = dedupeStrings([...base, ...extras]);

  resolved.red_flag_source = sourceId;
  resolved.red_flag_set = combined;
}

function loadRedFlagSource(configRoot: string, sourceId: string): string[] {
  const filenameJson = join(configRoot, RED_FLAGS_DIR, `${sourceId}.json`);
  const filenameYaml = join(configRoot, RED_FLAGS_DIR, `${sourceId}.yaml`);
  if (existsSync(filenameJson)) {
    const raw = readFileSync(filenameJson, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      throw new Error(`red_flag_source_invalid:${sourceId}`);
    }
    return dedupeStrings(toStringList(parsed));
  }
  if (existsSync(filenameYaml)) {
    const parsed = parseYaml(readFileSync(filenameYaml, 'utf8'));
    if (!Array.isArray(parsed)) {
      throw new Error(`red_flag_source_invalid:${sourceId}`);
    }
    return dedupeStrings(toStringList(parsed));
  }
  throw new Error(`red_flag_source_missing:${sourceId}`);
}

function toStringList(values: Iterable<unknown>): string[] {
  const result: string[] = [];
  for (const value of values) {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed.length > 0) {
        result.push(trimmed.toLowerCase());
      }
    }
  }
  return result;
}

function dedupeStrings(values: Iterable<string>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const key = value.trim().toLowerCase();
    if (!key) continue;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(key);
    }
  }
  return result;
}
