import http from 'node:http';
import { createFileSink, resolveAnalyticsSinkPath } from './sink/fileSink';
import { AnalyticsConsumer, startAnalyticsConsumer } from './consumer';
import { TriageDecisionObserver, startTriageDecisionObserver } from './triageDecisionObserver';
import { getCounterRecords, getHistogramRecords, logger } from '@onecare/observability';
import { getBus, markNatsBusConnected } from '@onecare/bus';
import type { MessageBus } from '@onecare/bus';
import { Topics } from '@onecare/events';

const SHUTDOWN_SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];
const ANALYTICS_QUEUE_GROUP = 'analytics-consumer';
const ANALYTICS_METRICS_PORT = Number.parseInt(process.env.ANALYTICS_METRICS_PORT ?? '9400', 10);

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

const INGEST_LATENCY_BUCKETS_MS = [10, 25, 50, 100, 200, 400, 800, 1_500, 3_000, 5_000, 10_000, 30_000, 60_000, 120_000, 300_000];
const SINK_LATENCY_BUCKETS_MS = [10, 25, 50, 100, 200, 400, 800, 1_500, 3_000, 5_000, 10_000, 30_000];

const HISTOGRAM_EXPORTS: HistogramExport[] = [
  {
    name: 'analytics_ingest_lag_ms',
    help: 'Analytics ingest lag in milliseconds',
    buckets: INGEST_LATENCY_BUCKETS_MS,
    labelKeys: ['metricName'],
  },
  {
    name: 'analytics_sink_latency_ms',
    help: 'Analytics sink latency in milliseconds',
    buckets: SINK_LATENCY_BUCKETS_MS,
    labelKeys: ['metricName', 'result'],
  },
];

const COUNTER_EXPORTS: CounterExport[] = [
  {
    name: 'analytics_ingest_ok_total',
    help: 'Analytics metrics ingested successfully',
    labelKeys: ['metricName', 'duplicate', 'attempt', 'result'],
  },
  {
    name: 'analytics_ingest_error_total',
    help: 'Analytics ingest error events',
    labelKeys: ['metricName', 'reason'],
  },
  {
    name: 'analytics_ingest_retry_total',
    help: 'Analytics ingest retries attempted',
    labelKeys: ['metricName', 'attempt'],
  },
  {
    name: 'analytics_ingest_duplicate_total',
    help: 'Analytics duplicates suppressed',
    labelKeys: ['metricName'],
  },
  {
    name: 'analytics_ingest_dlq_total',
    help: 'Analytics metrics sent to the DLQ',
    labelKeys: ['metricName', 'cause', 'reason'],
  },
];

async function establishBus(): Promise<MessageBus> {
  const wantsNats = Boolean(process.env.NATS_URL?.trim());
  const bus = getBus({ queueGroup: ANALYTICS_QUEUE_GROUP });
  if (!wantsNats) {
    markNatsBusConnected(bus, true);
  }
  return bus;
}

async function main(): Promise<void> {
  const sinkPath = resolveAnalyticsSinkPath();
  logger.info('starting analytics consumer runtime', { sinkPath });

  const bus = await establishBus();
  let consumer: AnalyticsConsumer | null = null;
  let decisionObserver: TriageDecisionObserver | null = null;
  let metricsServer: http.Server | null = startMetricsServer();
  let shuttingDown = false;

  try {
    consumer = await startAnalyticsConsumer({ bus, sink: createFileSink({ filePath: sinkPath }) });
    decisionObserver = await startTriageDecisionObserver({ bus });
    logger.info('analytics consumer ready', { topic: Topics.analytics.metric });
    logger.info('triage decision observer ready', { topic: Topics.triage.decision ?? 'triage.decision' });
  } catch (err) {
    logger.error('failed to start analytics consumer', {
      error: err instanceof Error ? err.message : err,
    });
    if (consumer) {
      try {
        await consumer.stop();
      } catch (stopErr) {
        logger.warn('error stopping analytics consumer after failed startup', {
          error: stopErr instanceof Error ? stopErr.message : stopErr,
        });
      }
    }
    await shutdown('startup_failed', 1);
    return;
  }

  async function shutdown(reason: string, exitCode: number): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutting down analytics consumer', { reason });
    try {
      if (decisionObserver) {
        await decisionObserver.stop();
        decisionObserver = null;
      }
      if (consumer) {
        await consumer.stop();
        consumer = null;
      }
      if (metricsServer) {
        await new Promise<void>((resolve) => {
          metricsServer?.close(() => resolve());
        });
        metricsServer = null;
      }
    } catch (err) {
      logger.error('error during analytics consumer shutdown', {
        error: err instanceof Error ? err.message : err,
      });
    }
    process.exit(exitCode);
  }

  SHUTDOWN_SIGNALS.forEach((signal) => {
    process.once(signal, () => {
      void shutdown(signal, 0);
    });
  });

  process.on('unhandledRejection', (reason) => {
    logger.error('unhandled rejection in analytics runtime', {
      reason: reason instanceof Error ? reason.message : reason,
    });
    void shutdown('unhandledRejection', 1);
  });

  process.on('uncaughtException', (err) => {
    logger.error('uncaught exception in analytics runtime', {
      error: err instanceof Error ? err.message : err,
    });
    void shutdown('uncaughtException', 1);
  });
}

void main();

function startMetricsServer(): http.Server | null {
  if (!Number.isFinite(ANALYTICS_METRICS_PORT) || ANALYTICS_METRICS_PORT <= 0) {
    logger.warn('analytics metrics server disabled (invalid port)', { port: process.env.ANALYTICS_METRICS_PORT });
    return null;
  }

  const server = http.createServer((req, res) => {
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
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.statusCode = 404;
    res.end('Not Found');
  });

  server.on('error', (error) => {
    logger.error('analytics metrics server error', {
      reason: (error as NodeJS.ErrnoException).message,
    });
  });

  server.listen(ANALYTICS_METRICS_PORT, () => {
    logger.info('analytics metrics server listening', { port: ANALYTICS_METRICS_PORT });
  });

  return server;
}

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
