import type { ErrorEnvelope, ErrorObject } from './contracts/error-envelope';

export type ErrorCode = ErrorObject['code'];

const ERROR_STATUS_MAP: Record<ErrorCode, number> = {
  unauthorized: 401,
  forbidden: 403,
  invalid_input: 400,
  not_found: 404,
  unsupported_media_type: 415,
  payload_too_large: 413,
  conflict: 409,
  upstream_timeout: 504,
  upstream_unavailable: 503,
  internal_error: 500,
  too_many_requests: 429,
  rate_limited: 429,
  busy: 503,
  over_capacity: 503,
  invalid_fhir: 400,
};

export function mapErrorCodeToStatus(code: ErrorCode): number {
  return ERROR_STATUS_MAP[code] ?? 500;
}

export function createErrorEnvelope(
  code: ErrorCode,
  message: string,
  details?: Record<string, unknown>,
  correlationId?: string,
): ErrorEnvelope {
  const error: ErrorObject = {
    code,
    message,
  };
  if (details && Object.keys(details).length > 0) {
    error.details = details;
  }
  if (correlationId) {
    error.correlationId = correlationId;
  }
  return { error };
}
