import { BaseState } from '@onecare/statekit';
import type { MachineContext, MachineEvent } from '@onecare/statekit';
import type { ResolvedConfig } from '@onecare/config';
import { computeTriageScore, type TriageFeatureVector } from './scoring';

export interface TriageContext extends MachineContext {
  config: ResolvedConfig;
  features: TriageFeatureVector;
  patientId?: string;
  narrative?: string;
  now?: number;
  score?: number;
  isDuplicate?: boolean;
}

export interface TriageEvent extends MachineEvent {
  type: 'triage.evaluate' | string;
}

interface DedupEntry {
  narrative: string;
  timestamp: number;
}

const dedupCache = new Map<string, DedupEntry[]>();

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

    if (windowMs > 0 && threshold > 0 && patientId && narrative) {
      const entries = dedupCache.get(patientId) ?? [];
      const freshEntries = entries.filter((entry) => now - entry.timestamp <= windowMs);
      const duplicateEntry = freshEntries.find(
        (entry) => similarity(entry.narrative, narrative) >= threshold,
      );

      if (duplicateEntry) {
        ctx.isDuplicate = true;
      } else {
        freshEntries.push({ narrative, timestamp: now });
      }

      dedupCache.set(patientId, freshEntries);
    }

    ctx.score = computeTriageScore(ctx.config, ctx.features ?? {});
    return 'Scored';
  }
}

export class ScoredState extends BaseState<TriageContext, TriageEvent> {
  constructor() {
    super('Scored');
  }

  async handle(_ctx: TriageContext, _evt: TriageEvent): Promise<string> {
    return 'TaskCreated';
  }
}

export class TaskCreatedState extends BaseState<TriageContext, TriageEvent> {
  constructor() {
    super('TaskCreated');
  }

  async handle(_ctx: TriageContext, _evt: TriageEvent): Promise<string> {
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
