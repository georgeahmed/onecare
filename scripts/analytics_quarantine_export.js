#!/usr/bin/env node
'use strict';

const fs = require('fs');
const fsPromises = fs.promises;
const path = require('path');
const zlib = require('zlib');
const { pipeline } = require('stream/promises');
const crypto = require('node:crypto');
const { logger, createCounter, createHistogram } = require('@onecare/observability');
const { createLineageEmitter, resolveGitCommit } = require('./analytics/lineage.js');

const DEFAULT_INPUT = process.env.ANALYTICS_QUALITY_QUARANTINE || 'var/analytics/quarantine.jsonl';
const DEFAULT_ARCHIVE_ROOT = process.env.ANALYTICS_QUARANTINE_ARCHIVE_DIR || 'var/analytics/archive';
const DEFAULT_RETENTION_DAYS = process.env.ANALYTICS_QUARANTINE_RETENTION_DAYS
  ? Number(process.env.ANALYTICS_QUARANTINE_RETENTION_DAYS)
  : undefined;
const DELETE_SOURCE = /^true$/i.test(process.env.ANALYTICS_QUARANTINE_DELETE_SOURCE ?? '');

const exportRunCounter = createCounter('analytics.quarantine_export.run');
const exportDurationHistogram = createHistogram('analytics.quarantine_export.duration_ms');
const exportFileCounter = createCounter('analytics.quarantine_export.files_archived');
const exportErrorCounter = createCounter('analytics.quarantine_export.errors');
const exportRetentionCounter = createCounter('analytics.quarantine_export.retention_deleted');
const QUARANTINE_ARCHIVE_SCHEMA_ID = 'analytics_quarantine_archive_v1';

function generateRunId() {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const suffix = Math.random().toString(36).slice(2, 8);
  return `analytics-quarantine-export-${Date.now()}-${suffix}`;
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('-')) continue;
    const value = argv[i + 1];
    if ((token === '--input' || token === '-i') && value) {
      args.input = value;
      i += 1;
    } else if ((token === '--archive' || token === '-a') && value) {
      args.archive = value;
      i += 1;
    } else if ((token === '--retention-days' || token === '-r') && value) {
      const parsed = Number(value);
      if (!Number.isNaN(parsed) && parsed >= 0) {
        args.retentionDays = parsed;
      }
      i += 1;
    } else if (token === '--delete-source') {
      args.deleteSource = true;
    }
  }
  return args;
}

async function fileExists(filePath) {
  try {
    await fsPromises.access(filePath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function formatTimestamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '').replace('T', 'T');
}

function archiveSubdir(root, date = new Date()) {
  const year = String(date.getUTCFullYear());
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return path.join(root, year, month, day);
}

async function ensureDir(dirPath) {
  await fsPromises.mkdir(dirPath, { recursive: true });
}

async function compressAndCopy(src, dest) {
  await ensureDir(path.dirname(dest));
  const gzip = zlib.createGzip({ level: zlib.constants.Z_BEST_COMPRESSION });
  await pipeline(fs.createReadStream(src), gzip, fs.createWriteStream(dest));
}

async function pruneRetention(root, cutoffMs) {
  let deletedFiles = 0;
  let deletedDirs = 0;

  async function walk(current) {
    const entries = await fsPromises.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        const remaining = await fsPromises.readdir(full);
        if (remaining.length === 0) {
          await fsPromises.rmdir(full);
          deletedDirs += 1;
        }
      } else if (entry.isFile()) {
        const stats = await fsPromises.stat(full);
        if (stats.mtimeMs < cutoffMs) {
          await fsPromises.unlink(full);
          deletedFiles += 1;
        }
      }
    }
  }
  await walk(root);
  return { deletedFiles, deletedDirs };
}

async function run(argv = process.argv.slice(2)) {
  const startedAt = Date.now();
  const runId = generateRunId();
  const gitCommit = resolveGitCommit();
  const runContext = { runId, gitCommit };
  exportRunCounter.add(1, runContext);

  const args = parseArgs(argv);
  const inputPath = path.resolve(args.input || DEFAULT_INPUT);
  const archiveRoot = path.resolve(args.archive || DEFAULT_ARCHIVE_ROOT);
  const deleteSource = Boolean(args.deleteSource || DELETE_SOURCE);
  const retentionDays =
    typeof args.retentionDays === 'number'
      ? args.retentionDays
      : typeof DEFAULT_RETENTION_DAYS === 'number'
      ? DEFAULT_RETENTION_DAYS
      : undefined;

  const lineage = createLineageEmitter({
    jobName: 'analytics.quarantine_export',
    runId,
    inputs: [
      {
        name: 'analytics.quality.quarantine',
        uri: inputPath,
      },
    ],
    outputs: [
      {
        name: 'analytics.quarantine.archive',
        uri: archiveRoot,
      },
    ],
    dataset: {
      name: 'analytics.quarantine.archive',
      version: 'v1',
      schema: {
        id: QUARANTINE_ARCHIVE_SCHEMA_ID,
        format: 'jsonl.gz',
      },
    },
    lineagePath: path.join(archiveRoot, 'lineage', 'analytics_quarantine_export.jsonl'),
    gitCommit,
  });

  await lineage.emitStart({
    inputPath,
    archiveRoot,
    deleteSource,
    retentionDays,
  });

  const exists = await fileExists(inputPath);
  if (!exists) {
    logger.info('analytics-quarantine-export input file not found, skipping', {
      inputPath,
      runId,
    });
    exportErrorCounter.add(1, { reason: 'input_not_found', runId });
    exportDurationHistogram.record(Date.now() - startedAt, runContext);
    await lineage.emitComplete('SKIPPED', {
      reason: 'input_not_found',
      inputPath,
    });
    return;
  }

  let durationMs = 0;
  let archivedPath = null;
  let retentionSummary = null;
  let success = false;

  try {
    const now = new Date();
    const destinationDir = archiveSubdir(archiveRoot, now);
    const timestamp = formatTimestamp(now);
    const baseName = `analytics-quarantine-${timestamp}.jsonl.gz`;
    const destinationPath = path.join(destinationDir, baseName);

    await compressAndCopy(inputPath, destinationPath);
    archivedPath = destinationPath;
    exportFileCounter.add(1, { ...runContext, archiveRoot });
    logger.info('analytics-quarantine-export archived quarantine file', {
      inputPath,
      destinationPath,
      runId,
    });

    if (deleteSource) {
      try {
        await fsPromises.unlink(inputPath);
        logger.info('analytics-quarantine-export deleted source file', {
          inputPath,
          runId,
        });
      } catch (err) {
        logger.warn('analytics-quarantine-export failed to delete source file', {
          inputPath,
          error: err instanceof Error ? err.message : err,
          runId,
        });
        exportErrorCounter.add(1, { reason: 'delete_source_failed', runId });
      }
    }

    if (typeof retentionDays === 'number' && retentionDays >= 0) {
      const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
      try {
        retentionSummary = await pruneRetention(archiveRoot, cutoffMs);
        if (retentionSummary.deletedFiles > 0) {
          exportRetentionCounter.add(retentionSummary.deletedFiles, { ...runContext, archiveRoot });
        }
        logger.info('analytics-quarantine-export applied retention policy', {
          archiveRoot,
          retentionDays,
          deletedFiles: retentionSummary.deletedFiles,
          deletedDirs: retentionSummary.deletedDirs,
          runId,
        });
      } catch (err) {
        logger.warn('analytics-quarantine-export retention sweep failed', {
          archiveRoot,
          error: err instanceof Error ? err.message : err,
          runId,
        });
        exportErrorCounter.add(1, { reason: 'retention_failed', runId });
      }
    }

    await lineage.emitComplete('COMPLETED', {
      inputPath,
      archiveRoot,
      archivedPath: destinationPath,
      deleteSource,
      retentionDays,
      retentionSummary,
    });
    success = true;
  } catch (err) {
    logger.error('analytics-quarantine-export failed to archive quarantine file', {
      inputPath,
      archiveRoot,
      error: err instanceof Error ? err.message : err,
      runId,
    });
    exportErrorCounter.add(1, { reason: 'archive_failed', runId });
    await lineage.emitFailure(err, {
      inputPath,
      archiveRoot,
      archivedPath,
    });
    throw err;
  } finally {
    durationMs = Date.now() - startedAt;
    exportDurationHistogram.record(durationMs, runContext);
  }

  if (success) {
    logger.info('analytics-quarantine-export completed', {
      runId,
      inputPath,
      archiveRoot,
      archivedPath,
      retentionDays,
      retentionDeletedFiles: retentionSummary?.deletedFiles ?? 0,
      retentionDeletedDirs: retentionSummary?.deletedDirs ?? 0,
      durationMs,
      gitCommit,
      lineagePath: lineage.lineagePath,
    });
  }
}

if (require.main === module) {
  run().catch((err) => {
    logger.error('analytics-quarantine-export fatal error', {
      error: err instanceof Error ? err.message : err,
    });
    process.exitCode = 1;
  });
}

module.exports = {
  parseArgs,
  pruneRetention,
  run,
};
