export interface AuthContext {
  actor: { type: 'patient' | 'practitioner' | 'system'; id: string };
  scope?: string[];
}

export interface SecurityServices {
  verifySignatureAndReplayGuard(authHeader: string | undefined, requestId: string): Promise<boolean>;
  authorize(actor: AuthContext['actor'], action: string, patientId?: string, scope?: string[]): Promise<boolean>;
  checkConsent(patientId: string, purpose: string, requestedResources: string[]): Promise<boolean>;
}

