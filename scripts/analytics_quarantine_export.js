#!/usr/bin/env node
'use strict';

const fs = require('fs');
const fsPromises = fs.promises;
const path = require('path');
const zlib = require('zlib');
const { pipeline } = require('stream/promises');

const DEFAULT_INPUT = process.env.ANALYTICS_QUALITY_QUARANTINE || 'var/analytics/quarantine.jsonl';
const DEFAULT_ARCHIVE_ROOT = process.env.ANALYTICS_QUARANTINE_ARCHIVE_DIR || 'var/analytics/archive';
const DEFAULT_RETENTION_DAYS = process.env.ANALYTICS_QUARANTINE_RETENTION_DAYS
  ? Number(process.env.ANALYTICS_QUARANTINE_RETENTION_DAYS)
  : undefined;
const DELETE_SOURCE = /^true$/i.test(process.env.ANALYTICS_QUARANTINE_DELETE_SOURCE ?? '');

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
  async function walk(current) {
    const entries = await fsPromises.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        const remaining = await fsPromises.readdir(full);
        if (remaining.length === 0) {
          await fsPromises.rmdir(full);
        }
      } else if (entry.isFile()) {
        const stats = await fsPromises.stat(full);
        if (stats.mtimeMs < cutoffMs) {
          await fsPromises.unlink(full);
        }
      }
    }
  }
  await walk(root);
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  const inputPath = path.resolve(args.input || DEFAULT_INPUT);
  const archiveRoot = path.resolve(args.archive || DEFAULT_ARCHIVE_ROOT);
  const deleteSource = Boolean(args.deleteSource || DELETE_SOURCE);
  const retentionDays =
    typeof args.retentionDays === 'number'
      ? args.retentionDays
      : typeof DEFAULT_RETENTION_DAYS === 'number'
      ? DEFAULT_RETENTION_DAYS
      : undefined;

  const exists = await fileExists(inputPath);
  if (!exists) {
    console.info('[analytics-quarantine-export] input file not found, skipping', { inputPath });
    return;
  }

  const now = new Date();
  const destinationDir = archiveSubdir(archiveRoot, now);
  const timestamp = formatTimestamp(now);
  const baseName = `analytics-quarantine-${timestamp}.jsonl.gz`;
  const destinationPath = path.join(destinationDir, baseName);

  await compressAndCopy(inputPath, destinationPath);
  console.info('[analytics-quarantine-export] archived quarantine file', {
    inputPath,
    destinationPath,
  });

  if (deleteSource) {
    await fsPromises.unlink(inputPath).catch((err) => {
      console.warn('[analytics-quarantine-export] failed to delete source file', {
        inputPath,
        error: err instanceof Error ? err.message : err,
      });
    });
  }

  if (typeof retentionDays === 'number' && retentionDays >= 0) {
    const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    try {
      await pruneRetention(archiveRoot, cutoffMs);
      console.info('[analytics-quarantine-export] applied retention policy', {
        archiveRoot,
        retentionDays,
      });
    } catch (err) {
      console.warn('[analytics-quarantine-export] retention sweep failed', {
        archiveRoot,
        error: err instanceof Error ? err.message : err,
      });
    }
  }
}

run().catch((err) => {
  console.error('[analytics-quarantine-export] fatal error', err);
  process.exitCode = 1;
});
