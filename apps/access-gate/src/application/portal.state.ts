import { createCounter, logger } from '@onecare/observability';
import type { DeferralRecord, DeferralStore } from '@onecare/ports';
import type { ResolvedConfig } from '@onecare/config';

const DEFAULT_TIME_ZONE = 'Europe/London';
const DEFAULT_OOH_MESSAGE =
  'Outside core hours. For urgent medical help, contact NHS 111 (24/7) or call 999 in an emergency.';
const TTL_BUFFER_MS = 10 * 60 * 1000; // 10 minutes grace

export interface CoreHours {
  start: string;
  end: string;
}

export interface OohPolicy {
  accept_submissions?: boolean;
  patient_message?: string;
}

export interface PortalState {
  portalOpen: boolean;
  acceptsSubmissions: boolean;
  bannerMessage?: string;
}

export type PortalIntent =
  | { type: 'OPEN_PORTAL' }
  | { type: 'CLOSE_PORTAL' }
  | { type: 'SET_SUBMISSION_MODE'; acceptsSubmissions: boolean }
  | { type: 'SET_BANNER'; message: string }
  | { type: 'CLEAR_BANNER' };

export type PortalDecisionReason = 'within_hours' | 'outside_hours' | 'config_missing' | 'config_invalid';

export interface EnsurePortalContext {
  now: Date;
  timeZone?: string;
  coreHours?: CoreHours;
  policy?: OohPolicy;
  currentState?: PortalState;
}

export interface PortalDecision {
  reason: PortalDecisionReason;
  desiredState: PortalState;
  intents: PortalIntent[];
  changed: boolean;
  localDateTime: ZonedDateTime;
}

export interface ZonedDateTime {
  minutesOfDay: number;
  isoDate: string;
}

const DEFAULT_PORTAL_STATE: PortalState = {
  portalOpen: true,
  acceptsSubmissions: true,
};

const TIME_PARTS_FORMATTER = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export function ensurePortalState(context: EnsurePortalContext): PortalDecision {
  const timeZone = normaliseTimeZone(context.timeZone);
  const parsedCoreHours = parseCoreHours(context.coreHours);
  if (!parsedCoreHours) {
    return {
      reason: context.coreHours ? 'config_invalid' : 'config_missing',
      desiredState: cloneState(context.currentState ?? DEFAULT_PORTAL_STATE),
      intents: [],
      changed: false,
      localDateTime: getZonedDateTime(context.now, timeZone),
    };
  }

  const localDateTime = getZonedDateTime(context.now, timeZone);
  const withinHours = isWithinCoreHours(localDateTime.minutesOfDay, parsedCoreHours);
  const desiredState = buildDesiredState(withinHours, context.policy);
  const currentState = context.currentState ?? DEFAULT_PORTAL_STATE;
  const intents = computeIntents(currentState, desiredState);

  return {
    reason: withinHours ? 'within_hours' : 'outside_hours',
    desiredState,
    intents,
    changed: intents.length > 0,
    localDateTime,
  };
}

function buildDesiredState(withinHours: boolean, policy?: OohPolicy): PortalState {
  const acceptSubmissions = !!policy?.accept_submissions;
  const bannerMessage = policy?.patient_message?.trim() || DEFAULT_OOH_MESSAGE;

  if (withinHours) {
    return {
      portalOpen: true,
      acceptsSubmissions: true,
    };
  }

  return {
    portalOpen: acceptSubmissions,
    acceptsSubmissions: acceptSubmissions,
    bannerMessage,
  };
}

function computeIntents(current: PortalState, desired: PortalState): PortalIntent[] {
  const intents: PortalIntent[] = [];

  if (current.portalOpen !== desired.portalOpen) {
    intents.push({ type: desired.portalOpen ? 'OPEN_PORTAL' : 'CLOSE_PORTAL' });
  }
  if (current.acceptsSubmissions !== desired.acceptsSubmissions) {
    intents.push({ type: 'SET_SUBMISSION_MODE', acceptsSubmissions: desired.acceptsSubmissions });
  }
  const currentBanner = current.bannerMessage?.trim() || undefined;
  const desiredBanner = desired.bannerMessage?.trim() || undefined;
  if (desiredBanner && desiredBanner !== currentBanner) {
    intents.push({ type: 'SET_BANNER', message: desiredBanner });
  } else if (!desiredBanner && currentBanner) {
    intents.push({ type: 'CLEAR_BANNER' });
  }
  return intents;
}

function parseCoreHours(coreHours?: CoreHours): ParsedCoreHours | undefined {
  if (!coreHours) return undefined;
  const start = parseTimeToMinutes(coreHours.start);
  const end = parseTimeToMinutes(coreHours.end);
  if (start === undefined || end === undefined) {
    return undefined;
  }
  return { startMinutes: start, endMinutes: end };
}

interface ParsedCoreHours {
  startMinutes: number;
  endMinutes: number;
}

function parseTimeToMinutes(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return undefined;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return undefined;
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return undefined;
  return hours * 60 + minutes;
}

function isWithinCoreHours(minutesOfDay: number, hours: ParsedCoreHours): boolean {
  const { startMinutes, endMinutes } = hours;
  if (startMinutes === endMinutes) {
    // Treat as always open if start and end coincide (24h service).
    return true;
  }
  if (startMinutes < endMinutes) {
    return minutesOfDay >= startMinutes && minutesOfDay < endMinutes;
  }
  // Overnight window (e.g., 22:00 - 06:00)
  return minutesOfDay >= startMinutes || minutesOfDay < endMinutes;
}

function normaliseTimeZone(timeZone?: string): string {
  if (typeof timeZone === 'string' && timeZone.trim().length > 0) {
    return timeZone.trim();
  }
  return DEFAULT_TIME_ZONE;
}

function getZonedDateTime(now: Date, timeZone: string): ZonedDateTime {
  const formatter = TIME_PARTS_FORMATTER.resolvedOptions().timeZone === timeZone
    ? TIME_PARTS_FORMATTER
    : new Intl.DateTimeFormat('en-GB', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        timeZone,
      });

  const parts = formatter.formatToParts(now);
  const hour = parseInt(parts.find((p) => p.type === 'hour')?.value ?? '0', 10);
  const minute = parseInt(parts.find((p) => p.type === 'minute')?.value ?? '0', 10);
  const year = parts.find((p) => p.type === 'year')?.value ?? '1970';
  const month = parts.find((p) => p.type === 'month')?.value ?? '01';
  const day = parts.find((p) => p.type === 'day')?.value ?? '01';
  const minutesOfDay = hour * 60 + minute;
  const isoDate = `${year}-${month}-${day}`;
  return { minutesOfDay, isoDate };
}

function cloneState(state: PortalState): PortalState {
  return {
    portalOpen: state.portalOpen,
    acceptsSubmissions: state.acceptsSubmissions,
    bannerMessage: state.bannerMessage,
  };
}

const deferralEnqueueCounter = createCounter('deferral.enqueue');

export interface OutOfHoursSubmission {
  practiceId: string;
  submissionId: string;
  summaryCode: string;
  receivedAt: Date;
  config: ResolvedConfig;
  store: DeferralStore;
  correlationId?: string;
  now?: Date;
}

export interface EnqueueOutcome {
  enqueued: boolean;
  record?: DeferralRecord;
  deferUntilIso?: string;
}

export async function enqueueOutOfHoursSubmission(ctx: OutOfHoursSubmission): Promise<EnqueueOutcome> {
  const now = ctx.now ?? ctx.receivedAt;
  const timeZone = normaliseTimeZone((ctx.config as Record<string, unknown>).timezone as string | undefined);
  const coreHours = parseCoreHours(ctx.config.core_hours as CoreHours | undefined);
  const policy = (ctx.config as Record<string, unknown>).ooh_policy as OohPolicy | undefined;

  if (!coreHours || !policy?.accept_submissions) {
    return { enqueued: false };
  }

  const decision = ensurePortalState({
    now,
    timeZone,
    coreHours: ctx.config.core_hours as CoreHours,
    policy,
  });

  if (decision.reason !== 'outside_hours' || !policy.accept_submissions) {
    return { enqueued: false };
  }

  const deltaMinutes = minutesUntilNextStart(decision.localDateTime.minutesOfDay, coreHours);
  const deferUntilDate = addMinutes(now, deltaMinutes);
  const ttlMs = Math.max(deltaMinutes * 60 * 1000 + TTL_BUFFER_MS, TTL_BUFFER_MS);
  const record = buildDeferralRecord(ctx, deferUntilDate.toISOString());

  await ctx.store.enqueue(record, ttlMs);
  deferralEnqueueCounter.add(1, { practiceId: ctx.practiceId });
  logger.info('portal.deferral.enqueued', {
    practiceId: ctx.practiceId,
    submissionId: ctx.submissionId,
    correlationId: ctx.correlationId,
    deferUntil: record.deferUntil,
  });

  return { enqueued: true, record, deferUntilIso: record.deferUntil };
}

function buildDeferralRecord(ctx: OutOfHoursSubmission, deferUntilIso: string): DeferralRecord {
  const createdAtIso = ctx.receivedAt.toISOString();
  return {
    id: `${ctx.practiceId}:${ctx.submissionId}`,
    practiceId: ctx.practiceId,
    submissionId: ctx.submissionId,
    createdAt: createdAtIso,
    summaryCode: ctx.summaryCode,
    deferUntil: deferUntilIso,
  };
}

function minutesUntilNextStart(minutesOfDay: number, hours: ParsedCoreHours): number {
  if (hours.startMinutes === hours.endMinutes) {
    return 24 * 60;
  }
  let delta = (hours.startMinutes - minutesOfDay + 1440) % 1440;
  if (delta === 0) {
    delta = 24 * 60;
  }
  return delta;
}

function addMinutes(base: Date, minutes: number): Date {
  return new Date(base.getTime() + minutes * 60 * 1000);
}

export interface DeferralFlushContext {
  practiceId: string;
  correlationId: string;
  records: DeferralRecord[];
}
