import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { getBus, getNatsBusDiagnostics } from '@onecare/bus';
import { getCounterRecords, getHistogramRecords, initTracing, logger } from '@onecare/observability';
import { AuditSpool } from './application/audit.spool';
import { ProcessingLimiter } from './application/backpressure';
import { initialiseIcsContext } from './application/ics.state';

const READINESS_CACHE_MS = Math.max(250, Number(process.env.READINESS_CACHE_MS ?? 1_000));
const PORT = resolvePort(process.env.PORT ?? process.env.ICS_HUB_PORT);
const SERVICE_NAME = 'ics-hub';

const ROUTING_LATENCY_BUCKETS_MS = [10, 25, 50, 100, 200, 400, 800, 1_500, 3_000, 5_000];
const ACK_LATENCY_BUCKETS_MS = [25, 50, 100, 200, 400, 800, 1_500, 3_000, 5_000, 10_000];
const BACKPRESSURE_WAIT_BUCKETS_MS = [10, 25, 50, 100, 200, 400, 800, 1_500, 3_000];

interface HistogramExport {
  readonly name: string;
  readonly help: string;
  readonly buckets: number[];
  readonly labelKeys: string[];
}

interface CounterExport {
  readonly name: string;
  readonly help: string;
  readonly labelKeys: string[];
}

const HISTOGRAM_EXPORTS: HistogramExport[] = [
  {
    name: 'ics_routing_latency_ms',
    help: 'ICS routing latency in milliseconds',
    buckets: ROUTING_LATENCY_BUCKETS_MS,
    labelKeys: ['organisationId'],
  },
  {
    name: 'ics_ack_latency_ms',
    help: 'ICS acknowledgement latency in milliseconds',
    buckets: ACK_LATENCY_BUCKETS_MS,
    labelKeys: ['destinationOrgId', 'accepted'],
  },
  {
    name: 'ics_backpressure_wait_ms',
    help: 'ICS backpressure queue wait time in milliseconds',
    buckets: BACKPRESSURE_WAIT_BUCKETS_MS,
    labelKeys: ['state'],
  },
];

const COUNTER_EXPORTS: CounterExport[] = [
  { name: 'ics_routing_decisions_total', help: 'ICS routing decisions processed', labelKeys: ['organisationId', 'outcome'] },
  { name: 'ics_routing_blocked_total', help: 'ICS routing requests blocked by policy', labelKeys: ['organisationId'] },
  { name: 'ics_routing_rate_limited_total', help: 'ICS routing requests rejected due to rate limiting', labelKeys: ['organisationId'] },
  { name: 'ics_backpressure_acquire_total', help: 'ICS processing slots acquired', labelKeys: [] },
  { name: 'ics_backpressure_queue_overflow_total', help: 'ICS backpressure queue overflow events', labelKeys: [] },
  { name: 'ics_backpressure_overload_total', help: 'ICS processing overload events', labelKeys: ['reason'] },
  { name: 'ics_ack_published_total', help: 'ICS acknowledgement messages published', labelKeys: ['destinationOrgId', 'accepted'] },
  { name: 'ics_ack_failed_total', help: 'ICS acknowledgement publish failures', labelKeys: ['destinationOrgId'] },
  { name: 'ics_ack_duplicate_total', help: 'ICS acknowledgement duplicates suppressed', labelKeys: ['destinationOrgId'] },
];

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

function renderPrometheusMetrics(): string {
  const lines: string[] = [];

  for (const histogram of HISTOGRAM_EXPORTS) {
    const records = renderHistogramMetric(histogram);
    lines.push(`# HELP ${histogram.name} ${histogram.help}`);
    lines.push(`# TYPE ${histogram.name} histogram`);
    if (records.length === 0) {
      lines.push(`${histogram.name}_bucket{le="+Inf"} 0`);
      lines.push(`${histogram.name}_count 0`);
      lines.push(`${histogram.name}_sum 0`);
    } else {
      lines.push(...records);
    }
  }

  for (const counter of COUNTER_EXPORTS) {
    const records = renderCounterMetric(counter);
    lines.push(`# HELP ${counter.name} ${counter.help}`);
    lines.push(`# TYPE ${counter.name} counter`);
    if (records.length === 0) {
      lines.push(`${counter.name} 0`);
    } else {
      lines.push(...records);
    }
  }

  return `${lines.join('\n')}\n`;
}

function renderHistogramMetric(config: HistogramExport): string[] {
  const data = getHistogramRecords(config.name);
  if (data.length === 0) {
    return [];
  }

  const aggregates = new Map<string, { labelPairs: string[]; counts: number[]; sum: number; count: number }>();
  for (const record of data) {
    const value = Number(record.value ?? 0);
    if (!Number.isFinite(value)) continue;
    const labelPairs = collectLabelPairs(record.attributes ?? {}, config.labelKeys);
    const key = labelPairs.join(',');
    let aggregate = aggregates.get(key);
    if (!aggregate) {
      aggregate = {
        labelPairs,
        counts: new Array(config.buckets.length + 1).fill(0),
        sum: 0,
        count: 0,
      };
      aggregates.set(key, aggregate);
    }
    let bucketIndex = config.buckets.findIndex((boundary) => value <= boundary);
    if (bucketIndex === -1) bucketIndex = config.buckets.length;
    aggregate.counts[bucketIndex] += 1;
    aggregate.sum += value;
    aggregate.count += 1;
  }

  const lines: string[] = [];
  const sorted = Array.from(aggregates.values()).sort((a, b) => a.labelPairs.join(',').localeCompare(b.labelPairs.join(',')));
  for (const aggregate of sorted) {
    let cumulative = 0;
    config.buckets.forEach((boundary, idx) => {
      cumulative += aggregate.counts[idx];
      const labels = formatLabelText([...aggregate.labelPairs, `le="${boundary}"`]);
      lines.push(`${config.name}_bucket${labels} ${cumulative}`);
    });
    cumulative += aggregate.counts[aggregate.counts.length - 1];
    const infLabels = formatLabelText([...aggregate.labelPairs, 'le="+Inf"']);
    lines.push(`${config.name}_bucket${infLabels} ${cumulative}`);
    const baseLabels = formatLabelText(aggregate.labelPairs);
    lines.push(`${config.name}_count${baseLabels} ${aggregate.count}`);
    lines.push(`${config.name}_sum${baseLabels} ${aggregate.sum.toFixed(6)}`);
  }

  return lines;
}

function renderCounterMetric(config: CounterExport): string[] {
  const data = getCounterRecords(config.name);
  if (data.length === 0) {
    return [];
  }
  const totals = new Map<string, { labelPairs: string[]; value: number }>();
  for (const record of data) {
    const value = Number(record.value ?? 0);
    if (!Number.isFinite(value)) continue;
    const labelPairs = collectLabelPairs(record.attributes ?? {}, config.labelKeys);
    const key = labelPairs.join(',');
    const existing = totals.get(key);
    if (existing) {
      existing.value += value;
    } else {
      totals.set(key, { labelPairs, value });
    }
  }
  return Array.from(totals.values())
    .sort((a, b) => a.labelPairs.join(',').localeCompare(b.labelPairs.join(',')))
    .map((entry) => `${config.name}${formatLabelText(entry.labelPairs)} ${entry.value}`);
}

function collectLabelPairs(attributes: Record<string, unknown>, keys: string[]): string[] {
  const pairs: string[] = [];
  for (const key of keys) {
    const raw = attributes[key];
    if (raw === undefined || raw === null) continue;
    pairs.push(`${key}="${escapeLabelValue(raw)}"`);
  }
  return pairs;
}

function escapeLabelValue(value: unknown): string {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function formatLabelText(pairs: string[]): string {
  if (pairs.length === 0) {
    return '';
  }
  return `{${pairs.join(',')}}`;
}

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
    if (req.url.startsWith('/metrics')) {
      res.statusCode = 200;
      res.setHeader('content-type', 'text/plain; version=0.0.4');
      res.end(renderPrometheusMetrics());
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
    try {
      await processingLimiter.waitForIdle();
    } catch (error) {
      logger.error('ics.hub.processing_limiter.flush_failed', { reason: error instanceof Error ? error.message : String(error) });
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
