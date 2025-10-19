import { BaseState } from '@onecare/statekit';
import type { MachineContext, MachineEvent } from '@onecare/statekit';
import type { ResolvedConfig } from '@onecare/config';
import { logger, ensureTracing, createCounter, createHistogram, startSpan, type Span } from '@onecare/observability';
import type {
  FeatureStore,
  FhirRepository,
  FhirResourceRef,
  QueueNotifier,
  IdempotencyStore,
} from '@onecare/ports';
import { createTaskResource, executeWithIdempotency } from '@onecare/ports';
import type { MessageBus } from '@onecare/bus';
import { withMessageGuards } from '@onecare/bus';
import { Topics, createEnvelope, type AuditEvent, type TriageDecision, type TriageInput } from '@onecare/events';
import {
  computeRulesFallback,
  computeTriageScore,
  resolvePriorityThresholds,
  type RulesFallbackResult,
  type TriageFeatureVector,
} from './scoring';
import { extractFeatures } from './features';
import { createDedupStore, type DedupEntry, type DedupDecision } from './dedup';
import type { TextNormalizeOptions } from './text-normalize';
import { assertValidTriageDecision, assertValidTriageInput } from './contracts';
import { logFeatureVector } from '../featuresHook';
import { callWithGuard } from './guard';
import type { TriageSlaTracker } from '../sla/aging';
import { safePatientReference, safeTaskReference } from '../support/privacy';

export interface TriageContext extends MachineContext {
  config: ResolvedConfig;
  features: TriageFeatureVector;
  rawFeatures?: Record<string, unknown>;
  patientId?: string;
  narrative?: string;
  now?: number;
  score?: number;
  isDuplicate?: boolean;
  duplicateDetectedAt?: number;
  duplicateWindowMs?: number;
  duplicateSimilarity?: number;
  duplicateReference?: DedupEntry;
  handleDuplicate?: DuplicateHandler;
  duplicateHandled?: boolean;
  correlationId?: string;
  fhirRepository?: FhirRepository;
  bus?: MessageBus;
  priority?: PriorityCode;
  taskOwner?: string;
  taskReference?: FhirResourceRef;
  taskId?: string;
  taskCreatedAt?: string;
  taskEventPublished?: boolean;
  taskDescription?: string;
  queueNotifier?: QueueNotifier;
  queueName?: string;
  featureStore?: FeatureStore;
  idempotencyStore?: IdempotencyStore;
  idempotencyKey?: string;
  idempotencyTtlSeconds?: number;
  triageInput?: TriageInput;
  decision?: TriageDecision;
  decisionReasons?: string[];
  mlDependencies?: Partial<Record<MlDependencyKey, MlDependencyState>>;
  scoreSource?: 'ml' | 'rules';
  fallbackApplied?: boolean;
  fallbackDeltaExceeded?: boolean;
  slaTracker?: TriageSlaTracker;
  consentEvaluator?: AssignmentConsentEvaluator;
}

export interface TriageEvent extends MachineEvent {
  type: 'triage.evaluate' | string;
}

type PriorityCode = 'STAT' | 'URGENT' | 'SOON' | 'ROUTINE';

type MlDependencyKey = 'acuity' | 'similarity';
type MlDependencyState = 'ok' | 'timeout' | 'unavailable' | 'circuit_open' | 'degraded';

interface TaskCreatedEvent {
  taskId: string;
  patientId: string;
  priority: PriorityCode;
}

export interface DuplicateDetails {
  patientId?: string;
  narrative?: string;
  duplicateNarrative?: string;
  similarity?: number;
  windowMs?: number;
  detectedAt: number;
  correlationId?: string;
}

export type DuplicateHandler = (details: DuplicateDetails) => Promise<void> | void;

export interface AssignmentConsentInput {
  patientId: string;
  correlationId?: string;
  purpose: 'triage.assignment';
}

export interface AssignmentConsentDecision {
  allowed: boolean;
  reason?: string;
  auditDetails?: Record<string, unknown>;
}

export interface AssignmentConsentEvaluator {
  check(input: AssignmentConsentInput): Promise<AssignmentConsentDecision> | AssignmentConsentDecision;
}

ensureTracing('triage');

const TRIAGE_TASKS_CREATED_TOPIC = Topics.tasks.created;
const TRIAGE_TASKS_UPDATED_TOPIC = Topics.tasks.updated;
const TRIAGE_DECISION_TOPIC = (Topics.triage as { decision?: string } | undefined)?.decision ?? 'triage.decision';
const TRIAGE_ALLOWED_TOPICS = new Set<string>([
  TRIAGE_TASKS_CREATED_TOPIC,
  TRIAGE_TASKS_UPDATED_TOPIC,
  TRIAGE_DECISION_TOPIC,
  Topics.broker.deadLetter,
  Topics.audit.event,
]);
const DEDUP_CACHE_LIMIT = 50;
const dedupStore = createDedupStore({ maxEntriesPerPatient: DEDUP_CACHE_LIMIT });
const DEFAULT_TRIAGE_IDEMPOTENCY_TTL_SECONDS = 10 * 60;

const scoreDecisionCounter = createCounter('triage.score.decision');
const scoreDurationHistogram = createHistogram('triage.score.duration_ms');
const dedupDurationHistogram = createHistogram('triage.dedup.duration_ms');
const taskCreateSuccessCounter = createCounter('triage.task.create.success');
const taskCreateErrorCounter = createCounter('triage.task.create.error');
const taskCreateDurationHistogram = createHistogram('triage.task.create.duration_ms');
const notifySuccessCounter = createCounter('triage.notify.success');
const notifyErrorCounter = createCounter('triage.notify.error');
const notifyDurationHistogram = createHistogram('triage.notify.duration_ms');

function metricAttributes(ctx: TriageContext, attributes: Record<string, unknown> = {}): Record<string, unknown> {
  if (ctx.correlationId) {
    return { ...attributes, correlationId: ctx.correlationId };
  }
  return { ...attributes };
}

function endSpan(span: Span | undefined, error?: unknown): void {
  if (!span) return;
  if (error instanceof Error && span.isRecording()) {
    span.recordException(error);
  }
  span.end();
}

function recordScoreDecision(ctx: TriageContext, priority: PriorityCode): void {
  const attributes: Record<string, unknown> = {
    priority,
    source: ctx.scoreSource ?? 'unknown',
    fallback: ctx.fallbackApplied ? 'yes' : 'no',
    duplicate: ctx.isDuplicate ? 'yes' : 'no',
  };
  const deltaExceeded = ctx.fallbackDeltaExceeded === true;
  attributes.deltaExceeded = deltaExceeded ? 'yes' : 'no';
  scoreDecisionCounter.add(1, metricAttributes(ctx, attributes));
}

function resolveFallbackCause(ctx: TriageContext): string | undefined {
  const dependencies = ctx.mlDependencies;
  if (dependencies) {
    for (const [name, state] of Object.entries(dependencies) as [MlDependencyKey, MlDependencyState | undefined][]) {
      if (!state || state === 'ok') continue;
      return `ml_${name}_${state}`;
    }
  }

  const featureSource = ctx.triageInput?.features;
  if (!featureSource || (typeof featureSource === 'object' && featureSource !== null && Object.keys(featureSource).length === 0)) {
    return 'ml_features_missing';
  }

  return undefined;
}

function parseDurationToMs(raw: unknown): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return raw;
  }
  if (typeof raw !== 'string') return 0;
  const match = raw.match(
    /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i,
  );
  if (!match) return 0;
  const [, days, hours, minutes, seconds] = match;
  const dayMs = days ? Number(days) * 24 * 60 * 60 * 1_000 : 0;
  const hourMs = hours ? Number(hours) * 60 * 60 * 1_000 : 0;
  const minuteMs = minutes ? Number(minutes) * 60 * 1_000 : 0;
  const secondMs = seconds ? Number(seconds) * 1_000 : 0;
  const total = dayMs + hourMs + minuteMs + secondMs;
  return Number.isFinite(total) ? total : 0;
}

function getDedupWindowMs(config: ResolvedConfig): number {
  const raw = (config.triage as { dedup_window?: unknown } | undefined)?.dedup_window;
  const ms = parseDurationToMs(raw);
  return ms > 0 ? ms : 0;
}

function getSimilarityThreshold(config: ResolvedConfig): number {
  const raw = (config.triage as { sim_threshold?: unknown } | undefined)?.sim_threshold;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return Math.min(Math.max(raw, 0), 1);
  }
  return 1;
}

function getNow(ctx: TriageContext): number {
  return typeof ctx.now === 'number' ? ctx.now : Date.now();
}

export function resetDedupCache(): void {
  dedupStore.reset();
}

function getDedupShingleSize(config: ResolvedConfig): number {
  const raw = (config.triage as { dedup_shingle_size?: unknown } | undefined)?.dedup_shingle_size;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    const value = Math.floor(raw);
    return value >= 2 ? value : 2;
  }
  return 3;
}

function getDedupTextOptions(config: ResolvedConfig): TextNormalizeOptions | undefined {
  const raw = (config.triage as { dedup_normalization?: Record<string, unknown> } | undefined)?.dedup_normalization;
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }
  const options: TextNormalizeOptions = {};
  if (Array.isArray(raw.stopwords)) {
    options.stopwords = raw.stopwords.filter((value): value is string => typeof value === 'string');
  }
  if (typeof raw.apply_stemming === 'boolean') {
    options.applyStemming = raw.apply_stemming;
  }
  if (typeof raw.min_token_length === 'number' && Number.isFinite(raw.min_token_length)) {
    const coerced = Math.floor(raw.min_token_length);
    options.minTokenLength = coerced > 0 ? coerced : 1;
  }
  return options;
}

export class IntakeState extends BaseState<TriageContext, TriageEvent> {
  constructor() {
    super('Intake');
  }

  async handle(ctx: TriageContext, _evt: TriageEvent): Promise<string> {
    const fallbackFeatures =
      ctx.rawFeatures ??
      (ctx.features
        ? Object.fromEntries(
            Object.entries(ctx.features).filter(([, value]) => value !== undefined),
          )
        : undefined);

    const inputPayload: TriageInput =
      ctx.triageInput ??
      ({
        patientId: ctx.patientId ?? '',
        narrative: ctx.narrative ?? '',
        ...(fallbackFeatures ? { features: fallbackFeatures } : {}),
      } as TriageInput);

    assertValidTriageInput(inputPayload);
    ctx.triageInput = inputPayload;
    ctx.patientId = inputPayload.patientId;
    ctx.narrative = inputPayload.narrative;
    ctx.rawFeatures =
      inputPayload.features && typeof inputPayload.features === 'object'
        ? (inputPayload.features as Record<string, unknown>)
        : undefined;

    const windowMs = getDedupWindowMs(ctx.config);
    const threshold = getSimilarityThreshold(ctx.config);
    const patientId = ctx.patientId?.trim();
    const narrative = ctx.narrative?.trim();
    const now = getNow(ctx);

    const dedupSpan = startSpan('triage.dedup');
    const dedupStarted = Date.now();
    let decision: DedupDecision | undefined;
    let dedupError: unknown;
    try {
      decision = dedupStore.evaluate({
        patientId,
        narrative,
        now,
        windowMs,
        threshold,
        shingleSize: getDedupShingleSize(ctx.config),
        textOptions: getDedupTextOptions(ctx.config),
        correlationId: ctx.correlationId,
      });
    } catch (error) {
      dedupError = error;
      throw error;
    } finally {
      const duration = Date.now() - dedupStarted;
      const outcome = decision ? (decision.isDuplicate ? 'duplicate' : 'unique') : 'error';
      const attributes: Record<string, unknown> = { outcome };
      if (decision?.reason) {
        attributes.reason = decision.reason;
      }
      dedupDurationHistogram.record(duration, metricAttributes(ctx, attributes));
      if (decision && dedupSpan.isRecording()) {
        dedupSpan.setAttribute('triage.dedup.duplicate', decision.isDuplicate ? 1 : 0);
        if (decision.reason) {
          dedupSpan.setAttribute('triage.dedup.reason', decision.reason);
        }
      }
      endSpan(dedupSpan, dedupError);
    }

    if (!decision) {
      throw new Error('dedup_decision_missing');
    }

    ctx.duplicateWindowMs = windowMs > 0 ? windowMs : undefined;
    ctx.duplicateSimilarity = decision.similarity;
    ctx.duplicateReference = decision.reference;

    if (decision.isDuplicate) {
      ctx.isDuplicate = true;
      ctx.duplicateDetectedAt = now;
      return 'Duplicate';
    }

    ctx.isDuplicate = false;
    ctx.duplicateDetectedAt = undefined;
    const normalizedFeatures = extractFeatures(ctx.rawFeatures ?? ctx.features ?? {}, ctx.config);
    ctx.features = normalizedFeatures;
    const scoreSpan = startSpan('triage.score');
    const scoreStarted = Date.now();
    let baselineScore = 0;
    let fallbackResult: RulesFallbackResult | undefined;
    let scoringError: unknown;

    try {
      baselineScore = computeTriageScore(ctx.config, normalizedFeatures);
      const fallbackCause = resolveFallbackCause(ctx);

      if (fallbackCause) {
        fallbackResult = computeRulesFallback({
          config: ctx.config,
          features: normalizedFeatures,
          narrative: ctx.narrative ?? ctx.triageInput?.narrative ?? '',
          cause: fallbackCause,
          redFlags: ctx.config.red_flag_set ?? [],
          baselineScore,
        });
      }

      if (fallbackResult?.applied) {
        ctx.score = fallbackResult.score;
        ctx.decisionReasons = fallbackResult.reasons;
        ctx.scoreSource = 'rules';
        ctx.fallbackApplied = true;
        ctx.fallbackDeltaExceeded = fallbackResult.deltaExceeded;
      } else {
        ctx.score = baselineScore;
        ctx.decisionReasons = fallbackResult?.reasons?.length ? fallbackResult.reasons : undefined;
        ctx.scoreSource = 'ml';
        ctx.fallbackApplied = false;
        ctx.fallbackDeltaExceeded = fallbackResult?.deltaExceeded ?? false;
      }
    } catch (error) {
      scoringError = error;
      throw error;
    } finally {
      const duration = Date.now() - scoreStarted;
      const attributes: Record<string, unknown> = {
        source: ctx.scoreSource ?? 'unknown',
        fallback: ctx.fallbackApplied ? 'yes' : 'no',
      };
      if (typeof ctx.score === 'number' && Number.isFinite(ctx.score)) {
        attributes.score = ctx.score;
      }
      scoreDurationHistogram.record(duration, metricAttributes(ctx, attributes));
      if (scoreSpan.isRecording()) {
        scoreSpan.setAttribute('triage.score.source', ctx.scoreSource ?? 'unknown');
        scoreSpan.setAttribute('triage.score.fallback', ctx.fallbackApplied ? 'yes' : 'no');
        if (typeof ctx.score === 'number' && Number.isFinite(ctx.score)) {
          scoreSpan.setAttribute('triage.score.value', ctx.score);
        }
      }
      endSpan(scoreSpan, scoringError);
    }
    return 'Scored';
  }
}

export class ScoredState extends BaseState<TriageContext, TriageEvent> {
  constructor() {
    super('Scored');
  }

  async handle(ctx: TriageContext, _evt: TriageEvent): Promise<string> {
    const score = typeof ctx.score === 'number' ? ctx.score : 0;
    ctx.priority = determinePriority(ctx.config, score, ctx.features);
    recordScoreDecision(ctx, ctx.priority);
    await logFeatureVector({
      source: 'triage',
      store: ctx.featureStore,
      correlationId: ctx.correlationId,
      patientId: ctx.patientId,
      entityId: ctx.patientId,
      features: ctx.features ?? {},
      metadata: {
        score,
        priority: ctx.priority,
      },
    });
    return 'TaskCreated';
  }
}

export class TaskCreatedState extends BaseState<TriageContext, TriageEvent> {
  constructor() {
    super('TaskCreated');
  }

  async handle(ctx: TriageContext, _evt: TriageEvent): Promise<string> {
    if (!ctx.fhirRepository) {
      throw new Error('fhir_repository_missing');
    }
    if (!ctx.patientId) {
      throw new Error('patient_id_missing');
    }

    const bus = ensureTriageBus(ctx);
    const correlationId = ensureCorrelationId(ctx);
    const score = typeof ctx.score === 'number' ? ctx.score : 0;
    const priority = ctx.priority ?? determinePriority(ctx.config, score, ctx.features);
    ctx.priority = priority;

    await ensureAssignmentConsent(ctx, correlationId, bus);

    const timestamp = new Date().toISOString();
    const idempotencyKey = ctx.idempotencyKey ?? deriveTriageIdempotencyKey(ctx);
    const ttlSeconds = resolveTriageIdempotencyTtl(ctx);

    const { status } = await executeWithIdempotency({
      store: ctx.idempotencyStore,
      key: idempotencyKey,
      ttlSeconds,
      execute: async () => {
        const taskResource = buildTaskResource(ctx, priority, timestamp);
        let reference;
        const taskSpan = startSpan('triage.task.create');
        const taskStarted = Date.now();
        let taskError: (Error & { code: string }) | undefined;
        try {
          reference = await callWithGuard(
            'fhir.createTask',
            async (signal) =>
              createTaskResource(ctx.fhirRepository!, taskResource, {
                idempotencyKey,
                signal,
              }),
            {
              correlationId,
            },
          );
          taskCreateSuccessCounter.add(1, metricAttributes(ctx, { owner: ctx.taskOwner ?? 'unknown' }));
        } catch (error) {
          const mapped = classifyFhirTaskError(error);
          taskError = mapped;
          taskCreateErrorCounter.add(1, metricAttributes(ctx, { code: mapped.code, outcome: 'error' }));
          logger.error('triage.fhir_task.failed', {
            component: 'triage',
            code: mapped.code,
            message: mapped.message,
            correlationId,
            patientRef: safePatientReference(ctx.patientId),
          });
          throw mapped;
        } finally {
          const duration = Date.now() - taskStarted;
          const outcomeAttributes: Record<string, unknown> = {
            outcome: taskError ? 'error' : 'success',
          };
          if (taskError) {
            outcomeAttributes.code = taskError.code;
          }
          taskCreateDurationHistogram.record(duration, metricAttributes(ctx, outcomeAttributes));
          if (taskSpan.isRecording()) {
            taskSpan.setAttribute('triage.task.create.outcome', taskError ? 'error' : 'success');
            if (taskError) {
              taskSpan.setAttribute('triage.task.create.error_code', taskError.code);
            }
          }
          endSpan(taskSpan, taskError);
        }

        ctx.taskReference = reference;
        ctx.taskId = reference.id;
        ctx.taskCreatedAt = timestamp;

        const decision = buildTriageDecision(ctx, timestamp);
        assertValidTriageDecision(decision);
        ctx.decision = decision;

        const decisionEnvelope = createEnvelope(TRIAGE_DECISION_TOPIC, decision, correlationId);

        const payload: TaskCreatedEvent = {
          taskId: reference.id,
          patientId: ctx.patientId!,
          priority,
        };
        const envelope = createEnvelope(TRIAGE_TASKS_CREATED_TOPIC, payload, correlationId);
        const headers: Record<string, string> = {
          'x-idempotency-key': idempotencyKey,
        };
        if (correlationId) {
          headers['x-correlation-id'] = correlationId;
        }
        await bus.publish(TRIAGE_DECISION_TOPIC, decisionEnvelope, headers);
        await bus.publish(TRIAGE_TASKS_CREATED_TOPIC, envelope, headers);
        ctx.taskEventPublished = true;

        await notifyQueue(ctx, {
          taskId: reference.id,
          patientId: ctx.patientId!,
          priority,
          createdAt: timestamp,
        });

        logger.info('triage.idempotency.executed', {
          component: 'triage',
          correlationId,
          idempotencyKey,
          taskRef: safeTaskReference(reference.id),
          patientRef: safePatientReference(ctx.patientId),
        });
        return true;
      },
      onDuplicate: () => {
        logger.warn('triage.idempotency.duplicate', {
          component: 'triage',
          idempotencyKey,
          patientRef: safePatientReference(ctx.patientId),
          correlationId,
        });
      },
      onError: (error) => {
        logger.error('triage.idempotency.failed', {
          component: 'triage',
          idempotencyKey,
          patientRef: safePatientReference(ctx.patientId),
          correlationId,
          reason: error instanceof Error ? error.message : 'unknown_error',
        });
      },
    });

    if (status === 'skipped') {
      return 'Notified';
    }

    if (status === 'executed' && ctx.slaTracker && ctx.taskId && ctx.patientId) {
      const createdAtIso = ctx.taskCreatedAt ?? new Date().toISOString();
      ctx.slaTracker.track({
        taskId: ctx.taskId,
        patientId: ctx.patientId,
        priority,
        createdAt: createdAtIso,
        correlationId,
        queueName: ctx.queueName,
        queueNotifier: ctx.queueNotifier,
        ownerReference: ctx.taskOwner,
      });
    }
    return 'Notified';
  }
}

export class NotifiedState extends BaseState<TriageContext, TriageEvent> {
  constructor() {
    super('Notified');
  }

  async handle(_ctx: TriageContext, _evt: TriageEvent): Promise<string> {
    return 'Completed';
  }
}

export class CompletedState extends BaseState<TriageContext, TriageEvent> {
  constructor() {
    super('Completed');
  }

  async handle(_ctx: TriageContext, _evt: TriageEvent): Promise<string> {
    return 'Completed';
  }
}

export function getDedupCacheSizeForTest(): number {
  return dedupStore.size();
}

export function getDedupCacheEntryCountForTest(patientId: string): number {
  return dedupStore.count(patientId);
}

export { DEDUP_CACHE_LIMIT as DEDUP_CACHE_LIMIT_FOR_TEST };

export class DuplicateState extends BaseState<TriageContext, TriageEvent> {
  constructor() {
    super('Duplicate');
  }

  async handle(ctx: TriageContext, _evt: TriageEvent): Promise<string> {
    const details: DuplicateDetails = {
      patientId: ctx.patientId,
      narrative: ctx.narrative,
      duplicateNarrative: ctx.duplicateReference?.narrative,
      similarity: ctx.duplicateSimilarity,
      windowMs: ctx.duplicateWindowMs,
      detectedAt: ctx.duplicateDetectedAt ?? getNow(ctx),
      correlationId: ctx.correlationId,
    };

    if (ctx.handleDuplicate) {
      await ctx.handleDuplicate(details);
    } else {
      logger.info('triage duplicate detected', {
        component: 'triage',
        patientRef: safePatientReference(details.patientId),
        windowMs: details.windowMs,
        similarity: details.similarity,
        detectedAt: details.detectedAt,
        correlationId: details.correlationId,
        narrativeLength: details.narrative?.length ?? 0,
        duplicateNarrativeLength: details.duplicateNarrative?.length ?? 0,
      });
    }

    ctx.duplicateHandled = true;
    return 'Completed';
  }
}

function sanitizeNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function classifyFhirTaskError(error: unknown): Error & { code: string } {
  const baseMessage = 'FHIR task creation failed';
  const mapped = { code: 'upstream_unavailable', message: baseMessage };

  if (error && typeof error === 'object') {
    const status = Number((error as { status?: number }).status);
    const retryable = (error as { retryable?: boolean }).retryable === true;
    if (status === 409) {
      mapped.code = 'conflict';
      mapped.message = 'FHIR reported a conflict while creating the task';
    } else if (status === 429) {
      mapped.code = 'too_many_requests';
      mapped.message = 'FHIR rate limit exceeded while creating the task';
    } else if (status === 400 || status === 422) {
      mapped.code = 'invalid_fhir';
      mapped.message = 'FHIR rejected the task payload';
    } else if (status === 401 || status === 403) {
      mapped.code = 'forbidden';
      mapped.message = 'FHIR denied authorization for task creation';
    } else if (retryable || (error as { name?: string }).name === 'AbortError') {
      mapped.code = 'upstream_timeout';
      mapped.message = 'FHIR task creation timed out';
    } else if (Number.isFinite(status) && status >= 500) {
      mapped.code = 'upstream_unavailable';
      mapped.message = 'FHIR service unavailable during task creation';
    }
  }

  if (error instanceof Error) {
    return Object.assign(error, { code: mapped.code, message: mapped.message });
  }
  return Object.assign(new Error(mapped.message), { code: mapped.code });
}

function getPriorityTieBreaker(config: ResolvedConfig): { epsilon: number; acuityPromotion: number } {
  const raw = ((config.triage as { priority_tiebreaker?: Record<string, unknown> } | undefined)?.priority_tiebreaker ??
    {}) as Record<string, unknown>;

  const epsilon = sanitizeNumber(raw.epsilon, 0.01);
  const acuityPromotion = sanitizeNumber(raw.acuity_promotion, 0.85);
  return {
    epsilon: epsilon > 0 ? epsilon : 0.01,
    acuityPromotion: Math.min(Math.max(acuityPromotion, 0), 1),
  };
}

export function determinePriority(
  config: ResolvedConfig,
  score: number,
  features?: TriageFeatureVector,
): PriorityCode {
  const thresholds = resolvePriorityThresholds(config);

  const tieBreaker = getPriorityTieBreaker(config);
  const acuity = typeof features?.acuity === 'number' && Number.isFinite(features.acuity) ? features.acuity : 0;

  let priority: PriorityCode = 'ROUTINE';
  if (score >= thresholds.STAT) {
    priority = 'STAT';
  } else if (score >= thresholds.URGENT) {
    priority = 'URGENT';
  } else if (score >= thresholds.SOON) {
    priority = 'SOON';
  }

  if (priority === 'STAT') {
    return 'STAT';
  }

  const nextThresholdByPriority: Record<PriorityCode, number | undefined> = {
    STAT: undefined,
    URGENT: thresholds.STAT,
    SOON: thresholds.URGENT,
    ROUTINE: thresholds.SOON,
  };

  const promotedPriority: Record<PriorityCode, PriorityCode> = {
    ROUTINE: 'SOON',
    SOON: 'URGENT',
    URGENT: 'STAT',
    STAT: 'STAT',
  };

  const nextThreshold = nextThresholdByPriority[priority];
  if (
    nextThreshold !== undefined &&
    nextThreshold - score <= tieBreaker.epsilon &&
    acuity >= tieBreaker.acuityPromotion
  ) {
    return promotedPriority[priority];
  }

  return priority;
}

function mapPriorityToFhirCode(priority: PriorityCode): 'stat' | 'urgent' | 'asap' | 'routine' {
  switch (priority) {
    case 'STAT':
      return 'stat';
    case 'URGENT':
      return 'urgent';
    case 'SOON':
      return 'asap';
    case 'ROUTINE':
    default:
      return 'routine';
  }
}

function buildTaskResource(ctx: TriageContext, priority: PriorityCode, timestamp: string): Record<string, unknown> {
  const resource: Record<string, unknown> = {
    resourceType: 'Task',
    status: 'requested',
    intent: 'order',
    authoredOn: timestamp,
    lastModified: timestamp,
    priority: mapPriorityToFhirCode(priority),
    for: { reference: `Patient/${ctx.patientId}` },
    description: ctx.taskDescription ?? 'Follow-up from triage scoring',
  };

  if (ctx.taskOwner) {
    resource.owner = { reference: ctx.taskOwner };
  }

  const inputs: Array<Record<string, unknown>> = [];
  if (typeof ctx.score === 'number') {
    inputs.push({
      type: { text: 'triage-score' },
      valueDecimal: ctx.score,
    });
  }
  if (ctx.priority) {
    inputs.push({
      type: { text: 'triage-priority' },
      valueString: ctx.priority,
    });
  }

  if (inputs.length > 0) {
    resource.input = inputs;
  }

  return resource;
}

function buildTriageDecision(ctx: TriageContext, generatedAt: string): TriageDecision {
  if (!ctx.patientId) {
    throw new Error('patient_id_missing');
  }
  const score = typeof ctx.score === 'number' && Number.isFinite(ctx.score) ? ctx.score : 0;
  const priority = ctx.priority ?? determinePriority(ctx.config, score, ctx.features);
  const decision: TriageDecision = {
    patientId: ctx.patientId,
    score,
    priority,
    generatedAt,
  };

  const rawReasons = ctx.decisionReasons
    ?.map((code) => (typeof code === 'string' ? code.trim().toLowerCase() : ''))
    .filter((code) => code.length > 0 && /^[a-z0-9_.-]{1,64}$/.test(code))
    .slice(0, 10);
  if (rawReasons && rawReasons.length > 0) {
    decision.reasons = rawReasons as TriageDecision['reasons'];
  }

  return decision;
}

interface QueueNotificationPayload {
  taskId: string;
  patientId: string;
  priority: PriorityCode;
  createdAt: string;
}

async function notifyQueue(ctx: TriageContext, payload: QueueNotificationPayload): Promise<void> {
  if (!ctx.queueNotifier) {
    logger.info('queue notifier not configured; skipping', {
      component: 'triage',
      taskRef: safeTaskReference(payload.taskId),
      patientRef: safePatientReference(payload.patientId),
      patientIdPresent: Boolean(payload.patientId),
      correlationId: ctx.correlationId,
    });
    return;
  }

  const queue = ctx.queueName || ctx.taskOwner || 'triage.default';
  const span = startSpan('triage.notify');
  const startedAt = Date.now();
  const baseAttributes = { queue };
  let notifyError: unknown;

  try {
    await ctx.queueNotifier.notify(queue, payload);
    notifySuccessCounter.add(1, metricAttributes(ctx, { ...baseAttributes, outcome: 'success' }));
    logger.info('triage.notify.success', {
      component: 'triage',
      queue,
      correlationId: ctx.correlationId,
      taskRef: safeTaskReference(payload.taskId),
      patientRef: safePatientReference(payload.patientId),
    });
  } catch (error) {
    notifyError = error;
    const reason = error instanceof Error ? error.message : String(error);
    notifyErrorCounter.add(1, metricAttributes(ctx, { ...baseAttributes, outcome: 'error', reason }));
    logger.error('triage.notify.failed', {
      component: 'triage',
      queue,
      reason,
      correlationId: ctx.correlationId,
      taskRef: safeTaskReference(payload.taskId),
      patientRef: safePatientReference(payload.patientId),
    });
    throw error;
  } finally {
    const duration = Date.now() - startedAt;
    notifyDurationHistogram.record(
      duration,
      metricAttributes(ctx, { ...baseAttributes, outcome: notifyError ? 'error' : 'success' }),
    );
    if (span.isRecording()) {
      span.setAttribute('triage.notify.queue', queue);
      span.setAttribute('triage.notify.outcome', notifyError ? 'error' : 'success');
    }
    endSpan(span, notifyError);
  }
}

async function ensureAssignmentConsent(
  ctx: TriageContext,
  correlationId: string | undefined,
  bus: MessageBus,
): Promise<void> {
  if (!ctx.consentEvaluator || !ctx.patientId) {
    return;
  }
  const decision = await ctx.consentEvaluator.check({
    patientId: ctx.patientId,
    correlationId,
    purpose: 'triage.assignment',
  });
  if (decision.allowed) {
    return;
  }
  const reason = decision.reason ?? 'consent_denied';
  logger.warn('triage.assignment.consent_denied', {
    component: 'triage',
    correlationId,
    reason,
  });
  await publishConsentAudit(bus, ctx.patientId, correlationId, reason, decision.auditDetails);
  const error = Object.assign(new Error('consent_denied'), { code: 'consent_denied' });
  throw error;
}

async function publishConsentAudit(
  bus: MessageBus,
  patientId: string,
  correlationId: string | undefined,
  reason: string,
  details?: Record<string, unknown>,
): Promise<void> {
  const payload: AuditEvent = {
    type: 'triage.assignment.denied',
    ts: new Date().toISOString(),
    correlationId: correlationId ?? null,
    subjectRef: safePatientReference(patientId),
    outcome: 'deny',
    reasonCode: reason,
    details: details ?? null,
  };

  try {
    const envelope = createEnvelope(Topics.audit.event, payload, correlationId);
    const headers: Record<string, string> = {
      'x-message-id': envelope.id,
      'x-idempotency-key': `audit:${envelope.id}`,
    };
    if (correlationId) {
      headers['x-correlation-id'] = correlationId;
    }
    await bus.publish(Topics.audit.event, envelope, headers);
  } catch (error) {
    logger.warn('triage.assignment.audit_publish_failed', {
      component: 'triage',
      correlationId,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

function deriveTriageIdempotencyKey(ctx: TriageContext): string {
  const patientId = ctx.patientId ?? 'unknown-patient';
  const correlation = ctx.correlationId ?? ctx.id;
  return `triage:task:${patientId}:${correlation}`;
}

function resolveTriageIdempotencyTtl(ctx: TriageContext): number {
  const ttl = ctx.idempotencyTtlSeconds;
  return typeof ttl === 'number' && Number.isFinite(ttl) && ttl > 0 ? ttl : DEFAULT_TRIAGE_IDEMPOTENCY_TTL_SECONDS;
}

function ensureTriageBus(ctx: TriageContext): MessageBus {
  if (!ctx.bus) {
    throw new Error('bus_missing');
  }
  const guarded = withMessageGuards(ctx.bus, { allowedTopics: TRIAGE_ALLOWED_TOPICS });
  ctx.bus = guarded;
  return guarded;
}

function normalizeCorrelationId(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function ensureCorrelationId(ctx: TriageContext): string | undefined {
  const normalized = normalizeCorrelationId(ctx.correlationId);
  ctx.correlationId = normalized;
  return normalized;
}
