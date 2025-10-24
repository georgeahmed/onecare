import type { SendDocumentRequest } from '@onecare/events';
import { validate, type ValidationError, type ValidationResult } from '@onecare/domain';

const SEND_DOCUMENT_REQUEST_SCHEMA_ID = 'https://onecare/schemas/messaging/send-document-request.json';

export interface ContractValidationSuccess<T> {
  ok: true;
  value: T;
}

export interface ContractValidationFailure {
  ok: false;
  errors: ValidationError[];
}

type ContractValidationResult<T> = ContractValidationSuccess<T> | ContractValidationFailure;

function mapResult<T>(payload: unknown, validator: (value: unknown) => ValidationResult): ContractValidationResult<T> {
  const result = validator(payload);
  if (result.ok) {
    return { ok: true, value: payload as T };
  }
  return { ok: false, errors: result.errors };
}

export function validateSendDocumentRequest(payload: unknown): ContractValidationResult<SendDocumentRequest> {
  return mapResult<SendDocumentRequest>(payload, (value) => validate(SEND_DOCUMENT_REQUEST_SCHEMA_ID, value));
}
