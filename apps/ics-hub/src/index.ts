import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { getBus, getNatsBusDiagnostics } from '@onecare/bus';
import { initTracing, logger } from '@onecare/observability';
import { AuditSpool } from './application/audit.spool';
import { ProcessingLimiter } from './application/backpressure';
import { initialiseIcsContext } from './application/ics.state';

const READINESS_CACHE_MS = Math.max(250, Number(process.env.READINESS_CACHE_MS ?? 1_000));
const PORT = resolvePort(process.env.PORT ?? process.env.ICS_HUB_PORT);
const SERVICE_NAME = 'ics-hub';

type CachedReadiness = { status: number; body: string; expiresAt: number };

let readinessCache: CachedReadiness | null = null;
let shuttingDown = false;

const bus = getBus();
const auditSpool = new AuditSpool(() => bus, {
  maxSize: Number(process.env.ICS_AUDIT_SPOOL_MAX ?? 512),
  maxAttempts: Number(process.env.ICS_AUDIT_SPOOL_ATTEMPTS ?? 5),
  retryDelayMs: Number(process.env.ICS_AUDIT_SPOOL_DELAY_MS ?? 250),
});

const processingLimiter = new ProcessingLimiter({
  maxConcurrency: Math.max(1, Math.floor(Number(process.env.ICS_PROCESSING_MAX_CONCURRENCY ?? 16))),
  queueLimit: Math.max(1, Math.floor(Number(process.env.ICS_PROCESSING_QUEUE_LIMIT ?? 64))),
  highWatermark: Math.max(1, Math.floor(Number(process.env.ICS_PROCESSING_HIGH_WATERMARK ?? 32))),
  retryAfterSeconds: Math.max(1, Math.floor(Number(process.env.ICS_PROCESSING_RETRY_AFTER ?? 2))),
});

function resolvePort(raw: string | undefined): number {
  if (!raw) return 7100;
  const parsed = Number(raw.trim());
  if (!Number.isFinite(parsed) || parsed <= 0) return 7100;
  return Math.min(65535, Math.max(1024, Math.floor(parsed)));
}

function handleHealthz(_req: IncomingMessage, res: ServerResponse): void {
  res.statusCode = 200;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ ok: true }));
}

function computeReadiness(): CachedReadiness {
  if (shuttingDown) {
    return {
      status: 503,
      body: JSON.stringify({ ok: false, reason: 'shutting_down' }),
      expiresAt: Date.now() + READINESS_CACHE_MS,
    };
  }

  const diagnostics = getNatsBusDiagnostics(bus);
  if (diagnostics && !diagnostics.isConnected) {
    return {
      status: 503,
      body: JSON.stringify({ ok: false, reason: 'bus_disconnected' }),
      expiresAt: Date.now() + READINESS_CACHE_MS,
    };
  }

  return {
    status: 200,
    body: JSON.stringify({ ok: true }),
    expiresAt: Date.now() + READINESS_CACHE_MS,
  };
}

function handleReadyz(_req: IncomingMessage, res: ServerResponse): void {
  const now = Date.now();
  if (!readinessCache || readinessCache.expiresAt <= now) {
    readinessCache = computeReadiness();
  }
  res.statusCode = readinessCache.status;
  res.setHeader('content-type', 'application/json');
  res.end(readinessCache.body);
}

function createServer() {
  return http.createServer((req, res) => {
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
      handleReadyz(req, res);
      return;
    }
    res.statusCode = 404;
    res.end('Not Found');
  });
}

async function start(): Promise<void> {
  await initTracing(SERVICE_NAME).catch((error) => {
    logger.warn('ics.hub.tracing_init_failed', { reason: error instanceof Error ? error.message : String(error) });
  });

  const server = createServer();
  server.listen(PORT, () => {
    const address = server.address() as AddressInfo | null;
    logger.info('ics.hub.server.started', {
      port: address?.port ?? PORT,
      pid: process.pid,
    });
  });

  const gracefulShutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    readinessCache = null;
    logger.warn('ics.hub.shutdown.start', { signal });
    try {
      await auditSpool.flush();
    } catch (error) {
      logger.error('ics.hub.audit_spool.flush_failed', { reason: error instanceof Error ? error.message : String(error) });
    }
    server.close((error) => {
      if (error) {
        logger.error('ics.hub.shutdown.error', { reason: error.message });
        process.exitCode = 1;
      }
      logger.info('ics.hub.shutdown.complete', { signal });
      process.exit();
    });
  };

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('uncaughtException', (error) => {
    logger.error('ics.hub.uncaught_exception', { reason: error.message });
    gracefulShutdown('uncaughtException');
  });
}

if (require.main === module) {
  void start().catch((error) => {
    logger.error('ics.hub.start_failed', { reason: error instanceof Error ? error.message : String(error) });
    process.exit(1);
  });
}

export { start, createServer, initialiseIcsContext };
export function getAuditSpool(): AuditSpool {
  return auditSpool;
}

export function getProcessingLimiter(): ProcessingLimiter {
  return processingLimiter;
}
export { buildIcsMachine, runIcsMachine } from './application/ics.machine';
