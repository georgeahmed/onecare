import { logger } from '@onecare/observability';
import type { AnalyzePortalSubmissionOptions } from '../adapters/services/safetyGate';
import type { GuardOptions } from '../adapters/services/callWithGuard';
import type { OrchestratorContext, ShadowSafetyGateContext } from '../types';
import { safePatientReference } from '../support/privacy';

function sanitizeEndpoint(raw?: string): string | undefined {
  if (!raw) return undefined;
  try {
    const parsed = new URL(raw);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return undefined;
  }
}

function deriveShadowGuardOptions(
  ctx: OrchestratorContext,
  config: ShadowSafetyGateContext,
): GuardOptions {
  const guard: GuardOptions = {
    ...ctx.safetyGuardOptions,
    correlationId: ctx.correlationId,
    maxRetries: config.maxRetries ?? 0,
  };
  if (config.timeoutMs !== undefined) {
    guard.timeoutMs = config.timeoutMs;
  }
  if (config.baseDelayMs !== undefined) {
    guard.baseDelayMs = config.baseDelayMs;
  }
  return guard;
}

function buildAnalyzeOptions(
  ctx: OrchestratorContext,
  requestId: string,
  config: ShadowSafetyGateContext,
  signal: AbortSignal,
): AnalyzePortalSubmissionOptions {
  const base: AnalyzePortalSubmissionOptions = {
    ...ctx.safetyGateOptions,
    correlationId: ctx.correlationId,
    requestId,
    consentReference: ctx.consentEvidence?.reference ?? null,
    actor: ctx.actor,
    scope: ctx.scope,
    rolloutStage: 'shadow',
    rolloutVariant: config.variant,
    signal,
  };
  return base;
}

export function maybeRunShadowEvaluation(ctx: OrchestratorContext): void {
  const config = ctx.shadowSafetyGate;
  if (!config?.enabled) return;
  if (!ctx.decision) return;
  if (config.sampleRate <= 0) return;
  const sampler = config.random ?? Math.random;
  if (sampler() > config.sampleRate) return;

  void runShadowEvaluation(ctx, config).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn('safety.shadow.schedule_failed', {
      correlationId: ctx.correlationId,
      reason: message,
    });
  });
}

export async function runShadowEvaluation(
  ctx: OrchestratorContext,
  config: ShadowSafetyGateContext,
): Promise<void> {
  if (!ctx.decision) return;
  const guardOptions = deriveShadowGuardOptions(ctx, config);
  const shadowRequestId = `${ctx.requestId}:shadow`;
  try {
    const shadowDecision = await ctx.callGuard(
      'safety_gate_shadow',
      async (signal) => {
        const options = buildAnalyzeOptions(ctx, shadowRequestId, config, signal);
        return ctx.analyzeSubmission(ctx.submission, config.endpoint, options);
      },
      guardOptions,
    );

    const auditDetails = {
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
      shadowRequestId,
      sampleRate: config.sampleRate,
      variant: config.variant,
      endpoint: sanitizeEndpoint(config.endpoint),
      primaryOutcome: ctx.decision?.outcome,
      primaryReason: ctx.decision?.reason,
      shadowOutcome: shadowDecision.outcome,
      shadowReason: shadowDecision.reason,
    };

    logger.info('safety.shadow.recorded', {
      correlationId: ctx.correlationId,
      outcome: shadowDecision.outcome,
      variant: config.variant,
    });

    const auditOptions = {
      outcome: 'allow' as const,
      reasonCode: 'shadow_evaluated',
      subjectRef: safePatientReference(ctx.submission.patient?.id),
      details: auditDetails,
    };
    ctx.recordAudit(config.auditEvent, auditOptions);
    try {
      await ctx.emitAudit(config.auditEvent, auditOptions);
    } catch (auditError) {
      const auditReason = auditError instanceof Error ? auditError.message : String(auditError);
      logger.warn('safety.shadow.audit_failed', {
        correlationId: ctx.correlationId,
        reason: auditReason,
      });
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    logger.warn('safety.shadow.failed', {
      correlationId: ctx.correlationId,
      reason,
      endpoint: sanitizeEndpoint(config.endpoint),
      variant: config.variant,
    });
  }
}
