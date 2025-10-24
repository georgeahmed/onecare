#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const fsPromises = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const { logger } = require('@onecare/observability');
const parquet = require('parquetjs-lite');

const DEFAULT_INPUT = process.env.ANALYTICS_ROLLUP_PATH || 'var/analytics/rollup.jsonl';
const DEFAULT_OUTPUT_ROOT = process.env.ANALYTICS_LAKE_PATH || 'var/analytics/lake';
const DEFAULT_TARGET_BYTES = Number(process.env.ANALYTICS_PARQUET_TARGET_BYTES || 192 * 1024 * 1024);
const SCHEMA_VERSION = 'analytics_rollup_v1';

const PARQUET_SCHEMA = new parquet.ParquetSchema({
  windowSize: { type: 'UTF8' },
  windowStart: { type: 'UTF8' },
  windowEnd: { type: 'UTF8' },
  metric: { type: 'UTF8' },
  labelHash: { type: 'UTF8' },
  labelsJson: { type: 'UTF8', optional: true },
  count: { type: 'INT64' },
  numericCount: { type: 'INT64' },
  p50: { type: 'DOUBLE', optional: true },
  p95: { type: 'DOUBLE', optional: true },
  generatedAt: { type: 'UTF8' },
  schemaVersion: { type: 'UTF8' },
  writeRunId: { type: 'UTF8' },
});

function generateRunId() {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const suffix = Math.random().toString(36).slice(2, 10);
  return `analytics-storage-${Date.now()}-${suffix}`;
}

function normaliseLabels(labels) {
  if (!labels || typeof labels !== 'object') {
    return {};
  }
  const entries = Object.entries(labels)
    .filter(([key, value]) => typeof key === 'string' && typeof value === 'string')
    .map(([key, value]) => [key.trim(), value.trim()])
    .filter(([key, value]) => key.length > 0 && value.length > 0)
    .sort(([a], [b]) => a.localeCompare(b));
  return Object.fromEntries(entries);
}

function deriveDateFromWindowStart(windowStart) {
  if (typeof windowStart !== 'string' || windowStart.length < 10) {
    return null;
  }
  return windowStart.slice(0, 10);
}

function derivePartition(record) {
  const date = deriveDateFromWindowStart(record.windowStart);
  if (!date) return null;
  const metric = typeof record.metric === 'string' ? record.metric.trim() : null;
  const windowSize = typeof record.windowSize === 'string' ? record.windowSize.trim() : null;
  const labelHash = typeof record.labelHash === 'string' ? record.labelHash.trim() : null;
  if (!metric || !windowSize || !labelHash) {
    return null;
  }
  return {
    date,
    metric,
    windowSize,
    labelHash,
  };
}

function planPartitions(records, options = {}) {
  const runId = options.runId ?? generateRunId();
  const plans = new Map();
  for (const record of records) {
    if (!record || typeof record !== 'object') continue;
    const partition = derivePartition(record);
    if (!partition) continue;
    const key = `${partition.date}::${partition.metric}::${partition.windowSize}::${partition.labelHash}`;
    const normalisedLabels = normaliseLabels(record.labels);
    const prepared = {
      windowSize: String(record.windowSize ?? ''),
      windowStart: String(record.windowStart ?? ''),
      windowEnd: String(record.windowEnd ?? ''),
      metric: String(record.metric ?? ''),
      labelHash: String(record.labelHash ?? ''),
      labelsJson: Object.keys(normalisedLabels).length > 0 ? JSON.stringify(normalisedLabels) : null,
      count: Number.isFinite(record.count) ? Number(record.count) : 0,
      numericCount: Number.isFinite(record.numericCount) ? Number(record.numericCount) : 0,
      p50: typeof record.p50 === 'number' && Number.isFinite(record.p50) ? record.p50 : null,
      p95: typeof record.p95 === 'number' && Number.isFinite(record.p95) ? record.p95 : null,
      generatedAt: String(record.generatedAt ?? new Date().toISOString()),
    };
    const bucket =
      plans.get(key) ??
      {
        partition,
        records: [],
      };
    bucket.records.push(prepared);
    plans.set(key, bucket);
  }

  return Array.from(plans.values()).map((entry) => ({
    runId,
    partition: entry.partition,
    records: entry.records,
  }));
}

async function writePartitions(plans, rootPath, options = {}) {
  if (!plans.length) return [];
  const runId = options.runId ?? plans[0]?.runId ?? generateRunId();
  const schemaVersion = options.schemaVersion ?? SCHEMA_VERSION;
  const written = [];
  for (const plan of plans) {
    const partition = plan.partition;
    const directory = path.join(
      rootPath,
      `date=${partition.date}`,
      `metric=${partition.metric}`,
      `window=${partition.windowSize}`,
      `label=${partition.labelHash}`
    );
    await fsPromises.mkdir(directory, { recursive: true });
    const fileName = `analytics-rollup-${runId}.parquet`;
    const filePath = path.join(directory, fileName);
    const writer = await parquet.ParquetWriter.openFile(PARQUET_SCHEMA, filePath, {
      useDataPageV2: false,
    });
    for (const record of plan.records) {
      await writer.appendRow({
        ...record,
        schemaVersion,
        writeRunId: runId,
      });
    }
    await writer.close();
    written.push({
      runId,
      partition,
      filePath,
      rowCount: plan.records.length,
    });
  }
  return written;
}

async function readRollupJsonl(inputPath) {
  const exists = await fsPromises
    .access(inputPath, fs.constants.F_OK)
    .then(() => true)
    .catch(() => false);
  if (!exists) {
    return [];
  }
  const content = await fsPromises.readFile(inputPath, 'utf8');
  const lines = content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const records = [];
  for (const line of lines) {
    try {
      records.push(JSON.parse(line));
    } catch (err) {
      logger.warn?.('analytics-storage-layout skipped invalid JSON line', {
        line: line.slice(0, 120),
        error: err instanceof Error ? err.message : err,
      });
    }
  }
  return records;
}

async function readPartitions(rootPath, filters = {}) {
  const results = [];
  const rootExists = await fsPromises
    .stat(rootPath)
    .then((stats) => stats.isDirectory())
    .catch(() => false);
  if (!rootExists) return results;

  async function walk(currentPath, context = {}) {
    const entries = await fsPromises.readdir(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        const [key, value] = entry.name.split('=');
        const nextContext = { ...context };
        if (key && value) {
          nextContext[key] = value;
          if (filters.dates && key === 'date' && !filters.dates.includes(value)) {
            continue;
          }
          if (filters.metrics && key === 'metric' && !filters.metrics.includes(value)) {
            continue;
          }
          if (filters.windows && key === 'window' && !filters.windows.includes(value)) {
            continue;
          }
          if (filters.labels && key === 'label' && !filters.labels.includes(value)) {
            continue;
          }
        }
        // eslint-disable-next-line no-await-in-loop
        await walk(entryPath, nextContext);
      } else if (entry.isFile() && entry.name.endsWith('.parquet')) {
        if (filters.dates && context.date && !filters.dates.includes(context.date)) {
          continue;
        }
        if (filters.metrics && context.metric && !filters.metrics.includes(context.metric)) {
          continue;
        }
        if (filters.windows && context.window && !filters.windows.includes(context.window)) {
          continue;
        }
        if (filters.labels && context.label && !filters.labels.includes(context.label)) {
          continue;
        }
        // eslint-disable-next-line no-await-in-loop
        const reader = await parquet.ParquetReader.openFile(entryPath);
        const cursor = reader.getCursor();
        // eslint-disable-next-line no-constant-condition
        while (true) {
          // eslint-disable-next-line no-await-in-loop
          const record = await cursor.next();
          if (!record) break;
          let labels = {};
          if (typeof record.labelsJson === 'string' && record.labelsJson.length > 0) {
            try {
              labels = JSON.parse(record.labelsJson);
            } catch {
              labels = {};
            }
          }
          results.push({
            windowSize: record.windowSize,
            windowStart: record.windowStart,
            windowEnd: record.windowEnd,
            metric: record.metric,
            labelHash: record.labelHash,
            labels,
            count: Number(record.count ?? 0),
            numericCount: Number(record.numericCount ?? 0),
            p50: record.p50 ?? null,
            p95: record.p95 ?? null,
            generatedAt: record.generatedAt,
            schemaVersion: record.schemaVersion,
            writeRunId: record.writeRunId,
            filePath: entryPath,
          });
        }
        await reader.close();
      }
    }
  }

  await walk(rootPath, {});
  return results;
}

async function listPartitionFiles(rootPath) {
  const files = [];
  const rootExists = await fsPromises
    .stat(rootPath)
    .then((stats) => stats.isDirectory())
    .catch(() => false);
  if (!rootExists) return files;

  async function walk(currentPath, context = {}) {
    const entries = await fsPromises.readdir(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        const [key, value] = entry.name.split('=');
        const nextContext = { ...context };
        if (key && value) {
          nextContext[key] = value;
        }
        // eslint-disable-next-line no-await-in-loop
        await walk(entryPath, nextContext);
      } else if (entry.isFile() && entry.name.endsWith('.parquet')) {
        // eslint-disable-next-line no-await-in-loop
        const stats = await fsPromises.stat(entryPath);
        files.push({
          partition: context,
          filePath: entryPath,
          size: stats.size,
        });
      }
    }
  }

  await walk(rootPath, {});
  return files;
}

async function compactPartitions(rootPath, options = {}) {
  const runId = options.runId ?? generateRunId();
  const targetBytes = typeof options.targetBytes === 'number' && options.targetBytes > 0 ? options.targetBytes : DEFAULT_TARGET_BYTES;
  const minBytesToCompact = typeof options.minBytesToCompact === 'number' && options.minBytesToCompact > 0 ? options.minBytesToCompact : Math.floor(targetBytes / 4);
  const allFiles = await listPartitionFiles(rootPath);
  if (!allFiles.length) return [];

  const partitions = new Map();
  for (const file of allFiles) {
    if (!file.partition?.date || !file.partition?.metric || !file.partition?.window || !file.partition?.label) {
      continue;
    }
    const key = `${file.partition.date}::${file.partition.metric}::${file.partition.window}::${file.partition.label}`;
    const group =
      partitions.get(key) ??
      {
        partition: file.partition,
        files: [],
      };
    group.files.push(file);
    partitions.set(key, group);
  }

  const manifests = [];
  const manifestPath = path.join(rootPath, 'compaction-manifest.jsonl');
  const manifestLines = [];
  for (const { partition, files } of partitions.values()) {
    if (files.length <= 1) {
      continue;
    }
    const totalSize = files.reduce((acc, file) => acc + file.size, 0);
    const allSmall = files.every((file) => file.size <= targetBytes);
    if (!allSmall && totalSize < minBytesToCompact) {
      continue;
    }
    const startedAt = new Date().toISOString();
    const directory = path.dirname(files[0].filePath);
    const tempPath = path.join(directory, `analytics-rollup-${runId}.parquet.tmp`);
    const finalPath = path.join(directory, `analytics-rollup-${runId}.parquet`);

    const writer = await parquet.ParquetWriter.openFile(PARQUET_SCHEMA, tempPath, {
      useDataPageV2: false,
    });
    let rowCount = 0;
    let schemaVersion = SCHEMA_VERSION;
    for (const file of files) {
      // eslint-disable-next-line no-await-in-loop
      const reader = await parquet.ParquetReader.openFile(file.filePath);
      schemaVersion = schemaVersion ?? reader.metadata.created_by ?? SCHEMA_VERSION;
      const cursor = reader.getCursor();
      // eslint-disable-next-line no-constant-condition
      while (true) {
        // eslint-disable-next-line no-await-in-loop
        const record = await cursor.next();
        if (!record) break;
        rowCount += 1;
        await writer.appendRow({
          ...record,
          schemaVersion: record.schemaVersion ?? SCHEMA_VERSION,
          writeRunId: record.writeRunId ?? runId,
        });
      }
      await reader.close();
    }
    await writer.close();

    await fsPromises.rename(tempPath, finalPath);

    for (const file of files) {
      await fsPromises.unlink(file.filePath);
    }
    const stats = await fsPromises.stat(finalPath);
    const completedAt = new Date().toISOString();
    const manifest = {
      runId,
      partition,
      inputFiles: files.map((file) => ({ path: file.filePath, size: file.size })),
      outputFile: { path: finalPath, size: stats.size },
      rowCount,
      startedAt,
      completedAt,
    };
    manifests.push(manifest);
    manifestLines.push(`${JSON.stringify(manifest)}\n`);
  }

  if (manifestLines.length > 0) {
    await fsPromises.mkdir(rootPath, { recursive: true });
    await fsPromises.appendFile(manifestPath, manifestLines.join(''), 'utf8');
  }
  return manifests;
}

function parseCliArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (!token.startsWith('-')) continue;
    const value = rest[i + 1];
    if ((token === '--input' || token === '-i') && value) {
      options.input = value;
      i += 1;
    } else if ((token === '--output-root' || token === '-o') && value) {
      options.outputRoot = value;
      i += 1;
    } else if (token === '--target-bytes' && value) {
      options.targetBytes = Number(value);
      i += 1;
    } else if (token === '--dates' && value) {
      options.dates = value.split(',').map((part) => part.trim()).filter(Boolean);
      i += 1;
    } else if (token === '--metrics' && value) {
      options.metrics = value.split(',').map((part) => part.trim()).filter(Boolean);
      i += 1;
    } else if (token === '--windows' && value) {
      options.windows = value.split(',').map((part) => part.trim()).filter(Boolean);
      i += 1;
    } else if (token === '--labels' && value) {
      options.labels = value.split(',').map((part) => part.trim()).filter(Boolean);
      i += 1;
    }
  }
  return { command, options };
}

async function handleWrite(options) {
  const inputPath = path.resolve(options.input || DEFAULT_INPUT);
  const outputRoot = path.resolve(options.outputRoot || DEFAULT_OUTPUT_ROOT);
  const runId = generateRunId();
  logger.info?.('analytics-storage-layout write run started', {
    inputPath,
    outputRoot,
    runId,
  });
  const records = await readRollupJsonl(inputPath);
  const plans = planPartitions(records, { runId });
  const written = await writePartitions(plans, outputRoot, { runId });
  logger.info?.('analytics-storage-layout write run completed', {
    runId,
    partitions: written.length,
    rows: written.reduce((acc, entry) => acc + entry.rowCount, 0),
  });
}

async function handleCompact(options) {
  const outputRoot = path.resolve(options.outputRoot || DEFAULT_OUTPUT_ROOT);
  const targetBytes = options.targetBytes;
  const runId = generateRunId();
  logger.info?.('analytics-storage-layout compaction started', {
    outputRoot,
    runId,
    targetBytes: targetBytes ?? DEFAULT_TARGET_BYTES,
  });
  const manifests = await compactPartitions(outputRoot, {
    runId,
    targetBytes,
  });
  logger.info?.('analytics-storage-layout compaction completed', {
    runId,
    partitionsCompacted: manifests.length,
  });
}

async function handleInspect(options) {
  const outputRoot = path.resolve(options.outputRoot || DEFAULT_OUTPUT_ROOT);
  const records = await readPartitions(outputRoot, {
    dates: options.dates,
    metrics: options.metrics,
    windows: options.windows,
    labels: options.labels,
  });
  console.log(JSON.stringify({ count: records.length, records }, null, 2));
}

async function runCli(argv = process.argv.slice(2)) {
  const { command, options } = parseCliArgs(argv);
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    console.log(
      [
        'Usage: node scripts/analytics_storage_layout.js <command> [options]',
        '',
        'Commands:',
        '  write               Transform rollup JSONL into partitioned Parquet',
        '  compact             Merge small Parquet files within each partition',
        '  inspect             Print records matching the supplied filters as JSON',
        '',
        'Options:',
        '  --input <path>              Source rollup JSONL (write)',
        '  --output-root <path>        Destination lake root (write/compact/inspect)',
        '  --target-bytes <number>     Target file size for compaction (compact)',
        '  --dates <csv>               Filter dates (inspect)',
        '  --metrics <csv>             Filter metrics (inspect)',
        '  --windows <csv>             Filter windows (inspect)',
        '  --labels <csv>              Filter label hashes (inspect)',
      ].join('\n')
    );
    return;
  }

  if (command === 'write') {
    await handleWrite(options);
    return;
  }
  if (command === 'compact') {
    await handleCompact(options);
    return;
  }
  if (command === 'inspect') {
    await handleInspect(options);
    return;
  }
  console.error(`Unknown command: ${command}`);
  process.exitCode = 1;
}

if (require.main === module) {
  runCli().catch((err) => {
    logger.error?.('analytics-storage-layout fatal error', {
      error: err instanceof Error ? err.message : err,
    });
    process.exitCode = 1;
  });
}

module.exports = {
  SCHEMA_VERSION,
  PARQUET_SCHEMA,
  DEFAULT_INPUT,
  DEFAULT_OUTPUT_ROOT,
  DEFAULT_TARGET_BYTES,
  generateRunId,
  normaliseLabels,
  planPartitions,
  writePartitions,
  readRollupJsonl,
  readPartitions,
  compactPartitions,
  listPartitionFiles,
  runCli,
};
