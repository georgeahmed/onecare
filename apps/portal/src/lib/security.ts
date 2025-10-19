const CONTROL_CHAR_PATTERN = /[\u0000-\u001F\u007F]/g;
const NON_NEWLINE_CONTROL_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const COLLAPSE_WHITESPACE_PATTERN = /\s+/g;
const HTML_TAG_PATTERN = /<\/?[^>]+>/g;
const SENSITIVE_KEY_TOKENS = ['token', 'secret', 'password', 'authorization', 'auth', 'patient', 'idempotency'];
const HIGH_ENTROPY_VALUE = /[A-Za-z0-9_\-]{24,}/;

const truncate = (value: string, maxLength: number): string =>
  value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;

export const sanitizeText = (value: string, maxLength = 1_000): string => {
  const cleaned = value.replace(CONTROL_CHAR_PATTERN, ' ').replace(COLLAPSE_WHITESPACE_PATTERN, ' ').trim();
  return truncate(cleaned, maxLength);
};

export const sanitizeMultilineText = (value: string, maxLength = 2_000): string => {
  const cleaned = value
    .replace(NON_NEWLINE_CONTROL_PATTERN, ' ')
    .replace(/\r\n|\r/g, '\n')
    .replace(/\t+/g, ' ')
    .replace(/[ \u00A0]+/g, ' ')
    .replace(/[ \u00A0]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return truncate(cleaned, maxLength);
};

export const stripHtml = (value: string, maxLength = 1_000): string => {
  const withoutTags = value.replace(HTML_TAG_PATTERN, ' ');
  return sanitizeText(withoutTags, maxLength);
};

export const ensureHttpsUrl = (candidate: string): string | null => {
  try {
    const parsed = new URL(candidate.trim());
    if (parsed.protocol !== 'https:') {
      return null;
    }
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return null;
  }
};

const redactString = (value: string): string => {
  if (value.length > 128 || HIGH_ENTROPY_VALUE.test(value)) {
    return '[redacted]';
  }
  return value;
};

export const redactForLog = (value: unknown): unknown => {
  if (value === null || typeof value === 'undefined') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactForLog(item));
  }
  if (typeof value === 'string') {
    return redactString(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    return entries.reduce<Record<string, unknown>>((acc, [key, raw]) => {
      if (SENSITIVE_KEY_TOKENS.some((token) => key.toLowerCase().includes(token))) {
        acc[key] = '[redacted]';
        return acc;
      }
      acc[key] = redactForLog(raw);
      return acc;
    }, {});
  }
  return '[redacted]';
};

export const scrubHeaders = (headers: Record<string, string | undefined>): Record<string, string> => {
  return Object.entries(headers).reduce<Record<string, string>>((acc, [key, value]) => {
    if (!value) {
      return acc;
    }
    if (SENSITIVE_KEY_TOKENS.some((token) => key.toLowerCase().includes(token))) {
      acc[key] = '[redacted]';
      return acc;
    }
    acc[key] = value;
    return acc;
  }, {});
};
