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

type CBState = 'closed' | 'open' | 'half-open';

interface CircuitBreaker {
  state: CBState;
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
    name,
    ...(correlationId ? { correlationId } : {}),
    ...(extra ?? {}),
  });
}

export async function callWithGuard<T>(
  name: string,
  fn: (signal: AbortSignal) => Promise<T>,
  opts: GuardOptions = {}
): Promise<T> {
  const {
    timeoutMs = 2000,
    maxRetries = 2,
    baseDelayMs = 100,
    cbFailureThreshold = 5,
    cbCooldownMs = 15000,
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
      log('cb.half_open', name, correlationId);
    } else {
      log('cb.reject', name, correlationId, { since: startedAt - breaker.openedAt });
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
    const attemptStart = now();
    try {
      const span = fn(controller.signal);
      const result = await span;
      clearTimeout(timer);
      if (breaker.state !== 'closed') {
        log('cb.closed', name, correlationId);
      }
      breaker.state = 'closed';
      breaker.failures = 0;
      return result;
    } catch (error) {
      clearTimeout(timer);
      const elapsed = now() - attemptStart;
      const retryable = controller.signal.aborted || isRetryable(error);

      if (controller.signal.aborted) {
        log('call.timeout', name, correlationId, { attempt, elapsed });
      }

      if (retryable && attempt < maxAttempts) {
        const backoff = baseDelayMs * Math.pow(2, attempt - 1) + jitter(baseDelayMs, random);
        log('call.retry', name, correlationId, { attempt, backoff, reason: classifyErrorCode(error) });
        await sleep(backoff);
        continue;
      }

      breaker.failures += 1;
      if (breaker.failures >= cbFailureThreshold) {
        breaker.state = 'open';
        breaker.openedAt = now();
        log('cb.open', name, correlationId, { failures: breaker.failures });
      }

      throw error;
    }
  }
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
    code.includes('temporarily_unavailable')
  );
}

export function resetGuardBreakers(): void {
  breakers.clear();
}
