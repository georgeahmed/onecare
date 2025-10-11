// Minimal scheduler placeholder for portal uptime guard and similar periodic tasks.
// Replace with a proper scheduler or job queue as needed.

export type Task = () => Promise<void> | void;
export interface ScheduleOptions {
  jitterMs?: number;
  signal?: AbortSignal;
}

export interface ScheduledTask {
  cancel(): void;
}

export function every(intervalMs: number, task: Task): ScheduledTask {
  return everyWithJitter(intervalMs, 0, task);
}

export function everyWithJitter(intervalMs: number, jitterMs: number, task: Task, opts: ScheduleOptions = {}): ScheduledTask {
  let cancelled = false;
  const run = () => {
    if (cancelled || (opts.signal && (opts.signal as any).aborted)) return;
    Promise.resolve(task()).catch(() => {
      // swallow errors in skeleton; add logging when observability is ready
    }).finally(() => {
      if (cancelled || (opts.signal && (opts.signal as any).aborted)) return;
      const j = jitterMs > 0 ? Math.floor((Math.random() * 2 - 1) * jitterMs) : 0; // ±jitter
      const delay = Math.max(0, intervalMs + j);
      setTimeout(run, delay);
    });
  };
  // kick off initial run after a small jitter to avoid herd
  const initialDelay = jitterMs > 0 ? Math.floor(Math.random() * jitterMs) : 0;
  const t = setTimeout(run, initialDelay);
  return {
    cancel: () => {
      cancelled = true;
      clearTimeout(t);
    }
  };
}
