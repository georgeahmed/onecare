import { createHash } from 'node:crypto';

export function hashIdentifier(value: string | null | undefined): string | null {
  if (!value) return null;
  return createHash('sha256').update(value).digest('base64url');
}

export function safePatientReference(patientId: string | null | undefined): string | null {
  return hashIdentifier(patientId);
}

export function safeTaskReference(taskId: string | null | undefined): string | null {
  return hashIdentifier(taskId);
}
