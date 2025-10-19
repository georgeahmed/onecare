import { getCorrelationId } from './otel';

type Level = 'debug' | 'info' | 'warn' | 'error';

const REDACTED_TEXT = '[REDACTED]';
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE_RE = /(?<!\w)(?:\+?\d[\d\s().-]{6,}\d)/g;
const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/g;
const NHS_NUMBER_RE = /\b\d{3}\s?\d{3}\s?\d{4}\b/g;
const NI_NUMBER_RE = /\b(?!oo)[A-CEGHJ-PR-TW-Z]{2}\s?\d{2}\s?\d{2}\s?\d{2}\s?[A-D]\b/gi;
const CREDIT_CARD_RE = /\b(?:\d[ -]?){13,16}\d\b/g;
const KEY_VALUE_SECRET_RE =
  /\b(token|secret|password|passcode|credential|api[_-]?key|client[_-]?secret|session[_-]?token|session[_-]?id|refresh[_-]?token|access[_-]?token|authorization|bearer|basic)\b\s*([:=])\s*(['"]?)([^\s,;'"`]+)(['"]?)/gi;
const JSON_SECRET_PAIR_RE =
  /(["'])(token|secret|password|passcode|credential|apiKey|clientSecret|sessionToken|sessionId|refreshToken|accessToken|authorization|bearer|basic)\1\s*:\s*(["'])([^"']*)\3/gi;
const HEADER_SECRET_RE = /\b(authorization|proxy-authorization|x-auth-token)\b\s*([:=])\s*([^\r\n]+)/gi;
const SENSITIVE_KEYWORD_RE =
  /(token|secret|password|credential|passcode|pin|otp|ssn|phone|mobile|email|authorization|bearer|basic|nhs|mrn|nationalinsurance|passport|accountnumber|iban|swift|sortcode|routingnumber|cardnumber|creditcard|cvv|cvc)/i;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const BASIC_RE = /\bBasic\s+[A-Za-z0-9._~+/=-]+/gi;
const COOKIE_HEADER_RE = /\b(cookie|set-cookie)\b\s*[:=]\s*([^\r\n;]+(?:;[^\r\n]+)*)/gi;
const SAFE_ID_KEYS = new Set([
  'correlationid',
  'traceid',
  'spanid',
  'requestid',
  'practiceid',
  'practice_id',
  'servicerequestid',
  'x-correlation-id',
  'x_correlation_id',
  'x-correlationid',
  'x-request-id',
  'x_request_id',
  'x-requestid',
]);
const SAFE_ID_PARTS = [
  'correlationid',
  'correlation-id',
  'requestid',
  'request-id',
  'traceid',
  'spanid',
  'practiceid',
  'practice-id',
  'servicerequestid',
  'service-request-id',
];
const SENSITIVE_KEY_SUBSTRINGS = [
  'apikey',
  'clientsecret',
  'sessiontoken',
  'sessionsecret',
  'sessionkey',
  'sessionid',
  'refreshtoken',
  'accesstoken',
  'idtoken',
  'nhsnumber',
  'nationalinsurance',
  'medicalrecord',
  'mrn',
  'ninumber',
  'passportnumber',
  'dob',
  'dateofbirth',
  'birthdate',
  'accountnumber',
  'bankaccount',
  'routingnumber',
  'sortcode',
  'iban',
  'swift',
  'cardnumber',
  'creditcard',
  'cvv',
  'cvc',
  'passcode',
  'pin',
  'otp',
];

function isBinaryLike(value: unknown): boolean {
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) return true;
  if (value instanceof ArrayBuffer) return true;
  return ArrayBuffer.isView(value);
}

function safeObjectEntries(value: Record<string, unknown>): Array<[string, unknown]> {
  const entries: Array<[string, unknown]> = [];
  for (const key of Object.keys(value)) {
    try {
      entries.push([key, value[key]]);
    } catch {
      entries.push([key, REDACTED_TEXT]);
    }
  }
  return entries;
}

const COMPONENT_FIELD_ALLOWLIST: Record<string, Set<string>> = {
  triage: new Set([
    'component',
    'correlationid',
    'topic',
    'decision',
    'score',
    'priority',
    'taskid',
    'taskref',
    'patientref',
    'reason',
    'reasons',
    'status',
    'code',
    'outcome',
    'attempt',
    'idempotencykey',
    'event',
    'audit',
  ]),
};

function isAllowedForComponent(component: string | undefined, key: string): boolean {
  if (!component) return true;
  const normalizedComponent = component.toLowerCase();
  const allowlist = COMPONENT_FIELD_ALLOWLIST[normalizedComponent];
  if (!allowlist) return true;
  if (allowlist.has(key.toLowerCase())) return true;
  if (SAFE_ID_KEYS.has(key.toLowerCase())) return true;
  if (SAFE_ID_PARTS.some((part) => key.toLowerCase().includes(part))) return true;
  return false;
}

function shouldRedactKey(key: string): boolean {
  const lower = key.toLowerCase();
  if (lower === 'cookie' || lower === 'set-cookie') return true;
  if (lower.includes('transcript') || lower.includes('transcription')) return true;
  if (SAFE_ID_KEYS.has(lower)) return false;
  if (SAFE_ID_PARTS.some((part) => lower.includes(part))) return false;
  const normalized = lower.replace(/[^a-z0-9]/g, '');
  if (normalized === 'id') return true;
  const hasDelimitedIdSuffix = ['_', '-', '.', ':'].some((sep) => lower.endsWith(`${sep}id`));
  const hasCamelIdSuffix = key.endsWith('Id') || key.endsWith('ID');
  if (hasDelimitedIdSuffix || hasCamelIdSuffix) return true;
  if (SENSITIVE_KEY_SUBSTRINGS.some((segment) => normalized.includes(segment))) return true;
  return SENSITIVE_KEYWORD_RE.test(lower);
}

function redactString(value: string): string {
  let result = value;
  result = result.replace(EMAIL_RE, REDACTED_TEXT);
  result = result.replace(PHONE_RE, REDACTED_TEXT);
  result = result.replace(NHS_NUMBER_RE, REDACTED_TEXT);
  result = result.replace(NI_NUMBER_RE, REDACTED_TEXT);
  result = result.replace(SSN_RE, REDACTED_TEXT);
  result = result.replace(CREDIT_CARD_RE, REDACTED_TEXT);
  result = result.replace(
    HEADER_SECRET_RE,
    (_match, headerKey: string, separator: string) => {
      const normalisedSeparator = separator === ':' ? ':' : separator.trim() || ':';
      const gap = normalisedSeparator === ':' ? ' ' : '';
      return `${headerKey}${normalisedSeparator}${gap}${REDACTED_TEXT}`;
    },
  );
  result = result.replace(BEARER_RE, (match) => {
    const [prefix] = match.split(/\s+/, 1);
    return `${prefix} ${REDACTED_TEXT}`;
  });
  result = result.replace(BASIC_RE, () => `Basic ${REDACTED_TEXT}`);
  result = result.replace(COOKIE_HEADER_RE, (_match, key) => `${key}: ${REDACTED_TEXT}`);
  result = result.replace(
    JSON_SECRET_PAIR_RE,
    (_match, keyQuote: string, keyWord: string, valueQuote: string, _value: string) =>
      `${keyQuote}${keyWord}${keyQuote}:${valueQuote}${REDACTED_TEXT}${valueQuote}`,
  );
  result = result.replace(
    KEY_VALUE_SECRET_RE,
    (_match, keyWord, separator, opening, _value, closing) => {
      const openQuote = opening ?? '';
      const closeQuote = closing ?? (openQuote === '"' || openQuote === "'" ? openQuote : '');
      const normalisedSeparator = separator === '=' ? '=' : `${separator}`;
      const gap = normalisedSeparator === '=' ? '' : ' ';
      return `${keyWord}${normalisedSeparator}${gap}${openQuote}${REDACTED_TEXT}${closeQuote}`;
    },
  );
  return result;
}

function redactUnknown(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint' || typeof value === 'symbol') return String(value);
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message),
    };
  }
  if (isBinaryLike(value)) return REDACTED_TEXT;
  if (Array.isArray(value)) {
    if (seen.has(value)) return REDACTED_TEXT;
    seen.add(value);
    return value.map((item) => redactUnknown(item, seen));
  }
  if (value instanceof Map) {
    if (seen.has(value)) return REDACTED_TEXT;
    seen.add(value);
    const mapped: Record<string, unknown> = {};
    for (const [mapKey, mapValue] of value.entries()) {
      const key = typeof mapKey === 'string' ? mapKey : String(mapKey);
      mapped[key] = shouldRedactKey(key) ? REDACTED_TEXT : redactUnknown(mapValue, seen);
    }
    return mapped;
  }
  if (value instanceof Set) {
    if (seen.has(value)) return REDACTED_TEXT;
    seen.add(value);
    return Array.from(value).map((entry) => redactUnknown(entry, seen));
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (seen.has(obj)) return REDACTED_TEXT;
    seen.add(obj);
    const result: Record<string, unknown> = {};
    for (const [key, inner] of safeObjectEntries(obj)) {
      if (shouldRedactKey(key)) {
        result[key] = REDACTED_TEXT;
      } else {
        result[key] = redactUnknown(inner, seen);
      }
    }
    return result;
  }
  return value;
}

export function redact<T>(value: T): T {
  return redactUnknown(value, new WeakSet()) as T;
}

function now() { return new Date().toISOString(); }

function scrub(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (value instanceof Error) {
    return { message: value.message, name: value.name };
  }
  const type = typeof value;
  if (type === 'string' || type === 'number' || type === 'boolean') return value;
  if (type === 'bigint' || type === 'symbol') return String(value);
  if (Array.isArray(value)) {
    return value.map((item) => scrub(item));
  }
  if (type === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      const cleaned = scrub(inner);
      if (cleaned !== undefined) {
        result[key] = cleaned;
      }
    }
    return result;
  }
  return String(value);
}

export function log(level: Level, msg: string, fields?: Record<string, unknown>) {
  const sanitizedMsg = redact(msg);
  const entry: Record<string, unknown> = { ts: now(), level, msg: sanitizedMsg };
  if (fields) {
    const component = typeof fields.component === 'string' ? fields.component : undefined;
    for (const [k, v] of Object.entries(fields)) {
      if (!isAllowedForComponent(component, k)) {
        entry[k] = REDACTED_TEXT;
        continue;
      }
      if (shouldRedactKey(k)) {
        entry[k] = REDACTED_TEXT;
        continue;
      }
      const sanitized = redact(v);
      const cleaned = scrub(sanitized);
      if (cleaned !== undefined) entry[k] = cleaned;
    }
  }
  const fieldsCorrelation = entry.correlationId ?? (fields?.correlationId as string | undefined);
  if (fieldsCorrelation) {
    entry.correlationId = String(fieldsCorrelation);
  } else {
    const cid = getCorrelationId();
    if (cid) entry.correlationId = cid;
  }
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(entry));
}

export const logger = {
  debug: (msg: string, f?: Record<string, unknown>) => log('debug', msg, f),
  info: (msg: string, f?: Record<string, unknown>) => log('info', msg, f),
  warn: (msg: string, f?: Record<string, unknown>) => log('warn', msg, f),
  error: (msg: string, f?: Record<string, unknown>) => log('error', msg, f),
};
