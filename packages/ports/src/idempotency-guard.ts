import type { IdempotencyStore } from './idempotency';

export interface IdempotencyExecutionResult<T> {
  status: 'executed' | 'skipped';
  result?: T;
}

export interface IdempotencyExecutionOptions<T> {
  store?: IdempotencyStore | null;
  key: string;
  ttlSeconds: number;
  execute: () => Promise<T>;
  onDuplicate?: () => Promise<void> | void;
  onError?: (error: unknown) => Promise<void> | void;
}

/**
 * Executes an operation ensuring at-most-once semantics via the provided {@link IdempotencyStore}.
 * If the key already exists the function short-circuits and returns `{ status: 'skipped' }`.
 * When the underlying operation throws, the reserved key is released (best-effort) to allow retries.
 */
export async function executeWithIdempotency<T>(
  options: IdempotencyExecutionOptions<T>,
): Promise<IdempotencyExecutionResult<T>> {
  const store = options.store ?? undefined;
  if (!store) {
    const result = await options.execute();
    return { status: 'executed', result };
  }

  const { key, ttlSeconds } = options;
  const reserveSupported = typeof store.reserve === 'function';
  const deleteSupported = typeof store.delete === 'function';

  if (reserveSupported) {
    const outcome = await store.reserve!(key, ttlSeconds);
    if (outcome === 'exists') {
      await Promise.resolve(options.onDuplicate?.());
      return { status: 'skipped' };
    }
    try {
      const result = await options.execute();
      return { status: 'executed', result };
    } catch (error) {
      if (deleteSupported) {
        await store.delete!(key).catch(() => undefined);
      }
      await Promise.resolve(options.onError?.(error));
      throw error;
    }
  }

  const exists = await store.exists(key);
  if (exists) {
    await Promise.resolve(options.onDuplicate?.());
    return { status: 'skipped' };
  }

  try {
    const result = await options.execute();
    await store.put(key, ttlSeconds);
    return { status: 'executed', result };
  } catch (error) {
    if (deleteSupported) {
      await store.delete!(key).catch(() => undefined);
    }
    await Promise.resolve(options.onError?.(error));
    throw error;
  }
}
