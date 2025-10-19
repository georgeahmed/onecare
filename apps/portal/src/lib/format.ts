const PREFERENCES_STORAGE_KEY = 'onecare.portal.preferences';

export type HourCyclePreference = 'h11' | 'h12' | 'h23' | 'h24';

export interface LocalePreferences {
  locale: string;
  timeZone: string;
  hourCycle: HourCyclePreference;
  firstDayOfWeek: number;
}

export interface FormatDateOptions extends Intl.DateTimeFormatOptions {
  locale?: string;
  timeZone?: string;
}

export interface FormatTimeOptions extends FormatDateOptions {
  hourCycle?: HourCyclePreference;
}

export interface FormatNumberOptions extends Intl.NumberFormatOptions {
  locale?: string;
}

const ALLOWED_HOUR_CYCLES: ReadonlySet<HourCyclePreference> = new Set(['h11', 'h12', 'h23', 'h24']);
const DEFAULT_TIME_ZONE = 'UTC';
const DEFAULT_HOUR_CYCLE: HourCyclePreference = 'h12';
const DEFAULT_FIRST_DAY = 1;

type StoredPreferences = Partial<Pick<LocalePreferences, 'timeZone' | 'hourCycle' | 'firstDayOfWeek'>>;

type LocaleWeekInfoShim = {
  weekInfo?: {
    firstDay?: number;
  };
};

const hasBrowserStorage = (): boolean =>
  typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';

let storedPreferencesCache: StoredPreferences | null = null;

const normalizeHourCycle = (value: unknown): HourCyclePreference | undefined => {
  if (typeof value !== 'string') return undefined;
  return ALLOWED_HOUR_CYCLES.has(value as HourCyclePreference) ? (value as HourCyclePreference) : undefined;
};

const normalizeFirstDay = (value: unknown): number | undefined => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const normalized = Math.floor(value);
  if (normalized < 0 || normalized > 6) return undefined;
  return normalized;
};

const normalizeTimeZone = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const readStoredPreferences = (): StoredPreferences => {
  if (storedPreferencesCache) {
    return storedPreferencesCache;
  }
  if (!hasBrowserStorage()) {
    storedPreferencesCache = {};
    return storedPreferencesCache;
  }
  try {
    const raw = hasBrowserStorage() ? window.localStorage.getItem(PREFERENCES_STORAGE_KEY) : null;
    if (!raw) {
      storedPreferencesCache = {};
      return storedPreferencesCache;
    }
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      storedPreferencesCache = {};
      return storedPreferencesCache;
    }
    const candidate = parsed as Record<string, unknown>;
    const hourCycle = normalizeHourCycle(candidate.hourCycle);
    const firstDayOfWeek = normalizeFirstDay(candidate.firstDayOfWeek);
    const timeZone = normalizeTimeZone(candidate.timeZone);
    storedPreferencesCache = {
      ...(hourCycle ? { hourCycle } : {}),
      ...(firstDayOfWeek !== undefined ? { firstDayOfWeek } : {}),
      ...(timeZone ? { timeZone } : {})
    };
    return storedPreferencesCache;
  } catch {
    storedPreferencesCache = {};
    return storedPreferencesCache;
  }
};

const detectHourCycle = (locale: string): HourCyclePreference => {
  try {
    const resolvedOptions = new Intl.DateTimeFormat(locale, { hour: 'numeric' }).resolvedOptions() as {
      hourCycle?: string;
    };
    const resolved = resolvedOptions.hourCycle;
    return normalizeHourCycle(resolved) ?? DEFAULT_HOUR_CYCLE;
  } catch {
    return DEFAULT_HOUR_CYCLE;
  }
};

const detectTimeZone = (): string => {
  try {
    const resolved = new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' }).resolvedOptions().timeZone;
    return typeof resolved === 'string' && resolved.trim().length > 0 ? resolved : DEFAULT_TIME_ZONE;
  } catch {
    return DEFAULT_TIME_ZONE;
  }
};

const detectFirstDayOfWeek = (locale: string): number => {
  try {
    const intlWithLocale = Intl as typeof Intl & {
      Locale?: new (tag: string) => { weekInfo?: { firstDay?: number } };
    };
    if (typeof intlWithLocale.Locale !== 'function') {
      return DEFAULT_FIRST_DAY;
    }
    const localeInstance = new intlWithLocale.Locale(locale) as LocaleWeekInfoShim;
    const candidate = localeInstance.weekInfo?.firstDay;
    if (typeof candidate === 'number') {
      const zeroBased = candidate % 7;
      return normalizeFirstDay(zeroBased) ?? DEFAULT_FIRST_DAY;
    }
    return DEFAULT_FIRST_DAY;
  } catch {
    return DEFAULT_FIRST_DAY;
  }
};

export const resolveLocalePreferences = (
  locale: string,
  overrides: Partial<LocalePreferences> = {},
): LocalePreferences => {
  const stored = readStoredPreferences();
  const normalizedLocale = typeof locale === 'string' && locale.trim().length > 0 ? locale : 'en';
  const hourCycle =
    overrides.hourCycle ??
    stored.hourCycle ??
    detectHourCycle(normalizedLocale);
  const firstDayOfWeek =
    overrides.firstDayOfWeek ??
    stored.firstDayOfWeek ??
    detectFirstDayOfWeek(normalizedLocale);
  return {
    locale: normalizedLocale,
    hourCycle,
    firstDayOfWeek,
    timeZone: overrides.timeZone ?? stored.timeZone ?? detectTimeZone(),
  };
};

const toDate = (value: Date | string | number): Date | null => {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

const applyDateOptions = (
  options: FormatDateOptions,
  preferences: LocalePreferences,
): Intl.DateTimeFormatOptions => {
  const { locale: _locale, timeZone, ...rest } = options;
  return {
    ...rest,
    timeZone: timeZone ?? preferences.timeZone,
  };
};

export const formatDate = (input: Date | string | number, options: FormatDateOptions = {}): string => {
  const locale = options.locale ?? 'en';
  const preferences = resolveLocalePreferences(locale);
  const date = toDate(input);
  if (!date) return '';

  try {
    const formatter = new Intl.DateTimeFormat(preferences.locale, applyDateOptions(options, preferences));
    return formatter.format(date);
  } catch {
    return date.toISOString();
  }
};

export const formatTime = (input: Date | string | number, options: FormatTimeOptions = {}): string => {
  const locale = options.locale ?? 'en';
  const preferences = resolveLocalePreferences(locale);
  const date = toDate(input);
  if (!date) return '';

  const timeOptions = {
    timeStyle: 'short' as const,
    ...options,
    hourCycle: options.hourCycle ?? preferences.hourCycle,
  };

  try {
    const formatter = new Intl.DateTimeFormat(preferences.locale, applyDateOptions(timeOptions, preferences));
    return formatter.format(date);
  } catch {
    return date.toISOString();
  }
};

export const formatDateTime = (input: Date | string | number, options: FormatTimeOptions = {}): string => {
  const locale = options.locale ?? 'en';
  const preferences = resolveLocalePreferences(locale);
  const date = toDate(input);
  if (!date) return '';

  const dateTimeOptions: FormatTimeOptions = {
    dateStyle: 'medium',
    timeStyle: 'short',
    ...options,
  };

  try {
    const formatter = new Intl.DateTimeFormat(preferences.locale, {
      ...applyDateOptions(dateTimeOptions, preferences),
      hourCycle: dateTimeOptions.hourCycle ?? preferences.hourCycle,
    });
    return formatter.format(date);
  } catch {
    return date.toISOString();
  }
};

export const formatAccessibleDateTime = (
  input: Date | string | number,
  options: FormatTimeOptions = {},
): string => {
  const locale = options.locale ?? 'en';
  const preferences = resolveLocalePreferences(locale);
  const date = toDate(input);
  if (!date) return '';

  const accessibleOptions: FormatTimeOptions = {
    dateStyle: 'full',
    timeStyle: 'short',
    timeZoneName: 'long',
    ...options,
  };
  const timeZoneToUse = accessibleOptions.timeZone ?? preferences.timeZone;

  try {
    const formatter = new Intl.DateTimeFormat(preferences.locale, {
      ...applyDateOptions(accessibleOptions, preferences),
      hourCycle: accessibleOptions.hourCycle ?? preferences.hourCycle,
    });
    return formatter.format(date);
  } catch {
    const dateLabel = formatDate(date, {
      locale,
      timeZone: timeZoneToUse,
      dateStyle: 'full',
    });
    const timeLabel = formatTime(date, {
      locale,
      timeZone: timeZoneToUse,
      timeStyle: 'short',
    });
    const tzLabel = formatTimeZoneName(timeZoneToUse, { locale, type: 'long' });
    const components = [dateLabel, timeLabel, tzLabel].filter((value) => typeof value === 'string' && value.trim().length > 0);
    return components.length > 0 ? components.join(' ') : date.toISOString();
  }
};

export const formatTimeRange = (
  start: Date | string | number,
  end: Date | string | number,
  options: FormatTimeOptions = {},
): string => {
  const locale = options.locale ?? 'en';
  const preferences = resolveLocalePreferences(locale);
  const startDate = toDate(start);
  const endDate = toDate(end);
  if (!startDate || !endDate) return '';

  const rangeOptions: FormatTimeOptions = {
    timeStyle: 'short',
    ...options,
  };

  try {
    const formatter = new Intl.DateTimeFormat(preferences.locale, {
      ...applyDateOptions(rangeOptions, preferences),
      hourCycle: rangeOptions.hourCycle ?? preferences.hourCycle,
    });
    const formatterWithRange = formatter as Intl.DateTimeFormat & {
      formatRange?: (start: Date, end: Date) => string;
    };
    if (typeof formatterWithRange.formatRange === 'function') {
      return formatterWithRange.formatRange(startDate, endDate);
    }
    return `${formatter.format(startDate)} – ${formatter.format(endDate)}`;
  } catch {
    return `${startDate.toISOString()} – ${endDate.toISOString()}`;
  }
};

export const formatNumber = (value: number, options: FormatNumberOptions = {}): string => {
  const locale = options.locale ?? 'en';
  const { locale: _locale, ...rest } = options;
  try {
    return new Intl.NumberFormat(locale, rest).format(value);
  } catch {
    return Number.isFinite(value) ? String(value) : '';
  }
};

export const getWeekdaySequence = (firstDayOfWeek: number): number[] => {
  const sequence: number[] = [];
  for (let index = 0; index < 7; index += 1) {
    sequence.push((firstDayOfWeek + index) % 7);
  }
  return sequence;
};

export const toIsoDay = (zeroBasedDay: number): number => {
  if (!Number.isFinite(zeroBasedDay)) return 1;
  const normalized = ((Math.floor(zeroBasedDay) % 7) + 7) % 7;
  return ((normalized + 6) % 7) + 1;
};

export const fromIsoDay = (isoDay: number): number => {
  if (!Number.isFinite(isoDay)) return 0;
  const normalized = Math.floor(isoDay);
  if (normalized <= 0) {
    return 0;
  }
  return normalized % 7;
};

export const formatTimeZoneName = (
  timeZone: string,
  options: { locale?: string; type?: 'short' | 'long' } = {},
): string => {
  const locale = options.locale ?? 'en';
  try {
    const formatter = new Intl.DateTimeFormat(locale, {
      timeZone,
      timeZoneName: options.type ?? 'long',
    });
    const parts = formatter.formatToParts(new Date());
    const zonePart = parts.find((part) => part.type === 'timeZoneName');
    return zonePart?.value ?? timeZone;
  } catch {
    return timeZone;
  }
};

export const __resetStoredPreferencesForTests = (): void => {
  storedPreferencesCache = null;
};
