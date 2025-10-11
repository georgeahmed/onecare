import { getCorrelationId } from './otel';

type Level = 'debug' | 'info' | 'warn' | 'error';

const REDACTED_TEXT = '[REDACTED]';
const EMAIL_RE =
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE_RE =
  /\b(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4})\b/g;
const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/g;
const KEY_VALUE_SECRET_RE =
  /\b(token|secret|password|key|authorization|bearer)\b\s*([:=])\s*([^\s,;]+)/gi;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const SAFE_ID_KEYS = new Set(['correlationid', 'traceid', 'spanid', 'requestid']);

function shouldRedactKey(key: string): boolean {
  const lower = key.toLowerCase();
  if (SAFE_ID_KEYS.has(lower)) return false;
  if (lower.endsWith('id')) return true;
  return /(token|secret|password|credential|ssn|phone|email|authorization|bearer)/i.test(lower);
}

function redactString(value: string): string {
  let result = value;
  result = result.replace(EMAIL_RE, REDACTED_TEXT);
  result = result.replace(PHONE_RE, REDACTED_TEXT);
  result = result.replace(SSN_RE, REDACTED_TEXT);
  result = result.replace(KEY_VALUE_SECRET_RE, (_match, key, separator) => `${key}${separator}${REDACTED_TEXT}`);
  result = result.replace(BEARER_RE, (match) => {
    const [prefix] = match.split(/\s+/, 1);
    return `${prefix} ${REDACTED_TEXT}`;
  });
  return result;
}

function redactUnknown(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message),
    };
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactUnknown(item, seen));
  }
  if (typeof value === 'object') {
    if (seen.has(value as object)) return REDACTED_TEXT;
    seen.add(value as object);
    const result: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      if (shouldRedactKey(key)) {
        result[key] = REDACTED_TEXT;
      } else {
        result[key] = redactUnknown(inner, seen);
      }
    }
    return result;
  }
  return value;
}

export function redact<T>(value: T): T {
  return redactUnknown(value, new WeakSet()) as T;
}

function now() { return new Date().toISOString(); }

function scrub(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const type = typeof value;
  if (type === 'string' || type === 'number' || type === 'boolean') return value;
  if (value instanceof Error) {
    return { message: value.message, name: value.name };
  }
  return '[object redacted]';
}

export function log(level: Level, msg: string, fields?: Record<string, unknown>) {
  const sanitizedMsg = redact(msg);
  const entry: Record<string, unknown> = { ts: now(), level, msg: sanitizedMsg };
  if (fields) {
    for (const [k, v] of Object.entries(fields)) {
      if (shouldRedactKey(k)) {
        entry[k] = REDACTED_TEXT;
        continue;
      }
      const sanitized = redact(v);
      const cleaned = scrub(sanitized);
      if (cleaned !== undefined) entry[k] = cleaned;
    }
  }
  const fieldsCorrelation = entry.correlationId ?? (fields?.correlationId as string | undefined);
  if (fieldsCorrelation) {
    entry.correlationId = String(fieldsCorrelation);
  } else {
    const cid = getCorrelationId();
    if (cid) entry.correlationId = cid;
  }
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(entry));
}

export const logger = {
  debug: (msg: string, f?: Record<string, unknown>) => log('debug', msg, f),
  info: (msg: string, f?: Record<string, unknown>) => log('info', msg, f),
  warn: (msg: string, f?: Record<string, unknown>) => log('warn', msg, f),
  error: (msg: string, f?: Record<string, unknown>) => log('error', msg, f),
};
