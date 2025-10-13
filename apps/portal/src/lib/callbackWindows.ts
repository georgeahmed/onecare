const CALLBACK_PRIORITIES = ['stat', 'urgent', 'soon', 'routine'] as const;
const CALLBACK_WINDOW_CODES = ['immediate', 'within_2h', 'same_day', 'within_48h'] as const;

export type CallbackPriority = typeof CALLBACK_PRIORITIES[number];
export type CallbackWindowCode = typeof CALLBACK_WINDOW_CODES[number];

export interface CallbackWindowsConfig {
  windows: Record<CallbackPriority, CallbackWindowCode>;
  outsideHoursMessage?: string;
  acceptSubmissionsOutsideHours?: boolean;
}

const DEFAULT_WINDOWS: Record<CallbackPriority, CallbackWindowCode> = {
  stat: 'immediate',
  urgent: 'within_2h',
  soon: 'same_day',
  routine: 'within_48h',
};

const DEFAULT_OUTSIDE_HOURS_MESSAGE =
  'If we are outside core hours we will review requests as soon as we reopen.';

export function resolveCallbackWindowsFromEnv(
  env: Record<string, string | undefined>
): CallbackWindowsConfig {
  const parsed = safeParse(env.VITE_CALLBACK_WINDOWS_BY_PRIORITY);
  const resolvedWindows = normalizeWindows(parsed);

  const rawMessage = env.VITE_CALLBACK_OOH_MESSAGE;
  const oohMessage = rawMessage !== undefined ? rawMessage.trim() : undefined;
  const acceptOutside = parseBoolean(env.VITE_CALLBACK_OOH_ACCEPT_SUBMISSIONS);

  return {
    windows: resolvedWindows,
    outsideHoursMessage:
      rawMessage === undefined
        ? DEFAULT_OUTSIDE_HOURS_MESSAGE
        : oohMessage && oohMessage.length > 0
        ? oohMessage
        : undefined,
    acceptSubmissionsOutsideHours: acceptOutside ?? true,
  };
}

function safeParse(value: string | undefined): unknown {
  if (!value) {
    return undefined;
  }
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function normalizeWindows(input: unknown): Record<CallbackPriority, CallbackWindowCode> {
  if (!isRecord(input)) {
    return DEFAULT_WINDOWS;
  }
  const windows: Partial<Record<CallbackPriority, CallbackWindowCode>> = {};
  for (const priority of CALLBACK_PRIORITIES) {
    const raw = input[priority];
    if (typeof raw === 'string' && CALLBACK_WINDOW_CODES.includes(raw as CallbackWindowCode)) {
      windows[priority] = raw as CallbackWindowCode;
    }
  }
  return {
    ...DEFAULT_WINDOWS,
    ...windows,
  };
}

function parseBoolean(value: string | undefined): boolean | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function createDefaultCallbackWindows(): CallbackWindowsConfig {
  return {
    windows: { ...DEFAULT_WINDOWS },
    outsideHoursMessage: DEFAULT_OUTSIDE_HOURS_MESSAGE,
    acceptSubmissionsOutsideHours: true,
  };
}

export function getConfiguredCallbackWindows(): CallbackWindowsConfig {
  const env = (import.meta as unknown as { env: Record<string, string | undefined> }).env ?? {};
  return resolveCallbackWindowsFromEnv(env);
}

export const orderedPriorities = [...CALLBACK_PRIORITIES];
