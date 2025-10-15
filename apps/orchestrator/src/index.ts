import * as http from 'http';
import { randomUUID } from 'node:crypto';
import { analyzePortalSubmission } from './adapters/services/safetyGate';
import { errorEnvelope, mapErrorToStatus, redact } from './application/error';
import { callWithGuard } from './adapters/services/callWithGuard';
import { validatePortalSubmission } from './application/validator';
import { getBus, markNatsBusConnected, withMessageGuards } from '@onecare/bus';
import type { MessageBus } from '@onecare/bus';
import { createEnvelope, PortalSubmission, Topics, AuditEvent } from '@onecare/events';
import { validate } from '@onecare/domain';
import {
  initTracing,
  logger,
  setCorrelationId,
  withCorrelationContext,
  createCounter,
  createHistogram,
} from '@onecare/observability';
import { deriveIdempotencyKey, releaseIdempotency, InMemoryIdempotencyStore } from './application/idempotency';
import { ErrorCode } from './application/error';
import { connect, type ConnectionOptions, type NatsConnection } from 'nats';
import type { AuthContext } from '@onecare/security';
import { getSecurityServices, getConsentEvidence } from './adapters/security';
import { loadConfig, type ResolvedConfig, type SafetyGateShadowConfig } from '@onecare/config';
import { createAuditEvent, getAuditLedger } from './adapters/audit';
import { InMemoryFeatureStore } from '@onecare/feature-store-memory';
import {
  withFhirValidation,
  type FeatureStore,
  type FhirRepository,
  type IdempotencyStore,
  type InvalidFhirError,
} from '@onecare/ports';
import { resolveServerPort } from './support/port';
import { createHttpFhirRepository, isFhirRequestError } from './adapters/persistence/fhir.repository';
import HttpError from './application/httpError';
import { buildOrchestratorMachine, runOrchestratorMachine } from './application/orchestrator.machine';
import type { OrchestratorContext, ShadowSafetyGateContext } from './types';
import type { GateDenialReason } from './application/orchestrator.state';

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
function resolvePracticeId(): string {
  const envValue = process.env.PRACTICE_ID?.trim();
  if (envValue) return envValue;
  if (process.env.NODE_ENV === 'test') return 'demo';
  throw new Error('PRACTICE_ID environment variable is required');
}

function resolveFhirBaseUrl(): string {
  const envValue = process.env.FHIR_BASE_URL?.trim();
  if (envValue) return envValue;
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

function safeUrlForLog(raw: string): string {
  try {
    const url = new URL(raw);
    return url.origin + url.pathname;
  } catch {
    return 'invalid-url';
  }
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

const practiceId = resolvePracticeId();
const practiceConfig: ResolvedConfig = loadConfig(practiceId);
const safetyGateSettings = practiceConfig.safety_gate ?? {};
const safetyGateTimeoutMs = safetyGateSettings.timeout_ms ?? 800;
const safetyGateFallbackMode = safetyGateSettings.fallback ?? 'rules';
const shadowSafetyGate = normaliseShadowSafetyGate(safetyGateSettings.shadow);
const idempotencyConfig = practiceConfig.idempotency ?? { ttlSeconds: 600 };
const idempotencyTtlSeconds = idempotencyConfig.ttlSeconds;
const bookingAvailabilityTimeoutMs =
  practiceConfig.booking?.availabilityTimeoutMs ?? 2_000;
const bookingAvailabilityBase = (() => {
  const raw = process.env.BOOKING_AVAILABILITY_URL?.trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      logger.warn('booking availability upstream rejected - invalid protocol', { value: raw });
      return null;
    }
    return parsed;
  } catch (error) {
    logger.warn('booking availability upstream rejected - invalid URL', {
      value: raw,
      reason: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
})();

function parseBooleanFlag(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
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

const featureLoggingOn = parseBooleanFlag(process.env.FEATURE_LOGGING);
let featureStore: FeatureStore | null = featureLoggingOn ? new InMemoryFeatureStore() : null;
const fhirBaseUrl = resolveFhirBaseUrl();
const fhirTimeoutMs = resolveFhirTimeoutMs();
const fhirMaxRetries = resolveFhirMaxRetries();
const fhirProfiles = resolveFhirProfiles(practiceConfig);
function constructFhirRepository(): FhirRepository {
  const repository = createHttpFhirRepository({
    baseUrl: fhirBaseUrl,
    authToken: resolveFhirAuthToken(),
    timeoutMs: fhirTimeoutMs,
    maxRetries: fhirMaxRetries,
    practiceId,
  });
  return withFhirValidation(repository, { profiles: fhirProfiles });
}

let fhirRepository: FhirRepository = constructFhirRepository();

logger.info('practice config applied', {
  practiceId: practiceConfig.practiceId,
  safetyGate: {
    timeoutMs: safetyGateTimeoutMs,
    fallback: safetyGateFallbackMode,
    redFlagThreshold: safetyGateSettings.red_flag_threshold,
    emergencyConfidence: safetyGateSettings.emergency_confidence,
  },
  shadowSafetyGate: shadowSafetyGate
    ? {
        sampleRate: shadowSafetyGate.sampleRate,
        endpoint: shadowSafetyGate.endpoint ? safeUrlForLog(shadowSafetyGate.endpoint) : undefined,
        variant: shadowSafetyGate.variant,
        timeoutMs: shadowSafetyGate.timeoutMs ?? safetyGateTimeoutMs,
        maxRetries: shadowSafetyGate.maxRetries ?? 0,
      }
    : { enabled: false },
  fairnessFloors: practiceConfig.fairness_floors,
  holdBackFraction: practiceConfig.hold_back_fraction,
  idempotency: {
    ttlSeconds: idempotencyTtlSeconds,
  },
  booking: {
    availabilityTimeoutMs: bookingAvailabilityTimeoutMs,
  },
  fhir: {
    baseUrl: safeUrlForLog(fhirBaseUrl),
    timeoutMs: fhirTimeoutMs,
    maxRetries: fhirMaxRetries,
    profiles: fhirProfiles ? Object.keys(fhirProfiles) : [],
  },
});

void initTracing('orchestrator').catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  logger.warn('failed to initialize tracing', { message });
});

const ORCHESTRATOR_ALLOWED_TOPICS = new Set<string>([
  Topics.audit.event,
  Topics.triage.input,
  Topics.tasks.created,
]);

function buildMessageBus(options?: Parameters<typeof getBus>[0]): MessageBus {
  const base = getBus(options);
  return withMessageGuards(base, {
    allowedTopics: ORCHESTRATOR_ALLOWED_TOPICS,
  });
}

let bus: MessageBus = buildMessageBus();
markNatsBusConnected(bus, !wantsNats);
let idempotencyStore: IdempotencyStore = new InMemoryIdempotencyStore();
let busReady = !wantsNats;
let _natsConn: NatsConnection | null = null;
let reconnectTimer: NodeJS.Timeout | undefined;
let reconnectAttempts = 0;
const CONSENT_RESOURCES = ['QuestionnaireResponse', 'Communication'] as const;
const BOOKING_RESOURCES = ['Slot'] as const;
const FEATURE_LOG_RESOURCES = ['FeatureLog'] as const;
const BOOKING_SCOPE = 'booking:read';
const BOOKING_PARAM_KEYS = ['serviceType', 'windowStart', 'windowEnd', 'location'] as const;
type BookingParamKey = typeof BOOKING_PARAM_KEYS[number];
const BOOKING_ALLOWED_PARAMS = new Set<BookingParamKey>(BOOKING_PARAM_KEYS);

function isBookingParamKey(value: string): value is BookingParamKey {
  return BOOKING_ALLOWED_PARAMS.has(value as BookingParamKey);
}
const BOOKING_QUERY_SCHEMA_ID = 'https://onecare/schemas/booking/booking-search-request.json';
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

  const sanitized = new URLSearchParams();
  sanitized.set('serviceType', candidate.serviceType!);
  sanitized.set('windowStart', candidate.windowStart!);
  sanitized.set('windowEnd', candidate.windowEnd!);
  if (candidate.location) {
    sanitized.set('location', candidate.location);
  }
  return sanitized;
}

function parseServers(raw: string | undefined): string[] {
  if (!raw) return ['nats://localhost:4222'];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function buildConnectionOptions(): ConnectionOptions {
  const servers = parseServers(process.env.NATS_URL);
  const options: ConnectionOptions = { servers };
  const user = process.env.NATS_USER;
  const pass = process.env.NATS_PASS;
  const token = process.env.NATS_TOKEN;
  if (user) options.user = user;
  if (pass) options.pass = pass;
  if (token) options.token = token;
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
  return parsed;
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

function recordHttpMetrics(route: string, outcome: RequestOutcome, durationMs: number, correlationId: string | undefined): void {
  logger.info('metric.http.request', {
    route,
    outcome,
    durationMs: Number(durationMs.toFixed(2)),
    correlationId,
  });
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

  const finalize = () => {
    const durationMs = Number(process.hrtime.bigint() - start) / 1_000_000;
    recordHttpMetrics(route, outcome, durationMs, correlationId);
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
    .finally(finalize)
    .catch((err) => {
      // finalization errors should never occur; log defensively
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

async function emitAuditEvent(
  type: string,
  correlationId: string | undefined,
  actor: AuthContext['actor'] | null | undefined,
  details: Record<string, unknown>
): Promise<void> {
  const event: AuditEvent = {
    type,
    timestamp: new Date().toISOString(),
    correlationId,
    actor: actor ? `${actor.type}:${actor.id}` : null,
    details,
  };
  try {
    const env = createEnvelope(Topics.audit.event, event, correlationId);
    const headers = env.correlationId ? { 'x-correlation-id': env.correlationId } : undefined;
    await bus.publish(env.topic, env, headers);
  } catch (err) {
    logger.warn('failed to publish audit event', {
      type,
      correlationId,
      err: err instanceof Error ? err.message : err,
    });
  }
}

function recordAudit(type: string, correlationId: string | undefined, payload?: Record<string, unknown>): void {
  const ledgerEvent = createAuditEvent(type, { correlationId, payload });
  void getAuditLedger()
    .write(ledgerEvent)
    .catch((err) => {
      logger.warn('audit ledger write failed', {
        type,
        correlationId,
        err: err instanceof Error ? err.message : err,
      });
    });
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
  if (!featureLoggingOn || !featureStore) {
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

const server = http.createServer((req, res) => withCorrelationContext(() => {
  if (!req.url) {
    res.statusCode = 400;
    res.end('Bad Request');
    return;
  }
  const corr = cidFromHeaders(req.headers);
  setCorrelationId(corr);
  if (req.url === '/health') {
    res.statusCode = 200;
    res.end('ok');
    return;
  }
  if (req.url === '/ready') {
    const body = {
      status: busReady ? 'ready' : 'not_ready',
      bus: busReady ? 'connected' : 'disconnected',
    };
    res.statusCode = busReady ? 200 : 503;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(body));
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

  if (req.method === 'GET' && parsedUrl.pathname === '/booking/slots') {
    const routeLabel = 'GET /booking/slots';
    handleHttp(req, res, routeLabel, corr, async (setOutcome) => {
      const security = getSecurityServices();
      const requestId = getHeader(req.headers, 'x-request-id') ?? corr;
      const authHeader = getHeader(req.headers, 'authorization');
      const authContext = buildAuthContext(req.headers);
      const deny = async (reason: GateDenialReason, extraDetails: Record<string, unknown> = {}): Promise<void> => {
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
        recordAudit(AUDIT_DENIED_TYPE, corr, auditDetails);
        await emitAuditEvent(AUDIT_DENIED_TYPE, corr, authContext?.actor ?? null, auditDetails);
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

      if (actor.type === 'patient' && (!patientId || patientId !== actor.id)) {
        await deny('not_authorized', { reason: 'patient_mismatch' });
        return;
      }

      if (!(await security.authorize(actor, BOOKING_SCOPE, patientId, scope))) {
        await deny('not_authorized');
        return;
      }

      let consentReference: string | null = null;
      if (patientId) {
        if (!(await security.checkConsent(patientId, 'care', Array.from(BOOKING_RESOURCES)))) {
          await deny('consent_denied');
          return;
        }
        const consentEvidence = getConsentEvidence(patientId, 'care');
        if (!consentEvidence) {
          await deny('consent_denied', { reason: 'consent_evidence_missing' });
          return;
        }
        consentReference = consentEvidence.reference;
      }

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
      const practiceHeader = getHeader(req.headers, 'x-practice-id');
      if (practiceHeader) {
        headers['x-practice-id'] = practiceHeader;
      }

      const controller = new AbortController();
      const timeoutMs = Number.isFinite(bookingAvailabilityTimeoutMs) && bookingAvailabilityTimeoutMs > 0
        ? bookingAvailabilityTimeoutMs
        : 3000;
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      let upstream: Response;
      try {
        upstream = await fetch(upstreamUrl, {
          method: 'GET',
          headers,
          signal: controller.signal,
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
      res.end(bodyText);

      if (!upstream.ok) {
        setOutcome(upstream.status >= 500 ? 'upstream_unavailable' : 'invalid_input');
      } else {
        const successAuditDetails = {
          patientId: patientId ?? null,
          actorType: actor.type,
          scope,
          consentReference,
          upstreamStatus: upstream.status,
        } satisfies Record<string, unknown>;
        recordAudit('orchestrator.booking.proxy', corr, successAuditDetails);
        await emitAuditEvent('orchestrator.booking.proxy', corr, authContext.actor, successAuditDetails);
        setOutcome('ok');
      }
    });
    return;
  }

  if (req.method === 'POST' && parsedUrl.pathname === '/feature-log') {
    const routeLabel = 'POST /feature-log';
    handleHttp(req, res, routeLabel, corr, async (setOutcome) => {
      if (!featureLoggingOn || !featureStore) {
        res.statusCode = 202;
        res.end('feature logging disabled');
        return;
      }

      const security = getSecurityServices();
      const authContext = buildAuthContext(req.headers);
      const deny = async (
        reason: string,
        code: ErrorCode = 'forbidden',
        extraDetails: Record<string, unknown> = {}
      ): Promise<void> => {
        const auditDetails = {
          reason,
          scope: extractScopes(req.headers),
          ...extraDetails,
        } satisfies Record<string, unknown>;
        recordAudit('orchestrator.feature_log.denied', corr, auditDetails);
        await emitAuditEvent('orchestrator.feature_log.denied', corr, authContext?.actor ?? null, auditDetails);
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
      const correlationId =
        typeof payload.correlationId === 'string' && payload.correlationId.trim().length > 0 ? payload.correlationId : corr;

      if (
        !(await security.checkConsent(patientId, FEATURE_LOG_PURPOSE, Array.from(FEATURE_LOG_RESOURCES)))
      ) {
        await deny('consent_denied');
        return;
      }
      const consentEvidence = getConsentEvidence(patientId, FEATURE_LOG_PURPOSE);
      if (!consentEvidence || consentEvidence.reference !== consentReferenceHeader) {
        await deny('consent_mismatch', 'forbidden', { consentReference: consentEvidence?.reference ?? null });
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
        patientId,
        consentReference: consentEvidence.reference,
        scope: scopes,
      } satisfies Record<string, unknown>;
      recordAudit('orchestrator.feature_log.accepted', corr, successAuditDetails);
      await emitAuditEvent('orchestrator.feature_log.accepted', corr, authContext?.actor ?? null, successAuditDetails);

      res.statusCode = 202;
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

      const maxBytes = resolveMaxBodyBytes();
      const rawBuf = await readRequestBody(req, maxBytes);

      const ctype = (req.headers['content-type'] || '').toString().toLowerCase();
      if (!ctype.includes('application/json')) {
        respondError(res, 'unsupported_media_type', 'Only application/json is supported', corr, setOutcome);
        return;
      }

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
      const explicitKey = Array.isArray(explicitKeyHeader) ? explicitKeyHeader[0] : explicitKeyHeader;
      const idemKey = deriveIdempotencyKey(submission, authContext?.actor?.id, explicitKey);
      const replayFingerprint = `${requestId}:${idemKey}`;

      res.setHeader('x-idempotency-key', idemKey);
      logger.info('idempotency.key.derived', { key: idemKey, correlationId: corr });

      const orchestratorContext: OrchestratorContext = {
        id: requestId,
        correlationId: corr,
        requestId,
        submission,
        practiceId: practiceConfig.practiceId,
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
        emitAudit: (type, details) => emitAuditEvent(type, corr, authContext?.actor ?? null, details),
        recordAudit: (type, details) => recordAudit(type, corr, details),
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
  res.end('orchestrator skeleton');
}));

if (process.env.NODE_ENV !== 'test') {
  server.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`orchestrator listening on :${port}`);
  });
}

export function setBusReadyForTest(ready: boolean): void {
  busReady = ready;
}

export function getBusReadyForTest(): boolean {
  return busReady;
}

export function getMessageBusForTest(): MessageBus {
  return bus;
}

export function getPracticeConfig(): ResolvedConfig {
  return practiceConfig;
}

export function getSafetyGateSettings(): { timeoutMs: number; fallback: 'rules' | 'none' } {
  return { timeoutMs: safetyGateTimeoutMs, fallback: safetyGateFallbackMode };
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

export { server };
