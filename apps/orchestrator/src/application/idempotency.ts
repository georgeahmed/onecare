import { createHash } from 'node:crypto';
import type { IdempotencyStore } from '@onecare/ports';
import { logger } from '@onecare/observability';
import type { PortalSubmission } from '@onecare/events';

export function deriveIdempotencyKey(
  submission: PortalSubmission,
  actorId?: string,
  explicitKey?: string
): string {
  if (explicitKey) return explicitKey;
  const hash = createHash('sha256');
  const base = {
    practiceId: submission.practiceId,
    patientId: submission.patient?.id,
    narrativeLength: submission.narrative?.length ?? 0,
    channel: submission.channel,
    attachmentsCount: Array.isArray(submission.attachments) ? submission.attachments.length : 0,
  };
  hash.update(JSON.stringify(base));

  if (submission.narrative) {
    const narrativeDigest = createHash('sha256').update(submission.narrative).digest('hex');
    hash.update(narrativeDigest);
  }

  if (Array.isArray(submission.attachments) && submission.attachments.length > 0) {
    const attachmentDigests = submission.attachments
      .map((attachment) => {
        const attHash = createHash('sha256');
        attHash.update(String(attachment?.contentType ?? ''));
        attHash.update('\u0000');
        attHash.update(String(attachment?.url ?? ''));
        return attHash.digest('hex');
      })
      .sort();

    for (const digest of attachmentDigests) {
      hash.update(digest);
    }
  }

  if (actorId) hash.update(`:${actorId}`);
  return hash.digest('hex');
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
  if (typeof store.reserve === 'function') {
    return store.reserve(key, opts.ttlSeconds);
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

export async function releaseIdempotency(
  store: IdempotencyStore,
  key: string
): Promise<void> {
  if (typeof store.delete === 'function') {
    await store.delete(key);
    return;
  }
  try {
    await store.put(key, 0);
  } catch (err) {
    logger.warn('idempotency.release_fallback_failed', {
      key,
      reason: err instanceof Error ? err.message : err,
    });
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
  async reserve(key: string, ttlSeconds: number): Promise<'reserved' | 'exists'> {
    this.gc();
    if (this.map.has(key)) return 'exists';
    this.map.set(key, Date.now() + ttlSeconds * 1000);
    return 'reserved';
  }

  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }

  private gc() {
    const now = Date.now();
    for (const [k, exp] of this.map.entries()) if (exp <= now) this.map.delete(k);
  }
}
