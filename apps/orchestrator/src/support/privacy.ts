import { hashIdentifier as secureHashIdentifier } from '@onecare/security';

export function hashIdentifier(value: string | null | undefined): string | null {
  if (!value) return null;
  return secureHashIdentifier(value);
}

export function safePatientReference(patientId: string | null | undefined): string | null {
  return hashIdentifier(patientId);
}
