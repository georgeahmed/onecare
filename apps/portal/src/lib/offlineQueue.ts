import type { BookingModality } from './booking';

export interface OfflineBookingJob {
  id: string;
  idempotencyKey: string;
  correlationId: string;
  payload: {
    slotId: string;
    patientId: string;
  };
  slot: {
    start: string;
    end: string;
    modality: BookingModality;
    location?: string;
  };
  attempt: number;
  createdAt: number;
  nextAttemptAt: number;
  lastError?: string;
}

const STORAGE_KEY = 'onecare.portal.bookingOfflineQueue';

type Listener = (queue: OfflineBookingJob[]) => void;

const listeners = new Set<Listener>();

const getStorage = (): Storage | undefined => {
  if (typeof window === 'undefined' || !window.localStorage) return undefined;
  return window.localStorage;
};

function emit(queue: OfflineBookingJob[]): void {
  listeners.forEach((listener) => {
    try {
      listener(queue);
    } catch {
      // ignore listener errors so others still receive updates
    }
  });
}

function readQueue(): OfflineBookingJob[] {
  const storage = getStorage();
  if (!storage) return [];
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is OfflineBookingJob => {
      return item && typeof item === 'object' && typeof (item as OfflineBookingJob).id === 'string';
    });
  } catch {
    return [];
  }
}

function writeQueue(queue: OfflineBookingJob[]): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(queue));
  } catch {
    // ignore persistence errors (storage full, private mode, etc.)
  }
}

export function listOfflineJobs(): OfflineBookingJob[] {
  return readQueue();
}

export function getOfflineJob(id: string): OfflineBookingJob | undefined {
  return readQueue().find((job) => job.id === id);
}

export function enqueueOfflineJob(job: Omit<OfflineBookingJob, 'attempt' | 'createdAt' | 'nextAttemptAt'>): OfflineBookingJob {
  const queue = readQueue();
  const entry: OfflineBookingJob = {
    ...job,
    attempt: 0,
    createdAt: Date.now(),
    nextAttemptAt: Date.now(),
  };
  const existingIndex = queue.findIndex((item) => item.id === entry.id);
  if (existingIndex >= 0) {
    queue[existingIndex] = entry;
  } else {
    queue.push(entry);
  }
  writeQueue(queue);
  emit(queue);
  return entry;
}

export function updateOfflineJob(id: string, updates: Partial<OfflineBookingJob>): OfflineBookingJob | undefined {
  const queue = readQueue();
  const index = queue.findIndex((job) => job.id === id);
  if (index === -1) return undefined;
  const updated: OfflineBookingJob = {
    ...queue[index],
    ...updates,
  };
  queue[index] = updated;
  writeQueue(queue);
  emit(queue);
  return updated;
}

export function removeOfflineJob(id: string): void {
  const queue = readQueue();
  const next = queue.filter((job) => job.id !== id);
  writeQueue(next);
  emit(next);
}

export function subscribeOfflineQueue(listener: Listener): () => void {
  listeners.add(listener);
  listener(readQueue());
  return () => {
    listeners.delete(listener);
  };
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key === STORAGE_KEY) {
      emit(readQueue());
    }
  });
}
