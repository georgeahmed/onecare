import { setTimeout as delay } from 'node:timers/promises';

export interface GuardOptions {
  timeoutMs: number;
  maxRetries: number;
  baseDelayMs?: number; // for backoff
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
}

export class CircuitBreaker {
  private failures = 0;
  private state: 'closed' | 'open' | 'half-open' = 'closed';
  private openedAt = 0;
  constructor(
    private readonly name: string,
    private readonly failureThreshold = 3,
    private readonly openMs = 2000
  ) {}

  canPass(): boolean {
    if (this.state === 'closed') return true;
    if (this.state === 'open') {
      if (Date.now() - this.openedAt > this.openMs) {
        this.state = 'half-open';
        return true; // allow probe
      }
      return false;
    }
    // half-open allows a single probe
    return true;
  }

  onSuccess() {
    this.failures = 0;
    this.state = 'closed';
  }

  onFailure() {
    this.failures += 1;
    if (this.failures >= this.failureThreshold) {
      this.state = 'open';
      this.openedAt = Date.now();
    }
  }
}

export async function callWithGuard<T>(
  name: string,
  fn: (signal: AbortSignal) => Promise<T>,
  opts: GuardOptions,
  breaker?: CircuitBreaker
): Promise<T> {
  const base = opts.baseDelayMs ?? 100;
  const random = opts.random ?? Math.random;
  let lastErr: unknown;
  const timeoutMs = opts.timeoutMs ?? 2000;
  const maxRetries = opts.maxRetries ?? 0;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const controller = new AbortController();
    const sleep =
      opts.sleep ??
      ((ms: number, signal?: AbortSignal) => delay(ms, undefined, { signal }));

    const runOnce = async (): Promise<T> => {
      if (breaker && !breaker.canPass()) {
        throw new Error(`circuit_open:${name}`);
      }
      const timeoutError = new Error(`timeout:${name}`);
      let timer: NodeJS.Timeout | undefined;
      let timedOut = false;
      const workPromise = fn(controller.signal);
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
          reject(timeoutError);
        }, timeoutMs);
      });

      try {
        const result = await Promise.race([workPromise, timeoutPromise]);
        if (breaker) breaker.onSuccess();
        return result;
      } catch (err) {
        if (breaker) breaker.onFailure();
        if ((err as Error) === timeoutError || timedOut) {
          workPromise.catch(() => {});
        }
        throw err;
      } finally {
        if (timer) clearTimeout(timer);
      }
    };

    try {
      return await runOnce();
    } catch (err) {
      lastErr = err;
      if (attempt === maxRetries) break;
      const exp = Math.min(5, attempt + 1);
      const jitter = random() * base;
      await sleep(exp * base + jitter, controller.signal).catch(() => {});
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
