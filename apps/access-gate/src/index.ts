import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';

import type { AccessGateConfig, TokenBucketRateLimitConfig } from '@onecare/config';
import { loadConfig } from '@onecare/config';
import { hashIdentifier } from '@onecare/security';
import { createCounter, logger, setCorrelationId, withCorrelationContext } from '@onecare/observability';
import type { PortalGuardHandle } from './scheduler';

const rateLimitHitCounter = createCounter('rate.limit.hit');
const rateLimitBlockCounter = createCounter('rate.limit.block');
const shutdownStartCounter = createCounter('shutdown.start');
const shutdownTimeoutCounter = createCounter('shutdown.timeout');
const SHUTDOWN_TIMEOUT_MS = 10_000;

interface ReadinessTracker {
  draining: boolean;
}

const readinessTracker: ReadinessTracker = { draining: false };
let portalGuardHandle: PortalGuardHandle | undefined;

export function setPortalSchedulerForHealth(handle: PortalGuardHandle | undefined): void {
  portalGuardHandle = handle;
}

export function resetPortalSchedulerForHealth(): void {
  portalGuardHandle = undefined;
  readinessTracker.draining = false;
}

function markServiceDraining(): void {
  readinessTracker.draining = true;
}

function isAccessGateReady(): boolean {
  if (readinessTracker.draining) return false;
  if (!portalGuardHandle) return true;
  const status = portalGuardHandle.status();
  if (status.draining) return false;
  if (!status.ready) return false;
  return true;
}

type RateLimitScope = 'tenant' | 'account';

interface BucketEvaluation {
  scope: RateLimitScope;
  allowed: boolean;
  retryAfterSeconds?: number;
}

interface RateLimitCheckResult {
  allowed: boolean;
  evaluations: BucketEvaluation[];
  blocking?: BucketEvaluation;
}

interface RateLimitIdentity {
  tenantId: string;
  accountId?: string | null;
}

interface BucketTakeResult {
  allowed: boolean;
  retryAfterSeconds?: number;
}

function resolveRetryAfterSeconds(
  result: BucketTakeResult,
  config: TokenBucketRateLimitConfig,
): number | undefined {
  if (result.retryAfterSeconds !== undefined) return result.retryAfterSeconds;
  if (config.refillPerSecond > 0) {
    const seconds = 1 / config.refillPerSecond;
    return seconds > 0 ? seconds : 1;
  }
  return config.ttlSeconds > 0 ? config.ttlSeconds : undefined;
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
    const required = amount - this.tokens;
    const seconds = required / this.refillPerSecond;
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
    private readonly bucketConfig: TokenBucketRateLimitConfig,
    private readonly now: () => number,
  ) {
    this.ttlMs = Math.max(0, bucketConfig.ttlSeconds * 1000);
  }

  get(key: string, nowMs: number): TokenBucket {
    this.evictExpired(nowMs);
    let entry = this.entries.get(key);
    if (entry) {
      entry.lastAccessMs = nowMs;
      this.promote(key, entry);
      return entry.bucket;
    }
    const bucket = new TokenBucket(
      this.bucketConfig.capacity,
      this.bucketConfig.refillPerSecond,
      nowMs,
    );
    entry = { bucket, lastAccessMs: nowMs };
    this.entries.set(key, entry);
    this.trim();
    return bucket;
  }

  private evictExpired(nowMs: number): void {
    if (this.ttlMs <= 0) return;
    const expiryThreshold = nowMs - this.ttlMs;
    for (const [key, entry] of this.entries) {
      if (entry.lastAccessMs <= expiryThreshold) {
        this.entries.delete(key);
      }
    }
  }

  private trim(): void {
    const limit = Math.max(1, this.bucketConfig.maxEntries);
    while (this.entries.size > limit) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  private promote(key: string, entry: CacheEntry): void {
    this.entries.delete(key);
    this.entries.set(key, entry);
  }
}

class AccessRateLimiter {
  private readonly tenantBuckets: BucketCache;
  private readonly accountBuckets: BucketCache;

  constructor(
    private readonly config: AccessGateConfig['rateLimit'],
    private readonly now: () => number,
  ) {
    this.tenantBuckets = new BucketCache(config.tenant, now);
    this.accountBuckets = new BucketCache(config.account, now);
  }

  check(identity: RateLimitIdentity): RateLimitCheckResult {
    const nowMs = this.now();
    const evaluations: BucketEvaluation[] = [];

    const tenantBucket = this.tenantBuckets.get(identity.tenantId, nowMs);
    const tenantOutcome = tenantBucket.take(nowMs, 1);
    const tenantEvaluation: BucketEvaluation = {
      scope: 'tenant',
      allowed: tenantOutcome.allowed,
      retryAfterSeconds: tenantOutcome.allowed
        ? undefined
        : resolveRetryAfterSeconds(tenantOutcome, this.config.tenant),
    };
    evaluations.push(tenantEvaluation);
    if (!tenantOutcome.allowed) {
      return { allowed: false, evaluations, blocking: tenantEvaluation };
    }

    const accountId = identity.accountId;
    if (!accountId) {
      return { allowed: true, evaluations };
    }

    const accountKey = `${identity.tenantId}::${accountId}`;
    const accountBucket = this.accountBuckets.get(accountKey, nowMs);
    const accountOutcome = accountBucket.take(nowMs, 1);
    const accountEvaluation: BucketEvaluation = {
      scope: 'account',
      allowed: accountOutcome.allowed,
      retryAfterSeconds: accountOutcome.allowed
        ? undefined
        : resolveRetryAfterSeconds(accountOutcome, this.config.account),
    };
    evaluations.push(accountEvaluation);
    if (!accountOutcome.allowed) {
      return { allowed: false, evaluations, blocking: accountEvaluation };
    }
    return { allowed: true, evaluations };
  }
}

function getHeader(headers: IncomingMessage['headers'], name: string): string | undefined {
  const lower = name.toLowerCase();
  const raw = headers[lower] ?? headers[name];
  if (Array.isArray(raw)) return raw[0];
  if (typeof raw === 'string') return raw;
  return undefined;
}

function normalizeCorrelationId(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function resolveTenantId(req: IncomingMessage): string {
  const raw = getHeader(req.headers, 'x-practice-id') ?? getHeader(req.headers, 'x-tenant-id');
  const trimmed = raw?.trim();
  if (!trimmed) return 'unknown';
  return trimmed;
}

function resolveAccountId(req: IncomingMessage): string | null {
  const raw =
    getHeader(req.headers, 'x-account-id') ??
    getHeader(req.headers, 'x-actor-id') ??
    getHeader(req.headers, 'x-patient-id');
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  return trimmed;
}

function toAccountMetricValue(accountHash: string | null): string {
  return accountHash ?? 'none';
}

function toRetryAfterSeconds(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value)) return undefined;
  if (value <= 0) return 1;
  return Math.max(1, Math.ceil(value));
}

export interface IngressContext {
  correlationId: string;
  tenantId: string;
  accountId: string | null;
  accountHash: string | null;
}

function getRequestPath(url: string | undefined): string {
  if (!url || url.length === 0) return '/';
  try {
    const parsed = new URL(url, 'http://localhost');
    return parsed.pathname || '/';
  } catch {
    const base = url.split('?')[0] ?? '';
    return base || '/';
  }
}

function handleProbeRequest(req: IncomingMessage, res: ServerResponse): boolean {
  if (req.method !== 'GET') return false;
  const pathname = getRequestPath(req.url);
  if (pathname === '/healthz') {
    res.statusCode = 200;
    res.setHeader('cache-control', 'no-store, max-age=0');
    res.setHeader('content-type', 'text/plain');
    res.end('ok');
    return true;
  }
  if (pathname === '/readyz') {
    const ready = isAccessGateReady();
    res.statusCode = ready ? 200 : 503;
    res.setHeader('cache-control', 'no-store, max-age=0');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ status: ready ? 'ready' : 'not_ready' }));
    return true;
  }
  return false;
}

export type IngressHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  context: IngressContext,
) => Promise<void> | void;

export interface AccessGateIngressOptions {
  config: AccessGateConfig;
  now?: () => number;
}

export function createAccessGateHandler(options: AccessGateIngressOptions, next: IngressHandler) {
  const nowFn = options.now ?? (() => Date.now());
  const limiter = new AccessRateLimiter(options.config.rateLimit, nowFn);

  return (req: IncomingMessage, res: ServerResponse): void => {
    withCorrelationContext(() => {
      const correlationId = normalizeCorrelationId(getHeader(req.headers, 'x-correlation-id')) ?? randomUUID();
      setCorrelationId(correlationId);
      res.setHeader('x-correlation-id', correlationId);

      const tenantId = resolveTenantId(req);
      const accountId = resolveAccountId(req);
      const accountHash = accountId ? hashIdentifier(accountId) : null;

      const result = limiter.check({ tenantId, accountId });
      for (const evaluation of result.evaluations) {
        const attributes: Record<string, unknown> = {
          scope: evaluation.scope,
          tenant: tenantId,
          account: toAccountMetricValue(accountHash),
        };
        if (evaluation.allowed) {
          rateLimitHitCounter.add(1, attributes);
        } else {
          const retryAfterRounded = toRetryAfterSeconds(evaluation.retryAfterSeconds);
          if (retryAfterRounded !== undefined) {
            attributes.retryAfterSeconds = retryAfterRounded;
          }
          rateLimitBlockCounter.add(1, attributes);
        }
      }

      if (!result.allowed) {
        const retryAfterSeconds = toRetryAfterSeconds(result.blocking?.retryAfterSeconds);
        if (retryAfterSeconds !== undefined) {
          res.setHeader('retry-after', retryAfterSeconds.toString());
        }
        res.statusCode = 429;
        res.setHeader('cache-control', 'no-store, max-age=0');
        res.setHeader('content-type', 'application/json');
        logger.warn('access.rate.limit.block', {
          scope: result.blocking?.scope ?? 'tenant',
          tenantId,
          accountHash,
          retryAfterSeconds,
          correlationId,
        });
        res.end(JSON.stringify({ error: { code: 'rate_limited', correlationId } }));
        return;
      }

      try {
        const maybePromise = next(req, res, {
          correlationId,
          tenantId,
          accountId,
          accountHash,
        });
        if (maybePromise && typeof (maybePromise as Promise<unknown>).then === 'function') {
          (maybePromise as Promise<unknown>).catch((error) => {
            handleHandlerError(error, res, correlationId, tenantId);
          });
        }
      } catch (error) {
        handleHandlerError(error, res, correlationId, tenantId);
      }
    });
  };
}

export interface AccessGateServerOptions {
  config: AccessGateConfig;
  ingress?: IngressHandler;
  now?: () => number;
}

const DEFAULT_FALLBACK_HANDLER: IngressHandler = (_req, res, context) => {
  if (res.writableEnded) return;
  res.statusCode = 404;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ error: { code: 'not_found', correlationId: context.correlationId } }));
};

export function createAccessGateServer(options: AccessGateServerOptions): http.Server {
  const ingress = options.ingress ?? DEFAULT_FALLBACK_HANDLER;
  const handler = createAccessGateHandler(
    { config: options.config, now: options.now },
    ingress,
  );
  return http.createServer((req, res) => {
    if (handleProbeRequest(req, res)) {
      return;
    }
    handler(req, res);
  });
}

let shuttingDown = false;

async function initiateShutdown(signal: NodeJS.Signals, server: http.Server): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  markServiceDraining();
  shutdownStartCounter.add(1, { component: 'access-gate', signal });
  logger.info('access.shutdown.start', { signal });

  const drainPromise = (() => {
    if (!portalGuardHandle) return Promise.resolve<'completed'>('completed');
    return portalGuardHandle
      .drain({ timeoutMs: SHUTDOWN_TIMEOUT_MS })
      .then((result) => {
        if (result === 'completed') {
          portalGuardHandle?.cancel();
        }
        return result;
      })
      .catch((error) => {
        logger.error('access.shutdown.scheduler_error', {
          signal,
          reason: error instanceof Error ? error.message : String(error),
        });
        return 'timeout' as const;
      });
  })();

  const closePromise = new Promise<'closed' | 'timeout'>((resolve) => {
    let finished = false;
    const settle = (outcome: 'closed' | 'timeout') => {
      if (finished) return;
      finished = true;
      resolve(outcome);
    };
    server.close((err) => {
      if (err) {
        logger.error('access.shutdown.server_close_failed', {
          signal,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
      settle('closed');
    });
    setTimeout(() => settle('timeout'), SHUTDOWN_TIMEOUT_MS);
  });

  const [drainResult, closeResult] = await Promise.all([drainPromise, closePromise]);

  if (drainResult === 'timeout') {
    shutdownTimeoutCounter.add(1, { component: 'scheduler', signal });
    logger.warn('access.shutdown.scheduler_timeout', { signal });
  }
  if (closeResult === 'timeout') {
    shutdownTimeoutCounter.add(1, { component: 'server', signal });
    logger.warn('access.shutdown.server_timeout', { signal });
  }

  if (process.env.NODE_ENV !== 'test') {
    const exitCode = closeResult === 'timeout' ? 1 : 0;
    process.exit(exitCode);
  }
}

function installSignalHandlers(server: http.Server): void {
  process.once('SIGTERM', () => {
    void initiateShutdown('SIGTERM', server);
  });
  process.once('SIGINT', () => {
    void initiateShutdown('SIGINT', server);
  });
}

function resolvePracticeId(): string {
  const envValue = process.env.PRACTICE_ID?.trim();
  if (envValue) return envValue;
  if (process.env.NODE_ENV === 'test') return 'demo';
  throw new Error('PRACTICE_ID environment variable is required');
}

function resolveAccessGatePort(): number {
  const raw = process.env.ACCESS_GATE_PORT ?? process.env.PORT;
  if (!raw) return 3600;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return 3600;
  return Math.min(65535, Math.max(1024, Math.floor(parsed)));
}

export function loadAccessGateConfig(practiceId = resolvePracticeId()): AccessGateConfig {
  const resolved = loadConfig(practiceId);
  if (!resolved.access_gate) {
    throw new Error('access_gate configuration missing for practice');
  }
  return resolved.access_gate;
}

export function createServerFromEnvironment(): http.Server {
  const config = loadAccessGateConfig();
  return createAccessGateServer({ config });
}

if (require.main === module) {
  const port = resolveAccessGatePort();
  const server = createServerFromEnvironment();
  installSignalHandlers(server);
  server.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`access-gate listening on :${port}`);
  });
}

function handleHandlerError(
  error: unknown,
  res: ServerResponse,
  correlationId: string,
  tenantId: string,
): void {
  logger.error('access.handler.error', {
    correlationId,
    tenantId,
    reason: error instanceof Error ? error.message : String(error),
  });
  if (!res.headersSent && !res.writableEnded) {
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: { code: 'internal_error', correlationId } }));
  }
}
