#!/usr/bin/env node
'use strict';

/**
 * Feature backfill & recompute framework
 *
 * - Supports date-ranged backfills with resumable ledger checkpoints.
 * - Derives feature payloads for supported feature sets and validates against the registry.
 * - Writes outputs idempotently (JSONL snapshots) and optionally hydrates the in-memory feature store.
 *
 * Usage examples:
 *   node scripts/feature_backfill.js --input data/backfill/triage-core.jsonl --feature-set triage-core
 *   node scripts/feature_backfill.js --input-root data/backfill --start 2025-01-01 --end 2025-01-07 --feature-set triage-core
 *
 * Environment overrides:
 *   FEATURE_BACKFILL_INPUT, FEATURE_BACKFILL_OUTPUT, FEATURE_BACKFILL_SET,
 *   FEATURE_BACKFILL_LEDGER, FEATURE_BACKFILL_INPUT_ROOT, FEATURE_BACKFILL_PARALLELISM
 */

const fs = require('node:fs');
const fsPromises = fs.promises;
const path = require('node:path');
const readline = require('node:readline');
const crypto = require('node:crypto');

const DEFAULT_INPUT = process.env.FEATURE_BACKFILL_INPUT || 'data/backfill/triage-input.jsonl';
const DEFAULT_INPUT_ROOT = process.env.FEATURE_BACKFILL_INPUT_ROOT || 'data/backfill';
const DEFAULT_OUTPUT = process.env.FEATURE_BACKFILL_OUTPUT || 'var/features/triage-core.jsonl';
const DEFAULT_FEATURE_SET = process.env.FEATURE_BACKFILL_SET || 'triage-core';
const DEFAULT_LEDGER = process.env.FEATURE_BACKFILL_LEDGER || 'var/features/backfill-ledger.jsonl';
const DEFAULT_PARALLELISM = Number.parseInt(process.env.FEATURE_BACKFILL_PARALLELISM || '2', 10);

const DAY_MS = 24 * 60 * 60 * 1000;

let validateFeaturePayload = null;
let getFeatureSchemaId = null;

try {
  ({ validateFeaturePayload, getFeatureSchemaId } = require('@onecare/ports'));
} catch (error) {
  const { validate } = require('@onecare/domain');
  const registry = loadFeatureRegistry();
  validateFeaturePayload = (featureSet, payload) => {
    const schemaId = registry[featureSet];
    if (!schemaId) {
      throw new Error(`Unknown feature set: ${featureSet}`);
    }
    return validate(schemaId, payload);
  };
  getFeatureSchemaId = (featureSet) => loadFeatureRegistry()[featureSet];
}

let InMemoryFeatureStore;
try {
  ({ InMemoryFeatureStore } = require('@onecare/feature-store-memory'));
} catch (error) {
  InMemoryFeatureStore = class {
    constructor() {
      this.store = new Map();
    }
    async putFeatures(key, record) {
      this.store.set(key, record);
    }
  };
}

function loadFeatureRegistry() {
  const registryPath = path.resolve(__dirname, '..', 'schemas', 'features', 'registry.json');
  try {
    const raw = fs.readFileSync(registryPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed?.featureSets && Array.isArray(parsed.featureSets)) {
      return parsed.featureSets.reduce((acc, set) => {
        if (set?.name && set?.schemaId) {
          acc[set.name] = set.schemaId;
        }
        return acc;
      }, {});
    }
  } catch (error) {
    // fall through to defaults
  }
  return {
    'triage-core': 'https://onecare/schemas/features/triage-core.json',
    'acuity-signal': 'https://onecare/schemas/features/acuity-signal.json',
  };
}

function parseArgs(argv) {
  const args = {
    input: null,
    inputRoot: null,
    output: DEFAULT_OUTPUT,
    featureSet: DEFAULT_FEATURE_SET,
    start: null,
    end: null,
    parallelism: DEFAULT_PARALLELISM,
    ledger: DEFAULT_LEDGER,
    dryRun: false,
    resume: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = argv[i + 1];
    switch (token) {
      case '--input':
      case '-i':
        args.input = next;
        i += 1;
        break;
      case '--input-root':
        args.inputRoot = next;
        i += 1;
        break;
      case '--output':
      case '-o':
        args.output = next;
        i += 1;
        break;
      case '--feature-set':
      case '-f':
        args.featureSet = next;
        i += 1;
        break;
      case '--start':
      case '-s':
        args.start = next;
        i += 1;
        break;
      case '--end':
      case '-e':
        args.end = next;
        i += 1;
        break;
      case '--date':
      case '-d':
        args.start = next;
        args.end = next;
        i += 1;
        break;
      case '--parallelism':
      case '-p':
        args.parallelism = Number.parseInt(next, 10);
        i += 1;
        break;
      case '--ledger':
        args.ledger = next;
        i += 1;
        break;
      case '--dry-run':
        args.dryRun = true;
        break;
      case '--resume':
        args.resume = true;
        break;
      default:
        break;
    }
  }

  if (args.input && args.inputRoot) {
    throw new Error('Provide either --input or --input-root (not both)');
  }

  if (!args.input && !args.inputRoot) {
    args.input = DEFAULT_INPUT;
  }

  if (args.inputRoot && (!args.start || !args.end)) {
    throw new Error('--input-root requires --start/--end (or --date)');
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

function enumerateDateRange(start, end) {
  const normalizedStart = normalizeDate(start);
  const normalizedEnd = normalizeDate(end);
  if (!normalizedStart || !normalizedEnd) {
    throw new Error('Invalid start/end date');
  }
  const startMs = Date.parse(`${normalizedStart}T00:00:00Z`);
  const endMs = Date.parse(`${normalizedEnd}T00:00:00Z`);
  if (startMs > endMs) {
    throw new Error('start date must be <= end date');
  }
  const dates = [];
  for (let ms = startMs; ms <= endMs; ms += DAY_MS) {
    dates.push(new Date(ms).toISOString().slice(0, 10));
  }
  return dates;
}

async function readLedgerEntries(ledgerPath) {
  try {
    const raw = await fsPromises.readFile(ledgerPath, 'utf8');
    return raw
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

function collectCompletedPartitions(entries, jobKey) {
  const completed = new Set();
  for (const entry of entries) {
    if (
      entry &&
      entry.type === 'partition' &&
      entry.jobKey === jobKey &&
      (entry.status === 'success' || entry.status === 'dry-run')
    ) {
      const date = entry.partition?.date;
      if (date) completed.add(date);
    }
  }
  return completed;
}

function createSequentialExecutor() {
  let previous = Promise.resolve();
  return (task) => {
    const run = previous.then(task, task);
    previous = run.catch(() => {});
    return run;
  };
}

function createLedger(ledgerPath) {
  const appendQueue = createSequentialExecutor();
  return {
    async append(entry) {
      await appendQueue(async () => {
        await fsPromises.mkdir(path.dirname(ledgerPath), { recursive: true });
        await fsPromises.appendFile(ledgerPath, `${JSON.stringify(entry)}\n`, 'utf8');
      });
    },
  };
}

async function readJsonl(filePath) {
  const records = [];
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed));
    } catch (error) {
      records.push({ __parseError: true, raw: trimmed, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return records;
}

function deriveFeatureRecords(event, featureSet) {
  switch (featureSet) {
    case 'triage-core':
      return deriveTriageCore(event);
    case 'acuity-signal':
      return deriveAcuitySignal(event);
    default:
      throw new Error(`Unsupported feature set: ${featureSet}`);
  }
}

function safeNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (!Number.isNaN(parsed) && Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function clamp(value, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function deriveTriageCore(event) {
  const envelope = event || {};
  const payload = envelope.payload && typeof envelope.payload === 'object' ? envelope.payload : envelope;
  const patientId = payload.patientId || payload.patient_id || payload.entityId;
  if (!patientId || typeof patientId !== 'string') {
    return [];
  }
  const base = payload.features && typeof payload.features === 'object' ? payload.features : {};
  const generatedAt =
    (typeof envelope.timestamp === 'string' && envelope.timestamp) ||
    (typeof payload.generatedAt === 'string' && payload.generatedAt) ||
    new Date().toISOString();
  const scores = ['acuity', 'risk', 'complexity', 'time', 'capacity'].reduce((acc, key) => {
    const numeric = clamp(safeNumber(base[key]) ?? 0, 0, 1);
    acc[key] = numeric ?? 0;
    return acc;
  }, {});
  const composite =
    safeNumber(base.compositeScore) ??
    Object.values(scores).reduce((acc, value) => acc + value, 0) / Math.max(Object.keys(scores).length, 1);
  const featureVector = {
    schemaVersion: typeof base.schemaVersion === 'string' ? base.schemaVersion : 'v1.0.0',
    generatedAt,
    ...scores,
    compositeScore: composite ?? 0,
    source: typeof base.source === 'string' ? base.source : 'backfill',
  };
  if (typeof base.expiresAt === 'string') {
    featureVector.expiresAt = base.expiresAt;
  }
  const extensions = {};
  for (const [key, value] of Object.entries(base)) {
    if (key in scores || key === 'compositeScore' || key === 'schemaVersion' || key === 'expiresAt' || key === 'source') {
      continue;
    }
    extensions[key] = value;
  }
  if (Object.keys(extensions).length > 0) {
    featureVector.extensions = extensions;
  }
  return [
    {
      featureSet: 'triage-core',
      entityId: patientId,
      asOf: generatedAt,
      payload: featureVector,
    },
  ];
}

function deriveAcuitySignal(event) {
  const payload = event.payload && typeof event.payload === 'object' ? event.payload : event;
  const entityId = payload.patientId || payload.entityId;
  if (!entityId || typeof entityId !== 'string') {
    return [];
  }
  const generatedAt = payload.generatedAt || payload.timestamp || new Date().toISOString();
  const score = clamp(safeNumber(payload.score) ?? 0, 0, 1) ?? 0;
  const confidence = clamp(safeNumber(payload.confidence) ?? 0, 0, 1) ?? 0;
  const vector = {
    schemaVersion: typeof payload.schemaVersion === 'string' ? payload.schemaVersion : 'v1.0.0',
    generatedAt,
    score,
    confidence,
  };
  if (typeof payload.modelVersion === 'string') {
    vector.modelVersion = payload.modelVersion;
  }
  return [
    {
      featureSet: 'acuity-signal',
      entityId,
      asOf: generatedAt,
      payload: vector,
    },
  ];
}

function computeFeatureKey(record) {
  const parts = [
    record.featureSet ?? 'unknown',
    record.entityId ?? 'unknown',
    record.asOf ?? record.payload?.generatedAt ?? '',
  ];
  return parts.join('|');
}

async function readExistingFeatures(outputPath) {
  const map = new Map();
  try {
    const records = await readJsonl(outputPath);
    for (const record of records) {
      if (!record || typeof record !== 'object') continue;
      const key = computeFeatureKey(record);
      map.set(key, record);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return map;
}

async function writeFeatures(outputPath, records) {
  if (records.length === 0) return;
  const existing = await readExistingFeatures(outputPath);
  for (const record of records) {
    const key = computeFeatureKey(record);
    existing.set(key, record);
  }
  const sorted = Array.from(existing.values()).sort((a, b) => {
    if (a.featureSet !== b.featureSet) return a.featureSet.localeCompare(b.featureSet);
    if (a.entityId !== b.entityId) return a.entityId.localeCompare(b.entityId);
    const aAsOf = a.asOf ?? a.payload?.generatedAt ?? '';
    const bAsOf = b.asOf ?? b.payload?.generatedAt ?? '';
    return aAsOf.localeCompare(bAsOf);
  });
  await fsPromises.mkdir(path.dirname(outputPath), { recursive: true });
  const lines = sorted.map((record) => JSON.stringify(record));
  await fsPromises.writeFile(outputPath, `${lines.join('\n')}\n`, 'utf8');
}

async function processPartition(partition, context) {
  const { featureSet, ledger, outputPath, dryRun, store } = context;
  const partitionStart = Date.now();
  const partitionInfo = {
    partition: { date: partition.date },
    inputPath: partition.inputPath,
  };

  await ledger.append({
    version: 1,
    type: 'partition',
    event: 'start',
    jobKey: context.jobKey,
    runId: context.runId,
    timestamp: new Date().toISOString(),
    ...partitionInfo,
  });

  const exists = await fsPromises
    .access(partition.inputPath, fs.constants.F_OK)
    .then(() => true)
    .catch(() => false);
  if (!exists) {
    await ledger.append({
      version: 1,
      type: 'partition',
      event: 'error',
      jobKey: context.jobKey,
      runId: context.runId,
      status: 'missing',
      timestamp: new Date().toISOString(),
      ...partitionInfo,
    });
    return {
      status: 'missing',
      processed: 0,
      written: 0,
      invalid: 0,
      missingKey: 0,
      durationMs: Date.now() - partitionStart,
    };
  }

  const inputRecords = await readJsonl(partition.inputPath);
  let processed = 0;
  let written = 0;
  let invalid = 0;
  let missingKey = 0;
  const derivedRecords = [];

  for (const event of inputRecords) {
    if (event?.__parseError) {
      invalid += 1;
      continue;
    }
    processed += 1;
    let derived = [];
    try {
      derived = deriveFeatureRecords(event, featureSet);
    } catch (error) {
      invalid += 1;
      continue;
    }
    for (const record of derived) {
      const validation = validateFeaturePayload(featureSet, record.payload);
      if (!validation.ok) {
        invalid += 1;
        continue;
      }
      if (!record.entityId) {
        missingKey += 1;
        continue;
      }
      derivedRecords.push(record);
      written += 1;
    }
  }

  if (!dryRun && derivedRecords.length > 0) {
    await writeFeatures(outputPath, derivedRecords);
    if (store) {
      for (const record of derivedRecords) {
        const storeKey = `${record.featureSet}:${record.entityId}`;
        await store.putFeatures(storeKey, record);
      }
    }
  }

  const durationMs = Date.now() - partitionStart;
  const status = dryRun ? 'dry-run' : 'success';

  await ledger.append({
    version: 1,
    type: 'partition',
    event: 'complete',
    jobKey: context.jobKey,
    runId: context.runId,
    status,
    timestamp: new Date().toISOString(),
    processed,
    written,
    invalid,
    missingKey,
    durationMs,
    ...partitionInfo,
  });

  return { status, processed, written, invalid, missingKey, durationMs };
}

async function gatherPartitions(args) {
  if (args.input) {
    return [
      {
        date: new Date().toISOString().slice(0, 10),
        inputPath: path.resolve(args.input),
      },
    ];
  }
  const inputRoot = path.resolve(args.inputRoot || DEFAULT_INPUT_ROOT);
  const dates = enumerateDateRange(args.start, args.end);
  return dates.map((date) => ({
    date,
    inputPath: path.join(inputRoot, date, `${args.featureSet}.jsonl`),
  }));
}

function createJobKey(options) {
  const payload = {
    featureSet: options.featureSet,
    outputPath: options.outputPath,
    partitions: options.partitions.map((p) => p.date),
  };
  return crypto.createHash('sha1').update(JSON.stringify(payload)).digest('hex');
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  const featureSet = args.featureSet;
  if (!getFeatureSchemaId(featureSet)) {
    throw new Error(`Unknown feature set: ${featureSet}`);
  }

  const partitions = await gatherPartitions(args);
  if (partitions.length === 0) {
    console.info('[feature-backfill] no partitions to process');
    return;
  }

  const runId = crypto.randomUUID();
  const jobKey = createJobKey({ featureSet, outputPath: args.output, partitions });
  const ledgerPath = path.resolve(args.ledger || DEFAULT_LEDGER);
  const ledger = createLedger(ledgerPath);

  const previousEntries = args.resume ? await readLedgerEntries(ledgerPath) : [];
  const completed = args.resume ? collectCompletedPartitions(previousEntries, jobKey) : new Set();

  const store = args.dryRun ? null : new InMemoryFeatureStore();
  const context = {
    featureSet,
    outputPath: path.resolve(args.output || DEFAULT_OUTPUT),
    dryRun: Boolean(args.dryRun),
    runId,
    jobKey,
    ledger,
    store,
  };

  await ledger.append({
    version: 1,
    type: 'job',
    event: 'start',
    runId,
    jobKey,
    timestamp: new Date().toISOString(),
    params: {
      featureSet,
      outputPath: context.outputPath,
      partitions: partitions.map((p) => p.date),
      dryRun: context.dryRun,
      resume: args.resume,
      parallelism: args.parallelism,
    },
  });

  const results = {
    processedPartitions: 0,
    skippedPartitions: 0,
    failedPartitions: 0,
    processedRecords: 0,
    writtenRecords: 0,
    invalidRecords: 0,
    missingKeyRecords: 0,
  };

  const concurrency = Math.max(1, Number.isFinite(args.parallelism) ? args.parallelism : DEFAULT_PARALLELISM);
  const executor = createSequentialExecutor();
  const queue = [];

  for (const partition of partitions) {
    if (completed.has(partition.date)) {
      results.skippedPartitions += 1;
      await ledger.append({
        version: 1,
        type: 'partition',
        event: 'resume-skip',
        status: 'skipped',
        jobKey,
        runId,
        timestamp: new Date().toISOString(),
        partition: { date: partition.date },
      });
      continue;
    }
    const task = async () => {
      const summary = await processPartition(partition, context);
      if (summary.status === 'missing') {
        results.failedPartitions += 1;
      } else {
        results.processedPartitions += 1;
      }
      results.processedRecords += summary.processed ?? 0;
      results.writtenRecords += summary.written ?? 0;
      results.invalidRecords += summary.invalid ?? 0;
      results.missingKeyRecords += summary.missingKey ?? 0;
      return summary;
    };
    queue.push(task);
  }

  async function runWithConcurrency(tasks, limit) {
    const executing = new Set();
    const outcomes = [];
    for (const task of tasks) {
      const promise = task().finally(() => executing.delete(promise));
      executing.add(promise);
      outcomes.push(promise);
      if (executing.size >= limit) {
        await Promise.race(executing);
      }
    }
    await Promise.all(outcomes);
  }

  await runWithConcurrency(queue, concurrency);

  const status = results.failedPartitions > 0 ? 'failed' : 'completed';

  await ledger.append({
    version: 1,
    type: 'job',
    event: 'complete',
    runId,
    jobKey,
    status,
    timestamp: new Date().toISOString(),
    summary: results,
  });

  const output = {
    runId,
    jobKey,
    status,
    ...results,
    dryRun: context.dryRun,
    outputPath: context.outputPath,
    ledgerPath,
  };

  console.log(JSON.stringify(output, null, 2));

  if (status === 'failed') {
    process.exitCode = 1;
  }
}

run().catch((error) => {
  console.error('[feature-backfill] fatal error', error);
  process.exitCode = 1;
});
