export interface IdempotencyStore {
  exists(key: string): Promise<boolean>;
  put(key: string, ttlSeconds: number): Promise<void>;
  reserve?(key: string, ttlSeconds: number): Promise<'reserved' | 'exists'>;
  delete?(key: string): Promise<void>;
}

export interface ReserveIdempotencyOptions {
  ttlSeconds: number;
}

const inflightReservations = new Map<string, Promise<void>>();

export async function reserveIdempotency(
  store: IdempotencyStore,
  key: string,
  options: ReserveIdempotencyOptions,
): Promise<'reserved' | 'exists'> {
  if (typeof store.reserve === 'function') {
    return store.reserve(key, options.ttlSeconds);
  }

  if (await store.exists(key)) {
    return 'exists';
  }

  const existing = inflightReservations.get(key);
  if (existing) {
    await existing;
    return (await store.exists(key)) ? 'exists' : reserveWithoutNative(store, key, options.ttlSeconds);
  }

  let releaseLock!: () => void;
  const lock = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });
  inflightReservations.set(key, lock);

  try {
    if (await store.exists(key)) {
      return 'exists';
    }
    await store.put(key, options.ttlSeconds);
    return 'reserved';
  } finally {
    inflightReservations.delete(key);
    releaseLock();
  }
}

async function reserveWithoutNative(
  store: IdempotencyStore,
  key: string,
  ttlSeconds: number,
): Promise<'reserved' | 'exists'> {
  if (await store.exists(key)) {
    return 'exists';
  }
  await store.put(key, ttlSeconds);
  return 'reserved';
}

export async function releaseIdempotency(store: IdempotencyStore, key: string): Promise<void> {
  if (typeof store.delete === 'function') {
    await store.delete(key);
    return;
  }
  try {
    await store.put(key, 0);
  } catch {
    // ignore best-effort fallback failures
  }
}
