import type { ContractValidationError } from '@onecare/events';

export type TelephonyContractErrorCode = 'call_transcribed_invalid' | 'intent_classified_invalid';

export class TelephonyContractError extends Error {
  constructor(
    public readonly code: TelephonyContractErrorCode,
    message: string,
    public readonly details: ContractValidationError[],
  ) {
    super(message);
    this.name = 'TelephonyContractError';
  }
}
