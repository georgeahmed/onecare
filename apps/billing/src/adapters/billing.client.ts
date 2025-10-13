import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import type { ResolvedConfig, BillingConfig, IcsTlsConfig } from '@onecare/config';
import { createHistogram, createCounter, logger } from '@onecare/observability';

export interface ClaimPayload {
  claimId: string;
  encounterId: string;
  amount: number;
  currency: string;
  metadata?: Record<string, unknown>;
}

export interface ClaimResponse {
  claimId: string;
  status: 'accepted' | 'pending' | 'rejected';
  reason?: string;
}

export interface BillingCallOptions {
  correlationId?: string;
}

export interface BillingClient {
  submitClaim(claim: ClaimPayload, options?: BillingCallOptions): Promise<ClaimResponse>;
  getResponse(claimId: string, options?: BillingCallOptions): Promise<ClaimResponse>;
}

export type BillingErrorCode =
  | 'invalid_input'
  | 'forbidden'
  | 'upstream_timeout'
  | 'upstream_unavailable'
  | 'conflict'
  | 'internal_error'
  | 'unknown';

export class BillingClientError extends Error {
  constructor(public readonly code: BillingErrorCode, message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'BillingClientError';
  }
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

export interface BillingClientOptions {
  endpoint: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  retry?: Partial<RetryPolicy>;
  circuitBreaker?: Partial<CircuitBreakerPolicy>;
  correlationHeader?: string;
  tls?: IcsTlsConfig;
  submitDispatcher?: ClaimDispatcher;
  responseDispatcher?: ResponseDispatcher;
}

export interface BillingCallContext {
  endpoint: string;
  headers: Record<string, string>;
  correlationId?: string;
  timeoutMs: number;
  attempt: number;
  signal: AbortSignal;
  tls?: IcsTlsConfig;
  operation: 'claim' | 'response';
}

export type ClaimDispatcher = (claim: ClaimPayload, context: BillingCallContext) => Promise<ClaimResponse>;
export type ResponseDispatcher = (claimId: string, context: BillingCallContext) => Promise<ClaimResponse>;

const DEFAULT_TIMEOUT_MS = 3_000;
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

const claimLatencyHistogram = createHistogram('billing_claim_latency_ms');
const claimSuccessCounter = createCounter('billing_claim_success_total');
const claimErrorCounter = createCounter('billing_claim_error_total');
const responseLatencyHistogram = createHistogram('billing_response_latency_ms');
const responseSuccessCounter = createCounter('billing_response_success_total');
const responseErrorCounter = createCounter('billing_response_error_total');
const circuitOpenCounter = createCounter('billing_circuit_open_total');

export class BillingHttpClient implements BillingClient {
  private readonly options: ResolvedClientOptions;
  private readonly circuitBreaker: CircuitBreaker;
  private readonly submitDispatcher: ClaimDispatcher;
  private readonly responseDispatcher: ResponseDispatcher;

  constructor(options: BillingClientOptions) {
    if (!options?.endpoint) {
      throw new Error('billing_endpoint_missing');
    }
    this.options = normaliseClientOptions(options);
    this.circuitBreaker = new CircuitBreaker(this.options.circuitBreaker);
    this.submitDispatcher = options.submitDispatcher ?? defaultSubmitDispatcher;
    this.responseDispatcher = options.responseDispatcher ?? defaultResponseDispatcher;
  }

  static fromConfig(config: ResolvedConfig, overrides: Partial<BillingClientOptions> = {}): BillingHttpClient {
    const billing = (config.billing ?? {}) as BillingConfig;
    const headers = buildHeaders({ ...(billing.headers ?? {}) }, billing.apiKey);
    const endpoint = overrides.endpoint ?? billing.endpoint ?? readEnv('BILLING_ENDPOINT');
    if (!endpoint) {
      throw new Error('billing_endpoint_missing');
    }
    return new BillingHttpClient({
      endpoint,
      headers: { ...headers, ...(overrides.headers ?? {}) },
      timeoutMs: overrides.timeoutMs ?? billing.timeoutMs,
      retry: overrides.retry ?? billing.retry,
      circuitBreaker: overrides.circuitBreaker ?? billing.circuitBreaker,
      correlationHeader: overrides.correlationHeader ?? billing.correlationHeader,
      tls: overrides.tls ?? billing.tls,
      submitDispatcher: overrides.submitDispatcher,
      responseDispatcher: overrides.responseDispatcher,
    });
  }

  async submitClaim(claim: ClaimPayload, options?: BillingCallOptions): Promise<ClaimResponse> {
    if (!claim?.claimId) {
      throw new BillingClientError('invalid_input', 'claimId is required');
    }
    return this.executeWithGuard('claim', options, (context) => this.submitDispatcher(claim, context));
  }

  async getResponse(claimId: string, options?: BillingCallOptions): Promise<ClaimResponse> {
    if (!claimId || !claimId.trim()) {
      throw new BillingClientError('invalid_input', 'claimId is required');
    }
    return this.executeWithGuard('response', options, (context) => this.responseDispatcher(claimId.trim(), context));
  }

  private async executeWithGuard(
    operation: 'claim' | 'response',
    options: BillingCallOptions | undefined,
    executor: (context: BillingCallContext) => Promise<ClaimResponse>,
  ): Promise<ClaimResponse> {
    if (!this.circuitBreaker.canExecute()) {
      circuitOpenCounter.add(1, { operation });
      logger.warn('billing.circuit.open', { operation, correlationId: options?.correlationId });
      throw new BillingClientError('upstream_unavailable', 'Billing circuit breaker open');
    }

    const attributes = { operation };
    const start = performance.now();
    let attempt = 0;
    let lastError: BillingClientError | undefined;

    while (attempt <= this.options.retry.attempts) {
      const controller = new AbortController();
      const context: BillingCallContext = {
        endpoint: this.options.endpoint,
        headers: this.buildHeaders(options?.correlationId),
        correlationId: options?.correlationId,
        timeoutMs: this.options.timeoutMs,
        attempt,
        signal: controller.signal,
        tls: this.options.tls,
        operation,
      };
      try {
        const result = await withTimeout(() => executor(context), this.options.timeoutMs, controller);
        this.circuitBreaker.recordSuccess();
        recordSuccess(operation, performance.now() - start, attributes, options?.correlationId);
        return result;
      } catch (error) {
        const mapped = mapProviderError(error);
        lastError = mapped;
        this.circuitBreaker.recordFailure();
        recordFailure(operation, mapped.code, attributes, options?.correlationId, attempt, attempt < this.options.retry.attempts);
        if (attempt >= this.options.retry.attempts || !shouldRetry(mapped)) {
          throw mapped;
        }
        attempt += 1;
        const delayMs = calculateDelay(this.options.retry, attempt);
        await delay(delayMs);
      }
    }

    throw lastError ?? new BillingClientError('unknown', 'Billing request failed');
  }

  private buildHeaders(correlationId?: string): Record<string, string> {
    const headers: Record<string, string> = { ...this.options.headers };
    if (correlationId && correlationId.trim().length > 0) {
      headers[this.options.correlationHeader] = correlationId;
    }
    return headers;
  }
}

interface ResolvedClientOptions {
  endpoint: string;
  headers: Record<string, string>;
  timeoutMs: number;
  retry: RetryPolicy;
  circuitBreaker: CircuitBreakerPolicy;
  correlationHeader: string;
  tls?: IcsTlsConfig;
}

function normaliseClientOptions(options: BillingClientOptions): ResolvedClientOptions {
  return {
    endpoint: options.endpoint,
    headers: { ...(options.headers ?? {}) },
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    retry: normalizeRetryPolicy(options.retry),
    circuitBreaker: normalizeCircuitPolicy(options.circuitBreaker),
    correlationHeader: options.correlationHeader ?? DEFAULT_CORRELATION_HEADER,
    tls: options.tls,
  };
}

function recordSuccess(
  operation: 'claim' | 'response',
  durationMs: number,
  attributes: Record<string, unknown>,
  correlationId?: string,
): void {
  if (operation === 'claim') {
    claimSuccessCounter.add(1, attributes);
    claimLatencyHistogram.record(durationMs, attributes);
    logger.info('billing.claim.success', { ...attributes, correlationId, durationMs });
  } else {
    responseSuccessCounter.add(1, attributes);
    responseLatencyHistogram.record(durationMs, attributes);
    logger.info('billing.response.success', { ...attributes, correlationId, durationMs });
  }
}

function recordFailure(
  operation: 'claim' | 'response',
  code: BillingErrorCode,
  attributes: Record<string, unknown>,
  correlationId: string | undefined,
  attempt: number,
  retrying: boolean,
): void {
  const payload = { ...attributes, code, attempt, retrying, correlationId };
  if (operation === 'claim') {
    claimErrorCounter.add(1, { ...attributes, code });
    logger.warn('billing.claim.failure', payload);
  } else {
    responseErrorCounter.add(1, { ...attributes, code });
    logger.warn('billing.response.failure', payload);
  }
}

async function defaultSubmitDispatcher(claim: ClaimPayload, _context: BillingCallContext): Promise<ClaimResponse> {
  await delay(10);
  return {
    claimId: claim.claimId,
    status: 'accepted',
  };
}

async function defaultResponseDispatcher(claimId: string, _context: BillingCallContext): Promise<ClaimResponse> {
  await delay(5);
  return {
    claimId,
    status: 'pending',
  };
}

function readEnv(key: string): string | undefined {
  const value = process.env[key]?.trim();
  return value && value.length > 0 ? value : undefined;
}

function buildHeaders(headers: Record<string, string>, apiKey?: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === 'string' && value.trim().length > 0) {
      result[key] = value.trim();
    }
  }
  if (apiKey && !result.Authorization) {
    result.Authorization = apiKey.startsWith('Bearer ') ? apiKey : `Bearer ${apiKey}`;
  }
  if (!result['Content-Type']) {
    result['Content-Type'] = 'application/json';
  }
  return result;
}

async function withTimeout<T>(factory: () => Promise<T>, timeoutMs: number, controller: AbortController): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeoutPromise = new Promise<T>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new BillingClientError('upstream_timeout', 'Billing request timed out'));
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
    });
    return await Promise.race([factory(), timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function mapProviderError(error: unknown): BillingClientError {
  if (error instanceof BillingClientError) return error;
  if (error instanceof Error && error.name === 'AbortError') {
    return new BillingClientError('upstream_timeout', 'Billing request timed out', error);
  }
  const status = extractStatus(error);
  if (status !== undefined) {
    if (status === 400 || status === 422) {
      return new BillingClientError('invalid_input', 'Billing request invalid', error);
    }
    if (status === 401 || status === 403) {
      return new BillingClientError('forbidden', 'Billing auth failed', error);
    }
    if (status === 408) {
      return new BillingClientError('upstream_timeout', 'Billing request timed out', error);
    }
    if (status === 409) {
      return new BillingClientError('conflict', 'Billing duplicate detected', error);
    }
    if (status >= 500) {
      return new BillingClientError('upstream_unavailable', 'Billing service unavailable', error);
    }
  }
  const code = (error as { code?: string }).code;
  if (typeof code === 'string') {
    const lowered = code.toLowerCase();
    if (lowered === 'etimedout') {
      return new BillingClientError('upstream_timeout', 'Billing request timed out', error);
    }
    if (lowered === 'econnrefused' || lowered === 'ehostunreach') {
      return new BillingClientError('upstream_unavailable', 'Billing service unavailable', error);
    }
  }
  return new BillingClientError('internal_error', 'Billing request failed', error);
}

function extractStatus(error: unknown): number | undefined {
  const candidate = error as { status?: number; response?: { status?: number }; httpStatus?: number };
  if (candidate?.status && Number.isFinite(candidate.status)) return candidate.status;
  if (candidate?.response?.status && Number.isFinite(candidate.response.status)) return candidate.response.status;
  if (candidate?.httpStatus && Number.isFinite(candidate.httpStatus)) return candidate.httpStatus;
  return undefined;
}

function shouldRetry(error: BillingClientError): boolean {
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

function normalizeRetryPolicy(input?: Partial<RetryPolicy>): RetryPolicy {
  const attempts = clampInteger(input?.attempts ?? DEFAULT_RETRY_POLICY.attempts, 0, 5);
  const baseDelayMs = clampNumber(input?.baseDelayMs ?? DEFAULT_RETRY_POLICY.baseDelayMs, 10, 10_000);
  const maxDelayMs = clampNumber(input?.maxDelayMs ?? DEFAULT_RETRY_POLICY.maxDelayMs, baseDelayMs, 60_000);
  const jitterRatio = clampNumber(input?.jitterRatio ?? DEFAULT_RETRY_POLICY.jitterRatio, 0, 1);
  return { attempts, baseDelayMs, maxDelayMs, jitterRatio };
}

function normalizeCircuitPolicy(input?: Partial<CircuitBreakerPolicy>): CircuitBreakerPolicy {
  const failureThreshold = clampInteger(input?.failureThreshold ?? DEFAULT_CIRCUIT_POLICY.failureThreshold, 1, 20);
  const cooldownMs = clampNumber(input?.cooldownMs ?? DEFAULT_CIRCUIT_POLICY.cooldownMs, 1_000, 300_000);
  return { failureThreshold, cooldownMs };
}

function clampNumber(value: unknown, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : undefined;
  if (parsed === undefined || !Number.isFinite(parsed)) return min;
  return Math.min(Math.max(parsed, min), max);
}

function clampInteger(value: unknown, min: number, max: number): number {
  return Math.round(clampNumber(value, min, max));
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

export function buildBillingClient(config: ResolvedConfig, overrides?: Partial<BillingClientOptions>): BillingHttpClient {
  return BillingHttpClient.fromConfig(config, overrides);
}
