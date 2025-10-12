import type { ErrorEnvelope, ErrorObject } from '@onecare/events';

export function createErrorEnvelope(
  code: ErrorObject['code'],
  message: string,
  details?: Record<string, unknown>,
  correlationId?: string,
): ErrorEnvelope {
  const error: ErrorObject = {
    code,
    message,
    ...(details && Object.keys(details).length > 0 ? { details } : {}),
    ...(correlationId ? { correlationId } : {}),
  };
  return { error };
}
