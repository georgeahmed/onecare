import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { once } from 'node:events';
import { getBus, getNatsBusDiagnostics, withMessageGuards } from '@onecare/bus';
import type { MessageBus } from '@onecare/bus';
import type { ResolvedConfig } from '@onecare/config';
import { logger } from '@onecare/observability';
import type { FhirRepository, QueueNotifier, IdempotencyStore, FeatureStore } from '@onecare/ports';
import { TriageConsumer, type TriageConsumerOptions } from './adapters/consumer';
import {
  TriageSlaScheduler,
  type TriageSlaSchedulerOptions,
  startTriageSlaScheduler,
} from './sla/aging';
import type { AssignmentConsentEvaluator } from './application/triage.state';
import { Topics } from '@onecare/events';

const DEFAULT_PORT = 7300;
const DEFAULT_READINESS_CACHE_MS = Math.max(250, Number(process.env.TRIAGE_READINESS_CACHE_MS ?? 1_000));
const DEFAULT_MAX_PENDING_READY = Math.max(10, Number(process.env.TRIAGE_READY_MAX_PENDING ?? 500));
const FHIR_PROBE_TIMEOUT_MS = Math.max(100, Number(process.env.TRIAGE_FHIR_PROBE_TIMEOUT_MS ?? 750));
const SHUTDOWN_GRACE_MS = Math.max(1_000, Number(process.env.TRIAGE_SHUTDOWN_GRACE_MS ?? 10_000));
const SHUTDOWN_SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];

type CachedReadiness = {
  status: number;
  body: string;
  expiresAt: number;
};

interface ReadinessResult {
  ok: boolean;
  reason?: string;
}

export interface TriageRuntimeOptions {
  config: ResolvedConfig;
  fhirRepository: FhirRepository;
  queueNotifier?: QueueNotifier;
  featureStore?: FeatureStore;
  ingressIdempotencyStore?: IdempotencyStore;
  taskIdempotencyStore?: IdempotencyStore;
  consentEvaluator?: AssignmentConsentEvaluator;
  bus?: MessageBus;
  port?: number;
  readinessCacheMs?: number;
  maxPendingTasksReadyThreshold?: number;
  slaSchedulerOptions?: Partial<TriageSlaSchedulerOptions>;
  consumerOptions?: Partial<Omit<TriageConsumerOptions, 'config' | 'fhirRepository' | 'bus'>>;
  busHealthCheck?: () => Promise<ReadinessResult> | ReadinessResult;
  fhirReadinessCheck?: () => Promise<ReadinessResult> | ReadinessResult;
  extraReadinessChecks?: Array<() => Promise<ReadinessResult> | ReadinessResult>;
}

export interface TriageRuntime {
  port: number;
  server: http.Server;
  consumer: TriageConsumer;
  scheduler: TriageSlaScheduler;
  stop(): Promise<void>;
}

function resolvePort(raw: number | string | undefined): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    if (raw === 0) return 0;
    return Math.min(65535, Math.max(1024, Math.floor(raw)));
  }
  if (typeof raw === 'string' && raw.trim().length > 0) {
    const parsed = Number(raw.trim());
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.min(65535, Math.max(1024, Math.floor(parsed)));
    }
    if (parsed === 0) {
      return 0;
    }
  }
  return DEFAULT_PORT;
}

async function defaultBusHealth(bus: MessageBus): Promise<ReadinessResult> {
  const diagnostics = getNatsBusDiagnostics(bus);
  if (!diagnostics) {
    return { ok: true };
  }
  if (!diagnostics.isConnected) {
    return { ok: false, reason: 'bus_disconnected' };
  }
  return { ok: true };
}

async function defaultFhirHealth(repository: FhirRepository): Promise<ReadinessResult> {
  if (typeof repository.readResource !== 'function') {
    return { ok: true };
  }
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      repository.readResource<Record<string, unknown>>('metadata'),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('fhir_timeout')), FHIR_PROBE_TIMEOUT_MS);
      }),
    ]);
    return { ok: true };
  } catch (error) {
    if (error instanceof Error && error.message === 'fhir_timeout') {
      return { ok: false, reason: 'fhir_timeout' };
    }
    return {
      ok: false,
      reason: error instanceof Error ? error.message : 'fhir_error',
    };
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export async function startTriageRuntime(options: TriageRuntimeOptions): Promise<TriageRuntime> {
  const port = resolvePort(options.port ?? process.env.TRIAGE_PORT ?? process.env.PORT);
  const readinessCacheMs = Math.max(250, options.readinessCacheMs ?? DEFAULT_READINESS_CACHE_MS);
  const maxPendingThreshold = Math.max(1, options.maxPendingTasksReadyThreshold ?? DEFAULT_MAX_PENDING_READY);

  let readinessCache: CachedReadiness | null = null;
  let shuttingDown = false;

  const rawBus = options.bus ?? getBus();
  const bus = withMessageGuards(rawBus, {
    allowedTopics: [Topics.triage.input, Topics.tasks.created, Topics.tasks.updated, Topics.broker.deadLetter],
  });

  const scheduler = startTriageSlaScheduler({
    config: options.config,
    fhirRepository: options.fhirRepository,
    bus,
    ...(options.slaSchedulerOptions ?? {}),
  });

  const consumer = new TriageConsumer({
    config: options.config,
    fhirRepository: options.fhirRepository,
    bus,
    queueNotifier: options.queueNotifier,
    featureStore: options.featureStore,
    ingressIdempotencyStore: options.ingressIdempotencyStore,
    taskIdempotencyStore: options.taskIdempotencyStore,
    consentEvaluator: options.consentEvaluator,
    slaTracker: scheduler,
    ...(options.consumerOptions ?? {}),
  });

  await consumer.start();

  const readinessChecks = options.extraReadinessChecks ?? [];

  const computeReadiness = async (): Promise<CachedReadiness> => {
    if (shuttingDown) {
      return {
        status: 503,
        body: JSON.stringify({ ok: false, reason: 'shutting_down' }),
        expiresAt: Date.now() + readinessCacheMs,
      };
    }

    const busResult = await (options.busHealthCheck?.() ?? defaultBusHealth(bus));
    if (!busResult.ok) {
      logger.warn('triage.readiness.bus_unavailable', {
        component: 'triage',
        reason: busResult.reason ?? 'unknown',
      });
      return {
        status: 503,
        body: JSON.stringify({ ok: false, reason: busResult.reason ?? 'bus_unavailable' }),
        expiresAt: Date.now() + readinessCacheMs,
      };
    }

    const fhirResult = await (options.fhirReadinessCheck?.() ?? defaultFhirHealth(options.fhirRepository));
    if (!fhirResult.ok) {
      logger.warn('triage.readiness.fhir_unavailable', {
        component: 'triage',
        reason: fhirResult.reason ?? 'fhir_unavailable',
      });
      return {
        status: 503,
        body: JSON.stringify({ ok: false, reason: fhirResult.reason ?? 'fhir_unavailable' }),
        expiresAt: Date.now() + readinessCacheMs,
      };
    }

    if (scheduler.getPendingCount() > maxPendingThreshold) {
      logger.warn('triage.readiness.backlog_high', {
        component: 'triage',
        pending: scheduler.getPendingCount(),
        threshold: maxPendingThreshold,
      });
      return {
        status: 503,
        body: JSON.stringify({ ok: false, reason: 'backlog_high' }),
        expiresAt: Date.now() + readinessCacheMs,
      };
    }

    for (const check of readinessChecks) {
      try {
        const result = await check();
        if (!result.ok) {
          return {
            status: 503,
            body: JSON.stringify({ ok: false, reason: result.reason ?? 'dependency_unavailable' }),
            expiresAt: Date.now() + readinessCacheMs,
          };
        }
      } catch (error) {
        logger.error('triage.readiness.extra_check_failed', {
          component: 'triage',
          reason: error instanceof Error ? error.message : String(error),
        });
        return {
          status: 503,
          body: JSON.stringify({ ok: false, reason: 'extra_check_failed' }),
          expiresAt: Date.now() + readinessCacheMs,
        };
      }
    }

    return {
      status: 200,
      body: JSON.stringify({ ok: true }),
      expiresAt: Date.now() + readinessCacheMs,
    };
  };

  const handleHealthz = (_req: IncomingMessage, res: ServerResponse): void => {
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true }));
  };

  const handleReadyz = async (_req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const now = Date.now();
    if (!readinessCache || readinessCache.expiresAt <= now) {
      readinessCache = await computeReadiness();
    }
    res.statusCode = readinessCache.status;
    res.setHeader('content-type', 'application/json');
    res.end(readinessCache.body);
  };

  const server = http.createServer((req, res) => {
    if (!req.url) {
      res.statusCode = 400;
      res.end('Bad Request');
      return;
    }
    if (req.url.startsWith('/healthz')) {
      handleHealthz(req, res);
      return;
    }
    if (req.url.startsWith('/readyz')) {
      void handleReadyz(req, res);
      return;
    }
    res.statusCode = 404;
    res.end('Not Found');
  });

  let resolvedPort = port;

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => {
      const address = server.address() as AddressInfo | null;
      resolvedPort = address?.port ?? port;
      logger.info('triage.runtime.started', {
        component: 'triage',
        port: resolvedPort,
        pid: process.pid,
      });
      server.off('error', reject);
      resolve();
    });
  });

  const stop = async (reason = 'shutdown'): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    readinessCache = null;
    logger.warn('triage.runtime.shutdown.start', {
      component: 'triage',
      reason,
    });

    const stopTasks: Array<Promise<void>> = [];
    stopTasks.push(
      (async () => {
        try {
          await consumer.stop();
        } catch (error) {
          logger.error('triage.runtime.shutdown.consumer_failed', {
            component: 'triage',
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      })(),
    );
    stopTasks.push(
      (async () => {
        try {
          await scheduler.stop({ reason });
        } catch (error) {
          logger.error('triage.runtime.shutdown.scheduler_failed', {
            component: 'triage',
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      })(),
    );

    await Promise.all(stopTasks);

    server.close((error) => {
      if (error) {
        logger.error('triage.runtime.shutdown.server_failed', {
          component: 'triage',
          reason: error.message,
        });
        return;
      }
      logger.info('triage.runtime.shutdown.complete', {
        component: 'triage',
        reason,
      });
    });
    if (server.listening) {
      await Promise.race([
        once(server, 'close'),
        new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_GRACE_MS)),
      ]);
    }
  };

  SHUTDOWN_SIGNALS.forEach((signal) => {
    process.once(signal, () => {
      void stop(signal);
    });
  });

  process.on('uncaughtException', (error) => {
    logger.error('triage.runtime.uncaught_exception', {
      component: 'triage',
      reason: error instanceof Error ? error.message : String(error),
    });
    void stop('uncaughtException');
  });

  process.on('unhandledRejection', (reason) => {
    logger.error('triage.runtime.unhandled_rejection', {
      component: 'triage',
      reason: reason instanceof Error ? reason.message : String(reason),
    });
    void stop('unhandledRejection');
  });

  return {
    port: resolvedPort,
    server,
    consumer,
    scheduler,
    stop: async () => {
      await stop('manual');
    },
  };
}
