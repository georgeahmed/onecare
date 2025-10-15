import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { SpanStatusCode } from '@opentelemetry/api';
import {
  createCounter,
  createHistogram,
  getCorrelationId,
  startSpan,
  type CounterMetric,
  type HistogramMetric,
} from '@onecare/observability';
import type { FhirBundle, FhirRepository, FhirResourceRef } from '@onecare/ports';

type FetchImpl = typeof fetch;

const REQUEST_LATENCY_METRIC = 'fhir_request_latency_ms';
const REQUEST_TOTAL_METRIC = 'fhir_requests_total';
const REQUEST_ERROR_METRIC = 'fhir_request_errors_total';

const DEFAULT_TIMEOUT_MS = 5_000;
const MIN_TIMEOUT_MS = 500;
const MAX_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 2;
const MAX_RETRIES = 5;
const RETRY_BASE_DELAY_MS = 150;
const RETRY_JITTER_MS = 75;

const latencyHistogram: HistogramMetric = createHistogram(REQUEST_LATENCY_METRIC);
const totalCounter: CounterMetric = createCounter(REQUEST_TOTAL_METRIC);
const errorCounter: CounterMetric = createCounter(REQUEST_ERROR_METRIC);

export interface HttpFhirRepositoryOptions {
  baseUrl: string;
  authToken?: string;
  timeoutMs?: number;
  maxRetries?: number;
  fetchImpl?: FetchImpl;
  practiceId?: string;
}

export class FhirRequestError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly operation?: string,
    public readonly retryable?: boolean,
    public readonly body?: unknown,
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

  constructor(options: HttpFhirRepositoryOptions) {
    if (!options?.baseUrl) {
      throw new Error('HttpFhirRepository requires a baseUrl');
    }
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.authHeader = buildAuthHeader(options.authToken);
    this.timeoutMs = clampTimeout(options.timeoutMs);
    this.maxRetries = clampRetries(options.maxRetries);
    this.fetchImpl = options.fetchImpl?.bind(globalThis) ?? globalThis.fetch.bind(globalThis);
    this.practiceId = options.practiceId;
  }

  async upsertBundle(bundle: FhirBundle): Promise<FhirBundle> {
    return this.request<FhirBundle>({
      method: 'POST',
      path: '',
      body: bundle,
      operation: 'Bundle.upsert',
      preferRepresentation: true,
    });
  }

  async createTask(task: unknown): Promise<FhirResourceRef> {
    return this.request<FhirResourceRef>({
      method: 'POST',
      path: 'Task',
      body: task,
      operation: 'Task.create',
      preferRepresentation: true,
    });
  }

  async createAppointment(appt: unknown): Promise<FhirResourceRef> {
    return this.request<FhirResourceRef>({
      method: 'POST',
      path: 'Appointment',
      body: appt,
      operation: 'Appointment.create',
      preferRepresentation: true,
    });
  }

  async createDocumentReference(doc: unknown): Promise<FhirResourceRef> {
    return this.request<FhirResourceRef>({
      method: 'POST',
      path: 'DocumentReference',
      body: doc,
      operation: 'DocumentReference.create',
      preferRepresentation: true,
    });
  }

  async updateTask(taskId: string, patch: unknown): Promise<void> {
    await this.request<void>({
      method: 'PUT',
      path: `Task/${encodeURIComponent(taskId)}`,
      body: patch,
      operation: 'Task.update',
      preferRepresentation: false,
    });
  }

  private async request<T>({
    method,
    path,
    body,
    operation,
    preferRepresentation,
  }: {
    method: 'POST' | 'PUT';
    path: string;
    body: unknown;
    operation: string;
    preferRepresentation: boolean;
  }): Promise<T> {
    const url = new URL(path, this.baseUrl).toString();
    let attempt = 0;
    let lastError: unknown;

    while (attempt <= this.maxRetries) {
      attempt += 1;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      const start = performance.now();
      const span = startSpan('fhir.request', {
        attributes: {
          'fhir.operation': operation,
          'fhir.url': url,
          'http.method': method,
          ...(this.practiceId ? { 'fhir.practice_id': this.practiceId } : {}),
        },
      });
      try {
        const headers: Record<string, string> = {
          accept: 'application/fhir+json',
          'content-type': 'application/fhir+json',
        };
        if (preferRepresentation) headers.prefer = 'return=representation';
        if (this.authHeader) headers.authorization = this.authHeader;
        const correlationId = getCorrelationId();
        if (correlationId) headers['x-correlation-id'] = correlationId;

        const response = await this.fetchImpl(url, {
          method,
          headers,
          body: body ? JSON.stringify(body) : undefined,
          signal: controller.signal,
        });

        clearTimeout(timer);
        const durationMs = performance.now() - start;
        this.recordMetrics(durationMs, method, path, response.status, attempt);
        span.setAttribute('http.status_code', response.status);

        if (!response.ok) {
          const responseBody = await parseJsonBody(response);
          const retryable = isRetryableStatus(response.status);
          if (span.isRecording()) {
            span.setStatus({ code: SpanStatusCode.ERROR, message: String(response.status) });
            span.recordException(
              new Error(`FHIR request failed with status ${response.status}`),
            );
          }

          if (retryable && attempt <= this.maxRetries) {
            await this.waitBeforeRetry(attempt);
            continue;
          }

          const error = new FhirRequestError(
            `FHIR request failed with status ${response.status}`,
            response.status,
            operation,
            retryable,
            responseBody,
          );
          errorCounter.add(1, this.metricAttributes(method, path, response.status, attempt));
          throw error;
        }

        if (span.isRecording()) {
          span.setStatus({ code: SpanStatusCode.OK });
        }
        return (await parseJsonBody(response)) as T;
      } catch (err) {
        clearTimeout(timer);
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
          this.recordMetrics(durationMs, method, path, 0, attempt);
          errorCounter.add(1, this.metricAttributes(method, path, 0, attempt));
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

        lastError = errorToThrow;
        throw errorToThrow;
      } finally {
        span.end();
      }
    }

    throw lastError ?? new Error('FHIR request failed');
  }

  private async waitBeforeRetry(attempt: number): Promise<void> {
    const backoff = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
    const jitter = Math.random() * RETRY_JITTER_MS;
    await delay(backoff + jitter);
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
