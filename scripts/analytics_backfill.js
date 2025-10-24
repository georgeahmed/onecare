#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const fsPromises = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const { logger, createCounter, createHistogram } = require('@onecare/observability');
const rollup = require('./metrics_rollup.js');
const { createLineageEmitter, resolveGitCommit } = require('./analytics/lineage.js');

const DEFAULT_INPUT_ROOT = process.env.ANALYTICS_BACKFILL_INPUT_ROOT || 'var/analytics/backfill';
const DEFAULT_OUTPUT = process.env.ANALYTICS_BACKFILL_OUTPUT || process.env.ANALYTICS_ROLLUP_PATH || 'var/analytics/rollup.jsonl';
const DEFAULT_LEDGER_PATH = process.env.ANALYTICS_BACKFILL_LEDGER || 'var/analytics/backfill-ledger.jsonl';
const DEFAULT_WINDOWS = process.env.ANALYTICS_BACKFILL_WINDOWS || null;
const DEFAULT_PARALLELISM = Number.parseInt(process.env.ANALYTICS_BACKFILL_PARALLELISM || '2', 10);
const JOB_NAME = 'analytics-rollup-backfill';
const DAY_MS = 24 * 60 * 60 * 1000;
const ROLLUP_SCHEMA_ID = 'analytics_rollup_v1';

const backfillRunCounter = createCounter('analytics.backfill.run');
const backfillPartitionCounter = createCounter('analytics.backfill.partition');
const backfillErrorCounter = createCounter('analytics.backfill.errors');
const backfillDurationHistogram = createHistogram('analytics.backfill.duration_ms');

class BackfillRunError extends Error {
  constructor(message, summary) {
    super(message);
    this.name = 'BackfillRunError';
    this.summary = summary;
  }
}

function generateRunId() {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const suffix = Math.random().toString(36).slice(2, 10);
  return `${JOB_NAME}-${Date.now()}-${suffix}`;
}

function parseArgs(argv) {
  const args = {
    parallelism: Number.isFinite(DEFAULT_PARALLELISM) && DEFAULT_PARALLELISM > 0 ? DEFAULT_PARALLELISM : 2,
    dryRun: false,
    resume: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('-')) continue;
    const value = argv[i + 1];
    switch (token) {
      case '--start':
      case '-s':
        if (value) {
          args.start = value;
          i += 1;
        }
        break;
      case '--end':
      case '-e':
        if (value) {
          args.end = value;
          i += 1;
        }
        break;
      case '--date':
      case '-d':
        if (value) {
          args.start = value;
          args.end = value;
          i += 1;
        }
        break;
      case '--input-root':
      case '-i':
        if (value) {
          args.inputRoot = value;
          i += 1;
        }
        break;
      case '--output':
      case '-o':
        if (value) {
          args.output = value;
          i += 1;
        }
        break;
      case '--ledger':
      case '-l':
        if (value) {
          args.ledger = value;
          i += 1;
        }
        break;
      case '--windows':
      case '-w':
        if (value) {
          args.windows = value;
          i += 1;
        }
        break;
      case '--parallelism':
      case '-p':
        if (value) {
          const parsed = Number.parseInt(value, 10);
          if (Number.isFinite(parsed) && parsed > 0) {
            args.parallelism = parsed;
          }
          i += 1;
        }
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
  return args;
}

function parseDate(raw) {
  if (typeof raw !== 'string') return null;
  const match = raw.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10);
  const day = Number.parseInt(match[3], 10);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return null;
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day) {
    return null;
  }
  return date;
}

function formatDateUTC(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new Error('Invalid date provided to formatDateUTC');
  }
  const year = String(date.getUTCFullYear());
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function enumerateDateRange(startDate, endDate) {
  const start = parseDate(startDate);
  const end = parseDate(endDate);
  if (!start || !end) {
    throw new Error('Invalid start or end date');
  }
  if (start.getTime() > end.getTime()) {
    throw new Error('Start date must be before or equal to end date');
  }
  const dates = [];
  for (let cursor = start.getTime(); cursor <= end.getTime(); cursor += DAY_MS) {
    dates.push(formatDateUTC(new Date(cursor)));
  }
  return dates;
}

async function readLedgerEntries(ledgerPath) {
  try {
    const content = await fsPromises.readFile(ledgerPath, 'utf8');
    return content
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .reduce((acc, line) => {
        try {
          const parsed = JSON.parse(line);
          acc.push(parsed);
        } catch (err) {
          logger.warn('analytics-backfill skipped malformed ledger entry', {
            ledgerPath,
            line: line.slice(0, 200),
            error: err instanceof Error ? err.message : err,
          });
        }
        return acc;
      }, []);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return [];
    }
    throw err;
  }
}

function createSequentialExecutor() {
  let queue = Promise.resolve();
  return (task) => {
    const run = queue.then(() => task());
    queue = run.catch(() => {});
    return run;
  };
}

function createLedger(ledgerPath) {
  const ensureDir = async () => {
    await fsPromises.mkdir(path.dirname(ledgerPath), { recursive: true });
  };
  const enqueue = createSequentialExecutor();
  return {
    append(entry) {
      return enqueue(async () => {
        await ensureDir();
        await fsPromises.appendFile(ledgerPath, `${JSON.stringify(entry)}\n`, 'utf8');
      });
    },
    read() {
      return readLedgerEntries(ledgerPath);
    },
  };
}

function createJobKey(payload) {
  const canonical = JSON.stringify(payload);
  return crypto.createHash('sha1').update(canonical).digest('hex');
}

async function processWithConcurrency(items, limit, handler) {
  if (!Array.isArray(items) || items.length === 0) {
    return [];
  }
  const max = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 1;
  const executing = new Set();
  const results = [];
  for (const item of items) {
    const promise = Promise.resolve().then(() => handler(item));
    results.push(promise);
    executing.add(promise);
    const settle = () => executing.delete(promise);
    promise.then(settle, settle);
    if (executing.size >= max) {
      await Promise.race(executing);
    }
  }
  return Promise.all(results);
}

function collectSuccessfulPartitions(entries, jobKey) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return new Set();
  }
  const completed = new Set();
  for (const entry of entries) {
    if (
      entry &&
      entry.type === 'partition' &&
      entry.jobKey === jobKey &&
      entry.status === 'success' &&
      entry.partition &&
      typeof entry.partition.date === 'string'
    ) {
      completed.add(entry.partition.date);
    }
  }
  return completed;
}

async function processPartition(date, options) {
  const {
    inputRoot,
    outputPath,
    dryRun,
    windows,
    runContext,
    ledger,
    enqueueWrite,
  } = options;

  const partitionStart = Date.now();
  const partitionContext = {
    ...runContext,
    partitionDate: date,
  };

  await ledger.append({
    version: 1,
    type: 'partition',
    event: 'start',
    jobKey: runContext.jobKey,
    runId: runContext.runId,
    partition: { date },
    timestamp: new Date().toISOString(),
  });

  try {
    const partitionInputRoot = path.resolve(inputRoot, date);
    const inputExists = await fsPromises
      .stat(partitionInputRoot)
      .then((stats) => stats.isDirectory())
      .catch(() => false);
    if (!inputExists) {
      backfillPartitionCounter.add(1, { ...partitionContext, status: 'failed' });
      backfillErrorCounter.add(1, { ...partitionContext, reason: 'input_not_found' });
      const durationMs = Date.now() - partitionStart;
      await ledger.append({
        version: 1,
        type: 'partition',
        event: 'error',
        jobKey: runContext.jobKey,
        runId: runContext.runId,
        partition: { date },
        status: 'failed',
        reason: 'input_not_found',
        durationMs,
        timestamp: new Date().toISOString(),
      });
      logger.warn('analytics-backfill partition failed (input not found)', {
        ...partitionContext,
        inputRoot: partitionInputRoot,
      });
      return {
        status: 'failed',
        reason: 'input_not_found',
        metrics: 0,
        rollups: 0,
        durationMs,
      };
    }

    const metrics = await rollup.readMetricsFromDir(partitionInputRoot, partitionContext);
    if (!metrics.length) {
      backfillPartitionCounter.add(1, { ...partitionContext, status: 'empty' });
      const durationMs = Date.now() - partitionStart;
      await ledger.append({
        version: 1,
        type: 'partition',
        event: 'complete',
        jobKey: runContext.jobKey,
        runId: runContext.runId,
        partition: { date },
        status: 'skipped',
        reason: 'no_metrics',
        durationMs,
        timestamp: new Date().toISOString(),
        metricsProcessed: 0,
        rollupsWritten: 0,
      });
      logger.info('analytics-backfill partition contained no metrics', {
        ...partitionContext,
        inputRoot: partitionInputRoot,
      });
      return {
        status: 'skipped',
        reason: 'no_metrics',
        metrics: 0,
        rollups: 0,
        durationMs,
      };
    }

    const generatedAt = new Date().toISOString();
    const rollups = rollup.aggregateMetrics(metrics, {
      windows,
      defaultDate: date,
      generatedAt,
    });

    if (!rollups.length) {
      backfillPartitionCounter.add(1, { ...partitionContext, status: 'skipped' });
      const durationMs = Date.now() - partitionStart;
      await ledger.append({
        version: 1,
        type: 'partition',
        event: 'complete',
        jobKey: runContext.jobKey,
        runId: runContext.runId,
        partition: { date },
        status: 'skipped',
        reason: 'no_rollups',
        durationMs,
        timestamp: new Date().toISOString(),
        metricsProcessed: metrics.length,
        rollupsWritten: 0,
      });
      logger.warn('analytics-backfill partition produced no rollups', {
        ...partitionContext,
        metrics: metrics.length,
      });
      return {
        status: 'skipped',
        reason: 'no_rollups',
        metrics: metrics.length,
        rollups: 0,
        durationMs,
      };
    }

    if (!dryRun) {
      await enqueueWrite(() => rollup.writeRollups(outputPath, rollups, partitionContext));
    }

    const durationMs = Date.now() - partitionStart;
    backfillPartitionCounter.add(1, { ...partitionContext, status: 'success' });

    await ledger.append({
      version: 1,
      type: 'partition',
      event: 'complete',
      jobKey: runContext.jobKey,
      runId: runContext.runId,
      partition: { date },
      status: dryRun ? 'dry-run' : 'success',
      durationMs,
      timestamp: new Date().toISOString(),
      metricsProcessed: metrics.length,
      rollupsWritten: rollups.length,
      outputPath: dryRun ? undefined : path.resolve(outputPath),
    });

    logger.info('analytics-backfill partition processed', {
      ...partitionContext,
      metrics: metrics.length,
      rollups: rollups.length,
      dryRun,
      durationMs,
    });

    return {
      status: dryRun ? 'dry-run' : 'success',
      reason: null,
      metrics: metrics.length,
      rollups: rollups.length,
      durationMs,
    };
  } catch (err) {
    const durationMs = Date.now() - partitionStart;
    backfillPartitionCounter.add(1, { ...runContext, partitionDate: date, status: 'failed' });
    backfillErrorCounter.add(1, { ...runContext, partitionDate: date });
    await ledger.append({
      version: 1,
      type: 'partition',
      event: 'error',
      jobKey: runContext.jobKey,
      runId: runContext.runId,
      partition: { date },
      status: 'failed',
      durationMs,
      timestamp: new Date().toISOString(),
      error: {
        message: err instanceof Error ? err.message : String(err),
      },
    });
    logger.error('analytics-backfill partition failed', {
      ...runContext,
      partitionDate: date,
      error: err instanceof Error ? err.message : err,
    });
    return {
      status: 'failed',
      reason: err instanceof Error ? err.message : String(err),
      metrics: 0,
      rollups: 0,
      durationMs,
    };
  }
}

async function run(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const startDate = args.start;
  const endDate = args.end || args.start;

  if (!startDate || !endDate) {
    throw new Error('Start/end date is required (use --start/--end or --date)');
  }

  const partitions = enumerateDateRange(startDate, endDate);
  if (!partitions.length) {
    logger.info('analytics-backfill no partitions to process', { startDate, endDate });
    return {
      runId: generateRunId(),
      jobKey: null,
      status: 'noop',
      processedPartitions: 0,
      skippedPartitions: 0,
      failedPartitions: 0,
      totalPartitions: 0,
    };
  }

  const runId = generateRunId();
  const inputRoot = path.resolve(args.inputRoot || DEFAULT_INPUT_ROOT);
  const outputPath = path.resolve(args.output || DEFAULT_OUTPUT);
  const ledgerPath = path.resolve(args.ledger || DEFAULT_LEDGER_PATH);
  const windows = rollup.resolveWindows(args.windows || DEFAULT_WINDOWS);
  const parallelism = Math.max(1, Number.isFinite(args.parallelism) ? Math.floor(args.parallelism) : 1);
  const dryRun = Boolean(args.dryRun);
  const resume = Boolean(args.resume);

  const jobKey = createJobKey({
    job: JOB_NAME,
    partitions,
    inputRoot,
    outputPath,
    windows: windows.map((spec) => spec.name),
  });

  const gitCommit = resolveGitCommit();
  const lineage = createLineageEmitter({
    jobName: 'analytics.backfill',
    runId,
    inputs: [
      {
        name: 'analytics.metrics.backfill',
        uri: inputRoot,
        facets: { partitions },
      },
    ],
    outputs: [
      {
        name: 'analytics.rollups.jsonl',
        uri: outputPath,
      },
      {
        name: 'analytics.backfill.ledger',
        uri: ledgerPath,
      },
    ],
    dataset: {
      name: 'analytics.rollups',
      version: 'v1',
      schema: {
        id: ROLLUP_SCHEMA_ID,
        format: 'jsonl',
      },
    },
    lineagePath: path.join(path.dirname(ledgerPath), 'lineage', 'analytics_backfill.jsonl'),
    gitCommit,
  });

  const runContext = {
    runId,
    jobKey,
    job: JOB_NAME,
    dryRun,
  };

  const ledger = createLedger(ledgerPath);

  let resumeSet = new Set();
  if (resume) {
    const entries = await ledger.read();
    resumeSet = collectSuccessfulPartitions(entries, jobKey);
  }

  const runAttributes = {
    runId,
    jobKey,
    dryRun: dryRun ? 'true' : 'false',
    parallelism,
    gitCommit,
  };
  backfillRunCounter.add(1, runAttributes);

  await lineage.emitStart({
    startDate,
    endDate,
    partitions,
    resume,
    dryRun,
    parallelism,
  });

  logger.info('analytics-backfill job started', {
    ...runAttributes,
    startDate,
    endDate,
    partitions: partitions.length,
    inputRoot,
    outputPath,
    ledgerPath,
    resume,
    lineagePath: lineage.lineagePath,
  });

  await ledger.append({
    version: 1,
    type: 'job',
    event: 'start',
    runId,
    jobKey,
    timestamp: new Date().toISOString(),
     gitCommit,
    datasetSchemaId: ROLLUP_SCHEMA_ID,
    params: {
      startDate,
      endDate,
      partitions,
      inputRoot,
      outputPath,
      windows: windows.map((spec) => spec.name),
      parallelism,
      dryRun,
      resume,
    },
  });

  const enqueueWrite = createSequentialExecutor();

  let processedPartitions = 0;
  let skippedPartitions = 0;
  let failedPartitions = 0;

  const startedAt = Date.now();

  await processWithConcurrency(partitions, parallelism, async (date) => {
    if (resume && resumeSet.has(date)) {
      skippedPartitions += 1;
      await ledger.append({
        version: 1,
        type: 'partition',
        event: 'resume-skip',
        jobKey,
        runId,
        partition: { date },
        status: 'skipped',
        reason: 'already_completed',
        timestamp: new Date().toISOString(),
      });
      logger.info('analytics-backfill skipped partition (already completed)', {
        ...runContext,
        partitionDate: date,
      });
      return;
    }

    const result = await processPartition(date, {
      inputRoot,
      outputPath,
      dryRun,
      windows,
      runContext,
      ledger,
      enqueueWrite,
    });

    if (result.status === 'success' || result.status === 'dry-run') {
      processedPartitions += 1;
    } else if (result.status === 'failed') {
      failedPartitions += 1;
    } else {
      skippedPartitions += 1;
    }
  });

  const durationMs = Date.now() - startedAt;
  backfillDurationHistogram.record(durationMs, runAttributes);

  const summary = {
    runId,
    jobKey,
    status: failedPartitions > 0 ? 'failed' : 'completed',
    processedPartitions,
    skippedPartitions,
    failedPartitions,
    totalPartitions: partitions.length,
    durationMs,
  };

  await ledger.append({
    version: 1,
    type: 'job',
    event: 'complete',
    runId,
    jobKey,
    timestamp: new Date().toISOString(),
    status: summary.status,
    durationMs,
    processedPartitions,
    skippedPartitions,
    failedPartitions,
    gitCommit,
    datasetSchemaId: ROLLUP_SCHEMA_ID,
  });

  logger.info('analytics-backfill job finished', summary);

  if (failedPartitions > 0) {
    const failureError = new BackfillRunError('analytics backfill completed with failures', summary);
    await lineage.emitFailure(failureError, summary);
    throw failureError;
  }

  await lineage.emitComplete('COMPLETED', summary);
  return summary;
}

if (require.main === module) {
  run().catch((err) => {
    logger.error('analytics-backfill fatal error', {
      error: err instanceof Error ? err.message : err,
      summary: err instanceof BackfillRunError ? err.summary : undefined,
    });
    process.exitCode = 1;
  });
}

module.exports = {
  BackfillRunError,
  parseArgs,
  parseDate,
  enumerateDateRange,
  createJobKey,
  readLedgerEntries,
  run,
};
