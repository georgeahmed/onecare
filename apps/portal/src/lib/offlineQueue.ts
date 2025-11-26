import {
  OFFLINE_QUEUE_BROADCAST_CHANNEL,
  OFFLINE_QUEUE_SYNC_TAG,
  OFFLINE_QUEUE_TTL_MS
} from './offlineQueue.constants';
import type { OfflineBookingJob, OfflineQueueSnapshot } from './offlineQueue.types';
import {
  isOfflineQueuePersistenceAvailable,
  persistQueueSnapshotToDb,
  readQueueSnapshotFromDb
} from './offlineStorage';

export type { OfflineBookingJob } from './offlineQueue.types';

const STORAGE_KEY = 'onecare.portal.bookingOfflineQueue';
const MAX_ERROR_LENGTH = 160;

type Listener = (queue: OfflineQueueSnapshot) => void;

const hasWindow = (): boolean => typeof window !== 'undefined';
const hasNavigator = (): boolean => typeof navigator !== 'undefined';

const instanceId =
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `offline-queue-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

const listeners = new Set<Listener>();
let queueCache: OfflineQueueSnapshot = [];
const persistenceMode: 'indexedDB' | 'localStorage' | 'memory' = isOfflineQueuePersistenceAvailable()
  ? 'indexedDB'
  : hasWindow()
    ? 'localStorage'
    : 'memory';

const broadcastChannel =
  typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(OFFLINE_QUEUE_BROADCAST_CHANNEL) : null;

type SyncManagerLike = {
  register: (tag: string) => Promise<void>;
};

type SyncCapableRegistration = ServiceWorkerRegistration & { sync: SyncManagerLike };

const hasBackgroundSync = (registration: ServiceWorkerRegistration): registration is SyncCapableRegistration => {
  const candidate = registration as { sync?: unknown };
  if (!candidate.sync || typeof candidate.sync !== 'object') {
    return false;
  }
  return typeof (candidate.sync as SyncManagerLike).register === 'function';
};

const getStorage = (): Storage | undefined => {
  if (!hasWindow()) return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
};

const cloneQueue = (queue: OfflineQueueSnapshot): OfflineQueueSnapshot =>
  queue.map((job) => ({
    ...job,
    payload: { ...job.payload },
    slot: { ...job.slot }
  }));

const pruneExpiredJobs = (queue: OfflineQueueSnapshot): OfflineQueueSnapshot =>
  queue.filter((job) => !isExpired(job.createdAt));

const isExpired = (createdAt: number | undefined): boolean =>
  typeof createdAt === 'number' && Number.isFinite(createdAt)
    ? Date.now() - createdAt > OFFLINE_QUEUE_TTL_MS
    : true;

const sanitizeJob = (candidate: unknown): OfflineBookingJob | null => {
  if (!candidate || typeof candidate !== 'object') return null;
  const record = candidate as Partial<OfflineBookingJob>;
  const id = typeof record.id === 'string' ? record.id.trim() : '';
  const idempotencyKey = typeof record.idempotencyKey === 'string' ? record.idempotencyKey.trim() : '';
  const correlationId = typeof record.correlationId === 'string' ? record.correlationId.trim() : '';
  const payload = record.payload as Partial<OfflineBookingJob['payload']> | undefined;
  const slot = record.slot as Partial<OfflineBookingJob['slot']> | undefined;

  if (!id || !idempotencyKey || !correlationId || !payload || !slot) {
    return null;
  }

  const slotStart = typeof slot.start === 'string' ? slot.start.trim() : '';
  const slotEnd = typeof slot.end === 'string' ? slot.end.trim() : '';
  const modality = slot.modality;

  if (!slotStart || !slotEnd || (modality !== 'phone' && modality !== 'in_person' && modality !== 'unknown')) {
    return null;
  }

  const patientId = typeof payload.patientId === 'string' ? payload.patientId.trim() : '';
  const slotId = typeof payload.slotId === 'string' ? payload.slotId.trim() : '';

  if (!patientId || !slotId) {
    return null;
  }

  const createdAt = typeof record.createdAt === 'number' && Number.isFinite(record.createdAt)
    ? record.createdAt
    : Date.now();

  if (isExpired(createdAt)) {
    return null;
  }

  return {
    id,
    idempotencyKey,
    correlationId,
    payload: {
      slotId,
      patientId
    },
    slot: {
      start: slotStart,
      end: slotEnd,
      modality,
      location: typeof slot.location === 'string' && slot.location.trim().length > 0 ? slot.location.trim() : undefined
    },
    attempt: typeof record.attempt === 'number' && Number.isFinite(record.attempt) && record.attempt >= 0 ? record.attempt : 0,
    createdAt,
    nextAttemptAt:
      typeof record.nextAttemptAt === 'number' && Number.isFinite(record.nextAttemptAt)
        ? record.nextAttemptAt
        : Date.now(),
    lastError:
      typeof record.lastError === 'string' && record.lastError.trim().length > 0
        ? record.lastError.trim().slice(0, MAX_ERROR_LENGTH)
        : undefined
  };
};

const sanitizeQueue = (raw: unknown): OfflineQueueSnapshot => {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(sanitizeJob)
    .filter((item): item is OfflineBookingJob => item !== null)
    .sort((a, b) => a.createdAt - b.createdAt);
};

const readQueueFromLocalStorage = (): OfflineQueueSnapshot => {
  const storage = getStorage();
  if (!storage) return [];
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return [];
    return sanitizeQueue(JSON.parse(raw) as unknown);
  } catch {
    return [];
  }
};

const writeQueueToLocalStorage = (queue: OfflineQueueSnapshot): void => {
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(queue));
  } catch {
    // Ignore localStorage persistence failures (quota, private mode, etc.)
  }
};

const persistQueue = (queue: OfflineQueueSnapshot): void => {
  if (persistenceMode === 'indexedDB') {
    void persistQueueSnapshotToDb(queue);
    writeQueueToLocalStorage(queue);
  } else if (persistenceMode === 'localStorage') {
    writeQueueToLocalStorage(queue);
  }
};

const emit = (origin: 'local' | 'remote' = 'local'): void => {
  const snapshot = cloneQueue(queueCache);
  listeners.forEach((listener) => {
    try {
      listener(snapshot);
    } catch {
      // Listener errors are ignored so other subscribers still receive updates.
    }
  });

  if (origin === 'local') {
    broadcastChannel?.postMessage({ type: 'queue-updated', sender: instanceId });
  }
};

const reloadFromPersistence = async (origin: 'local' | 'remote'): Promise<void> => {
  if (persistenceMode === 'indexedDB') {
    const snapshot = sanitizeQueue(await readQueueSnapshotFromDb());
    queueCache = snapshot;
    persistQueue(queueCache);
    emit(origin);
    return;
  }

  queueCache = readQueueFromLocalStorage();
  emit(origin);
};

const initializeQueue = async (): Promise<void> => {
  if (persistenceMode === 'indexedDB') {
    const fromDb = sanitizeQueue(await readQueueSnapshotFromDb());
    if (fromDb.length > 0) {
      queueCache = pruneExpiredJobs(fromDb);
      writeQueueToLocalStorage(queueCache);
    } else {
      const fromLocal = readQueueFromLocalStorage();
      if (fromLocal.length > 0) {
        queueCache = pruneExpiredJobs(fromLocal);
        persistQueue(queueCache);
      }
    }
  } else if (persistenceMode === 'localStorage') {
    queueCache = pruneExpiredJobs(readQueueFromLocalStorage());
  } else {
    queueCache = [];
  }

  persistQueue(queueCache);
  emit('remote');
};

const scheduleBackgroundSync = async (): Promise<void> => {
  if (!hasNavigator() || !('serviceWorker' in navigator)) {
    return;
  }
  try {
    const registration = await navigator.serviceWorker.ready;
    if (hasBackgroundSync(registration)) {
      await registration.sync.register(OFFLINE_QUEUE_SYNC_TAG);
    } else {
      void registration.update();
    }
  } catch {
    // Ignore sync registration failures (unsupported browser, etc.)
  }
};

const notifyServiceWorkerPendingJobs = (): void => {
  if (!hasNavigator() || !navigator.serviceWorker?.controller) {
    return;
  }
  try {
    navigator.serviceWorker.controller.postMessage({
      type: 'OFFLINE_QUEUE_PENDING'
    });
  } catch {
    // Silently ignore messaging failures.
  }
};

const ensureInitialized = (() => {
  let initialized = false;
  let pending: Promise<void> | null = null;

  return () => {
    if (initialized) return;
    if (!pending) {
      pending = initializeQueue().catch(() => undefined).finally(() => {
        initialized = true;
      });
    }
  };
})();

ensureInitialized();

export const listOfflineJobs = (): OfflineQueueSnapshot => {
  queueCache = pruneExpiredJobs(queueCache);
  persistQueue(queueCache);
  return cloneQueue(queueCache);
};

export const getOfflineJob = (id: string): OfflineBookingJob | undefined => {
  queueCache = pruneExpiredJobs(queueCache);
  persistQueue(queueCache);
  return queueCache.find((job) => job.id === id);
};

export const enqueueOfflineJob = (
  job: Omit<OfflineBookingJob, 'attempt' | 'createdAt' | 'nextAttemptAt'>
): OfflineBookingJob => {
  const sanitizedSlot = {
    start: job.slot.start.trim(),
    end: job.slot.end.trim(),
    modality: job.slot.modality,
    location: job.slot.location?.trim() || undefined
  };

  const sanitizedPayload = {
    slotId: job.payload.slotId.trim(),
    patientId: job.payload.patientId.trim()
  };

  const entry: OfflineBookingJob = {
    ...job,
    payload: sanitizedPayload,
    slot: sanitizedSlot,
    attempt: 0,
    createdAt: Date.now(),
    nextAttemptAt: Date.now()
  };
  queueCache = pruneExpiredJobs(queueCache);

  const existingIndex = queueCache.findIndex((item) => item.id === entry.id);
  if (existingIndex >= 0) {
    queueCache[existingIndex] = entry;
  } else {
    queueCache = [...queueCache, entry];
  }

  persistQueue(queueCache);
  emit();
  void scheduleBackgroundSync();
  notifyServiceWorkerPendingJobs();
  return entry;
};

export const pruneOfflineJobsForPatient = (patientId: string | null | undefined): void => {
  queueCache = pruneExpiredJobs(queueCache);
  if (!patientId) {
    queueCache = [];
  } else {
    queueCache = queueCache.filter((job) => job.payload.patientId === patientId);
  }
  persistQueue(queueCache);
  emit();
  notifyServiceWorkerPendingJobs();
};

export const updateOfflineJob = (id: string, updates: Partial<OfflineBookingJob>): OfflineBookingJob | undefined => {
  const index = queueCache.findIndex((job) => job.id === id);
  if (index === -1) return undefined;

  const current = queueCache[index];

  const sanitizedAttempt =
    typeof updates.attempt === 'number' && Number.isFinite(updates.attempt) && updates.attempt >= 0
      ? Math.floor(updates.attempt)
      : current.attempt;

  const sanitizedNextAttemptAt =
    typeof updates.nextAttemptAt === 'number' && Number.isFinite(updates.nextAttemptAt)
      ? updates.nextAttemptAt
      : current.nextAttemptAt;

  const sanitizedPayload = updates.payload
    ? {
        ...current.payload,
        ...updates.payload,
        slotId: updates.payload.slotId?.trim() ?? current.payload.slotId,
        patientId: updates.payload.patientId?.trim() ?? current.payload.patientId
      }
    : current.payload;

  const sanitizedSlot = updates.slot
    ? {
        ...current.slot,
        ...updates.slot,
        start: updates.slot.start?.trim() ?? current.slot.start,
        end: updates.slot.end?.trim() ?? current.slot.end,
        modality: updates.slot.modality ?? current.slot.modality,
        location: updates.slot.location?.trim() || current.slot.location
      }
    : current.slot;

  const sanitizedLastError =
    typeof updates.lastError === 'string'
      ? updates.lastError.trim().slice(0, MAX_ERROR_LENGTH) || undefined
      : updates.lastError === ''
        ? undefined
        : current.lastError;

  const next: OfflineBookingJob = {
    ...current,
    ...updates,
    payload: sanitizedPayload,
    slot: sanitizedSlot,
    attempt: sanitizedAttempt,
    nextAttemptAt: sanitizedNextAttemptAt,
    lastError: sanitizedLastError
  };

  queueCache = pruneExpiredJobs(queueCache);
  const nextIndex = queueCache.findIndex((job) => job.id === id);
  if (nextIndex === -1) {
    queueCache.push(next);
  } else {
    queueCache[nextIndex] = next;
  }
  persistQueue(queueCache);
  emit();
  void scheduleBackgroundSync();
  notifyServiceWorkerPendingJobs();
  return next;
};

export const removeOfflineJob = (id: string): void => {
  queueCache = pruneExpiredJobs(queueCache);
  const next = queueCache.filter((job) => job.id !== id);
  if (next.length === queueCache.length) {
    return;
  }
  queueCache = next;
  persistQueue(queueCache);
  emit();
  notifyServiceWorkerPendingJobs();
};

export const subscribeOfflineQueue = (listener: Listener): (() => void) => {
  queueCache = pruneExpiredJobs(queueCache);
  persistQueue(queueCache);
  listeners.add(listener);
  listener(cloneQueue(queueCache));

  return () => {
    listeners.delete(listener);
  };
};

const handleBroadcastMessage = (event: MessageEvent<{ type?: string; sender?: string }>): void => {
  if (!event.data || event.data.sender === instanceId || event.data.type !== 'queue-updated') {
    return;
  }
  void reloadFromPersistence('remote');
};

if (broadcastChannel) {
  broadcastChannel.addEventListener('message', handleBroadcastMessage);
}

if (hasWindow()) {
  window.addEventListener('storage', (event) => {
    if (event.key === STORAGE_KEY) {
      void reloadFromPersistence('remote');
    }
  });
}

if (hasNavigator() && navigator.serviceWorker) {
  navigator.serviceWorker.addEventListener('message', (event) => {
    const data = event.data as { type?: string } | undefined;
    if (!data) return;
    if (data.type === 'OFFLINE_QUEUE_REFRESH') {
      void reloadFromPersistence('remote');
    }
  });
}
