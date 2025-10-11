// Lightweight guardrail wrapper with timeout, retries (exp backoff + jitter), and a simple CB.

export interface GuardOptions {
  timeoutMs?: number;
  maxRetries?: number; // number of retries after the first attempt
  baseDelayMs?: number; // base delay for exponential backoff
  cbFailureThreshold?: number; // consecutive failures before open
  cbCooldownMs?: number; // time to half-open
  now?: () => number; // injectable time for tests
  sleep?: (ms: number) => Promise<void>; // injectable sleep for tests
}

type CBState = 'closed' | 'open' | 'half-open';

interface CircuitBreaker {
  state: CBState;
  failures: number;
  openedAt: number;
}

const breakers = new Map<string, CircuitBreaker>();

function getBreaker(name: string): CircuitBreaker {
  let b = breakers.get(name);
  if (!b) {
    b = { state: 'closed', failures: 0, openedAt: 0 };
    breakers.set(name, b);
  }
  return b;
}

function jitter(base: number): number {
  return Math.floor(Math.random() * base);
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
    now = () => Date.now(),
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  } = opts;

  const b = getBreaker(name);
  const tnow = now();
  if (b.state === 'open') {
    if (tnow - b.openedAt >= cbCooldownMs) {
      b.state = 'half-open';
    } else {
      throw Object.assign(new Error('circuit_open'), { code: 'circuit_open' });
    }
  }

  let attempt = 0;
  // attempt loop: initial + retries
  for (;;) {
    attempt++;
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const result = await fn(ac.signal);
      clearTimeout(t);
      // success → reset breaker
      b.failures = 0;
      b.state = 'closed';
      return result;
    } catch (err: any) {
      clearTimeout(t);
      const isTimeout = ac.signal.aborted;
      // classify retryable
      const retryable = isTimeout || isRetryable(err);
      if (retryable && attempt <= maxRetries + 1) {
        const delay = baseDelayMs * Math.pow(2, attempt - 1) + jitter(baseDelayMs);
        await sleep(delay);
        continue; // next attempt
      }

      // update breaker on failure
      b.failures += 1;
      if (b.failures >= cbFailureThreshold) {
        b.state = 'open';
        b.openedAt = now();
      }
      throw err;
    }
  }
}

function isRetryable(err: any): boolean {
  const code = String(err?.code || err?.name || '').toLowerCase();
  return (
    code.includes('timeout') ||
    code.includes('econnreset') ||
    code.includes('etimedout') ||
    code.includes('eai_again') ||
    code.includes('temporarily_unavailable')
  );
}

