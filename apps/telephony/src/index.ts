import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import type { Socket } from 'node:net';
import { performance } from 'node:perf_hooks';
import { SpanStatusCode } from '@opentelemetry/api';

import {
  logger,
  setCorrelationId,
  createHistogram,
  createCounter,
  createGauge,
  withCorrelationContext,
  startSpan,
} from '@onecare/observability';
import type { MessageBus } from '@onecare/bus';
import type { IdempotencyStore } from '@onecare/ports';
import type { TelephonyRateLimitConfig, TokenBucketRateLimitConfig } from '@onecare/config';

import { applyTelephonyDependencies } from './application/bootstrap';
import {
  CallReceivedState,
  LanguageSelectionState,
  TranscribedState,
  IntentClassifiedState,
  EmergencyTransferState,
  RoutedState,
} from './application/telephony.state';
import type { TelephonyContext } from './application/types';
import { TelephonyContractError } from './application/errors';
import { errorEnvelope, mapErrorToStatus, type ErrorCode, type ErrorEnvelope } from './application/error';
import type { CallMetadata } from './adapters/ivr.adapter';
import type { AsrClient } from './adapters/asr.client';
import { AsrClientError } from './adapters/asr.client';
import type { IntentClassifier } from './application/types';
import { IntentClassifierError } from './adapters/intent.classifier';

const JSON_CONTENT_TYPE = 'application/json';
const DEFAULT_BODY_LIMIT = 256 * 1024;
const DEFAULT_MAX_CONCURRENCY = 32;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000;
const READINESS_CACHE_MIN_MS = 250;
const DEFAULT_READINESS_CACHE_MS = 1_000;

const httpDuration = createHistogram('telephony_http_duration_ms');
const queueGauge = createGauge('telephony.queue');
const rejectCounter = createCounter('telephony.reject');
const rateLimitHitCounter = createCounter('telephony.ratelimit.hit');
const rateLimitMissCounter = createCounter('telephony.ratelimit.miss');

interface TelephonyIngressOptions {
  bus: MessageBus;
  idempotencyStore?: IdempotencyStore;
  idempotencyTtlSeconds?: number;
  asrClient?: AsrClient;
  intentClassifier?: IntentClassifier;
  maxConcurrency?: number;
  rateLimit?: TelephonyRateLimitConfig;
  readinessCheck?: () => Promise<boolean>;
  shutdownGraceMs?: number;
  now?: () => number;
}

export interface TelephonyHttpServer extends http.Server {
  initiateShutdown(timeoutMs?: number): Promise<void>;
}

interface TelephonyRequestBody {
  callId?: unknown;
  audioRef?: unknown;
  patientId?: unknown;
  selectedLanguage?: unknown;
  metadata?: unknown;
  correlationId?: unknown;
  idempotency?: unknown;
}

interface NormalisedTelephonyRequest {
  callId: string;
  audioRef: string;
  patientId?: string | null;
  selectedLanguage?: string;
  metadata?: CallMetadata;
  correlationId?: string;
  idempotency?: {
    pipeline?: string;
    callTranscribed?: string;
    intentClassified?: string;
    triage?: string;
  };
}

interface RateLimitOutcome {
  allowed: boolean;
  scope?: 'caller' | 'practice';
  retryAfterSeconds?: number;
}

interface BucketTakeResult {
  allowed: boolean;
  retryAfterSeconds?: number;
}

interface ReadinessStatus {
  ok: boolean;
  reason?: string;
  checkedAt: number;
}

interface ReadinessManager {
  check(): Promise<ReadinessStatus>;
  markShutdown(): void;
  isShuttingDown(): boolean;
  getStatus(): ReadinessStatus | null;
}

class TokenBucket {
  private tokens: number;
  private lastRefillMs: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
    initialNow: number,
  ) {
    this.tokens = Math.max(0, capacity);
    this.lastRefillMs = initialNow;
  }

  take(nowMs: number, amount = 1): BucketTakeResult {
    this.refill(nowMs);
    if (this.tokens >= amount) {
      this.tokens -= amount;
      return { allowed: true };
    }

    if (this.refillPerSecond <= 0) {
      return { allowed: false };
    }
    const deficit = amount - this.tokens;
    const seconds = deficit / this.refillPerSecond;
    return {
      allowed: false,
      retryAfterSeconds: seconds > 0 ? seconds : 0,
    };
  }

  private refill(nowMs: number): void {
    if (nowMs <= this.lastRefillMs) {
      return;
    }
    if (this.refillPerSecond <= 0) {
      this.lastRefillMs = nowMs;
      return;
    }
    const elapsedMs = nowMs - this.lastRefillMs;
    if (elapsedMs <= 0) {
      return;
    }
    const tokensToAdd = (elapsedMs / 1000) * this.refillPerSecond;
    if (tokensToAdd > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + tokensToAdd);
    }
    this.lastRefillMs = nowMs;
  }
}

interface CacheEntry {
  bucket: TokenBucket;
  lastAccessMs: number;
}

class BucketCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly ttlMs: number;

  constructor(
    private readonly config: TokenBucketRateLimitConfig,
    private readonly now: () => number,
  ) {
    this.ttlMs = Math.max(0, (config.ttlSeconds ?? 0) * 1000);
  }

  get(key: string, nowMs: number): TokenBucket {
    this.evictExpired(nowMs);
    let entry = this.entries.get(key);
    if (entry) {
      entry.lastAccessMs = nowMs;
      return entry.bucket;
    }
    const bucket = new TokenBucket(
      this.config.capacity,
      this.config.refillPerSecond,
      nowMs,
    );
    entry = { bucket, lastAccessMs: nowMs };
    this.entries.set(key, entry);
    this.trim();
    return bucket;
  }

  private evictExpired(nowMs: number): void {
    if (this.ttlMs <= 0) {
      return;
    }
    const expiry = nowMs - this.ttlMs;
    for (const [key, entry] of this.entries) {
      if (entry.lastAccessMs <= expiry) {
        this.entries.delete(key);
      }
    }
  }

  private trim(): void {
    const limit = Math.max(1, this.config.maxEntries);
    while (this.entries.size > limit) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.entries.delete(oldest);
    }
  }
}

class TelephonyRateLimiter {
  private readonly callerBuckets?: BucketCache;
  private readonly practiceBuckets?: BucketCache;

  constructor(private readonly config: TelephonyRateLimitConfig | undefined, private readonly now: () => number) {
    if (config?.caller) {
      this.callerBuckets = new BucketCache(config.caller, now);
    }
    if (config?.practice) {
      this.practiceBuckets = new BucketCache(config.practice, now);
    }
  }

  evaluate(keys: { callerKey?: string | null; practiceKey?: string | null }): RateLimitOutcome {
    if (!this.callerBuckets && !this.practiceBuckets) {
      return { allowed: true };
    }

    const nowMs = this.now();

    if (this.callerBuckets && keys.callerKey) {
      const bucket = this.callerBuckets.get(keys.callerKey, nowMs);
      const result = bucket.take(nowMs, 1);
      if (!result.allowed) {
        return {
          allowed: false,
          scope: 'caller',
          retryAfterSeconds: resolveRetryAfterSeconds(result, this.config!.caller!),
        };
      }
      rateLimitMissCounter.add(1, { scope: 'caller' });
    }

    if (this.practiceBuckets && keys.practiceKey) {
      const bucket = this.practiceBuckets.get(keys.practiceKey, nowMs);
      const result = bucket.take(nowMs, 1);
      if (!result.allowed) {
        return {
          allowed: false,
          scope: 'practice',
          retryAfterSeconds: resolveRetryAfterSeconds(result, this.config!.practice!),
        };
      }
      rateLimitMissCounter.add(1, { scope: 'practice' });
    }

    return { allowed: true };
  }
}

class ConcurrencyGate {
  private readonly limit: number;
  private active = 0;

  constructor(limit?: number) {
    this.limit = typeof limit === 'number' && limit > 0 ? Math.floor(limit) : DEFAULT_MAX_CONCURRENCY;
  }

  tryAcquire(): boolean {
    if (this.limit <= 0) {
      return true;
    }
    if (this.active >= this.limit) {
      return false;
    }
    this.active += 1;
    queueGauge.set(this.active);
    return true;
  }

  release(): void {
    if (this.active > 0) {
      this.active -= 1;
    }
    queueGauge.set(this.active);
  }

  getActive(): number {
    return this.active;
  }
}

function resolveRetryAfterSeconds(result: BucketTakeResult, config: TokenBucketRateLimitConfig): number | undefined {
  if (result.retryAfterSeconds !== undefined) {
    return result.retryAfterSeconds;
  }
  if (config.refillPerSecond > 0) {
    const seconds = 1 / config.refillPerSecond;
    return seconds > 0 ? seconds : 1;
  }
  if (config.ttlSeconds > 0) {
    return config.ttlSeconds;
  }
  return undefined;
}

function normalizePath(url?: string | null): string {
  if (!url) {
    return '/';
  }
  try {
    const parsed = new URL(url, 'http://localhost');
    return parsed.pathname || '/';
  } catch {
    const [path] = url.split('?');
    return path || '/';
  }
}

function ensureRequestCorrelationId(req: IncomingMessage, res: ServerResponse): string {
  const header = typeof req.headers['x-correlation-id'] === 'string' ? req.headers['x-correlation-id'] : undefined;
  const candidate = header?.trim();
  const correlationId = candidate && candidate.length > 0 ? candidate : randomUUID();
  res.setHeader('x-correlation-id', correlationId);
  setCorrelationId(correlationId);
  return correlationId;
}

async function readJsonBody(req: IncomingMessage, limit = DEFAULT_BODY_LIMIT): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > limit) {
      throw new Error('payload_too_large');
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) {
    return {};
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    logger.warn('telephony.ingress.invalid_json', {
      reason: error instanceof Error ? error.message : 'unknown_error',
    });
    throw new Error('invalid_json');
  }
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader('content-type', JSON_CONTENT_TYPE);
  res.setHeader('content-length', Buffer.byteLength(body));
  res.end(body);
}

function asString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeMetadata(raw: unknown): CallMetadata | undefined {
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }
  const metadata = raw as Record<string, unknown>;
  const callerId = asString(metadata.callerId);
  const practiceId = asString(metadata.practiceId);
  const dialedNumber = asString(metadata.dialedNumber ?? metadata.dialledNumber);
  const correlationId = asString(metadata.correlationId ?? metadata.correlation_id);
  const attributes = typeof metadata.attributes === 'object' && metadata.attributes !== null
    ? Object.fromEntries(
        Object.entries(metadata.attributes as Record<string, unknown>)
          .filter(([, value]) => typeof value === 'string')
          .map(([key, value]) => [key, String(value)]),
      )
    : undefined;
  return {
    ...(callerId ? { callerId } : {}),
    ...(practiceId ? { practiceId } : {}),
    ...(dialedNumber ? { dialedNumber } : {}),
    ...(correlationId ? { correlationId } : {}),
    ...(attributes ? { attributes } : {}),
  };
}

function normaliseIdempotency(raw: unknown): NormalisedTelephonyRequest['idempotency'] {
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const pipeline = asString(record.pipeline);
  const callTranscribed = asString(record.callTranscribed ?? record.call_transcribed);
  const intentClassified = asString(record.intentClassified ?? record.intent_classified);
  const triage = asString(record.triage ?? record.triageInput ?? record.triage_input);
  if (!pipeline && !callTranscribed && !intentClassified && !triage) {
    return undefined;
  }
  return {
    ...(pipeline ? { pipeline } : {}),
    ...(callTranscribed ? { callTranscribed } : {}),
    ...(intentClassified ? { intentClassified } : {}),
    ...(triage ? { triage } : {}),
  };
}

function normaliseRequest(body: TelephonyRequestBody): NormalisedTelephonyRequest {
  const callId = asString(body.callId);
  const audioRef = asString(body.audioRef);
  if (!callId || !audioRef) {
    throw new Error('invalid_request');
  }
  const patientId = body.patientId === null ? null : asString(body.patientId);
  const selectedLanguage = asString(body.selectedLanguage);
  const metadata = normalizeMetadata(body.metadata);
  const correlationId = asString(body.correlationId);
  const idempotency = normaliseIdempotency(body.idempotency);
  return {
    callId,
    audioRef,
    patientId: patientId ?? undefined,
    selectedLanguage,
    metadata,
    correlationId,
    idempotency,
  };
}

function hashIdentifier(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function createReadinessManager(options: TelephonyIngressOptions): ReadinessManager {
  const cacheMs = Math.max(READINESS_CACHE_MIN_MS, DEFAULT_READINESS_CACHE_MS);
  let shuttingDown = false;
  let lastStatus: ReadinessStatus | null = null;
  let inFlight: Promise<ReadinessStatus> | null = null;

  const runProbe = async (): Promise<ReadinessStatus> => {
    if (typeof options.readinessCheck === 'function') {
      try {
        const ok = await options.readinessCheck();
        return { ok: Boolean(ok), reason: ok ? undefined : 'dependency_unavailable', checkedAt: Date.now() };
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : 'unknown_error', checkedAt: Date.now() };
      }
    }
    return { ok: true, checkedAt: Date.now() };
  };

  const evaluate = async (): Promise<ReadinessStatus> => {
    const status = await runProbe();
    lastStatus = status;
    return status;
  };

  return {
    async check(): Promise<ReadinessStatus> {
      if (shuttingDown) {
        const status: ReadinessStatus = { ok: false, reason: 'shutting_down', checkedAt: Date.now() };
        lastStatus = status;
        return status;
      }
      const now = Date.now();
      if (lastStatus && now - lastStatus.checkedAt < cacheMs) {
        return lastStatus;
      }
      if (!inFlight) {
        inFlight = evaluate().finally(() => {
          inFlight = null;
        });
      }
      return inFlight;
    },
    markShutdown(): void {
      shuttingDown = true;
      lastStatus = { ok: false, reason: 'shutting_down', checkedAt: Date.now() };
    },
    isShuttingDown(): boolean {
      return shuttingDown;
    },
    getStatus(): ReadinessStatus | null {
      return lastStatus;
    },
  };
}

function mapIngressError(error: unknown): { code: ErrorCode; message: string; details?: Record<string, unknown> } {
  if (error instanceof TelephonyContractError) {
    return {
      code: 'invalid_input',
      message: error.message,
      details: { errors: error.details },
    };
  }

  if (error instanceof AsrClientError) {
    switch (error.code) {
      case 'call_id_required':
      case 'audio_ref_required':
      case 'transcript_required':
        return { code: 'invalid_input', message: error.message };
      case 'asr_timeout':
        return { code: 'upstream_timeout', message: error.message };
      case 'asr_circuit_open':
        return { code: 'over_capacity', message: error.message };
      case 'asr_unreachable':
        return { code: 'upstream_unavailable', message: error.message };
      case 'asr_invalid_response':
        return { code: 'upstream_unavailable', message: error.message };
      default:
        return { code: 'internal_error', message: error.message };
    }
  }

  if (error instanceof IntentClassifierError) {
    switch (error.code) {
      case 'intent_classifier_timeout':
        return { code: 'upstream_timeout', message: error.message };
      case 'intent_classifier_unavailable':
        return { code: 'upstream_unavailable', message: error.message };
      case 'intent_classifier_configuration':
        return { code: 'internal_error', message: error.message };
      case 'intent_classifier_invalid_response':
        return { code: 'upstream_unavailable', message: error.message };
      default:
        return { code: 'internal_error', message: error.message };
    }
  }

  if (error instanceof Error) {
    if (error.message === 'invalid_json') {
      return { code: 'invalid_input', message: 'Request body must be valid JSON' };
    }
    if (error.message === 'payload_too_large') {
      return { code: 'payload_too_large', message: 'Request body exceeds allowed size' };
    }
    if (error.message === 'invalid_request') {
      return { code: 'invalid_input', message: 'callId and audioRef are required' };
    }
    return { code: 'internal_error', message: error.message };
  }

  return { code: 'internal_error', message: 'Unexpected error' };
}

function buildSuccessPayload(ctx: TelephonyContext, correlationId: string): Record<string, unknown> {
  return {
    ok: true,
    callId: ctx.callId,
    correlationId,
    duplicate: Boolean(ctx.pipelineDuplicate),
    intent: ctx.intentClassified?.intent ?? null,
    decision: ctx.intentRoutingDecision ?? null,
    target: ctx.intentRouteTarget ?? null,
    reason: ctx.intentRouteReason ?? null,
    emergencyTransfer: Boolean(ctx.emergencyTransferTriggered && ctx.emergencyTransferEnabled),
  };
}

export function createTelephonyServer(options: TelephonyIngressOptions): TelephonyHttpServer {
  const maxConcurrency = options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
  const concurrency = new ConcurrencyGate(maxConcurrency);
  const rateLimiter = new TelephonyRateLimiter(options.rateLimit, options.now ?? Date.now);
  const readiness = createReadinessManager(options);
  const shutdownGraceMs = options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;

  const callReceivedState = new CallReceivedState();
  const languageSelectionState = new LanguageSelectionState();
  const transcribedState = new TranscribedState();
  const intentClassifiedState = new IntentClassifiedState();
  const emergencyState = new EmergencyTransferState();
  const routedState = new RoutedState();

  let shuttingDown = false;
  const sockets = new Set<Socket>();

  const server = http.createServer(async (req, res) => {
    const started = performance.now();
    const method = req.method ?? 'GET';
    const path = normalizePath(req.url);
    const correlationId = ensureRequestCorrelationId(req, res);

    const recordDuration = (status: number, outcome: string): void => {
      const duration = performance.now() - started;
      httpDuration.record(duration, { method, path, status, outcome });
    };

    try {
      if (method === 'GET' && path === '/healthz') {
        sendJson(res, 200, { ok: true });
        recordDuration(200, 'health');
        return;
      }

      if (method === 'GET' && path === '/readyz') {
        const status = await readiness.check();
        const httpStatus = status.ok ? 200 : 503;
        sendJson(res, httpStatus, { ok: status.ok, reason: status.reason });
        recordDuration(httpStatus, 'ready');
        return;
      }

      if (shuttingDown || readiness.isShuttingDown()) {
        const envelope = errorEnvelope('over_capacity', 'Telephony ingress shutting down', {}, correlationId);
        sendJson(res, 503, envelope);
        recordDuration(503, 'shutting_down');
        return;
      }

      if (method !== 'POST' || path !== '/calls') {
        const envelope = errorEnvelope('invalid_input', 'Route not found', { path, method }, correlationId);
        sendJson(res, 404, envelope);
        recordDuration(404, 'not_found');
        return;
      }

      if (!concurrency.tryAcquire()) {
        rejectCounter.add(1, { reason: 'over_capacity' });
        const envelope = errorEnvelope('over_capacity', 'Telephony pipeline is saturated', undefined, correlationId);
        sendJson(res, 503, envelope);
        recordDuration(503, 'over_capacity');
        return;
      }

      try {
        const rawBody = await readJsonBody(req, DEFAULT_BODY_LIMIT);
        const body = normaliseRequest(rawBody as TelephonyRequestBody);

        const callerKey = body.metadata?.callerId ? hashIdentifier(body.metadata.callerId) : undefined;
        const practiceKey = body.metadata?.practiceId ? body.metadata.practiceId : undefined;
        const rateOutcome = rateLimiter.evaluate({ callerKey, practiceKey });
        if (!rateOutcome.allowed) {
          rejectCounter.add(1, { reason: 'rate_limit' });
          rateLimitHitCounter.add(1, { scope: rateOutcome.scope ?? 'unknown' });
          if (rateOutcome.retryAfterSeconds !== undefined) {
            res.setHeader('retry-after', Math.max(1, Math.round(rateOutcome.retryAfterSeconds)));
          }
          const envelope = errorEnvelope('rate_limited', 'Rate limit exceeded', { scope: rateOutcome.scope }, correlationId);
          sendJson(res, 429, envelope);
          recordDuration(429, 'rate_limited');
          return;
        }

        const ctx: TelephonyContext = applyTelephonyDependencies({
          id: body.callId,
          callId: body.callId,
          audioRef: body.audioRef,
          patientId: body.patientId ?? undefined,
          metadata: body.metadata,
          correlationId: body.correlationId ?? correlationId,
          selectedLanguage: body.selectedLanguage,
          bus: options.bus,
          idempotencyStore: options.idempotencyStore,
          idempotencyTtlSeconds: options.idempotencyTtlSeconds,
          callTranscribedIdempotencyKey: body.idempotency?.callTranscribed,
          intentClassifiedIdempotencyKey: body.idempotency?.intentClassified,
          triagePublishIdempotencyKey: body.idempotency?.triage,
          pipelineIdempotencyKey: body.idempotency?.pipeline,
          asrClient: options.asrClient,
          intentClassifier: options.intentClassifier,
          ivrPrompts: [],
          enqueuePrompt: async () => undefined,
          now: options.now ?? Date.now,
        } as TelephonyContext);

        await withCorrelationContext(async () => {
          setCorrelationId(ctx.correlationId ?? correlationId);
          const pipelineSpan = startSpan('telephony.pipeline');
          pipelineSpan.setAttribute('telephony.call_id', ctx.callId);
          pipelineSpan.setAttribute('telephony.practice_id', ctx.metadata?.practiceId ?? 'unknown');
          try {
            await callReceivedState.handle(ctx, { type: 'telephony.call.received' });
            await languageSelectionState.handle(ctx, { type: 'telephony.language.selection' });
            await transcribedState.handle(ctx, { type: 'telephony.call.transcribed' });
            await intentClassifiedState.handle(ctx, { type: 'telephony.intent.classified' });
            if (ctx.emergencyTransferTriggered && ctx.emergencyTransferEnabled) {
              await emergencyState.handle(ctx, { type: 'telephony.emergency_transfer' });
            }
            await routedState.handle(ctx, { type: 'telephony.call.routed' });
          } catch (error) {
            pipelineSpan.recordException(error as Error);
            pipelineSpan.setStatus({
              code: SpanStatusCode.ERROR,
              message: error instanceof Error ? error.message : 'pipeline_failed',
            });
            throw error;
          } finally {
            pipelineSpan.end();
          }
        });

        const payload = buildSuccessPayload(ctx, correlationId);
        sendJson(res, 202, payload);
        recordDuration(202, 'accepted');
      } catch (error) {
        const mapped = mapIngressError(error);
        const envelope: ErrorEnvelope = errorEnvelope(mapped.code, mapped.message, mapped.details, correlationId);
        const status = mapErrorToStatus(mapped.code);
        if (mapped.code === 'rate_limited') {
          rejectCounter.add(1, { reason: 'rate_limit' });
        }
        sendJson(res, status, envelope);
        recordDuration(status, 'error');
      } finally {
        concurrency.release();
      }
    } catch (error) {
      const mapped = mapIngressError(error);
      const envelope: ErrorEnvelope = errorEnvelope(mapped.code, mapped.message, mapped.details, correlationId);
      const status = mapErrorToStatus(mapped.code);
      sendJson(res, status, envelope);
      recordDuration(status, 'fatal_error');
    }
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  async function initiateShutdown(timeoutMs = shutdownGraceMs): Promise<void> {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    readiness.markShutdown();
    server.close();
    await Promise.race([
      new Promise<void>((resolve) => {
        if (server.listening) {
          server.on('close', () => resolve());
          sockets.forEach((socket) => socket.end());
        } else {
          resolve();
        }
      }),
      new Promise<void>((resolve) => {
        setTimeout(() => {
          sockets.forEach((socket) => socket.destroy());
          resolve();
        }, timeoutMs);
      }),
    ]);
  }

  (server as TelephonyHttpServer).initiateShutdown = initiateShutdown;
  return server as TelephonyHttpServer;
}

export type { TelephonyIngressOptions };
