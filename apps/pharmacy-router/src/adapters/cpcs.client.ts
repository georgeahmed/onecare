import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { isIP } from 'node:net';
import type { ResolvedConfig } from '@onecare/config';
import { createHistogram, createCounter, logger, startSpan } from '@onecare/observability';
import { SpanStatusCode } from '@opentelemetry/api';

/**
 * Environment variables consumed by {@link CpcsHttpClient.fromEnv}:
 * - `CPCS_URL`: Base HTTPS endpoint for the CPCS API (required).
 * - `CPCS_API_KEY`: API key or bearer token used for authentication (optional if headers provided by config).
 * - `CPCS_HEADER_NAME` / `CPCS_HEADER_VALUE`: Optional single custom header pair.
 * - `CPCS_EXTRA_HEADERS`: Optional JSON string containing additional headers (string:string).
 */

export interface CpcsSlot {
  start: string;
  end: string;
  locationOdsCode?: string;
  reference?: string;
}

export interface CpcsServiceRequest {
  id: string;
  patientReference: string;
  presentingComplaintCode: string;
  consentTimestamp: string;
  metadata?: Record<string, unknown>;
}

export interface ReferralResult {
  status: 'accepted' | 'queued' | 'rejected';
  reference: string;
  code?: string;
  message?: string;
}

export interface ReferralOptions {
  correlationId?: string;
}

export interface CpcsDispatchContext {
  headers: Record<string, string>;
  correlationId?: string;
  path: 'slot' | 'slotless';
  attempt: number;
  signal: AbortSignal;
  timeoutMs: number;
}

export interface CpcsDispatchPayload extends CpcsServiceRequest {
  summary: string;
}

export type CpcsReferralDispatcher = (
  organisationId: string,
  payload: CpcsDispatchPayload,
  slot?: CpcsSlot,
  context?: CpcsDispatchContext,
) => Promise<ReferralResult>;

export interface CpcsClientOptions {
  baseUrl: string;
  headers?: Record<string, string>;
  apiKey?: string;
  timeoutMs?: number;
  dispatcher?: CpcsReferralDispatcher;
  retry?: Partial<RetryPolicy>;
  circuitBreaker?: Partial<CircuitBreakerPolicy>;
  slotlessFallbackEnabled?: boolean;
  correlationHeader?: string;
}

export interface CpcsClient {
  sendReferral(
    organisationId: string,
    serviceRequest: CpcsServiceRequest,
    summary: string,
    slot?: CpcsSlot,
    options?: ReferralOptions,
  ): Promise<ReferralResult>;
}

interface RetryPolicy {
  attempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitterRatio: number;
}

interface CircuitBreakerPolicy {
  failureThreshold: number;
  cooldownMs: number;
}

export type CpcsErrorCode =
  | 'invalid_input'
  | 'forbidden'
  | 'upstream_timeout'
  | 'upstream_unavailable'
  | 'conflict'
  | 'internal_error'
  | 'unknown';

export class CpcsClientError extends Error {
  constructor(public readonly code: CpcsErrorCode, message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'CpcsClientError';
  }
}

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_RETRY_POLICY: RetryPolicy = {
  attempts: 2,
  baseDelayMs: 200,
  maxDelayMs: 1_000,
  jitterRatio: 0.2,
};
const DEFAULT_CIRCUIT_POLICY: CircuitBreakerPolicy = {
  failureThreshold: 5,
  cooldownMs: 30_000,
};
const DEFAULT_CORRELATION_HEADER = 'x-correlation-id';

const integrationLatencyHistogram = createHistogram('integration.latency_ms');
const integrationSuccessCounter = createCounter('integration.call.success_total');
const integrationErrorCounter = createCounter('integration.call.error_total');
const integrationTimeoutCounter = createCounter('integration.call.timeout_total');
const integrationCircuitCounter = createCounter('integration.call.circuit_open_total');
const referralFallbackCounter = createCounter('cpcs_referral_slotless_fallback_total');

const PROVIDER = 'cpcs';

function buildLogFields(
  operation: string,
  endpoint: string,
  correlationId: string | undefined,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    provider: PROVIDER,
    operation,
    endpoint,
    ...(correlationId ? { correlationId } : {}),
    ...extra,
  };
}

function recordSuccessMetrics(operation: string, durationMs: number): void {
  integrationSuccessCounter.add(1, { provider: PROVIDER, operation });
  integrationLatencyHistogram.record(durationMs, {
    provider: PROVIDER,
    operation,
    outcome: 'success',
  });
}

function recordFailureMetrics(operation: string, durationMs: number, code: CpcsErrorCode): void {
  const attrs = { provider: PROVIDER, operation, code };
  if (code === 'upstream_timeout') {
    integrationTimeoutCounter.add(1, attrs);
  } else {
    integrationErrorCounter.add(1, attrs);
  }
  integrationLatencyHistogram.record(durationMs, {
    ...attrs,
    outcome: 'failure',
  });
}

function logSuccess(operation: string, endpoint: string, correlationId: string | undefined, durationMs: number): void {
  logger.info('integration.call.success', buildLogFields(operation, endpoint, correlationId, {
    durationMs,
    result: 'success',
  }));
}

function logFailure(
  operation: string,
  endpoint: string,
  correlationId: string | undefined,
  code: CpcsErrorCode,
  attempt: number,
  retrying: boolean,
): void {
  logger.warn('integration.call.failure', buildLogFields(operation, endpoint, correlationId, {
    code,
    attempt,
    retrying,
    result: 'failure',
  }));
}

function logRetry(
  operation: string,
  endpoint: string,
  correlationId: string | undefined,
  code: CpcsErrorCode,
  attempt: number,
  nextDelayMs: number,
): void {
  logger.warn('integration.call.retry', buildLogFields(operation, endpoint, correlationId, {
    code,
    attempt,
    nextDelayMs,
    result: 'retry',
  }));
}

function logCircuitOpen(operation: string, endpoint: string, correlationId: string | undefined): void {
  logger.warn('integration.call.circuit_open', buildLogFields(operation, endpoint, correlationId, {
    result: 'circuit_open',
  }));
}

export class CpcsHttpClient implements CpcsClient {
  private readonly baseUrl: string;
  private headers: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly dispatcher: CpcsReferralDispatcher;
  private readonly retryPolicy: RetryPolicy;
  private readonly circuitBreaker: CircuitBreaker;
  private readonly slotlessFallbackEnabled: boolean;
  private correlationHeader: string;
  private rawHeaders: Record<string, string>;
  private apiKey?: string;

  constructor(options: CpcsClientOptions) {
    if (!options.baseUrl) {
      throw new Error('cpcs_base_url_missing');
    }
    this.baseUrl = ensureSafeCpcsBaseUrl(options.baseUrl);
    this.rawHeaders = { ...(options.headers ?? {}) };
    this.apiKey = options.apiKey?.trim() || undefined;
    this.headers = buildHeaders(this.rawHeaders, this.apiKey);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.dispatcher = options.dispatcher ?? defaultDispatcher;
    this.retryPolicy = normalizeRetryPolicy(options.retry);
    this.circuitBreaker = new CircuitBreaker(normalizeCircuitPolicy(options.circuitBreaker));
    this.slotlessFallbackEnabled = options.slotlessFallbackEnabled ?? false;
    this.correlationHeader = options.correlationHeader ?? DEFAULT_CORRELATION_HEADER;
  }

  static fromConfig(config: ResolvedConfig, overrides: Partial<CpcsClientOptions> = {}): CpcsHttpClient {
    const cpcs = (config.cpcs ?? {}) as {
      endpoint?: string;
      apiKey?: string;
      headers?: Record<string, string>;
      timeoutMs?: number;
      retry?: Partial<RetryPolicy>;
      circuitBreaker?: Partial<CircuitBreakerPolicy>;
      slotlessFallback?: { enabled?: boolean };
      correlationHeader?: string;
    };
    const baseUrl = overrides.baseUrl ?? cpcs.endpoint ?? readEnvUrl();
    const headers: Record<string, string> = { ...(cpcs.headers ?? {}) };
    if (overrides.headers) {
      for (const [key, value] of Object.entries(overrides.headers)) {
        headers[key] = value;
      }
    }
    return new CpcsHttpClient({
      baseUrl,
      headers,
      apiKey: overrides.apiKey ?? cpcs.apiKey?.trim(),
      timeoutMs: overrides.timeoutMs ?? cpcs.timeoutMs,
      dispatcher: overrides.dispatcher,
      retry: overrides.retry ?? cpcs.retry,
      circuitBreaker: overrides.circuitBreaker ?? cpcs.circuitBreaker,
      slotlessFallbackEnabled:
        overrides.slotlessFallbackEnabled ?? cpcs.slotlessFallback?.enabled ?? false,
      correlationHeader: overrides.correlationHeader ?? cpcs.correlationHeader,
    });
  }

  static fromEnv(overrides: Partial<CpcsClientOptions> = {}): CpcsHttpClient {
    const baseUrl = overrides.baseUrl ?? readEnvUrl();
    const headers = { ...readEnvHeaders(), ...(overrides.headers ?? {}) };
    return new CpcsHttpClient({
      baseUrl,
      headers,
      apiKey: overrides.apiKey ?? process.env.CPCS_API_KEY?.trim(),
      timeoutMs: overrides.timeoutMs,
      dispatcher: overrides.dispatcher,
      retry: overrides.retry,
      circuitBreaker: overrides.circuitBreaker,
      slotlessFallbackEnabled: overrides.slotlessFallbackEnabled ?? parseEnvSlotlessFallback(),
      correlationHeader: overrides.correlationHeader ?? process.env.CPCS_CORRELATION_HEADER,
    });
  }

  async sendReferral(
    organisationId: string,
    serviceRequest: CpcsServiceRequest,
    summary: string,
    slot?: CpcsSlot,
    options?: ReferralOptions,
  ): Promise<ReferralResult> {
    if (!organisationId || !organisationId.trim()) {
      throw new CpcsClientError('invalid_input', 'Organisation identifier is required');
    }
    if (!serviceRequest?.id) {
      throw new CpcsClientError('invalid_input', 'ServiceRequest identifier is required');
    }
    if (!summary || summary.trim().length === 0) {
      throw new CpcsClientError('invalid_input', 'Referral summary is required');
    }

    const correlationId = options?.correlationId;
    const hasSchedulableSlot =
      slot?.locationOdsCode && slot.locationOdsCode.trim().length > 0;
    const mode: 'slot' | 'slotless' = hasSchedulableSlot ? 'slot' : 'slotless';
    const payload: CpcsDispatchPayload = { ...serviceRequest, summary };

    const primary = await this.executeWithGuard(
      mode,
      organisationId.trim(),
      payload,
      hasSchedulableSlot ? slot : undefined,
      correlationId,
    );
    if (
      slot &&
      this.slotlessFallbackEnabled &&
      shouldFallbackToSlotless(primary)
    ) {
      referralFallbackCounter.add(1, { provider: PROVIDER, path: 'slot' });
      logger.info(
        'integration.call.fallback',
        buildLogFields('slot', this.baseUrl, correlationId, {
          fallback: 'slotless',
          reason: primary.code ?? 'slot_unavailable',
        }),
      );
      return this.executeWithGuard('slotless', organisationId.trim(), payload, undefined, correlationId);
    }
    return primary;
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  getHeaders(): Record<string, string> {
    return { ...this.headers };
  }

  refreshCredentials(update: { headers?: Record<string, string>; apiKey?: string | null; correlationHeader?: string }): void {
    if (update.headers) {
      this.rawHeaders = { ...update.headers };
    }
    if (update.apiKey !== undefined) {
      const trimmed = update.apiKey?.trim();
      this.apiKey = trimmed && trimmed.length > 0 ? trimmed : undefined;
    }
    this.headers = buildHeaders(this.rawHeaders, this.apiKey);
    if (update.correlationHeader) {
      const trimmed = update.correlationHeader.trim();
      if (trimmed.length > 0) {
        this.correlationHeader = trimmed;
      }
    }
  }

  getTimeoutMs(): number {
    return this.timeoutMs;
  }

  private startCallSpan(operation: 'slot' | 'slotless', correlationId?: string) {
    const span = startSpan('cpcs.call', {
      attributes: {
        'integration.provider': PROVIDER,
        'integration.operation': operation,
        'integration.endpoint': this.baseUrl,
      },
    });
    if (correlationId && span.isRecording()) {
      span.setAttribute('integration.correlation_id', correlationId);
    }
    return span;
  }

  private buildHeaders(correlationId?: string): Record<string, string> {
    const merged: Record<string, string> = { ...this.headers };
    if (correlationId && correlationId.trim().length > 0) {
      merged[this.correlationHeader] = correlationId;
    }
    return merged;
  }

  private async executeWithGuard(
    path: 'slot' | 'slotless',
    organisationId: string,
    payload: CpcsDispatchPayload,
    slot: CpcsSlot | undefined,
    correlationId?: string,
  ): Promise<ReferralResult> {
    if (!this.circuitBreaker.canExecute()) {
      integrationCircuitCounter.add(1, { provider: PROVIDER, operation: path });
      logCircuitOpen(path, this.baseUrl, correlationId);
      const span = this.startCallSpan(path, correlationId);
      span.setStatus({ code: SpanStatusCode.ERROR, message: 'Circuit breaker open' });
      span.end();
      throw new CpcsClientError('upstream_unavailable', 'CPCS circuit breaker open');
    }

    const operationStart = performance.now();
    const span = this.startCallSpan(path, correlationId);
    let attempt = 0;
    let lastError: CpcsClientError | undefined;

    while (attempt <= this.retryPolicy.attempts) {
      const controller = new AbortController();
      const call = () =>
        this.dispatcher(organisationId, payload, slot, {
          headers: this.buildHeaders(correlationId),
          correlationId,
          path,
          attempt,
          signal: controller.signal,
          timeoutMs: this.timeoutMs,
        });

      try {
        const result = await withTimeout(call, this.timeoutMs, controller);
        this.circuitBreaker.recordSuccess();
        const durationMs = performance.now() - operationStart;
        recordSuccessMetrics(path, durationMs);
        logSuccess(path, this.baseUrl, correlationId, durationMs);
        span.setStatus({ code: SpanStatusCode.OK });
        span.end();
        return result;
      } catch (error) {
        const mapped = mapProviderError(error);
        lastError = mapped;
        this.circuitBreaker.recordFailure();
        const retryable = shouldRetry(mapped);
        const finalAttempt = attempt >= this.retryPolicy.attempts || !retryable;
        if (finalAttempt) {
          const durationMs = performance.now() - operationStart;
          recordFailureMetrics(path, durationMs, mapped.code);
          logFailure(path, this.baseUrl, correlationId, mapped.code, attempt, false);
          span.recordException(mapped);
          span.setStatus({ code: SpanStatusCode.ERROR, message: mapped.message });
          span.end();
          throw mapped;
        }
        const nextAttempt = attempt + 1;
        const delayMs = calculateDelay(this.retryPolicy, nextAttempt);
        logRetry(path, this.baseUrl, correlationId, mapped.code, attempt, delayMs);
        span.addEvent('retry', { attempt, delayMs, code: mapped.code });
        attempt = nextAttempt;
        await delay(delayMs);
      }
    }
    const fallbackError = lastError ?? new CpcsClientError('unknown', 'CPCS referral request failed');
    span.recordException(fallbackError);
    span.setStatus({ code: SpanStatusCode.ERROR, message: fallbackError.message });
    span.end();
    throw fallbackError;
  }
}

async function defaultDispatcher(
  organisationId: string,
  payload: CpcsDispatchPayload,
  slot?: CpcsSlot,
  context?: CpcsDispatchContext,
): Promise<ReferralResult> {
  void organisationId;
  void payload;
  void slot;
  void context;
  await delay(10);
  return {
    status: 'accepted',
    reference: `cpcs-${payload.id}`,
  };
}

function readEnvUrl(): string {
  const value = process.env.CPCS_URL?.trim();
  if (!value) {
    throw new Error('cpcs_url_missing');
  }
  return value;
}

function readEnvHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  const name = process.env.CPCS_HEADER_NAME?.trim();
  const headerValue = process.env.CPCS_HEADER_VALUE?.trim();
  if (name && headerValue) {
    headers[name] = headerValue;
  }
  const extra = process.env.CPCS_EXTRA_HEADERS;
  if (extra) {
    try {
      const parsed = JSON.parse(extra) as Record<string, string>;
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === 'string' && value.trim().length > 0) {
          headers[key] = value;
        }
      }
    } catch {
      // Ignore malformed JSON; no logging to avoid leaking secrets.
    }
  }
  return headers;
}

function buildHeaders(headers: Record<string, string> = {}, apiKey?: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === 'string' && value.trim().length > 0) {
      result[key] = value;
    }
  }
  if (apiKey && !result.Authorization) {
    result.Authorization = apiKey.startsWith('Bearer ') ? apiKey : `Bearer ${apiKey}`;
  }
  if (!result['Content-Type']) {
    result['Content-Type'] = 'application/json';
  }
  if (!result.Accept) {
    result.Accept = 'application/json';
  }
  return result;
}

async function withTimeout<T>(
  factory: () => Promise<T>,
  timeoutMs: number,
  controller: AbortController,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeoutPromise = new Promise<T>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new CpcsClientError('upstream_timeout', 'CPCS request timed out'));
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
    });
    return await Promise.race([factory(), timeoutPromise]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function mapProviderError(error: unknown): CpcsClientError {
  if (error instanceof CpcsClientError) return error;
  if (error instanceof Error && error.name === 'AbortError') {
    return new CpcsClientError('upstream_timeout', 'CPCS request timed out', error);
  }
  const status = extractStatus(error);
  if (status !== undefined) {
    if (status === 400 || status === 422) {
      return new CpcsClientError('invalid_input', 'CPCS rejected request', error);
    }
    if (status === 401 || status === 403) {
      return new CpcsClientError('forbidden', 'CPCS authentication failed', error);
    }
    if (status === 408) {
      return new CpcsClientError('upstream_timeout', 'CPCS request timed out', error);
    }
    if (status === 409) {
      return new CpcsClientError('conflict', 'CPCS duplicate detected', error);
    }
    if (status >= 500) {
      return new CpcsClientError('upstream_unavailable', 'CPCS service unavailable', error);
    }
  }
  const code = (error as { code?: string }).code;
  if (typeof code === 'string') {
    const lowered = code.toLowerCase();
    if (lowered === 'etimedout') {
      return new CpcsClientError('upstream_timeout', 'CPCS request timed out', error);
    }
    if (lowered === 'econnrefused' || lowered === 'ehostunreach') {
      return new CpcsClientError('upstream_unavailable', 'CPCS service unavailable', error);
    }
  }
  return new CpcsClientError('internal_error', 'CPCS referral request failed', error);
}

function extractStatus(error: unknown): number | undefined {
  const candidate = error as { status?: number; response?: { status?: number }; httpStatus?: number };
  if (candidate?.status && Number.isFinite(candidate.status)) return candidate.status;
  if (candidate?.response?.status && Number.isFinite(candidate.response.status)) return candidate.response.status;
  if (candidate?.httpStatus && Number.isFinite(candidate.httpStatus)) return candidate.httpStatus;
  return undefined;
}

function shouldRetry(error: CpcsClientError): boolean {
  return (
    error.code === 'upstream_timeout' ||
    error.code === 'upstream_unavailable' ||
    error.code === 'internal_error' ||
    error.code === 'unknown'
  );
}

function calculateDelay(policy: RetryPolicy, attempt: number): number {
  const exponent = Math.max(0, attempt - 1);
  const exponential = policy.baseDelayMs * Math.pow(2, exponent);
  const capped = Math.min(exponential, policy.maxDelayMs);
  const jitter = capped * policy.jitterRatio * Math.random();
  return capped + jitter;
}

function shouldFallbackToSlotless(result: ReferralResult): boolean {
  if (result.status !== 'rejected') return false;
  const code = result.code?.toLowerCase();
  return code === 'slot_unavailable' || code === 'no_slot' || code === 'slot_not_available';
}

function normalizeRetryPolicy(input?: Partial<RetryPolicy>): RetryPolicy {
  const attempts = coerceInteger(input?.attempts, DEFAULT_RETRY_POLICY.attempts, 0, 5);
  const baseDelayMs = coerceNumber(input?.baseDelayMs, DEFAULT_RETRY_POLICY.baseDelayMs, 10, 10_000);
  const maxDelayMs = coerceNumber(
    input?.maxDelayMs,
    DEFAULT_RETRY_POLICY.maxDelayMs,
    baseDelayMs,
    60_000,
  );
  const jitterRatio = coerceNumber(input?.jitterRatio, DEFAULT_RETRY_POLICY.jitterRatio, 0, 1);
  return { attempts, baseDelayMs, maxDelayMs, jitterRatio };
}

function normalizeCircuitPolicy(input?: Partial<CircuitBreakerPolicy>): CircuitBreakerPolicy {
  const failureThreshold = coerceInteger(
    input?.failureThreshold,
    DEFAULT_CIRCUIT_POLICY.failureThreshold,
    1,
    20,
  );
  const cooldownMs = coerceNumber(input?.cooldownMs, DEFAULT_CIRCUIT_POLICY.cooldownMs, 1_000, 300_000);
  return { failureThreshold, cooldownMs };
}

function parseEnvSlotlessFallback(): boolean {
  const raw =
    process.env.CPCS_SLOTLESS_FALLBACK_ENABLED ??
    process.env.CPCS_SLOTLESS_FALLBACK ??
    '';
  if (!raw) return false;
  return ['1', 'true', 'yes', 'y'].includes(raw.toLowerCase());
}

function coerceNumber(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim().length > 0
        ? Number(value)
        : undefined;
  if (parsed === undefined || !Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function coerceInteger(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const numberValue = coerceNumber(value, fallback, min, max);
  return Math.round(numberValue);
}

class CircuitBreaker {
  private state: 'closed' | 'open' | 'half-open' = 'closed';
  private failureCount = 0;
  private openedAt = 0;

  constructor(private readonly policy: CircuitBreakerPolicy) {}

  canExecute(): boolean {
    if (this.state === 'open') {
      const now = Date.now();
      if (now - this.openedAt >= this.policy.cooldownMs) {
        this.state = 'half-open';
        return true;
      }
      return false;
    }
    return true;
  }

  recordSuccess(): void {
    this.failureCount = 0;
    this.state = 'closed';
  }

  recordFailure(): void {
    if (this.state === 'half-open') {
      this.open();
      return;
    }
    this.failureCount += 1;
    if (this.failureCount >= this.policy.failureThreshold) {
      this.open();
    }
  }

  private open(): void {
    this.state = 'open';
    this.openedAt = Date.now();
  }
}

function ensureSafeCpcsBaseUrl(candidate: string): string {
  const trimmed = candidate.trim();
  if (!trimmed) {
    throw new Error('cpcs_base_url_missing');
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('cpcs_base_url_invalid');
  }
  if (parsed.protocol !== 'https:') {
    throw new Error('cpcs_base_url_insecure');
  }
  if (parsed.username || parsed.password) {
    throw new Error('cpcs_base_url_credentials_not_allowed');
  }
  if (parsed.search || parsed.hash) {
    throw new Error('cpcs_base_url_extraneous');
  }
  if (isBlockedHostname(parsed.hostname)) {
    throw new Error('cpcs_base_url_blocked');
  }
  const normalisedPath = parsed.pathname.replace(/\/+$/u, '');
  return `${parsed.origin}${normalisedPath === '' ? '' : normalisedPath}`;
}

function isBlockedHostname(hostname: string): boolean {
  const lower = hostname.trim().toLowerCase();
  if (!lower) return true;
  if (lower === 'localhost' || lower.endsWith('.localhost')) return true;
  if (lower.endsWith('.local') || lower.endsWith('.internal')) return true;
  if (lower === '0.0.0.0') return true;
  if (lower === '::1') return true;
  const ipType = isIP(lower);
  if (ipType === 4) {
    const parts = lower.split('.').map((segment) => Number(segment));
    if (parts.length !== 4 || parts.some((segment) => Number.isNaN(segment) || segment < 0 || segment > 255)) {
      return true;
    }
    const [a, b] = parts;
    if (a === 10 || a === 127) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 0) return true;
  } else if (ipType === 6) {
    if (lower === '::1') return true;
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
    if (lower.startsWith('fe80')) return true;
  }
  return false;
}
