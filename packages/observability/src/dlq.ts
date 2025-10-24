import { createHash } from 'node:crypto';

export interface DlqPayloadSummary {
  redacted: true;
  fields: Record<string, string>;
  digest: string;
}

export function summariseForDlq(payload: unknown): DlqPayloadSummary | unknown {
  if (!payload || typeof payload !== 'object') {
    return payload;
  }
  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    fields[key] = describe(value);
  }
  return {
    redacted: true,
    fields,
    digest: hash(payload),
  };
}

function describe(value: unknown): string {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  const type = typeof value;
  if (type === 'object') return 'object';
  return type;
}

function hash(payload: unknown): string {
  try {
    const json = JSON.stringify(payload ?? null);
    return createHash('sha1').update(json).digest('hex');
  } catch {
    return 'unknown';
  }
}
