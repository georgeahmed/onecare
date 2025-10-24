#!/usr/bin/env node
'use strict';

/**
 * Analytics playback harness
 *
 * Replays deterministic analytics.metric fixtures through the in-process consumer. Useful for CI
 * and local smoke tests without requiring a running NATS cluster.
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const crypto = require('node:crypto');
const { MemoryBus } = require('@onecare/bus');
const { Topics, createEnvelope } = require('@onecare/events');
const { logger, setCorrelationId } = require('@onecare/observability');
const { AnalyticsConsumer, createFileSink, resolveAnalyticsSinkPath } = require('../../apps/analytics/dist/index.js');

function usageAndExit(message) {
  if (message) {
    console.error(`[analytics-playback] ${message}`);
  }
  console.error('Usage: node scripts/bench/analytics_playback.js --fixtures <path[,path]> [--output <file>] [--delay-ms <n>]');
  process.exit(1);
}

function parseArgs(argv) {
  const args = {
    fixtures: [],
    output: resolveAnalyticsSinkPath(),
    delayMs: 0,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = argv[i + 1];
    switch (token) {
      case '--fixtures':
        if (!next) usageAndExit('missing value for --fixtures');
        args.fixtures = next.split(',').map((entry) => entry.trim()).filter(Boolean);
        i += 1;
        break;
      case '--output':
        if (!next) usageAndExit('missing value for --output');
        args.output = path.resolve(next);
        i += 1;
        break;
      case '--delay-ms':
        if (!next) usageAndExit('missing value for --delay-ms');
        args.delayMs = Number(next);
        i += 1;
        break;
      default:
        usageAndExit(`unknown argument: ${token}`);
    }
  }

  if (args.fixtures.length === 0) {
    usageAndExit('at least one fixture file must be provided via --fixtures');
  }
  if (!Number.isFinite(args.delayMs) || args.delayMs < 0) {
    usageAndExit('--delay-ms must be a positive integer (or zero)');
  }

  return args;
}

const DEFAULT_EXPECTATION = 'success';

class PlaybackTracker {
  constructor() {
    this.events = new Map(); // correlationId -> { expected, actual, key, timestamp }
    this.keyToCorrelations = new Map(); // key -> [correlationIds]
    this.latencyMs = [];
    this.ingestLagMs = [];
    this.failures = [];
    this.sent = 0;
    this.acknowledged = 0;
    this.dlqCount = 0;
    this.startTimes = new Map(); // correlationId -> perf.now
  }

  recordSend(correlationId, expectedOutcome, key, timestamp) {
    const expectation = expectedOutcome ?? DEFAULT_EXPECTATION;
    this.events.set(correlationId, {
      expected: expectation,
      actual: null,
      key,
      timestamp,
    });
    const list = this.keyToCorrelations.get(key) ?? [];
    list.push(correlationId);
    this.keyToCorrelations.set(key, list);
    this.startTimes.set(correlationId, performance.now());
    this.sent += 1;
  }

  recordAck(key) {
    const correlations = this.keyToCorrelations.get(key);
    if (!correlations || correlations.length === 0) {
      return;
    }
    const correlationId = correlations.shift();
    if (correlations.length === 0) {
      this.keyToCorrelations.delete(key);
    }
    const event = this.events.get(correlationId);
    if (!event) return;
    const started = this.startTimes.get(correlationId);
    if (started !== undefined) {
      this.latencyMs.push(performance.now() - started);
      this.startTimes.delete(correlationId);
    }
    if (event.timestamp) {
      const parsed = Date.parse(event.timestamp);
      if (!Number.isNaN(parsed)) {
        this.ingestLagMs.push(Date.now() - parsed);
      }
    }
    event.actual = 'success';
    this.acknowledged += 1;
  }

  recordDlq(correlationId, cause) {
    const event = this.events.get(correlationId);
    if (event) {
      event.actual = 'dlq';
      if (event.key && this.keyToCorrelations.has(event.key)) {
        const queue = this.keyToCorrelations.get(event.key);
        const index = queue.indexOf(correlationId);
        if (index >= 0) {
          queue.splice(index, 1);
        }
        if (queue.length === 0) {
          this.keyToCorrelations.delete(event.key);
        }
      }
    } else {
      this.events.set(correlationId, {
        expected: DEFAULT_EXPECTATION,
        actual: 'dlq',
        key: null,
        timestamp: null,
      });
    }
    this.startTimes.delete(correlationId);
    this.dlqCount += 1;
    this.failures.push({ correlationId, cause });
  }

  verifyExpectations() {
    const mismatches = [];
    for (const [correlationId, record] of this.events.entries()) {
      const expected = record.expected ?? DEFAULT_EXPECTATION;
      const actual = record.actual ?? 'unknown';
      if (expected !== actual) {
        mismatches.push({ correlationId, expected, actual });
      }
    }
    const outstanding = Array.from(this.startTimes.keys()).map((correlationId) => ({
      correlationId,
      expected: this.events.get(correlationId)?.expected ?? DEFAULT_EXPECTATION,
      actual: 'pending',
    }));
    return { mismatches, outstanding };
  }

  percentile(collection, ratio) {
    if (collection.length === 0) return 0;
    const sorted = [...collection].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.floor(ratio * (sorted.length - 1)));
    return sorted[idx];
  }

  summary() {
    return {
      sent: this.sent,
      acknowledged: this.acknowledged,
      dlq: this.dlqCount,
      ingestLatency: {
        p50: this.percentile(this.latencyMs, 0.5),
        p95: this.percentile(this.latencyMs, 0.95),
      },
      ingestLagMs: {
        p50: this.percentile(this.ingestLagMs, 0.5),
        p95: this.percentile(this.ingestLagMs, 0.95),
      },
      failures: this.failures,
    };
  }
}

function createPlaybackSink(filePath, tracker) {
  const base = createFileSink({ filePath });
  return {
    async write(metric) {
      await base.write(metric);
      const key = createMetricKey(metric);
      tracker.recordAck(key);
    },
  };
}

function createMetricKey(metric) {
  return JSON.stringify([metric.name ?? '', metric.timestamp ?? '', metric.value ?? '']);
}

async function loadFixtures(paths) {
  const envelopes = [];
  for (const fixturePath of paths) {
    const absolute = path.resolve(fixturePath);
    const raw = await fs.readFile(absolute, 'utf8');
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(`Failed to parse fixture ${absolute}: ${error instanceof Error ? error.message : error}`);
    }
    const items = Array.isArray(parsed) ? parsed : parsed.envelopes;
    if (!Array.isArray(items)) {
      throw new Error(`Fixture ${absolute} missing 'envelopes' array`);
    }
    for (const entry of items) {
      if (!entry || typeof entry !== 'object') {
        throw new Error(`Fixture ${absolute} contains invalid entry`);
      }
      const correlationId = entry.correlationId ?? cryptoSafeId();
      const payload = entry.payload;
      if (!payload || typeof payload !== 'object') {
        throw new Error(`Fixture ${absolute} entry missing payload`);
      }
      envelopes.push({
        source: absolute,
        correlationId,
        topic: entry.topic ?? Topics.analytics.metric,
        payload,
        expected: entry.expected ?? DEFAULT_EXPECTATION,
      });
    }
  }
  return envelopes;
}

function cryptoSafeId() {
  return crypto.randomUUID();
}

async function ensureOutputReady(outputPath) {
  await fs.rm(outputPath, { force: true });
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const tracker = new PlaybackTracker();
  const events = await loadFixtures(args.fixtures);

  if (events.length === 0) {
    logger.info('analytics-playback: no events to process');
    return;
  }

  await ensureOutputReady(args.output);

  const bus = new MemoryBus();
  const sink = createPlaybackSink(args.output, tracker);
  const consumer = new AnalyticsConsumer({ bus, sink });
  await consumer.start();

  const dlqSubscription = await bus.subscribe(Topics.broker.deadLetter, async ({ payload }) => {
    const correlationId = payload?.correlationId;
    const cause = payload?.payload?.cause ?? payload?.cause ?? 'unknown';
    if (correlationId) {
      tracker.recordDlq(correlationId, cause);
    } else {
      tracker.failures.push({ correlationId: 'unknown', cause });
    }
  });

  for (const event of events) {
    const key = createMetricKey(event.payload);
    tracker.recordSend(event.correlationId, event.expected, key, event.payload.timestamp);
    setCorrelationId(event.correlationId);
    const envelope = createEnvelope(event.topic, event.payload, event.correlationId);
    await bus.publish(event.topic, envelope, { 'x-correlation-id': event.correlationId });
    if (args.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, args.delayMs));
    }
  }

  // allow writes to settle
  await new Promise((resolve) => setTimeout(resolve, 100));

  await consumer.stop();
  await dlqSubscription.unsubscribe();

  const { mismatches, outstanding } = tracker.verifyExpectations();
  if (mismatches.length > 0 || outstanding.length > 0) {
    const error = {
      mismatches,
      outstanding,
      summary: tracker.summary(),
    };
    throw new Error(`analytics playback mismatch: ${JSON.stringify(error, null, 2)}`);
  }

  console.log(JSON.stringify({ output: args.output, summary: tracker.summary() }, null, 2));
}

main().catch((error) => {
  logger.error('analytics-playback fatal error', {
    error: error instanceof Error ? error.message : error,
  });
  process.exitCode = 1;
});
