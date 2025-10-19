/// <reference types="vitest/globals" />

import {
  enqueueOfflineJob,
  getOfflineJob,
  listOfflineJobs,
  removeOfflineJob,
  updateOfflineJob,
} from '../src/lib/offlineQueue';

const ensureWindow = () => {
  if (typeof window !== 'undefined') return;
  const storage = new Map<string, string>();
  const localStorage: Storage = {
    get length() {
      return storage.size;
    },
    clear: () => {
      storage.clear();
    },
    getItem: (key: string) => storage.get(key) ?? null,
    key: (index: number) => Array.from(storage.keys())[index] ?? null,
    removeItem: (key: string) => {
      storage.delete(key);
    },
    setItem: (key: string, value: string) => {
      storage.set(key, value);
    },
  };
  (globalThis as unknown as { window: Window }).window = {
    localStorage,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  } as unknown as Window;
};

ensureWindow();

const SLOT_FIXTURE = {
  start: '2025-10-14T09:00:00Z',
  end: '2025-10-14T09:15:00Z',
  modality: 'phone' as const,
  location: 'Clinic A',
};

describe('offlineQueue', () => {
  beforeEach(() => {
    listOfflineJobs().forEach((job) => removeOfflineJob(job.id));
    window.localStorage.clear();
  });

  it('enqueues and retrieves jobs', () => {
    const job = enqueueOfflineJob({
      id: 'job-1',
      idempotencyKey: 'job-1',
      correlationId: 'corr-1',
      payload: { slotId: 'slot-1', patientId: 'patient-1' },
      slot: SLOT_FIXTURE,
    });

    expect(job.attempt).toBe(0);
    expect(getOfflineJob('job-1')).toMatchObject({ id: 'job-1', payload: { slotId: 'slot-1' } });
    expect(listOfflineJobs()).toHaveLength(1);
  });

  it('updates attempts and next attempt time', () => {
    enqueueOfflineJob({
      id: 'job-2',
      idempotencyKey: 'job-2',
      correlationId: 'corr-2',
      payload: { slotId: 'slot-2', patientId: 'patient-2' },
      slot: SLOT_FIXTURE,
    });

    const nextAttempt = Date.now() + 5_000;
    const updated = updateOfflineJob('job-2', { attempt: 3, nextAttemptAt: nextAttempt });
    expect(updated).toMatchObject({ attempt: 3, nextAttemptAt: nextAttempt });
  });

  it('removes jobs from the queue', () => {
    enqueueOfflineJob({
      id: 'job-3',
      idempotencyKey: 'job-3',
      correlationId: 'corr-3',
      payload: { slotId: 'slot-3', patientId: 'patient-3' },
      slot: SLOT_FIXTURE,
    });
    removeOfflineJob('job-3');
    expect(listOfflineJobs()).toHaveLength(0);
  });
});
