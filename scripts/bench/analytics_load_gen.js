#!/usr/bin/env node
'use strict';

/**
 * Analytics load generator
 *
 * Publishes synthetic `analytics.metric` envelopes against the in-process analytics consumer and
 * records ingest latency, sink throughput, and DLQ behaviour. Defaults to an in-memory bus and the
 * JSONL sink, enabling local perf probes without external infrastructure.
 */

const { performance } = require('node:perf_hooks');
const crypto = require('node:crypto');
const path = require('node:path');
const { MemoryBus } = require('@onecare/bus');
const { Topics, createEnvelope } = require('@onecare/events');
const { logger, setCorrelationId } = require('@onecare/observability');
const { AnalyticsConsumer, createFileSink, resolveAnalyticsSinkPath } = require('../../apps/analytics/dist/index.js');

const DEFAULT_DURATION = 60;
const DEFAULT_RATE = 200; // metrics per second
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_METRIC_NAMES = ['latency_ms', 'errors_total', 'requests_total'];
const DEFAULT_SERVICES = ['triage', 'booking', 'telephony', 'orchestrator'];
const DEFAULT_VALUES = { min: 0, max: 500 };
const DEFAULT_LABEL_RESULTS = ['ok', 'error', 'timeout'];

function parseArgs(argv) {
  const args = {
    duration: DEFAULT_DURATION,
    rate: DEFAULT_RATE,
    concurrency: DEFAULT_CONCURRENCY,
    output: resolveAnalyticsSinkPath(),
    services: DEFAULT_SERVICES,
    metrics: DEFAULT_METRIC_NAMES,
    resultLabels: DEFAULT_LABEL_RESULTS,
    minValue: DEFAULT_VALUES.min,
    maxValue: DEFAULT_VALUES.max,
    backpressureMs: 0,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = argv[i + 1];
    switch (token) {
      case '--duration':
        args.duration = Number(next);
        i += 1;
        break;
      case '--rate':
        args.rate = Number(next);
        i += 1;
        break;
      case '--concurrency':
        args.concurrency = Number(next);
        i += 1;
        break;
      case '--output':
        args.output = path.resolve(next);
        i += 1;
        break;
      case '--services':
        args.services = next.split(',').map((entry) => entry.trim()).filter(Boolean);
        i += 1;
        break;
      case '--metrics':
        args.metrics = next.split(',').map((entry) => entry.trim()).filter(Boolean);
        i += 1;
        break;
      case '--results':
        args.resultLabels = next.split(',').map((entry) => entry.trim()).filter(Boolean);
        i += 1;
        break;
      case '--min':
        args.minValue = Number(next);
        i += 1;
        break;
      case '--max':
        args.maxValue = Number(next);
        i += 1;
        break;
      case '--backpressure-ms':
        args.backpressureMs = Number(next);
        i += 1;
        break;
      default:
        break;
    }
  }

  if (!Number.isFinite(args.duration) || args.duration <= 0) {
    throw new Error('duration must be a positive number of seconds');
  }
  if (!Number.isFinite(args.rate) || args.rate <= 0) {
    throw new Error('rate must be a positive number (messages/second)');
  }
  if (!Number.isFinite(args.concurrency) || args.concurrency <= 0) {
    throw new Error('concurrency must be a positive integer');
  }
  if (!Number.isFinite(args.minValue) || !Number.isFinite(args.maxValue) || args.minValue >= args.maxValue) {
    throw new Error('min/max must be numeric and min < max');
  }
  return args;
}

function sleep(ms) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class MetricsTracker {
  constructor() {
    this.sent = 0;
    this.acks = 0;
    this.failures = 0;
    this.dlq = [];
    this.latencyMs = [];
    this.sinkLatencyMs = [];
    this.ingestLagMs = [];
    this.startTimes = new Map();
    this.sequence = 0;
    this.publishStartedAt = null;
    this.publishFinishedAt = null;
  }

  nextSequence() {
    this.sequence += 1;
    return this.sequence;
  }

  recordSend(key) {
    if (!this.publishStartedAt) {
      this.publishStartedAt = Date.now();
    }
    this.sent += 1;
    this.startTimes.set(key, performance.now());
  }

  recordAck(key, metricTimestampIso) {
    const started = this.startTimes.get(key);
    if (started !== undefined) {
      const latency = performance.now() - started;
      this.latencyMs.push(latency);
      this.startTimes.delete(key);
    }
    if (metricTimestampIso) {
      const parsed = Date.parse(metricTimestampIso);
      if (!Number.isNaN(parsed)) {
        this.ingestLagMs.push(Date.now() - parsed);
      }
    }
    this.acks += 1;
  }

  recordFailure(reason) {
    this.failures += 1;
    this.dlq.push(reason);
  }

  recordSinkLatency(durationMs) {
    this.sinkLatencyMs.push(durationMs);
  }

  markPublishingComplete() {
    this.publishFinishedAt = Date.now();
  }

  percentile(collection, ratio) {
    if (collection.length === 0) return 0;
    const sorted = [...collection].sort((a, b) => a - b);
    const index = Math.min(sorted.length - 1, Math.floor(ratio * (sorted.length - 1)));
    return sorted[index];
  }

  summary() {
    const durationSeconds =
      this.publishStartedAt && this.publishFinishedAt
        ? (this.publishFinishedAt - this.publishStartedAt) / 1000
        : 0;
    return {
      sent: this.sent,
      acknowledged: this.acks,
      failures: this.failures,
      dlqReasons: this.dlq,
      publishDurationSeconds: durationSeconds,
      achievedRate: durationSeconds > 0 ? this.sent / durationSeconds : 0,
      ingestLatency: {
        p50: this.percentile(this.latencyMs, 0.5),
        p95: this.percentile(this.latencyMs, 0.95),
        p99: this.percentile(this.latencyMs, 0.99),
      },
      sinkLatency: {
        p50: this.percentile(this.sinkLatencyMs, 0.5),
        p95: this.percentile(this.sinkLatencyMs, 0.95),
        p99: this.percentile(this.sinkLatencyMs, 0.99),
      },
      ingestLagMs: {
        p50: this.percentile(this.ingestLagMs, 0.5),
        p95: this.percentile(this.ingestLagMs, 0.95),
        p99: this.percentile(this.ingestLagMs, 0.99),
      },
    };
  }
}

function createInstrumentedSink(filePath, tracker) {
  const base = createFileSink({ filePath });
  return {
    async write(metric) {
      const started = performance.now();
      await base.write(metric);
      tracker.recordSinkLatency(performance.now() - started);
      const key = createMetricKey(metric);
      tracker.recordAck(key, metric.timestamp);
    },
  };
}

function createMetricKey(metric) {
  return JSON.stringify([metric.name, metric.timestamp ?? '', metric.value]);
}

function buildMetric(args, tracker) {
  const sequence = tracker.nextSequence();
  const metricName = args.metrics[sequence % args.metrics.length];
  const service = args.services[sequence % args.services.length];
  const result = args.resultLabels[sequence % args.resultLabels.length];
  const value =
    args.minValue + ((sequence * 9301 + 49297) % 233280) / 233280 * (args.maxValue - args.minValue);

  return {
    name: metricName,
    value: Number(value.toFixed(2)),
    timestamp: new Date().toISOString(),
    labels: {
      service,
      result,
      source: 'loadgen',
    },
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const tracker = new MetricsTracker();
  const bus = new MemoryBus();
  const sink = createInstrumentedSink(args.output, tracker);
  const consumer = new AnalyticsConsumer({ bus, sink });

  await consumer.start();
  logger.info('analytics-load-gen consumer started', { sink: args.output });

  const dlqSubscription = await bus.subscribe(Topics.broker.deadLetter, async ({ payload }) => {
    const reason = payload?.metadata?.cause ?? 'unknown';
    tracker.recordFailure(reason);
  });

  if (args.backpressureMs > 0) {
    const originalPublish = bus.publish.bind(bus);
    bus.publish = async (topic, envelope, headers) => {
      if (topic === Topics.analytics.metric) {
        await sleep(args.backpressureMs);
      }
      return originalPublish(topic, envelope, headers);
    };
  }

  const endAt = Date.now() + args.duration * 1000;
  const publishers = [];
  const perPublisherRate = args.rate / args.concurrency;
  if (!Number.isFinite(perPublisherRate) || perPublisherRate <= 0) {
    throw new Error('computed per-publisher rate is invalid; check rate and concurrency values');
  }
  const intervalMs = 1000 / perPublisherRate;

  for (let i = 0; i < args.concurrency; i += 1) {
    publishers.push(
      (async () => {
        let nextSend = performance.now();
        while (Date.now() < endAt) {
          const metric = buildMetric(args, tracker);
          const key = createMetricKey(metric);
          const correlationId = crypto.randomUUID();
          tracker.recordSend(key);
          setCorrelationId(correlationId);
          const envelope = createEnvelope(Topics.analytics.metric, metric, correlationId);
          await bus.publish(Topics.analytics.metric, envelope, { 'x-correlation-id': correlationId });
          nextSend += intervalMs;
          const delay = nextSend - performance.now();
          if (delay > 0) {
            await sleep(delay);
          }
        }
      })()
    );
  }

  await Promise.all(publishers);
  tracker.markPublishingComplete();

  // Allow pending writes to settle
  await sleep(500);

  await consumer.stop();
  await dlqSubscription.unsubscribe();

  console.log(JSON.stringify({ args, summary: tracker.summary() }, null, 2));
}

main().catch((error) => {
  logger.error('analytics-load-gen fatal error', {
    error: error instanceof Error ? error.message : error,
  });
  process.exitCode = 1;
});
