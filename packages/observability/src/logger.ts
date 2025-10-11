type Level = 'debug' | 'info' | 'warn' | 'error';
import { getCorrelationId } from './otel';

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
  const entry: Record<string, unknown> = { ts: now(), level, msg };
  if (fields) {
    for (const [k, v] of Object.entries(fields)) {
      const cleaned = scrub(v);
      if (cleaned !== undefined) entry[k] = cleaned;
    }
  }
  const fieldsCorrelation = fields?.correlationId;
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
