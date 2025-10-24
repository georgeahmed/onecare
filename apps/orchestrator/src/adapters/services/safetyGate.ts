import * as http from 'node:http';
import * as https from 'node:https';
import { promises as dns } from 'node:dns';
import { readFileSync } from 'node:fs';
import { PortalSubmission, SafetyDecision } from '@onecare/events';
import { logger } from '@onecare/observability';
import { context, trace } from '@opentelemetry/api';
import type { AuthContext } from '@onecare/security';

type SafetyGateErrorCode =
  | 'invalid_input'
  | 'forbidden'
  | 'unauthorized'
  | 'temporarily_unavailable'
  | 'upstream_timeout'
  | 'invalid_response';

type SafetyGateClient = (
  url: string,
  body: unknown,
  headers?: Record<string, string>,
  signal?: AbortSignal
) => Promise<SafetyDecision>;

export class SafetyGateHttpError extends Error {
  public readonly statusCode?: number;
  public readonly retryAfterMs?: number;
  public readonly code: SafetyGateErrorCode;

  constructor(code: SafetyGateErrorCode, message: string, statusCode?: number, retryAfterMs?: number) {
    super(message);
    this.name = 'SafetyGateHttpError';
    this.code = code;
    this.statusCode = statusCode;
    this.retryAfterMs = retryAfterMs;
  }
}

const DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = resolveMaxResponseBytes();
const DEFAULT_HEADERS: Readonly<Record<string, string>> = {
  accept: 'application/json',
  'user-agent': 'onecare-orchestrator',
};
const SAFETY_GATE_SCOPE = 'safety:analyze';

function isIpV4Private(ip: string): boolean {
  const m = ip.split('.').map((s) => Number(s));
  if (m.length !== 4 || m.some((x) => Number.isNaN(x))) return false;
  if (m[0] === 10) return true;
  if (m[0] === 172 && m[1] >= 16 && m[1] <= 31) return true;
  if (m[0] === 192 && m[1] === 168) return true;
  if (m[0] === 127) return true;
  return false;
}

function isIpV6LoopbackOrPrivate(host: string): boolean {
  const h = host.toLowerCase();
  if (h === '::1') return true;
  return h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80:');
}

async function enforceAllowlist(url: URL): Promise<void> {
  const hostname = url.hostname;
  if (!/^https?:$/.test(url.protocol)) throw new Error('blocked_protocol');
  const allowEntries = (process.env.PY_SAFETY_GATE_HOST_ALLOWLIST || '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
  const allowlist = new Set(allowEntries);
  const hostKey = hostname.toLowerCase();
  const allowlisted = allowlist.has(hostKey);

  if (allowlist.size > 0 && !allowlisted) {
    throw new Error('blocked_not_allowlisted');
  }

  if (allowlisted) {
    return;
  }

  if (hostKey === 'localhost' || hostKey.endsWith('.local')) throw new Error('blocked_host');
  const isV4 = /^\d+\.\d+\.\d+\.\d+$/.test(hostname);
  const isV6 = /^[0-9a-fA-F:]+$/.test(hostname);
  if (isV4 && isIpV4Private(hostname)) throw new Error('blocked_private_ip');
  if (isV6 && isIpV6LoopbackOrPrivate(hostname)) throw new Error('blocked_private_ip');

  if (!isV4 && !isV6) {
    let records;
    try {
      records = await dns.lookup(hostname, { all: true });
    } catch (err) {
      throw new Error('blocked_host_resolution');
    }
    for (const entry of records) {
      const address = entry.address ?? '';
      if (isIpV4Private(address) || isIpV6LoopbackOrPrivate(address)) {
        throw new Error('blocked_private_ip');
      }
    }
  }
}

function postJson<T>(
  urlStr: string,
  body: unknown,
  headers?: Record<string, string>,
  signal?: AbortSignal
): Promise<T> {
  return new Promise((resolve, reject) => {
    try {
      const url = new URL(urlStr);
      const isHttps = url.protocol === 'https:';
      const payload = Buffer.from(JSON.stringify(body));
      const finalHeaders = {
        ...DEFAULT_HEADERS,
        'content-type': 'application/json',
        ...(headers ?? {}),
      };
      const options: http.RequestOptions = {
        method: 'POST',
        hostname: url.hostname,
        path: url.pathname + (url.search || ''),
        port: url.port || (isHttps ? 443 : 80),
        headers: {
          ...finalHeaders,
          'content-length': payload.length,
        },
      };
      const request = (isHttps ? https : http).request(options, (res) => {
        let settled = false;
        let receivedBytes = 0;
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => {
          if (settled) return;
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          receivedBytes += buffer.length;
          if (receivedBytes > MAX_RESPONSE_BYTES) {
            settled = true;
            request.destroy();
            reject(
              new SafetyGateHttpError(
                'invalid_response',
                `Safety gate response exceeded ${MAX_RESPONSE_BYTES} bytes`,
                res.statusCode ?? 502
              )
            );
            return;
          }
          chunks.push(buffer);
        });
        res.on('end', () => {
          if (settled) return;
          settled = true;
          const text = Buffer.concat(chunks).toString('utf8');
          const statusCode = res.statusCode ?? 500;
          if (statusCode >= 400) {
            reject(mapStatusToError(statusCode, text, res.headers));
            return;
          }
          try {
            resolve(parseJsonOrThrow<T>(text));
          } catch (error) {
            reject(
              Object.assign(
                new SafetyGateHttpError('invalid_response', 'Safety gate returned invalid JSON', statusCode),
                { raw: text, cause: error }
              )
            );
          }
        });
      });
      request.on('error', (err) => {
        reject(normalizeNetworkError(err));
      });
      if (signal) {
        const abort = () => {
          request.destroy(new SafetyGateHttpError('upstream_timeout', 'safety gate call aborted by signal'));
        };
        if (signal.aborted) {
          abort();
          return;
        }
        signal.addEventListener('abort', abort, { once: true });
        request.on('close', () => signal.removeEventListener('abort', abort));
      }
      request.write(payload);
      request.end();
    } catch (err) {
      reject(err);
    }
  });
}

function normalizeNetworkError(error: unknown): Error {
  if (error instanceof SafetyGateHttpError) {
    return error;
  }
  if (!error || typeof error !== 'object') {
    return new SafetyGateHttpError('temporarily_unavailable', 'Safety gate request failed');
  }
  const code = (error as { code?: string }).code;
  if (typeof code === 'string') {
    const lowered = code.toLowerCase();
    if (lowered === 'etimedout') {
      return new SafetyGateHttpError('upstream_timeout', 'Safety gate request timed out');
    }
    if (lowered === 'econnreset' || lowered === 'econreset' || lowered === 'econnaborted') {
      return new SafetyGateHttpError('temporarily_unavailable', 'Safety gate connection reset');
    }
    if (
      lowered === 'econnrefused' ||
      lowered === 'ehostunreach' ||
      lowered === 'enotfound' ||
      lowered === 'eai_again'
    ) {
      return new SafetyGateHttpError('temporarily_unavailable', 'Safety gate unavailable');
    }
  }
  return error as Error;
}

function mapStatusToError(
  statusCode: number,
  body: string,
  headers: http.IncomingHttpHeaders
): SafetyGateHttpError {
  const retryAfterMs = parseRetryAfter(headers['retry-after']);
  if (statusCode === 401) {
    return new SafetyGateHttpError('unauthorized', 'Safety gate authentication failed', statusCode);
  }
  if (statusCode === 403) {
    return new SafetyGateHttpError('forbidden', 'Safety gate rejected the request', statusCode);
  }
  if (statusCode === 408) {
    return new SafetyGateHttpError('upstream_timeout', 'Safety gate timed out', statusCode, retryAfterMs);
  }
  if (statusCode === 429) {
    return new SafetyGateHttpError('temporarily_unavailable', 'Safety gate rate limited the request', statusCode, retryAfterMs);
  }
  if (statusCode >= 500) {
    return new SafetyGateHttpError('temporarily_unavailable', 'Safety gate unavailable', statusCode, retryAfterMs);
  }
  if (statusCode >= 400) {
    return new SafetyGateHttpError('invalid_input', 'Safety gate reported validation failure', statusCode);
  }
  return new SafetyGateHttpError('invalid_response', `Safety gate returned unexpected status ${statusCode}`, statusCode);
}

function parseRetryAfter(value: string | string[] | undefined): number | undefined {
  if (!value) return undefined;
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds > 0) {
    return Math.round(seconds * 1_000);
  }
  const target = Date.parse(raw);
  if (Number.isNaN(target)) return undefined;
  const delta = target - Date.now();
  return delta > 0 ? delta : undefined;
}

function resolveMaxResponseBytes(): number {
  const raw = process.env.PY_SAFETY_GATE_MAX_RESPONSE_BYTES;
  if (!raw) return DEFAULT_MAX_RESPONSE_BYTES;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_RESPONSE_BYTES;
  return Math.min(Math.floor(parsed), 2 * 1024 * 1024);
}

function readSecretEnv(value: string | undefined, fileEnv: string | undefined, logKey: string): string | undefined {
  const inline = value?.trim();
  const filePath = fileEnv?.trim();
  if (!filePath) {
    return inline && inline.length > 0 ? inline : undefined;
  }
  try {
    const contents = readFileSync(filePath, 'utf8').trim();
    if (contents.length === 0) {
      logger.warn('safety gate auth file empty', { key: logKey, path: filePath });
      return inline && inline.length > 0 ? inline : undefined;
    }
    return contents;
  } catch (error) {
    logger.warn('safety gate auth file read failed', {
      key: logKey,
      path: filePath,
      reason: error instanceof Error ? error.message : String(error),
    });
    return inline && inline.length > 0 ? inline : undefined;
  }
}

function resolveSafetyGateAuthHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  const headerName = process.env.PY_SAFETY_GATE_AUTH_HEADER_NAME?.trim();
  const headerValue = readSecretEnv(
    process.env.PY_SAFETY_GATE_AUTH_HEADER_VALUE,
    process.env.PY_SAFETY_GATE_AUTH_HEADER_VALUE_FILE,
    'auth_header_value',
  );
  let skipAuthorization = false;
  if (headerName && headerValue) {
    headers[headerName] = headerValue;
    skipAuthorization = true;
  }

  const apiKey =
    readSecretEnv(
      process.env.PY_SAFETY_GATE_API_KEY,
      process.env.PY_SAFETY_GATE_API_KEY_FILE,
      'api_key',
    ) ??
    readSecretEnv(
      process.env.PY_SAFETY_GATE_BEARER_TOKEN,
      process.env.PY_SAFETY_GATE_BEARER_TOKEN_FILE,
      'bearer_token',
    ) ??
    readSecretEnv(process.env.PY_SAFETY_GATE_TOKEN, process.env.PY_SAFETY_GATE_TOKEN_FILE, 'token');
  if (apiKey && !skipAuthorization && !hasAuthorizationHeader(headers)) {
    headers.Authorization = apiKey.startsWith('Bearer ') ? apiKey : `Bearer ${apiKey}`;
  }

  const extra = process.env.PY_SAFETY_GATE_EXTRA_HEADERS;
  if (extra) {
    try {
      const parsed = JSON.parse(extra) as Record<string, string>;
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof key === 'string' && typeof value === 'string' && key.trim() && value.trim()) {
          headers[key] = value;
        }
      }
    } catch {
      // ignore malformed extras to avoid exposing secrets in logs
    }
  }

  return headers;
}

function hasAuthorizationHeader(headers: Record<string, string>): boolean {
  return Object.keys(headers).some((key) => key.toLowerCase() === 'authorization');
}

function buildSafetyGateHeaders(options: AnalyzePortalSubmissionOptions): Record<string, string> {
  const headers: Record<string, string> = { ...resolveSafetyGateAuthHeaders() };
  const correlationId = options.correlationId;
  if (correlationId && correlationId.trim().length > 0 && !headers['x-correlation-id']) {
    headers['x-correlation-id'] = correlationId.trim();
  }
  const traceParent = currentTraceParent();
  if (traceParent && !headers.traceparent) {
    headers.traceparent = traceParent;
  }
  const requestId = options.requestId;
  if (requestId && requestId.trim().length > 0 && !headers['x-request-id']) {
    headers['x-request-id'] = requestId.trim();
  }
  const scopes = new Set<string>([SAFETY_GATE_SCOPE]);
  if (Array.isArray(options.scope)) {
    for (const entry of options.scope) {
      if (typeof entry === 'string' && entry.trim().length > 0) {
        scopes.add(entry.trim());
      }
    }
  }
  headers['x-auth-scope'] = Array.from(scopes).join(' ');
  const consentRef = typeof options.consentReference === 'string' ? options.consentReference.trim() : undefined;
  if (consentRef) {
    headers['x-consent-reference'] = consentRef;
  }
  if (options.actor?.id) {
    headers['x-actor-id'] = options.actor.id;
  }
  if (options.actor?.type) {
    headers['x-actor-type'] = options.actor.type;
  }
  return headers;
}

export const __safetyGateTesting = {
  buildSafetyGateHeaders,
  resolveSafetyGateAuthHeaders,
  mapStatusToError,
  parseRetryAfter,
  MAX_RESPONSE_BYTES,
  refreshAuthHeaders: () => undefined,
};

export function parseJsonOrThrow<T>(text: string): T {
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    const error = new Error('invalid_json') as Error & {
      code?: string;
      cause?: unknown;
      raw?: string;
    };
    error.name = 'SafetyGateParseError';
    error.code = 'invalid_json';
    error.cause = err;
    error.raw = text;
    throw error;
  }
}

export interface AnalyzePortalSubmissionOptions {
  correlationId?: string;
  signal?: AbortSignal;
  requestId?: string;
  consentReference?: string | null;
  actor?: AuthContext['actor'];
  scope?: readonly string[];
  client?: SafetyGateClient;
  [key: string]: unknown;
}

export async function analyzePortalSubmission(
  submission: PortalSubmission,
  endpoint?: string,
  options: AnalyzePortalSubmissionOptions = {}
): Promise<SafetyDecision> {
  const normalizedOptions =
    typeof options === 'string'
      ? ({ correlationId: options } satisfies AnalyzePortalSubmissionOptions)
      : options;
  const correlationId = normalizedOptions.correlationId;
  const candidateEndpoint = endpoint ?? process.env.PY_SAFETY_GATE_URL;
  const trimmedEndpoint = candidateEndpoint?.trim();
  if (!trimmedEndpoint) {
    throw new Error('safety_gate_endpoint_missing');
  }
  const normalizedEndpoint = trimmedEndpoint.replace(/\/$/, '');
  const url = `${normalizedEndpoint}/analyze`;
  try {
    await enforceAllowlist(new URL(url));
  } catch (error) {
    logger.warn('safety gate endpoint blocked by SSRF guard', {
      reason: (error as Error).message,
      endpoint: trimmedEndpoint,
      correlationId,
    });
    throw error;
  }

  const headerOptions: AnalyzePortalSubmissionOptions = {
    ...normalizedOptions,
    correlationId,
  };
  const headers = buildSafetyGateHeaders(headerOptions);
  const client: SafetyGateClient =
    normalizedOptions.client ?? ((u, b, h, s) => postJson<SafetyDecision>(u, b, h, s));
  try {
    return await client(url, submission, headers, normalizedOptions.signal);
  } catch (error) {
    logger.warn('safety gate call failed', {
      err: (error as Error)?.message,
      correlationId,
      code: (error as { code?: string }).code,
    });
    throw error;
  }
}

function currentTraceParent(): string | undefined {
  const span = trace.getSpan(context.active());
  if (!span) return undefined;
  const spanContext = span.spanContext();
  if (!spanContext || !spanContext.traceId || !spanContext.spanId) return undefined;
  const traceId = spanContext.traceId;
  const spanId = spanContext.spanId;
  const flags = spanContext.traceFlags?.toString(16).padStart(2, '0') ?? '01';
  return `00-${traceId}-${spanId}-${flags}`;
}
