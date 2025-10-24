import { validate, type ValidationError as SchemaValidationError } from '@onecare/domain';
import type { TriageDecision, TriageInput } from '@onecare/events';

const TRIAGE_INPUT_SCHEMA_ID = 'https://onecare/schemas/triage/triage-input.json';
const TRIAGE_DECISION_SCHEMA_ID = 'https://onecare/schemas/triage/triage-decision.json';

export interface ContractViolation {
  path: string;
  keyword: string;
  message?: string;
}

export class TriageContractValidationError extends Error {
  constructor(
    public readonly schemaId: string,
    public readonly violations: ContractViolation[],
    message = 'triage_contract_validation_failed',
  ) {
    super(message);
    this.name = 'TriageContractValidationError';
  }
}

function mapViolations(errors: SchemaValidationError[]): ContractViolation[] {
  return errors.map(({ path, keyword, message }) => ({
    path,
    keyword,
    message,
  }));
}

export function assertValidTriageInput(payload: TriageInput): void {
  const result = validate(TRIAGE_INPUT_SCHEMA_ID, payload);
  if (!result.ok) {
    throw new TriageContractValidationError(TRIAGE_INPUT_SCHEMA_ID, mapViolations(result.errors));
  }
}

export function assertValidTriageDecision(payload: TriageDecision): void {
  const result = validate(TRIAGE_DECISION_SCHEMA_ID, payload);
  if (!result.ok) {
    throw new TriageContractValidationError(TRIAGE_DECISION_SCHEMA_ID, mapViolations(result.errors));
  }
}
