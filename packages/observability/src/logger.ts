type Level = 'debug' | 'info' | 'warn' | 'error';
import { getCorrelationId } from './otel';

function now() { return new Date().toISOString(); }

function redact(obj: unknown): unknown {
  // Minimal redaction: do not include large payloads or unknown objects; extend as needed
  if (obj && typeof obj === 'object') return '[object redacted]';
  return obj;
}

export function log(level: Level, msg: string, fields?: Record<string, unknown>) {
  const entry: Record<string, unknown> = { ts: now(), level, msg };
  if (fields) {
    for (const [k, v] of Object.entries(fields)) entry[k] = redact(v);
  }
  const cid = getCorrelationId();
  if (cid && !('correlationId' in (fields || {}))) entry.correlationId = cid;
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(entry));
}

export const logger = {
  debug: (msg: string, f?: Record<string, unknown>) => log('debug', msg, f),
  info: (msg: string, f?: Record<string, unknown>) => log('info', msg, f),
  warn: (msg: string, f?: Record<string, unknown>) => log('warn', msg, f),
  error: (msg: string, f?: Record<string, unknown>) => log('error', msg, f),
};
