import { BaseState } from '@onecare/statekit';
import { logger } from '@onecare/observability';
import { createEnvelope, Topics, type TriageInput } from '@onecare/events';
import { reserveIdempotency } from './idempotency';
import { normalizeToFhir, validateProfiles } from './normalize';
import HttpError from './httpError';
import type { OrchestratorContext, OrchestratorEvent } from '../types';
import { maybeRunShadowEvaluation } from './shadowEvaluation';
import { safePatientReference } from '../support/privacy';
import { publishWithRetry } from '../adapters/busUtil';

export type GateDenialReason =
  | 'signature_invalid'
  | 'actor_missing'
  | 'not_authorized'
  | 'consent_denied';

const AUDIT_DENIED_TYPE = 'orchestrator.access.denied';
const AUDIT_SUCCESS_TYPE = 'orchestrator.access.success';

function deny(ctx: OrchestratorContext, reason: GateDenialReason, extraDetails: Record<string, unknown> = {}): never {
  const auditDetails = {
    reason,
    requestId: ctx.requestId,
    patientRef: safePatientReference(ctx.submission.patient?.id),
    scope: ctx.scope,
    ...extraDetails,
  } satisfies Record<string, unknown>;

  logger.warn('zero-trust gate denied request', {
    reason,
    correlationId: ctx.correlationId,
    requestId: ctx.requestId,
    actorType: ctx.actor?.type,
    actorRef: ctx.actor?.id ? safePatientReference(ctx.actor.id) : null,
  });

  const auditOptions = {
    outcome: 'deny' as const,
    reasonCode: reason,
    subjectRef: auditDetails.patientRef ?? null,
    details: auditDetails,
  };
  ctx.recordAudit(AUDIT_DENIED_TYPE, auditOptions);
  void ctx.emitAudit(AUDIT_DENIED_TYPE, auditOptions);
  ctx.setOutcome('forbidden');
  throw new HttpError('forbidden', 'Access denied');
}

export class ReceivedState extends BaseState<OrchestratorContext, OrchestratorEvent> {
  constructor() {
    super('Received');
  }

  async handle(ctx: OrchestratorContext, _evt: OrchestratorEvent): Promise<string> {
    ctx.busHeaders = ctx.correlationId ? { 'x-correlation-id': ctx.correlationId } : undefined;
    return 'Authorized';
  }
}

export class AuthorizedState extends BaseState<OrchestratorContext, OrchestratorEvent> {
  constructor() {
    super('Authorized');
  }

  async handle(ctx: OrchestratorContext, _evt: OrchestratorEvent): Promise<string> {
    const signatureOk = await ctx.security.verifySignatureAndReplayGuard(ctx.authHeader, ctx.replayFingerprint);
    if (!signatureOk) {
      deny(ctx, 'signature_invalid', { hasAuthHeader: Boolean(ctx.authHeader) });
    }
    if (!ctx.authContext?.actor) {
      deny(ctx, 'actor_missing');
    }
    ctx.actor = ctx.authContext.actor;
    ctx.scope = ctx.authContext.scope ?? undefined;
    return 'ConsentChecked';
  }
}

export class ConsentCheckedState extends BaseState<OrchestratorContext, OrchestratorEvent> {
  constructor() {
    super('ConsentChecked');
  }

  async handle(ctx: OrchestratorContext, _evt: OrchestratorEvent): Promise<string> {
    const patientId = ctx.submission.patient?.id;
    if (!patientId) {
      ctx.setOutcome('invalid_input');
      throw new HttpError('invalid_input', 'Submission missing patient.id');
    }

    if (!ctx.actor) {
      deny(ctx, 'actor_missing');
    }

    const authorized = await ctx.security.authorize(ctx.actor, 'submit', patientId, ctx.scope);
    if (!authorized) {
      deny(ctx, 'not_authorized');
    }

    const consentDecision = await ctx.security.checkConsent(
      patientId,
      ctx.consentPurpose,
      ctx.consentResources,
      { correlationId: ctx.correlationId },
    );
    if (!consentDecision.allowed) {
      deny(ctx, 'consent_denied', { consentReason: consentDecision.reason });
    }

    const evidence =
      consentDecision.evidence ?? ctx.resolveConsentEvidence(patientId, ctx.consentPurpose);
    if (!evidence) {
      deny(ctx, 'consent_denied', { reason: 'consent_evidence_missing' });
    }
    ctx.consentEvidence = evidence;
    return 'IdempotencyReserved';
  }
}

export class IdempotencyReservedState extends BaseState<OrchestratorContext, OrchestratorEvent> {
  constructor() {
    super('IdempotencyReserved');
  }

  async handle(ctx: OrchestratorContext, _evt: OrchestratorEvent): Promise<string> {
    const result = await reserveIdempotency(ctx.idempotencyStore, ctx.idempotencyKey, {
      ttlSeconds: ctx.idempotencyTtlSeconds,
    });

    if (result === 'exists') {
      ctx.recordIdempotencyHit(ctx.idempotencyKey, ctx.correlationId);
      ctx.setOutcome('conflict');
      throw new HttpError('conflict', 'Duplicate request', { idempotencyKey: ctx.idempotencyKey });
    }

    ctx.idempotencyReserved = true;
    ctx.recordIdempotencyMiss(ctx.idempotencyKey, ctx.correlationId);
    ctx.recordIdempotencyTtl(ctx.idempotencyTtlSeconds, ctx.correlationId);
    return 'SafetyEvaluated';
  }
}

export class SafetyEvaluatedState extends BaseState<OrchestratorContext, OrchestratorEvent> {
  constructor() {
    super('SafetyEvaluated');
  }

  async handle(ctx: OrchestratorContext, _evt: OrchestratorEvent): Promise<string> {
    try {
      const decision = await ctx.callGuard(
        'safety_gate',
        (signal) =>
          ctx.analyzeSubmission(ctx.submission, undefined, {
            ...ctx.safetyGateOptions,
            correlationId: ctx.correlationId,
            requestId: ctx.requestId,
            consentReference: ctx.consentEvidence?.reference ?? null,
            actor: ctx.actor,
            scope: ctx.scope,
            signal,
          }),
        {
          ...ctx.safetyGuardOptions,
          correlationId: ctx.correlationId,
        },
      );
      ctx.decision = decision;
    } catch (error) {
      const code = ctx.classifyErrorCode(error);
      if (code === 'circuit_open' && ctx.safetyFallbackMode === 'rules') {
        logger.warn('safety.fallback.rules', { correlationId: ctx.correlationId });
        const auditDetails = { mode: 'rules', correlationId: ctx.correlationId };
        const auditOptions = {
          outcome: 'error' as const,
          reasonCode: 'safety_fallback',
          subjectRef: safePatientReference(ctx.submission.patient?.id),
          details: auditDetails,
        };
        ctx.recordAudit('orchestrator.safety.fallback', auditOptions);
        await ctx.emitAudit('orchestrator.safety.fallback', auditOptions);
        ctx.decision = { outcome: 'SAFE_TO_CONTINUE', reason: 'FALLBACK_RULES' };
      } else {
        throw error;
      }
    }

    if (!ctx.decision) {
      ctx.setOutcome('internal_error');
      throw new HttpError('internal_error', 'Safety decision missing');
    }

    maybeRunShadowEvaluation(ctx);

    if (ctx.decision.outcome !== 'SAFE_TO_CONTINUE') {
      ctx.result = ctx.decision;
      logger.info('safety diverted submission', { correlationId: ctx.correlationId });
      ctx.idempotencyReserved = false;
      ctx.setOutcome('ok');
      return 'Audited';
    }

    return 'Normalized';
  }
}

export class NormalizedState extends BaseState<OrchestratorContext, OrchestratorEvent> {
  constructor() {
    super('Normalized');
  }

  async handle(ctx: OrchestratorContext, _evt: OrchestratorEvent): Promise<string> {
    if (!ctx.decision || ctx.decision.outcome !== 'SAFE_TO_CONTINUE') {
      ctx.result = ctx.decision;
      ctx.idempotencyReserved = false;
      ctx.setOutcome('ok');
      return 'Audited';
    }

    const bundle = normalizeToFhir(ctx.submission);
    ctx.fhirBundle = bundle;
    logger.info('bundle.normalized', {
      entries: bundle.entry.length,
      correlationId: ctx.correlationId,
    });
    return 'Validated';
  }
}

export class ValidatedState extends BaseState<OrchestratorContext, OrchestratorEvent> {
  constructor() {
    super('Validated');
  }

  async handle(ctx: OrchestratorContext, _evt: OrchestratorEvent): Promise<string> {
    if (!ctx.fhirBundle) {
      ctx.setOutcome('internal_error');
      throw new HttpError('internal_error', 'FHIR bundle missing');
    }

    try {
      await validateProfiles(ctx.fhirBundle);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const auditOptions = {
        outcome: 'deny' as const,
        reasonCode: 'validation_failure',
        subjectRef: safePatientReference(ctx.submission.patient?.id),
        details: { reason, correlationId: ctx.correlationId },
      };
      ctx.recordAudit('orchestrator.validation.failure', auditOptions);
      await ctx.emitAudit('orchestrator.validation.failure', auditOptions);
      ctx.setOutcome('invalid_fhir');
      throw new HttpError('invalid_fhir', 'FHIR validation failed', { reason });
    }
    return 'Persisted';
  }
}

export class PersistedState extends BaseState<OrchestratorContext, OrchestratorEvent> {
  constructor() {
    super('Persisted');
  }

  async handle(ctx: OrchestratorContext, _evt: OrchestratorEvent): Promise<string> {
    if (!ctx.fhirBundle) {
      ctx.setOutcome('internal_error');
      throw new HttpError('internal_error', 'FHIR bundle missing');
    }
    try {
      await ctx.fhirRepository.upsertBundle(ctx.fhirBundle);
      const auditDetails = {
        entries: ctx.fhirBundle.entry?.length ?? 0,
        practiceId: ctx.practiceId,
        correlationId: ctx.correlationId,
      };
      const auditOptions = {
        outcome: 'allow' as const,
        reasonCode: 'fhir_persisted',
        subjectRef: safePatientReference(ctx.submission.patient?.id),
        details: auditDetails,
      };
      ctx.recordAudit('orchestrator.fhir.persisted', auditOptions);
      await ctx.emitAudit('orchestrator.fhir.persisted', auditOptions);
    } catch (error) {
      const mapped = ctx.mapFhirError(error);
      const failureOptions = {
        outcome: 'error' as const,
        reasonCode: mapped.code,
        subjectRef: safePatientReference(ctx.submission.patient?.id),
        details: {
          code: mapped.code,
          practiceId: ctx.practiceId,
          correlationId: ctx.correlationId,
        },
      };
      ctx.recordAudit('orchestrator.fhir.failure', failureOptions);
      await ctx.emitAudit('orchestrator.fhir.failure', failureOptions);
      ctx.setOutcome(mapped.code);
      throw new HttpError(mapped.code, mapped.message, mapped.details);
    }
    return 'Routed';
  }
}

export class RoutedState extends BaseState<OrchestratorContext, OrchestratorEvent> {
  constructor() {
    super('Routed');
  }

  async handle(ctx: OrchestratorContext, _evt: OrchestratorEvent): Promise<string> {
    if (!ctx.decision) {
      ctx.setOutcome('internal_error');
      throw new HttpError('internal_error', 'Safety decision missing');
    }

    const payload: TriageInput = {
      patientId: ctx.submission.patient.id,
      narrative: ctx.submission.narrative,
    };

    const requestId = ctx.requestId;
    const topic = ctx.triageTopic ?? Topics.triage.input;
    const envelope = createEnvelope(topic, payload, ctx.correlationId);
    const headers = ctx.busHeaders;
    const publishOptions = ctx.busPublishOptions;
    const maxAttempts = (publishOptions.maxRetries ?? 0) + 1;
    try {
      await publishWithRetry({
        bus: ctx.bus,
        envelope,
        headers,
        correlationId: ctx.correlationId,
        idempotencyKey: ctx.idempotencyKey,
        timeoutMs: publishOptions.timeoutMs ?? 500,
        maxAttempts,
        baseDelayMs: publishOptions.baseDelayMs ?? 50,
        payloadRef: {
          requestId,
          patientRef: safePatientReference(payload.patientId),
          outcome: ctx.decision.outcome,
        },
      });
    } catch (error) {
      logger.error('triage.publish.failed', {
        topic: envelope.topic,
        correlationId: ctx.correlationId,
        attempts: maxAttempts,
        reason: error instanceof Error ? error.message : String(error),
      });
      const publishFailureOptions = {
        outcome: 'error' as const,
        reasonCode: ctx.classifyErrorCode(error) ?? 'unknown',
        subjectRef: safePatientReference(ctx.submission.patient?.id),
        details: {
          topic: envelope.topic,
          attempts: maxAttempts,
          reason: ctx.classifyErrorCode(error) ?? 'unknown',
          correlationId: ctx.correlationId,
        },
      };
      ctx.recordAudit('orchestrator.publish.failure', publishFailureOptions);
      await ctx.emitAudit('orchestrator.publish.failure', publishFailureOptions);
      ctx.setOutcome('upstream_unavailable');
      throw new HttpError('upstream_unavailable', 'Event bus unavailable', {
        reason: error instanceof Error ? error.message : String(error),
      });
    }

    logger.info('published triage.input', {
      topic: envelope.topic,
      correlationId: ctx.correlationId,
      patientRef: safePatientReference(payload.patientId),
    });

    const successDetails = {
      outcome: ctx.decision.outcome,
      patientRef: safePatientReference(payload.patientId),
      practiceId: ctx.practiceId,
      topic: envelope.topic,
      consentReference: ctx.consentEvidence?.reference ?? null,
    };
    const publishSuccessOptions = {
      outcome: 'allow' as const,
      reasonCode: 'triage_routed',
      subjectRef: safePatientReference(ctx.submission.patient?.id),
      details: successDetails,
    };
    ctx.recordAudit(AUDIT_SUCCESS_TYPE, publishSuccessOptions);
    await ctx.emitAudit(AUDIT_SUCCESS_TYPE, publishSuccessOptions);

    ctx.result = ctx.decision;
    ctx.idempotencyReserved = false;
    ctx.setOutcome('ok');
    return 'Audited';
  }
}

export class AuditedState extends BaseState<OrchestratorContext, OrchestratorEvent> {
  constructor() {
    super('Audited');
  }

  async handle(_ctx: OrchestratorContext, _evt: OrchestratorEvent): Promise<string> {
    return 'Audited';
  }
}
