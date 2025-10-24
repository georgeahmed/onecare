import { logger } from '@onecare/observability';

export interface GuardOptions {
  timeoutMs?: number;
  maxRetries?: number;
  baseDelayMs?: number;
  cbFailureThreshold?: number;
  cbCooldownMs?: number;
  correlationId?: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

type CircuitState = 'closed' | 'open' | 'half-open';

interface CircuitBreaker {
  state: CircuitState;
  failures: number;
  openedAt: number;
}

const breakers = new Map<string, CircuitBreaker>();

function getBreaker(name: string): CircuitBreaker {
  let breaker = breakers.get(name);
  if (!breaker) {
    breaker = { state: 'closed', failures: 0, openedAt: 0 };
    breakers.set(name, breaker);
  }
  return breaker;
}

function jitter(base: number, random: () => number): number {
  return Math.floor(random() * base);
}

function log(event: string, name: string, correlationId: string | undefined, extra?: Record<string, unknown>) {
  logger.info(event, {
    component: 'triage.guard',
    name,
    ...(correlationId ? { correlationId } : {}),
    ...(extra ?? {}),
  });
}

function classifyErrorCode(err: unknown): string | undefined {
  if (!err) return undefined;
  const code = (err as { code?: string; name?: string }).code ?? (err as { name?: string }).name;
  return code ? String(code).toLowerCase() : undefined;
}

function isRetryable(err: unknown): boolean {
  const code = classifyErrorCode(err);
  if (!code) return false;
  return (
    code.includes('timeout') ||
    code.includes('econnreset') ||
    code.includes('etimedout') ||
    code.includes('eai_again') ||
    code.includes('temporarily_unavailable') ||
    code.includes('conflict')
  );
}

export async function callWithGuard<T>(
  name: string,
  fn: (signal: AbortSignal) => Promise<T>,
  opts: GuardOptions = {},
): Promise<T> {
  const {
    timeoutMs = 2_000,
    maxRetries = 2,
    baseDelayMs = 100,
    cbFailureThreshold = 5,
    cbCooldownMs = 15_000,
    correlationId,
    now = () => Date.now(),
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    random = Math.random,
  } = opts;

  const breaker = getBreaker(name);
  const startedAt = now();

  if (breaker.state === 'open') {
    if (startedAt - breaker.openedAt >= cbCooldownMs) {
      breaker.state = 'half-open';
      log('triage.guard.cb.half_open', name, correlationId);
    } else {
      log('triage.guard.cb.reject', name, correlationId, { sinceMs: startedAt - breaker.openedAt });
      const err = Object.assign(new Error('circuit_open'), { code: 'circuit_open' });
      throw err;
    }
  }

  let attempt = 0;
  const maxAttempts = maxRetries + 1;

  for (;;) {
    attempt += 1;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const attemptStarted = now();
    try {
      const result = await fn(controller.signal);
      clearTimeout(timer);
      if (breaker.state !== 'closed') {
        breaker.state = 'closed';
        breaker.failures = 0;
        log('triage.guard.cb.closed', name, correlationId);
      }
      return result;
    } catch (error) {
      clearTimeout(timer);
      const elapsed = now() - attemptStarted;
      const timeout = controller.signal.aborted;
      if (timeout) {
        log('triage.guard.timeout', name, correlationId, { attempt, elapsedMs: elapsed });
      }

      const retryable = timeout || isRetryable(error);
      if (retryable && attempt < maxAttempts) {
        const backoff = baseDelayMs * Math.pow(2, attempt - 1) + jitter(baseDelayMs, random);
        log('triage.guard.retry', name, correlationId, {
          attempt,
          backoffMs: backoff,
          reason: classifyErrorCode(error),
        });
        await sleep(backoff);
        continue;
      }

      breaker.failures += 1;
      if (breaker.failures >= cbFailureThreshold) {
        breaker.state = 'open';
        breaker.openedAt = now();
        log('triage.guard.cb.open', name, correlationId, { failures: breaker.failures });
      }
      throw error;
    }
  }
}

export function resetTriageGuardBreakers(): void {
  breakers.clear();
}
