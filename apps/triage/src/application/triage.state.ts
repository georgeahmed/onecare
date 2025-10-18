import { BaseState } from '@onecare/statekit';
import type { MachineContext, MachineEvent } from '@onecare/statekit';
import type { ResolvedConfig } from '@onecare/config';
import { logger, ensureTracing } from '@onecare/observability';
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
import { Topics, createEnvelope, type TriageDecision, type TriageInput } from '@onecare/events';
import { computeTriageScore, type TriageFeatureVector } from './scoring';
import { extractFeatures } from './features';
import { createDedupStore, type DedupEntry } from './dedup';
import type { TextNormalizeOptions } from './text-normalize';
import { assertValidTriageDecision, assertValidTriageInput } from './contracts';
import { logFeatureVector } from '../featuresHook';
import { callWithGuard } from './guard';

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
}

export interface TriageEvent extends MachineEvent {
  type: 'triage.evaluate' | string;
}

type PriorityCode = 'STAT' | 'URGENT' | 'SOON' | 'ROUTINE';

interface TaskCreatedEvent {
  taskId: string;
  patientId: string;
  priority: PriorityCode;
  owner?: string;
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

ensureTracing('triage');

const TRIAGE_TASKS_CREATED_TOPIC = Topics.tasks.created;
const TRIAGE_DECISION_TOPIC = (Topics.triage as { decision?: string } | undefined)?.decision ?? 'triage.decision';
const TRIAGE_ALLOWED_TOPICS = new Set<string>([TRIAGE_TASKS_CREATED_TOPIC, TRIAGE_DECISION_TOPIC]);
const DEDUP_CACHE_LIMIT = 50;
const dedupStore = createDedupStore({ maxEntriesPerPatient: DEDUP_CACHE_LIMIT });
const DEFAULT_TRIAGE_IDEMPOTENCY_TTL_SECONDS = 10 * 60;

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

    const decision = dedupStore.evaluate({
      patientId,
      narrative,
      now,
      windowMs,
      threshold,
      shingleSize: getDedupShingleSize(ctx.config),
      textOptions: getDedupTextOptions(ctx.config),
    });

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
    ctx.score = computeTriageScore(ctx.config, normalizedFeatures);
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
        } catch (error) {
          const mapped = classifyFhirTaskError(error);
          logger.error('triage.fhir_task.failed', {
            code: mapped.code,
            message: mapped.message,
            correlationId,
          });
          throw mapped;
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
          owner: ctx.taskOwner,
        };
        const envelope = createEnvelope(TRIAGE_TASKS_CREATED_TOPIC, payload, correlationId);
        const headers = correlationId ? { 'x-correlation-id': correlationId } : undefined;
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
          key: idempotencyKey,
          patientId: ctx.patientId,
          taskId: reference.id,
          correlationId,
        });
        return true;
      },
      onDuplicate: () => {
        logger.warn('triage.idempotency.duplicate', {
          key: idempotencyKey,
          patientId: ctx.patientId,
          correlationId,
        });
      },
      onError: (error) => {
        logger.error('triage.idempotency.failed', {
          key: idempotencyKey,
          patientId: ctx.patientId,
          correlationId,
          reason: error instanceof Error ? error.message : 'unknown_error',
        });
      },
    });

    if (status === 'skipped') {
      return 'Notified';
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
        hasPatientId: Boolean(details.patientId),
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
  const raw = (config.priority_thresholds as Record<string, unknown> | undefined) ?? {};
  const thresholds = {
    STAT: sanitizeNumber(raw.stat, 0.9),
    URGENT: sanitizeNumber(raw.urgent, 0.7),
    SOON: sanitizeNumber(raw.soon, 0.4),
    ROUTINE: sanitizeNumber(raw.routine, 0),
  };

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

  const normalizedReasons =
    ctx.decisionReasons
      ?.map((code) => (typeof code === 'string' ? code.trim().toLowerCase() : ''))
      .filter((code) => code.length > 0 && /^[a-z0-9_.-]{1,64}$/.test(code))
      .slice(0, 10) ?? [];
  if (normalizedReasons.length > 0) {
    decision.reasons = normalizedReasons as [string, ...string[]];
  }

  if (ctx.isDuplicate && ctx.duplicateReference) {
    decision.duplicateOf = `${ctx.patientId}:${ctx.duplicateReference.timestamp}`;
  }

  const featureEntries = Object.entries(ctx.features ?? {}).filter(
    ([, value]) => typeof value === 'number' && Number.isFinite(value),
  );
  if (featureEntries.length > 0) {
    decision.features = Object.fromEntries(featureEntries);
  }

  if (ctx.taskOwner || ctx.queueName) {
    decision.assignment = {};
    if (ctx.taskOwner) {
      decision.assignment.owner = ctx.taskOwner;
    }
    if (ctx.queueName) {
      decision.assignment.team = ctx.queueName;
    }
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
      taskId: payload.taskId,
      patientIdPresent: Boolean(payload.patientId),
    });
    return;
  }

  const queue = ctx.queueName || ctx.taskOwner || 'triage.default';
  await ctx.queueNotifier.notify(queue, payload);
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
