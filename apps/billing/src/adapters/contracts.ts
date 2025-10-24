import { validate, type ValidationError as SchemaValidationError } from '@onecare/domain';
import type { BillingClaim, BillingResponse } from '@onecare/events';

const BILLING_CLAIM_SCHEMA_ID = 'https://onecare/schemas/billing/claim.json';
const BILLING_RESPONSE_SCHEMA_ID = 'https://onecare/schemas/billing/response.json';

export interface ContractViolation {
  path: string;
  keyword: string;
  message?: string;
}

export class BillingContractError extends Error {
  constructor(
    public readonly schemaId: string,
    public readonly violations: ContractViolation[],
    message = 'billing_contract_validation_failed',
  ) {
    super(message);
    this.name = 'BillingContractError';
  }
}

function sanitizeErrors(errors: SchemaValidationError[]): ContractViolation[] {
  return errors.map(({ path, keyword, message }) => ({
    path,
    keyword,
    message,
  }));
}

export function assertValidBillingClaim(payload: BillingClaim): void {
  const result = validate(BILLING_CLAIM_SCHEMA_ID, payload);
  if (!result.ok) {
    throw new BillingContractError(BILLING_CLAIM_SCHEMA_ID, sanitizeErrors(result.errors));
  }
}

export function assertValidBillingResponse(payload: BillingResponse): void {
  const result = validate(BILLING_RESPONSE_SCHEMA_ID, payload);
  if (!result.ok) {
    throw new BillingContractError(BILLING_RESPONSE_SCHEMA_ID, sanitizeErrors(result.errors));
  }
}
