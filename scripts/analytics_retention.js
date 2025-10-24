#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const fsPromises = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const { logger, createCounter, createHistogram } = require('@onecare/observability');

const DEFAULT_LAKE_ROOT = process.env.ANALYTICS_LAKE_PATH || 'var/analytics/lake';
const DEFAULT_BACKFILL_ROOT = process.env.ANALYTICS_BACKFILL_ROOT || 'var/analytics/backfill';
const DEFAULT_LINEAGE_DIR = process.env.ANALYTICS_LINEAGE_DIR || 'var/analytics/lineage';
const DEFAULT_LEDGER_PATH = process.env.ANALYTICS_BACKFILL_LEDGER || 'var/analytics/backfill-ledger.jsonl';
const DEFAULT_TIER_ROOT = process.env.ANALYTICS_TIER_ROOT || 'var/analytics/cold';

const DEFAULT_TTLS = {
  lakeDays: Number.parseInt(process.env.ANALYTICS_RETENTION_LAKE_DAYS || '365', 10),
  rawDays: Number.parseInt(process.env.ANALYTICS_RETENTION_RAW_DAYS || '30', 10),
  lineageDays: Number.parseInt(process.env.ANALYTICS_RETENTION_LINEAGE_DAYS || '180', 10),
  ledgerDays: Number.parseInt(process.env.ANALYTICS_RETENTION_LEDGER_DAYS || '365', 10),
};

const retentionRunCounter = createCounter('analytics.retention.run');
const retentionItemCounter = createCounter('analytics.retention.items');
const retentionErrorCounter = createCounter('analytics.retention.errors');
const retentionDurationHistogram = createHistogram('analytics.retention.duration_ms');

const DAY_MS = 24 * 60 * 60 * 1000;

function generateRunId() {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const suffix = Math.random().toString(36).slice(2, 10);
  return `analytics-retention-${Date.now()}-${suffix}`;
}

function parseArgs(argv) {
  const args = {
    lakeRoot: DEFAULT_LAKE_ROOT,
    backfillRoot: DEFAULT_BACKFILL_ROOT,
    lineageDir: DEFAULT_LINEAGE_DIR,
    ledgerPath: DEFAULT_LEDGER_PATH,
    tierDir: DEFAULT_TIER_ROOT,
    ttlLakeDays: DEFAULT_TTLS.lakeDays,
    ttlRawDays: DEFAULT_TTLS.rawDays,
    ttlLineageDays: DEFAULT_TTLS.lineageDays,
    ttlLedgerDays: DEFAULT_TTLS.ledgerDays,
    dryRun: false,
    vacuum: false,
    deleteInsteadOfTier: false,
    now: Date.now(),
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('-')) continue;
    const value = argv[i + 1];
    switch (token) {
      case '--lake-root':
        if (value) {
          args.lakeRoot = value;
          i += 1;
        }
        break;
      case '--backfill-root':
        if (value) {
          args.backfillRoot = value;
          i += 1;
        }
        break;
      case '--lineage-dir':
        if (value) {
          args.lineageDir = value;
          i += 1;
        }
        break;
      case '--ledger':
        if (value) {
          args.ledgerPath = value;
          i += 1;
        }
        break;
      case '--tier-dir':
        if (value) {
          args.tierDir = value;
          i += 1;
        }
        break;
      case '--ttl-lake-days':
        if (value) {
          const parsed = Number.parseInt(value, 10);
          if (Number.isFinite(parsed) && parsed >= 0) {
            args.ttlLakeDays = parsed;
          }
          i += 1;
        }
        break;
      case '--ttl-raw-days':
        if (value) {
          const parsed = Number.parseInt(value, 10);
          if (Number.isFinite(parsed) && parsed >= 0) {
            args.ttlRawDays = parsed;
          }
          i += 1;
        }
        break;
      case '--ttl-lineage-days':
        if (value) {
          const parsed = Number.parseInt(value, 10);
          if (Number.isFinite(parsed) && parsed >= 0) {
            args.ttlLineageDays = parsed;
          }
          i += 1;
        }
        break;
      case '--ttl-ledger-days':
        if (value) {
          const parsed = Number.parseInt(value, 10);
          if (Number.isFinite(parsed) && parsed >= 0) {
            args.ttlLedgerDays = parsed;
          }
          i += 1;
        }
        break;
      case '--dry-run':
        args.dryRun = true;
        break;
      case '--vacuum':
        args.vacuum = true;
        break;
      case '--delete':
        args.deleteInsteadOfTier = true;
        break;
      case '--now':
        if (value) {
          const parsed = Date.parse(value);
          if (!Number.isNaN(parsed)) {
            args.now = parsed;
          }
          i += 1;
        }
        break;
      default:
        break;
    }
  }

  return args;
}

function daysToCutoff(nowMs, ttlDays) {
  if (!Number.isFinite(ttlDays) || ttlDays < 0) {
    return null;
  }
  return nowMs - ttlDays * DAY_MS;
}

function parsePartitionDate(name) {
  if (typeof name !== 'string') return null;
  const match = name.match(/^date=(\d{4}-\d{2}-\d{2})$/);
  if (!match) return null;
  const parsed = Date.parse(`${match[1]}T00:00:00.000Z`);
  if (Number.isNaN(parsed)) return null;
  return { iso: match[1], ms: parsed };
}

async function pathExists(target) {
  try {
    await fsPromises.access(target, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function ensureDir(dirPath) {
  await fsPromises.mkdir(dirPath, { recursive: true });
}

async function moveToTier(src, tierBase, relative, summary, options) {
  const dest = path.join(tierBase, relative);
  if (options.dryRun) {
    logger.info('analytics-retention would tier path', {
      source: src,
      destination: dest,
    });
  } else {
    await ensureDir(path.dirname(dest));
    const destExists = await pathExists(dest);
    if (destExists) {
      await fsPromises.rm(dest, { recursive: true, force: true });
    }
    await fsPromises.rename(src, dest);
    logger.info('analytics-retention tiered path', {
      source: src,
      destination: dest,
    });
  }
  summary.tiered += 1;
}

async function removePath(target, summary, options) {
  if (options.dryRun) {
    logger.info('analytics-retention would delete path', {
      target,
    });
  } else {
    await fsPromises.rm(target, { recursive: true, force: true });
    logger.info('analytics-retention deleted path', {
      target,
    });
  }
  summary.deleted += 1;
}

async function enforceLakeRetention(args, summary) {
  const { lakeRoot, tierDir, ttlLakeDays, deleteInsteadOfTier, now, dryRun } = args;
  const cutoffMs = daysToCutoff(now, ttlLakeDays);
  if (cutoffMs === null) return;

  const exists = await pathExists(lakeRoot);
  if (!exists) return;

  const entries = await fsPromises.readdir(lakeRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const partition = parsePartitionDate(entry.name);
    if (!partition) continue;
    if (partition.ms > cutoffMs) continue;
    const absolute = path.join(lakeRoot, entry.name);
    const relative = path.join('lake', entry.name);
    try {
      if (!deleteInsteadOfTier && tierDir) {
        await moveToTier(absolute, tierDir, relative, summary, { dryRun });
        retentionItemCounter.add(1, { dataset: 'lake', action: dryRun ? 'tier_plan' : 'tier' });
      } else {
        await removePath(absolute, summary, { dryRun });
        retentionItemCounter.add(1, { dataset: 'lake', action: dryRun ? 'delete_plan' : 'delete' });
      }
    } catch (err) {
      summary.errors += 1;
      retentionErrorCounter.add(1, { dataset: 'lake' });
      logger.error('analytics-retention failed to process lake partition', {
        path: absolute,
        error: err instanceof Error ? err.message : err,
      });
    }
  }
}

async function enforceBackfillRetention(args, summary) {
  const { backfillRoot, tierDir, ttlRawDays, deleteInsteadOfTier, now, dryRun } = args;
  const cutoffMs = daysToCutoff(now, ttlRawDays);
  if (cutoffMs === null) return;
  const exists = await pathExists(backfillRoot);
  if (!exists) return;

  const entries = await fsPromises.readdir(backfillRoot, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const name = entry.name;
    const parsed = Date.parse(`${name}T00:00:00.000Z`);
    if (Number.isNaN(parsed)) continue;
    if (parsed > cutoffMs) continue;
    const absolute = path.join(backfillRoot, name);
    const relative = path.join('backfill', name);
    try {
      if (!deleteInsteadOfTier && tierDir) {
        await moveToTier(absolute, tierDir, relative, summary, { dryRun });
        retentionItemCounter.add(1, { dataset: 'raw', action: dryRun ? 'tier_plan' : 'tier' });
      } else {
        await removePath(absolute, summary, { dryRun });
        retentionItemCounter.add(1, { dataset: 'raw', action: dryRun ? 'delete_plan' : 'delete' });
      }
    } catch (err) {
      summary.errors += 1;
      retentionErrorCounter.add(1, { dataset: 'raw' });
      logger.error('analytics-retention failed to process raw backfill partition', {
        path: absolute,
        error: err instanceof Error ? err.message : err,
      });
    }
  }
}

async function collectFilesRecursive(root) {
  const collected = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = await fsPromises.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        collected.push(full);
      }
    }
  }
  return collected;
}

async function enforceLineageRetention(args, summary) {
  const { lineageDir, tierDir, ttlLineageDays, deleteInsteadOfTier, now, dryRun } = args;
  const cutoffMs = daysToCutoff(now, ttlLineageDays);
  if (cutoffMs === null) return;
  const exists = await pathExists(lineageDir);
  if (!exists) return;

  const files = await collectFilesRecursive(lineageDir);
  for (const filePath of files) {
    try {
      const stats = await fsPromises.stat(filePath);
      if (stats.mtimeMs > cutoffMs) continue;
      const relative = path.relative(lineageDir, filePath);
      const targetRel = path.join('lineage', relative);
      if (!deleteInsteadOfTier && tierDir) {
        await moveToTier(filePath, tierDir, targetRel, summary, { dryRun });
        retentionItemCounter.add(1, { dataset: 'lineage', action: dryRun ? 'tier_plan' : 'tier' });
      } else {
        await removePath(filePath, summary, { dryRun });
        retentionItemCounter.add(1, { dataset: 'lineage', action: dryRun ? 'delete_plan' : 'delete' });
      }
    } catch (err) {
      summary.errors += 1;
      retentionErrorCounter.add(1, { dataset: 'lineage' });
      logger.error('analytics-retention failed to process lineage file', {
        file: filePath,
        error: err instanceof Error ? err.message : err,
      });
    }
  }
}

function parseLedgerTimestamp(entry) {
  if (!entry || typeof entry !== 'object') return null;
  if (typeof entry.timestamp === 'string') {
    const parsed = Date.parse(entry.timestamp);
    if (!Number.isNaN(parsed)) return parsed;
  }
  if (entry.eventTime && typeof entry.eventTime === 'string') {
    const parsed = Date.parse(entry.eventTime);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return null;
}

async function compactLedger(args, summary) {
  const { ledgerPath, ttlLedgerDays, now, dryRun } = args;
  const cutoffMs = daysToCutoff(now, ttlLedgerDays);
  if (cutoffMs === null) return;
  const exists = await pathExists(ledgerPath);
  if (!exists) return;

  let lines;
  try {
    const raw = await fsPromises.readFile(ledgerPath, 'utf8');
    lines = raw
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch (err) {
    summary.errors += 1;
    retentionErrorCounter.add(1, { dataset: 'ledger' });
    logger.error('analytics-retention failed to read ledger', {
      ledgerPath,
      error: err instanceof Error ? err.message : err,
    });
    return;
  }

  const keep = [];
  let removed = 0;
  for (const line of lines) {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      keep.push(line);
      continue;
    }
    const timestamp = parseLedgerTimestamp(parsed);
    if (timestamp === null || timestamp > cutoffMs) {
      keep.push(line);
    } else {
      removed += 1;
    }
  }

  if (!removed) return;

  if (dryRun) {
    logger.info('analytics-retention would compact ledger', {
      ledgerPath,
      removedEntries: removed,
    });
  } else {
    await fsPromises.writeFile(ledgerPath, `${keep.join('\n')}\n`, 'utf8');
    logger.info('analytics-retention compacted ledger', {
      ledgerPath,
      removedEntries: removed,
    });
  }
  summary.ledgerCompacted += removed;
  retentionItemCounter.add(removed, { dataset: 'ledger', action: dryRun ? 'compact_plan' : 'compact' });
}

async function vacuumEmptyDirectories(root, summary, options) {
  const exists = await pathExists(root);
  if (!exists) return;

  async function walk(current) {
    let entries;
    try {
      entries = await fsPromises.readdir(current, { withFileTypes: true });
    } catch {
      return true;
    }

    let hasContent = false;
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        const childHasContent = await walk(full);
        if (!childHasContent) {
          continue;
        }
        hasContent = true;
      } else if (entry.isFile()) {
        hasContent = true;
      }
    }

    if (!hasContent && current !== root) {
      if (options.dryRun) {
        logger.info('analytics-retention would vacuum empty directory', {
          directory: current,
        });
      } else {
        await fsPromises.rmdir(current).catch(() => {});
        logger.info('analytics-retention vacuumed empty directory', {
          directory: current,
        });
      }
      summary.vacuumed += 1;
      return false;
    }
    return true;
  }

  await walk(root);
}

async function run(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const runId = generateRunId();
  const summary = {
    runId,
    dryRun: args.dryRun,
    tiered: 0,
    deleted: 0,
    ledgerCompacted: 0,
    vacuumed: 0,
    errors: 0,
  };

  const startedAt = Date.now();
  retentionRunCounter.add(1, {
    runId,
    dryRun: args.dryRun ? 'true' : 'false',
  });

  logger.info('analytics-retention run started', {
    runId,
    dryRun: args.dryRun,
    lakeRoot: args.lakeRoot,
    backfillRoot: args.backfillRoot,
    lineageDir: args.lineageDir,
    ledgerPath: args.ledgerPath,
    tierDir: args.tierDir,
    ttlLakeDays: args.ttlLakeDays,
    ttlRawDays: args.ttlRawDays,
    ttlLineageDays: args.ttlLineageDays,
    ttlLedgerDays: args.ttlLedgerDays,
    vacuum: args.vacuum,
  });

  try {
    await enforceLakeRetention(args, summary);
    await enforceBackfillRetention(args, summary);
    await enforceLineageRetention(args, summary);
    await compactLedger(args, summary);
    if (args.vacuum) {
      await vacuumEmptyDirectories(args.lakeRoot, summary, { dryRun: args.dryRun });
    }
  } catch (err) {
    summary.errors += 1;
    retentionErrorCounter.add(1, { dataset: 'general' });
    logger.error('analytics-retention encountered an unexpected error', {
      error: err instanceof Error ? err.message : err,
    });
    if (!args.dryRun) {
      throw err;
    }
  } finally {
    const durationMs = Date.now() - startedAt;
    retentionDurationHistogram.record(durationMs, { runId });
    logger.info('analytics-retention run finished', {
      runId,
      dryRun: args.dryRun,
      tiered: summary.tiered,
      deleted: summary.deleted,
      ledgerCompacted: summary.ledgerCompacted,
      vacuumed: summary.vacuumed,
      errors: summary.errors,
      durationMs,
    });
  }

  return summary;
}

if (require.main === module) {
  run().catch((err) => {
    logger.error('analytics-retention fatal error', {
      error: err instanceof Error ? err.message : err,
    });
    process.exitCode = 1;
  });
}

module.exports = {
  run,
  parseArgs,
};
