import { performance } from 'node:perf_hooks';
import { URL } from 'node:url';
import { isIP } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { context, trace, SpanStatusCode } from '@opentelemetry/api';
import {
  createCounter,
  createHistogram,
  getCorrelationId,
  logger,
  startSpan,
} from '@onecare/observability';
import {
  IntentClassifierError,
  type IntentClassifier,
  type IntentClassificationInput,
  type IntentClassificationResult,
  StubIntentClassifier,
} from './intent.classifier';

export interface KeywordIntentConfig {
  intent: string;
  keywords: string[];
  confidence?: number;
}

export interface IntentServiceClassifierOptions {
  baseUrl?: string;
  apiKey?: string;
  defaultIntent?: string;
  defaultConfidence?: number;
  keywordIntents?: KeywordIntentConfig[];
  fallback?: IntentClassifier;
  timeoutMs?: number;
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  hostAllowlist?: string[];
  allowInsecureHttp?: boolean;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
}

const DEFAULT_INTENT = 'telephony.callback';
const DEFAULT_CONFIDENCE = 0.6;
const DEFAULT_TIMEOUT_MS = 2_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_BASE_DELAY_MS = 150;
const DEFAULT_MAX_DELAY_MS = 2_000;
const DEFAULT_BACKOFF_JITTER = 75;

const FALLBACK_KEYWORD_CONFIG: KeywordIntentConfig[] = [
  { intent: 'telephony.emergency', keywords: ['emergency', 'ambulance', 'help now'], confidence: 0.95 },
  { intent: 'telephony.medication', keywords: ['refill', 'prescription', 'medication'], confidence: 0.8 },
  { intent: 'telephony.appointment', keywords: ['appointment', 'schedule', 'book'], confidence: 0.75 },
  { intent: 'telephony.test.results', keywords: ['results', 'lab', 'test'], confidence: 0.7 },
  { intent: 'telephony.billing', keywords: ['bill', 'payment', 'invoice'], confidence: 0.65 },
];

function parseFloatEnv(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseKeywordConfig(raw: string | undefined): KeywordIntentConfig[] | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as KeywordIntentConfig[];
    if (!Array.isArray(parsed)) return undefined;
    return parsed
      .filter((entry) => typeof entry?.intent === 'string' && Array.isArray(entry?.keywords))
      .map((entry) => ({
        intent: entry.intent.trim(),
        keywords: entry.keywords.map((kw) => kw.toLowerCase().trim()).filter(Boolean),
        confidence: typeof entry.confidence === 'number' ? entry.confidence : undefined,
      }))
      .filter((entry) => entry.intent && entry.keywords.length > 0);
  } catch {
    return undefined;
  }
}

function normaliseKeywordIntents(intents?: KeywordIntentConfig[]): KeywordIntentConfig[] {
  if (!intents) {
    return FALLBACK_KEYWORD_CONFIG;
  }
  if (intents.length === 0) {
    return [];
  }
  return intents.map((entry) => ({
    intent: entry.intent.trim(),
    keywords: entry.keywords.map((kw) => kw.toLowerCase().trim()).filter(Boolean),
    confidence: typeof entry.confidence === 'number' ? entry.confidence : undefined,
  }));
}

const truthy = new Set(['1', 'true', 'yes', 'on', 'enable', 'enabled']);
const falsy = new Set(['0', 'false', 'no', 'off', 'disable', 'disabled']);

function parseIntegerEnv(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseBooleanEnv(value: string | undefined): boolean | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return undefined;
  if (truthy.has(normalized)) return true;
  if (falsy.has(normalized)) return false;
  return undefined;
}

function parseAllowlist(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  return raw
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
}

function isPrivateHost(hostname: string): boolean {
  if (!hostname) return true;
  const lowered = hostname.toLowerCase();
  if (lowered === 'localhost' || lowered.endsWith('.local') || lowered.endsWith('.internal')) {
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
    if (lowered === '::1') return true;
    if (lowered.startsWith('fe80') || lowered.startsWith('fc') || lowered.startsWith('fd')) return true;
  }
  return false;
}

function normalizeEndpoint(endpoint: string, allowInsecure: boolean): URL {
  if (!endpoint || typeof endpoint !== 'string') {
    throw new Error('telephony_intent_endpoint_missing');
  }
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error('telephony_intent_endpoint_invalid');
  }
  if (parsed.protocol !== 'https:' && !allowInsecure) {
    throw new Error('telephony_intent_endpoint_insecure');
  }
  if (isPrivateHost(parsed.hostname)) {
    throw new Error('telephony_intent_endpoint_private');
  }
  return parsed;
}

function buildAllowlist(raw: string[] | undefined, hostname: string): Set<string> {
  const entries = Array.isArray(raw) && raw.length > 0 ? raw : [hostname];
  const allowlist = new Set<string>();
  for (const entry of entries) {
    if (typeof entry !== 'string') continue;
    const trimmed = entry.trim().toLowerCase();
    if (trimmed) {
      allowlist.add(trimmed);
    }
  }
  return allowlist;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const intentServiceLatencyHistogram = createHistogram('telephony.intent_service.latency_ms');
const intentServiceSuccessCounter = createCounter('telephony.intent_service.success_total');
const intentServiceErrorCounter = createCounter('telephony.intent_service.error_total');
const intentServiceTimeoutCounter = createCounter('telephony.intent_service.timeout_total');
const intentServiceRetryCounter = createCounter('telephony.intent_service.retry_total');
const intentServiceFallbackCounter = createCounter('telephony.intent_service.fallback_total');

type IntentServiceErrorCode = 'intent_classifier_timeout' | 'intent_classifier_unavailable' | 'intent_classifier_configuration' | 'intent_classifier_invalid_response';

interface IntentServiceCallContext {
  correlationId?: string;
  headers: Record<string, string>;
  payload: Record<string, unknown>;
}

export class IntentServiceClassifier implements IntentClassifier {
  private readonly endpoint?: URL;
  private readonly apiKey?: string;
  private readonly defaultIntent: string;
  private readonly defaultConfidence: number;
  private readonly keywordIntents: KeywordIntentConfig[];
  private readonly fallback?: IntentClassifier;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly allowlist: Set<string>;
  private readonly fetchImpl?: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly now: () => number;
  private readonly host?: string;

  constructor(options?: IntentServiceClassifierOptions) {
    this.apiKey = options?.apiKey?.trim() || undefined;
    this.defaultIntent = options?.defaultIntent?.trim() || DEFAULT_INTENT;
    const confidence = options?.defaultConfidence;
    this.defaultConfidence = typeof confidence === 'number' && Number.isFinite(confidence) ? confidence : DEFAULT_CONFIDENCE;
    this.keywordIntents = normaliseKeywordIntents(options?.keywordIntents);
    this.fallback = options?.fallback;
    this.timeoutMs = Math.max(100, options?.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    this.maxRetries = Math.max(0, options?.maxRetries ?? DEFAULT_MAX_RETRIES);
    this.baseDelayMs = Math.max(10, options?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS);
    this.maxDelayMs = Math.max(this.baseDelayMs, options?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS);
    this.sleep = options?.sleep ?? ((ms) => delay(ms));
    this.random = options?.random ?? Math.random;
    this.now = options?.now ?? (() => performance.now());
    this.fetchImpl = options?.fetchImpl ?? (globalThis.fetch?.bind(globalThis) as typeof fetch);

    const baseUrl = options?.baseUrl?.trim();
    if (baseUrl) {
      const endpoint = normalizeEndpoint(baseUrl, options?.allowInsecureHttp ?? false);
      this.endpoint = endpoint;
      this.host = endpoint.hostname.toLowerCase();
      this.allowlist = buildAllowlist(options?.hostAllowlist, endpoint.hostname);
      if (!this.allowlist.has(this.host)) {
        throw new Error('telephony_intent_endpoint_not_allowlisted');
      }
      if (!this.fetchImpl || typeof this.fetchImpl !== 'function') {
        throw new Error('telephony_intent_fetch_unavailable');
      }
    } else {
      this.endpoint = undefined;
      this.host = undefined;
      this.allowlist = new Set<string>();
    }
  }

  static fromEnv(): IntentServiceClassifier {
    const baseUrl = process.env.INTENT_SERVICE_URL?.trim();
    const apiKey = process.env.INTENT_SERVICE_API_KEY?.trim();
    const defaultIntent = process.env.INTENT_SERVICE_DEFAULT_INTENT?.trim();
    const defaultConfidence = parseFloatEnv(process.env.INTENT_SERVICE_DEFAULT_CONFIDENCE);
    const keywordConfig = parseKeywordConfig(process.env.INTENT_SERVICE_KEYWORD_INTENTS);
    const fallback = process.env.INTENT_SERVICE_FALLBACK === 'stub' ? new StubIntentClassifier() : undefined;
    const timeoutMs = parseIntegerEnv(process.env.INTENT_SERVICE_TIMEOUT_MS);
    const maxRetries = parseIntegerEnv(process.env.INTENT_SERVICE_MAX_RETRIES);
    const baseDelayMs = parseIntegerEnv(process.env.INTENT_SERVICE_BASE_DELAY_MS);
    const maxDelayMs = parseIntegerEnv(process.env.INTENT_SERVICE_MAX_DELAY_MS);
    const allowInsecure = parseBooleanEnv(process.env.INTENT_SERVICE_ALLOW_INSECURE_HTTP);
    const hostAllowlist = parseAllowlist(process.env.INTENT_SERVICE_HOST_ALLOWLIST);

    return new IntentServiceClassifier({
      baseUrl,
      apiKey,
      defaultIntent,
      defaultConfidence,
      keywordIntents: keywordConfig,
      fallback,
      timeoutMs,
      maxRetries,
      baseDelayMs,
      maxDelayMs,
      hostAllowlist,
      allowInsecureHttp: allowInsecure,
    });
  }

  async classify(input: IntentClassificationInput): Promise<IntentClassificationResult> {
    const rawTranscript = input.transcript ?? '';
    const trimmedTranscript = rawTranscript.trim();
    if (!trimmedTranscript) {
      return this.resolveDefault();
    }

    const transcriptLower = trimmedTranscript.toLowerCase();
    for (const config of this.keywordIntents) {
      if (config.keywords.some((keyword) => transcriptLower.includes(keyword))) {
        return {
          intent: config.intent,
          confidence: config.confidence ?? this.defaultConfidence,
        };
      }
    }

    if (!this.endpoint) {
      return this.resolveDefault();
    }

    try {
      return await this.classifyViaService(input, trimmedTranscript);
    } catch (error) {
      const classifierError =
        error instanceof IntentClassifierError
          ? error
          : new IntentClassifierError('intent_classifier_unavailable', 'intent classifier failed', error);

      if (classifierError.code !== 'intent_classifier_configuration' && this.fallback) {
        try {
          const fallbackResult = await this.fallback.classify(input);
          intentServiceFallbackCounter.add(1, {
            host: this.host ?? 'unconfigured',
            code: classifierError.code,
          });
          logger.warn('telephony.intent.service.fallback', {
            host: this.host,
            code: classifierError.code,
            correlationId: input.correlationId ?? getCorrelationId(),
          });
          return fallbackResult;
        } catch (fallbackError) {
          throw new IntentClassifierError('intent_classifier_unavailable', 'fallback classifier failed', fallbackError);
        }
      }

      throw classifierError;
    }
  }

  private resolveDefault(): IntentClassificationResult {
    return {
      intent: this.defaultIntent,
      confidence: this.defaultConfidence,
    };
  }

  private async classifyViaService(
    input: IntentClassificationInput,
    transcript: string,
  ): Promise<IntentClassificationResult> {
    if (!this.endpoint || !this.fetchImpl) {
      throw new IntentClassifierError('intent_classifier_configuration', 'intent service endpoint not configured');
    }
    const host = this.host ?? this.endpoint.hostname.toLowerCase();
    if (!this.allowlist.has(host)) {
      throw new IntentClassifierError('intent_classifier_configuration', 'intent service endpoint disallowed');
    }

    const correlationId = input.correlationId?.trim() || getCorrelationId();
    const payload: Record<string, unknown> = {
      callId: input.callId,
      transcript,
      lang: input.lang ?? null,
      patientId: input.patientId ?? null,
      practiceId: input.practiceId ?? null,
    };

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json',
    };
    if (this.apiKey) {
      headers['x-api-key'] = this.apiKey;
    }
    if (correlationId) {
      headers['x-correlation-id'] = correlationId;
    }
    const traceparent = currentTraceParent();
    if (traceparent) {
      headers.traceparent = traceparent;
    }

    const context: IntentServiceCallContext = {
      correlationId: correlationId ?? undefined,
      headers,
      payload,
    };

    const span = startSpan('telephony.intent_service.call', {
      attributes: {
        'telephony.intent_service.host': host,
      },
    });

    return await this.executeWithRetries(span, host, context);
  }

  private async executeWithRetries(
    span: import('@opentelemetry/api').Span,
    host: string,
    ctx: IntentServiceCallContext,
  ): Promise<IntentClassificationResult> {
    const maxAttempts = this.maxRetries + 1;
    let attempt = 0;
    let lastError: IntentClassifierError | null = null;

    return await context.with(trace.setSpan(context.active(), span), async () => {
      try {
        while (attempt < maxAttempts) {
          attempt += 1;
          const started = this.now();
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
          try {
            const response = await this.fetchImpl!(this.endpoint!.toString(), {
              method: 'POST',
              headers: ctx.headers,
              body: JSON.stringify(ctx.payload),
              signal: controller.signal,
            });
            clearTimeout(timeout);
            const duration = this.now() - started;
            if (!response.ok) {
              const error = await this.mapHttpError(response);
              this.recordFailure(host, duration, attempt, error, attempt < maxAttempts && this.shouldRetry(error.code));
              lastError = error;
              if (this.shouldRetry(error.code) && attempt < maxAttempts) {
                await this.scheduleRetry(host, attempt);
                continue;
              }
              throw error;
            }

            const result = await this.parseResponse(response);
            this.recordSuccess(host, duration, attempt);
            if (span.isRecording()) {
              span.setStatus({ code: SpanStatusCode.OK });
            }
            return result;
          } catch (error) {
            clearTimeout(timeout);
            const duration = this.now() - started;
            const classifierError =
              error instanceof IntentClassifierError ? error : this.normalizeFetchError(error);
            this.recordFailure(
              host,
              duration,
              attempt,
              classifierError,
              attempt < maxAttempts && this.shouldRetry(classifierError.code),
            );
            lastError = classifierError;
            if (this.shouldRetry(classifierError.code) && attempt < maxAttempts) {
              await this.scheduleRetry(host, attempt);
              continue;
            }
            throw classifierError;
          }
        }
        throw lastError ?? new IntentClassifierError('intent_classifier_unavailable', 'intent classifier failed');
      } finally {
        span.end();
      }
    });
  }

  private async scheduleRetry(host: string, attempt: number): Promise<void> {
    const backoff = this.computeBackoff(attempt);
    intentServiceRetryCounter.add(1, { host, attempt });
    await this.sleep(backoff);
  }

  private computeBackoff(attempt: number): number {
    const exponential = this.baseDelayMs * Math.pow(2, attempt - 1);
    const jitter = Math.floor(this.random() * DEFAULT_BACKOFF_JITTER);
    return Math.min(exponential + jitter, this.maxDelayMs);
  }

  private shouldRetry(code: IntentServiceErrorCode): boolean {
    return code === 'intent_classifier_timeout' || code === 'intent_classifier_unavailable';
  }

  private async parseResponse(response: Response): Promise<IntentClassificationResult> {
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch (error) {
      throw new IntentClassifierError('intent_classifier_invalid_response', 'intent service returned invalid JSON', error);
    }
    if (!isRecord(parsed)) {
      throw new IntentClassifierError('intent_classifier_invalid_response', 'intent service responded with invalid shape');
    }

    const intentRaw = typeof parsed.intent === 'string' ? parsed.intent : undefined;
    const intent = intentRaw?.trim();
    if (!intent) {
      throw new IntentClassifierError('intent_classifier_invalid_response', 'intent service returned empty intent', parsed);
    }

    const confidenceCandidate =
      typeof parsed.confidence === 'number'
        ? parsed.confidence
        : typeof parsed.confidenceScore === 'number'
          ? parsed.confidenceScore
          : undefined;
    const confidence =
      typeof confidenceCandidate === 'number' && Number.isFinite(confidenceCandidate)
        ? confidenceCandidate
        : undefined;

    return {
      intent,
      ...(confidence !== undefined ? { confidence } : {}),
    };
  }

  private async mapHttpError(response: Response): Promise<IntentClassifierError> {
    const bodyText = await response
      .text()
      .catch(() => undefined);

    if (response.status === 401 || response.status === 403) {
      return new IntentClassifierError(
        'intent_classifier_configuration',
        'intent service rejected authentication',
        { status: response.status, body: bodyText },
      );
    }

    if (response.status === 408 || response.status === 504) {
      return new IntentClassifierError('intent_classifier_timeout', 'intent service timed out', {
        status: response.status,
        body: bodyText,
      });
    }

    if (response.status >= 500) {
      return new IntentClassifierError('intent_classifier_unavailable', 'intent service unavailable', {
        status: response.status,
        body: bodyText,
      });
    }

    if (response.status === 429) {
      return new IntentClassifierError('intent_classifier_unavailable', 'intent service rate limited request', {
        status: response.status,
        body: bodyText,
      });
    }

    if (response.status === 400 || response.status === 422) {
      return new IntentClassifierError('intent_classifier_invalid_response', 'intent service rejected payload', {
        status: response.status,
        body: bodyText,
      });
    }

    return new IntentClassifierError('intent_classifier_unavailable', 'intent service request failed', {
      status: response.status,
      body: bodyText,
    });
  }

  private normalizeFetchError(error: unknown): IntentClassifierError {
    if (error instanceof IntentClassifierError) {
      return error;
    }
    const name = (error as { name?: string }).name?.toLowerCase();
    if (name === 'aborterror') {
      return new IntentClassifierError('intent_classifier_timeout', 'intent service request aborted', error);
    }
    const code = (error as { code?: string }).code?.toLowerCase();
    if (code && (code.includes('timeout') || code.includes('econnreset') || code.includes('etimedout'))) {
      return new IntentClassifierError('intent_classifier_timeout', 'intent service network timeout', error);
    }
    return new IntentClassifierError('intent_classifier_unavailable', 'intent service call failed', error);
  }

  private recordSuccess(host: string, duration: number, attempt: number): void {
    intentServiceSuccessCounter.add(1, { host, attempt });
    intentServiceLatencyHistogram.record(duration, {
      host,
      outcome: 'success',
    });
    logger.info('telephony.intent.service.success', {
      host,
      attempt,
      durationMs: duration,
    });
  }

  private recordFailure(
    host: string,
    duration: number,
    attempt: number,
    error: IntentClassifierError,
    retrying: boolean,
  ): void {
    if (error.code === 'intent_classifier_timeout') {
      intentServiceTimeoutCounter.add(1, { host });
    }
    intentServiceErrorCounter.add(1, {
      host,
      code: error.code,
    });
    intentServiceLatencyHistogram.record(duration, {
      host,
      outcome: 'failure',
      code: error.code,
    });
    logger.warn('telephony.intent.service.failure', {
      host,
      attempt,
      durationMs: duration,
      code: error.code,
      retrying,
    });
  }
}
