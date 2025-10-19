import type { OfflineQueueSnapshot } from './offlineQueue.types';

const DB_NAME = 'onecare.portal.offline';
const STORE_NAME = 'bookingQueue';
const DB_VERSION = 1;

let dbPromise: Promise<IDBDatabase> | null = null;

const hasIndexedDbSupport = (): boolean => typeof indexedDB !== 'undefined';

const openDb = (): Promise<IDBDatabase> => {
  if (!hasIndexedDbSupport()) {
    return Promise.reject(new Error('IndexedDB is not available'));
  }

  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('Failed to open offline queue database'));
    });
  }

  return dbPromise;
};

const withStore = async <T>(mode: IDBTransactionMode, handler: (store: IDBObjectStore) => T | Promise<T>): Promise<T> => {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    let result: T | undefined;

    const transaction = db.transaction(STORE_NAME, mode);
    transaction.oncomplete = () => resolve(result as T);
    transaction.onerror = () => reject(transaction.error ?? new Error('Offline queue transaction failed'));

    try {
      const value = handler(transaction.objectStore(STORE_NAME));
      if (value instanceof Promise) {
        value.then((resolved) => {
          result = resolved;
        }).catch(reject);
      } else {
        result = value;
      }
    } catch (error) {
      reject(error instanceof Error ? error : new Error('Offline queue handler failed'));
    }
  });
};

export const readQueueSnapshotFromDb = async (): Promise<OfflineQueueSnapshot> => {
  if (!hasIndexedDbSupport()) {
    return [];
  }

  try {
    return await withStore('readonly', (store) => {
      return new Promise<OfflineQueueSnapshot>((resolve, reject) => {
        const request = store.getAll();
        request.onsuccess = () => resolve((request.result ?? []) as OfflineQueueSnapshot);
        request.onerror = () => reject(request.error ?? new Error('Failed to read offline queue'));
      });
    });
  } catch {
    return [];
  }
};

export const persistQueueSnapshotToDb = async (snapshot: OfflineQueueSnapshot): Promise<void> => {
  if (!hasIndexedDbSupport()) {
    return;
  }

  try {
    await withStore('readwrite', (store) => {
      store.clear();
      snapshot.forEach((job) => {
        store.put(job);
      });
    });
  } catch {
    // Ignore persistence failures; queue will retry later.
  }
};

export const removeJobFromDb = async (id: string): Promise<void> => {
  if (!hasIndexedDbSupport()) {
    return;
  }

  try {
    await withStore('readwrite', (store) => {
      store.delete(id);
    });
  } catch {
    // Ignore storage deletion failures.
  }
};

export const isOfflineQueuePersistenceAvailable = (): boolean => hasIndexedDbSupport();
