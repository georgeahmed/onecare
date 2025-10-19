import type { ErrorObject as ContractErrorObject } from '@onecare/events';

export type ErrorCode =
  | ContractErrorObject['code']
  | 'unsupported_media_type'
  | 'payload_too_large'
  | 'busy';

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
  correlationId?: string,
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
    case 'rate_limited':
      return 429;
    case 'busy':
    case 'over_capacity':
    case 'upstream_unavailable':
      return 503;
    case 'upstream_timeout':
      return 504;
    case 'invalid_fhir':
      return 400;
    default:
      return 500;
  }
}
