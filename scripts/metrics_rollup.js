#!/usr/bin/env node
'use strict';

const fs = require('fs');
const fsPromises = fs.promises;
const path = require('path');
const readline = require('readline');

const DEFAULT_INPUT = process.env.ANALYTICS_SINK_PATH || 'var/analytics/metrics.jsonl';
const DEFAULT_OUTPUT = process.env.ANALYTICS_ROLLUP_PATH || 'var/analytics/rollup.jsonl';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('-')) continue;
    const next = argv[i + 1];
    if (token === '--input' || token === '-i') {
      args.input = next;
      i += 1;
    } else if (token === '--output' || token === '-o') {
      args.output = next;
      i += 1;
    } else if (token === '--date' || token === '-d') {
      args.date = next;
      i += 1;
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

function dateFromMetric(metric, fallbackDate) {
  const fromTimestamp = typeof metric.timestamp === 'string' ? normalizeDate(metric.timestamp) : null;
  return fromTimestamp || fallbackDate;
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

function percentile95(values) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const rank = Math.ceil(0.95 * sorted.length);
  const index = Math.min(sorted.length - 1, Math.max(rank - 1, 0));
  return sorted[index];
}

async function fileExists(filePath) {
  try {
    await fsPromises.access(filePath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function readMetrics(inputPath) {
  const exists = await fileExists(inputPath);
  if (!exists) {
    console.warn(`[metrics-rollup] input file not found, skipping: ${inputPath}`);
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
      console.warn('[metrics-rollup] failed to parse line, skipping', { line: trimmed.slice(0, 100), error: err.message });
    }
  }

  return records;
}

async function writeRollups(outputPath, rollups) {
  if (!rollups.length) {
    console.info('[metrics-rollup] no rollups to write');
    return;
  }
  await fsPromises.mkdir(path.dirname(outputPath), { recursive: true });
  const lines = rollups.map((entry) => JSON.stringify(entry));
  await fsPromises.writeFile(outputPath, `${lines.join('\n')}\n`, 'utf8');
  console.info('[metrics-rollup] wrote rollups', { count: rollups.length, outputPath });
}

async function run() {
  const { input, output, date } = parseArgs(process.argv.slice(2));
  const inputPath = path.resolve(input || DEFAULT_INPUT);
  const outputPath = path.resolve(output || DEFAULT_OUTPUT);
  const defaultDate = normalizeDate(date) || new Date().toISOString().slice(0, 10);

  const metrics = await readMetrics(inputPath);
  if (!metrics.length) {
    console.info('[metrics-rollup] no metrics found, exiting');
    return;
  }

  const aggregates = new Map();
  let processed = 0;

  for (const metric of metrics) {
    if (!metric || typeof metric !== 'object') continue;
    if (typeof metric.name !== 'string' || metric.name.trim().length === 0) continue;
    const metricDate = dateFromMetric(metric, defaultDate);
    if (!metricDate) continue;
    processed += 1;
    const key = `${metricDate}::${metric.name}`;
    const bucket = aggregates.get(key) || { date: metricDate, metric: metric.name, count: 0, numericValues: [] };
    bucket.count += 1;
    const numeric = coerceNumeric(metric.value);
    if (numeric !== null) {
      bucket.numericValues.push(numeric);
    }
    aggregates.set(key, bucket);
  }

  const rollups = [];
  const generatedAt = new Date().toISOString();

  for (const bucket of aggregates.values()) {
    const numericCount = bucket.numericValues.length;
    const p95 = percentile95(bucket.numericValues);
    rollups.push({
      date: bucket.date,
      metric: bucket.metric,
      count: bucket.count,
      numericCount,
      p95,
      generatedAt,
    });
  }

  rollups.sort((a, b) => {
    if (a.date === b.date) return a.metric.localeCompare(b.metric);
    return a.date.localeCompare(b.date);
  });

  await writeRollups(outputPath, rollups);
  console.info('[metrics-rollup] completed', {
    processed,
    rollups: rollups.length,
    inputPath,
    outputPath,
  });
}

run().catch((err) => {
  console.error('[metrics-rollup] fatal error', err);
  process.exitCode = 1;
});
