import { createCorrelationId, getSessionCorrelationId, recordRumEvent, safeLog } from './telemetry';

export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  jitter?: boolean;
}

export interface RequestOptions {
  baseUrl: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  headers?: Record<string, string>;
  retry?: RetryOptions;
  onRetry?: (state: { attempt: number; maxRetries: number; correlationId: string }) => void;
  correlationId?: string;
  requestId?: string;
  credentials?: RequestCredentials;
}

export interface GetOptions extends RequestOptions {
  cacheKey?: string;
  cacheTtlMs?: number;
}

export interface PostOptions extends RequestOptions {
  body?: unknown;
}

export class HttpError extends Error {
  status: number;
  response: Response;
  body?: unknown;
  correlationId?: string;
  requestId?: string;
  retryAfterSeconds?: number;

  constructor(message: string, response: Response, body?: unknown) {
    super(message);
    this.name = 'HttpError';
    this.status = response.status;
    this.response = response;
    this.body = body;
  }
}

type CacheEntry = {
  expiresAt: number;
  value: unknown;
};

const DEFAULT_RETRY: Required<RetryOptions> = {
  maxRetries: 0,
  baseDelayMs: 250,
  jitter: true
};

const cacheStore = new Map<string, CacheEntry>();

const wait = (ms: number): Promise<void> => new Promise((resolve) => {
  if (ms <= 0) {
    resolve();
    return;
  }
  setTimeout(resolve, ms);
});

const shouldRetryResponse = (response: Response): boolean => {
  return response.status === 429 || response.status === 503 || response.status >= 500;
};

const computeDelay = (attempt: number, retry: Required<RetryOptions>): number => {
  const exponential = retry.baseDelayMs * 2 ** attempt;
  if (!retry.jitter) {
    return exponential;
  }
  const randomFactor = 0.5 + Math.random();
  return exponential * randomFactor;
};

const toAbsoluteUrl = (baseUrl: string, path: string): string => {
  if (/^https?:\/\//.test(path)) {
    return path;
  }
  const normalized = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return new URL(path.replace(/^\/+/, ''), normalized).toString();
};

const parseRetryAfterSeconds = (headerValue: string | null): number | undefined => {
  if (!headerValue) return undefined;
  const parsedNumeric = Number.parseInt(headerValue, 10);
  if (!Number.isNaN(parsedNumeric)) {
    return parsedNumeric > 0 ? parsedNumeric : undefined;
  }
  const parsedDate = Date.parse(headerValue);
  if (Number.isNaN(parsedDate)) return undefined;
  const deltaMs = parsedDate - Date.now();
  return deltaMs > 0 ? Math.ceil(deltaMs / 1_000) : undefined;
};

const sanitizeHeaders = (headers: Record<string, string | undefined>): Record<string, string> => {
  const reduced = new Map<string, { key: string; value: string }>();
  for (const [rawKey, rawValue] of Object.entries(headers)) {
    if (typeof rawValue !== 'string') {
      continue;
    }
    const trimmed = rawValue.trim();
    if (!trimmed) {
      continue;
    }
    const canonical = rawKey.toLowerCase();
    reduced.set(canonical, { key: rawKey, value: trimmed });
  }
  const result: Record<string, string> = {};
  for (const { key, value } of reduced.values()) {
    result[key] = value;
  }
  return result;
};

const executeRequest = async (
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  options: RequestOptions & { body?: unknown }
): Promise<Response> => {
  const {
    baseUrl,
    signal: externalSignal,
    timeoutMs,
    retry,
    onRetry,
    headers = {},
    correlationId,
    requestId,
    credentials = 'include',
    body
  } = options;

  const sessionCorrelationId = getSessionCorrelationId();
  const resolvedRequestId = requestId ?? createCorrelationId();
  const resolvedCorrelationId = correlationId ?? createCorrelationId();

  const retryConfig: Required<RetryOptions> = {
    ...DEFAULT_RETRY,
    ...(retry ?? {})
  };

  let attempt = 0;
  let lastError: unknown;

  while (attempt <= retryConfig.maxRetries) {
    const controller = new AbortController();
    let abortedByTimeout = false;
    const timeoutHandle =
      typeof timeoutMs === 'number' && timeoutMs > 0
        ? setTimeout(() => {
            abortedByTimeout = true;
            controller.abort();
          }, timeoutMs)
        : null;
    const abortHandler = () => controller.abort();

    if (externalSignal) {
      if (externalSignal.aborted) {
        controller.abort();
      } else {
        externalSignal.addEventListener('abort', abortHandler, { once: true });
      }
    }

    try {
      const isFormDataBody = typeof FormData !== 'undefined' && body instanceof FormData;
      const isUrlEncodedBody = typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams;
      const isJsonBody = body && typeof body === 'object' && !isFormDataBody && !isUrlEncodedBody;

      const finalHeaders = sanitizeHeaders({
        'content-type': isJsonBody ? 'application/json' : undefined,
        'x-session-correlation-id': sessionCorrelationId,
        'x-correlation-id': resolvedCorrelationId,
        'x-request-id': resolvedRequestId,
        ...headers
      });

      const response = await fetch(toAbsoluteUrl(baseUrl, path), {
        method,
        credentials,
        headers: finalHeaders,
        signal: controller.signal,
        body: isFormDataBody
          ? (body as FormData)
          : isUrlEncodedBody
            ? (body as URLSearchParams)
            : isJsonBody
              ? JSON.stringify(body)
              : typeof body === 'string'
                ? body
                : undefined
      });

      if (response.ok) {
        recordRumEvent('network.request', {
          method,
          path,
          status: response.status,
          correlationId: resolvedCorrelationId,
          requestId: resolvedRequestId
        });
        return response;
      }

      const shouldRetry = shouldRetryResponse(response);
      if (attempt < retryConfig.maxRetries && shouldRetry) {
        onRetry?.({ attempt: attempt + 1, maxRetries: retryConfig.maxRetries, correlationId: resolvedCorrelationId });
        await wait(computeDelay(attempt, retryConfig));
        attempt += 1;
        continue;
      }

      let parsedBody: unknown;
      try {
        const clone = response.clone();
        parsedBody = await clone.json();
      } catch {
        parsedBody = undefined;
      }

      const errorMessage =
        typeof parsedBody === 'object' && parsedBody && 'message' in (parsedBody as Record<string, unknown>)
          ? String((parsedBody as Record<string, unknown>).message)
          : `Request failed with status ${response.status}`;

      const error = new HttpError(errorMessage, response, parsedBody);
      error.correlationId = response.headers.get('x-correlation-id') ?? resolvedCorrelationId;
      error.requestId = resolvedRequestId;
      error.retryAfterSeconds = parseRetryAfterSeconds(response.headers.get('retry-after'));
      throw error;
    } catch (error) {
      lastError = error;
      const isAbortError = (error as { name?: string }).name === 'AbortError';
      if (isAbortError && abortedByTimeout) {
        const timeoutError = new HttpError('Request timed out', new Response(null, { status: 408 }));
        timeoutError.correlationId = resolvedCorrelationId;
        timeoutError.requestId = resolvedRequestId;
        throw timeoutError;
      }

      if (attempt < retryConfig.maxRetries) {
        onRetry?.({ attempt: attempt + 1, maxRetries: retryConfig.maxRetries, correlationId: resolvedCorrelationId });
        await wait(computeDelay(attempt, retryConfig));
        attempt += 1;
        continue;
      }

      const message = error instanceof Error ? error.message : String(error ?? 'unknown');
      recordRumEvent('network.request.failure', {
        method,
        path,
        attemptCount: attempt + 1,
        correlationId: resolvedCorrelationId,
        requestId: resolvedRequestId,
        error: message
      });
      safeLog('dataClient.request.failed', { method, path, error: message });
      throw error;
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      if (externalSignal) {
        externalSignal.removeEventListener('abort', abortHandler);
      }
    }
  }

  throw lastError ?? new Error('Request failed');
};

export const getJson = async <T = unknown>(path: string, options: GetOptions): Promise<T> => {
  const cacheKey = options.cacheKey ?? `${options.baseUrl}__${path}`;
  const cacheTtlMs = options.cacheTtlMs ?? 0;
  const now = Date.now();

  if (cacheTtlMs > 0) {
    const cached = cacheStore.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return cached.value as T;
    }
  }

  const response = await executeRequest('GET', path, options);
  const status = response.status;
  const noContentStatus = status === 204 || status === 205 || status === 304;
  const contentLengthHeader = response.headers.get('content-length');
  const declaredLength = contentLengthHeader !== null ? Number.parseInt(contentLengthHeader, 10) : undefined;
  const hasDeclaredLength = declaredLength !== undefined && !Number.isNaN(declaredLength);
  const hasBody = !noContentStatus && (!hasDeclaredLength || declaredLength > 0);

  if (!hasBody) {
    return undefined as T;
  }

  let data: T;
  try {
    data = (await response.json()) as T;
  } catch {
    data = undefined as unknown as T;
  }

  if (cacheTtlMs > 0) {
    cacheStore.set(cacheKey, { value: data, expiresAt: now + cacheTtlMs });
  }

  return data;
};

export const postJson = async <TResponse = unknown>(
  path: string,
  options: PostOptions
): Promise<{ data: TResponse; response: Response }> => {
  const response = await executeRequest('POST', path, options);
  let data: TResponse;
  try {
    data = (await response.json()) as TResponse;
  } catch {
    data = undefined as unknown as TResponse;
  }
  return { data, response };
};

export const clearDataClientCache = (): void => {
  cacheStore.clear();
};
