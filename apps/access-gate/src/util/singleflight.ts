// Lightweight singleflight with optional TTL-based suppression

type AsyncFn<T> = () => Promise<T>;

export interface SingleflightRunResult<T> {
  executed: boolean; // true if we executed fn now
  deduped?: boolean; // true if we reused an in-progress call
  skipped?: boolean; // true if suppressed due to TTL since last completion
  result?: T;
}

export class Singleflight {
  private inProgress = new Map<string, Promise<any>>();
  private lastCompleteAt = new Map<string, number>();
  private now: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.now = now;
  }

  async run<T>(key: string, ttlMs: number, fn: AsyncFn<T>): Promise<SingleflightRunResult<T>> {
    const now = this.now();
    const last = this.lastCompleteAt.get(key) || 0;
    if (ttlMs > 0 && now - last < ttlMs) {
      return { executed: false, skipped: true };
    }
    const existing = this.inProgress.get(key);
    if (existing) {
      const res = await existing; // collapse duplicates
      return { executed: false, deduped: true, result: res };
    }
    const p = (async () => await fn())();
    this.inProgress.set(key, p);
    try {
      const res = await p;
      this.lastCompleteAt.set(key, this.now());
      return { executed: true, result: res };
    } finally {
      this.inProgress.delete(key);
    }
  }
}

