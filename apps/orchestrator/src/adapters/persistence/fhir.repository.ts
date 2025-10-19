import * as http from 'node:http';
import * as https from 'node:https';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { SpanStatusCode } from '@opentelemetry/api';
import {
  createCounter,
  createHistogram,
  getCorrelationId,
  logger,
  startSpan,
  type CounterMetric,
  type HistogramMetric,
} from '@onecare/observability';
import type {
  FhirBundle,
  FhirReadOptions,
  FhirRepository,
  FhirResourceRef,
  TaskCreateOptions,
} from '@onecare/ports';

type FetchImpl = typeof fetch;
type CircuitState = 'closed' | 'open' | 'half_open';

const REQUEST_LATENCY_METRIC = 'fhir_request_latency_ms';
const REQUEST_TOTAL_METRIC = 'fhir_requests_total';
const REQUEST_ERROR_METRIC = 'fhir_request_errors_total';
const CIRCUIT_OPEN_METRIC = 'fhir_circuit_open_total';
const CIRCUIT_HALF_OPEN_METRIC = 'fhir_circuit_half_open_total';
const TRANSACTION_DURATION_METRIC = 'fhir.transaction.duration_ms';

const DEFAULT_TIMEOUT_MS = 5_000;
const MIN_TIMEOUT_MS = 500;
const MAX_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 2;
const MAX_RETRIES = 5;
const RETRY_BASE_DELAY_MS = 150;
const RETRY_JITTER_MS = 75;
const DEFAULT_CIRCUIT_FAILURE_THRESHOLD = 3;
const DEFAULT_CIRCUIT_COOLDOWN_MS = 15_000;
const DEFAULT_CIRCUIT_HALF_OPEN_SUCCESS = 2;

const latencyHistogram: HistogramMetric = createHistogram(REQUEST_LATENCY_METRIC);
const totalCounter: CounterMetric = createCounter(REQUEST_TOTAL_METRIC);
const errorCounter: CounterMetric = createCounter(REQUEST_ERROR_METRIC);
const circuitOpenedCounter: CounterMetric = createCounter(CIRCUIT_OPEN_METRIC);
const circuitHalfOpenCounter: CounterMetric = createCounter(CIRCUIT_HALF_OPEN_METRIC);
const transactionDurationHistogram: HistogramMetric = createHistogram(TRANSACTION_DURATION_METRIC);

function createKeepAliveFetch(baseUrl: string, timeoutMs: number): FetchImpl {
  const parsed = new URL(baseUrl);
  const isHttps = parsed.protocol === 'https:';
  const httpModule = isHttps ? https : http;
  const agent = new httpModule.Agent({
    keepAlive: true,
    keepAliveMsecs: 1_000,
    maxSockets: 50,
    timeout: 60_000,
  });

  return async (input, init = {}) =>
    new Promise<Response>((resolve, reject) => {
      const target = typeof input === 'string' ? new URL(input) : new URL(input.toString());
      const headersInit: Record<string, string> = {};
      if (init.headers instanceof Headers) {
        for (const [key, value] of init.headers.entries()) {
          headersInit[key] = value;
        }
      } else if (Array.isArray(init.headers)) {
        for (const [key, value] of init.headers) {
          headersInit[key] = value;
        }
      } else if (init.headers && typeof init.headers === 'object') {
        Object.assign(headersInit, init.headers as Record<string, string>);
      }
      const requestOptions: http.RequestOptions = {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port ? Number(target.port) : target.protocol === 'https:' ? 443 : 80,
        path: `${target.pathname}${target.search}`,
        method: init.method ?? 'GET',
        headers: headersInit,
        agent,
      };

      const request = httpModule.request(requestOptions, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        res.on('end', () => {
          const body = Buffer.concat(chunks);
          const headers = new Headers();
          for (const [key, value] of Object.entries(res.headers)) {
            if (Array.isArray(value)) {
              headers.set(key, value.join(', '));
            } else if (value !== undefined) {
              headers.set(key, String(value));
            }
          }
          resolve(new Response(body, { status: res.statusCode ?? 0, statusText: res.statusMessage ?? '', headers }));
        });
      });

      request.setTimeout(timeoutMs, () => {
        request.destroy(new Error('RequestTimeout'));
      });

      request.on('error', (error) => reject(error));

      if (init.body instanceof Uint8Array || Buffer.isBuffer(init.body)) {
        request.write(init.body);
      } else if (typeof init.body === 'string') {
        request.write(init.body);
      } else if (init.body instanceof ArrayBuffer) {
        request.write(Buffer.from(init.body));
      }

      const signal = init.signal;
      const onAbort = () => {
        request.destroy(new Error('AbortError'));
      };
      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
        request.on('close', () => signal.removeEventListener('abort', onAbort));
      }

      request.end();
    });
}

export interface HttpFhirRepositoryOptions {
  baseUrl: string;
  authToken?: string;
  timeoutMs?: number;
  maxRetries?: number;
  fetchImpl?: FetchImpl;
  practiceId?: string;
  circuitBreakerThreshold?: number;
  circuitBreakerCooldownMs?: number;
  circuitBreakerHalfOpenSuccesses?: number;
}

export class FhirRequestError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly operation?: string,
    public readonly retryable?: boolean,
    public readonly body?: unknown,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'FhirRequestError';
  }
}

export function isFhirRequestError(err: unknown): err is FhirRequestError {
  return err instanceof FhirRequestError;
}

function normalizeBaseUrl(raw: string): string {
  const url = new URL(raw.trim());
  if (!url.pathname.endsWith('/')) {
    url.pathname = `${url.pathname}/`;
  }
  return url.toString();
}

function clampTimeout(timeoutMs: number | undefined): number {
  if (!Number.isFinite(timeoutMs ?? NaN)) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(timeoutMs!, MIN_TIMEOUT_MS), MAX_TIMEOUT_MS);
}

function clampRetries(value: number | undefined): number {
  if (!Number.isFinite(value ?? NaN)) return DEFAULT_MAX_RETRIES;
  const parsed = Math.floor(value!);
  return Math.min(Math.max(parsed, 0), MAX_RETRIES);
}

function buildAuthHeader(token: string | undefined): string | undefined {
  if (!token) return undefined;
  const trimmed = token.trim();
  if (!trimmed) return undefined;
  if (/^(basic|bearer)\s/i.test(trimmed)) return trimmed;
  return `Bearer ${trimmed}`;
}

function sanitizePathForTelemetry(rawPath: string): string {
  if (!rawPath) return '/';
  let candidate = rawPath;
  try {
    const maybeUrl = new URL(rawPath);
    candidate = maybeUrl.pathname || '/';
  } catch {
    const queryIndex = candidate.indexOf('?');
    candidate = queryIndex >= 0 ? candidate.slice(0, queryIndex) : candidate;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) {
      try {
        const parsed = new URL(candidate);
        candidate = parsed.pathname || '/';
      } catch {
        candidate = '/';
      }
    }
  }
  candidate = candidate.replace(/\/\/+/g, '/');
  if (!candidate || candidate === '/') {
    return '/';
  }
  if (candidate.startsWith('/')) {
    candidate = candidate.slice(1);
  }
  if (candidate.endsWith('/')) {
    candidate = candidate.slice(0, -1);
  }
  if (!candidate) return '/';
  const segments = candidate
    .split('/')
    .map((segment, index) => {
      if (!segment) return '';
      if (segment === '.' || segment === '..') return '';
      if (segment.startsWith('_') || segment.startsWith('$')) return segment;
      if (index === 0) {
        return segment;
      }
      if (/^[A-Za-z]+$/.test(segment)) {
        return segment;
      }
      return ':id';
    })
    .filter(Boolean);
  return segments.length > 0 ? segments.join('/') : '/';
}

function isRetryableStatus(status: number): boolean {
  if (status === 408 || status === 429) return true;
  return status >= 500 && status < 600;
}

function isAbortError(err: unknown): boolean {
  if (!err) return false;
  if (err instanceof DOMException && err.name === 'AbortError') return true;
  if ((err as { name?: string }).name === 'AbortError') return true;
  return false;
}

function parseRetryAfterHeader(value: string | null): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1_000);
  }
  const parsedDate = Date.parse(trimmed);
  if (Number.isFinite(parsedDate)) {
    const diff = parsedDate - Date.now();
    return diff > 0 ? diff : 0;
  }
  return null;
}

async function parseJsonBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export class HttpFhirRepository implements FhirRepository {
  private readonly baseUrl: string;
  private readonly authHeader?: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetchImpl: FetchImpl;
  private readonly practiceId?: string;
  private readonly circuitFailureThreshold: number;
  private readonly circuitCooldownMs: number;
  private readonly circuitHalfOpenSuccessRequirement: number;
  private circuitState: CircuitState = 'closed';
  private circuitOpenedAt = 0;
  private consecutiveFailures = 0;
  private halfOpenSuccesses = 0;

  constructor(options: HttpFhirRepositoryOptions) {
    if (!options?.baseUrl) {
      throw new Error('HttpFhirRepository requires a baseUrl');
    }
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.authHeader = buildAuthHeader(options.authToken);
    this.timeoutMs = clampTimeout(options.timeoutMs);
    this.maxRetries = clampRetries(options.maxRetries);
    this.fetchImpl = options.fetchImpl?.bind(globalThis) ?? createKeepAliveFetch(this.baseUrl, this.timeoutMs);
    this.practiceId = options.practiceId;
    this.circuitFailureThreshold =
      Number.isFinite(options.circuitBreakerThreshold)
        ? Math.max(1, Math.floor(options.circuitBreakerThreshold!))
        : DEFAULT_CIRCUIT_FAILURE_THRESHOLD;
    this.circuitCooldownMs =
      Number.isFinite(options.circuitBreakerCooldownMs)
        ? Math.max(1_000, Math.floor(options.circuitBreakerCooldownMs!))
        : DEFAULT_CIRCUIT_COOLDOWN_MS;
    this.circuitHalfOpenSuccessRequirement =
      Number.isFinite(options.circuitBreakerHalfOpenSuccesses)
        ? Math.max(1, Math.floor(options.circuitBreakerHalfOpenSuccesses!))
        : DEFAULT_CIRCUIT_HALF_OPEN_SUCCESS;
  }

  async upsertBundle(bundle: FhirBundle): Promise<FhirBundle> {
    const start = performance.now();
    const result = await this.request<FhirBundle>({
      method: 'POST',
      path: '',
      body: bundle,
      operation: 'Bundle.upsert',
      preferRepresentation: true,
      idempotent: true,
      expectJsonBody: true,
    });
    const duration = performance.now() - start;
    transactionDurationHistogram.record(Number(duration.toFixed(2)), {
      operation: 'Bundle.upsert',
      practiceId: this.practiceId,
    });
    return result;
  }

  async createTask(task: unknown, options?: TaskCreateOptions): Promise<FhirResourceRef> {
    const headers: Record<string, string> = { ...(options?.headers ?? {}) };
    if (options?.idempotencyKey) {
      headers['idempotency-key'] = options.idempotencyKey;
    }
    return this.request<FhirResourceRef>({
      method: 'POST',
      path: 'Task',
      body: task,
      operation: 'Task.create',
      preferRepresentation: true,
      expectJsonBody: true,
      headers,
      signal: options?.signal,
    });
  }

  async createAppointment(appt: unknown): Promise<FhirResourceRef> {
    return this.request<FhirResourceRef>({
      method: 'POST',
      path: 'Appointment',
      body: appt,
      operation: 'Appointment.create',
      preferRepresentation: true,
      expectJsonBody: true,
    });
  }

  async createDocumentReference(doc: unknown): Promise<FhirResourceRef> {
    return this.request<FhirResourceRef>({
      method: 'POST',
      path: 'DocumentReference',
      body: doc,
      operation: 'DocumentReference.create',
      preferRepresentation: true,
      expectJsonBody: true,
    });
  }

  async readResource<T>(path: string, options?: FhirReadOptions): Promise<T> {
    const resolvedPath = this.buildRelativePath(path, options?.searchParams);
    const headers: Record<string, string> = { ...(options?.headers ?? {}) };
    if (options?.prefer) {
      headers.prefer = options.prefer;
    }
    return this.request<T>({
      method: 'GET',
      path: resolvedPath,
      operation: `Resource.read`,
      headers,
      idempotent: true,
      expectJsonBody: true,
    });
  }

  async updateTask(taskId: string, patch: unknown, options?: { ifMatch?: string }): Promise<void> {
    await this.request<void>({
      method: 'PUT',
      path: `Task/${encodeURIComponent(taskId)}`,
      body: patch,
      operation: 'Task.update',
      preferRepresentation: false,
      idempotent: true,
      ifMatch: options?.ifMatch,
      expectJsonBody: false,
    });
  }

  private async request<T>({
    method,
    path,
    body,
    operation,
    preferRepresentation,
    headers,
    idempotent,
    ifMatch,
    expectJsonBody,
    signal,
  }: {
    method: 'GET' | 'POST' | 'PUT';
    path: string;
    body?: unknown;
    operation: string;
    preferRepresentation?: boolean;
    headers?: Record<string, string>;
    idempotent?: boolean;
    ifMatch?: string;
    expectJsonBody?: boolean;
    signal?: AbortSignal;
  }): Promise<T> {
    const url = new URL(path, this.baseUrl).toString();
    const telemetryPath = sanitizePathForTelemetry(path);
    const wantsJsonResponse = expectJsonBody ?? (preferRepresentation === true || method === 'GET');
    this.ensureCircuitAllowsRequest(operation);
    let attempt = 0;
    let lastError: unknown;

    while (attempt <= this.maxRetries) {
      attempt += 1;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      const externalSignal = signal;
      const onExternalAbort = () => controller.abort();
      if (externalSignal) {
        if (externalSignal.aborted) {
          controller.abort();
        } else {
          externalSignal.addEventListener('abort', onExternalAbort);
        }
      }
      const cleanupExternal = () => {
        if (externalSignal) {
          externalSignal.removeEventListener('abort', onExternalAbort);
        }
      };
      const start = performance.now();
      const span = startSpan('fhir.request', {
        attributes: {
          'fhir.operation': operation,
          'fhir.path': telemetryPath,
          'http.route': telemetryPath === '/' ? '/' : `/${telemetryPath}`,
          'http.method': method,
          ...(this.practiceId ? { 'fhir.practice_id': this.practiceId } : {}),
        },
      });
      try {
        const requestHeaders: Record<string, string> = {
          accept: 'application/fhir+json; charset=utf-8',
        };
        if (method !== 'GET') {
          requestHeaders['content-type'] = 'application/fhir+json; charset=utf-8';
        }
        if (preferRepresentation) {
          requestHeaders.prefer = 'return=representation';
        }
        if (this.authHeader) {
          requestHeaders.authorization = this.authHeader;
        }
        if (ifMatch) {
          requestHeaders['if-match'] = ifMatch;
        }
        if (headers) {
          Object.assign(requestHeaders, headers);
        }
        const correlationId = getCorrelationId();
        if (correlationId) {
          requestHeaders['x-correlation-id'] = correlationId;
        }

        const payload = method !== 'GET' && body !== undefined ? JSON.stringify(body) : undefined;

        logger.debug('fhir.request.dispatch', {
          operation,
          method,
          path: telemetryPath,
          attempt,
        });

        const response = await this.fetchImpl(url, {
          method,
          headers: requestHeaders,
          body: payload,
          signal: controller.signal,
        });

        clearTimeout(timer);
        cleanupExternal();
        const elapsedMs = performance.now() - start;
        this.recordMetrics(elapsedMs, method, telemetryPath, response.status, attempt);
        span.setAttribute('http.status_code', response.status);

        if (!response.ok) {
          const responseBody = await parseJsonBody(response);
          const retryAfterMs = parseRetryAfterHeader(response.headers.get('retry-after'));
          const conflict = response.status === 409 || response.status === 412;
          const retryable = !conflict && isRetryableStatus(response.status);

          if (span.isRecording()) {
            span.setStatus({ code: SpanStatusCode.ERROR, message: String(response.status) });
            span.recordException(new Error(`FHIR request failed with status ${response.status}`));
          }

          if (retryable && attempt <= this.maxRetries) {
            logger.warn('fhir.request.retry', {
              operation,
              status: response.status,
              attempt,
            });
            await this.waitBeforeRetry(attempt, retryAfterMs ?? undefined);
            cleanupExternal();
            continue;
          }

          const error = new FhirRequestError(
            `FHIR request failed with status ${response.status}`,
            response.status,
            operation,
            retryable,
            responseBody,
            retryAfterMs ?? undefined,
          );
          errorCounter.add(1, this.metricAttributes(method, telemetryPath, response.status, attempt));

          const shouldTripCircuit = !conflict;
          if (conflict && idempotent) {
            logger.info('fhir.idempotent.conflict', {
              operation,
              status: response.status,
            });
            this.recordFailure(operation, false, error);
          } else {
            logger.warn('fhir.request.failed', {
              operation,
              status: response.status,
              attempt,
            });
            this.recordFailure(operation, shouldTripCircuit, error);
          }
          throw error;
        }

        if (span.isRecording()) {
          span.setStatus({ code: SpanStatusCode.OK });
        }
        if (wantsJsonResponse && response.status !== 204) {
          this.ensureJsonContentType(response, operation, telemetryPath);
        }
        logger.debug('fhir.request.succeeded', {
          operation,
          method,
          path: telemetryPath,
          attempt,
          durationMs: Number(elapsedMs.toFixed(2)),
        });
        this.recordSuccess(operation);
        if (method === 'GET') {
          if (response.status === 204) {
            return undefined as T;
          }
        }
        return (await parseJsonBody(response)) as T;
      } catch (err) {
        clearTimeout(timer);
        cleanupExternal();
        const durationMs = performance.now() - start;
        let retryable = false;
        let errorToThrow: FhirRequestError | Error;

        if (isFhirRequestError(err)) {
          retryable = err.retryable === true;
          errorToThrow = err;
        } else if (isAbortError(err)) {
          retryable = true;
          errorToThrow = new FhirRequestError('FHIR request aborted', undefined, operation, true);
        } else if (err instanceof TypeError) {
          retryable = true;
          errorToThrow = new FhirRequestError(err.message, undefined, operation, true);
        } else if (err instanceof Error) {
          errorToThrow = err;
        } else {
          errorToThrow = new Error(String(err));
        }

        if (!isFhirRequestError(err)) {
          this.recordMetrics(durationMs, method, telemetryPath, 0, attempt);
          errorCounter.add(1, this.metricAttributes(method, telemetryPath, 0, attempt));
        }

        if (isAbortError(err) && span.isRecording()) {
          span.setStatus({ code: SpanStatusCode.ERROR, message: 'timeout' });
          span.recordException(errorToThrow);
        }

        if (retryable && attempt <= this.maxRetries) {
          lastError = errorToThrow;
          await this.waitBeforeRetry(attempt);
          continue;
        }

        if (span.isRecording()) {
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: errorToThrow instanceof Error ? errorToThrow.message : String(errorToThrow),
          });
          span.recordException(errorToThrow);
        }

        const shouldTripCircuit = !(
          isFhirRequestError(errorToThrow) &&
          (errorToThrow.status === 409 || errorToThrow.status === 412)
        );
        this.recordFailure(operation, shouldTripCircuit, errorToThrow);
        lastError = errorToThrow;
        throw errorToThrow;
      } finally {
        span.end();
      }
    }

    throw lastError ?? new Error('FHIR request failed');
  }

  private async waitBeforeRetry(attempt: number, retryAfterMs?: number): Promise<void> {
    if (retryAfterMs !== undefined && Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
      await delay(retryAfterMs);
      return;
    }
    const backoff = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
    const jitter = Math.random() * RETRY_JITTER_MS;
    await delay(backoff + jitter);
  }

  private buildRelativePath(path: string, params?: Record<string, string | number | boolean | undefined>): string {
    const trimmed = path.trim();
    if (!trimmed) {
      throw new Error('fhir_path_required');
    }
    if (!params || Object.keys(params).length === 0) {
      return trimmed;
    }
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined) continue;
      search.set(key, String(value));
    }
    const query = search.toString();
    if (!query) return trimmed;
    return trimmed.includes('?') ? `${trimmed}&${query}` : `${trimmed}?${query}`;
  }

  private ensureCircuitAllowsRequest(operation: string): void {
    if (this.circuitState === 'open') {
      if (Date.now() - this.circuitOpenedAt >= this.circuitCooldownMs) {
        this.circuitState = 'half_open';
        this.halfOpenSuccesses = 0;
        circuitHalfOpenCounter.add(1, { operation });
        logger.warn('fhir.circuit.half_open', { operation });
      } else {
        throw this.circuitOpenError(operation);
      }
    }
  }

  private recordSuccess(operation: string): void {
    this.consecutiveFailures = 0;
    if (this.circuitState === 'half_open') {
      this.halfOpenSuccesses += 1;
      if (this.halfOpenSuccesses >= this.circuitHalfOpenSuccessRequirement) {
        this.transitionToClosed(operation);
      }
    }
  }

  private recordFailure(operation: string, shouldTripCircuit: boolean, err: unknown): void {
    if (!shouldTripCircuit) {
      if (this.circuitState === 'half_open') {
        this.transitionToClosed(operation);
      }
      this.consecutiveFailures = 0;
      return;
    }

    this.consecutiveFailures += 1;
    if (this.circuitState === 'half_open') {
      this.openCircuit(operation, err);
      return;
    }
    if (this.consecutiveFailures >= this.circuitFailureThreshold) {
      this.openCircuit(operation, err);
    }
  }

  private openCircuit(operation: string, err: unknown): void {
    this.circuitState = 'open';
    this.circuitOpenedAt = Date.now();
    this.consecutiveFailures = 0;
    this.halfOpenSuccesses = 0;
    circuitOpenedCounter.add(1, { operation });
    logger.error('fhir.circuit.open', {
      operation,
      cooldownMs: this.circuitCooldownMs,
      reason: err instanceof Error ? err.message : String(err),
    });
  }

  private transitionToClosed(operation: string): void {
    if (this.circuitState !== 'closed') {
      logger.info('fhir.circuit.closed', { operation });
    }
    this.circuitState = 'closed';
    this.circuitOpenedAt = 0;
    this.consecutiveFailures = 0;
    this.halfOpenSuccesses = 0;
  }

  private circuitOpenError(operation: string): FhirRequestError {
    return new FhirRequestError('circuit_open', undefined, operation, false);
  }

  private ensureJsonContentType(response: Response, operation: string, path: string): void {
    const contentType = response.headers.get('content-type');
    if (!contentType) {
      throw new FhirRequestError('missing_content_type', response.status, operation, false);
    }
    const normalized = contentType.trim().toLowerCase();
    if (!normalized.startsWith('application/fhir+json')) {
      throw new FhirRequestError(
        `unexpected_content_type:${contentType}`,
        response.status,
        operation,
        false,
      );
    }
    if (!/charset\s*=\s*utf-8/.test(normalized)) {
      logger.warn('fhir.response.charset_missing', {
        operation,
        path,
        contentType,
      });
    }
  }

  private recordMetrics(durationMs: number, method: string, path: string, status: number, attempt: number): void {
    const attrs = this.metricAttributes(method, path, status, attempt);
    latencyHistogram.record(Number(durationMs.toFixed(2)), attrs);
    totalCounter.add(1, attrs);
  }

  private metricAttributes(method: string, path: string, status: number, attempt: number): Record<string, unknown> {
    return {
      method,
      path,
      status,
      attempt,
      ...(this.practiceId ? { practiceId: this.practiceId } : {}),
    };
  }
}

export function createHttpFhirRepository(options: HttpFhirRepositoryOptions): HttpFhirRepository {
  return new HttpFhirRepository(options);
}
