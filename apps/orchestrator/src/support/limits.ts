import { performance } from 'node:perf_hooks';

export interface ConcurrencyLimits {
  globalLimit: number;
  defaultRouteLimit: number;
  perRoute?: Record<string, number>;
}

export type ReleaseFn = () => void;

export class ConcurrencyLimiter {
  private readonly perRouteActive = new Map<string, number>();
  private globalActive = 0;

  constructor(private readonly config: ConcurrencyLimits) {}

  enter(route: string): ReleaseFn | null {
    const routeLimit = this.config.perRoute?.[route] ?? this.config.defaultRouteLimit;
    const globalLimit = this.config.globalLimit;

    if (globalLimit > 0 && this.globalActive >= globalLimit) {
      return null;
    }
    if (routeLimit > 0) {
      const current = this.perRouteActive.get(route) ?? 0;
      if (current >= routeLimit) {
        return null;
      }
      this.perRouteActive.set(route, current + 1);
    }

    this.globalActive += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.globalActive = Math.max(0, this.globalActive - 1);
      if (routeLimit > 0) {
        const current = (this.perRouteActive.get(route) ?? 1) - 1;
        if (current <= 0) this.perRouteActive.delete(route);
        else this.perRouteActive.set(route, current);
      }
    };
  }

  active(route?: string): number {
    if (route) {
      return this.perRouteActive.get(route) ?? 0;
    }
    return this.globalActive;
  }

  reset(): void {
    this.perRouteActive.clear();
    this.globalActive = 0;
  }
}

export interface RateLimitConfig {
  maxRequests: number;
  windowMs: number;
  blockMs?: number;
}

interface RateEntry {
  remaining: number;
  resetAt: number;
  blockedUntil?: number;
}

export interface RateLimitCheckResult {
  allowed: boolean;
  retryAfterSeconds?: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, RateEntry>();

  constructor(
    private readonly defaultConfig: RateLimitConfig,
    private readonly perRoute: Record<string, RateLimitConfig> = {},
  ) {}

  check(route: string, identity: string, now = performance.now()): RateLimitCheckResult {
    const config = this.perRoute[route] ?? this.defaultConfig;
    if (!config || config.maxRequests <= 0 || config.windowMs <= 0) {
      return { allowed: true };
    }

    const bucketKey = `${route}::${identity}`;
    const wallNow = Date.now();
    const entry = this.getEntry(bucketKey, config, wallNow);

    if (entry.blockedUntil && entry.blockedUntil > wallNow) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((entry.blockedUntil - wallNow) / 1000)),
      };
    }

    if (entry.remaining <= 0) {
      if (config.blockMs && !entry.blockedUntil) {
        entry.blockedUntil = wallNow + config.blockMs;
      }
      const retry = entry.blockedUntil ?? entry.resetAt;
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((retry - wallNow) / 1000)),
      };
    }

    entry.remaining -= 1;
    this.buckets.set(bucketKey, entry);
    return { allowed: true };
  }

  reset(): void {
    this.buckets.clear();
  }

  private getEntry(bucketKey: string, config: RateLimitConfig, nowMs: number): RateEntry {
    const existing = this.buckets.get(bucketKey);
    if (!existing || existing.resetAt <= nowMs) {
      const resetAt = nowMs + config.windowMs;
      const next: RateEntry = {
        remaining: Math.max(0, config.maxRequests),
        resetAt,
      };
      this.buckets.set(bucketKey, next);
      return next;
    }
    return existing;
  }
}
