import * as http from 'node:http';
import * as https from 'node:https';
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
import type { ObjectStore, ObjectStorePutOptions } from '@onecare/ports';

type FetchImpl = typeof fetch;

const REQUEST_LATENCY_METRIC = 'object_store_request_latency_ms';
const REQUEST_TOTAL_METRIC = 'object_store_requests_total';
const REQUEST_ERROR_METRIC = 'object_store_request_errors_total';
const OBJECT_PUT_DURATION_METRIC = 'object.store.put.duration_ms';

const DEFAULT_TIMEOUT_MS = 2_000;
const MIN_TIMEOUT_MS = 200;
const MAX_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RETRIES = 1;
const MAX_RETRIES = 4;
const RETRY_BASE_DELAY_MS = 100;
const RETRY_JITTER_MS = 50;

const latencyHistogram: HistogramMetric = createHistogram(REQUEST_LATENCY_METRIC);
const totalCounter: CounterMetric = createCounter(REQUEST_TOTAL_METRIC);
const errorCounter: CounterMetric = createCounter(REQUEST_ERROR_METRIC);
const objectPutDurationHistogram: HistogramMetric = createHistogram(OBJECT_PUT_DURATION_METRIC);

function createKeepAliveFetch(baseUrl: string, timeoutMs: number): FetchImpl {
  const parsed = new URL(baseUrl);
  const isHttps = parsed.protocol === 'https:';
  const httpModule = isHttps ? https : http;
  const agent = new httpModule.Agent({
    keepAlive: true,
    keepAliveMsecs: 1_000,
    maxSockets: 25,
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
      const onAbort = () => request.destroy(new Error('AbortError'));
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

export interface HttpObjectStoreOptions {
  baseUrl: string;
  timeoutMs?: number;
  maxRetries?: number;
  fetchImpl?: FetchImpl;
  authToken?: string;
}

export class ObjectStoreRequestError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly operation?: string,
    public readonly retryable?: boolean,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ObjectStoreRequestError';
  }
}

export function isObjectStoreRequestError(err: unknown): err is ObjectStoreRequestError {
  return err instanceof ObjectStoreRequestError;
}

function ensureHttpsUrl(raw: string): URL {
  const url = new URL(raw.trim());
  if (url.protocol !== 'https:') {
    throw new Error('ObjectStore baseUrl must use HTTPS');
  }
  return url;
}

function normalizeBaseUrl(raw: string): string {
  const url = ensureHttpsUrl(raw);
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
  return status === 408 || status === 429 || (status >= 500 && status < 600);
}

function normalizeKey(key: string): string {
  const trimmed = key.trim().replace(/^\//, '');
  if (!trimmed) {
    throw new Error('object_store_key_empty');
  }
  if (trimmed.includes('..')) {
    throw new Error('object_store_key_invalid');
  }
  return trimmed;
}

export class HttpObjectStore implements ObjectStore {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetchImpl: FetchImpl;
  private readonly authHeader?: string;

  constructor(options: HttpObjectStoreOptions) {
    if (!options?.baseUrl) {
      throw new Error('HttpObjectStore requires a baseUrl');
    }
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.timeoutMs = clampTimeout(options.timeoutMs);
    this.maxRetries = clampRetries(options.maxRetries);
    this.fetchImpl = options.fetchImpl?.bind(globalThis) ?? createKeepAliveFetch(this.baseUrl, this.timeoutMs);
    this.authHeader = buildAuthHeader(options.authToken);
  }

  async put(
    key: string,
    data: ArrayBuffer | Uint8Array,
    contentType: string,
    options?: ObjectStorePutOptions,
  ): Promise<{ url: string }> {
    const buffer = data instanceof Uint8Array ? data : new Uint8Array(data);
    const start = performance.now();
    await this.request<void>({
      method: 'PUT',
      key,
      body: buffer,
      headers: {
        'content-type': contentType,
        'content-length': String(buffer.byteLength),
        ...(options?.ttlSeconds !== undefined
          ? { 'x-ttl-seconds': String(Math.max(0, Math.floor(options.ttlSeconds))) }
          : {}),
        ...(options?.metadata
          ? Object.fromEntries(
              Object.entries(options.metadata).map(([headerKey, value]) => [
                `x-meta-${headerKey.toLowerCase()}`,
                value,
              ]),
            )
          : {}),
      },
      operation: 'ObjectStore.put',
      expectBinary: false,
    });
    const duration = performance.now() - start;
    objectPutDurationHistogram.record(Number(duration.toFixed(2)), {
      operation: 'ObjectStore.put',
    });
    return { url: this.resourceUrl(key) };
  }

  async get(key: string): Promise<Uint8Array> {
    const data = await this.request<ArrayBuffer>({
      method: 'GET',
      key,
      operation: 'ObjectStore.get',
      expectBinary: true,
    });
    return new Uint8Array(data);
  }

  private resourceUrl(key: string): string {
    const normalized = normalizeKey(key);
    return new URL(normalized, this.baseUrl).toString();
  }

  private async request<T>({
    method,
    key,
    body,
    headers,
    operation,
    expectBinary,
  }: {
    method: 'GET' | 'PUT';
    key: string;
    body?: Uint8Array;
    headers?: Record<string, string>;
    operation: string;
    expectBinary: boolean;
  }): Promise<T> {
    const url = this.resourceUrl(key);
    let attempt = 0;
    let lastError: unknown;

    while (attempt <= this.maxRetries) {
      attempt += 1;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      const start = performance.now();
      const span = startSpan('object_store.request', {
        attributes: {
          'object_store.operation': operation,
          'object_store.url': url,
          'http.method': method,
        },
      });
      try {
        const requestHeaders: Record<string, string> = {
          accept: expectBinary ? 'application/octet-stream' : 'application/json',
        };
        if (this.authHeader) {
          requestHeaders.authorization = this.authHeader;
        }
        if (headers) {
          Object.assign(requestHeaders, headers);
        }
        const correlationId = getCorrelationId();
        if (correlationId) {
          requestHeaders['x-correlation-id'] = correlationId;
        }

        const requestBody = body ? Buffer.from(body) : undefined;
        const response = await this.fetchImpl(url, {
          method,
          headers: requestHeaders,
          body: requestBody,
          signal: controller.signal,
        });

        clearTimeout(timer);
        const durationMs = performance.now() - start;
        this.recordMetrics(durationMs, method, key, response.status, attempt);
        span.setAttribute('http.status_code', response.status);

        if (!response.ok) {
          const retryable = isRetryableStatus(response.status);
          if (span.isRecording()) {
            span.setStatus({ code: SpanStatusCode.ERROR, message: String(response.status) });
            span.recordException(new Error(`ObjectStore request failed with status ${response.status}`));
          }
          if (retryable && attempt <= this.maxRetries) {
            await this.waitBeforeRetry(attempt);
            continue;
          }
          const error = new ObjectStoreRequestError(
            `ObjectStore request failed with status ${response.status}`,
            response.status,
            operation,
            retryable,
          );
          errorCounter.add(1, this.metricAttributes(method, key, response.status, attempt));
          throw error;
        }

        if (span.isRecording()) {
          span.setStatus({ code: SpanStatusCode.OK });
        }

        if (expectBinary) {
          const buffer = await response.arrayBuffer();
          return buffer as unknown as T;
        }
        return undefined as unknown as T;
      } catch (err) {
        clearTimeout(timer);
        const durationMs = performance.now() - start;
        let retryable = false;
        let errorToThrow: ObjectStoreRequestError | Error;

        if (isObjectStoreRequestError(err)) {
          retryable = err.retryable === true;
          errorToThrow = err;
        } else if ((err as { name?: string }).name === 'AbortError') {
          retryable = true;
          errorToThrow = new ObjectStoreRequestError('ObjectStore request aborted', undefined, operation, true, err);
        } else if (err instanceof TypeError) {
          retryable = true;
          errorToThrow = new ObjectStoreRequestError(err.message, undefined, operation, true, err);
        } else if (err instanceof Error) {
          errorToThrow = err;
        } else {
          errorToThrow = new Error(String(err));
        }

        if (!isObjectStoreRequestError(err)) {
          this.recordMetrics(durationMs, method, key, 0, attempt);
          errorCounter.add(1, this.metricAttributes(method, key, 0, attempt));
        }

        if (span.isRecording()) {
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: errorToThrow instanceof Error ? errorToThrow.message : String(errorToThrow),
          });
          span.recordException(errorToThrow);
        }

        if (retryable && attempt <= this.maxRetries) {
          lastError = errorToThrow;
          await this.waitBeforeRetry(attempt);
          continue;
        }

        lastError = errorToThrow;
        throw errorToThrow;
      } finally {
        span.end();
      }
    }

    throw lastError ?? new ObjectStoreRequestError('ObjectStore request failed', undefined, operation);
  }

  private async waitBeforeRetry(attempt: number): Promise<void> {
    const backoff = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
    const jitter = Math.random() * RETRY_JITTER_MS;
    await delay(backoff + jitter);
  }

  private recordMetrics(durationMs: number, method: string, key: string, status: number, attempt: number): void {
    const attrs = this.metricAttributes(method, key, status, attempt);
    latencyHistogram.record(Number(durationMs.toFixed(2)), attrs);
    totalCounter.add(1, attrs);
  }

  private metricAttributes(method: string, key: string, status: number, attempt: number): Record<string, unknown> {
    return {
      method,
      key,
      status,
      attempt,
    };
  }
}
