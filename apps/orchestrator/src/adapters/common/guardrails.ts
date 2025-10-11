import { setTimeout as delay } from 'node:timers/promises';

export interface GuardOptions {
  timeoutMs: number;
  maxRetries: number;
  baseDelayMs?: number; // for backoff
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
  fn: () => Promise<T>,
  opts: GuardOptions,
  breaker?: CircuitBreaker
): Promise<T> {
  const base = opts.baseDelayMs ?? 100;
  const controller = new AbortController();
  const { signal } = controller;

  let attempt = 0;
  const runOnce = async (): Promise<T> => {
    attempt += 1;
    if (breaker && !breaker.canPass()) throw new Error(`circuit_open:${name}`);
    const timeout = setTimeout(() => controller.abort(), opts.timeoutMs);
    try {
      const res = await fn();
      if (breaker) breaker.onSuccess();
      clearTimeout(timeout);
      return res;
    } catch (err) {
      clearTimeout(timeout);
      if (breaker) breaker.onFailure();
      throw err;
    }
  };

  let lastErr: unknown;
  for (let i = 0; i <= opts.maxRetries; i++) {
    try {
      return await runOnce();
    } catch (err) {
      lastErr = err;
      if (i === opts.maxRetries) break;
      const exp = Math.min(5, i + 1);
      const jitter = Math.random() * base;
      await delay(exp * base + jitter, undefined, { signal }).catch(() => {});
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

