import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { isIP } from 'node:net';
import type { ResolvedConfig, IcsConfig, IcsRouteConfig, IcsTlsConfig } from '@onecare/config';
import { createHistogram, createCounter, logger, startSpan } from '@onecare/observability';
import { SpanStatusCode } from '@opentelemetry/api';
import type { IcsReferralRequest, IcsReferralAck } from '@onecare/events';

export interface IcsClient {
  sendReferral(request: IcsReferralRequest, options?: IcsCallOptions): Promise<IcsReferralAck>;
  acknowledge(referralId: string, ack: IcsReferralAck, options?: IcsCallOptions): Promise<IcsReferralAck>;
}

export interface IcsCallOptions {
  correlationId?: string;
  organisationIdOverride?: string;
}

export type IcsErrorCode =
  | 'invalid_input'
  | 'forbidden'
  | 'upstream_timeout'
  | 'upstream_unavailable'
  | 'conflict'
  | 'internal_error'
  | 'rate_limited'
  | 'unknown';

export class IcsClientError extends Error {
  constructor(public readonly code: IcsErrorCode, message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'IcsClientError';
  }
}

export interface IcsRouteOptions {
  endpoint: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  retry?: Partial<RetryPolicy>;
  circuitBreaker?: Partial<CircuitBreakerPolicy>;
  correlationHeader?: string;
  tls?: IcsTlsConfig;
  rateLimitPerMinute?: number;
}

export interface IcsClientOptions {
  routes: Record<string, IcsRouteOptions>;
  defaultRoute?: IcsRouteOptions;
  referralDispatcher?: IcsReferralDispatcher;
  ackDispatcher?: IcsAckDispatcher;
}

export interface IcsCallContext {
  endpoint: string;
  headers: Record<string, string>;
  correlationId?: string;
  attempt: number;
  signal: AbortSignal;
  timeoutMs: number;
  tls?: IcsTlsConfig;
  operation: 'referral' | 'ack';
  organisationId: string;
}

export type IcsReferralDispatcher = (
  route: RouteState,
  request: IcsReferralRequest,
  context: IcsCallContext,
) => Promise<IcsReferralAck>;

export type IcsAckDispatcher = (
  route: RouteState,
  referralId: string,
  ack: IcsReferralAck,
  context: IcsCallContext,
) => Promise<IcsReferralAck>;

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

interface RouteState {
  key: string;
  options: RouteOptionsResolved;
  circuitBreaker: CircuitBreaker;
  rateLimiter: RateLimiter;
}

interface RouteOptionsResolved {
  endpoint: string;
  headers: Record<string, string>;
  timeoutMs: number;
  retry: RetryPolicy;
  circuitBreaker: CircuitBreakerPolicy;
  correlationHeader: string;
  tls?: IcsTlsConfig;
  rateLimitPerMinute?: number;
}

interface RouteCredentialUpdate {
  headers?: Record<string, string>;
  apiKey?: string | null;
  correlationHeader?: string;
  tls?: IcsTlsConfig;
}

const DEFAULT_TIMEOUT_MS = 3_000;
const DEFAULT_CORRELATION_HEADER = 'x-correlation-id';
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

const integrationLatencyHistogram = createHistogram('integration.latency_ms');
const integrationSuccessCounter = createCounter('integration.call.success_total');
const integrationErrorCounter = createCounter('integration.call.error_total');
const integrationTimeoutCounter = createCounter('integration.call.timeout_total');
const integrationCircuitCounter = createCounter('integration.call.circuit_open_total');
const integrationBlockedCounter = createCounter('integration.call.blocked_total');

const PROVIDER = 'ics';

type Operation = 'referral' | 'ack';

function buildLogFields(
  operation: Operation,
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

function recordSuccessMetrics(operation: Operation, durationMs: number): void {
  integrationSuccessCounter.add(1, { provider: PROVIDER, operation });
  integrationLatencyHistogram.record(durationMs, {
    provider: PROVIDER,
    operation,
    outcome: 'success',
  });
}

function recordFailureMetrics(operation: Operation, durationMs: number, code: IcsErrorCode): void {
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

function logSuccess(operation: Operation, endpoint: string, correlationId: string | undefined, durationMs: number): void {
  logger.info('integration.call.success', buildLogFields(operation, endpoint, correlationId, {
    durationMs,
    result: 'success',
  }));
}

function logFailure(
  operation: Operation,
  endpoint: string,
  correlationId: string | undefined,
  code: IcsErrorCode,
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
  operation: Operation,
  endpoint: string,
  correlationId: string | undefined,
  code: IcsErrorCode,
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

function logCircuitOpen(operation: Operation, endpoint: string, correlationId: string | undefined): void {
  logger.warn('integration.call.circuit_open', buildLogFields(operation, endpoint, correlationId, {
    result: 'circuit_open',
  }));
}

function logBlocked(organisationId: string): void {
  integrationBlockedCounter.add(1, { provider: PROVIDER, organisationId });
  logger.warn('integration.call.blocked', {
    provider: PROVIDER,
    operation: 'referral',
    endpoint: 'blocked',
    organisationId,
    result: 'blocked',
  });
}

export class IcsHttpClient implements IcsClient {
  private readonly routes: Map<string, RouteState>;
  private readonly defaultRoute?: RouteState;
  private readonly referralDispatcher: IcsReferralDispatcher;
  private readonly ackDispatcher: IcsAckDispatcher;

  constructor(options: IcsClientOptions) {
    if (
      !options ||
      (Object.keys(options.routes ?? {}).length === 0 && !options.defaultRoute)
    ) {
      throw new Error('ics_routes_missing');
    }
    const routeEntries: Array<[string, RouteState]> = options.routes
      ? Object.entries(options.routes).map(([org, route]): [string, RouteState] => [
          normaliseOrgId(org),
          createRouteState(org, route),
        ])
      : [];
    this.routes = new Map<string, RouteState>(routeEntries);
    this.defaultRoute = options.defaultRoute ? createRouteState('default', options.defaultRoute) : undefined;
    this.referralDispatcher = options.referralDispatcher ?? defaultReferralDispatcher;
    this.ackDispatcher = options.ackDispatcher ?? defaultAckDispatcher;
  }

  static fromConfig(config: ResolvedConfig, overrides: Partial<IcsClientOptions> = {}): IcsHttpClient {
    const ics = config.ics;
    const routes: Record<string, IcsRouteOptions> = {};
    if (ics?.routes) {
      for (const [org, route] of Object.entries(ics.routes)) {
        const parsed = toRouteOptions(route);
        if (parsed) routes[org] = parsed;
      }
    }
    if (overrides.routes) {
      for (const [org, route] of Object.entries(overrides.routes)) {
        routes[org] = route;
      }
    }
    const defaultRoute = overrides.defaultRoute ?? (ics?.default ? toRouteOptions(ics.default) : undefined);

    if (Object.keys(routes).length === 0 && !defaultRoute) {
      throw new Error('ics_routes_missing');
    }

    return new IcsHttpClient({
      routes,
      defaultRoute,
      referralDispatcher: overrides.referralDispatcher,
      ackDispatcher: overrides.ackDispatcher,
    });
  }

  async sendReferral(request: IcsReferralRequest, options?: IcsCallOptions): Promise<IcsReferralAck> {
    if (!request?.org) {
      throw new IcsClientError('invalid_input', 'Organisation identifier required');
    }
    const rawOrgId = options?.organisationIdOverride ?? request.org;
    const orgId = rawOrgId.trim();
    const route = this.resolveRoute(orgId);
    try {
      route.rateLimiter.consume();
    } catch (error) {
      throw this.handleImmediateFailure('referral', route, options?.correlationId, orgId, error);
    }
    return this.executeWithGuard('referral', route, orgId, options?.correlationId, async (context) =>
      this.referralDispatcher(route, request, context),
    );
  }

  async acknowledge(
    referralId: string,
    ack: IcsReferralAck,
    options?: IcsCallOptions,
  ): Promise<IcsReferralAck> {
    if (!referralId) {
      throw new IcsClientError('invalid_input', 'Referral identifier required');
    }
    const overrideOrg = options?.organisationIdOverride?.trim();
    const route = overrideOrg ? this.resolveRoute(overrideOrg) : this.defaultRoute;
    if (!route) {
      throw new IcsClientError('invalid_input', 'Organisation identifier required for acknowledgement');
    }
    const effectiveOrgId = overrideOrg ?? route.key;
    try {
      route.rateLimiter.consume();
    } catch (error) {
      throw this.handleImmediateFailure('ack', route, options?.correlationId, effectiveOrgId, error);
    }
    return this.executeWithGuard('ack', route, effectiveOrgId, options?.correlationId, async (context) =>
      this.ackDispatcher(route, referralId, ack, context),
    );
  }

  refreshRouteCredentials(organisationId: string | 'default', update: RouteCredentialUpdate): void {
    const target =
      organisationId === 'default'
        ? this.defaultRoute
        : this.routes.get(normaliseOrgId(organisationId));
    if (!target) {
      throw new Error('ics_route_missing');
    }
    applyRouteCredentialUpdate(target, update);
  }

  private async executeWithGuard(
    operation: 'referral' | 'ack',
    route: RouteState,
    organisationId: string,
    correlationId: string | undefined,
    executor: (context: IcsCallContext) => Promise<IcsReferralAck>,
  ): Promise<IcsReferralAck> {
    if (!route.circuitBreaker.canExecute()) {
      integrationCircuitCounter.add(1, { provider: PROVIDER, operation });
      logCircuitOpen(operation, route.options.endpoint, correlationId);
      const span = this.startCallSpan(operation, route, correlationId, organisationId);
      span.setStatus({ code: SpanStatusCode.ERROR, message: 'Circuit breaker open' });
      span.end();
      throw new IcsClientError('upstream_unavailable', 'ICS circuit breaker open');
    }

    const operationStart = performance.now();
    const span = this.startCallSpan(operation, route, correlationId, organisationId);
    let attempt = 0;
    let lastError: IcsClientError | undefined;

    while (attempt <= route.options.retry.attempts) {
      const controller = new AbortController();
      const headers = this.buildHeaders(route, correlationId);
      const context: IcsCallContext = {
        endpoint: route.options.endpoint,
        headers,
        correlationId,
        attempt,
        signal: controller.signal,
        timeoutMs: route.options.timeoutMs,
        tls: route.options.tls,
        operation,
        organisationId,
      };
      try {
        const result = await withTimeout(
          () => executor(context),
          route.options.timeoutMs,
          controller,
        );
        route.circuitBreaker.recordSuccess();
        const durationMs = performance.now() - operationStart;
        recordSuccessMetrics(operation, durationMs);
        logSuccess(operation, route.options.endpoint, correlationId, durationMs);
        span.setStatus({ code: SpanStatusCode.OK });
        span.end();
        return result;
      } catch (error) {
        const mapped = mapProviderError(error);
        lastError = mapped;
        route.circuitBreaker.recordFailure();
        const retryable = shouldRetry(mapped);
        const finalAttempt = attempt >= route.options.retry.attempts || !retryable;
        if (finalAttempt) {
          const durationMs = performance.now() - operationStart;
          recordFailureMetrics(operation, durationMs, mapped.code);
          logFailure(operation, route.options.endpoint, correlationId, mapped.code, attempt, false);
          span.recordException(mapped);
          span.setStatus({ code: SpanStatusCode.ERROR, message: mapped.message });
          span.end();
          throw mapped;
        }
        const nextAttempt = attempt + 1;
        const delayMs = calculateDelay(route.options.retry, nextAttempt);
        logRetry(operation, route.options.endpoint, correlationId, mapped.code, attempt, delayMs);
        span.addEvent('retry', { attempt, delayMs, code: mapped.code });
        attempt = nextAttempt;
        await delay(delayMs);
      }
    }
    const fallbackError = lastError ?? new IcsClientError('unknown', 'ICS request failed');
    span.recordException(fallbackError);
    span.setStatus({ code: SpanStatusCode.ERROR, message: fallbackError.message });
    span.end();
    throw fallbackError;
  }

  private resolveRoute(orgId: string): RouteState {
    const normalised = normaliseOrgId(orgId);
    const route = this.routes.get(normalised) ?? this.defaultRoute;
    if (!route) {
      logBlocked(normalised);
      throw new IcsClientError('forbidden', 'Organisation not allowed for ICS routing');
    }
    return route;
  }

  private startCallSpan(
    operation: Operation,
    route: RouteState,
    correlationId?: string,
    organisationId?: string,
  ) {
    const span = startSpan('ics.call', {
      attributes: {
        'integration.provider': PROVIDER,
        'integration.operation': operation,
        'integration.endpoint': route.options.endpoint,
        'integration.route': route.key,
      },
    });
    if (correlationId && span.isRecording()) {
      span.setAttribute('integration.correlation_id', correlationId);
    }
    const orgAttribute = organisationId && organisationId.trim().length > 0 ? normaliseOrgId(organisationId) : route.key;
    span.setAttribute('integration.organisation_id', orgAttribute);
    return span;
  }

  private handleImmediateFailure(
    operation: Operation,
    route: RouteState,
    correlationId: string | undefined,
    organisationId: string,
    error: unknown,
  ): IcsClientError {
    const mapped =
      error instanceof IcsClientError
        ? error
        : new IcsClientError('upstream_unavailable', 'ICS request failed', error);
    recordFailureMetrics(operation, 0, mapped.code);
    logFailure(operation, route.options.endpoint, correlationId, mapped.code, 0, false);
    const span = this.startCallSpan(operation, route, correlationId, organisationId);
    span.recordException(mapped);
    span.setStatus({ code: SpanStatusCode.ERROR, message: mapped.message });
    span.end();
    return mapped;
  }

  private buildHeaders(route: RouteState, correlationId?: string): Record<string, string> {
    const headers: Record<string, string> = { ...route.options.headers };
    if (correlationId && correlationId.trim().length > 0) {
      headers[route.options.correlationHeader] = correlationId;
    }
    return headers;
  }
}

function defaultReferralDispatcher(
  _route: RouteState,
  request: IcsReferralRequest,
  _context: IcsCallContext,
): Promise<IcsReferralAck> {
  return delay(10).then(() => ({
    referralId: request.referralId,
    accepted: true,
  }));
}

function defaultAckDispatcher(
  _route: RouteState,
  _referralId: string,
  ack: IcsReferralAck,
  _context: IcsCallContext,
): Promise<IcsReferralAck> {
  return delay(5).then(() => ack);
}

function toRouteOptions(route: IcsRouteConfig | undefined): IcsRouteOptions | undefined {
  if (!route?.endpoint) return undefined;
  const headers: Record<string, string> = { ...(route.headers ?? {}) };
  if (route.apiKey && !headers.Authorization) {
    headers.Authorization = route.apiKey.startsWith('Bearer ')
      ? route.apiKey
      : `Bearer ${route.apiKey}`;
  }
  return {
    endpoint: route.endpoint,
    headers: Object.keys(headers).length > 0 ? headers : undefined,
    timeoutMs: route.timeoutMs,
    retry: route.retry,
    circuitBreaker: route.circuitBreaker,
    correlationHeader: route.correlationHeader,
    tls: route.tls,
    rateLimitPerMinute: route.rateLimitPerMinute,
  };
}

function normaliseOrgId(orgId: string): string {
  return orgId.trim().toLowerCase();
}

function createRouteState(key: string, options: IcsRouteOptions): RouteState {
  const correlationHeader = typeof options.correlationHeader === 'string'
    ? options.correlationHeader.trim()
    : undefined;
  const safeEndpoint = ensureSafeIcsEndpoint(options.endpoint);
  const resolved: RouteOptionsResolved = {
    endpoint: safeEndpoint,
    headers: sanitizeHeaders(options.headers),
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    retry: normalizeRetryPolicy(options.retry),
    circuitBreaker: normalizeCircuitPolicy(options.circuitBreaker),
    correlationHeader: correlationHeader && correlationHeader.length > 0 ? correlationHeader : DEFAULT_CORRELATION_HEADER,
    tls: options.tls,
    rateLimitPerMinute: options.rateLimitPerMinute,
  };
  if (resolved.rateLimitPerMinute && resolved.rateLimitPerMinute < 0) {
    resolved.rateLimitPerMinute = undefined;
  }
  const circuitBreaker = new CircuitBreaker(resolved.circuitBreaker);
  const rateLimiter = new RateLimiter(resolved.rateLimitPerMinute);
  return {
    key,
    options: resolved,
    circuitBreaker,
    rateLimiter,
  };
}

function normalizeRetryPolicy(input?: Partial<RetryPolicy>): RetryPolicy {
  const attempts = clampInteger(input?.attempts, DEFAULT_RETRY_POLICY.attempts, 0, 5);
  const baseDelayMs = clampNumber(input?.baseDelayMs, DEFAULT_RETRY_POLICY.baseDelayMs, 10, 10_000);
  const maxDelayMs = clampNumber(
    input?.maxDelayMs,
    DEFAULT_RETRY_POLICY.maxDelayMs,
    baseDelayMs,
    60_000,
  );
  const jitterRatio = clampNumber(input?.jitterRatio, DEFAULT_RETRY_POLICY.jitterRatio, 0, 1);
  return { attempts, baseDelayMs, maxDelayMs, jitterRatio };
}

function normalizeCircuitPolicy(input?: Partial<CircuitBreakerPolicy>): CircuitBreakerPolicy {
  const failureThreshold = clampInteger(
    input?.failureThreshold,
    DEFAULT_CIRCUIT_POLICY.failureThreshold,
    1,
    20,
  );
  const cooldownMs = clampNumber(input?.cooldownMs, DEFAULT_CIRCUIT_POLICY.cooldownMs, 1_000, 300_000);
  return { failureThreshold, cooldownMs };
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
        reject(new IcsClientError('upstream_timeout', 'ICS request timed out'));
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
    });
    return await Promise.race([factory(), timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function mapProviderError(error: unknown): IcsClientError {
  if (error instanceof IcsClientError) return error;
  if (error instanceof Error && error.name === 'AbortError') {
    return new IcsClientError('upstream_timeout', 'ICS request timed out', error);
  }
  const status = extractStatus(error);
  if (status !== undefined) {
    if (status === 400 || status === 422) {
      return new IcsClientError('invalid_input', 'ICS rejected request', error);
    }
    if (status === 401 || status === 403) {
      return new IcsClientError('forbidden', 'ICS authentication failed', error);
    }
    if (status === 408) {
      return new IcsClientError('upstream_timeout', 'ICS request timed out', error);
    }
    if (status === 409) {
      return new IcsClientError('conflict', 'ICS duplicate detected', error);
    }
    if (status === 429) {
      return new IcsClientError('rate_limited', 'ICS rate limit exceeded', error);
    }
    if (status >= 500) {
      return new IcsClientError('upstream_unavailable', 'ICS service unavailable', error);
    }
  }
  const code = (error as { code?: string }).code;
  if (typeof code === 'string') {
    const lowered = code.toLowerCase();
    if (lowered === 'etimedout') {
      return new IcsClientError('upstream_timeout', 'ICS request timed out', error);
    }
    if (lowered === 'econnrefused' || lowered === 'ehostunreach') {
      return new IcsClientError('upstream_unavailable', 'ICS service unavailable', error);
    }
    if (lowered.includes('rate') && lowered.includes('limit')) {
      return new IcsClientError('rate_limited', 'ICS rate limit exceeded', error);
    }
  }
  return new IcsClientError('internal_error', 'ICS request failed', error);
}

function extractStatus(error: unknown): number | undefined {
  const candidate = error as { status?: number; response?: { status?: number }; httpStatus?: number };
  if (candidate?.status && Number.isFinite(candidate.status)) return candidate.status;
  if (candidate?.response?.status && Number.isFinite(candidate.response.status)) return candidate.response.status;
  if (candidate?.httpStatus && Number.isFinite(candidate.httpStatus)) return candidate.httpStatus;
  return undefined;
}

function shouldRetry(error: IcsClientError): boolean {
  return (
    error.code === 'upstream_timeout' ||
    error.code === 'upstream_unavailable' ||
    error.code === 'internal_error' ||
    error.code === 'unknown' ||
    error.code === 'rate_limited'
  );
}

function calculateDelay(policy: RetryPolicy, attempt: number): number {
  const exponent = Math.max(0, attempt - 1);
  const exponential = policy.baseDelayMs * Math.pow(2, exponent);
  const capped = Math.min(exponential, policy.maxDelayMs);
  const jitter = capped * policy.jitterRatio * Math.random();
  return capped + jitter;
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim().length > 0
        ? Number(value)
        : undefined;
  if (parsed === undefined || !Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  return Math.round(clampNumber(value, fallback, min, max));
}

function sanitizeHeaders(headers?: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  if (headers) {
    for (const [key, value] of Object.entries(headers)) {
      if (typeof value !== 'string') continue;
      const trimmedKey = key.trim();
      const trimmedValue = value.trim();
      if (!trimmedKey || !trimmedValue) continue;
      result[trimmedKey] = trimmedValue;
    }
  }
  if (!result['Content-Type']) {
    result['Content-Type'] = 'application/json';
  }
  if (!result.Accept) {
    result.Accept = 'application/json';
  }
  return result;
}

function applyRouteCredentialUpdate(route: RouteState, update: RouteCredentialUpdate): void {
  if (update.headers || update.apiKey !== undefined) {
    const headersSource = update.headers ? { ...update.headers } : { ...route.options.headers };
    if (update.apiKey !== undefined) {
      const trimmed = update.apiKey?.trim();
      if (!trimmed) {
        delete headersSource.Authorization;
      } else {
        headersSource.Authorization = trimmed.startsWith('Bearer ')
          ? trimmed
          : `Bearer ${trimmed}`;
      }
    }
    route.options.headers = sanitizeHeaders(headersSource);
  }
  if (update.correlationHeader !== undefined) {
    const trimmed = update.correlationHeader?.trim() ?? '';
    route.options.correlationHeader = trimmed.length > 0 ? trimmed : DEFAULT_CORRELATION_HEADER;
  }
  if (update.tls !== undefined) {
    route.options.tls = update.tls || undefined;
  }
}

function ensureSafeIcsEndpoint(candidate: string): string {
  const trimmed = candidate.trim();
  if (!trimmed) {
    throw new Error('ics_endpoint_missing');
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('ics_endpoint_invalid');
  }
  if (parsed.protocol !== 'https:') {
    throw new Error('ics_endpoint_insecure');
  }
  if (parsed.username || parsed.password) {
    throw new Error('ics_endpoint_credentials_not_allowed');
  }
  if (parsed.search || parsed.hash) {
    throw new Error('ics_endpoint_extraneous');
  }
  if (isBlockedHostname(parsed.hostname)) {
    throw new Error('ics_endpoint_blocked');
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
    const segments = lower.split('.').map((segment) => Number(segment));
    if (segments.length !== 4 || segments.some((segment) => Number.isNaN(segment) || segment < 0 || segment > 255)) {
      return true;
    }
    const [a, b] = segments;
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

class RateLimiter {
  private windowStart = 0;
  private count = 0;

  constructor(private readonly limit?: number) {}

  consume(): void {
    if (!this.limit || this.limit <= 0) return;
    const now = Date.now();
    if (now - this.windowStart >= 60_000) {
      this.windowStart = now;
      this.count = 0;
    }
    if (this.count >= this.limit) {
      throw new IcsClientError('rate_limited', 'ICS rate limit exceeded');
    }
    this.count += 1;
  }
}

export function buildIcsClientFromConfig(config: ResolvedConfig, overrides?: Partial<IcsClientOptions>): IcsHttpClient {
  return IcsHttpClient.fromConfig(config, overrides);
}

export function toIcsClientOptions(icsConfig?: IcsConfig): IcsClientOptions {
  const routes: Record<string, IcsRouteOptions> = {};
  if (icsConfig?.routes) {
    for (const [org, route] of Object.entries(icsConfig.routes)) {
      const parsed = toRouteOptions(route);
      if (parsed) routes[org] = parsed;
    }
  }
  const defaultRoute = icsConfig?.default ? toRouteOptions(icsConfig.default) : undefined;
  if (Object.keys(routes).length === 0 && !defaultRoute) {
    throw new Error('ics_routes_missing');
  }
  return { routes, defaultRoute };
}
