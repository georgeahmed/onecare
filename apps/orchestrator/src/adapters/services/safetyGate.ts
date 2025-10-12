import * as http from 'node:http';
import * as https from 'node:https';
import { PortalSubmission, SafetyDecision } from '@onecare/events';
import { logger } from '@onecare/observability';
import { context, trace } from '@opentelemetry/api';

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

function enforceAllowlist(url: URL) {
  const hostname = url.hostname;
  if (!/^https?:$/.test(url.protocol)) throw new Error('blocked_protocol');
  if (hostname === 'localhost' || hostname.endsWith('.local')) throw new Error('blocked_host');
  const isV4 = /^\d+\.\d+\.\d+\.\d+$/.test(hostname);
  const isV6 = /^[0-9a-fA-F:]+$/.test(hostname);
  if (isV4 && isIpV4Private(hostname)) throw new Error('blocked_private_ip');
  if (isV6 && isIpV6LoopbackOrPrivate(hostname)) throw new Error('blocked_private_ip');
  const allow = (process.env.PY_SAFETY_GATE_HOST_ALLOWLIST || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (allow.length > 0 && !allow.includes(hostname)) throw new Error('blocked_not_allowlisted');
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
      const options: http.RequestOptions = {
        method: 'POST',
        hostname: url.hostname,
        path: url.pathname + (url.search || ''),
        port: url.port || (isHttps ? 443 : 80),
        headers: {
          'content-type': 'application/json',
          'content-length': payload.length,
          ...(headers || {}),
        },
      };
      const req = (isHttps ? https : http).request(options, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if ((res.statusCode || 500) >= 400) {
            return reject(new Error(`HTTP ${res.statusCode}: ${text}`));
          }
          try {
            resolve(parseJsonOrThrow<T>(text));
          } catch (e) {
            const error = Object.assign(
              new Error('invalid_json'),
              {
                code: 'invalid_json',
                statusCode: res.statusCode,
                raw: text,
                cause: e,
              },
            );
            reject(error);
          }
        });
      });
      if (signal) {
        const abort = () => {
          req.destroy(new Error('aborted'));
        };
        if (signal.aborted) {
          abort();
          return;
        }
        signal.addEventListener('abort', abort, { once: true });
        req.on('close', () => signal.removeEventListener('abort', abort));
      }
      req.on('error', reject);
      req.write(payload);
      req.end();
    } catch (err) {
      reject(err);
    }
  });
}

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

export async function analyzePortalSubmission(
  submission: PortalSubmission,
  endpoint = process.env.PY_SAFETY_GATE_URL || 'http://localhost:8081',
  options?: { correlationId?: string; signal?: AbortSignal }
): Promise<SafetyDecision> {
  const correlationId = options?.correlationId;
  const url = `${endpoint.replace(/\/$/, '')}/analyze`;
  // SSRF allowlist/guards
  try {
    enforceAllowlist(new URL(url));
  } catch (e) {
    logger.warn('safety gate endpoint blocked by SSRF guard', { reason: (e as Error).message, endpoint, correlationId });
    throw e;
  }
  // Propagate correlationId outbound if provided
  const headers: Record<string, string> = {};
  if (correlationId) headers['x-correlation-id'] = correlationId;
  const traceParent = currentTraceParent();
  if (traceParent) headers['traceparent'] = traceParent;
  try {
    return await postJson<SafetyDecision>(url, submission, headers, options?.signal);
  } catch (err) {
    logger.warn('safety gate call failed', { err: (err as Error)?.message, correlationId });
    throw err;
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
