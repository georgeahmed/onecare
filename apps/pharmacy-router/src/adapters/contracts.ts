import { validate, type ValidationError as SchemaValidationError } from '@onecare/domain';
import type { PharmacyOutcome, PharmacyReferral } from '@onecare/events';

const PHARMACY_REFERRAL_SCHEMA_ID = 'https://onecare/schemas/pharmacy/pharmacy-referral.json';
const PHARMACY_OUTCOME_SCHEMA_ID = 'https://onecare/schemas/pharmacy/pharmacy-outcome.json';

export interface ContractViolation {
  path: string;
  keyword: string;
  message?: string;
}

export class ContractValidationError extends Error {
  constructor(
    public readonly schemaId: string,
    public readonly violations: ContractViolation[],
    message = 'contract_validation_failed',
  ) {
    super(message);
    this.name = 'ContractValidationError';
  }
}

function sanitizeErrors(errors: SchemaValidationError[]): ContractViolation[] {
  return errors.map(({ path, keyword, message }) => ({
    path,
    keyword,
    message,
  }));
}

export function assertValidPharmacyReferral(payload: PharmacyReferral): void {
  const result = validate(PHARMACY_REFERRAL_SCHEMA_ID, payload);
  if (!result.ok) {
    throw new ContractValidationError(PHARMACY_REFERRAL_SCHEMA_ID, sanitizeErrors(result.errors));
  }
}

export function assertValidPharmacyOutcome(payload: PharmacyOutcome): void {
  const result = validate(PHARMACY_OUTCOME_SCHEMA_ID, payload);
  if (!result.ok) {
    throw new ContractValidationError(PHARMACY_OUTCOME_SCHEMA_ID, sanitizeErrors(result.errors));
  }
}
