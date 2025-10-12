import { BaseState } from '@onecare/statekit';
import type { MachineContext, MachineEvent } from '@onecare/statekit';
import type { ResolvedConfig } from '@onecare/config';
import { logger } from '@onecare/observability';
import type { FhirRepository, FhirResourceRef, QueueNotifier } from '@onecare/ports';
import { createTaskResource } from '@onecare/ports';
import type { MessageBus } from '@onecare/bus';
import { Topics, createEnvelope } from '@onecare/events';
import { computeTriageScore, type TriageFeatureVector } from './scoring';

export interface TriageContext extends MachineContext {
  config: ResolvedConfig;
  features: TriageFeatureVector;
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

interface DedupEntry {
  narrative: string;
  timestamp: number;
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

const dedupCache = new Map<string, DedupEntry[]>();
const DEDUP_CACHE_LIMIT = 50;

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

function normalizeTokens(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .split(/\W+/)
      .map((token) => token.trim())
      .filter((token) => token.length > 0),
  );
}

function similarity(a: string, b: string): number {
  const tokensA = normalizeTokens(a);
  const tokensB = normalizeTokens(b);
  if (tokensA.size === 0 && tokensB.size === 0) return 1;
  let intersection = 0;
  for (const token of tokensA) {
    if (tokensB.has(token)) {
      intersection += 1;
    }
  }
  const union = tokensA.size + tokensB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function getNow(ctx: TriageContext): number {
  return typeof ctx.now === 'number' ? ctx.now : Date.now();
}

export function resetDedupCache(): void {
  dedupCache.clear();
}

function pruneDedupCache(windowMs: number, now: number): void {
  if (windowMs <= 0) {
    dedupCache.clear();
    return;
  }
  for (const [patientId, entries] of dedupCache.entries()) {
    const fresh = entries.filter((entry) => now - entry.timestamp <= windowMs);
    if (fresh.length === 0) {
      dedupCache.delete(patientId);
    } else {
      dedupCache.set(patientId, fresh);
    }
  }
}

function trimEntries(entries: DedupEntry[], limit: number): DedupEntry[] {
  if (entries.length <= limit) return entries;
  return entries.slice(entries.length - limit);
}

export class IntakeState extends BaseState<TriageContext, TriageEvent> {
  constructor() {
    super('Intake');
  }

  async handle(ctx: TriageContext, _evt: TriageEvent): Promise<string> {
    const windowMs = getDedupWindowMs(ctx.config);
    const threshold = getSimilarityThreshold(ctx.config);
    const patientId = ctx.patientId?.trim();
    const narrative = ctx.narrative?.trim();
    const now = getNow(ctx);

    pruneDedupCache(windowMs, now);

    let duplicateSimilarity: number | undefined;
    if (windowMs > 0 && threshold > 0 && patientId && narrative) {
      const entries = dedupCache.get(patientId) ?? [];
      const freshEntries = entries.filter((entry) => now - entry.timestamp <= windowMs);
      const duplicateEntry = freshEntries.find((entry) => {
        const score = similarity(entry.narrative, narrative);
        if (score >= threshold) {
          duplicateSimilarity = score;
          return true;
        }
        return false;
      });

      if (duplicateEntry) {
        ctx.isDuplicate = true;
        ctx.duplicateDetectedAt = now;
        ctx.duplicateWindowMs = windowMs;
        ctx.duplicateSimilarity = duplicateSimilarity;
        ctx.duplicateReference = duplicateEntry;
      }

      const updatedEntries = trimEntries([...freshEntries, { narrative, timestamp: now }], DEDUP_CACHE_LIMIT);
      dedupCache.set(patientId, updatedEntries);
    }

    if (ctx.isDuplicate) {
      return 'Duplicate';
    }

    ctx.score = computeTriageScore(ctx.config, ctx.features ?? {});
    return 'Scored';
  }
}

export class ScoredState extends BaseState<TriageContext, TriageEvent> {
  constructor() {
    super('Scored');
  }

  async handle(ctx: TriageContext, _evt: TriageEvent): Promise<string> {
    const score = typeof ctx.score === 'number' ? ctx.score : 0;
    ctx.priority = determinePriority(ctx.config, score);
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
    if (!ctx.bus) {
      throw new Error('bus_missing');
    }
    if (!ctx.patientId) {
      throw new Error('patient_id_missing');
    }

    const score = typeof ctx.score === 'number' ? ctx.score : 0;
    const priority = ctx.priority ?? determinePriority(ctx.config, score);
    ctx.priority = priority;

    const timestamp = new Date().toISOString();
    const taskResource = buildTaskResource(ctx, priority, timestamp);
    const reference = await createTaskResource(ctx.fhirRepository, taskResource);

    ctx.taskReference = reference;
    ctx.taskId = reference.id;
    ctx.taskCreatedAt = timestamp;

    const payload: TaskCreatedEvent = {
      taskId: reference.id,
      patientId: ctx.patientId,
      priority,
      owner: ctx.taskOwner,
    };
    const envelope = createEnvelope(Topics.tasks.created, payload, ctx.correlationId);
    const headers = ctx.correlationId ? { 'x-correlation-id': ctx.correlationId } : undefined;
    await ctx.bus.publish(Topics.tasks.created, envelope, headers);
    ctx.taskEventPublished = true;

    await notifyQueue(ctx, {
      taskId: reference.id,
      patientId: ctx.patientId,
      priority,
      createdAt: timestamp,
    });

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
  return dedupCache.size;
}

export function getDedupCacheEntryCountForTest(patientId: string): number {
  return dedupCache.get(patientId)?.length ?? 0;
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

export function determinePriority(config: ResolvedConfig, score: number): PriorityCode {
  const raw = (config.priority_thresholds as Record<string, unknown> | undefined) ?? {};
  const thresholds = {
    STAT: sanitizeNumber(raw.stat, 0.9),
    URGENT: sanitizeNumber(raw.urgent, 0.7),
    SOON: sanitizeNumber(raw.soon, 0.4),
    ROUTINE: sanitizeNumber(raw.routine, 0),
  };

  if (score >= thresholds.STAT) return 'STAT';
  if (score >= thresholds.URGENT) return 'URGENT';
  if (score >= thresholds.SOON) return 'SOON';
  return 'ROUTINE';
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
