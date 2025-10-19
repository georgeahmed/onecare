import { CallTranscribed } from '@onecare/events';
import { URL } from 'node:url';
import { isIP } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { createCounter, getCorrelationId, logger, startSpan } from '@onecare/observability';
import { context, trace, SpanStatusCode } from '@opentelemetry/api';

const asrRetryCounter = createCounter('asr.retry');
const asrTimeoutCounter = createCounter('asr.timeout');
const asrCircuitOpenCounter = createCounter('asr.cb.open');

export interface DiarizationSegment {
  speaker: string;
  startMs: number;
  endMs: number;
}

export interface TranscriptionResponse {
  text: string;
  lang?: string | null;
  diarization?: DiarizationSegment[];
}

export interface TranscriptionContext {
  patientId?: string | null;
}

export interface AsrClient {
  transcribe(callId: string, audioRef: string): Promise<TranscriptionResponse>;
}

export type CallTranscribedBuilder = (params: {
  callId: string;
  transcription: TranscriptionResponse;
  context?: TranscriptionContext;
}) => CallTranscribed;

export type TranscriptNormalizer = (text: string) => string;

export interface StubAsrClientOptions {
  normalizer?: TranscriptNormalizer;
  defaultLanguage?: string;
  diarization?: DiarizationSegment[];
}

const baseNormalizer: TranscriptNormalizer = (text: string) => text.trim();
export const defaultNormalizer = baseNormalizer;

export class StubAsrClient implements AsrClient {
  private readonly normalizer: TranscriptNormalizer;
  private readonly defaultLanguage?: string;
  private readonly diarization?: DiarizationSegment[];

  constructor(options?: StubAsrClientOptions) {
    this.normalizer = options?.normalizer ?? baseNormalizer;
    this.defaultLanguage = options?.defaultLanguage;
    this.diarization = options?.diarization;
  }

  async transcribe(callId: string, audioRef: string): Promise<TranscriptionResponse> {
    if (!callId?.trim()) {
      throw new AsrClientError('call_id_required', 'callId is required for transcription');
    }
    if (!audioRef?.trim()) {
      throw new AsrClientError('audio_ref_required', 'audio reference is required');
    }
    const text = this.normalizer(`transcript for ${callId}`);
    return {
      text,
      lang: this.defaultLanguage ?? null,
      diarization: this.diarization,
    };
  }
}

export class AsrClientError extends Error {
  constructor(
    public readonly code: AsrClientErrorCode,
    message: string,
    public readonly cause?: unknown,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = 'AsrClientError';
  }
}

export type AsrClientErrorCode =
  | 'call_id_required'
  | 'audio_ref_required'
  | 'transcript_required'
  | 'asr_timeout'
  | 'asr_circuit_open'
  | 'asr_unreachable'
  | 'asr_invalid_response';

export const buildCallTranscribed: CallTranscribedBuilder = ({ callId, transcription, context }) => {
  const normalizedCallId = callId?.trim();
  if (!normalizedCallId) {
    throw new AsrClientError('call_id_required', 'callId is required to build CallTranscribed payload');
  }
  const transcript = transcription?.text ? baseNormalizer(transcription.text) : '';
  if (!transcript) {
    throw new AsrClientError('transcript_required', 'transcription text is required');
  }

  const payload: CallTranscribed = {
    callId: normalizedCallId,
    transcript,
  };

  const lang = transcription?.lang;
  if (typeof lang === 'string') {
    const normalizedLang = lang.trim();
    if (normalizedLang) {
      payload.lang = normalizedLang;
    }
  } else if (lang === null) {
    payload.lang = null;
  }

  if (context && 'patientId' in context) {
    const rawPatient = context.patientId;
    if (typeof rawPatient === 'string') {
      const normalizedPatient = rawPatient.trim();
      payload.patientId = normalizedPatient.length > 0 ? normalizedPatient : null;
    } else {
      payload.patientId = rawPatient ?? null;
    }
  }

  return payload;
};

export interface HttpAsrClientOptions {
  endpoint: string;
  timeoutMs?: number;
  maxRetries?: number;
  baseDelayMs?: number;
  circuitBreakerFailureThreshold?: number;
  circuitBreakerCooldownMs?: number;
  hostAllowlist?: string[];
  allowInsecureHttp?: boolean;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

interface CircuitBreakerState {
  state: 'closed' | 'open' | 'half-open';
  failures: number;
  openedAt: number;
}

const breakerStates = new Map<string, CircuitBreakerState>();

export function __resetAsrCircuitBreakers(): void {
  breakerStates.clear();
}

function defaultNow(): number {
  return Date.now();
}

function defaultRandom(): number {
  return Math.random();
}

function getBreaker(key: string): CircuitBreakerState {
  const existing = breakerStates.get(key);
  if (existing) return existing;
  const state: CircuitBreakerState = { state: 'closed', failures: 0, openedAt: 0 };
  breakerStates.set(key, state);
  return state;
}

function computeJitter(base: number, random: () => number): number {
  if (base <= 0) return 0;
  const clamped = Math.max(0, base);
  return Math.floor(random() * clamped);
}

function isPrivateHost(hostname: string): boolean {
  if (!hostname) {
    return true;
  }
  const lower = hostname.toLowerCase();
  if (lower === 'localhost' || lower.endsWith('.local') || lower.endsWith('.internal')) {
    return true;
  }
  const ipType = isIP(hostname);
  if (ipType === 4) {
    const octets = hostname.split('.').map((part) => Number(part));
    if (octets[0] === 10) return true;
    if (octets[0] === 127) return true;
    if (octets[0] === 192 && octets[1] === 168) return true;
    if (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) return true;
  }
  if (ipType === 6) {
    const normalized = hostname.toLowerCase();
    if (normalized === '::1') return true;
    if (normalized.startsWith('fe80') || normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
  }
  return false;
}

function buildAllowlist(raw: string[] | undefined, hostname: string): Set<string> {
  const allowlist = new Set<string>();
  const entries = Array.isArray(raw) && raw.length > 0 ? raw : [hostname];
  for (const entry of entries) {
    if (typeof entry !== 'string') continue;
    const trimmed = entry.trim().toLowerCase();
    if (trimmed) {
      allowlist.add(trimmed);
    }
  }
  return allowlist;
}

function normalizeEndpoint(endpoint: string, allowInsecure: boolean): URL {
  if (!endpoint || typeof endpoint !== 'string') {
    throw new Error('telephony_asr_endpoint_missing');
  }
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error('telephony_asr_endpoint_invalid');
  }
  if (parsed.protocol !== 'https:' && !allowInsecure) {
    throw new Error('telephony_asr_endpoint_insecure');
  }
  if (isPrivateHost(parsed.hostname)) {
    throw new Error('telephony_asr_endpoint_private');
  }
  return parsed;
}

function currentTraceParent(): string | undefined {
  const span = trace.getSpan(context.active());
  if (!span) return undefined;
  const spanContext = span.spanContext();
  if (!spanContext || !spanContext.traceId || !spanContext.spanId) return undefined;
  const traceId = spanContext.traceId;
  const spanId = spanContext.spanId;
  const flags = spanContext.traceFlags?.toString(16).padStart(2, '0') ?? '01';
  return `00-${traceId}-${spanId}-${flags}`;
}

function isRetryableStatus(status: number): boolean {
  if (status >= 500) return true;
  return status === 408 || status === 425 || status === 429;
}

function isRetryableError(error: unknown): boolean {
  if (error instanceof AsrClientError) {
    return error.retryable || error.code === 'asr_timeout' || error.code === 'asr_unreachable';
  }
  const code = (error as { code?: string }).code;
  if (typeof code === 'string') {
    const lowered = code.toLowerCase();
    if (
      lowered.includes('timeout') ||
      lowered.includes('econnreset') ||
      lowered.includes('etimedout') ||
      lowered.includes('eai_again') ||
      lowered.includes('temporarily_unavailable')
    ) {
      return true;
    }
  }
  const name = (error as { name?: string }).name;
  if (name && name.toLowerCase() === 'aborterror') {
    return true;
  }
  return false;
}

function sanitizeLanguage(raw: unknown): string | null | undefined {
  if (raw === null) return null;
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function sanitizeTranscriptText(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface DiarizationLike {
  speaker?: unknown;
  speakerId?: unknown;
  start?: unknown;
  end?: unknown;
  startMs?: unknown;
  endMs?: unknown;
  start_ms?: unknown;
  end_ms?: unknown;
}

function normalizeDiarizationSegment(entry: unknown): DiarizationSegment | null {
  if (!entry || typeof entry !== 'object') return null;
  const segment = entry as DiarizationLike;
  const speakerRaw = typeof segment.speaker === 'string' ? segment.speaker : typeof segment.speakerId === 'string' ? segment.speakerId : undefined;
  const speaker = speakerRaw?.trim() || 'unknown';

  const startCandidate =
    typeof segment.startMs === 'number'
      ? segment.startMs
      : typeof segment.start_ms === 'number'
        ? segment.start_ms
        : typeof segment.start === 'number'
          ? segment.start * (segment.start > 10 ? 1 : 1000)
          : undefined;
  const endCandidate =
    typeof segment.endMs === 'number'
      ? segment.endMs
      : typeof segment.end_ms === 'number'
        ? segment.end_ms
        : typeof segment.end === 'number'
          ? segment.end * (segment.end > 10 ? 1 : 1000)
          : undefined;

  if (!Number.isFinite(startCandidate) || !Number.isFinite(endCandidate)) {
    return null;
  }
  const startMs = Math.max(0, Math.floor(startCandidate!));
  const endMs = Math.max(startMs, Math.floor(endCandidate!));
  return { speaker, startMs, endMs };
}

function extractDiarization(payload: unknown): DiarizationSegment[] | undefined {
  const candidates: unknown[] = [];
  if (isRecord(payload) && Array.isArray(payload.diarization)) {
    candidates.push(...payload.diarization);
  }
  if (isRecord(payload) && isRecord(payload.result) && Array.isArray(payload.result.diarization)) {
    candidates.push(...payload.result.diarization);
  }
  if (isRecord(payload) && isRecord(payload.result) && Array.isArray(payload.result.segments)) {
    candidates.push(...payload.result.segments);
  }
  if (candidates.length === 0) return undefined;
  const normalized = candidates
    .map((entry) => normalizeDiarizationSegment(entry))
    .filter((segment): segment is DiarizationSegment => Boolean(segment));
  if (normalized.length === 0) return undefined;
  return normalized;
}

export class HttpAsrClient implements AsrClient {
  private readonly endpoint: URL;
  private readonly hostname: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly allowlist: Set<string>;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly breakerKey: string;

  constructor(options: HttpAsrClientOptions) {
    const allowInsecure =
      options.allowInsecureHttp ?? (process.env.NODE_ENV ? process.env.NODE_ENV.toLowerCase() === 'development' : false);
    const endpoint = normalizeEndpoint(options.endpoint, allowInsecure);
    const allowlist = buildAllowlist(options.hostAllowlist, endpoint.hostname);
    if (!allowlist.has(endpoint.hostname.toLowerCase())) {
      throw new Error('telephony_asr_endpoint_not_allowlisted');
    }
    this.endpoint = endpoint;
    this.hostname = endpoint.hostname;
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.baseDelayMs = Math.max(50, options.baseDelayMs ?? 150);
    this.failureThreshold = Math.max(1, options.circuitBreakerFailureThreshold ?? 5);
    this.cooldownMs = Math.max(1_000, options.circuitBreakerCooldownMs ?? 15_000);
    this.allowlist = allowlist;
    this.fetchImpl = options.fetchImpl ?? (globalThis.fetch?.bind(globalThis) as typeof fetch);
    if (typeof this.fetchImpl !== 'function') {
      throw new Error('telephony_asr_fetch_unavailable');
    }
    this.now = options.now ?? defaultNow;
    this.sleepFn = options.sleep ?? sleep;
    this.random = options.random ?? defaultRandom;
    this.breakerKey = `${this.hostname}:${this.endpoint.port || this.endpoint.protocol}`;
  }

  async transcribe(callId: string, audioRef: string): Promise<TranscriptionResponse> {
    const trimmedCallId = callId?.trim();
    if (!trimmedCallId) {
      throw new AsrClientError('call_id_required', 'callId is required for transcription', undefined, false);
    }
    const trimmedAudioRef = audioRef?.trim();
    if (!trimmedAudioRef) {
      throw new AsrClientError('audio_ref_required', 'audio reference is required', undefined, false);
    }
    if (!this.allowlist.has(this.hostname.toLowerCase())) {
      throw new AsrClientError('asr_unreachable', 'ASR endpoint disallowed', undefined, true);
    }

    const span = startSpan('asr.call', {
      attributes: {
        'asr.host': this.hostname,
        'asr.endpoint': this.endpoint.pathname || '/',
      },
    });

    return await context.with(trace.setSpan(context.active(), span), async () => {
      try {
        const result = await this.executeWithGuard(trimmedCallId, trimmedAudioRef);
        if (span.isRecording()) {
          span.setStatus({ code: SpanStatusCode.OK });
        }
        return result;
      } catch (error) {
        if (span.isRecording()) {
          const message = error instanceof Error ? error.message : 'asr_call_failed';
          span.setStatus({ code: SpanStatusCode.ERROR, message });
          span.recordException(error as Error);
        }
        throw error;
      } finally {
        span.end();
      }
    });
  }

  private async executeWithGuard(callId: string, audioRef: string): Promise<TranscriptionResponse> {
    const breaker = getBreaker(this.breakerKey);
    const startedAt = this.now();
    if (breaker.state === 'open') {
      const elapsed = startedAt - breaker.openedAt;
      if (elapsed < this.cooldownMs) {
        asrCircuitOpenCounter.add(1, { host: this.hostname });
        logger.warn('telephony.asr.cb.reject', {
          callId,
          host: this.hostname,
          sinceMs: elapsed,
        });
        throw new AsrClientError('asr_circuit_open', 'ASR circuit breaker open');
      }
      breaker.state = 'half-open';
      logger.info('telephony.asr.cb.half_open', {
        callId,
        host: this.hostname,
      });
    }

    const maxAttempts = this.maxRetries + 1;
    let attempt = 0;
    let lastError: unknown;

    while (attempt < maxAttempts) {
      attempt += 1;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      const attemptStarted = this.now();
      const correlationId = getCorrelationId() ?? undefined;
      try {
        const result = await this.performRequest(callId, audioRef, controller.signal, correlationId);
        clearTimeout(timeout);
        if (breaker.state !== 'closed') {
          breaker.state = 'closed';
          breaker.failures = 0;
          breaker.openedAt = 0;
          logger.info('telephony.asr.cb.closed', {
            callId,
            host: this.hostname,
          });
        }
        return result;
      } catch (error) {
        clearTimeout(timeout);
        lastError = error;
        const durationMs = this.now() - attemptStarted;
        const isTimeout = controller.signal.aborted || (error instanceof AsrClientError && error.code === 'asr_timeout');
        if (isTimeout) {
          asrTimeoutCounter.add(1, { host: this.hostname });
          logger.warn('telephony.asr.timeout', {
            callId,
            host: this.hostname,
            attempt,
            durationMs,
          });
        }

        const retryable = isTimeout || isRetryableError(error);
        if (retryable && attempt < maxAttempts) {
          const backoff = this.computeBackoff(attempt);
          asrRetryCounter.add(1, {
            host: this.hostname,
            attempt,
          });
          logger.warn('telephony.asr.retry', {
            callId,
            host: this.hostname,
            attempt,
            backoffMs: backoff,
            reason: error instanceof AsrClientError ? error.code : 'error',
          });
          await this.sleepFn(backoff);
          continue;
        }

        breaker.failures += 1;
        if (breaker.state === 'half-open' || breaker.failures >= this.failureThreshold) {
          breaker.state = 'open';
          breaker.openedAt = this.now();
          breaker.failures = 0;
          asrCircuitOpenCounter.add(1, { host: this.hostname });
          logger.error('telephony.asr.cb.open', {
            callId,
            host: this.hostname,
          });
        }
        throw error;
      }
    }

    throw lastError ?? new AsrClientError('asr_unreachable', 'ASR call failed');
  }

  private computeBackoff(attempt: number): number {
    const exponent = Math.pow(2, attempt - 1);
    return this.baseDelayMs * exponent + computeJitter(this.baseDelayMs, this.random);
  }

  private async performRequest(
    callId: string,
    audioRef: string,
    signal: AbortSignal,
    correlationId: string | undefined,
  ): Promise<TranscriptionResponse> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
    };
    if (correlationId) {
      headers['x-correlation-id'] = correlationId;
    }
    const traceParent = currentTraceParent();
    if (traceParent) {
      headers.traceparent = traceParent;
    }

    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint.toString(), {
        method: 'POST',
        headers,
        body: JSON.stringify({
          callId,
          audioRef,
        }),
        signal,
        redirect: 'manual',
      });
    } catch (error) {
      if (signal.aborted || (error as { name?: string }).name === 'AbortError') {
        throw new AsrClientError('asr_timeout', 'ASR request timed out', error, true);
      }
      throw new AsrClientError('asr_unreachable', 'ASR request failed', error, true);
    }

    if (response.status >= 300 && response.status < 400) {
      throw new AsrClientError('asr_unreachable', `ASR redirect not allowed (${response.status})`, undefined, false);
    }

    if (!response.ok) {
      const retryable = isRetryableStatus(response.status);
      throw new AsrClientError(
        'asr_unreachable',
        `ASR request failed with status ${response.status}`,
        undefined,
        retryable,
      );
    }

    const contentType = response.headers.get('content-type') ?? '';
    let payload: unknown;
    if (contentType.includes('application/json')) {
      payload = await response.json().catch((error: unknown) => {
        throw new AsrClientError('asr_invalid_response', 'ASR response JSON invalid', error, false);
      });
    } else {
      const text = await response.text();
      try {
        payload = JSON.parse(text) as unknown;
      } catch (error) {
        throw new AsrClientError('asr_invalid_response', 'ASR response not JSON', error, false);
      }
    }

    const result = this.normalizeResponse(payload);
    if (!result.text) {
      throw new AsrClientError('transcript_required', 'ASR response missing transcript');
    }
    return result;
  }

  private normalizeResponse(payload: unknown): TranscriptionResponse {
    if (!payload || typeof payload !== 'object') {
      throw new AsrClientError('asr_invalid_response', 'ASR payload invalid');
    }
    const record = payload as Record<string, unknown>;
    const directText = sanitizeTranscriptText(record.text);
    const transcriptText =
      directText ??
      sanitizeTranscriptText(record.transcript) ??
      sanitizeTranscriptText((record.result as Record<string, unknown>)?.text);
    const lang =
      sanitizeLanguage(record.lang) ??
      sanitizeLanguage(record.language) ??
      sanitizeLanguage((record.result as Record<string, unknown>)?.lang);

    if (!transcriptText) {
      return { text: '', lang: lang ?? null };
    }
    const diarization = extractDiarization(payload);
    return {
      text: transcriptText,
      lang: lang ?? null,
      ...(diarization ? { diarization } : {}),
    };
  }
}

export function createAsrClientFromEnv(): AsrClient {
  const endpoint = process.env.TELEPHONY_ASR_ENDPOINT?.trim();
  if (!endpoint) {
    return new StubAsrClient();
  }
  const timeout = parseInt(process.env.TELEPHONY_ASR_TIMEOUT_MS ?? '', 10);
  const retries = parseInt(process.env.TELEPHONY_ASR_MAX_RETRIES ?? '', 10);
  const baseDelay = parseInt(process.env.TELEPHONY_ASR_BASE_DELAY_MS ?? '', 10);
  const failureThreshold = parseInt(process.env.TELEPHONY_ASR_CB_FAILURES ?? '', 10);
  const cooldown = parseInt(process.env.TELEPHONY_ASR_CB_COOLDOWN_MS ?? '', 10);
  const allowInsecure = parseBoolean(process.env.TELEPHONY_ASR_ALLOW_INSECURE) ?? false;
  const allowlistRaw = process.env.TELEPHONY_ASR_HOST_ALLOWLIST;
  const hostAllowlist = allowlistRaw
    ? allowlistRaw
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
    : undefined;

  return new HttpAsrClient({
    endpoint,
    timeoutMs: Number.isFinite(timeout) ? timeout : undefined,
    maxRetries: Number.isFinite(retries) ? retries : undefined,
    baseDelayMs: Number.isFinite(baseDelay) ? baseDelay : undefined,
    circuitBreakerFailureThreshold: Number.isFinite(failureThreshold) ? failureThreshold : undefined,
    circuitBreakerCooldownMs: Number.isFinite(cooldown) ? cooldown : undefined,
    hostAllowlist,
    allowInsecureHttp: allowInsecure,
  });
}

function parseBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return undefined;
  if (['1', 'true', 'yes', 'on', 'enabled'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off', 'disabled'].includes(normalized)) return false;
  return undefined;
}
