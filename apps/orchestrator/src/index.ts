/// <reference path="./types/schemas.d.ts" />
import * as http from 'http';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID, createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { analyzePortalSubmission } from './adapters/services/safetyGate';
import { errorEnvelope, mapErrorToStatus, redact } from './application/error';
import { callWithGuard } from './adapters/services/callWithGuard';
import { validatePortalSubmission } from './application/validator';
import { getBus, getNatsBusHealth, markNatsBusConnected, parseNatsServerConfig, withMessageGuards } from '@onecare/bus';
import type { MessageBus } from '@onecare/bus';
import {
  createEnvelope,
  PortalSubmission,
  Topics,
  AuditEvent as ContractAuditEvent,
  type ClinicianTaskSummary,
  type ClinicianTaskDetail,
  type ResolveRequest,
  type ScheduleCallbackRequest,
  type BookSlotRequest,
} from '@onecare/events';
import { validate } from '@onecare/domain';
import {
  initTracing,
  logger,
  setCorrelationId,
  withCorrelationContext,
  createCounter,
  createHistogram,
  getCounterRecords,
  getHistogramRecords,
} from '@onecare/observability';
import { deriveIdempotencyKey, releaseIdempotency, InMemoryIdempotencyStore } from './application/idempotency';
import { ErrorCode } from './application/error';
import { connect, type ConnectionOptions, type NatsConnection } from 'nats';
import type { AuthContext } from '@onecare/security';
import { OidcClient } from '@onecare/security';
import { getSecurityServices, getConsentEvidence } from './adapters/security';
import { loadConfig, type ResolvedConfig, type SafetyGateShadowConfig } from '@onecare/config';
import { createAuditEvent, getAuditLedger } from './adapters/audit';
import { InMemoryFeatureStore } from '@onecare/feature-store-memory';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const orchestratorSchema = require('../../../schemas/config/orchestrator.json');
import type { OrchestratorConfig } from '@onecare/config/src/contracts/orchestrator';
import {
  withFhirValidation,
  type FeatureStore,
  type FhirRepository,
  type FhirBundle,
  type FhirBundleEntry,
  type IdempotencyStore,
  type InvalidFhirError,
  type ObjectStore,
  type AuditEvent as LedgerAuditEvent,
  getDefaultTtlSeconds,
} from '@onecare/ports';
import { resolveServerPort } from './support/port';
import { normalizeExternalServiceBase } from './support/externalTargets';
import { createHttpFhirRepository, isFhirRequestError } from './adapters/persistence/fhir.repository';
import { HttpObjectStore } from './adapters/persistence/object-store.client';
import HttpError from './application/httpError';
import { buildOrchestratorMachine, runOrchestratorMachine } from './application/orchestrator.machine';
import type { AuditRecordOptions, OrchestratorContext, ShadowSafetyGateContext } from './types';
import type { GateDenialReason } from './application/orchestrator.state';
import { ConcurrencyLimiter, RateLimiter } from './support/limits';
import { hashIdentifier, safePatientReference } from './support/privacy';

const port = resolveServerPort();
const busImpl = (process.env.BUS_IMPL ?? '').trim().toLowerCase();
const wantsNats = busImpl !== 'memory' && Boolean(process.env.NATS_URL && process.env.NATS_URL.trim().length > 0);
const reconnectBaseDelayMs = parseReconnectBaseDelay(process.env.NATS_RECONNECT_BASE_DELAY_MS);
const reconnectMaxDelayMs = parseReconnectMaxDelay(process.env.NATS_RECONNECT_MAX_DELAY_MS, reconnectBaseDelayMs);
const reconnectJitterRatio = parseReconnectJitterRatio(process.env.NATS_RECONNECT_JITTER_RATIO);
const reconnectScheduleCounter = createCounter('bus.reconnect.scheduled');
const reconnectEventCounter = createCounter('bus.reconnect.events');
const disconnectEventCounter = createCounter('bus.disconnect.events');
const reconnectDelayHistogram = createHistogram('bus.reconnect.delay');
const busHealthMaxAgeMs = parsePositiveInt(process.env.BUS_HEALTH_CACHE_MS, 2_000, 60_000);
const busReadyLagThreshold = parsePositiveInt(process.env.BUS_READY_PENDING_LAG, 200, 100_000);
const HEADER_TOKEN_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const MAX_ALLOWED_BODY_BYTES = 1_048_576; // 1 MiB ceiling for ingress payloads
const HTTP_LATENCY_BUCKETS_MS = [50, 100, 200, 400, 800, 1_500, 3_000, 5_000, 10_000];
const httpServerDuration = createHistogram('http_server_duration_ms');
const httpServerRequests = createCounter('http_server_requests_total');
const httpServerErrors = createCounter('http_server_errors_total');
const ORCHESTRATOR_SERVICE_LABEL = 'orchestrator';

function containsHeaderControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if ((code >= 0 && code <= 31) || code === 127) {
      return true;
    }
  }
  return false;
}

function parseOptionalBoolean(raw: string | undefined): boolean | null {
  if (raw === undefined || raw === null) return null;
  const normalized = raw.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') {
    return true;
  }
  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') {
    return false;
  }
  return null;
}

const allowLoopbackUpstreams = (() => {
  const override = parseOptionalBoolean(process.env.ORCHESTRATOR_ALLOW_LOOPBACK_UPSTREAMS);
  if (override !== null) {
    return override;
  }
  return process.env.NODE_ENV !== 'production';
})();

function resolvePracticeId(): string {
  const envValue = process.env.PRACTICE_ID?.trim();
  if (envValue) return envValue;
  if (process.env.NODE_ENV === 'test') return 'demo';
  throw new Error('PRACTICE_ID environment variable is required');
}

function assertHttpsUrl(raw: string, envName: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch (error) {
    throw new Error(`${envName} must be a valid URL`);
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`${envName} must use HTTPS`);
  }
  const host = parsed.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.local')) {
    throw new Error(`${envName} must not point to localhost`);
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    throw new Error(`${envName} must not use a raw IPv4 address`);
  }
  if (/^[0-9a-f:]+$/i.test(host) && (host.startsWith('fd') || host.startsWith('fc') || host.startsWith('fe80') || host === '::1')) {
    throw new Error(`${envName} must not use a private IPv6 address`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`${envName} must not include credentials`);
  }
  if (!parsed.port || parsed.port.trim().length === 0) {
    parsed.port = '443';
  }
  return parsed;
}

function resolveFhirBaseUrl(): string {
  const envValue = process.env.FHIR_BASE_URL?.trim();
  if (envValue) {
    const url = assertHttpsUrl(envValue, 'FHIR_BASE_URL');
    return url.toString();
  }
  if (process.env.NODE_ENV === 'test') return 'http://localhost:9500/fhir';
  throw new Error('FHIR_BASE_URL environment variable is required');
}

function resolveFhirTimeoutMs(): number {
  const raw = process.env.FHIR_TIMEOUT_MS?.trim();
  const parsed = raw ? Number(raw) : Number.NaN;
  if (!Number.isFinite(parsed)) return 5_000;
  return Math.max(500, Math.min(parsed, 30_000));
}

function resolveFhirMaxRetries(): number {
  const raw = process.env.FHIR_MAX_RETRIES?.trim();
  const parsed = raw ? Number(raw) : Number.NaN;
  if (!Number.isFinite(parsed)) return 2;
  return Math.max(0, Math.min(Math.floor(parsed), 5));
}

function resolveFhirAuthToken(): string | undefined {
  const raw = process.env.FHIR_TOKEN ?? process.env.FHIR_AUTH_TOKEN;
  const trimmed = raw?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function resolveFhirHealthPath(): string {
  const raw = process.env.FHIR_HEALTH_PATH;
  if (raw === undefined || raw === null) return 'metadata';
  const trimmed = raw.trim();
  if (!trimmed) return '';
  return trimmed.replace(/^\//, '');
}

function resolveObjectStoreBaseUrl(): string | null {
  const raw = process.env.OBJECT_STORE_BASE_URL?.trim();
  if (!raw || raw.length === 0) return null;
  const url = assertHttpsUrl(raw, 'OBJECT_STORE_BASE_URL');
  return url.toString();
}

function resolveObjectStoreTimeoutMs(): number {
  const raw = process.env.OBJECT_STORE_TIMEOUT_MS?.trim();
  const parsed = raw ? Number(raw) : Number.NaN;
  if (!Number.isFinite(parsed)) return 2_000;
  return Math.max(200, Math.min(parsed, 30_000));
}

function resolveObjectStoreMaxRetries(): number {
  const raw = process.env.OBJECT_STORE_MAX_RETRIES?.trim();
  const parsed = raw ? Number(raw) : Number.NaN;
  if (!Number.isFinite(parsed)) return 1;
  return Math.max(0, Math.min(Math.floor(parsed), 4));
}

function resolveObjectStoreHealthPath(): string {
  const raw = process.env.OBJECT_STORE_HEALTH_PATH;
  if (raw === undefined || raw === null) return 'health';
  const trimmed = raw.trim();
  if (!trimmed) return '';
  return trimmed.replace(/^\//, '');
}

function resolveObjectStoreAuthToken(): string | undefined {
  const raw = process.env.OBJECT_STORE_TOKEN ?? process.env.OBJECT_STORE_AUTH_TOKEN;
  const trimmed = raw?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function resolveOidcIssuer(): string | null {
  const raw = process.env.OIDC_ISSUER?.trim();
  return raw && raw.length > 0 ? raw : null;
}

function resolveOidcAudience(): string[] {
  const raw = process.env.OIDC_AUDIENCE ?? process.env.OIDC_CLIENT_ID;
  if (!raw) return [];
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function resolveOidcJwksUri(): string | null {
  const raw = process.env.OIDC_JWKS_URI ?? process.env.OIDC_JWKS_URL;
  const trimmed = raw?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

function resolveOidcTimeoutMs(): number {
  const raw = process.env.OIDC_TIMEOUT_MS?.trim();
  const parsed = raw ? Number(raw) : Number.NaN;
  if (!Number.isFinite(parsed)) return 2_000;
  return Math.max(200, Math.min(parsed, 10_000));
}

function resolveOidcClockSkewSeconds(): number {
  const raw = process.env.OIDC_CLOCK_SKEW_SECONDS?.trim();
  const parsed = raw ? Number(raw) : Number.NaN;
  if (!Number.isFinite(parsed)) return 60;
  return Math.max(0, Math.min(Math.floor(parsed), 600));
}

function buildBearerHeader(token: string | undefined): string | undefined {
  if (!token) return undefined;
  const trimmed = token.trim();
  if (!trimmed) return undefined;
  if (/^(basic|bearer)\s/i.test(trimmed)) return trimmed;
  return `Bearer ${trimmed}`;
}

type DependencyName = 'fhir' | 'objectStore' | 'oidc';

interface DependencyState {
  status: 'ok' | 'degraded' | 'error' | 'skipped';
  details?: string;
  checkedAt: number;
}

const HEALTH_TTL_MS = 30_000;

function resolveFhirProfiles(config: ResolvedConfig): Record<string, string> | undefined {
  const rawFhirConfig = config.fhir;
  if (!rawFhirConfig || typeof rawFhirConfig !== 'object') return undefined;
  const profiles = (rawFhirConfig as { profiles?: unknown }).profiles;
  if (!profiles || typeof profiles !== 'object') return undefined;
  const entries = Object.entries(profiles as Record<string, unknown>)
    .filter(([key, value]) => typeof key === 'string' && typeof value === 'string' && value.trim().length > 0)
    .map(([key, value]) => [key, (value as string).trim()]);
  if (entries.length === 0) return undefined;
  return Object.fromEntries(entries);
}

function normaliseShadowSafetyGate(config?: SafetyGateShadowConfig): ShadowSafetyGateContext | undefined {
  if (!config?.enabled) return undefined;
  if (config.sampleRate <= 0) return undefined;
  return {
    enabled: true,
    sampleRate: Math.max(0, Math.min(config.sampleRate, 1)),
    endpoint: config.endpoint,
    variant: config.variant,
    timeoutMs: config.timeoutMs,
    maxRetries: config.maxRetries,
    baseDelayMs: config.baseDelayMs,
    auditEvent: config.auditEvent ?? 'orchestrator.safety.shadow',
    random: Math.random,
  };
}

type SafetyGateResolved = NonNullable<ResolvedConfig['safety_gate']>;

interface RuntimeState {
  practiceConfig: Readonly<ResolvedConfig>;
  orchestratorConfig: Readonly<OrchestratorConfig>;
  safetyGateSettings: Readonly<Partial<SafetyGateResolved>>;
  safetyGateTimeoutMs: number;
  safetyGateFallbackMode: 'rules' | 'none';
  shadowSafetyGate?: ShadowSafetyGateContext;
  idempotencyTtlSeconds: number;
  bookingAvailabilityTimeoutMs: number;
  configHash: string;
}

const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: false });
addFormats(ajv);
const validateOrchestratorConfiguration = ajv.compile<OrchestratorConfig>(
  orchestratorSchema as Record<string, unknown>,
);

function deepFreeze<T>(value: T): T {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;
  if (Object.isFrozen(value)) return value;
  const target = value as Record<string, unknown> | unknown[];
  Object.freeze(target);
  if (Array.isArray(target)) {
    for (const item of target) {
      deepFreeze(item);
    }
  } else {
    for (const item of Object.values(target)) {
      deepFreeze(item);
    }
  }
  return value;
}

function toOrchestratorConfig(config: ResolvedConfig): OrchestratorConfig {
  const result: OrchestratorConfig = {
    practiceId: config.practiceId,
  };

  const safetySource = config.safety_gate;
  if (safetySource) {
    const mapped: NonNullable<OrchestratorConfig['safetyGate']> = {};
    if (typeof safetySource.timeout_ms === 'number') {
      mapped.timeoutMs = safetySource.timeout_ms;
    }
    const maxRetriesCandidate =
      (safetySource as { max_retries?: unknown; maxRetries?: unknown }).max_retries ??
      (safetySource as { max_retries?: unknown; maxRetries?: unknown }).maxRetries;
    if (typeof maxRetriesCandidate === 'number' && Number.isFinite(maxRetriesCandidate)) {
      mapped.maxRetries = Math.max(0, Math.round(maxRetriesCandidate));
    }
    if (safetySource.fallback === 'none') {
      mapped.fallback = 'none';
    } else if (safetySource.fallback === 'rules') {
      mapped.fallback = 'rules';
    }
    const circuitSource = (safetySource as {
      circuit_breaker?: { failure_threshold?: number; open_ms?: number };
    }).circuit_breaker;
    if (circuitSource && typeof circuitSource === 'object') {
      const failureThreshold = Number(circuitSource.failure_threshold);
      const openMs = Number(circuitSource.open_ms);
      if (Number.isFinite(failureThreshold) && Number.isFinite(openMs)) {
        mapped.circuitBreaker = {
          failureThreshold,
          openMs,
        };
      }
    }
    if (Object.keys(mapped).length > 0) {
      result.safetyGate = mapped;
    }
  }

  if (config.idempotency?.ttlSeconds !== undefined) {
    result.idempotency = { ttlSeconds: config.idempotency.ttlSeconds };
  }

  if (config.booking?.availabilityTimeoutMs !== undefined) {
    result.booking = { availabilityTimeoutMs: config.booking.availabilityTimeoutMs };
  }

  return result;
}

function hashConfig(config: OrchestratorConfig): string {
  return createHash('sha256').update(JSON.stringify(config)).digest('hex');
}

function buildRuntimeState(practiceId: string): RuntimeState {
  const resolved = loadConfig(practiceId);
  const orchestratorConfig = toOrchestratorConfig(resolved);
  if (!validateOrchestratorConfiguration(orchestratorConfig)) {
    const errors =
      validateOrchestratorConfiguration.errors?.map(
        (error) => `${error.instancePath || '/'} ${error.message ?? 'invalid'}`,
      ) ?? ['Invalid orchestrator configuration'];
    const failure = new Error('orchestrator_config_invalid');
    (failure as { details?: string[] }).details = errors;
    throw failure;
  }

  deepFreeze(resolved);
  deepFreeze(orchestratorConfig);

  const safetyGateSettings = deepFreeze(
    (resolved.safety_gate ?? {}) as Partial<SafetyGateResolved>,
  );
  const safetyGateTimeoutMs =
    typeof safetyGateSettings.timeout_ms === 'number' ? safetyGateSettings.timeout_ms : 800;
  const safetyGateFallbackMode: 'rules' | 'none' =
    safetyGateSettings.fallback === 'none' ? 'none' : 'rules';
  const shadowSafetyGate = normaliseShadowSafetyGate(safetyGateSettings.shadow);
  const idempotencyTtlSeconds = resolved.idempotency?.ttlSeconds ?? 600;
  const bookingAvailabilityTimeoutMs = resolved.booking?.availabilityTimeoutMs ?? 2_000;

  return {
    practiceConfig: resolved,
    orchestratorConfig,
    safetyGateSettings,
    safetyGateTimeoutMs,
    safetyGateFallbackMode,
    shadowSafetyGate,
    idempotencyTtlSeconds,
    bookingAvailabilityTimeoutMs,
    configHash: hashConfig(orchestratorConfig),
  };
}

function logRuntimeConfig(state: RuntimeState, event: string): void {
  const safetyGate = state.safetyGateSettings;
  logger.info(event, {
    practiceId: state.practiceConfig.practiceId,
    hash: state.configHash,
    safetyGate: {
      timeoutMs: state.safetyGateTimeoutMs,
      fallback: state.safetyGateFallbackMode,
      redFlagThreshold: safetyGate.red_flag_threshold,
      emergencyConfidence: safetyGate.emergency_confidence,
      acuityThresholdEmergency: safetyGate.acuity_threshold_emergency,
    },
    idempotency: { ttlSeconds: state.idempotencyTtlSeconds },
    booking: { availabilityTimeoutMs: state.bookingAvailabilityTimeoutMs },
    fairnessFloors: state.practiceConfig.fairness_floors,
    holdBackFraction: state.practiceConfig.hold_back_fraction,
  });
}

const practiceId = resolvePracticeId();
let runtime: RuntimeState;
try {
  runtime = buildRuntimeState(practiceId);
} catch (error) {
  const details =
    error instanceof Error && (error as { details?: string[] }).details
      ? (error as { details?: string[] }).details
      : undefined;
  logger.error('orchestrator.config.load_failed', {
    reason: error instanceof Error ? error.message : String(error),
    details,
  });
  process.exit(1);
}

let fhirProfiles = resolveFhirProfiles(runtime.practiceConfig);
logRuntimeConfig(runtime, 'orchestrator.config.loaded');

function currentPracticeConfig(): Readonly<ResolvedConfig> {
  return runtime.practiceConfig;
}

function getSafetyGateTimeoutMs(): number {
  return runtime.safetyGateTimeoutMs;
}

function getSafetyGateFallbackMode(): 'rules' | 'none' {
  return runtime.safetyGateFallbackMode;
}

function getShadowSafetyGate(): ShadowSafetyGateContext | undefined {
  return runtime.shadowSafetyGate;
}

function getIdempotencyTtlSeconds(): number {
  return runtime.idempotencyTtlSeconds;
}

function getBookingAvailabilityTimeoutMs(): number {
  return runtime.bookingAvailabilityTimeoutMs;
}

function resolveBookingAvailabilityBase(): URL | null {
  const raw = process.env.BOOKING_AVAILABILITY_URL?.trim();
  if (!raw) return null;
  try {
    return normalizeExternalServiceBase(raw, {
      envName: 'BOOKING_AVAILABILITY_URL',
      allowHttp: true,
      allowHttps: true,
      allowLoopback: allowLoopbackUpstreams,
    });
  } catch (error) {
    logger.warn('booking availability upstream rejected', {
      value: raw,
      reason: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

function resolveBookingServiceBase(): URL | null {
  const raw = process.env.BOOKING_SERVICE_URL?.trim();
  if (!raw) return null;
  try {
    return normalizeExternalServiceBase(raw, {
      envName: 'BOOKING_SERVICE_URL',
      allowHttp: true,
      allowHttps: true,
      allowLoopback: allowLoopbackUpstreams,
    });
  } catch (error) {
    logger.warn('booking service upstream rejected', {
      value: raw,
      reason: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

function parseBooleanFlag(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function createDelegatingIdempotencyStore(getStore: () => IdempotencyStore): IdempotencyStore {
  return {
    async exists(key: string): Promise<boolean> {
      return getStore().exists(key);
    },
    async put(key: string, ttlSeconds: number): Promise<void> {
      await getStore().put(key, ttlSeconds);
    },
    async reserve(key: string, ttlSeconds: number): Promise<'reserved' | 'exists'> {
      const store = getStore();
      if (typeof store.reserve === 'function') {
        return store.reserve(key, ttlSeconds);
      }
      const exists = await store.exists(key);
      if (exists) {
        return 'exists';
      }
      await store.put(key, ttlSeconds);
      return 'reserved';
    },
    async delete(key: string): Promise<void> {
      const store = getStore();
      if (typeof store.delete === 'function') {
        await store.delete(key);
      }
    },
  };
}

function evaluateBusReadiness(): {
  ready: boolean;
  health: ReturnType<typeof getNatsBusHealth>;
  reason?: string;
} {
  const health = getNatsBusHealth(bus, { maxAgeMs: busHealthMaxAgeMs });
  if (!health) {
    if (busReadyOverride !== null) {
      return { ready: busReadyOverride, health: null, reason: busReadyOverride ? undefined : 'override' };
    }
    return { ready: true, health: null };
  }
  if (busReadyOverride !== null) {
    return {
      ready: busReadyOverride,
      health,
      reason: busReadyOverride ? undefined : 'override',
    };
  }
  const pendingOk = busReadyLagThreshold <= 0 || health.pendingLag <= busReadyLagThreshold;
  const ready = health.isReady && pendingOk;
  if (ready) {
    return { ready: true, health };
  }
  const reasons: string[] = [];
  if (!health.isConnected) reasons.push('disconnected');
  if (health.backpressure) reasons.push('backpressure');
  if (health.subscribed <= 0) reasons.push('no_subscribers');
  if (!pendingOk) reasons.push('pending_lag_exceeded');
  return {
    ready: false,
    health,
    reason: reasons.join(','),
  };
}

function parseReconnectBaseDelay(raw: string | undefined): number {
  const fallback = 1_500;
  const parsed = raw ? Number(raw.trim()) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  const coerced = Math.floor(parsed);
  return Math.min(Math.max(100, coerced), 60_000);
}

function parseReconnectMaxDelay(raw: string | undefined, base: number): number {
  const fallback = 30_000;
  const parsed = raw ? Number(raw.trim()) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return Math.max(base, fallback);
  }
  const coerced = Math.floor(parsed);
  return Math.max(base, Math.min(coerced, 5 * 60_000));
}

function parseReconnectJitterRatio(raw: string | undefined): number {
  const fallback = 0.2;
  const parsed = raw ? Number(raw.trim()) : Number.NaN;
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  if (parsed <= 0) return 0;
  if (parsed >= 1) return 1;
  return parsed;
}

function parsePositiveInt(raw: string | undefined, fallback: number, max: number): number {
  if (!raw) return fallback;
  const parsed = Number(raw.trim());
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return Math.min(Math.floor(parsed), max);
}

function parseLimitEnv(key: string, fallback: number, max: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const parsed = Number(raw.trim());
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  const coerced = Math.floor(parsed);
  return Math.min(coerced, max);
}

function parseDurationMs(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (!raw) return fallback;
  const trimmed = raw.trim().toLowerCase();
  const match = /^(\d+)(ms|s|m)?$/.exec(trimmed);
  if (!match) return fallback;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value < 0) return fallback;
  const unit = match[2] ?? 'ms';
  let milliseconds = value;
  if (unit === 's') milliseconds *= 1000;
  if (unit === 'm') milliseconds *= 60_000;
  milliseconds = Math.floor(milliseconds);
  if (milliseconds < min) return min;
  if (milliseconds > max) return max;
  return milliseconds;
}

function createConcurrencyLimiter(): ConcurrencyLimiter {
  const globalConcurrencyLimit = parseLimitEnv('ORCHESTRATOR_MAX_CONCURRENCY_GLOBAL', 64, 20_000);
  const defaultRouteConcurrencyLimit = parseLimitEnv('ORCHESTRATOR_MAX_CONCURRENCY_DEFAULT', 32, 10_000);
  return new ConcurrencyLimiter({
    globalLimit: globalConcurrencyLimit,
    defaultRouteLimit: defaultRouteConcurrencyLimit,
    perRoute: {
      'POST /safety-check': parseLimitEnv('ORCHESTRATOR_MAX_CONCURRENCY_SAFETY', 24, 5_000),
      'GET /booking/slots': parseLimitEnv('ORCHESTRATOR_MAX_CONCURRENCY_BOOKING', 16, 5_000),
      'POST /feature-log': parseLimitEnv('ORCHESTRATOR_MAX_CONCURRENCY_FEATURE_LOG', 12, 5_000),
    },
  });
}

function createRateLimiter(): RateLimiter {
  const defaultRateLimitPerMinute = parseLimitEnv('ORCHESTRATOR_RATE_LIMIT_DEFAULT_PER_MINUTE', 120, 100_000);
  const safetyRateLimitPerMinute = parseLimitEnv('ORCHESTRATOR_RATE_LIMIT_SAFETY_PER_MINUTE', 40, 10_000);
  const defaultRateLimiterConfig = {
    maxRequests: defaultRateLimitPerMinute,
    windowMs: parseDurationMs(process.env.ORCHESTRATOR_RATE_LIMIT_WINDOW_MS, 60_000, 1_000, 10 * 60_000),
    blockMs: parseDurationMs(process.env.ORCHESTRATOR_RATE_LIMIT_BLOCK_MS, 10_000, 0, 15 * 60_000),
  };
  return new RateLimiter(defaultRateLimiterConfig, {
    'POST /safety-check': {
      maxRequests: safetyRateLimitPerMinute,
      windowMs: parseDurationMs(process.env.ORCHESTRATOR_RATE_LIMIT_SAFETY_WINDOW_MS, 60_000, 1_000, 10 * 60_000),
      blockMs: parseDurationMs(process.env.ORCHESTRATOR_RATE_LIMIT_SAFETY_BLOCK_MS, 20_000, 0, 15 * 60_000),
    },
  });
}

let concurrencyLimiter = createConcurrencyLimiter();
let rateLimiter = createRateLimiter();

const busPublishTimeoutMs = parseDurationMs(
  process.env.ORCHESTRATOR_BUS_PUBLISH_TIMEOUT_MS,
  500,
  100,
  5_000,
);
const busPublishMaxRetries = parseLimitEnv('ORCHESTRATOR_BUS_PUBLISH_MAX_RETRIES', 2, 20);
const busPublishBackoffMs = parseDurationMs(
  process.env.ORCHESTRATOR_BUS_PUBLISH_BACKOFF_MS,
  50,
  10,
  2_000,
);

let shuttingDown = false;
let inflightRequests = 0;
let shutdownPromise: Promise<void> | null = null;
const drainWaiters: Array<() => void> = [];

function beginRequest(): void {
  inflightRequests += 1;
}

function endRequest(): void {
  inflightRequests = Math.max(0, inflightRequests - 1);
  if (inflightRequests === 0) {
    while (drainWaiters.length > 0) {
      const resolve = drainWaiters.pop();
      resolve?.();
    }
  }
}

function waitForDrain(): Promise<void> {
  if (inflightRequests === 0) return Promise.resolve();
  return new Promise((resolve) => {
    drainWaiters.push(resolve);
  });
}

function deriveRateLimitKey(req: http.IncomingMessage): { key: string; anonymised: string | null } {
  const actorId = getHeader(req.headers, 'x-actor-id');
  if (actorId) {
    return { key: `actor:${actorId}`, anonymised: hashIdentifier(actorId) };
  }
  const requestId = getHeader(req.headers, 'x-request-id');
  if (requestId) {
    return { key: `request:${requestId}`, anonymised: hashIdentifier(requestId) };
  }
  const remote = req.socket.remoteAddress ?? 'unknown';
  return { key: `ip:${remote}`, anonymised: hashIdentifier(remote) };
}

function validateIncomingHeaders(
  headers: http.IncomingHttpHeaders,
): { valid: true } | { valid: false; reason: string; header: string } {
  for (const [rawName, rawValue] of Object.entries(headers)) {
    const name = rawName?.trim();
    if (!name) {
      return { valid: false, reason: 'missing_name', header: rawName ?? '<unknown>' };
    }
    if (!HEADER_TOKEN_PATTERN.test(name)) {
      return { valid: false, reason: 'invalid_name', header: name };
    }
    const values = Array.isArray(rawValue) ? rawValue : [rawValue];
    for (const candidate of values) {
      if (candidate === undefined) continue;
      const value = String(candidate);
      if (containsHeaderControlChars(value)) {
        return { valid: false, reason: 'control_character', header: name };
      }
      if (value.length > 16_384) {
        return { valid: false, reason: 'value_too_long', header: name };
      }
    }
  }
  return { valid: true };
}

const shutdownDrainTimeoutMs = parseDurationMs(
  process.env.ORCHESTRATOR_SHUTDOWN_DRAIN_TIMEOUT_MS,
  10_000,
  1_000,
  120_000,
);

async function drainInflightRequests(timeoutMs: number): Promise<void> {
  if (inflightRequests === 0) return;
  await Promise.race([
    waitForDrain(),
    delay(timeoutMs).then(() => {
      throw new Error('drain_timeout');
    }),
  ]);
}

async function initiateShutdown(signal: NodeJS.Signals | 'test'): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  shuttingDown = true;
  logger.warn('shutdown.initiated', { signal });

  const perform = async () => {
    try {
      try {
        await drainInflightRequests(shutdownDrainTimeoutMs);
      } catch (error) {
        logger.warn('shutdown.drain_timeout', {
          reason: error instanceof Error ? error.message : String(error),
          inflight: inflightRequests,
        });
      }
      if (server) {
        await new Promise<void>((resolve) => {
          server.close((err) => {
            if (err) {
              logger.error('shutdown.server_close_failed', { reason: err.message });
            }
            resolve();
          });
        });
      }
      if (_natsConn) {
        try {
          await _natsConn.drain();
        } catch (error) {
          logger.warn('shutdown.nats_drain_failed', {
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } finally {
      logger.info('shutdown.completed', { inflight: inflightRequests });
    }
  };

  shutdownPromise = perform();
  return shutdownPromise;
}

export async function initiateShutdownForTest(): Promise<void> {
  await initiateShutdown('test');
}

export function resetShutdownStateForTest(): void {
  shuttingDown = false;
  shutdownPromise = null;
  inflightRequests = 0;
  drainWaiters.splice(0);
  concurrencyLimiter.reset();
  rateLimiter.reset();
}

function isFeatureLoggingEnabled(): boolean {
  return parseBooleanFlag(process.env.FEATURE_LOGGING);
}

function computeFeatureLoggingTtlMs(): number | undefined {
  const ttlSeconds = Math.max(
    getDefaultTtlSeconds('triage-core') ?? 0,
    getDefaultTtlSeconds('acuity-signal') ?? 0,
  );
  return ttlSeconds > 0 ? ttlSeconds * 1000 : undefined;
}

let featureStore: FeatureStore | null = null;

function refreshFeatureLoggingStore(): void {
  if (!isFeatureLoggingEnabled()) {
    featureStore = null;
    return;
  }
  const ttlMs = computeFeatureLoggingTtlMs();
  featureStore = new InMemoryFeatureStore(ttlMs ? { ttlMs } : undefined);
}

interface FhirEnvConfig {
  baseUrl: string;
  timeoutMs: number;
  maxRetries: number;
  authToken?: string;
  healthPath: string;
}

function loadFhirEnvConfig(): FhirEnvConfig {
  return {
    baseUrl: resolveFhirBaseUrl(),
    timeoutMs: resolveFhirTimeoutMs(),
    maxRetries: resolveFhirMaxRetries(),
    authToken: resolveFhirAuthToken(),
    healthPath: resolveFhirHealthPath(),
  };
}

function tryLoadFhirEnvConfig(): FhirEnvConfig | null {
  try {
    return loadFhirEnvConfig();
  } catch {
    return null;
  }
}

function constructFhirRepository(): FhirRepository {
  const env = loadFhirEnvConfig();
  const maybeFetch = (globalThis as { fetch?: typeof fetch }).fetch;
  const testFetch =
    process.env.NODE_ENV === 'test' && typeof maybeFetch === 'function'
      ? maybeFetch.bind(globalThis)
      : undefined;
  const repository = createHttpFhirRepository({
    baseUrl: env.baseUrl,
    authToken: env.authToken,
    timeoutMs: env.timeoutMs,
    maxRetries: env.maxRetries,
    practiceId,
    fetchImpl: testFetch,
    circuitBreakerThreshold: parsePositiveInt(process.env.FHIR_CIRCUIT_FAILURE_THRESHOLD, 3, 20),
    circuitBreakerCooldownMs: parsePositiveInt(process.env.FHIR_CIRCUIT_COOLDOWN_MS, 15_000, 5 * 60_000),
    circuitBreakerHalfOpenSuccesses: parsePositiveInt(process.env.FHIR_CIRCUIT_HALF_OPEN_SUCCESS, 2, 10),
  });
  return withFhirValidation(repository, { profiles: fhirProfiles });
}

let fhirRepository: FhirRepository = constructFhirRepository();

interface ObjectStoreEnvConfig {
  baseUrl: string;
  timeoutMs: number;
  maxRetries: number;
  healthPath: string;
  authToken?: string;
}

function loadObjectStoreEnvConfig(): ObjectStoreEnvConfig | null {
  const baseUrl = resolveObjectStoreBaseUrl();
  if (!baseUrl) return null;
  return {
    baseUrl,
    timeoutMs: resolveObjectStoreTimeoutMs(),
    maxRetries: resolveObjectStoreMaxRetries(),
    healthPath: resolveObjectStoreHealthPath(),
    authToken: resolveObjectStoreAuthToken(),
  };
}

function buildObjectStoreFromEnv(env: ObjectStoreEnvConfig | null): ObjectStore | null {
  if (!env) return null;
  return new HttpObjectStore({
    baseUrl: env.baseUrl,
    timeoutMs: env.timeoutMs,
    maxRetries: env.maxRetries,
    authToken: env.authToken,
  });
}

const initialObjectStoreEnv = loadObjectStoreEnvConfig();
let objectStore: ObjectStore | null = buildObjectStoreFromEnv(initialObjectStoreEnv);
if (initialObjectStoreEnv && !objectStore) {
  logger.warn('object store disabled - configuration incomplete');
}

interface OidcEnvConfig {
  issuer: string | null;
  audience: string[];
  jwksUri: string | null;
  timeoutMs: number;
  clockSkewSeconds: number;
}

function loadOidcEnvConfig(): OidcEnvConfig {
  return {
    issuer: resolveOidcIssuer(),
    audience: resolveOidcAudience(),
    jwksUri: resolveOidcJwksUri(),
    timeoutMs: resolveOidcTimeoutMs(),
    clockSkewSeconds: resolveOidcClockSkewSeconds(),
  };
}

function constructOidcClient(): OidcClient | null {
  const env = loadOidcEnvConfig();
  if (!env.issuer || !env.jwksUri || env.audience.length === 0) {
    return null;
  }
  return new OidcClient({
    issuer: env.issuer,
    audience: env.audience,
    jwksUri: env.jwksUri,
    httpTimeoutMs: env.timeoutMs,
    clockSkewSeconds: env.clockSkewSeconds,
  });
}

let oidcClient: OidcClient | null = constructOidcClient();

refreshFeatureLoggingStore();

process.on('SIGHUP', () => {
  logger.info('orchestrator.config.reload_requested');
  try {
    runtime = buildRuntimeState(practiceId);
    fhirProfiles = resolveFhirProfiles(runtime.practiceConfig);
    fhirRepository = constructFhirRepository();
    const reloadedObjectStoreEnv = loadObjectStoreEnvConfig();
    objectStore = buildObjectStoreFromEnv(reloadedObjectStoreEnv);
    if (reloadedObjectStoreEnv && !objectStore) {
      logger.warn('object store disabled after reload - configuration incomplete');
    }
    oidcClient = constructOidcClient();
    refreshFeatureLoggingStore();
    concurrencyLimiter = createConcurrencyLimiter();
    rateLimiter = createRateLimiter();
    logRuntimeConfig(runtime, 'orchestrator.config.reloaded');
  } catch (error) {
    const details =
      error instanceof Error && (error as { details?: string[] }).details
        ? (error as { details?: string[] }).details
        : undefined;
    logger.error('orchestrator.config.reload_failed', {
      reason: error instanceof Error ? error.message : String(error),
      details,
    });
  }
});

const dependencyCache: Record<DependencyName, DependencyState> = {
  fhir: { status: tryLoadFhirEnvConfig() ? 'error' : 'skipped', checkedAt: 0 },
  objectStore: { status: loadObjectStoreEnvConfig() ? 'error' : 'skipped', checkedAt: 0 },
  oidc: {
    status: (() => {
      const env = loadOidcEnvConfig();
      return env.issuer && env.jwksUri && env.audience.length > 0 ? 'error' : 'skipped';
    })(),
    checkedAt: 0,
  },
};

async function evaluateDependency(name: DependencyName, fn: () => Promise<DependencyState>): Promise<DependencyState> {
  const cached = dependencyCache[name];
  const now = Date.now();
  if (cached && now - cached.checkedAt < HEALTH_TTL_MS) {
    return cached;
  }
  try {
    const result = await fn();
    dependencyCache[name] = result;
    return result;
  } catch (error) {
    const failure: DependencyState = {
      status: 'error',
      details: error instanceof Error ? error.message : String(error),
      checkedAt: Date.now(),
    };
    dependencyCache[name] = failure;
    return failure;
  }
}

async function probeFhir(): Promise<DependencyState> {
  const env = tryLoadFhirEnvConfig();
  if (!env) {
    return { status: 'skipped', checkedAt: Date.now() };
  }
  const healthUrl = new URL(env.healthPath || '.', env.baseUrl).toString();
  const controller = new AbortController();
  // Allow up to 2s for the FHIR probe (bounded by FHIR_TIMEOUT_MS)
  const timeout = setTimeout(() => controller.abort(), Math.min(env.timeoutMs, 2_000));
  try {
    const headers: Record<string, string> = { accept: 'application/fhir+json' };
    const authHeader = buildBearerHeader(env.authToken);
    if (authHeader) headers.authorization = authHeader;
    const apiKey = (process.env.FHIR_API_KEY || process.env.NHS_API_KEY || '').trim();
    const apiKeyHeader = (process.env.FHIR_API_KEY_HEADER || 'apikey').trim();
    if (apiKey) headers[apiKeyHeader] = apiKey;
    const response = await fetch(healthUrl, {
      method: 'GET',
      headers,
      signal: controller.signal,
      redirect: 'manual',
    });
    clearTimeout(timeout);
    if (!response.ok) {
      return {
        status: 'degraded',
        details: `status_${response.status}`,
        checkedAt: Date.now(),
      } satisfies DependencyState;
    }
    return { status: 'ok', checkedAt: Date.now() } satisfies DependencyState;
  } catch (error) {
    clearTimeout(timeout);
    return {
      status: 'error',
      details: error instanceof Error ? error.message : String(error),
      checkedAt: Date.now(),
    } satisfies DependencyState;
  }
}

async function probeObjectStore(): Promise<DependencyState> {
  const env = loadObjectStoreEnvConfig();
  if (!env) {
    return { status: 'skipped', checkedAt: Date.now() };
  }
  const healthPath = env.healthPath;
  const healthUrl = new URL(healthPath || '.', env.baseUrl).toString();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.min(env.timeoutMs, 1_000));
  try {
    const headers: Record<string, string> = { accept: 'application/json' };
    const authHeader = buildBearerHeader(env.authToken);
    if (authHeader) headers.authorization = authHeader;
    const response = await fetch(healthUrl, {
      method: 'GET',
      headers,
      signal: controller.signal,
      redirect: 'manual',
    });
    clearTimeout(timeout);
    if (!response.ok) {
      return {
        status: 'degraded',
        details: `status_${response.status}`,
        checkedAt: Date.now(),
      } satisfies DependencyState;
    }
    return { status: 'ok', checkedAt: Date.now() } satisfies DependencyState;
  } catch (error) {
    clearTimeout(timeout);
    return {
      status: 'error',
      details: error instanceof Error ? error.message : String(error),
      checkedAt: Date.now(),
    } satisfies DependencyState;
  }
}

async function probeOidc(): Promise<DependencyState> {
  if (!oidcClient) {
    return { status: 'skipped', checkedAt: Date.now() };
  }
  try {
    await oidcClient.healthCheck();
    return { status: 'ok', checkedAt: Date.now() } satisfies DependencyState;
  } catch (error) {
    return {
      status: 'error',
      details: error instanceof Error ? error.message : String(error),
      checkedAt: Date.now(),
    } satisfies DependencyState;
  }
}

function formatDependency(state: DependencyState): { status: string; checkedAt: string; details?: string } {
  const report: { status: string; checkedAt: string; details?: string } = {
    status: state.status,
    checkedAt: new Date(state.checkedAt).toISOString(),
  };
  if (state.details) {
    report.details = state.details;
  }
  return report;
}

function computeOverallStatus(reports: Record<string, { status: string }>): 'ok' | 'degraded' | 'error' {
  const statuses = Object.values(reports).map((report) => report.status);
  if (statuses.includes('error')) return 'error';
  if (statuses.includes('degraded')) return 'degraded';
  return 'ok';
}

async function collectDependencyHealth(): Promise<
  Record<'fhir' | 'objectStore' | 'oidc', { status: string; checkedAt: string; details?: string }>
> {
  const [fhirStatus, objectStoreStatus, oidcStatus] = await Promise.all([
    evaluateDependency('fhir', probeFhir),
    evaluateDependency('objectStore', probeObjectStore),
    evaluateDependency('oidc', probeOidc),
  ]);
  return {
    fhir: formatDependency(fhirStatus),
    objectStore: formatDependency(objectStoreStatus),
    oidc: formatDependency(oidcStatus),
  };
}

void initTracing('orchestrator').catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  logger.warn('failed to initialize tracing', { message });
});

const ORCHESTRATOR_ALLOWED_TOPICS = new Set<string>([
  Topics.audit.event,
  Topics.triage.input,
  Topics.tasks.created,
]);

let idempotencyStore: IdempotencyStore = new InMemoryIdempotencyStore();
const delegatingIdempotencyStore = createDelegatingIdempotencyStore(() => idempotencyStore);

function buildMessageBus(options?: Parameters<typeof getBus>[0]): MessageBus {
  const base = getBus(options);
  const ttlSeconds = getIdempotencyTtlSeconds();
  return withMessageGuards(base, {
    allowedTopics: ORCHESTRATOR_ALLOWED_TOPICS,
    idempotencyStore: delegatingIdempotencyStore,
    idempotencyTtlSeconds: ttlSeconds,
    onDuplicate: (message) => {
      logger.warn('duplicate bus message skipped', {
        topic: message.topic,
        messageId: message.headers?.['x-message-id'],
        correlationId: message.headers?.['x-correlation-id'],
      });
    },
  });
}

let bus: MessageBus = buildMessageBus();
markNatsBusConnected(bus, !wantsNats);
let busReady = !wantsNats;
let busReadyOverride: boolean | null = null;
let _natsConn: NatsConnection | null = null;
let reconnectTimer: NodeJS.Timeout | undefined;
let reconnectAttempts = 0;
const CONSENT_RESOURCES = ['QuestionnaireResponse', 'Communication', 'DocumentReference'] as const;
const BOOKING_RESOURCES = ['Slot'] as const;
const FEATURE_LOG_RESOURCES = ['FeatureLog'] as const;
const BOOKING_SCOPE = 'booking:read';
const CLINICIAN_TASKS_ACTION = 'clinician:tasks:read';
const CLINICIAN_TASKS_WRITE_ACTION = 'clinician:tasks:write';
const CLINIC_SCOPE_PREFIX = 'clinic:';
const DEFAULT_CLINICIAN_TASK_LIMIT = 25;
const MAX_CLINICIAN_TASK_LIMIT = 100;
const TASK_SEARCH_SORT = '-authored-on,-_id';
const CLINIC_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const TASK_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const BOOKING_PARAM_KEYS = ['serviceType', 'windowStart', 'windowEnd', 'location'] as const;
type BookingParamKey = typeof BOOKING_PARAM_KEYS[number];
const BOOKING_ALLOWED_PARAMS = new Set<BookingParamKey>(BOOKING_PARAM_KEYS);

function isBookingParamKey(value: string): value is BookingParamKey {
  return BOOKING_ALLOWED_PARAMS.has(value as BookingParamKey);
}
const BOOKING_QUERY_SCHEMA_ID = 'https://onecare/schemas/booking/booking-search-request.json';
const CLINICIAN_RESOLVE_SCHEMA_ID = 'https://onecare/schemas/clinician/resolve.json';
const CLINICIAN_SCHEDULE_CALLBACK_SCHEMA_ID = 'https://onecare/schemas/clinician/schedule-callback.json';
const CLINICIAN_BOOK_SLOT_SCHEMA_ID = 'https://onecare/schemas/clinician/book-slot.json';
const MAX_ATTACHMENTS = 10;
const FEATURE_LOG_SCOPE = 'analytics:feature:write';
const FEATURE_LOG_PURPOSE = 'analytics-lite';
const AUDIT_DENIED_TYPE = 'orchestrator.access.denied';

function isPrivateIpv4(host: string): boolean {
  const octets = host.split('.').map((segment) => Number(segment));
  if (octets.length !== 4 || octets.some((part) => Number.isNaN(part) || part < 0 || part > 255)) return false;
  if (octets[0] === 10) return true;
  if (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) return true;
  if (octets[0] === 192 && octets[1] === 168) return true;
  if (octets[0] === 127) return true;
  if (octets[0] === 169 && octets[1] === 254) return true;
  return false;
}

function isPrivateIpv6(host: string): boolean {
  const lower = host.toLowerCase();
  if (lower === '::1' || lower === '0:0:0:0:0:0:0:1') return true;
  if (lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80:')) return true;
  return false;
}

function normalizeAttachmentUrl(rawUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new HttpError('invalid_input', 'Attachment URL is invalid');
  }
  if (parsed.protocol !== 'https:') {
    throw new HttpError('invalid_input', 'Attachment URL must use HTTPS');
  }
  if (parsed.username || parsed.password) {
    throw new HttpError('invalid_input', 'Attachment URL must not include credentials');
  }
  const hostname = parsed.hostname;
  if (!hostname) {
    throw new HttpError('invalid_input', 'Attachment hostname is missing');
  }
  if (hostname === 'localhost' || hostname.endsWith('.local')) {
    throw new HttpError('invalid_input', 'Attachment hostname is not allowed');
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname) && isPrivateIpv4(hostname)) {
    throw new HttpError('invalid_input', 'Attachment host is not reachable');
  }
  if (/^[0-9a-fA-F:]+$/.test(hostname) && isPrivateIpv6(hostname)) {
    throw new HttpError('invalid_input', 'Attachment host is not reachable');
  }
  return parsed.toString();
}

function sanitizeInboundSubmission(submission: PortalSubmission): void {
  if (!Array.isArray(submission.attachments) || submission.attachments.length === 0) {
    if ('attachments' in submission) {
      delete (submission as { attachments?: PortalSubmission['attachments'] }).attachments;
    }
    return;
  }
  const sanitized = submission.attachments.map((raw) => {
    const contentType = typeof raw?.contentType === 'string' ? raw.contentType.trim() : '';
    const url = typeof raw?.url === 'string' ? raw.url.trim() : '';
    if (!contentType || !url) {
      throw new HttpError('invalid_input', 'Attachment fields are required');
    }
    const safeUrl = normalizeAttachmentUrl(url);
    return {
      contentType,
      url: safeUrl,
    } satisfies { contentType: string; url: string };
  });
  if (sanitized.length > MAX_ATTACHMENTS) {
    throw new HttpError('invalid_input', 'Too many attachments');
  }
  if (sanitized.length > 0) {
    (submission as { attachments: PortalSubmission['attachments'] }).attachments =
      sanitized as unknown as PortalSubmission['attachments'];
  } else {
    delete (submission as { attachments?: PortalSubmission['attachments'] }).attachments;
  }
}

function sanitizeBookingQuery(searchParams: URLSearchParams | null): URLSearchParams {
  if (!searchParams || Array.from(searchParams.keys()).length === 0) {
    throw new HttpError('invalid_input', 'Missing booking search parameters');
  }

  const seen = new Set<BookingParamKey>();
  const candidate: Partial<Record<BookingParamKey, string>> = {};
  for (const [rawKey, rawValue] of searchParams.entries()) {
    if (!isBookingParamKey(rawKey)) {
      throw new HttpError('invalid_input', `Unexpected query parameter: ${rawKey}`);
    }
    if (seen.has(rawKey)) {
      throw new HttpError('invalid_input', `Duplicate query parameter: ${rawKey}`);
    }
    seen.add(rawKey);
    const value = rawValue.trim();
    if (!value) {
      throw new HttpError('invalid_input', `Parameter ${rawKey} must not be empty`);
    }
    candidate[rawKey] = value;
  }

  const validation = validate(BOOKING_QUERY_SCHEMA_ID, candidate);
  if (!validation.ok) {
    throw new HttpError('invalid_input', 'Invalid booking query parameters', {
      errors: validation.errors.slice(0, 5),
    });
  }

  const startDate = new Date(candidate.windowStart!);
  const endDate = new Date(candidate.windowEnd!);
  if (!Number.isFinite(startDate.getTime()) || !Number.isFinite(endDate.getTime()) || startDate >= endDate) {
    throw new HttpError('invalid_input', 'windowStart must be before windowEnd');
  }

  const sanitized = new URLSearchParams();
  sanitized.set('serviceType', candidate.serviceType!);
  sanitized.set('windowStart', candidate.windowStart!);
  sanitized.set('windowEnd', candidate.windowEnd!);
  if (candidate.location) {
    sanitized.set('location', candidate.location);
  }
  return sanitized;
}

function normalizeOptionalEnv(value: string | undefined): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function buildConnectionOptions(): ConnectionOptions {
  const { servers, auth } = parseNatsServerConfig(process.env.NATS_URL);
  const options: ConnectionOptions = { servers };
  const token = normalizeOptionalEnv(process.env.NATS_TOKEN) ?? auth.token;
  const user = normalizeOptionalEnv(process.env.NATS_USER) ?? auth.user;
  const pass = normalizeOptionalEnv(process.env.NATS_PASS) ?? auth.pass;
  if (token) {
    options.token = token;
  } else {
    if (user) options.user = user;
    if (pass) options.pass = pass;
  }
  const timeoutMs = Number(process.env.NATS_CONNECT_TIMEOUT_MS ?? '');
  if (!Number.isNaN(timeoutMs) && timeoutMs > 0) options.timeout = timeoutMs;
  const maxReconnect = Number(process.env.NATS_MAX_RECONNECT_ATTEMPTS ?? '');
  if (!Number.isNaN(maxReconnect) && maxReconnect >= 0) options.maxReconnectAttempts = maxReconnect;
  const reconnectWait = Number(process.env.NATS_RECONNECT_TIME_WAIT_MS ?? '');
  if (!Number.isNaN(reconnectWait) && reconnectWait > 0) options.reconnectTimeWait = reconnectWait;
  return options;
}

function scheduleReconnect(delayMs?: number) {
  if (reconnectTimer) return;
  reconnectAttempts += 1;
  const computedDelay =
    typeof delayMs === 'number' && delayMs > 0 ? Math.floor(delayMs) : calculateReconnectDelay(reconnectAttempts);
  reconnectDelayHistogram.record(computedDelay, { attempt: reconnectAttempts });
  reconnectScheduleCounter.add(1, { attempt: reconnectAttempts, delayMs: computedDelay });
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    void establishBusConnection();
  }, computedDelay);
}

function calculateReconnectDelay(attempt: number): number {
  const boundedAttempt = Math.max(1, attempt);
  const exponential = Math.min(
    reconnectMaxDelayMs,
    reconnectBaseDelayMs * Math.pow(2, Math.max(0, boundedAttempt - 1)),
  );
  if (reconnectJitterRatio <= 0) {
    return exponential;
  }
  const jitterSpan = Math.max(1, Math.floor(exponential * reconnectJitterRatio));
  const min = Math.max(100, exponential - jitterSpan);
  const max = exponential + jitterSpan;
  return Math.round(min + Math.random() * (max - min));
}

function monitorNats(conn: NatsConnection) {
  (async () => {
    for await (const status of conn.status()) {
      const event = status.type;
      if (event === 'reconnect') {
        reconnectEventCounter.add(1, { event });
        reconnectAttempts = 0;
        markNatsBusConnected(bus, true);
        busReady = true;
        logger.info('NATS connection restored', { event });
      } else if (
        event === 'disconnect' ||
        event === 'reconnecting' ||
        event === 'staleConnection' ||
        event === 'pingTimer' ||
        event === 'ldm' ||
        event === 'error'
      ) {
        disconnectEventCounter.add(1, { event });
        markNatsBusConnected(bus, false);
        busReady = false;
        logger.warn('NATS connection disrupted', { event });
        if (event === 'disconnect' || event === 'error') {
          scheduleReconnect();
        }
      } else if (event === 'update') {
        logger.info('NATS server list updated', { data: status.data });
      }
    }
    busReady = false;
    markNatsBusConnected(bus, false);
    logger.warn('NATS status iterator completed unexpectedly');
    scheduleReconnect();
  })().catch((err: unknown) => {
    logger.error('NATS status monitoring failed', { err: err instanceof Error ? err.message : err });
    busReady = false;
    markNatsBusConnected(bus, false);
    scheduleReconnect();
  });
}

async function establishBusConnection(): Promise<void> {
  if (!wantsNats) {
    busReady = true;
    markNatsBusConnected(bus, true);
    return;
  }
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
  }
  try {
    const options = buildConnectionOptions();
    logger.info('Connecting to NATS', { servers: options.servers });
    const conn = await connect(options);
    _natsConn = conn;
    bus = buildMessageBus({ connection: conn });
    markNatsBusConnected(bus, true);
    busReady = true;
    reconnectAttempts = 0;
    monitorNats(conn);
    logger.info('Connected to NATS', { servers: options.servers });
  } catch (err: unknown) {
    busReady = false;
    markNatsBusConnected(bus, false);
    logger.error('Failed to connect to NATS', { err: err instanceof Error ? err.message : err });
    scheduleReconnect();
  }
}

void establishBusConnection();

function cidFromHeaders(headers: http.IncomingHttpHeaders): string {
  const h = headers['x-correlation-id'] || headers['X-Correlation-ID'];
  if (Array.isArray(h)) return h[0];
  if (typeof h === 'string') return h;
  return randomUUID();
}

function resolveMaxBodyBytes(): number {
  const parsed = parseByteSize(process.env.MAX_BODY_BYTES);
  if (!parsed) {
    return 256 * 1024;
  }
  const capped = Math.min(parsed, MAX_ALLOWED_BODY_BYTES);
  if (capped < parsed) {
    logger.warn('max_body_bytes.capped', {
      configured: parsed,
      applied: capped,
    });
  }
  return capped;
}

function parseByteSize(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const match = /^([0-9]+(?:\.[0-9]+)?)([kKmMgG]?)(?:[bB])?$/.exec(trimmed);
  if (!match) return undefined;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  const unit = match[2]?.toLowerCase();
  const multiplier =
    unit === 'k' ? 1024 : unit === 'm' ? 1024 ** 2 : unit === 'g' ? 1024 ** 3 : 1;
  const bytes = value * multiplier;
  if (!Number.isFinite(bytes) || bytes <= 0) return undefined;
  return Math.floor(bytes);
}

function normalizeExplicitIdempotencyKey(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (!IDEMPOTENCY_KEY_PATTERN.test(trimmed)) {
    throw new HttpError('invalid_input', 'Invalid idempotency key');
  }
  return trimmed;
}

type RequestOutcome = ErrorCode | 'ok';

function respondJson(
  res: http.ServerResponse,
  statusCode: number,
  body: unknown,
  correlationId: string | undefined,
  setOutcome: (value: RequestOutcome) => void,
  outcome: RequestOutcome = 'ok'
): void {
  setOutcome(outcome);
  res.statusCode = statusCode;
  res.setHeader('content-type', 'application/json');
  if (correlationId) res.setHeader('x-correlation-id', correlationId);
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function respondError(
  res: http.ServerResponse,
  code: ErrorCode,
  message: string,
  correlationId: string | undefined,
  setOutcome: (value: RequestOutcome) => void,
  details?: Record<string, unknown>
): void {
  const envelope = errorEnvelope(code, message, details, correlationId);
  respondJson(res, mapErrorToStatus(code), envelope, correlationId, setOutcome, code);
}

function ensureReadResource(
  repository: FhirRepository,
  res: http.ServerResponse,
  correlationId: string | undefined,
  setOutcome: (value: RequestOutcome) => void,
): NonNullable<FhirRepository['readResource']> | null {
  if (typeof repository.readResource === 'function') {
    return repository.readResource.bind(repository) as NonNullable<FhirRepository['readResource']>;
  }
  respondError(res, 'upstream_unavailable', 'FHIR read capability unavailable', correlationId, setOutcome);
  return null;
}

function recordHttpMetrics(
  routeLabel: string,
  method: string,
  path: string,
  status: number,
  outcome: RequestOutcome,
  durationMs: number,
  correlationId: string | undefined,
): void {
  const statusCode = Number.isFinite(status) && status > 0 ? Math.trunc(status) : 0;
  httpServerDuration.record(durationMs, {
    service: ORCHESTRATOR_SERVICE_LABEL,
    route: path,
    method,
  });
  httpServerRequests.add(1, {
    service: ORCHESTRATOR_SERVICE_LABEL,
    route: path,
    method,
    status: statusCode,
    outcome,
  });
  if (statusCode >= 500 && statusCode < 600) {
    httpServerErrors.add(1, {
      service: ORCHESTRATOR_SERVICE_LABEL,
      route: path,
      method,
      status: statusCode,
      outcome,
    });
  }
  logger.info('metric.http.request', {
    route: routeLabel,
    method,
    path,
    status: statusCode,
    outcome,
    durationMs: Number(durationMs.toFixed(2)),
    correlationId,
  });
}

function deriveMethodAndPath(routeLabel: string, req: http.IncomingMessage): { method: string; path: string } {
  const parts = routeLabel.split(' ');
  let method = req.method?.toUpperCase() ?? 'UNKNOWN';
  let path = '';
  if (parts.length > 1 && /^[A-Z]+$/.test(parts[0])) {
    method = parts[0];
    path = parts.slice(1).join(' ').trim();
  } else if (parts.length === 1 && /^[A-Z]+$/.test(parts[0])) {
    method = parts[0];
  } else if (parts.length > 0 && !path) {
    path = routeLabel.trim();
  }
  if (!path) {
    const rawUrl = req.url ?? '/';
    path = rawUrl.split('?')[0] || '/';
  }
  if (!path.startsWith('/')) {
    path = `/${path.replace(/^\/?/, '')}`;
  }
  return { method, path };
}

function classifyError(err: unknown): { code: ErrorCode; message: string; details?: Record<string, unknown> } {
  if (err instanceof HttpError) {
    return { code: err.code, message: err.message, details: err.details };
  }
  const reason = err instanceof Error ? err.message : String(err);
  if (reason && reason.toLowerCase().includes('timeout')) {
    return { code: 'upstream_timeout', message: 'Upstream timeout' };
  }
  if (reason && reason.startsWith('circuit_open')) {
    return { code: 'upstream_unavailable', message: 'Safety gate unavailable' };
  }
  return { code: 'internal_error', message: 'Unexpected error' };
}

function isInvalidFhirError(err: unknown): err is InvalidFhirError {
  return Boolean(err && typeof err === 'object' && 'reason' in (err as Record<string, unknown>));
}

function isTimeoutLikeError(err: unknown): boolean {
  if (!err) return false;
  if (err instanceof DOMException && err.name === 'AbortError') return true;
  const message = err instanceof Error ? err.message : String(err);
  return message.toLowerCase().includes('timeout');
}

function mapFhirPersistenceError(err: unknown): { code: ErrorCode; message: string; details?: Record<string, unknown> } {
  if (isFhirRequestError(err)) {
    const status = err.status ?? 0;
    const details: Record<string, unknown> = {
      status,
      operation: err.operation,
      retryable: err.retryable,
    };
    if (status === 400 || status === 422) {
      return { code: 'invalid_fhir', message: 'FHIR server rejected the bundle', details };
    }
    if (status === 401 || status === 403) {
      return { code: 'forbidden', message: 'FHIR authorization failed', details };
    }
    if (status === 409) {
      return { code: 'conflict', message: 'FHIR conflict detected', details };
    }
    if (status === 429) {
      return { code: 'too_many_requests', message: 'FHIR rate limit exceeded', details };
    }
    if (status === 0 && err.retryable) {
      return { code: 'upstream_timeout', message: 'FHIR request timed out', details };
    }
    return { code: 'upstream_unavailable', message: 'FHIR request failed', details };
  }

  if (isInvalidFhirError(err)) {
    const detail: Record<string, unknown> = {
      reason: err.reason,
      resourceType: err.resourceType,
      profile: err.profile,
    };
    return { code: 'invalid_fhir', message: 'FHIR validation failed', details: detail };
  }

  if (isTimeoutLikeError(err)) {
    return { code: 'upstream_timeout', message: 'FHIR request timed out' };
  }

  return { code: 'internal_error', message: 'Unexpected FHIR persistence error' };
}

type HttpHandler = (setOutcome: (value: RequestOutcome) => void) => Promise<void>;

function handleHttp(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  route: string,
  correlationId: string,
  handler: HttpHandler
): void {
  const start = process.hrtime.bigint();
  let outcome: RequestOutcome = 'ok';
  const setOutcome = (value: RequestOutcome) => {
    outcome = value;
  };
  const { method: metricsMethod, path: metricsPath } = deriveMethodAndPath(route, req);

  const recordMetrics = () => {
    const durationMs = Number(process.hrtime.bigint() - start) / 1_000_000;
    const statusCode = typeof res.statusCode === 'number' ? res.statusCode : 0;
    recordHttpMetrics(route, metricsMethod, metricsPath, statusCode, outcome, durationMs, correlationId);
  };

  const headerValidation = validateIncomingHeaders(req.headers);
  if (!headerValidation.valid) {
    req.resume();
    logger.warn('http.headers.invalid', {
      route,
      correlationId,
      header: headerValidation.header,
      reason: headerValidation.reason,
    });
    respondError(res, 'invalid_input', 'Invalid HTTP headers', correlationId, setOutcome);
    recordMetrics();
    return;
  }

  if (shuttingDown) {
    respondError(res, 'busy', 'Service is shutting down', correlationId, setOutcome);
    recordMetrics();
    return;
  }

  const release = concurrencyLimiter.enter(route);
  if (!release) {
    logger.warn('backpressure.reject', {
      route,
      correlationId,
      active: concurrencyLimiter.active(route),
    });
    respondError(res, 'busy', 'Service is overloaded', correlationId, setOutcome);
    recordMetrics();
    return;
  }

  const { key: rateKey, anonymised } = deriveRateLimitKey(req);
  const rateResult = rateLimiter.check(route, rateKey);
  if (!rateResult.allowed) {
    release();
    if (typeof rateResult.retryAfterSeconds === 'number') {
      res.setHeader('retry-after', rateResult.retryAfterSeconds.toString());
    }
    logger.warn('rate.limit.block', {
      route,
      identity: anonymised,
      retryAfterSeconds: rateResult.retryAfterSeconds,
      correlationId,
    });
    respondError(res, 'too_many_requests', 'Too many requests', correlationId, setOutcome);
    recordMetrics();
    return;
  }

  beginRequest();

  const cleanup = () => {
    try {
      release();
    } finally {
      endRequest();
    }
  };

  handler(setOutcome)
    .catch((err) => {
      const { code, message, details } = classifyError(err);
      const reason = err instanceof Error ? err.message : String(err);
      logger.error('request failure', {
        route,
        correlationId,
        code,
        reason,
        error: err instanceof Error ? err.stack ?? err.message : String(err),
        headers: redact(req.headers as Record<string, unknown>),
      });
      if (!res.headersSent && !res.writableEnded) {
        respondError(res, code, message, correlationId, setOutcome, details);
      }
    })
    .finally(() => {
      try {
        recordMetrics();
      } finally {
        cleanup();
      }
    })
    .catch((err) => {
      logger.error('request finalization failure', {
        route,
        correlationId,
        reason: err instanceof Error ? err.message : String(err),
      });
    });
}

function readRequestBody(req: http.IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    let settled = false;

    const cleanup = () => {
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onError);
    };

    const abort = (err: HttpError) => {
      if (settled) return;
      settled = true;
      cleanup();
      req.on('data', () => {});
      req.resume();
      reject(err);
    };

    const onData = (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      received += buffer.length;
      if (received > maxBytes) {
        abort(new HttpError('payload_too_large', `Payload exceeds limit (${maxBytes} bytes)`));
        return;
      }
      chunks.push(buffer);
    };

    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks));
    };

    const onError = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new HttpError('internal_error', 'Failed to read request body', { reason: err.message }));
    };

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
  });
}

function getHeader(headers: http.IncomingHttpHeaders, name: string): string | undefined {
  const lower = name.toLowerCase();
  const raw = headers[lower] ?? headers[name];
  if (Array.isArray(raw)) return raw[0];
  if (typeof raw === 'string') return raw;
  return undefined;
}

function normalizeActorType(raw: string | undefined): AuthContext['actor']['type'] | null {
  if (!raw) return null;
  const lower = raw.toLowerCase();
  if (lower === 'patient' || lower === 'practitioner' || lower === 'system') {
    return lower;
  }
  return null;
}

function extractScopes(headers: http.IncomingHttpHeaders): string[] | undefined {
  const scopeHeader = getHeader(headers, 'x-auth-scope');
  if (!scopeHeader) return undefined;
  const scopes = scopeHeader
    .split(/\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return scopes.length > 0 ? scopes : undefined;
}

function buildAuthContext(headers: http.IncomingHttpHeaders): AuthContext | null {
  const actorId = getHeader(headers, 'x-actor-id');
  const actorType = normalizeActorType(getHeader(headers, 'x-actor-type'));
  if (!actorId || !actorType) return null;
  const scope = extractScopes(headers);
  return {
    actor: { type: actorType, id: actorId },
    scope,
  };
}

async function emitAuditEvent(event: ContractAuditEvent): Promise<void> {
  try {
    const env = createEnvelope(Topics.audit.event, event, event.correlationId ?? undefined);
    const headers = env.correlationId ? { 'x-correlation-id': env.correlationId } : undefined;
    await bus.publish(env.topic, env, headers);
  } catch (err) {
    logger.warn('failed to publish audit event', {
      type: event.type,
      correlationId: event.correlationId,
      err: err instanceof Error ? err.message : err,
    });
  }
}

function isAuditOptions(value: unknown): value is AuditRecordOptions {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    Object.prototype.hasOwnProperty.call(candidate, 'details') ||
    Object.prototype.hasOwnProperty.call(candidate, 'actor') ||
    Object.prototype.hasOwnProperty.call(candidate, 'subjectRef') ||
    Object.prototype.hasOwnProperty.call(candidate, 'outcome') ||
    Object.prototype.hasOwnProperty.call(candidate, 'reasonCode')
  );
}

function normalizeAuditOptions(
  value?: AuditRecordOptions | Record<string, unknown> | null
): AuditRecordOptions {
  if (!value) return {};
  if (isAuditOptions(value)) {
    return value as AuditRecordOptions;
  }
  return { details: value as Record<string, unknown> };
}

function formatActorRef(actor: AuthContext['actor'] | null | undefined): string | null {
  if (!actor) return null;
  if (actor.id) {
    const hashed = hashIdentifier(actor.id);
    return hashed ? `${actor.type}#${hashed}` : actor.type;
  }
  return actor.type;
}

function recordAudit(
  type: string,
  correlationId: string | undefined,
  optionsInput: AuditRecordOptions | Record<string, unknown> = {}
): LedgerAuditEvent {
  const options = normalizeAuditOptions(optionsInput);
  const event = createAuditEvent(type, {
    correlationId: correlationId ?? null,
    actorRef: formatActorRef(options.actor ?? null),
    subjectRef: options.subjectRef ?? null,
    outcome: options.outcome ?? 'unknown',
    reasonCode: options.reasonCode ?? null,
    details: options.details ?? null,
  });
  void getAuditLedger()
    .write(event)
    .catch((err) => {
      logger.warn('audit ledger write failed', {
        type,
        correlationId,
        err: err instanceof Error ? err.message : err,
      });
    });
  return event;
}

function recordIdempotencyHit(key: string, correlationId: string | undefined): void {
  logger.info('metric.idempotency.hit', {
    key,
    correlationId,
  });
}

function recordIdempotencyMiss(key: string, correlationId: string | undefined): void {
  logger.info('metric.idempotency.miss', {
    key,
    correlationId,
  });
}

function recordIdempotencyTtl(ttlSeconds: number, correlationId: string | undefined): void {
  logger.info('metric.idempotency.ttl', {
    ttlSeconds,
    correlationId,
  });
}

function classifyErrorCode(err: unknown): string | undefined {
  if (!err) return undefined;
  const code = (err as { code?: string; name?: string }).code ?? (err as { name?: string }).name;
  return code ? String(code).toLowerCase() : undefined;
}

type FeaturePrimitive = string | number | boolean | null;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sanitizeFeatureValue(value: unknown): FeaturePrimitive | undefined {
  if (value === null) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    return trimmed.length > 512 ? trimmed.slice(0, 512) : trimmed;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return undefined;
    return value;
  }
  if (typeof value === 'boolean') return value;
  return undefined;
}

function sanitizeFeatureBag(
  raw: unknown,
  maxEntries = 100
): { bag: Record<string, FeaturePrimitive>; dropped: boolean } {
  if (raw === undefined || raw === null) {
    return { bag: {}, dropped: false };
  }
  if (!isPlainObject(raw)) {
    return { bag: {}, dropped: true };
  }
  const result: Record<string, FeaturePrimitive> = {};
  let dropped = false;
  let count = 0;
  for (const [key, candidate] of Object.entries(raw)) {
    if (count >= maxEntries) {
      dropped = true;
      break;
    }
    const normalizedKey = key.trim();
    if (!normalizedKey || normalizedKey.length > 64) {
      dropped = true;
      continue;
    }
    const sanitizedValue = sanitizeFeatureValue(candidate);
    if (sanitizedValue === undefined) {
      dropped = true;
      continue;
    }
    result[normalizedKey] = sanitizedValue;
    count += 1;
  }
  return { bag: result, dropped };
}

interface FeatureLogEntry {
  source: 'triage' | 'safety';
  entityId?: string | null;
  patientId?: string | null;
  correlationId?: string | null;
  features?: Record<string, FeaturePrimitive> | null;
  metadata?: Record<string, FeaturePrimitive> | null;
  occurredAt?: string | number | Date | null;
}

interface FeatureLogRequestBody {
  source?: unknown;
  entityId?: unknown;
  patientId?: unknown;
  correlationId?: unknown;
  features?: unknown;
  metadata?: unknown;
  recordedAt?: unknown;
}

function buildFeatureLogKey(entry: FeatureLogEntry): string {
  const parts: string[] = [entry.source];
  if (entry.entityId) {
    parts.push(entry.entityId);
  }
  if (entry.correlationId) {
    parts.push(entry.correlationId);
  } else {
    parts.push(String(Date.now()));
  }
  return parts.join(':');
}

async function logFeatureRecord(entry: FeatureLogEntry): Promise<void> {
  if (!isFeatureLoggingEnabled() || !featureStore) {
    return;
  }

  const record = {
    source: entry.source,
    recordedAt: entry.occurredAt ? new Date(entry.occurredAt).toISOString() : new Date().toISOString(),
    correlationId: entry.correlationId ?? null,
    patientId: entry.patientId ?? null,
    metadata: entry.metadata ?? {},
    features: entry.features ?? {},
  } satisfies Record<string, unknown>;

  const key = buildFeatureLogKey(entry);
  try {
    await featureStore.putFeatures(key, record);
    logger.debug('feature record stored', {
      key,
      source: entry.source,
      correlationId: entry.correlationId,
    });
  } catch (err) {
    logger.warn('feature record storage failed', {
      key,
      source: entry.source,
      correlationId: entry.correlationId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export function getFeatureStoreForTest(): FeatureStore | null {
  return featureStore;
}

export function setFeatureStoreForTest(store: FeatureStore | null): void {
  featureStore = store;
}

export function getObjectStoreForTest(): ObjectStore | null {
  return objectStore;
}

export function setObjectStoreForTest(store: ObjectStore | null): void {
  objectStore = store;
}

export function getOidcClientForTest(): OidcClient | null {
  return oidcClient;
}

export function setOidcClientForTest(client: OidcClient | null): void {
  oidcClient = client;
}

async function respondHealth(res: http.ServerResponse): Promise<void> {
  try {
    const dependencies = await collectDependencyHealth();
    const status = computeOverallStatus(dependencies);
    res.statusCode = status === 'error' ? 503 : 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ status, dependencies }));
  } catch (error) {
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        status: 'error',
        message: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}

async function respondReady(res: http.ServerResponse): Promise<void> {
  try {
    const dependencies = await collectDependencyHealth();
    const dependenciesStatus = computeOverallStatus(dependencies);
    const previousBusReady = busReady;
    const readiness = evaluateBusReadiness();
    busReady = readiness.ready;
    if (!busReady && previousBusReady) {
      logger.error('bus readiness degraded', {
        reason: readiness.reason,
        health: readiness.health ?? { mode: 'memory' },
      });
    } else if (busReady && !previousBusReady) {
      logger.info('bus readiness restored', {
        health: readiness.health ?? { mode: 'memory' },
      });
    }
    const draining = shuttingDown;
    const ready = busReady && dependenciesStatus !== 'error' && !draining;
    res.statusCode = ready ? 200 : 503;
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        status: ready ? 'ready' : 'not_ready',
        bus: readiness.health
          ? {
              connected: readiness.health.isConnected,
              backpressure: readiness.health.backpressure,
              pendingLag: readiness.health.pendingLag,
              inFlight: readiness.health.inFlight,
              subscribed: readiness.health.subscribed,
              reason: readiness.reason,
            }
          : { mode: 'memory', connected: true, reason: readiness.reason },
        dependencies,
        dependenciesStatus,
        draining,
      }),
    );
  } catch (error) {
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        status: 'not_ready',
        message: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}

const server = http.createServer((req, res) => withCorrelationContext(() => {
  if (!req.url) {
    res.statusCode = 400;
    res.end('Bad Request');
    return;
  }
  const corr = cidFromHeaders(req.headers);
  setCorrelationId(corr);
  if (req.url === '/health') {
    void respondHealth(res);
    return;
  }
  if (req.url === '/ready' || req.url === '/readyz') {
    void respondReady(res);
    return;
  }
  let parsedUrl: URL | null = null;
  try {
    parsedUrl = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  } catch {
    res.statusCode = 400;
    res.end('Bad Request');
    return;
  }

  if (req.method === 'GET' && parsedUrl.pathname === '/metrics') {
    res.statusCode = 200;
    res.setHeader('content-type', 'text/plain; version=0.0.4');
    res.end(renderPrometheusMetrics());
    return;
  }

  if (req.method === 'GET' && parsedUrl.pathname === '/booking/slots') {
    const routeLabel = 'GET /booking/slots';
    handleHttp(req, res, routeLabel, corr, async (setOutcome) => {
      const security = getSecurityServices();
      const requestId = getHeader(req.headers, 'x-request-id') ?? corr;
      const authHeader = getHeader(req.headers, 'authorization');
      const authContext = buildAuthContext(req.headers);
      const deny = async (
        reason: GateDenialReason,
        extraDetails: Record<string, unknown> = {},
        overrides: Partial<AuditRecordOptions> = {},
      ): Promise<void> => {
        logger.warn('booking slots denied', {
          reason,
          correlationId: corr,
          requestId,
          actorType: authContext?.actor?.type,
          actorScope: authContext?.scope,
        });
        const auditDetails = {
          reason,
          requestId,
          scope: authContext?.scope,
          ...extraDetails,
        } satisfies Record<string, unknown>;
        const auditEvent = recordAudit(AUDIT_DENIED_TYPE, corr, {
          actor: authContext?.actor ?? null,
          subjectRef: overrides.subjectRef ?? null,
          outcome: 'deny',
          reasonCode: reason,
          details: auditDetails,
        });
        await emitAuditEvent(auditEvent);
        respondError(res, 'forbidden', 'Access denied', corr, setOutcome);
      };

      const fingerprint = `${requestId}:booking:slots`;
      if (!(await security.verifySignatureAndReplayGuard(authHeader, fingerprint))) {
        await deny('signature_invalid', { hasAuthHeader: Boolean(authHeader) });
        return;
      }

      if (!authContext) {
        await deny('actor_missing');
        return;
      }

      const { actor, scope } = authContext;
      const patientIdFromQuery = parsedUrl?.searchParams?.get('patientId') ?? undefined;
      const patientIdHeader = getHeader(req.headers, 'x-patient-id');
      const patientId = patientIdHeader || patientIdFromQuery || undefined;
      const patientRef = safePatientReference(patientId);

      if (actor.type === 'patient' && (!patientId || patientId !== actor.id)) {
        await deny('not_authorized', { reason: 'patient_mismatch' }, { subjectRef: patientRef });
        return;
      }

      if (!(await security.authorize(actor, BOOKING_SCOPE, patientId, scope))) {
        await deny('not_authorized', {}, { subjectRef: patientRef });
        return;
      }

      let consentReference: string | null = null;
      if (patientId) {
        const consentDecision = await security.checkConsent(
          patientId,
          'care',
          Array.from(BOOKING_RESOURCES),
          { correlationId: corr },
        );
        if (!consentDecision.allowed) {
          await deny('consent_denied', { consentReason: consentDecision.reason }, { subjectRef: patientRef });
          return;
        }
        const consentEvidence = consentDecision.evidence ?? getConsentEvidence(patientId, 'care');
        if (!consentEvidence) {
          await deny('consent_denied', { reason: 'consent_evidence_missing' }, { subjectRef: patientRef });
          return;
        }
        consentReference = consentEvidence.reference;
      }

      const bookingAvailabilityBase = resolveBookingAvailabilityBase();
      if (!bookingAvailabilityBase) {
        respondError(res, 'upstream_unavailable', 'Booking availability service not configured', corr, setOutcome);
        return;
      }

      const upstreamUrl = new URL('slots', bookingAvailabilityBase);
      const sanitizedQuery = sanitizeBookingQuery(parsedUrl?.searchParams ?? null);
      upstreamUrl.search = sanitizedQuery.toString();

      const headers: Record<string, string> = {
        accept: 'application/json',
        'x-correlation-id': corr,
      };
      if (authHeader) {
        headers.authorization = authHeader;
      }
      headers['x-practice-id'] = practiceId;
      if (patientId) {
        headers['x-patient-id'] = patientId;
      }

      const controller = new AbortController();
      const configuredBookingTimeout = getBookingAvailabilityTimeoutMs();
      const timeoutMs =
        Number.isFinite(configuredBookingTimeout) && configuredBookingTimeout > 0
          ? configuredBookingTimeout
          : 3000;
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      let upstream: Response;
      try {
        upstream = await fetch(upstreamUrl, {
          method: 'GET',
          headers,
          signal: controller.signal,
          redirect: 'manual',
        });
      } catch (error) {
        if ((error as Error)?.name === 'AbortError') {
          throw new HttpError('upstream_timeout', 'Booking availability request timed out');
        }
        throw new HttpError('upstream_unavailable', 'Booking availability request failed', {
          reason: error instanceof Error ? error.message : String(error),
        });
      } finally {
        clearTimeout(timeoutId);
      }

      const bodyText = await upstream.text();
      res.statusCode = upstream.status;
      res.setHeader('cache-control', 'no-store, max-age=0');
      const upstreamContentType = upstream.headers.get('content-type');
      if (upstreamContentType) {
        res.setHeader('content-type', upstreamContentType);
      } else {
        res.setHeader('content-type', 'application/json');
      }
      const upstreamCorrelation = upstream.headers.get('x-correlation-id');
      if (upstreamCorrelation) {
        res.setHeader('x-upstream-correlation-id', upstreamCorrelation);
      }
      if (corr) {
        res.setHeader('x-correlation-id', corr);
      }
      res.end(bodyText);

      if (!upstream.ok) {
        setOutcome(upstream.status >= 500 ? 'upstream_unavailable' : 'invalid_input');
      } else {
        const patientRefDetail = patientRef;
        const successAuditDetails = {
          patientRef: patientRefDetail,
          actorType: actor.type,
          scope,
          consentReference,
          upstreamStatus: upstream.status,
        } satisfies Record<string, unknown>;
        const auditEvent = recordAudit('orchestrator.booking.proxy', corr, {
          actor: authContext.actor,
          subjectRef: patientRef,
          outcome: 'allow',
          reasonCode: upstream.status >= 400 ? String(upstream.status) : null,
          details: successAuditDetails,
        });
        await emitAuditEvent(auditEvent);
        setOutcome('ok');
      }
    });
    return;
  }

  const clinicianTaskDetailMatch =
    req.method === 'GET' ? /^\/clinician\/tasks\/([^/]+)$/.exec(parsedUrl.pathname ?? '') : null;
  if (clinicianTaskDetailMatch) {
    const taskId = decodeURIComponent(clinicianTaskDetailMatch[1] ?? '').trim();
    const routeLabel = 'GET /clinician/tasks/:id';
    handleHttp(req, res, routeLabel, corr, async (setOutcome) => {
      res.setHeader('cache-control', 'no-store, max-age=0');
      const security = getSecurityServices();
      const requestId = getHeader(req.headers, 'x-request-id') ?? corr ?? randomUUID();
      const authHeader = getHeader(req.headers, 'authorization');
      if (!authHeader) {
        respondError(res, 'unauthorized', 'Authorization header missing', corr, setOutcome);
        return;
      }
      if (!taskId || !TASK_ID_PATTERN.test(taskId)) {
        respondError(res, 'invalid_input', 'Invalid task id', corr, setOutcome);
        return;
      }
      const authContext = buildAuthContext(req.headers);
      if (!authContext) {
        respondError(res, 'unauthorized', 'Actor context missing', corr, setOutcome);
        return;
      }

      const fingerprint = `${requestId}:clinician:task:${taskId}`;
      const signatureOk = await security.verifySignatureAndReplayGuard(authHeader, fingerprint);
      if (!signatureOk) {
        respondError(res, 'unauthorized', 'Signature verification failed', corr, setOutcome);
        return;
      }
      const scopes = authContext.scope;
      if (!(await security.authorize(authContext.actor, CLINICIAN_TASKS_ACTION, undefined, scopes))) {
        respondError(res, 'forbidden', 'Access denied', corr, setOutcome);
        return;
      }

      const readResource = ensureReadResource(fhirRepository, res, corr, setOutcome);
      if (!readResource) {
        return;
      }

      let taskResource: Record<string, unknown>;
      try {
        taskResource = await readResource<Record<string, unknown>>(
          `Task/${encodeURIComponent(taskId)}`,
        );
      } catch (error) {
        const status = extractStatusCode(error);
        if (status === 404) {
          respondError(res, 'not_found', 'Task not found', corr, setOutcome);
          return;
        }
        if (status === 403) {
          respondError(res, 'forbidden', 'Access denied', corr, setOutcome);
          return;
        }
        throw error;
      }

      if (!taskResource || (taskResource.resourceType as string | undefined) !== 'Task') {
        respondError(res, 'not_found', 'Task not found', corr, setOutcome);
        return;
      }

      const owner = (taskResource.owner as Record<string, unknown> | undefined) ?? undefined;
      const ownerRef = owner && typeof owner.reference === 'string' ? owner.reference : undefined;
      const clinicId = extractClinicIdFromOwner(ownerRef);
      if (!clinicId) {
        respondError(res, 'not_found', 'Task not found', corr, setOutcome);
        return;
      }
      if (!hasClinicAccess(scopes, clinicId)) {
        respondError(res, 'forbidden', 'Clinic access denied', corr, setOutcome);
        return;
      }

      const now = Date.now();
      const summary = mapTaskResourceToSummary(taskResource, clinicId, now);
      if (!summary) {
        respondError(res, 'not_found', 'Task not found', corr, setOutcome);
        return;
      }

      const detail = await buildClinicianTaskDetail(taskResource, summary, {
        repository: fhirRepository,
        patientId: summary.patientId,
        requestCorrelationId: corr ?? undefined,
      });

      logger.info('clinician.tasks.detail', {
        taskHash: hashIdentifier(detail.id),
        clinicHash: hashIdentifier(detail.clinicId),
        attachments: detail.attachments?.length ?? 0,
        correlationId: corr,
      });

      respondJson(res, 200, detail, corr, setOutcome);
    });
    return;
  }

  const clinicianTaskAssignMatch =
    req.method === 'POST' ? /^\/clinician\/tasks\/([^/]+)\/assign$/.exec(parsedUrl.pathname ?? '') : null;
  if (clinicianTaskAssignMatch) {
    const taskId = decodeURIComponent(clinicianTaskAssignMatch[1] ?? '').trim();
    const routeLabel = 'POST /clinician/tasks/:id/assign';
    handleHttp(req, res, routeLabel, corr, async (setOutcome) => {
      res.setHeader('cache-control', 'no-store, max-age=0');
      const security = getSecurityServices();
      const requestId = getHeader(req.headers, 'x-request-id') ?? corr ?? randomUUID();
      const authHeader = getHeader(req.headers, 'authorization');
      if (!authHeader) {
        respondError(res, 'unauthorized', 'Authorization header missing', corr, setOutcome);
        return;
      }
      if (!taskId || !TASK_ID_PATTERN.test(taskId)) {
        respondError(res, 'invalid_input', 'Invalid task id', corr, setOutcome);
        return;
      }
      const authContext = buildAuthContext(req.headers);
      if (!authContext) {
        respondError(res, 'unauthorized', 'Actor context missing', corr, setOutcome);
        return;
      }
      if (authContext.actor.type !== 'practitioner') {
        respondError(res, 'invalid_input', 'Only practitioners may assign tasks', corr, setOutcome);
        return;
      }

      const fingerprint = `${requestId}:clinician:task:${taskId}:assign`;
      if (!(await security.verifySignatureAndReplayGuard(authHeader, fingerprint))) {
        respondError(res, 'unauthorized', 'Signature verification failed', corr, setOutcome);
        return;
      }

      const scope = authContext.scope;
      if (!(await security.authorize(authContext.actor, CLINICIAN_TASKS_WRITE_ACTION, undefined, scope))) {
        respondError(res, 'forbidden', 'Access denied', corr, setOutcome);
        return;
      }

      const bodyBuffer = await readRequestBody(req, 4 * 1024);
      let assignBody: unknown = {};
      if (bodyBuffer.length > 0) {
        try {
          assignBody = JSON.parse(bodyBuffer.toString('utf8')) as unknown;
        } catch {
          throw new HttpError('invalid_input', 'Invalid JSON body');
        }
      }
      if (assignBody !== null && typeof assignBody !== 'object') {
        throw new HttpError('invalid_input', 'Invalid request body');
      }
      const assigneeInput = typeof (assignBody as { assignee?: unknown }).assignee === 'string'
        ? ((assignBody as { assignee?: string }).assignee ?? '').trim()
        : undefined;

      const readResource = ensureReadResource(fhirRepository, res, corr, setOutcome);
      if (!readResource) {
        return;
      }

      let taskResource: Record<string, unknown>;
      try {
        taskResource = await readResource<Record<string, unknown>>(`Task/${encodeURIComponent(taskId)}`);
      } catch (error) {
        const status = extractStatusCode(error);
        if (status === 404) {
          respondError(res, 'not_found', 'Task not found', corr, setOutcome);
          return;
        }
        if (status === 403) {
          respondError(res, 'forbidden', 'Access denied', corr, setOutcome);
          return;
        }
        throw error;
      }

      const ownerRef = typeof (taskResource.owner as { reference?: string } | undefined)?.reference === 'string'
        ? (taskResource.owner as { reference?: string }).reference
        : undefined;
      const clinicId = extractClinicIdFromOwner(ownerRef);
      if (!clinicId) {
        respondError(res, 'not_found', 'Task not found', corr, setOutcome);
        return;
      }
      if (!hasClinicAccess(scope, clinicId)) {
        respondError(res, 'forbidden', 'Clinic access denied', corr, setOutcome);
        return;
      }

      const nowEpoch = Date.now();
      const now = new Date(nowEpoch).toISOString();
      const summary = mapTaskResourceToSummary(taskResource, clinicId, nowEpoch);
      if (!summary) {
        respondError(res, 'not_found', 'Task not found', corr, setOutcome);
        return;
      }

      const assignment = buildAssigneeInfo(assigneeInput, authContext.actor);
      if (isTaskAlreadyAssigned(taskResource, assignment)) {
        const detail = await buildClinicianTaskDetail(taskResource, summary, {
          repository: fhirRepository,
          patientId: summary.patientId,
          requestCorrelationId: corr ?? undefined,
        });
        respondJson(res, 200, detail, corr, setOutcome);
        return;
      }

      const updatedResource = applyAssignmentToTask(taskResource, assignment, authContext.actor.id, now);
      const patch = buildTaskAssignmentPatch(taskId, updatedResource);
      try {
        if (typeof fhirRepository.updateTask === 'function') {
          const ifMatch = extractTaskVersion(taskResource);
          await fhirRepository.updateTask(taskId, patch, ifMatch ? { ifMatch } : undefined);
        }
      } catch (error) {
        const mapped = mapFhirPersistenceError(error);
        respondError(res, mapped.code, mapped.message, corr, setOutcome, mapped.details);
        return;
      }

      const updatedSummary = mapTaskResourceToSummary(updatedResource, clinicId, nowEpoch) ?? summary;
      const detail = await buildClinicianTaskDetail(updatedResource, updatedSummary, {
        repository: fhirRepository,
        patientId: summary.patientId,
        requestCorrelationId: corr ?? undefined,
      });

      logger.info('clinician.tasks.assigned', {
        taskHash: hashIdentifier(detail.id),
        clinicHash: hashIdentifier(detail.clinicId),
        assignee: assignment.reference,
        correlationId: corr,
      });

      const auditEvent = recordAudit('clinician.task.assigned', corr, {
        actor: authContext.actor,
        subjectRef: safePatientReference(summary.patientId),
        outcome: 'allow',
        details: {
          taskId: detail.id,
          clinicId: detail.clinicId,
          assigneeReference: assignment.reference,
          assigneeDisplay: assignment.display ?? null,
        },
      });
      await emitAuditEvent(auditEvent);

      respondJson(res, 200, detail, corr, setOutcome);
    });
    return;
  }

  const clinicianTaskUnassignMatch =
    req.method === 'POST' ? /^\/clinician\/tasks\/([^/]+)\/unassign$/.exec(parsedUrl.pathname ?? '') : null;
  if (clinicianTaskUnassignMatch) {
    const taskId = decodeURIComponent(clinicianTaskUnassignMatch[1] ?? '').trim();
    const routeLabel = 'POST /clinician/tasks/:id/unassign';
    handleHttp(req, res, routeLabel, corr, async (setOutcome) => {
      res.setHeader('cache-control', 'no-store, max-age=0');
      const security = getSecurityServices();
      const requestId = getHeader(req.headers, 'x-request-id') ?? corr ?? randomUUID();
      const authHeader = getHeader(req.headers, 'authorization');
      if (!authHeader) {
        respondError(res, 'unauthorized', 'Authorization header missing', corr, setOutcome);
        return;
      }
      if (!taskId || !TASK_ID_PATTERN.test(taskId)) {
        respondError(res, 'invalid_input', 'Invalid task id', corr, setOutcome);
        return;
      }
      const authContext = buildAuthContext(req.headers);
      if (!authContext) {
        respondError(res, 'unauthorized', 'Actor context missing', corr, setOutcome);
        return;
      }
      if (authContext.actor.type !== 'practitioner') {
        respondError(res, 'invalid_input', 'Only practitioners may unassign tasks', corr, setOutcome);
        return;
      }

      const fingerprint = `${requestId}:clinician:task:${taskId}:unassign`;
      if (!(await security.verifySignatureAndReplayGuard(authHeader, fingerprint))) {
        respondError(res, 'unauthorized', 'Signature verification failed', corr, setOutcome);
        return;
      }

      const scope = authContext.scope;
      if (!(await security.authorize(authContext.actor, CLINICIAN_TASKS_WRITE_ACTION, undefined, scope))) {
        respondError(res, 'forbidden', 'Access denied', corr, setOutcome);
        return;
      }

      const readResource = ensureReadResource(fhirRepository, res, corr, setOutcome);
      if (!readResource) {
        return;
      }

      let taskResource: Record<string, unknown>;
      try {
        taskResource = await readResource<Record<string, unknown>>(`Task/${encodeURIComponent(taskId)}`);
      } catch (error) {
        const status = extractStatusCode(error);
        if (status === 404) {
          respondError(res, 'not_found', 'Task not found', corr, setOutcome);
          return;
        }
        if (status === 403) {
          respondError(res, 'forbidden', 'Access denied', corr, setOutcome);
          return;
        }
        throw error;
      }

      const ownerRef = typeof (taskResource.owner as { reference?: string } | undefined)?.reference === 'string'
        ? (taskResource.owner as { reference?: string }).reference
        : undefined;
      const clinicId = extractClinicIdFromOwner(ownerRef);
      if (!clinicId) {
        respondError(res, 'not_found', 'Task not found', corr, setOutcome);
        return;
      }
      if (!hasClinicAccess(scope, clinicId)) {
        respondError(res, 'forbidden', 'Clinic access denied', corr, setOutcome);
        return;
      }

      const nowEpoch = Date.now();
      const now = new Date(nowEpoch).toISOString();
      const summary = mapTaskResourceToSummary(taskResource, clinicId, nowEpoch);
      if (!summary) {
        respondError(res, 'not_found', 'Task not found', corr, setOutcome);
        return;
      }

      if (isTaskUnassigned(taskResource)) {
        const detail = await buildClinicianTaskDetail(taskResource, summary, {
          repository: fhirRepository,
          patientId: summary.patientId,
          requestCorrelationId: corr ?? undefined,
        });
        respondJson(res, 200, detail, corr, setOutcome);
        return;
      }

      const updatedResource = applyUnassignmentToTask(taskResource, authContext.actor.id, now);
      const patch = buildTaskUnassignmentPatch(taskId, updatedResource);
      try {
        if (typeof fhirRepository.updateTask === 'function') {
          const ifMatch = extractTaskVersion(taskResource);
          await fhirRepository.updateTask(taskId, patch, ifMatch ? { ifMatch } : undefined);
        }
      } catch (error) {
        const mapped = mapFhirPersistenceError(error);
        respondError(res, mapped.code, mapped.message, corr, setOutcome, mapped.details);
        return;
      }

      const updatedSummary = mapTaskResourceToSummary(updatedResource, clinicId, nowEpoch) ?? summary;
      const detail = await buildClinicianTaskDetail(updatedResource, updatedSummary, {
        repository: fhirRepository,
        patientId: summary.patientId,
        requestCorrelationId: corr ?? undefined,
      });

      logger.info('clinician.tasks.unassigned', {
        taskHash: hashIdentifier(detail.id),
        clinicHash: hashIdentifier(detail.clinicId),
        correlationId: corr,
      });

      const auditEvent = recordAudit('clinician.task.unassigned', corr, {
        actor: authContext.actor,
        subjectRef: safePatientReference(summary.patientId),
        outcome: 'allow',
        details: {
          taskId: detail.id,
          clinicId: detail.clinicId,
        },
      });
      await emitAuditEvent(auditEvent);

      respondJson(res, 200, detail, corr, setOutcome);
    });
    return;
  }

  const clinicianTaskResolveMatch =
    req.method === 'POST' ? /^\/clinician\/tasks\/([^/]+)\/resolve$/.exec(parsedUrl.pathname ?? '') : null;
  if (clinicianTaskResolveMatch) {
    const taskId = decodeURIComponent(clinicianTaskResolveMatch[1] ?? '').trim();
    const routeLabel = 'POST /clinician/tasks/:id/resolve';
    handleHttp(req, res, routeLabel, corr, async (setOutcome) => {
      res.setHeader('cache-control', 'no-store, max-age=0');
      const security = getSecurityServices();
      const requestId = getHeader(req.headers, 'x-request-id') ?? corr ?? randomUUID();
      const authHeader = getHeader(req.headers, 'authorization');
      if (!authHeader) {
        respondError(res, 'unauthorized', 'Authorization header missing', corr, setOutcome);
        return;
      }
      if (!taskId || !TASK_ID_PATTERN.test(taskId)) {
        respondError(res, 'invalid_input', 'Invalid task id', corr, setOutcome);
        return;
      }
      const authContext = buildAuthContext(req.headers);
      if (!authContext) {
        respondError(res, 'unauthorized', 'Actor context missing', corr, setOutcome);
        return;
      }
      if (authContext.actor.type !== 'practitioner') {
        respondError(res, 'invalid_input', 'Only practitioners may resolve tasks', corr, setOutcome);
        return;
      }

      const fingerprint = `${requestId}:clinician:task:${taskId}:resolve`;
      if (!(await security.verifySignatureAndReplayGuard(authHeader, fingerprint))) {
        respondError(res, 'unauthorized', 'Signature verification failed', corr, setOutcome);
        return;
      }

      const scope = authContext.scope;
      if (!(await security.authorize(authContext.actor, CLINICIAN_TASKS_WRITE_ACTION, undefined, scope))) {
        respondError(res, 'forbidden', 'Access denied', corr, setOutcome);
        return;
      }

      const bodyBuffer = await readRequestBody(req, 8 * 1024);
      let payload: unknown = {};
      if (bodyBuffer.length > 0) {
        try {
          payload = JSON.parse(bodyBuffer.toString('utf8')) as unknown;
        } catch {
          throw new HttpError('invalid_input', 'Invalid JSON body');
        }
      }
      if (!payload || typeof payload !== 'object') {
        throw new HttpError('invalid_input', 'Invalid request body');
      }
      const validation = validate(CLINICIAN_RESOLVE_SCHEMA_ID, payload);
      if (!validation.ok) {
        respondError(res, 'invalid_input', 'Invalid request body', corr, setOutcome, {
          errors: validation.errors.slice(0, 5),
        });
        return;
      }
      const resolveRequest = payload as ResolveRequest;
      const outcome = sanitizeResolutionOutcome(resolveRequest.outcome);
      const note = sanitizeResolutionNote(resolveRequest.note);

      const readResource = ensureReadResource(fhirRepository, res, corr, setOutcome);
      if (!readResource) {
        return;
      }

      let taskResource: Record<string, unknown>;
      try {
        taskResource = await readResource<Record<string, unknown>>(`Task/${encodeURIComponent(taskId)}`);
      } catch (error) {
        const status = extractStatusCode(error);
        if (status === 404) {
          respondError(res, 'not_found', 'Task not found', corr, setOutcome);
          return;
        }
        if (status === 403) {
          respondError(res, 'forbidden', 'Access denied', corr, setOutcome);
          return;
        }
        throw error;
      }

      const ownerRef = typeof (taskResource.owner as { reference?: string } | undefined)?.reference === 'string'
        ? (taskResource.owner as { reference?: string }).reference
        : undefined;
      const clinicId = extractClinicIdFromOwner(ownerRef);
      if (!clinicId) {
        respondError(res, 'not_found', 'Task not found', corr, setOutcome);
        return;
      }
      if (!hasClinicAccess(scope, clinicId)) {
        respondError(res, 'forbidden', 'Clinic access denied', corr, setOutcome);
        return;
      }

      const nowEpoch = Date.now();
      const summary = mapTaskResourceToSummary(taskResource, clinicId, nowEpoch);
      if (!summary) {
        respondError(res, 'not_found', 'Task not found', corr, setOutcome);
        return;
      }

      if (isTaskAlreadyResolved(taskResource, outcome, note)) {
        const detail = await buildClinicianTaskDetail(taskResource, summary, {
          repository: fhirRepository,
          patientId: summary.patientId,
          requestCorrelationId: corr ?? undefined,
        });
        respondJson(res, 200, detail, corr, setOutcome);
        return;
      }

      const nowIso = new Date(nowEpoch).toISOString();
      const updatedResource = applyResolutionToTask(
        taskResource,
        { outcome, note },
        authContext.actor.id,
        nowIso,
      );
      const patch = buildTaskResolutionPatch(taskId, updatedResource);
      try {
        if (typeof fhirRepository.updateTask === 'function') {
          const ifMatch = extractTaskVersion(taskResource);
          await fhirRepository.updateTask(taskId, patch, ifMatch ? { ifMatch } : undefined);
        }
      } catch (error) {
        const mapped = mapFhirPersistenceError(error);
        respondError(res, mapped.code, mapped.message, corr, setOutcome, mapped.details);
        return;
      }

      const updatedSummary = mapTaskResourceToSummary(updatedResource, clinicId, nowEpoch) ?? summary;
      const detail = await buildClinicianTaskDetail(updatedResource, updatedSummary, {
        repository: fhirRepository,
        patientId: summary.patientId,
        requestCorrelationId: corr ?? undefined,
      });

      logger.info('clinician.tasks.resolved', {
        taskHash: hashIdentifier(detail.id),
        clinicHash: hashIdentifier(detail.clinicId),
        outcome,
        correlationId: corr,
      });

      const auditEvent = recordAudit('clinician.task.resolved', corr, {
        actor: authContext.actor,
        subjectRef: safePatientReference(summary.patientId),
        outcome: 'allow',
        details: {
          taskId: detail.id,
          clinicId: detail.clinicId,
          resolveOutcome: outcome,
          noteProvided: Boolean(note),
        },
      });
      await emitAuditEvent(auditEvent);

      respondJson(res, 200, detail, corr, setOutcome);
    });
    return;
  }

  const clinicianTaskScheduleMatch =
    req.method === 'POST' ? /^\/clinician\/tasks\/([^/]+)\/schedule-callback$/.exec(parsedUrl.pathname ?? '') : null;
  if (clinicianTaskScheduleMatch) {
    const taskId = decodeURIComponent(clinicianTaskScheduleMatch[1] ?? '').trim();
    const routeLabel = 'POST /clinician/tasks/:id/schedule-callback';
    handleHttp(req, res, routeLabel, corr, async (setOutcome) => {
      res.setHeader('cache-control', 'no-store, max-age=0');
      const security = getSecurityServices();
      const requestId = getHeader(req.headers, 'x-request-id') ?? corr ?? randomUUID();
      const authHeader = getHeader(req.headers, 'authorization');
      if (!authHeader) {
        respondError(res, 'unauthorized', 'Authorization header missing', corr, setOutcome);
        return;
      }
      if (!taskId || !TASK_ID_PATTERN.test(taskId)) {
        respondError(res, 'invalid_input', 'Invalid task id', corr, setOutcome);
        return;
      }
      const authContext = buildAuthContext(req.headers);
      if (!authContext) {
        respondError(res, 'unauthorized', 'Actor context missing', corr, setOutcome);
        return;
      }
      if (authContext.actor.type !== 'practitioner') {
        respondError(res, 'invalid_input', 'Only practitioners may schedule callbacks', corr, setOutcome);
        return;
      }

      const fingerprint = `${requestId}:clinician:task:${taskId}:schedule-callback`;
      if (!(await security.verifySignatureAndReplayGuard(authHeader, fingerprint))) {
        respondError(res, 'unauthorized', 'Signature verification failed', corr, setOutcome);
        return;
      }

      const scope = authContext.scope;
      if (!(await security.authorize(authContext.actor, CLINICIAN_TASKS_WRITE_ACTION, undefined, scope))) {
        respondError(res, 'forbidden', 'Access denied', corr, setOutcome);
        return;
      }

      const bodyBuffer = await readRequestBody(req, 8 * 1024);
      let payload: unknown = {};
      if (bodyBuffer.length > 0) {
        try {
          payload = JSON.parse(bodyBuffer.toString('utf8')) as unknown;
        } catch {
          throw new HttpError('invalid_input', 'Invalid JSON body');
        }
      }
      if (!payload || typeof payload !== 'object') {
        throw new HttpError('invalid_input', 'Invalid request body');
      }
      const validation = validate(CLINICIAN_SCHEDULE_CALLBACK_SCHEMA_ID, payload);
      if (!validation.ok) {
        respondError(res, 'invalid_input', 'Invalid request body', corr, setOutcome, {
          errors: validation.errors.slice(0, 5),
        });
        return;
      }

      const request = payload as ScheduleCallbackRequest;
      const scheduledAtIso = sanitizeCallbackTimestamp(request.when);
      const callbackWindow = sanitizeCallbackWindow(request.window);
      const callbackNote = sanitizeCallbackUserNote(request.note);

      const readResource = ensureReadResource(fhirRepository, res, corr, setOutcome);
      if (!readResource) {
        return;
      }

      let taskResource: Record<string, unknown>;
      try {
        taskResource = await readResource<Record<string, unknown>>(`Task/${encodeURIComponent(taskId)}`);
      } catch (error) {
        const status = extractStatusCode(error);
        if (status === 404) {
          respondError(res, 'not_found', 'Task not found', corr, setOutcome);
          return;
        }
        if (status === 403) {
          respondError(res, 'forbidden', 'Access denied', corr, setOutcome);
          return;
        }
        throw error;
      }

      const ownerRef = typeof (taskResource.owner as { reference?: string } | undefined)?.reference === 'string'
        ? (taskResource.owner as { reference?: string }).reference
        : undefined;
      const clinicId = extractClinicIdFromOwner(ownerRef);
      if (!clinicId) {
        respondError(res, 'not_found', 'Task not found', corr, setOutcome);
        return;
      }
      if (!hasClinicAccess(scope, clinicId)) {
        respondError(res, 'forbidden', 'Clinic access denied', corr, setOutcome);
        return;
      }

      const nowEpoch = Date.now();
      const summary = mapTaskResourceToSummary(taskResource, clinicId, nowEpoch);
      if (!summary) {
        respondError(res, 'not_found', 'Task not found', corr, setOutcome);
        return;
      }

      const existingSchedule = extractScheduledCallback(taskResource);
      if (existingSchedule) {
        const retryAfterSeconds = computeRetryAfterSeconds(existingSchedule.when, nowEpoch);
        if (retryAfterSeconds !== undefined) {
          res.setHeader('retry-after', retryAfterSeconds.toString());
        }
        respondError(
          res,
          'conflict',
          'Callback already scheduled',
          corr,
          setOutcome,
          {
            scheduledAt: existingSchedule.when,
            window: existingSchedule.window ?? null,
          },
        );
        return;
      }

      const nowIso = new Date(nowEpoch).toISOString();
      const updatedResource = applyScheduleCallbackToTask(
        taskResource,
        { when: scheduledAtIso, window: callbackWindow, note: callbackNote },
        authContext.actor.id,
        nowIso,
      );
      const patch = buildTaskCallbackPatch(taskId, updatedResource);
      try {
        if (typeof fhirRepository.updateTask === 'function') {
          const ifMatch = extractTaskVersion(taskResource);
          await fhirRepository.updateTask(taskId, patch, ifMatch ? { ifMatch } : undefined);
        }
      } catch (error) {
        const mapped = mapFhirPersistenceError(error);
        respondError(res, mapped.code, mapped.message, corr, setOutcome, mapped.details);
        return;
      }

      const updatedSummary = mapTaskResourceToSummary(updatedResource, clinicId, nowEpoch) ?? summary;
      const detail = await buildClinicianTaskDetail(updatedResource, updatedSummary, {
        repository: fhirRepository,
        patientId: summary.patientId,
        requestCorrelationId: corr ?? undefined,
      });

      logger.info('clinician.tasks.callback_scheduled', {
        taskHash: hashIdentifier(detail.id),
        clinicHash: hashIdentifier(detail.clinicId),
        when: scheduledAtIso,
        window: callbackWindow ?? null,
        noteProvided: Boolean(callbackNote),
        correlationId: corr,
      });

      const auditEvent = recordAudit('clinician.task.callback_scheduled', corr, {
        actor: authContext.actor,
        subjectRef: safePatientReference(summary.patientId),
        outcome: 'allow',
        details: {
          taskId: detail.id,
          clinicId: detail.clinicId,
          scheduledAt: scheduledAtIso,
          window: callbackWindow ?? null,
          noteProvided: Boolean(callbackNote),
        },
      });
      await emitAuditEvent(auditEvent);

      respondJson(res, 200, detail, corr, setOutcome);
    });
    return;
  }

  const clinicianTaskBookMatch =
    req.method === 'POST' ? /^\/clinician\/tasks\/([^/]+)\/book-slot$/.exec(parsedUrl.pathname ?? '') : null;
  if (clinicianTaskBookMatch) {
    const taskId = decodeURIComponent(clinicianTaskBookMatch[1] ?? '').trim();
    const routeLabel = 'POST /clinician/tasks/:id/book-slot';
    handleHttp(req, res, routeLabel, corr, async (setOutcome) => {
      res.setHeader('cache-control', 'no-store, max-age=0');
      const security = getSecurityServices();
      const requestId = getHeader(req.headers, 'x-request-id') ?? corr ?? randomUUID();
      const authHeader = getHeader(req.headers, 'authorization');
      if (!authHeader) {
        respondError(res, 'unauthorized', 'Authorization header missing', corr, setOutcome);
        return;
      }
      if (!taskId || !TASK_ID_PATTERN.test(taskId)) {
        respondError(res, 'invalid_input', 'Invalid task id', corr, setOutcome);
        return;
      }
      const authContext = buildAuthContext(req.headers);
      if (!authContext) {
        respondError(res, 'unauthorized', 'Actor context missing', corr, setOutcome);
        return;
      }
      if (authContext.actor.type !== 'practitioner') {
        respondError(res, 'invalid_input', 'Only practitioners may book slots', corr, setOutcome);
        return;
      }
      const bookingServiceBase = resolveBookingServiceBase();
      if (!bookingServiceBase) {
        respondError(res, 'upstream_unavailable', 'Booking service not configured', corr, setOutcome);
        return;
      }

      const fingerprint = `${requestId}:clinician:task:${taskId}:book-slot`;
      if (!(await security.verifySignatureAndReplayGuard(authHeader, fingerprint))) {
        respondError(res, 'unauthorized', 'Signature verification failed', corr, setOutcome);
        return;
      }

      const scope = authContext.scope;
      if (!(await security.authorize(authContext.actor, CLINICIAN_TASKS_WRITE_ACTION, undefined, scope))) {
        respondError(res, 'forbidden', 'Access denied', corr, setOutcome);
        return;
      }

      const bodyBuffer = await readRequestBody(req, 8 * 1024);
      let payload: unknown = {};
      if (bodyBuffer.length > 0) {
        try {
          payload = JSON.parse(bodyBuffer.toString('utf8')) as unknown;
        } catch {
          throw new HttpError('invalid_input', 'Invalid JSON body');
        }
      }
      if (!payload || typeof payload !== 'object') {
        throw new HttpError('invalid_input', 'Invalid request body');
      }
      const validation = validate(CLINICIAN_BOOK_SLOT_SCHEMA_ID, payload);
      if (!validation.ok) {
        respondError(res, 'invalid_input', 'Invalid request body', corr, setOutcome, {
          errors: validation.errors.slice(0, 5),
        });
        return;
      }
      const request = payload as BookSlotRequest;

      const readResource = ensureReadResource(fhirRepository, res, corr, setOutcome);
      if (!readResource) {
        return;
      }

      let taskResource: Record<string, unknown>;
      try {
        taskResource = await readResource<Record<string, unknown>>(`Task/${encodeURIComponent(taskId)}`);
      } catch (error) {
        const status = extractStatusCode(error);
        if (status === 404) {
          respondError(res, 'not_found', 'Task not found', corr, setOutcome);
          return;
        }
        if (status === 403) {
          respondError(res, 'forbidden', 'Access denied', corr, setOutcome);
          return;
        }
        throw error;
      }

      const ownerRef = typeof (taskResource.owner as { reference?: string } | undefined)?.reference === 'string'
        ? (taskResource.owner as { reference?: string }).reference
        : undefined;
      const clinicId = extractClinicIdFromOwner(ownerRef);
      if (!clinicId) {
        respondError(res, 'not_found', 'Task not found', corr, setOutcome);
        return;
      }
      if (!hasClinicAccess(scope, clinicId)) {
        respondError(res, 'forbidden', 'Clinic access denied', corr, setOutcome);
        return;
      }

      const nowEpoch = Date.now();
      const summary = mapTaskResourceToSummary(taskResource, clinicId, nowEpoch);
      if (!summary) {
        respondError(res, 'not_found', 'Task not found', corr, setOutcome);
        return;
      }

      const slot = extractBookingSlot(taskResource, request.slotId);
      if (!slot) {
        respondError(res, 'invalid_input', 'Slot details missing on task', corr, setOutcome);
        return;
      }

      if (request.modality) {
        slot.modality = request.modality;
      }
      if (request.location) {
        slot.location = request.location;
      }

      const bookingUrl = new URL('booking/appointments', bookingServiceBase);
      const bookingPayload = {
        slot,
        patientId: summary.patientId,
        originatingTaskId: taskId,
        idempotencyKey: `clinician:${taskId}:${slot.id}`,
      };

      const bookingHeaders: Record<string, string> = {
        accept: 'application/json',
        'content-type': 'application/json',
        'x-correlation-id': corr,
        'x-idempotency-key': bookingPayload.idempotencyKey,
      };
      if (authHeader) {
        bookingHeaders.authorization = authHeader;
      }
      bookingHeaders['x-clinic-id'] = clinicId;

      const controller = new AbortController();
      const timeoutMs = Math.min(getBookingAvailabilityTimeoutMs(), 10_000);
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      let upstream: Response;
      try {
        upstream = await fetch(bookingUrl, {
          method: 'POST',
          headers: bookingHeaders,
          body: JSON.stringify(bookingPayload),
          signal: controller.signal,
          redirect: 'manual',
        });
      } catch (error) {
        clearTimeout(timeoutId);
        if (error instanceof Error && error.name === 'AbortError') {
          respondError(res, 'upstream_timeout', 'Booking service request timed out', corr, setOutcome);
          return;
        }
        respondError(res, 'upstream_unavailable', 'Booking service request failed', corr, setOutcome, {
          reason: error instanceof Error ? error.message : String(error),
        });
        return;
      } finally {
        clearTimeout(timeoutId);
      }

      const upstreamBodyText = await upstream.text();
      let upstreamBody: Record<string, unknown> | null = null;
      if (upstreamBodyText.length > 0) {
        try {
          upstreamBody = JSON.parse(upstreamBodyText) as Record<string, unknown>;
        } catch {
          upstreamBody = null;
        }
      }

      if (upstream.status === 409) {
        const retryAfter = upstream.headers.get('retry-after');
        if (retryAfter) {
          res.setHeader('retry-after', retryAfter);
        }
        respondError(
          res,
          'conflict',
          'Appointment slot already booked',
          corr,
          setOutcome,
          upstreamBody ?? undefined,
        );
        return;
      }
      if (upstream.status === 429) {
        const retryAfter = upstream.headers.get('retry-after');
        if (retryAfter) {
          res.setHeader('retry-after', retryAfter);
        }
        respondError(res, 'too_many_requests', 'Booking service rate limited the request', corr, setOutcome, upstreamBody ?? undefined);
        return;
      }
      if (!upstream.ok) {
        respondError(
          res,
          upstream.status >= 500 ? 'upstream_unavailable' : 'invalid_input',
          'Booking service rejected the request',
          corr,
          setOutcome,
          upstreamBody ?? undefined,
        );
        return;
      }

      const appointmentId =
        (upstreamBody?.appointmentId as string | undefined) ?? `appt-${slot.id}`;
      const nowIso = new Date(nowEpoch).toISOString();
      const updatedResource = applyBookSlotToTask(
        taskResource,
        {
          appointmentId,
          slotId: slot.id,
          modality: slot.modality,
          location: slot.location,
        },
        authContext.actor.id,
        nowIso,
      );
      const patch = buildTaskBookingPatch(taskId, updatedResource);
      try {
        if (typeof fhirRepository.updateTask === 'function') {
          const ifMatch = extractTaskVersion(taskResource);
          await fhirRepository.updateTask(taskId, patch, ifMatch ? { ifMatch } : undefined);
        }
      } catch (error) {
        const mapped = mapFhirPersistenceError(error);
        respondError(res, mapped.code, mapped.message, corr, setOutcome, mapped.details);
        return;
      }

      const updatedSummary = mapTaskResourceToSummary(updatedResource, clinicId, nowEpoch) ?? summary;
      const detail = await buildClinicianTaskDetail(updatedResource, updatedSummary, {
        repository: fhirRepository,
        patientId: summary.patientId,
        requestCorrelationId: corr ?? undefined,
      });

      logger.info('clinician.tasks.slot_booked', {
        taskHash: hashIdentifier(detail.id),
        clinicHash: hashIdentifier(detail.clinicId),
        appointmentId,
        slotId: slot.id,
        correlationId: corr,
      });

      const auditEvent = recordAudit('clinician.task.slot_booked', corr, {
        actor: authContext.actor,
        subjectRef: safePatientReference(summary.patientId),
        outcome: 'allow',
        details: {
          taskId: detail.id,
          clinicId: detail.clinicId,
          appointmentId,
          slotId: slot.id,
        },
      });
      await emitAuditEvent(auditEvent);

      respondJson(res, 200, detail, corr, setOutcome);
    });
    return;
  }

  if (req.method === 'GET' && parsedUrl.pathname === '/clinician/tasks') {
    const routeLabel = 'GET /clinician/tasks';
    handleHttp(req, res, routeLabel, corr, async (setOutcome) => {
      res.setHeader('cache-control', 'no-store, max-age=0');
      const security = getSecurityServices();
      const requestId = getHeader(req.headers, 'x-request-id') ?? corr ?? randomUUID();
      const authHeader = getHeader(req.headers, 'authorization');
      if (!authHeader) {
        respondError(res, 'unauthorized', 'Authorization header missing', corr, setOutcome);
        return;
      }
      const authContext = buildAuthContext(req.headers);
      if (!authContext) {
        respondError(res, 'unauthorized', 'Actor context missing', corr, setOutcome);
        return;
      }

      const rawClinicId = parsedUrl.searchParams.get('clinicId') ?? '';
      const fingerprint = `${requestId}:clinician:tasks:${rawClinicId}`;
      const signatureOk = await security.verifySignatureAndReplayGuard(authHeader, fingerprint);
      if (!signatureOk) {
        respondError(res, 'unauthorized', 'Signature verification failed', corr, setOutcome);
        return;
      }

      let query: ClinicianTasksQuery;
      try {
        query = parseClinicianTasksQuery(parsedUrl.searchParams, authContext.actor);
      } catch (error) {
        if (error instanceof HttpError) {
          respondError(res, error.code, error.message, corr, setOutcome);
          return;
        }
        throw error;
      }

      const scopes = authContext.scope;
      if (!(await security.authorize(authContext.actor, CLINICIAN_TASKS_ACTION, undefined, scopes))) {
        respondError(res, 'forbidden', 'Access denied', corr, setOutcome);
        return;
      }
      if (!hasClinicAccess(scopes, query.clinicId)) {
        respondError(res, 'forbidden', 'Clinic access denied', corr, setOutcome);
        return;
      }
      if (query.cursorClinicId && query.cursorClinicId !== query.clinicId) {
        respondError(res, 'invalid_input', 'Cursor does not match clinic scope', corr, setOutcome);
        return;
      }

      const searchPath = query.cursorPath ?? buildClinicianTaskSearchPath(query);
      const readResource = ensureReadResource(fhirRepository, res, corr, setOutcome);
      if (!readResource) {
        return;
      }

      const bundle = await readResource<FhirBundle>(searchPath);
      const now = Date.now();
      const summaries = mapBundleToClinicianSummaries(bundle, query.clinicId, now);
      const nextCursor = extractNextCursor(bundle);

      logger.info('clinician.tasks.listed', {
        clinicHash: hashIdentifier(query.clinicId),
        count: summaries.length,
        correlationId: corr,
      });

      const responseBody: { items: ClinicianTaskSummary[]; nextCursor?: string } = {
        items: summaries,
      };
      if (nextCursor) {
        responseBody.nextCursor = nextCursor;
      }

      respondJson(res, 200, responseBody, corr, setOutcome);
    });
    return;
  }

  if (req.method === 'GET' && parsedUrl.pathname === '/clinician/tasks') {
    const routeLabel = 'GET /clinician/tasks';
    handleHttp(req, res, routeLabel, corr, async (setOutcome) => {
      res.setHeader('cache-control', 'no-store, max-age=0');
      const security = getSecurityServices();
      const requestId = getHeader(req.headers, 'x-request-id') ?? corr ?? randomUUID();
      const authHeader = getHeader(req.headers, 'authorization');
      if (!authHeader) {
        respondError(res, 'unauthorized', 'Authorization header missing', corr, setOutcome);
        return;
      }
      const authContext = buildAuthContext(req.headers);
      if (!authContext) {
        respondError(res, 'unauthorized', 'Actor context missing', corr, setOutcome);
        return;
      }

      const rawClinicId = parsedUrl.searchParams.get('clinicId') ?? '';
      const fingerprint = `${requestId}:clinician:tasks:${rawClinicId}`;
      const signatureOk = await security.verifySignatureAndReplayGuard(authHeader, fingerprint);
      if (!signatureOk) {
        respondError(res, 'unauthorized', 'Signature verification failed', corr, setOutcome);
        return;
      }

      let query: ClinicianTasksQuery;
      try {
        query = parseClinicianTasksQuery(parsedUrl.searchParams, authContext.actor);
      } catch (error) {
        if (error instanceof HttpError) {
          respondError(res, error.code, error.message, corr, setOutcome);
          return;
        }
        throw error;
      }

      const scopes = authContext.scope;
      if (!(await security.authorize(authContext.actor, CLINICIAN_TASKS_ACTION, undefined, scopes))) {
        respondError(res, 'forbidden', 'Access denied', corr, setOutcome);
        return;
      }
      if (!hasClinicAccess(scopes, query.clinicId)) {
        respondError(res, 'forbidden', 'Clinic access denied', corr, setOutcome);
        return;
      }
      if (query.cursorClinicId && query.cursorClinicId !== query.clinicId) {
        respondError(res, 'invalid_input', 'Cursor does not match clinic scope', corr, setOutcome);
        return;
      }

      const searchPath = query.cursorPath ?? buildClinicianTaskSearchPath(query);
      const readResource = ensureReadResource(fhirRepository, res, corr, setOutcome);
      if (!readResource) {
        return;
      }

      const bundle = await readResource<FhirBundle>(searchPath);
      const now = Date.now();
      const summaries = mapBundleToClinicianSummaries(bundle, query.clinicId, now);
      const nextCursor = extractNextCursor(bundle);

      logger.info('clinician.tasks.listed', {
        clinicHash: hashIdentifier(query.clinicId),
        count: summaries.length,
        correlationId: corr,
      });

      const responseBody: { items: ClinicianTaskSummary[]; nextCursor?: string } = {
        items: summaries,
      };
      if (nextCursor) {
        responseBody.nextCursor = nextCursor;
      }

      respondJson(res, 200, responseBody, corr, setOutcome);
    });
    return;
  }

  if (req.method === 'POST' && parsedUrl.pathname === '/feature-log') {
    const routeLabel = 'POST /feature-log';
    handleHttp(req, res, routeLabel, corr, async (setOutcome) => {
      if (!isFeatureLoggingEnabled() || !featureStore) {
        res.statusCode = 202;
        if (corr) {
          res.setHeader('x-correlation-id', corr);
        }
        res.end('feature logging disabled');
        return;
      }

      const security = getSecurityServices();
      const authContext = buildAuthContext(req.headers);
      const deny = async (
        reason: string,
        code: ErrorCode = 'forbidden',
        extraDetails: Record<string, unknown> = {},
        overrides: Partial<AuditRecordOptions> = {},
      ): Promise<void> => {
        const auditDetails = {
          reason,
          scope: extractScopes(req.headers),
          ...extraDetails,
        } satisfies Record<string, unknown>;
        const auditEvent = recordAudit('orchestrator.feature_log.denied', corr, {
          actor: authContext?.actor ?? null,
          subjectRef: overrides.subjectRef ?? null,
          outcome: 'deny',
          reasonCode: reason,
          details: auditDetails,
        });
        await emitAuditEvent(auditEvent);
        respondError(res, code, code === 'forbidden' ? 'Access denied' : 'Invalid request', corr, setOutcome, auditDetails);
      };

      const expectedApiKey = (process.env.FEATURE_LOG_API_KEY ?? '').trim();
      if (!expectedApiKey) {
        await deny('feature_log_api_key_missing', 'upstream_unavailable');
        return;
      }
      const providedApiKey = getHeader(req.headers, 'x-api-key')?.trim();
      if (!providedApiKey || providedApiKey !== expectedApiKey) {
        await deny('invalid_api_key');
        return;
      }

      const scopes = extractScopes(req.headers) ?? [];
      if (!scopes.includes(FEATURE_LOG_SCOPE) && !scopes.includes('*')) {
        await deny('missing_scope', 'forbidden', { requiredScope: FEATURE_LOG_SCOPE });
        return;
      }

      const consentReferenceHeader = getHeader(req.headers, 'x-consent-reference');
      if (!consentReferenceHeader || consentReferenceHeader.trim().length === 0) {
        await deny('missing_consent_reference');
        return;
      }

      const rawBuf = await readRequestBody(req, 64 * 1024);
      let payload: FeatureLogRequestBody;
      try {
        payload = JSON.parse(rawBuf.toString('utf8')) as FeatureLogRequestBody;
      } catch {
        throw new HttpError('invalid_input', 'Invalid JSON body');
      }

      if (!payload || typeof payload !== 'object') {
        throw new HttpError('invalid_input', 'Invalid request body');
      }

      const source = payload.source;
      if (source !== 'triage' && source !== 'safety') {
        throw new HttpError('invalid_input', 'Invalid source');
      }

      const entityId = typeof payload.entityId === 'string' && payload.entityId.trim().length > 0 ? payload.entityId : null;
      const patientIdRaw =
        typeof payload.patientId === 'string' && payload.patientId.trim().length > 0
          ? payload.patientId
          : entityId;
      const patientId = patientIdRaw ?? null;
      if (!patientId) {
        await deny('patient_id_missing', 'invalid_input');
        return;
      }
      const patientRef = safePatientReference(patientId);
      const correlationId =
        typeof payload.correlationId === 'string' && payload.correlationId.trim().length > 0 ? payload.correlationId : corr;

      const consentDecision = await security.checkConsent(
        patientId,
        FEATURE_LOG_PURPOSE,
        Array.from(FEATURE_LOG_RESOURCES),
        { correlationId },
      );
      if (!consentDecision.allowed) {
        await deny('consent_denied', 'forbidden', { consentReason: consentDecision.reason }, { subjectRef: patientRef });
        return;
      }
      const consentEvidence = consentDecision.evidence ?? getConsentEvidence(patientId, FEATURE_LOG_PURPOSE);
      if (!consentEvidence || consentEvidence.reference !== consentReferenceHeader) {
        await deny('consent_mismatch', 'forbidden', { consentReference: consentEvidence?.reference ?? null }, { subjectRef: patientRef });
        return;
      }

      const hasFeaturesInput = payload.features !== undefined && payload.features !== null;
      const hasMetadataInput = payload.metadata !== undefined && payload.metadata !== null;

      const {
        bag: features,
        dropped: featuresDropped,
      } = sanitizeFeatureBag(payload.features, 100);
      if (hasFeaturesInput && featuresDropped) {
        throw new HttpError('invalid_input', 'Invalid features payload');
      }

      const {
        bag: metadataBag,
        dropped: metadataDropped,
      } = sanitizeFeatureBag(payload.metadata, 50);
      if (hasMetadataInput && metadataDropped) {
        throw new HttpError('invalid_input', 'Invalid metadata payload');
      }

      const metadata = {
        ...metadataBag,
        consentReference: consentEvidence.reference,
      } as Record<string, FeaturePrimitive>;

      let recordedAt: string | number | undefined;
      if (typeof payload.recordedAt === 'string' || typeof payload.recordedAt === 'number') {
        recordedAt = payload.recordedAt;
      }

      await logFeatureRecord({
        source,
        entityId,
        patientId,
        correlationId,
        features,
        metadata,
        occurredAt: recordedAt ?? Date.now(),
      });

      const successAuditDetails = {
        source,
        patientRef,
        consentReference: consentEvidence.reference,
        scope: scopes,
      } satisfies Record<string, unknown>;
      const auditEvent = recordAudit('orchestrator.feature_log.accepted', corr, {
        actor: authContext?.actor ?? null,
        subjectRef: patientRef,
        outcome: 'allow',
        reasonCode: 'accepted',
        details: successAuditDetails,
      });
      await emitAuditEvent(auditEvent);

      res.statusCode = 202;
      if (corr) {
        res.setHeader('x-correlation-id', corr);
      }
      res.end('accepted');
      setOutcome('ok');
    });
    return;
  }
  if (req.method === 'POST' && parsedUrl.pathname === '/safety-check') {
    const routeLabel = 'POST /safety-check';
    handleHttp(req, res, routeLabel, corr, async (setOutcome) => {
      if (!busReady) {
        req.resume();
        respondError(res, 'upstream_unavailable', 'Event bus unavailable', corr, setOutcome);
        return;
      }

      const ctype = (req.headers['content-type'] || '').toString().toLowerCase();
      if (!ctype.includes('application/json')) {
        req.resume();
        respondError(res, 'unsupported_media_type', 'Only application/json is supported', corr, setOutcome);
        return;
      }

      const maxBytes = resolveMaxBodyBytes();
      const rawBuf = await readRequestBody(req, maxBytes);

      const raw = rawBuf.toString('utf8');
      let submission: PortalSubmission;
      try {
        submission = JSON.parse(raw) as PortalSubmission;
      } catch {
        throw new HttpError('invalid_input', 'Invalid JSON body');
      }

      const validation = validatePortalSubmission(submission);
      if (validation.ok !== true) {
        const primaryError = validation.errors[0]?.message;
        respondError(
          res,
          'invalid_input',
          primaryError ? `Invalid request body: ${primaryError}` : 'Invalid request body',
          corr,
          setOutcome,
          { errors: validation.errors.slice(0, 5) }
        );
        return;
      }

      sanitizeInboundSubmission(submission);

      const security = getSecurityServices();
      const requestId = getHeader(req.headers, 'x-request-id') ?? corr;
      const authHeader = getHeader(req.headers, 'authorization');
      const authContext = buildAuthContext(req.headers);
      const explicitKeyHeader = req.headers['x-idempotency-key'];
      const explicitKeyRaw = Array.isArray(explicitKeyHeader) ? explicitKeyHeader[0] : explicitKeyHeader;
      const explicitKey = normalizeExplicitIdempotencyKey(explicitKeyRaw);
      const idemKey = deriveIdempotencyKey(submission, authContext?.actor?.id, explicitKey);
      const replayFingerprint = `${requestId}:${idemKey}`;

      res.setHeader('x-idempotency-key', idemKey);
      logger.info('idempotency.key.derived', { key: idemKey, correlationId: corr });

      const practiceConfigSnapshot = currentPracticeConfig();
      const safetyGateTimeoutMs = getSafetyGateTimeoutMs();
      const safetyGateFallbackMode = getSafetyGateFallbackMode();
      const shadowSafetyGate = getShadowSafetyGate();
      const idempotencyTtlSeconds = getIdempotencyTtlSeconds();

      if (submission.practiceId !== practiceConfigSnapshot.practiceId) {
        logger.warn('submission.practice_mismatch', {
          expectedPractice: practiceConfigSnapshot.practiceId,
          receivedPractice: submission.practiceId,
          correlationId: corr,
        });
        respondError(res, 'forbidden', 'Practice mismatch', corr, setOutcome);
        return;
      }

      const orchestratorContext: OrchestratorContext = {
        id: requestId,
        correlationId: corr,
        requestId,
        submission,
        practiceId: practiceConfigSnapshot.practiceId,
        authHeader,
        authContext,
        actor: authContext?.actor ?? undefined,
        scope: authContext?.scope ?? undefined,
        replayFingerprint,
        security: {
          verifySignatureAndReplayGuard: security.verifySignatureAndReplayGuard,
          authorize: security.authorize,
          checkConsent: security.checkConsent,
        },
        consentPurpose: 'care',
        consentResources: CONSENT_RESOURCES,
        resolveConsentEvidence: getConsentEvidence,
        consentEvidence: undefined,
        setOutcome,
        safetyGateOptions: {
          requestId,
          actor: authContext?.actor ?? undefined,
          scope: authContext?.scope,
        },
        callGuard: callWithGuard,
        analyzeSubmission: analyzePortalSubmission,
        safetyGuardOptions: {
          timeoutMs: safetyGateTimeoutMs,
          maxRetries: 1,
          baseDelayMs: 10,
          correlationId: corr,
        },
        safetyFallbackMode: safetyGateFallbackMode,
        shadowSafetyGate,
        decision: undefined,
        idempotencyStore,
        idempotencyKey: idemKey,
        idempotencyTtlSeconds,
        idempotencyReserved: false,
        recordIdempotencyHit,
        recordIdempotencyMiss,
        recordIdempotencyTtl,
        fhirRepository,
        fhirBundle: undefined,
        mapFhirError: mapFhirPersistenceError,
        bus,
        triageTopic: Topics.triage.input,
        busHeaders: undefined,
        busPublishOptions: {
          timeoutMs: busPublishTimeoutMs,
          maxRetries: busPublishMaxRetries,
          baseDelayMs: busPublishBackoffMs,
        },
        emitAudit: async (type, options) => {
          const normalized = normalizeAuditOptions(options);
          const resolved: AuditRecordOptions = {
            actor: normalized.actor ?? authContext?.actor ?? null,
            subjectRef: normalized.subjectRef ?? null,
            outcome: normalized.outcome ?? 'unknown',
            reasonCode: normalized.reasonCode ?? null,
            details: normalized.details ?? null,
          };
          const event = createAuditEvent(type, {
            correlationId: corr ?? null,
            actorRef: formatActorRef(resolved.actor ?? null),
            subjectRef: resolved.subjectRef,
            outcome: resolved.outcome,
            reasonCode: resolved.reasonCode,
            details: resolved.details,
          });
          await emitAuditEvent(event);
        },
        recordAudit: (type, options) => {
          const normalized = normalizeAuditOptions(options);
          const resolved: AuditRecordOptions = {
            actor: normalized.actor ?? authContext?.actor ?? null,
            subjectRef: normalized.subjectRef ?? null,
            outcome: normalized.outcome ?? 'unknown',
            reasonCode: normalized.reasonCode ?? null,
            details: normalized.details ?? null,
          };
          return recordAudit(type, corr, resolved);
        },
        result: undefined,
        classifyErrorCode,
      };

      try {
        const machine = buildOrchestratorMachine(orchestratorContext);
        await runOrchestratorMachine(machine);
        if (!orchestratorContext.result) {
          throw new HttpError('internal_error', 'Safety decision missing');
        }
        respondJson(res, 200, orchestratorContext.result, corr, setOutcome, 'ok');
        return;
      } catch (err) {
        if (orchestratorContext.idempotencyReserved) {
          try {
            await releaseIdempotency(idempotencyStore, idemKey);
            logger.info('idempotency.released', { key: idemKey, correlationId: corr });
          } catch (releaseError) {
            logger.warn('idempotency.release_failed', {
              key: idemKey,
              correlationId: corr,
              reason: releaseError instanceof Error ? releaseError.message : releaseError,
            });
          } finally {
            orchestratorContext.idempotencyReserved = false;
          }
        }
        const { code, message, details } = classifyError(err);
        respondError(res, code, message, corr, setOutcome, details);
        return;
      }
    });
    return;
  }
  res.statusCode = 200;
  if (corr) {
    res.setHeader('x-correlation-id', corr);
  }
  res.end('orchestrator skeleton');
}));

server.on('clientError', (err, socket) => {
  logger.warn('http.client_error', {
    reason: err instanceof Error ? err.message : String(err),
  });
  const envelope = errorEnvelope('invalid_input', 'Invalid HTTP request', undefined, undefined);
  const body = JSON.stringify(envelope);
  const response = [
    'HTTP/1.1 400 Bad Request',
    'Content-Type: application/json',
    `Content-Length: ${Buffer.byteLength(body)}`,
    'Connection: close',
    '',
    body,
  ].join('\r\n');
  socket.end(response);
});

if (process.env.NODE_ENV !== 'test') {
  const shutdownSignals: Array<NodeJS.Signals> = ['SIGTERM', 'SIGINT'];
  shutdownSignals.forEach((signal) => {
    process.once(signal, () => {
      void initiateShutdown(signal).finally(() => {
        process.exit(0);
      });
    });
  });

  server.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`orchestrator listening on :${port}`);
  });
}

interface ClinicianTasksQuery {
  clinicId: string;
  limit: number;
  priorityCode?: string;
  statusCode?: string;
  fromIso?: string;
  toIso?: string;
  performerRef?: string;
  performerMissing?: boolean;
  cursorPath?: string;
  cursorClinicId?: string;
}

const PRIORITY_REQUEST_TO_FHIR: Record<string, string> = {
  STAT: 'stat',
  URGENT: 'urgent',
  SOON: 'asap',
  ROUTINE: 'routine',
};

const FHIR_PRIORITY_TO_RESPONSE: Record<string, ClinicianTaskSummary['priority']> = {
  stat: 'STAT',
  urgent: 'URGENT',
  asap: 'SOON',
  routine: 'ROUTINE',
};

const STATUS_REQUEST_TO_FHIR: Record<string, string> = {
  NEW: 'requested',
  IN_PROGRESS: 'in-progress',
  DONE: 'completed',
};

const FHIR_STATUS_TO_RESPONSE: Record<string, ClinicianTaskSummary['status']> = {
  requested: 'NEW',
  accepted: 'IN_PROGRESS',
  'in-progress': 'IN_PROGRESS',
  'on-hold': 'IN_PROGRESS',
  ready: 'IN_PROGRESS',
  completed: 'DONE',
  cancelled: 'DONE',
  'entered-in-error': 'DONE',
  failed: 'DONE',
};

function parseClinicianTasksQuery(params: URLSearchParams, actor: AuthContext['actor']): ClinicianTasksQuery {
  const clinicIdRaw = (params.get('clinicId') ?? '').trim();
  if (!clinicIdRaw || !CLINIC_ID_PATTERN.test(clinicIdRaw)) {
    throw new HttpError('invalid_input', 'clinicId is required');
  }
  const clinicId = clinicIdRaw;
  const limit = parseLimit(params.get('limit'));

  const priorityParam = params.get('priority');
  let priorityCode: string | undefined;
  if (priorityParam) {
    const upper = priorityParam.trim().toUpperCase();
    const mapped = PRIORITY_REQUEST_TO_FHIR[upper];
    if (!mapped) {
      throw new HttpError('invalid_input', 'Invalid priority filter');
    }
    priorityCode = mapped;
  }

  const statusParam = params.get('status');
  let statusCode: string | undefined;
  if (statusParam) {
    const upper = statusParam.trim().toUpperCase();
    const mapped = STATUS_REQUEST_TO_FHIR[upper];
    if (!mapped) {
      throw new HttpError('invalid_input', 'Invalid status filter');
    }
    statusCode = mapped;
  }

  const fromIso = parseDateParam(params.get('from'), 'from');
  const toIso = parseDateParam(params.get('to'), 'to');
  if (fromIso && toIso && new Date(fromIso).getTime() > new Date(toIso).getTime()) {
    throw new HttpError('invalid_input', '`from` must not be later than `to`');
  }

  const assigneeParam = (params.get('assignee') ?? 'any').trim().toLowerCase();
  let performerRef: string | undefined;
  let performerMissing: boolean | undefined;
  if (assigneeParam === 'me') {
    if (!actor?.id || actor.type !== 'practitioner') {
      throw new HttpError('invalid_input', 'assignee=me requires practitioner actor');
    }
    performerRef = `Practitioner/${actor.id}`;
  } else if (assigneeParam === 'unassigned') {
    performerMissing = true;
  } else if (assigneeParam === 'any' || assigneeParam === '') {
    // no-op
  } else {
    throw new HttpError('invalid_input', 'Invalid assignee filter');
  }

  const cursorParam = params.get('cursor');
  let cursorPath: string | undefined;
  let cursorClinicId: string | undefined;
  if (cursorParam) {
    cursorPath = decodeCursor(cursorParam);
    cursorClinicId = extractClinicIdFromCursor(cursorPath);
    if (!cursorClinicId) {
      throw new HttpError('invalid_input', 'Invalid cursor value');
    }
  }

  return {
    clinicId,
    limit,
    priorityCode,
    statusCode,
    fromIso,
    toIso,
    performerRef,
    performerMissing,
    cursorPath,
    cursorClinicId,
  };
}

function parseLimit(raw: string | null): number {
  if (!raw) {
    return DEFAULT_CLINICIAN_TASK_LIMIT;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new HttpError('invalid_input', 'limit must be a positive integer');
  }
  return Math.max(1, Math.min(Math.floor(parsed), MAX_CLINICIAN_TASK_LIMIT));
}

function parseDateParam(raw: string | null, field: 'from' | 'to'): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const date = new Date(trimmed);
  if (Number.isNaN(date.getTime())) {
    throw new HttpError('invalid_input', `Invalid ${field} timestamp`);
  }
  return date.toISOString();
}

function decodeCursor(cursor: string): string {
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8').trim();
    if (!decoded || !decoded.startsWith('Task')) {
      throw new Error('invalid cursor path');
    }
    return decoded;
  } catch {
    throw new HttpError('invalid_input', 'Invalid cursor value');
  }
}

function encodeCursor(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function normalizeFhirLink(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  const trimmed = url.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    const path = parsed.pathname.replace(/^\//, '');
    return path ? `${path}${parsed.search}` : parsed.search ? parsed.search.replace(/^\?/, '') : null;
  } catch {
    return trimmed.replace(/^\//, '') || null;
  }
}

function extractClinicIdFromCursor(path: string): string | undefined {
  const queryIndex = path.indexOf('?');
  const search = queryIndex >= 0 ? path.slice(queryIndex + 1) : path;
  const params = new URLSearchParams(search);
  const owners = params.getAll('owner');
  for (const owner of owners) {
    const clinicId = extractClinicIdFromOwner(owner);
    if (clinicId) {
      return clinicId;
    }
  }
  return undefined;
}

function extractClinicIdFromOwner(owner: string | undefined): string | null {
  if (!owner) return null;
  const trimmed = owner.trim();
  if (!trimmed) return null;
  const normalized = trimmed.startsWith('Organization/') ? trimmed.slice('Organization/'.length) : trimmed;
  if (!normalized || !CLINIC_ID_PATTERN.test(normalized)) {
    return null;
  }
  return normalized;
}

function hasClinicAccess(scope: string[] | undefined, clinicId: string): boolean {
  const normalizedClinic = clinicId.trim().toLowerCase();
  if (!normalizedClinic) return false;
  const scopeSet = new Set<string>(
    (scope ?? []).map((entry) => entry.trim().toLowerCase()).filter((entry) => entry.length > 0),
  );
  if (scopeSet.has('*')) return true;
  if (scopeSet.has(`${CLINIC_SCOPE_PREFIX}${normalizedClinic}`)) return true;
  if (scopeSet.has(`${CLINIC_SCOPE_PREFIX}*`)) return true;
  return false;
}

function buildClinicianTaskSearchPath(query: ClinicianTasksQuery): string {
  const params: string[] = [
    `_count=${query.limit}`,
    '_format=json',
    `_sort=${TASK_SEARCH_SORT}`,
    `owner=${encodeURIComponent(`Organization/${query.clinicId}`)}`,
  ];
  if (query.priorityCode) {
    params.push(`priority=${encodeURIComponent(query.priorityCode)}`);
  }
  if (query.statusCode) {
    params.push(`status=${encodeURIComponent(query.statusCode)}`);
  }
  if (query.fromIso) {
    params.push(`authored-on=ge${encodeURIComponent(query.fromIso)}`);
  }
  if (query.toIso) {
    params.push(`authored-on=le${encodeURIComponent(query.toIso)}`);
  }
  if (query.performerRef) {
    params.push(`performer=${encodeURIComponent(query.performerRef)}`);
  }
  if (query.performerMissing === true) {
    params.push('performer:missing=true');
  }
  return params.length > 0 ? `Task?${params.join('&')}` : 'Task';
}

function extractStatusCode(error: unknown): number | undefined {
  if (isFhirRequestError(error)) {
    return error.status;
  }
  if (error && typeof error === 'object' && 'status' in (error as Record<string, unknown>)) {
    const candidate = (error as { status?: unknown }).status;
    if (typeof candidate === 'number') {
      return candidate;
    }
  }
  return undefined;
}

const MAX_DETAIL_ATTACHMENTS = 8;
const MAX_ACTIONS_ALLOWED = 16;
const MAX_AUDIT_ENTRIES = 20;
const CORRELATION_ID_MIN_LENGTH = 6;
const CORRELATION_ID_MAX_LENGTH = 128;

async function buildClinicianTaskDetail(
  resource: Record<string, unknown>,
  summary: ClinicianTaskSummary,
  options: {
    repository: FhirRepository;
    patientId: string;
    requestCorrelationId?: string;
  },
): Promise<ClinicianTaskDetail> {
  const narrative = extractTaskNarrative(resource, summary.shortReason);
  const correlationCandidate =
    extractTaskCorrelationId(resource) ??
    sanitizeCorrelationId(options.requestCorrelationId) ??
    `task-${summary.id}`;
  const correlationId = sanitizeCorrelationId(correlationCandidate) ?? `task-${summary.id}`;
  const audit = extractTaskAudit(resource);
  const attachments = await collectTaskAttachments(resource, options.repository, options.patientId);
  const actionsAllowed: ClinicianTaskDetail['actionsAllowed'] = determineActionsAllowed(summary);
  return {
    ...summary,
    narrative,
    attachments: attachments.length > 0 ? attachments : undefined,
    actionsAllowed,
    audit,
    correlationId,
  };
}

function extractTaskNarrative(resource: Record<string, unknown>, fallback: string): string {
  const notes = Array.isArray(resource.note) ? resource.note : [];
  for (const note of notes) {
    if (!note || typeof note !== 'object') continue;
    const entry = note as Record<string, unknown>;
    const candidate = entry.text;
    if (typeof candidate === 'string') {
      const text = candidate.trim();
      if (!text) continue;
      return safeTruncate(text, 500_000);
    }
  }
  const description = typeof resource.description === 'string' ? resource.description.trim() : '';
  if (description) {
    return safeTruncate(description, 500_000);
  }
  return fallback;
}

function sanitizeCorrelationId(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (trimmed.length < CORRELATION_ID_MIN_LENGTH) {
    return undefined;
  }
  return safeTruncate(trimmed, CORRELATION_ID_MAX_LENGTH);
}

function extractTaskCorrelationId(resource: Record<string, unknown>): string | undefined {
  const identifiers = Array.isArray(resource.identifier) ? resource.identifier : [];
  for (const identifier of identifiers) {
    if (!identifier || typeof identifier !== 'object') continue;
    const entry = identifier as Record<string, unknown>;
    const value = typeof entry.value === 'string' ? entry.value.trim() : '';
    if (!value) continue;
    const system = typeof entry.system === 'string' ? entry.system.toLowerCase() : '';
    if (!system || system.includes('correlation')) {
      return safeTruncate(value, CORRELATION_ID_MAX_LENGTH);
    }
  }
  const extensions = Array.isArray(resource.extension) ? resource.extension : [];
  for (const extension of extensions) {
    if (!extension || typeof extension !== 'object') continue;
    const entry = extension as Record<string, unknown>;
    const url = typeof entry.url === 'string' ? entry.url.toLowerCase() : '';
    const valueString = typeof entry.valueString === 'string' ? entry.valueString.trim() : '';
    if (valueString && url.includes('correlation')) {
      return safeTruncate(valueString, CORRELATION_ID_MAX_LENGTH);
    }
  }
  return undefined;
}

function extractTaskAudit(resource: Record<string, unknown>): ClinicianTaskDetail['audit'] {
  const notes = Array.isArray(resource.note) ? resource.note : [];
  const audit: ClinicianTaskDetail['audit'] = [];
  for (const note of notes) {
    if (!note || typeof note !== 'object') continue;
    const entry = note as Record<string, unknown>;
    const text = typeof entry.text === 'string' ? entry.text.trim() : '';
    if (!text) continue;
    const when = coerceIsoTimestamp(typeof entry.time === 'string' ? entry.time : undefined);
    if (!when) continue;
    const who = extractNoteAuthor(entry);
    audit.push({
      when,
      who,
      what: safeTruncate(text, 256),
    });
    if (audit.length >= MAX_AUDIT_ENTRIES) {
      break;
    }
  }
  return audit;
}

function extractNoteAuthor(note: Record<string, unknown>): string {
  const authorString = typeof note.authorString === 'string' ? note.authorString.trim() : '';
  if (authorString) {
    return safeTruncate(authorString, 64);
  }
  const authorReference = note.authorReference as Record<string, unknown> | undefined;
  if (authorReference && typeof authorReference === 'object') {
    const display = typeof authorReference.display === 'string' ? authorReference.display.trim() : '';
    if (display) {
      return safeTruncate(display, 64);
    }
    const reference = typeof authorReference.reference === 'string' ? authorReference.reference.trim() : '';
    if (reference) {
      return safeTruncate(reference, 64);
    }
  }
  return 'system';
}

function determineActionsAllowed(summary: ClinicianTaskSummary): ClinicianTaskDetail['actionsAllowed'] {
  const actions: string[] = [];
  const add = (action: string) => {
    if (!actions.includes(action) && actions.length < MAX_ACTIONS_ALLOWED) {
      actions.push(action);
    }
  };
  if (summary.status !== 'DONE') {
    add('CALL');
    add('SCHEDULE');
    add('RESOLVE');
    if (summary.priority === 'STAT' || summary.priority === 'URGENT') {
      add('ESCALATE');
    }
    if (summary.status === 'NEW') {
      add('ASSIGN');
    } else if (summary.status === 'IN_PROGRESS') {
      if (summary.assignee) {
        add('UNASSIGN');
      } else {
        add('ASSIGN');
      }
    }
  }
  return actions as ClinicianTaskDetail['actionsAllowed'];
}

interface AssigneeInfo {
  reference: string;
  display?: string;
}

function buildAssigneeInfo(requested: string | undefined, actor: AuthContext['actor']): AssigneeInfo {
  if (actor.type !== 'practitioner') {
    throw new HttpError('invalid_input', 'Only practitioners may assign tasks');
  }
  const referenceBase = `Practitioner/${actor.id}`;
  if (!requested) {
    return { reference: referenceBase, display: actor.id };
  }
  const trimmed = requested.trim();
  if (!trimmed) {
    return { reference: referenceBase, display: actor.id };
  }
  if (/^[A-Za-z]+\/[A-Za-z0-9._-]{1,64}$/.test(trimmed)) {
    return { reference: trimmed };
  }
  return { reference: referenceBase, display: safeTruncate(trimmed, 64) };
}

function isTaskAlreadyAssigned(resource: Record<string, unknown>, assignment: AssigneeInfo): boolean {
  const status = typeof resource.status === 'string' ? resource.status.trim().toLowerCase() : '';
  if (status !== 'in-progress') {
    return false;
  }
  const performers = Array.isArray(resource.performer) ? (resource.performer as Array<Record<string, unknown>>) : [];
  if (performers.length === 0) {
    return false;
  }
  const first = performers[0] ?? {};
  const actor = (first.actor as Record<string, unknown> | undefined) ?? {};
  const referenceCandidate =
    typeof actor.reference === 'string'
      ? actor.reference.trim()
      : typeof first.reference === 'string'
        ? first.reference.trim()
        : undefined;
  if (referenceCandidate && referenceCandidate.toLowerCase() !== assignment.reference.toLowerCase()) {
    return false;
  }
  if (!assignment.display) {
    return Boolean(referenceCandidate);
  }
  const displayCandidate =
    typeof actor.display === 'string'
      ? actor.display.trim()
      : typeof first.display === 'string'
        ? first.display.trim()
        : undefined;
  if (!displayCandidate) {
    return false;
  }
  return displayCandidate.toLowerCase() === assignment.display.toLowerCase();
}

function isTaskUnassigned(resource: Record<string, unknown>): boolean {
  const status = typeof resource.status === 'string' ? resource.status.trim().toLowerCase() : '';
  const performers = Array.isArray(resource.performer) ? resource.performer : [];
  return (status === 'requested' || status === 'draft') && performers.length === 0;
}

function applyAssignmentToTask(
  resource: Record<string, unknown>,
  assignment: AssigneeInfo,
  actorId: string,
  timestamp: string,
): Record<string, unknown> {
  const clone = structuredClone(resource) as Record<string, unknown>;
  clone.status = 'in-progress';
  clone.lastModified = timestamp;
  clone.performer = [
    {
      actor: {
        reference: assignment.reference,
        ...(assignment.display ? { display: assignment.display } : {}),
      },
      ...(assignment.display ? { display: assignment.display } : {}),
    },
  ];
  clone.note = appendTaskNoteEntries(clone.note, {
    text: `assign:${assignment.display ?? assignment.reference}`,
    time: timestamp,
    authorString: actorId,
  });
  updateTaskMetaLastUpdated(clone, timestamp);
  return clone;
}

function applyUnassignmentToTask(resource: Record<string, unknown>, actorId: string, timestamp: string): Record<string, unknown> {
  const clone = structuredClone(resource) as Record<string, unknown>;
  clone.status = 'requested';
  clone.lastModified = timestamp;
  clone.performer = [];
  clone.note = appendTaskNoteEntries(clone.note, {
    text: `unassign:${actorId}`,
    time: timestamp,
    authorString: actorId,
  });
  updateTaskMetaLastUpdated(clone, timestamp);
  return clone;
}

function appendTaskNoteEntries(existing: unknown, entry: Record<string, unknown>): Array<Record<string, unknown>> {
  const notes = Array.isArray(existing)
    ? (structuredClone(existing) as Array<Record<string, unknown>>)
    : [];
  notes.push(entry);
  return notes.slice(-MAX_AUDIT_ENTRIES);
}

function updateTaskMetaLastUpdated(resource: Record<string, unknown>, timestamp: string): void {
  const currentMeta = (resource.meta as Record<string, unknown> | undefined) ?? {};
  const meta = { ...currentMeta, lastUpdated: timestamp };
  resource.meta = meta;
}

function buildTaskAssignmentPatch(taskId: string, resource: Record<string, unknown>): Record<string, unknown> {
  const patch: Record<string, unknown> = {
    resourceType: 'Task',
    id: taskId,
    status: resource.status,
    performer: resource.performer,
    note: resource.note,
    lastModified: resource.lastModified,
  };
  if (resource.meta) {
    patch.meta = resource.meta;
  }
  return patch;
}

function buildTaskUnassignmentPatch(taskId: string, resource: Record<string, unknown>): Record<string, unknown> {
  const patch: Record<string, unknown> = {
    resourceType: 'Task',
    id: taskId,
    status: resource.status,
    performer: [],
    note: resource.note,
    lastModified: resource.lastModified,
  };
  if (resource.meta) {
    patch.meta = resource.meta;
  }
  return patch;
}

function sanitizeResolutionOutcome(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new HttpError('invalid_input', 'Outcome must not be empty');
  }
  return safeTruncate(trimmed, 64);
}

function sanitizeResolutionNote(value: string | undefined): string | undefined {
  if (value === undefined || value === null) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return safeTruncate(trimmed, 500);
}

function formatResolutionNote(outcome: string, note: string | undefined): string {
  if (note) {
    return `resolve:${outcome}:${note}`;
  }
  return `resolve:${outcome}`;
}

function isTaskAlreadyResolved(resource: Record<string, unknown>, outcome: string, note: string | undefined): boolean {
  const status = typeof resource.status === 'string' ? resource.status.trim().toLowerCase() : '';
  if (status !== 'completed') {
    return false;
  }
  const businessStatus = resource.businessStatus as Record<string, unknown> | undefined;
  const businessText =
    typeof businessStatus?.text === 'string' ? businessStatus.text.trim() : undefined;
  if ((businessText ?? '') !== outcome) {
    return false;
  }
  const notes = Array.isArray(resource.note) ? (resource.note as Array<Record<string, unknown>>) : [];
  const expected = formatResolutionNote(outcome, note);
  for (const entry of notes) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const rawText = record.text;
    if (typeof rawText !== 'string') continue;
    const text = rawText.trim();
    if (!text) continue;
    if (text === expected) return true;
  }
  return false;
}

function applyResolutionToTask(
  resource: Record<string, unknown>,
  resolution: { outcome: string; note?: string },
  actorId: string,
  timestamp: string,
): Record<string, unknown> {
  const clone = structuredClone(resource) as Record<string, unknown>;
  clone.status = 'completed';
  clone.statusReason = { text: resolution.outcome };
  clone.businessStatus = { text: resolution.outcome };
  clone.lastModified = timestamp;
  const noteEntry = {
    text: formatResolutionNote(resolution.outcome, resolution.note),
    time: timestamp,
    authorString: actorId,
  };
  clone.note = appendTaskNoteEntries(clone.note, noteEntry);
  updateTaskMetaLastUpdated(clone, timestamp);
  return clone;
}

function buildTaskResolutionPatch(taskId: string, resource: Record<string, unknown>): Record<string, unknown> {
  const patch: Record<string, unknown> = {
    resourceType: 'Task',
    id: taskId,
    status: resource.status,
    businessStatus: resource.businessStatus,
    statusReason: resource.statusReason,
    note: resource.note,
    lastModified: resource.lastModified,
  };
  if (resource.meta) {
    patch.meta = resource.meta;
  }
  return patch;
}

interface ScheduledCallbackInfo {
  when: string;
  window?: string;
  note?: string;
}

function sanitizeCallbackTimestamp(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new HttpError('invalid_input', 'Invalid callback timestamp');
  }
  return parsed.toISOString();
}

function sanitizeCallbackWindow(value: string | undefined): string | undefined {
  if (value === undefined || value === null) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return safeTruncate(trimmed, 64);
}

function sanitizeCallbackUserNote(value: string | undefined): string | undefined {
  if (value === undefined || value === null) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return safeTruncate(trimmed, 500);
}

function formatCallbackAnnotation(info: ScheduledCallbackInfo): string {
  return `callback:${JSON.stringify({
    when: info.when,
    window: info.window ?? null,
    note: info.note ?? null,
  })}`;
}

function parseCallbackAnnotation(text: string): ScheduledCallbackInfo | null {
  if (!text.startsWith('callback:')) return null;
  const payload = text.slice('callback:'.length);
  try {
    const parsed = JSON.parse(payload) as { when?: string; window?: string | null; note?: string | null };
    if (!parsed || typeof parsed.when !== 'string') {
      return null;
    }
    return {
      when: parsed.when,
      window: typeof parsed.window === 'string' ? parsed.window : undefined,
      note: typeof parsed.note === 'string' ? parsed.note : undefined,
    };
  } catch {
    return null;
  }
}

function extractScheduledCallback(resource: Record<string, unknown>): ScheduledCallbackInfo | null {
  const notes = Array.isArray(resource.note) ? (resource.note as Array<Record<string, unknown>>) : [];
  for (const entry of notes) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const rawText = record.text;
    if (typeof rawText !== 'string') continue;
    const text = rawText.trim();
    if (!text) continue;
    const parsed = parseCallbackAnnotation(text);
    if (parsed) {
      return parsed;
    }
  }
  return null;
}

function applyScheduleCallbackToTask(
  resource: Record<string, unknown>,
  schedule: { when: string; window?: string; note?: string },
  actorId: string,
  timestamp: string,
): Record<string, unknown> {
  const clone = structuredClone(resource) as Record<string, unknown>;
  clone.status = 'in-progress';
  clone.businessStatus = { text: 'callback_scheduled' };
  clone.lastModified = timestamp;
  const noteEntry = {
    text: formatCallbackAnnotation(schedule),
    time: timestamp,
    authorString: actorId,
  };
  clone.note = appendTaskNoteEntries(clone.note, noteEntry);
  updateTaskMetaLastUpdated(clone, timestamp);
  return clone;
}

function buildTaskCallbackPatch(taskId: string, resource: Record<string, unknown>): Record<string, unknown> {
  const patch: Record<string, unknown> = {
    resourceType: 'Task',
    id: taskId,
    status: resource.status,
    businessStatus: resource.businessStatus,
    note: resource.note,
    lastModified: resource.lastModified,
  };
  if (resource.meta) {
    patch.meta = resource.meta;
  }
  return patch;
}

function computeRetryAfterSeconds(whenIso: string, nowEpoch: number): number | undefined {
  const target = Date.parse(whenIso);
  if (!Number.isFinite(target)) return undefined;
  const diffSeconds = Math.ceil((target - nowEpoch) / 1000);
  if (diffSeconds <= 0) return undefined;
  return Math.min(diffSeconds, 24 * 60 * 60);
}

interface BookingSlotDetails {
  id: string;
  start: string;
  end: string;
  organisationId: string;
  serviceType?: string;
  modality?: string;
  location?: string;
}

function extractBookingSlot(resource: Record<string, unknown>, expectedSlotId: string): BookingSlotDetails | null {
  const inputs = Array.isArray(resource.input) ? (resource.input as Array<Record<string, unknown>>) : [];
  for (const entry of inputs) {
    const valueString = typeof entry.valueString === 'string' ? entry.valueString : undefined;
    if (!valueString) continue;
    try {
      const parsed = JSON.parse(valueString) as Partial<BookingSlotDetails>;
      if (parsed && parsed.id === expectedSlotId && parsed.start && parsed.end && parsed.organisationId) {
        return {
          id: parsed.id,
          start: parsed.start,
          end: parsed.end,
          organisationId: parsed.organisationId,
          serviceType: parsed.serviceType,
          modality: parsed.modality,
          location: parsed.location,
        };
      }
    } catch {
      continue;
    }
  }
  return null;
}

interface AppointmentBookingInfo {
  appointmentId: string;
  slotId: string;
  modality?: string;
  location?: string;
}

function applyBookSlotToTask(
  resource: Record<string, unknown>,
  booking: AppointmentBookingInfo,
  actorId: string,
  timestamp: string,
): Record<string, unknown> {
  const clone = structuredClone(resource) as Record<string, unknown>;
  clone.status = 'in-progress';
  clone.businessStatus = { text: 'appointment_booked' };
  clone.lastModified = timestamp;
  clone.output = appendAppointmentOutput(clone.output, booking.appointmentId);
  const noteEntry = {
    text: formatBookingNote(booking),
    time: timestamp,
    authorString: actorId,
  };
  clone.note = appendTaskNoteEntries(clone.note, noteEntry);
  updateTaskMetaLastUpdated(clone, timestamp);
  return clone;
}

function buildTaskBookingPatch(taskId: string, resource: Record<string, unknown>): Record<string, unknown> {
  const patch: Record<string, unknown> = {
    resourceType: 'Task',
    id: taskId,
    status: resource.status,
    businessStatus: resource.businessStatus,
    note: resource.note,
    output: resource.output,
    lastModified: resource.lastModified,
  };
  if (resource.meta) {
    patch.meta = resource.meta;
  }
  return patch;
}

function appendAppointmentOutput(existing: unknown, appointmentId: string): Array<Record<string, unknown>> {
  const entries = Array.isArray(existing)
    ? (structuredClone(existing) as Array<Record<string, unknown>>)
    : [];
  entries.push({
    type: { text: 'Appointment' },
    valueReference: { reference: `Appointment/${appointmentId}` },
    valueString: appointmentId,
  });
  return entries.slice(-MAX_DETAIL_ATTACHMENTS);
}

function formatBookingNote(booking: AppointmentBookingInfo): string {
  return `book:${JSON.stringify({
    appointmentId: booking.appointmentId,
    slotId: booking.slotId,
    modality: booking.modality ?? null,
    location: booking.location ?? null,
  })}`;
}

function extractTaskVersion(resource: Record<string, unknown>): string | undefined {
  const meta = resource.meta as Record<string, unknown> | undefined;
  const version = typeof meta?.versionId === 'string' ? meta.versionId.trim() : undefined;
  if (!version) return undefined;
  return `W/"${version}"`;
}

async function collectTaskAttachments(
  resource: Record<string, unknown>,
  repository: FhirRepository,
  patientId: string,
): Promise<Array<{ contentType: string; url: string }>> {
  const attachments: Array<{ contentType: string; url: string }> = [];
  const seenUrls = new Set<string>();
  const containedDocs = collectContainedResources(resource, 'DocumentReference');
  const targets = extractDocumentReferenceTargets(resource);
  const readResource = typeof repository.readResource === 'function'
    ? (repository.readResource.bind(repository) as NonNullable<FhirRepository['readResource']>)
    : null;
  for (const id of targets.containedIds) {
    if (attachments.length >= MAX_DETAIL_ATTACHMENTS) break;
    const doc = containedDocs.get(id);
    if (!doc) continue;
    const mapped = mapDocumentReferenceToAttachments(
      doc,
      patientId,
      seenUrls,
      MAX_DETAIL_ATTACHMENTS - attachments.length,
    );
    attachments.push(...mapped);
  }
  if (!readResource) {
    return attachments;
  }

  for (const path of targets.externalRefs) {
    if (attachments.length >= MAX_DETAIL_ATTACHMENTS) break;
    try {
      const doc = await readResource<Record<string, unknown>>(path);
      if (!doc || (doc.resourceType as string | undefined) !== 'DocumentReference') {
        continue;
      }
      const mapped = mapDocumentReferenceToAttachments(
        doc,
        patientId,
        seenUrls,
        MAX_DETAIL_ATTACHMENTS - attachments.length,
      );
      attachments.push(...mapped);
    } catch (error) {
      if (isFhirRequestError(error)) {
        if (error.status === 404 || error.status === 403) {
          continue;
        }
      }
      logger.warn('clinician.tasks.detail.attachment_fetch_failed', {
        documentHash: hashIdentifier(path),
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return attachments.slice(0, MAX_DETAIL_ATTACHMENTS);
}

function extractDocumentReferenceTargets(resource: Record<string, unknown>): {
  containedIds: Set<string>;
  externalRefs: string[];
} {
  const containedIds = new Set<string>();
  const external = new Set<string>();

  const collect = (raw: unknown) => {
    if (typeof raw !== 'string') return;
    const trimmed = raw.trim();
    if (!trimmed) return;
    if (trimmed.startsWith('#')) {
      const id = trimmed.slice(1);
      if (id) containedIds.add(id);
      return;
    }
    const normalized = normalizeReference(trimmed, 'DocumentReference');
    if (normalized) {
      external.add(normalized);
    }
  };

  const supportingInfo = resource.supportingInfo;
  if (Array.isArray(supportingInfo)) {
    for (const entry of supportingInfo) {
      if (!entry || typeof entry !== 'object') continue;
      collect((entry as Record<string, unknown>).reference);
    }
  }

  const input = resource.input;
  if (Array.isArray(input)) {
    for (const entry of input) {
      if (!entry || typeof entry !== 'object') continue;
      const valueReference = (entry as Record<string, unknown>).valueReference as Record<string, unknown> | undefined;
      if (valueReference && typeof valueReference.reference === 'string') {
        collect(valueReference.reference);
      }
    }
  }

  const output = resource.output;
  if (Array.isArray(output)) {
    for (const entry of output) {
      if (!entry || typeof entry !== 'object') continue;
      const valueReference = (entry as Record<string, unknown>).valueReference as Record<string, unknown> | undefined;
      if (valueReference && typeof valueReference.reference === 'string') {
        collect(valueReference.reference);
      }
    }
  }

  return {
    containedIds,
    externalRefs: Array.from(external).slice(0, MAX_DETAIL_ATTACHMENTS),
  };
}

function collectContainedResources(
  resource: Record<string, unknown>,
  resourceType: string,
): Map<string, Record<string, unknown>> {
  const map = new Map<string, Record<string, unknown>>();
  const contained = resource.contained;
  if (!Array.isArray(contained)) return map;
  for (const entry of contained) {
    if (!entry || typeof entry !== 'object') continue;
    const candidate = entry as Record<string, unknown>;
    const type = typeof candidate.resourceType === 'string' ? candidate.resourceType : '';
    if (type !== resourceType) continue;
    const id = typeof candidate.id === 'string' ? candidate.id.trim() : '';
    if (!id) continue;
    map.set(id, candidate);
  }
  return map;
}

function mapDocumentReferenceToAttachments(
  doc: Record<string, unknown>,
  patientId: string,
  seenUrls: Set<string>,
  remaining: number,
): Array<{ contentType: string; url: string }> {
  if (remaining <= 0) return [];
  const subject = doc.subject as Record<string, unknown> | undefined;
  const subjectRef = subject && typeof subject.reference === 'string' ? subject.reference.trim() : undefined;
  if (subjectRef) {
    const subjectId = extractIdFromReference(subjectRef, 'Patient');
    if (subjectId && subjectId !== patientId) {
      return [];
    }
  }
  const contents = Array.isArray(doc.content) ? doc.content : [];
  const attachments: Array<{ contentType: string; url: string }> = [];
  for (const entry of contents) {
    if (attachments.length >= remaining) break;
    if (!entry || typeof entry !== 'object') continue;
    const attachment = (entry as Record<string, unknown>).attachment as Record<string, unknown> | undefined;
    if (!attachment || typeof attachment !== 'object') continue;
    const url = sanitizeAttachmentUrl(attachment.url);
    if (!url || seenUrls.has(url)) continue;
    const contentType =
      typeof attachment.contentType === 'string' && attachment.contentType.trim().length > 0
        ? safeTruncate(attachment.contentType.trim(), 128)
        : 'application/octet-stream';
    attachments.push({ contentType, url });
    seenUrls.add(url);
  }
  return attachments;
}

function sanitizeAttachmentUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') {
    return null;
  }
  if (isPrivateHostname(parsed.hostname)) {
    return null;
  }
  parsed.hash = '';
  parsed.username = '';
  parsed.password = '';
  return parsed.toString();
}

function normalizeReference(reference: string, expectedType: string): string | null {
  const trimmed = reference.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      let segments = parsed.pathname.split('/').filter(Boolean);
      if (segments.length >= 3 && segments[2].toLowerCase() === '_history') {
        segments = segments.slice(0, 2);
      }
      if (segments.length >= 2) {
        const [type, id] = segments;
        if (type.toLowerCase() === expectedType.toLowerCase() && id) {
          return `${expectedType}/${id.split('?')[0]}`;
        }
      }
      return null;
    } catch {
      return null;
    }
  }
  const withoutQuery = trimmed.split('?')[0];
  const segments = withoutQuery.split('/').filter(Boolean);
  if (segments.length === 1) {
    return `${expectedType}/${segments[0]}`;
  }
  if (segments.length >= 2) {
    const [type, id] = segments;
    if (type.toLowerCase() !== expectedType.toLowerCase() || !id) {
      return null;
    }
    return `${expectedType}/${id}`;
  }
  return null;
}

function isPrivateHostname(hostname: string): boolean {
  if (!hostname) return true;
  const lower = hostname.toLowerCase();
  if (lower === 'localhost' || lower.endsWith('.local') || lower.endsWith('.internal')) {
    return true;
  }
  const ipType = isIP(hostname);
  if (ipType === 4) {
    const parts = hostname.split('.').map((part) => Number(part));
    if (parts[0] === 10) return true;
    if (parts[0] === 127) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  } else if (ipType === 6) {
    const normalized = hostname.toLowerCase();
    if (normalized === '::1') return true;
    if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
    if (normalized.startsWith('fe80')) return true;
  }
  return false;
}

function mapBundleToClinicianSummaries(bundle: FhirBundle, clinicId: string, now: number): ClinicianTaskSummary[] {
  const entries = Array.isArray(bundle.entry) ? (bundle.entry as FhirBundleEntry[]) : [];
  const results: ClinicianTaskSummary[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const resource = entry.resource;
    if (!resource || typeof resource !== 'object') continue;
    const mapped = mapTaskResourceToSummary(resource as Record<string, unknown>, clinicId, now);
    if (mapped) {
      results.push(mapped);
    }
  }
  return results;
}

function mapTaskResourceToSummary(
  resource: Record<string, unknown>,
  clinicId: string,
  now: number,
): ClinicianTaskSummary | null {
  if ((resource.resourceType as string | undefined) !== 'Task') {
    return null;
  }

  const idRaw = typeof resource.id === 'string' ? resource.id.trim() : '';
  if (!idRaw) {
    return null;
  }
  const taskId = safeTruncate(idRaw, 64);

  const owner = (resource.owner as Record<string, unknown> | undefined) ?? undefined;
  const ownerRef = owner && typeof owner.reference === 'string' ? owner.reference : undefined;
  const clinicFromOwner = extractClinicIdFromOwner(ownerRef);
  if (!clinicFromOwner || clinicFromOwner !== clinicId) {
    return null;
  }

  const priorityRaw = typeof resource.priority === 'string' ? resource.priority.trim().toLowerCase() : '';
  const priority = FHIR_PRIORITY_TO_RESPONSE[priorityRaw];
  if (!priority) {
    return null;
  }

  const statusRaw = typeof resource.status === 'string' ? resource.status.trim().toLowerCase() : '';
  const status = FHIR_STATUS_TO_RESPONSE[statusRaw];
  if (!status) {
    return null;
  }

  const subject = (resource as Record<string, unknown>)['for'] as Record<string, unknown> | undefined;
  const subjectRef = subject && typeof subject.reference === 'string' ? subject.reference : undefined;
  const patientIdRaw = subjectRef ? extractIdFromReference(subjectRef, 'Patient') : null;
  if (!patientIdRaw) {
    return null;
  }
  const patientId = safeTruncate(patientIdRaw, 64);

  const authoredOn = typeof resource.authoredOn === 'string' ? resource.authoredOn : undefined;
  const lastModified = typeof resource.lastModified === 'string' ? resource.lastModified : undefined;
  const meta = (resource.meta as Record<string, unknown> | undefined) ?? undefined;
  const lastUpdated =
    meta && typeof meta.lastUpdated === 'string' ? (meta.lastUpdated as string) : undefined;
  const createdAtIso =
    coerceIsoTimestamp(authoredOn) ??
    coerceIsoTimestamp(lastModified) ??
    coerceIsoTimestamp(lastUpdated) ??
    new Date(now).toISOString();

  const waitMs = computeWaitMs(createdAtIso, now);
  const shortReason = sanitizeShortReason(typeof resource.description === 'string' ? resource.description : undefined);
  const assignee = extractAssignee(resource);
  return {
    id: taskId,
    clinicId,
    priority,
    status,
    shortReason,
    patientId,
    waitMs,
    interpreter: undefined,
    assignee,
    createdAt: createdAtIso,
  };
}

function coerceIsoTimestamp(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString();
}

function extractIdFromReference(reference: string, expectedType: string): string | null {
  const trimmed = reference.trim();
  if (!trimmed) return null;
  if (trimmed.toLowerCase().startsWith(`${expectedType.toLowerCase()}/`)) {
    return trimmed.slice(expectedType.length + 1);
  }
  return trimmed;
}

function sanitizeShortReason(value: string | undefined): string {
  const fallback = 'Clinical follow-up';
  if (!value) return fallback;
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  return safeTruncate(trimmed, 256);
}

function safeTruncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return value.slice(0, maxLength);
}

function extractAssignee(resource: Record<string, unknown>): string | undefined {
  const performers = resource.performer;
  if (!Array.isArray(performers)) {
    return undefined;
  }
  for (const performer of performers) {
    if (!performer || typeof performer !== 'object') continue;
    const performerObj = performer as Record<string, unknown>;
    const actor = performerObj.actor as Record<string, unknown> | undefined;
    const actorDisplay = actor && typeof actor.display === 'string' ? actor.display.trim() : undefined;
    if (actorDisplay) {
      return safeTruncate(actorDisplay, 64);
    }
    const actorReference = actor && typeof actor.reference === 'string' ? actor.reference.trim() : undefined;
    if (actorReference) {
      return safeTruncate(actorReference, 64);
    }
    const performerDisplay = typeof performerObj.display === 'string' ? performerObj.display.trim() : undefined;
    if (performerDisplay) {
      return safeTruncate(performerDisplay, 64);
    }
  }
  return undefined;
}

function computeWaitMs(createdAtIso: string, now: number): number {
  const createdAt = new Date(createdAtIso).getTime();
  if (!Number.isFinite(createdAt)) return 0;
  const diff = now - createdAt;
  return diff <= 0 ? 0 : Math.round(diff);
}

function extractNextCursor(bundle: FhirBundle): string | undefined {
  const links = Array.isArray(bundle.link) ? bundle.link : [];
  const nextLink = links.find((link) => (link?.relation ?? '').toLowerCase() === 'next');
  if (!nextLink || typeof nextLink.url !== 'string') {
    return undefined;
  }
  const relative = normalizeFhirLink(nextLink.url);
  if (!relative || !relative.startsWith('Task')) {
    return undefined;
  }
  return encodeCursor(relative);
}

function renderPrometheusMetrics(): string {
  const lines: string[] = [];

  lines.push('# HELP http_server_duration_ms HTTP server request duration in milliseconds');
  lines.push('# TYPE http_server_duration_ms histogram');
  const histogramLines = renderHistogramMetric('http_server_duration_ms', HTTP_LATENCY_BUCKETS_MS, [
    'service',
    'route',
    'method',
  ]);
  if (histogramLines.length === 0) {
    lines.push('http_server_duration_ms_bucket{le="+Inf"} 0');
    lines.push('http_server_duration_ms_count 0');
    lines.push('http_server_duration_ms_sum 0');
  } else {
    lines.push(...histogramLines);
  }

  lines.push('# HELP http_server_requests_total HTTP server requests');
  lines.push('# TYPE http_server_requests_total counter');
  const requestLines = renderCounterMetric('http_server_requests_total', ['service', 'route', 'method', 'status', 'outcome']);
  if (requestLines.length === 0) {
    lines.push('http_server_requests_total 0');
  } else {
    lines.push(...requestLines);
  }

  lines.push('# HELP http_server_errors_total HTTP server 5xx responses');
  lines.push('# TYPE http_server_errors_total counter');
  const errorLines = renderCounterMetric('http_server_errors_total', ['service', 'route', 'method', 'status', 'outcome']);
  if (errorLines.length === 0) {
    lines.push('http_server_errors_total 0');
  } else {
    lines.push(...errorLines);
  }

  return `${lines.join('\n')}\n`;
}

interface HistogramAggregate {
  labelPairs: string[];
  counts: number[];
  sum: number;
  count: number;
}

function renderHistogramMetric(name: string, buckets: number[], labelKeys: string[]): string[] {
  const records = getHistogramRecords(name);
  if (records.length === 0) return [];

  const aggregates = new Map<string, HistogramAggregate>();

  for (const record of records) {
    const value = Number(record.value ?? 0);
    if (!Number.isFinite(value)) continue;

    const labelPairs = collectLabelPairs(record.attributes ?? {}, labelKeys);
    const key = labelPairs.join(',');
    let aggregate = aggregates.get(key);
    if (!aggregate) {
      aggregate = {
        labelPairs,
        counts: new Array(buckets.length + 1).fill(0),
        sum: 0,
        count: 0,
      };
      aggregates.set(key, aggregate);
    }

    let bucketIndex = buckets.findIndex((boundary) => value <= boundary);
    if (bucketIndex === -1) bucketIndex = buckets.length;
    aggregate.counts[bucketIndex] += 1;
    aggregate.sum += value;
    aggregate.count += 1;
  }

  const lines: string[] = [];
  for (const [key, aggregate] of Array.from(aggregates.entries()).sort((a, b) => a[0].localeCompare(b[0]))) {
    const baseLabels = aggregate.labelPairs;
    let cumulative = 0;
    buckets.forEach((boundary, idx) => {
      cumulative += aggregate.counts[idx];
      const labels = formatLabelText([...baseLabels, `le="${boundary}"`]);
      lines.push(`${name}_bucket${labels} ${cumulative}`);
    });
    cumulative += aggregate.counts[aggregate.counts.length - 1];
    const infLabels = formatLabelText([...baseLabels, 'le="+Inf"']);
    lines.push(`${name}_bucket${infLabels} ${cumulative}`);
    const countLabels = formatLabelText(baseLabels);
    lines.push(`${name}_count${countLabels} ${aggregate.count}`);
    lines.push(`${name}_sum${countLabels} ${aggregate.sum.toFixed(6)}`);
  }

  return lines;
}

function renderCounterMetric(name: string, labelKeys: string[]): string[] {
  const records = getCounterRecords(name);
  if (records.length === 0) return [];

  const totals = new Map<string, { labelPairs: string[]; value: number }>();
  for (const record of records) {
    const value = Number(record.value ?? 0);
    if (!Number.isFinite(value)) continue;
    const labelPairs = collectLabelPairs(record.attributes ?? {}, labelKeys);
    const key = labelPairs.join(',');
    const existing = totals.get(key);
    if (existing) {
      existing.value += value;
    } else {
      totals.set(key, { labelPairs, value });
    }
  }

  return Array.from(totals.values())
    .sort((a, b) => a.labelPairs.join(',').localeCompare(b.labelPairs.join(',')))
    .map((entry) => `${name}${formatLabelText(entry.labelPairs)} ${entry.value}`);
}

function collectLabelPairs(attributes: Record<string, unknown>, labelKeys: string[]): string[] {
  const pairs: string[] = [];
  for (const key of labelKeys) {
    const raw = attributes[key];
    if (raw === undefined || raw === null) continue;
    const value = escapeLabelValue(raw);
    pairs.push(`${key}="${value}"`);
  }
  return pairs;
}

function escapeLabelValue(value: unknown): string {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function formatLabelText(pairs: string[]): string {
  if (pairs.length === 0) return '';
  return `{${pairs.join(',')}}`;
}

export function setBusReadyForTest(ready: boolean): void {
  busReadyOverride = ready;
  busReady = ready;
}

export function getBusReadyForTest(): boolean {
  return busReadyOverride ?? busReady;
}

export function getMessageBusForTest(): MessageBus {
  return bus;
}

export function setMessageBusForTest(messageBus: MessageBus): void {
  bus = messageBus;
  busReady = true;
  busReadyOverride = true;
}

export function setShuttingDownForTest(value: boolean): void {
  shuttingDown = value;
}

export function getPracticeConfig(): ResolvedConfig {
  return currentPracticeConfig() as ResolvedConfig;
}

export function getSafetyGateSettings(): { timeoutMs: number; fallback: 'rules' | 'none' } {
  return { timeoutMs: getSafetyGateTimeoutMs(), fallback: getSafetyGateFallbackMode() };
}

export function setIdempotencyStoreForTest(store: IdempotencyStore): void {
  idempotencyStore = store;
}

export function resetIdempotencyStoreForTest(): void {
  idempotencyStore = new InMemoryIdempotencyStore();
}

export function setFhirRepositoryForTest(repository: FhirRepository): void {
  fhirRepository = repository;
}

export function resetFhirRepositoryForTest(): void {
  fhirRepository = constructFhirRepository();
}

export async function shutdownForTest(): Promise<void> {
  await initiateShutdownForTest();
}

export { server };
