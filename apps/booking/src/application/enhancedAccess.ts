import type { ResolvedConfig } from '@onecare/config';
import type { SlotView } from '../adapters/gpconnect.client';

export interface EnhancedAccessWindow {
  name: string;
  days: number[]; // 1 (Mon) -> 7 (Sun)
  startMinutes: number;
  endMinutes: number;
}

export interface EnhancedAccessFairness {
  maxPerOrganisation?: number;
}

export interface EnhancedAccessPolicy {
  timezone: string;
  windows: EnhancedAccessWindow[];
  allowedSlotTypes: string[];
  fairness: EnhancedAccessFairness;
}

export interface RejectedSlot {
  slot: SlotView;
  reasons: string[];
}

export interface FilteredSlotsResult {
  accepted: SlotView[];
  rejected: RejectedSlot[];
}

interface RawWindow {
  name?: string;
  days?: number[];
  start?: string;
  end?: string;
}

interface RawFairness {
  max_per_organisation?: number;
}

function parseTimeToMinutes(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = value.match(/^(\d{2}):(\d{2})$/);
  if (!match) return undefined;
  const [, hh, mm] = match;
  const hours = Number(hh);
  const minutes = Number(mm);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return undefined;
  return hours * 60 + minutes;
}

function normalizeWindow(input: RawWindow): EnhancedAccessWindow | undefined {
  const name = input.name ?? 'window';
  const days = Array.isArray(input.days) && input.days.length > 0 ? input.days.filter((d) => d >= 1 && d <= 7) : undefined;
  const start = parseTimeToMinutes(input.start);
  const end = parseTimeToMinutes(input.end);
  if (!days || start === undefined || end === undefined) return undefined;
  return { name, days, startMinutes: start, endMinutes: end };
}

function uniqueStrings(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) {
      seen.add(value.trim());
    }
  }
  return Array.from(seen);
}

export function loadEnhancedAccessPolicy(config: ResolvedConfig): EnhancedAccessPolicy | undefined {
  const raw = (config.enhanced_access ?? config.enhancedAccess) as Record<string, unknown> | undefined;
  if (!raw) return undefined;
  const timezone = typeof raw.timezone === 'string' && raw.timezone.trim().length > 0 ? raw.timezone.trim() : 'UTC';
  const rawWindows = Array.isArray(raw.windows) ? raw.windows : [];
  const windows: EnhancedAccessWindow[] = [];
  for (const candidate of rawWindows) {
    const normalized = normalizeWindow(candidate as RawWindow);
    if (normalized) windows.push(normalized);
  }
  if (windows.length === 0) return undefined;

  const allowedSlotTypes = uniqueStrings(raw.allowed_slot_types ?? raw.allowedSlotTypes);
  const fairnessRaw = raw.fairness as RawFairness | undefined;
  const fairness: EnhancedAccessFairness = {};
  if (fairnessRaw && typeof fairnessRaw.max_per_organisation === 'number' && fairnessRaw.max_per_organisation > 0) {
    fairness.maxPerOrganisation = Math.floor(fairnessRaw.max_per_organisation);
  }

  return {
    timezone,
    windows,
    allowedSlotTypes,
    fairness,
  };
}

function getZonedDayAndMinutes(iso: string, timeZone: string): { day: number; minutes: number } | undefined {
  try {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return undefined;
    const formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    const parts = formatter.formatToParts(date);
    const weekdayPart = parts.find((part) => part.type === 'weekday');
    const hourPart = parts.find((part) => part.type === 'hour');
    const minutePart = parts.find((part) => part.type === 'minute');
    if (!weekdayPart || !hourPart || !minutePart) return undefined;
    const weekdayMap: Record<string, number> = {
      Mon: 1,
      Monday: 1,
      Tue: 2,
      Tuesday: 2,
      Wed: 3,
      Wednesday: 3,
      Thu: 4,
      Thursday: 4,
      Fri: 5,
      Friday: 5,
      Sat: 6,
      Saturday: 6,
      Sun: 7,
      Sunday: 7,
    };
    const day = weekdayMap[weekdayPart.value] ?? undefined;
    if (!day) return undefined;
    const minutes = Number(hourPart.value) * 60 + Number(minutePart.value);
    if (!Number.isFinite(minutes)) return undefined;
    return { day, minutes };
  } catch {
    return undefined;
  }
}

export function applyEnhancedAccessFilters(slots: SlotView[], policy: EnhancedAccessPolicy): FilteredSlotsResult {
  if (!Array.isArray(slots) || slots.length === 0) {
    return { accepted: [], rejected: [] };
  }

  const allowedTypes = new Set(policy.allowedSlotTypes.map((t) => t.toUpperCase()));
  const acceptedCandidates: SlotView[] = [];
  const rejected: RejectedSlot[] = [];

  for (const slot of slots) {
    const reasons: string[] = [];
    if (allowedTypes.size > 0) {
      const typeValue = slot.serviceType?.toUpperCase();
      if (!typeValue || !allowedTypes.has(typeValue)) {
        reasons.push('slot_type_not_allowed');
      }
    }

    const zoned = getZonedDayAndMinutes(slot.start, policy.timezone);
    if (!zoned) {
      reasons.push('invalid_start_time');
    } else {
      const withinWindow = policy.windows.some((window) => {
        if (!window.days.includes(zoned.day)) return false;
        return zoned.minutes >= window.startMinutes && zoned.minutes <= window.endMinutes;
      });
      if (!withinWindow) {
        reasons.push('outside_window');
      }
    }

    if (reasons.length === 0) {
      acceptedCandidates.push(slot);
    } else {
      rejected.push({ slot, reasons });
    }
  }

  const accepted: SlotView[] = [];
  const fairnessRejections: RejectedSlot[] = [];

  if (acceptedCandidates.length > 0) {
    const sorted = [...acceptedCandidates].sort((a, b) => a.start.localeCompare(b.start));
    const counter = new Map<string, number>();
    const maxPerOrg = policy.fairness.maxPerOrganisation ?? Infinity;
    for (const slot of sorted) {
      const key = slot.organisationId ?? 'unknown';
      const count = counter.get(key) ?? 0;
      if (count >= maxPerOrg) {
        fairnessRejections.push({ slot, reasons: ['fairness_max_per_org'] });
        continue;
      }
      counter.set(key, count + 1);
      accepted.push(slot);
    }
  }

  return {
    accepted,
    rejected: [...rejected, ...fairnessRejections],
  };
}
