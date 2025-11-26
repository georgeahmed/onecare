/// <reference lib="webworker" />

import {
  OFFLINE_QUEUE_BROADCAST_CHANNEL,
  OFFLINE_QUEUE_SYNC_TAG,
  OFFLINE_QUEUE_TTL_MS
} from './lib/offlineQueue.constants';
import type { OfflineBookingJob } from './lib/offlineQueue.types';
import { confirmBooking } from './lib/api';
import { persistQueueSnapshotToDb, readQueueSnapshotFromDb } from './lib/offlineStorage';
import { createCorrelationId, safeLog } from './lib/telemetry';

declare const self: ServiceWorkerGlobalScope;

const CACHE_PREFIX = 'onecare-portal';
const CACHE_VERSION = 'v20250214';
const SHELL_CACHE = `${CACHE_PREFIX}-shell-${CACHE_VERSION}`;
const RUNTIME_CACHE = `${CACHE_PREFIX}-runtime-${CACHE_VERSION}`;
const SCOPE_PATH = (() => {
  try {
    const pathname = new URL(self.registration.scope).pathname;
    const trimmed = pathname.endsWith('/') && pathname !== '/' ? pathname.slice(0, -1) : pathname;
    return trimmed || '';
  } catch {
    return '';
  }
})();
const SHELL_BASE = SCOPE_PATH || '/';
const SHELL_ASSETS: readonly string[] = [SHELL_BASE, `${SCOPE_PATH || ''}/index.html`];
const OFFLINE_FALLBACK = `${SCOPE_PATH || ''}/index.html`;
const BASE_BACKOFF_MS = 1_500;
const MAX_BACKOFF_MS = 30_000;
const JITTER_MAX_MS = 750;
const MAX_ERROR_LENGTH = 160;

type SyncManagerLike = {
  register: (tag: string) => Promise<void>;
};

type SyncEventLike = ExtendableEvent & { tag: string };

declare global {
  interface ServiceWorkerGlobalScopeEventMap {
    sync: SyncEventLike;
  }
}

const broadcastChannel =
  typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(OFFLINE_QUEUE_BROADCAST_CHANNEL) : null;

const isNavigationRequest = (request: Request): boolean =>
  request.mode === 'navigate' || (request.method === 'GET' && request.headers.get('accept')?.includes('text/html') === true);

const shouldCacheRuntimeAsset = (url: URL): boolean => {
  if (url.origin !== self.location.origin) {
    return false;
  }
  const path = url.pathname;
  const scopePrefix = SCOPE_PATH && SCOPE_PATH !== '/' ? `${SCOPE_PATH}/` : '/';
  const assetsPrefix = `${scopePrefix}assets/`;
  if (!(path === `${scopePrefix}index.html` || path.startsWith(assetsPrefix))) {
    return false;
  }
  if (path.startsWith(assetsPrefix)) {
    return path.endsWith('.js') || path.endsWith('.css') || path.endsWith('.woff2');
  }
  return false;
};

const cacheShellAssets = async (): Promise<void> => {
  const cache = await caches.open(SHELL_CACHE);
  const requests = SHELL_ASSETS.map((asset) => new Request(asset, { cache: 'reload', credentials: 'omit' }));
  await cache.addAll(requests);
};

const cleanOldCaches = async (): Promise<void> => {
  const keys = await caches.keys();
  await Promise.all(
    keys
      .filter(
        (key) => key.startsWith(`${CACHE_PREFIX}-`) && key !== SHELL_CACHE && key !== RUNTIME_CACHE
      )
      .map((key) => caches.delete(key))
  );
};

const fetchAndCache = async (request: Request, cacheName: string): Promise<Response> => {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response.ok) {
      void cache.put(request, response.clone());
    }
    return response;
  } catch (error) {
    const cached = await cache.match(request);
    if (cached) {
      return cached;
    }
    throw error;
  }
};

const respondWithOfflineFallback = async (request: Request): Promise<Response> => {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(request);
  if (cached) {
    return cached;
  }
  const fallback = await cache.match(OFFLINE_FALLBACK);
  if (fallback) {
    return fallback;
  }
  return new Response('Offline', { status: 503, statusText: 'Offline' });
};

const isOnline = (): boolean => {
  return typeof self.navigator === 'undefined' || typeof self.navigator.onLine !== 'boolean' || self.navigator.onLine;
};

const computeBackoffDelay = (attempt: number): number => {
  const exponential = BASE_BACKOFF_MS * 2 ** attempt;
  const capped = Math.min(MAX_BACKOFF_MS, exponential);
  const jitter = Math.floor(Math.random() * JITTER_MAX_MS);
  return capped + jitter;
};

const notifyClientsOfQueueChange = async (): Promise<void> => {
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  await Promise.all(
    clients.map((client) =>
      client.postMessage({
        type: 'OFFLINE_QUEUE_REFRESH'
      })
    )
  );
};

const getSyncManager = (): SyncManagerLike | undefined => {
  const registration = self.registration as ServiceWorkerRegistration & { sync?: SyncManagerLike };
  return registration.sync;
};

const scheduleBackgroundSync = async (): Promise<void> => {
  const syncManager = getSyncManager();
  if (!syncManager) return;
  try {
    await syncManager.register(OFFLINE_QUEUE_SYNC_TAG);
  } catch {
    // Ignore sync registration failures (unsupported browser or disabled feature).
  }
};

const isExpired = (createdAt: number | undefined): boolean =>
  typeof createdAt === 'number' && Number.isFinite(createdAt)
    ? Date.now() - createdAt > OFFLINE_QUEUE_TTL_MS
    : true;

const processOfflineQueue = async (): Promise<void> => {
  if (!isOnline()) {
    await scheduleBackgroundSync();
    return;
  }

  const rawSnapshot = await readQueueSnapshotFromDb();
  const snapshot = rawSnapshot.filter((job) => !isExpired(job.createdAt));
  if (snapshot.length === 0) {
    if (rawSnapshot.length > 0) {
      await persistQueueSnapshotToDb([]);
    }
    return;
  }

  const workingQueue: OfflineBookingJob[] = snapshot
    .map((job) => ({ ...job, payload: { ...job.payload }, slot: { ...job.slot } }))
    .sort((a, b) => a.nextAttemptAt - b.nextAttemptAt);

  let updated = rawSnapshot.length !== snapshot.length;

  for (const job of [...workingQueue]) {
    if (job.nextAttemptAt > Date.now()) {
      continue;
    }

    try {
      await confirmBooking(
        {
          slotId: job.payload.slotId,
          patientId: job.payload.patientId
        },
        {
          idempotencyKey: job.idempotencyKey,
          correlationId: job.correlationId ?? createCorrelationId()
        }
      );

      const index = workingQueue.findIndex((entry) => entry.id === job.id);
      if (index >= 0) {
        workingQueue.splice(index, 1);
        updated = true;
      }

      safeLog('sw.offlineQueue.success', { id: job.id, correlationId: job.correlationId });
    } catch (error) {
      const index = workingQueue.findIndex((entry) => entry.id === job.id);
      if (index === -1) {
        continue;
      }

      const attempts = job.attempt + 1;
      const message =
        error instanceof Error && typeof error.message === 'string'
          ? error.message.slice(0, MAX_ERROR_LENGTH)
          : 'Network error. We will retry soon.';

      workingQueue[index] = {
        ...job,
        attempt: attempts,
        lastError: message,
        nextAttemptAt: Date.now() + computeBackoffDelay(attempts)
      };
      updated = true;
      safeLog('sw.offlineQueue.retry', { id: job.id, attempts, message });
    }
  }

  if (updated) {
    await persistQueueSnapshotToDb(workingQueue);
    broadcastChannel?.postMessage({ type: 'queue-updated', sender: 'sw' });
    await notifyClientsOfQueueChange();
  }

  if (workingQueue.length > 0) {
    await scheduleBackgroundSync();
  }
};

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      await cacheShellAssets();
      self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      await cleanOldCaches();
      await cacheShellAssets();
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  if (request.method !== 'GET') {
    return;
  }

  const url = new URL(request.url);

  if (isNavigationRequest(request)) {
    event.respondWith(
      (async () => {
        try {
          const navigationRequest = new Request(request.url, {
            method: request.method,
            headers: request.headers,
            mode: request.mode,
            redirect: request.redirect,
            referrer: request.referrer,
            referrerPolicy: request.referrerPolicy,
            cache: 'no-store',
            credentials: 'omit'
          });
          return await fetch(navigationRequest);
        } catch {
          return respondWithOfflineFallback(request);
        }
      })()
    );
    return;
  }

  if (shouldCacheRuntimeAsset(url)) {
    event.respondWith(fetchAndCache(request, RUNTIME_CACHE));
  }
});

self.addEventListener('sync', (event) => {
  if (event.tag === OFFLINE_QUEUE_SYNC_TAG) {
    event.waitUntil(processOfflineQueue());
  }
});

self.addEventListener('message', (event) => {
  const data = event.data as { type?: string } | undefined;
  if (!data) return;
  if (data.type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }
  if (data.type === 'OFFLINE_QUEUE_PENDING') {
    event.waitUntil(processOfflineQueue());
  }
});
