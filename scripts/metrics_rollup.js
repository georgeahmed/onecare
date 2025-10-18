#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const fsPromises = fs.promises;
const path = require('node:path');
const readline = require('node:readline');
const crypto = require('node:crypto');
const { logger, createCounter, createHistogram } = require('@onecare/observability');

const DEFAULT_INPUT = process.env.ANALYTICS_SINK_PATH || 'var/analytics/metrics.jsonl';
const DEFAULT_OUTPUT = process.env.ANALYTICS_ROLLUP_PATH || 'var/analytics/rollup.jsonl';
const DEFAULT_WINDOW_NAMES = ['1m', '5m', '1h', '1d'];
const DAY_MS = 24 * 60 * 60 * 1000;

const rollupRunCounter = createCounter('analytics.rollup.run');
const rollupMetricCounter = createCounter('analytics.rollup.metrics_processed');
const rollupWindowCounter = createCounter('analytics.rollup.windows_emitted');
const rollupDurationHistogram = createHistogram('analytics.rollup.duration_ms');
const rollupErrorCounter = createCounter('analytics.rollup.errors');

function generateRunId() {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const suffix = Math.random().toString(36).slice(2, 8);
  return `analytics-rollup-${Date.now()}-${suffix}`;
}

function parseArgs(argv) {
  const args = {
    windows: null,
    backfill: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('-')) continue;
    const next = argv[i + 1];
    if (token === '--input' || token === '-i') {
      args.input = next;
      i += 1;
    } else if (token === '--input-dir') {
      args.inputDir = next;
      args.backfill = true;
      i += 1;
    } else if (token === '--output' || token === '-o') {
      args.output = next;
      i += 1;
    } else if (token === '--date' || token === '-d') {
      args.date = next;
      i += 1;
    } else if (token === '--windows' || token === '--window') {
      args.windows = typeof next === 'string' ? next : '';
      i += 1;
    } else if (token === '--backfill') {
      args.backfill = true;
    }
  }
  return args;
}

function normalizeDate(raw) {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

function coerceNumeric(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const maybe = Number(value);
    if (!Number.isNaN(maybe) && Number.isFinite(maybe)) {
      return maybe;
    }
  }
  return null;
}

async function fileExists(filePath) {
  try {
    await fsPromises.access(filePath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function readMetrics(inputPath, context = {}) {
  const exists = await fileExists(inputPath);
  if (!exists) {
    logger.info('metrics-rollup input file not found, skipping', {
      inputPath,
      runId: context.runId,
    });
    rollupErrorCounter.add(1, { reason: 'input_not_found', runId: context.runId });
    return [];
  }

  const stream = fs.createReadStream(inputPath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const records = [];

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      records.push(parsed);
    } catch (err) {
      logger.warn('metrics-rollup failed to parse line, skipping', {
        line: trimmed.slice(0, 100),
        error: err.message,
        runId: context.runId,
      });
      rollupErrorCounter.add(1, { reason: 'parse_error', runId: context.runId });
    }
  }

  return records;
}

async function readMetricsFromDir(rootPath, context = {}) {
  const resolved = path.resolve(rootPath);
  const exists = await fileExists(resolved);
  if (!exists) {
    logger.info('metrics-rollup input directory not found, skipping', {
      inputDir: resolved,
      runId: context.runId,
    });
    rollupErrorCounter.add(1, { reason: 'input_dir_not_found', runId: context.runId });
    return [];
  }

  const pending = [resolved];
  const aggregated = [];

  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;
    // eslint-disable-next-line no-await-in-loop
    const entries = await fsPromises.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        // eslint-disable-next-line no-await-in-loop
        const metrics = await readMetrics(fullPath, context);
        aggregated.push(...metrics);
      }
    }
  }

  return aggregated;
}

function parseWindowNames(raw) {
  if (!raw) return null;
  if (typeof raw !== 'string') return null;
  const tokens = raw
    .split(',')
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
  return tokens.length ? tokens : null;
}

function parseWindowSpec(name) {
  const match = /^(\d+)([smhd])$/i.exec(name);
  if (!match) {
    throw new Error(`Invalid window definition: ${name}`);
  }
  const value = Number(match[1]);
  const unit = match[2].toLowerCase();
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid window size: ${name}`);
  }
  const multipliers = {
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: DAY_MS,
  };
  const durationMs = multipliers[unit] * value;
  const allowFallbackDate = unit === 'd';
  return {
    name,
    durationMs,
    allowFallbackDate,
  };
}

function resolveWindows(windowList) {
  const names = parseWindowNames(windowList) ?? DEFAULT_WINDOW_NAMES;
  const seen = new Map();
  for (const name of names) {
    const spec = parseWindowSpec(name);
    seen.set(spec.name, spec);
  }
  return Array.from(seen.values()).sort((a, b) => a.durationMs - b.durationMs);
}

function normalizeLabels(labels) {
  if (!labels || typeof labels !== 'object') {
    return {};
  }
  const entries = Object.entries(labels)
    .filter(([key, value]) => typeof key === 'string' && typeof value === 'string')
    .map(([key, value]) => [key.trim(), value.trim()])
    .filter(([key, value]) => key.length > 0 && value.length > 0)
    .sort(([a], [b]) => a.localeCompare(b));
  const normalized = {};
  for (const [key, value] of entries) {
    normalized[key] = value;
  }
  return normalized;
}

function hashLabels(labels) {
  const normalized = normalizeLabels(labels);
  const json = JSON.stringify(normalized);
  const hash = crypto.createHash('sha1').update(json).digest('hex');
  return { normalized, hash };
}

function parseMetricTimestamp(metric) {
  if (!metric || typeof metric !== 'object') return null;
  const raw = metric.timestamp;
  if (!raw || typeof raw !== 'string') return null;
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) return null;
  return parsed;
}

function fallbackDateToMs(date) {
  if (!date) return null;
  const trimmed = date.trim();
  if (!trimmed) return null;
  const parsed = Date.parse(`${trimmed}T00:00:00.000Z`);
  if (Number.isNaN(parsed)) return null;
  return parsed;
}

function resolveWindowStart(timestampMs, spec, fallbackDate) {
  if (typeof timestampMs === 'number' && Number.isFinite(timestampMs)) {
    const floored = Math.floor(timestampMs / spec.durationMs) * spec.durationMs;
    return floored;
  }
  if (spec.allowFallbackDate) {
    const fallbackMs = fallbackDateToMs(fallbackDate);
    if (fallbackMs !== null) {
      return fallbackMs;
    }
  }
  return null;
}

function computePercentile(values, percentile) {
  if (!values.length) return null;
  if (percentile <= 0) return values.reduce((min, value) => Math.min(min, value), Number.POSITIVE_INFINITY);
  if (percentile >= 1) return values.reduce((max, value) => Math.max(max, value), Number.NEGATIVE_INFINITY);
  const sorted = values.slice().sort((a, b) => a - b);
  const rank = percentile * (sorted.length - 1);
  const lowerIndex = Math.floor(rank);
  const upperIndex = Math.ceil(rank);
  if (lowerIndex === upperIndex) {
    return sorted[lowerIndex];
  }
  const lower = sorted[lowerIndex];
  const upper = sorted[upperIndex];
  const weight = rank - lowerIndex;
  return lower + (upper - lower) * weight;
}

function createRollupKey(parts) {
  return `${parts.windowSize}|${parts.windowStartMs}|${parts.metric}|${parts.labelHash}`;
}

function aggregateMetrics(metrics, options = {}) {
  const windows = options.windows ?? resolveWindows(null);
  const defaultDate = options.defaultDate ?? null;
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const aggregates = new Map();

  for (const metric of metrics) {
    if (!metric || typeof metric !== 'object') continue;
    const name = typeof metric.name === 'string' ? metric.name.trim() : '';
    if (!name) continue;

    const timestampMs = parseMetricTimestamp(metric);
    const value = metric.value;
    const numeric = coerceNumeric(value);
    const { normalized: normalizedLabels, hash: labelHash } = hashLabels(metric.labels);

    for (const spec of windows) {
      const windowStartMs = resolveWindowStart(timestampMs, spec, defaultDate);
      if (windowStartMs === null) continue;
      const key = createRollupKey({
        windowSize: spec.name,
        windowStartMs,
        metric: name,
        labelHash,
      });
      const bucket =
        aggregates.get(key) ||
        {
          windowSize: spec.name,
          windowMs: spec.durationMs,
          windowStartMs,
          windowEndMs: windowStartMs + spec.durationMs,
          metric: name,
          labelHash,
          labels: normalizedLabels,
          count: 0,
          numericValues: [],
        };
      bucket.count += 1;
      if (numeric !== null) {
        bucket.numericValues.push(numeric);
      }
      aggregates.set(key, bucket);
    }
  }

  const rollups = [];

  for (const bucket of aggregates.values()) {
    const numericCount = bucket.numericValues.length;
    const p50 = computePercentile(bucket.numericValues, 0.5);
    const p95 = computePercentile(bucket.numericValues, 0.95);
    rollups.push({
      windowSize: bucket.windowSize,
      windowMs: bucket.windowMs,
      windowStart: new Date(bucket.windowStartMs).toISOString(),
      windowEnd: new Date(bucket.windowEndMs).toISOString(),
      metric: bucket.metric,
      labelHash: bucket.labelHash,
      labels: bucket.labels,
      count: bucket.count,
      numericCount,
      p50,
      p95,
      generatedAt,
    });
  }

  rollups.sort((a, b) => {
    if (a.windowStart === b.windowStart) {
      if (a.windowMs === b.windowMs) {
        if (a.metric === b.metric) {
          return a.labelHash.localeCompare(b.labelHash);
        }
        return a.metric.localeCompare(b.metric);
      }
      return a.windowMs - b.windowMs;
    }
    return a.windowStart.localeCompare(b.windowStart);
  });

  return rollups;
}

function normaliseLegacyRollup(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.windowSize && raw.windowStart) {
    const windowMs =
      typeof raw.windowMs === 'number' && Number.isFinite(raw.windowMs) && raw.windowMs > 0 ? raw.windowMs : DAY_MS;
    return {
      windowSize: raw.windowSize,
      windowMs,
      windowStart: raw.windowStart,
      windowEnd: raw.windowEnd ?? new Date(Date.parse(raw.windowStart) + windowMs).toISOString(),
      metric: raw.metric,
      labelHash: raw.labelHash ?? hashLabels(raw.labels).hash,
      labels: normalizeLabels(raw.labels),
      count: raw.count ?? 0,
      numericCount: raw.numericCount ?? 0,
      p50: typeof raw.p50 === 'number' ? raw.p50 : null,
      p95: typeof raw.p95 === 'number' ? raw.p95 : null,
      generatedAt: raw.generatedAt ?? new Date().toISOString(),
    };
  }

  if (raw.date && raw.metric) {
    const labels = normalizeLabels(raw.labels);
    const labelHash = raw.labelHash ?? hashLabels(labels).hash;
    const windowStartMs = fallbackDateToMs(raw.date);
    if (windowStartMs === null) return null;
    const windowStart = new Date(windowStartMs).toISOString();
    return {
      windowSize: '1d',
      windowMs: DAY_MS,
      windowStart,
      windowEnd: new Date(windowStartMs + DAY_MS).toISOString(),
      metric: raw.metric,
      labelHash,
      labels,
      count: raw.count ?? 0,
      numericCount: raw.numericCount ?? 0,
      p50: typeof raw.p50 === 'number' ? raw.p50 : null,
      p95: typeof raw.p95 === 'number' ? raw.p95 : null,
      generatedAt: raw.generatedAt ?? new Date().toISOString(),
    };
  }
  return null;
}

async function readExistingRollups(outputPath, context = {}) {
  const exists = await fileExists(outputPath);
  if (!exists) {
    return new Map();
  }
  const content = await fsPromises.readFile(outputPath, 'utf8');
  const lines = content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const map = new Map();
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      const normalized = normaliseLegacyRollup(parsed);
      if (!normalized) continue;
      const key = createRollupKey({
        windowSize: normalized.windowSize,
        windowStartMs: Date.parse(normalized.windowStart),
        metric: normalized.metric,
        labelHash: normalized.labelHash,
      });
      map.set(key, normalized);
    } catch (err) {
      logger.warn('metrics-rollup failed to parse existing rollup entry', {
        error: err.message,
        runId: context.runId,
      });
      rollupErrorCounter.add(1, { reason: 'existing_rollup_parse', runId: context.runId });
    }
  }
  return map;
}

async function writeRollups(outputPath, rollups, context = {}) {
  if (!rollups.length) {
    logger.info('metrics-rollup no rollups to write', {
      outputPath,
      runId: context.runId,
    });
    return;
  }
  const current = await readExistingRollups(outputPath, context);
  for (const rollup of rollups) {
    const key = createRollupKey({
      windowSize: rollup.windowSize,
      windowStartMs: Date.parse(rollup.windowStart),
      metric: rollup.metric,
      labelHash: rollup.labelHash,
    });
    current.set(key, rollup);
  }
  const next = Array.from(current.values()).sort((a, b) => {
    if (a.windowStart === b.windowStart) {
      if (a.windowMs === b.windowMs) {
        if (a.metric === b.metric) {
          return a.labelHash.localeCompare(b.labelHash);
        }
        return a.metric.localeCompare(b.metric);
      }
      return a.windowMs - b.windowMs;
    }
    return a.windowStart.localeCompare(b.windowStart);
  });

  await fsPromises.mkdir(path.dirname(outputPath), { recursive: true });
  const lines = next.map((entry) => JSON.stringify(entry));
  await fsPromises.writeFile(outputPath, `${lines.join('\n')}\n`, 'utf8');
  logger.info('metrics-rollup wrote rollups', {
    count: next.length,
    outputPath,
    runId: context.runId,
  });
}

async function run(argv = process.argv.slice(2)) {
  const startedAt = Date.now();
  const runId = generateRunId();
  const { input, output, date, windows: windowsRaw, inputDir, backfill } = parseArgs(argv);
  const windows = resolveWindows(windowsRaw);
  const mode = inputDir || backfill ? 'backfill' : 'incremental';
  const outputPath = path.resolve(output || DEFAULT_OUTPUT);
  const defaultDate = normalizeDate(date) || new Date().toISOString().slice(0, 10);
  const runAttributes = { runId, mode };

  rollupRunCounter.add(1, runAttributes);
  logger.info('metrics-rollup run started', {
    ...runAttributes,
    windows: windows.map((spec) => spec.name),
    outputPath,
  });

  let metrics = [];
  if (inputDir) {
    metrics = await readMetricsFromDir(inputDir, runAttributes);
  } else {
    const inputPath = path.resolve(input || DEFAULT_INPUT);
    metrics = await readMetrics(inputPath, runAttributes);
  }
  rollupMetricCounter.add(metrics.length, runAttributes);

  if (!metrics.length) {
    logger.info('metrics-rollup no metrics found', runAttributes);
    rollupDurationHistogram.record(Date.now() - startedAt, runAttributes);
    return;
  }

  const rollups = aggregateMetrics(metrics, {
    windows,
    defaultDate,
    generatedAt: new Date().toISOString(),
  });
  rollupWindowCounter.add(rollups.length, runAttributes);

  if (!rollups.length) {
    logger.warn('metrics-rollup generated an empty rollup set', runAttributes);
    rollupErrorCounter.add(1, { ...runAttributes, reason: 'no_rollups_generated' });
    rollupDurationHistogram.record(Date.now() - startedAt, runAttributes);
    return;
  }

  await writeRollups(outputPath, rollups, runAttributes);
  const durationMs = Date.now() - startedAt;
  rollupDurationHistogram.record(durationMs, runAttributes);
  logger.info('metrics-rollup completed', {
    ...runAttributes,
    processed: metrics.length,
    rollups: rollups.length,
    outputPath,
    windows: windows.map((spec) => spec.name),
    durationMs,
  });
}

if (require.main === module) {
  run().catch((err) => {
    logger.error('metrics-rollup fatal error', {
      error: err instanceof Error ? err.message : err,
    });
    process.exitCode = 1;
  });
}

module.exports = {
  aggregateMetrics,
  computePercentile,
  createRollupKey,
  normalizeLabels,
  parseArgs,
  parseWindowNames,
  parseWindowSpec,
  readExistingRollups,
  readMetrics,
  readMetricsFromDir,
  resolveWindowStart,
  resolveWindows,
  run,
  writeRollups,
};
