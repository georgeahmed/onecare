export { createErrorEnvelope as errorEnvelope, mapErrorCodeToStatus as mapErrorToStatus } from '@onecare/events';
export type { ErrorCode, ErrorEnvelope } from '@onecare/events';

// Minimal safe redaction helper for logs/tests
export function redact(obj: Record<string, unknown>): Record<string, unknown> {
  const SENSITIVE = new Set([
    'authorization',
    'cookie',
    'set-cookie',
    'x-api-key',
    'x-access-token',
    'password',
    'token',
  ]);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (SENSITIVE.has(k.toLowerCase())) out[k] = '[REDACTED]';
    else out[k] = v as unknown;
  }
  return out;
}
