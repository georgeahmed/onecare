export interface RawEnhancedAccessWindow {
  name?: string;
  days?: number[];
  start?: string;
  end?: string;
}

export interface RawEnhancedAccessConfig {
  timezone?: string;
  windows?: RawEnhancedAccessWindow[];
}

export interface EnhancedAccessWindow {
  name: string;
  days: number[];
  startMinutes: number;
  endMinutes: number;
}

export interface EnhancedAccessConfig {
  timezone: string;
  windows: EnhancedAccessWindow[];
}

const DEFAULT_ENHANCED_ACCESS_CONFIG: EnhancedAccessConfig = {
  timezone: 'Europe/London',
  windows: [
    {
      name: 'weekdays_evening',
      days: [1, 2, 3, 4, 5],
      startMinutes: 18 * 60 + 30,
      endMinutes: 20 * 60 + 30,
    },
    {
      name: 'saturday',
      days: [6],
      startMinutes: 9 * 60,
      endMinutes: 12 * 60,
    },
  ],
};

function parseJson(value: string | undefined): unknown {
  if (!value) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function clampDay(value: number): number | undefined {
  if (!Number.isFinite(value)) return undefined;
  const normalized = Math.trunc(value);
  if (normalized < 1 || normalized > 7) return undefined;
  return normalized;
}

function parseDays(values: number[] | undefined): number[] {
  if (!Array.isArray(values) || values.length === 0) return [];
  const unique = new Set<number>();
  for (const value of values) {
    const day = clampDay(value);
    if (day !== undefined) {
      unique.add(day);
    }
  }
  return Array.from(unique).sort((a, b) => a - b);
}

function parseTime(value: string | undefined): number | undefined {
  if (!value || typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  const match = trimmed.match(/^(\d{2}):(\d{2})$/);
  if (!match) return undefined;
  const [, hh, mm] = match;
  const hours = Number.parseInt(hh, 10);
  const minutes = Number.parseInt(mm, 10);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return undefined;
  if (hours < 0 || hours > 23) return undefined;
  if (minutes < 0 || minutes > 59) return undefined;
  return hours * 60 + minutes;
}

function normalizeWindow(input: RawEnhancedAccessWindow | undefined): EnhancedAccessWindow | undefined {
  if (!input) return undefined;
  const days = parseDays(input.days);
  const startMinutes = parseTime(input.start);
  const endMinutes = parseTime(input.end);
  if (days.length === 0 || startMinutes === undefined || endMinutes === undefined) {
    return undefined;
  }
  if (endMinutes <= startMinutes) {
    return undefined;
  }
  const name = typeof input.name === 'string' && input.name.trim().length > 0 ? input.name.trim() : 'enhanced_access';
  return { name, days, startMinutes, endMinutes };
}

function normalizeConfig(raw: RawEnhancedAccessConfig | undefined): EnhancedAccessConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const timezone =
    typeof raw.timezone === 'string' && raw.timezone.trim().length > 0 ? raw.timezone.trim() : 'UTC';
  const rawWindows = Array.isArray(raw.windows) ? raw.windows : [];
  const windows: EnhancedAccessWindow[] = [];
  for (const candidate of rawWindows) {
    const normalized = normalizeWindow(candidate);
    if (normalized) {
      windows.push(normalized);
    }
  }
  if (windows.length === 0) return undefined;
  return { timezone, windows };
}

export function resolveEnhancedAccessConfig(env: Record<string, string | undefined>): EnhancedAccessConfig {
  const parsed = parseJson(env.VITE_ENHANCED_ACCESS_WINDOWS) as RawEnhancedAccessConfig | undefined;
  const normalized = normalizeConfig(parsed);
  return normalized ?? DEFAULT_ENHANCED_ACCESS_CONFIG;
}

export function getEnhancedAccessConfig(): EnhancedAccessConfig {
  const env = (import.meta as unknown as { env: Record<string, string | undefined> }).env ?? {};
  return resolveEnhancedAccessConfig(env);
}

export function minutesToTimeLabel(minutes: number): string {
  const clamped = Math.max(0, Math.min(23 * 60 + 59, Math.floor(minutes)));
  const hours = Math.floor(clamped / 60);
  const mins = clamped % 60;
  const paddedHours = hours.toString().padStart(2, '0');
  const paddedMinutes = mins.toString().padStart(2, '0');
  return `${paddedHours}:${paddedMinutes}`;
}

export function dayIndexToLabel(day: number): string {
  const labels: Record<number, string> = {
    1: 'Monday',
    2: 'Tuesday',
    3: 'Wednesday',
    4: 'Thursday',
    5: 'Friday',
    6: 'Saturday',
    7: 'Sunday',
  };
  return labels[day] ?? 'Day';
}
