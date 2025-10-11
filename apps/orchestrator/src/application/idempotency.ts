import { createHash } from 'node:crypto';
import type { IdempotencyStore } from '@onecare/ports';
import type { PortalSubmission } from '@onecare/events';

export function deriveIdempotencyKey(
  submission: PortalSubmission,
  actorId?: string,
  explicitKey?: string
): string {
  if (explicitKey) return explicitKey;
  const safe = {
    practiceId: submission.practiceId,
    patientId: submission.patient?.id,
    narrative: submission.narrative?.slice(0, 64), // avoid PHI-heavy keys
    channel: submission.channel,
  };
  const h = createHash('sha256');
  h.update(JSON.stringify(safe));
  if (actorId) h.update(`:${actorId}`);
  return h.digest('hex');
}

// Simple in-process single-flight locks to complement a non-atomic store
const inflight = new Map<string, Promise<void>>();

export interface ReserveOptions { ttlSeconds: number }

export async function reserveIdempotency(
  store: IdempotencyStore,
  key: string,
  opts: ReserveOptions
): Promise<'reserved' | 'exists'> {
  // Prefer atomic reserve if supported by the store implementation
  const anyStore = store as IdempotencyStore & { reserve?: (k: string, ttl: number) => Promise<boolean> };
  if (typeof anyStore.reserve === 'function') {
    const ok = await anyStore.reserve(key, opts.ttlSeconds);
    return ok ? 'reserved' : 'exists';
  }
  // Otherwise, use single-flight lock to reduce race window
  if (await store.exists(key)) return 'exists';
  const current = inflight.get(key);
  if (current) {
    await current;
    return (await store.exists(key)) ? 'exists' : 'reserved';
  }
  let resolveLock: () => void;
  const lock = new Promise<void>(r => { resolveLock = r; });
  inflight.set(key, lock);
  try {
    if (await store.exists(key)) return 'exists';
    await store.put(key, opts.ttlSeconds);
    return 'reserved';
  } finally {
    inflight.delete(key);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    resolveLock!();
  }
}

export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly map = new Map<string, number>();

  async exists(key: string): Promise<boolean> {
    this.gc();
    return this.map.has(key);
  }
  async put(key: string, ttlSeconds: number): Promise<void> {
    const exp = Date.now() + ttlSeconds * 1000;
    this.map.set(key, exp);
  }
  private gc() {
    const now = Date.now();
    for (const [k, exp] of this.map.entries()) if (exp <= now) this.map.delete(k);
  }
}
