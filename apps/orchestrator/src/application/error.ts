export type ErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'invalid_input'
  | 'unsupported_media_type'
  | 'payload_too_large'
  | 'conflict'
  | 'upstream_timeout'
  | 'upstream_unavailable'
  | 'internal_error'
  | 'too_many_requests'
  | 'busy'
  | 'invalid_fhir';

export interface ErrorEnvelope {
  error: {
    code: ErrorCode;
    message: string;
    details?: Record<string, unknown>;
    correlationId?: string;
  };
}

export function errorEnvelope(
  code: ErrorCode,
  message: string,
  details?: Record<string, unknown>,
  correlationId?: string
): ErrorEnvelope {
  return {
    error: {
      code,
      message,
      ...(details ? { details } : {}),
      ...(correlationId ? { correlationId } : {}),
    },
  };
}

export function mapErrorToStatus(code: ErrorCode): number {
  switch (code) {
    case 'unauthorized':
      return 401;
    case 'forbidden':
      return 403;
    case 'invalid_input':
      return 400;
    case 'unsupported_media_type':
      return 415;
    case 'payload_too_large':
      return 413;
    case 'conflict':
      return 409;
    case 'too_many_requests':
      return 429;
    case 'upstream_timeout':
      return 504;
    case 'upstream_unavailable':
      return 503;
    case 'busy':
      return 503;
    case 'invalid_fhir':
      return 400;
    case 'internal_error':
    default:
      return 500;
  }
}

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

