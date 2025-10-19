import type { MachineContext, MachineEvent } from '@onecare/statekit';
import type { PortalSubmission, SafetyDecision } from '@onecare/events';
import type { AuthContext, ConsentDecision, ConsentCheckOptions } from '@onecare/security';
import type { MessageBus } from '@onecare/bus';
import type { AuditEvent as LedgerAuditEvent, AuditOutcome, FhirBundle, FhirRepository, IdempotencyStore } from '@onecare/ports';
import type { ConsentEvidence } from './adapters/security';
import type { ErrorCode } from './application/error';
import type { GuardOptions } from './adapters/services/callWithGuard';
import type { AnalyzePortalSubmissionOptions } from './adapters/services/safetyGate';

export type OrchestratorOutcome = ErrorCode | 'ok';

export interface ShadowSafetyGateContext {
  enabled: boolean;
  sampleRate: number;
  endpoint?: string;
  variant?: string;
  timeoutMs?: number;
  maxRetries?: number;
  baseDelayMs?: number;
  auditEvent: string;
  random?: () => number;
}

export interface SecurityServices {
  verifySignatureAndReplayGuard(authHeader: string | undefined, requestId: string): Promise<boolean>;
  authorize(actor: AuthContext['actor'], action: string, patientId?: string, scope?: string[]): Promise<boolean>;
  checkConsent(
    patientId: string,
    purpose: string,
    resources: readonly string[],
    options?: ConsentCheckOptions,
  ): Promise<ConsentDecision>;
}

export interface OrchestratorContext extends MachineContext {
  correlationId: string;
  requestId: string;
  submission: PortalSubmission;
  practiceId: string;
  authHeader?: string;
  authContext: AuthContext | null;
  actor?: AuthContext['actor'];
  scope?: string[];
  replayFingerprint: string;
  security: SecurityServices;
  consentPurpose: string;
  consentResources: readonly string[];
  consentEvidence?: ConsentEvidence;
  resolveConsentEvidence: (patientId: string, purpose: string) => ConsentEvidence | null;
  setOutcome: (outcome: OrchestratorOutcome) => void;

  // Safety gate
  safetyGateOptions: AnalyzePortalSubmissionOptions;
  callGuard: <T>(name: string, fn: (signal: AbortSignal) => Promise<T>, options?: GuardOptions) => Promise<T>;
  analyzeSubmission: (
    submission: PortalSubmission,
    baseUrl: string | undefined,
    options: AnalyzePortalSubmissionOptions,
  ) => Promise<SafetyDecision>;
  safetyGuardOptions: GuardOptions;
  safetyFallbackMode: 'rules' | 'none';
  decision?: SafetyDecision;
  shadowSafetyGate?: ShadowSafetyGateContext;

  // Idempotency
  idempotencyStore: IdempotencyStore;
  idempotencyKey: string;
  idempotencyTtlSeconds: number;
  idempotencyReserved: boolean;
  recordIdempotencyHit: (key: string, correlationId: string | undefined) => void;
  recordIdempotencyMiss: (key: string, correlationId: string | undefined) => void;
  recordIdempotencyTtl: (ttlSeconds: number, correlationId: string | undefined) => void;

  // FHIR
  fhirRepository: FhirRepository;
  fhirBundle?: FhirBundle;
  mapFhirError: (err: unknown) => { code: ErrorCode; message: string; details?: Record<string, unknown> };

  // Messaging
  bus: MessageBus;
  triageTopic: string;
  busHeaders?: Record<string, string>;
  busPublishOptions: {
    timeoutMs?: number;
    maxRetries?: number;
    baseDelayMs?: number;
  };

  // Auditing
  emitAudit: (type: string, options?: AuditRecordOptions) => Promise<void>;
  recordAudit: (type: string, options?: AuditRecordOptions) => LedgerAuditEvent;

  // Result
  result?: SafetyDecision;

  // Utilities
  classifyErrorCode: (err: unknown) => string | undefined;
}

export type OrchestratorEvent = MachineEvent;

export interface AuditRecordOptions {
  actor?: AuthContext['actor'] | null;
  subjectRef?: string | null;
  outcome?: AuditOutcome | null;
  reasonCode?: string | null;
  details?: Record<string, unknown> | null;
  [key: string]: unknown;
}
