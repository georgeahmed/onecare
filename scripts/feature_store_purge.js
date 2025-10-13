#!/usr/bin/env node
'use strict';

/*
 * Feature store retention / purge job.
 * - Deletes feature records older than the configured retention window.
 * - Supports Postgres-backed stores (FEATURE_STORE_URL) and JSONL fallbacks used in dev tooling.
 * - Logs summary metrics and supports dry-run mode for validation.
 *
 * Usage:
 *   node scripts/feature_store_purge.js \
 *     --url postgres://user:pass@host:5432/feature_store \
 *     --retention-days 30 \
 *     --dry-run
 *
 *   node scripts/feature_store_purge.js \
 *     --input var/features/triage-core.jsonl \
 *     --retention-days 14
 *
 * Environment variables:
 *   FEATURE_STORE_URL               Postgres connection string (overridden by --url).
 *   FEATURE_STORE_RETENTION_DAYS    Retention window override in days.
 *   FEATURE_STORE_DUMP              Default JSONL file path when Postgres URL absent.
 *   PRACTICE_ID                     Practice identifier used when loading config defaults.
 */

const fs = require('fs');
const fsPromises = fs.promises;
const path = require('path');
const readline = require('readline');

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RETENTION_DAYS = 90;
const DEFAULT_JSONL_PATH = 'var/features/feature-values.jsonl';

function printHelp() {
  console.log(
    [
      'Feature Store Purge',
      '',
      'Usage:',
      '  node scripts/feature_store_purge.js [options]',
      '',
      'Options:',
      '  -r, --retention-days <days>  Retention window (days).',
      '  -p, --practice <id>          Practice id for config lookup (defaults PRACTICE_ID env or demo).',
      '  -u, --url <postgres-url>     Feature store Postgres connection string.',
      '  -i, --input <path>           JSONL fallback path when Postgres URL absent.',
      '  -t, --table <name>           Table name when using Postgres (default feature_values).',
      '  -s, --schema <name>          Schema name when using Postgres (default public).',
      '  -n, --dry-run                Only report what would be purged.',
      '      --now <timestamp>        Override current time (ISO string or epoch milliseconds).',
      '  -h, --help                   Show this help.',
    ].join('\n')
  );
}

function parseArgs(argv) {
  const args = {
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('-')) continue;
    const next = argv[i + 1];
    if ((token === '--retention-days' || token === '-r') && next) {
      args.retentionDays = next;
      i += 1;
    } else if ((token === '--practice' || token === '-p') && next) {
      args.practiceId = next;
      i += 1;
    } else if ((token === '--url' || token === '-u') && next) {
      args.url = next;
      i += 1;
    } else if ((token === '--input' || token === '-i') && next) {
      args.input = next;
      i += 1;
    } else if ((token === '--table' || token === '-t') && next) {
      args.table = next;
      i += 1;
    } else if ((token === '--schema' || token === '-s') && next) {
      args.schema = next;
      i += 1;
    } else if (token === '--dry-run' || token === '-n') {
      args.dryRun = true;
    } else if (token === '--now') {
      if (next) {
        args.now = next;
        i += 1;
      }
    } else if (token === '--help' || token === '-h') {
      args.help = true;
    }
  }
  return args;
}

function parseBooleanFlag(value) {
  if (!value) return false;
  const normalized = String(value).trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function sanitizeDays(value) {
  if (value === undefined || value === null) return null;
  let numeric;
  if (typeof value === 'number') {
    numeric = value;
  } else if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed.length) return null;
    numeric = Number(trimmed);
  } else {
    return null;
  }
  if (!Number.isFinite(numeric)) {
    return null;
  }
  if (numeric < 0) {
    return 0;
  }
  return Math.floor(numeric);
}

function sanitizeIdentifier(value, fallback) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return fallback;
  }
  const trimmed = value.trim();
  const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
  if (!IDENTIFIER.test(trimmed)) {
    throw new Error(`Invalid identifier: ${value}`);
  }
  return trimmed;
}

function parseTemporalInput(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number') {
    return normalizeEpoch(value);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const numeric = Number(trimmed);
    if (!Number.isNaN(numeric)) {
      const normalized = normalizeEpoch(numeric);
      if (normalized !== null) return normalized;
    }
    const parsed = Date.parse(trimmed);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
    return null;
  }
  return null;
}

function normalizeEpoch(value) {
  if (!Number.isFinite(value)) return null;
  if (value > 1e12) {
    // Already in milliseconds.
    return Math.floor(value);
  }
  if (value > 1e9) {
    // Likely seconds (Unix epoch).
    return Math.floor(value * 1000);
  }
  if (value >= 0) {
    // Treat very small numbers as seconds.
    return Math.floor(value * 1000);
  }
  return null;
}

function parseDateValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') {
    return normalizeEpoch(value);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const numeric = Number(trimmed);
    if (!Number.isNaN(numeric)) {
      const epoch = normalizeEpoch(numeric);
      if (epoch !== null) return epoch;
    }
    const parsed = Date.parse(trimmed);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

function extractTimestamp(record) {
  if (!record || typeof record !== 'object') return null;
  const candidates = [
    record.recordedAt,
    record.recorded_at,
    record.generatedAt,
    record.generated_at,
    record.timestamp,
    record.createdAt,
    record.created_at,
    record.storedAt,
    record.stored_at,
    record.occurredAt,
    record.occurred_at,
    record.ingestedAt,
    record.ingested_at,
    record.updatedAt,
    record.updated_at,
    record.features && record.features.recordedAt,
    record.features && record.features.generatedAt,
    record.metadata && record.metadata.recordedAt,
    record.payload && record.payload.generatedAt,
    record.payload && record.payload.recordedAt,
    record.value && record.value.recordedAt,
  ];
  for (const candidate of candidates) {
    const parsed = parseDateValue(candidate);
    if (parsed !== null) return parsed;
  }
  return null;
}

function extractExpiry(record) {
  if (!record || typeof record !== 'object') return null;
  const candidates = [
    record.expiresAt,
    record.expires_at,
    record.payload && record.payload.expiresAt,
    record.payload && record.payload.expires_at,
    record.features && record.features.expiresAt,
    record.value && record.value.expiresAt,
  ];
  for (const candidate of candidates) {
    const parsed = parseDateValue(candidate);
    if (parsed !== null) return parsed;
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

function loadConfigRetention(practiceId) {
  try {
    // eslint-disable-next-line global-require
    const { loadConfig } = require('@onecare/config');
    const config = loadConfig(practiceId);
    const retention = config?.privacy_policy?.retention_days;
    const parsed = sanitizeDays(retention);
    if (parsed !== null) {
      return { days: parsed, source: `config:${practiceId}` };
    }
  } catch (err) {
    console.warn('[feature-store-purge] failed to load config retention', {
      practiceId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return null;
}

function determinePracticeId(args) {
  if (args.practiceId && typeof args.practiceId === 'string') {
    return args.practiceId.trim();
  }
  const envPractice = process.env.PRACTICE_ID;
  if (envPractice && envPractice.trim().length > 0) {
    return envPractice.trim();
  }
  return 'demo';
}

function determineRetentionDays(args, practiceId) {
  const cli = sanitizeDays(args.retentionDays);
  if (cli !== null) {
    return { days: cli, source: 'cli' };
  }

  const envRetention = sanitizeDays(process.env.FEATURE_STORE_RETENTION_DAYS);
  if (envRetention !== null) {
    return { days: envRetention, source: 'env' };
  }

  const configRetention = loadConfigRetention(practiceId);
  if (configRetention) {
    return configRetention;
  }

  return { days: DEFAULT_RETENTION_DAYS, source: 'default' };
}

function toIso(ms) {
  return new Date(ms).toISOString();
}

async function purgePostgres(options) {
  const { connectionString, nowMs, cutoffMs, dryRun, table, schema } = options;
  let pg;
  try {
    // eslint-disable-next-line global-require
    pg = require('pg');
  } catch (err) {
    console.error('[feature-store-purge] pg module not available; install dependency to purge Postgres stores', {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exitCode = 1;
    return;
  }

  const sanitizedTable = sanitizeIdentifier(table, 'feature_values');
  const sanitizedSchema = schema ? sanitizeIdentifier(schema, 'public') : 'public';
  const qualified = `${sanitizedSchema}.${sanitizedTable}`;

  const pool = new pg.Pool({
    connectionString,
    max: 1,
  });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const nowIso = new Date(nowMs);
    const cutoffIso = new Date(cutoffMs);

    const countResult = await client.query(
      `SELECT COUNT(*)::bigint AS count
       FROM ${qualified}
       WHERE (expires_at IS NOT NULL AND expires_at <= $1)
          OR (generated_at < $2)`,
      [nowIso, cutoffIso]
    );
    const toDelete = Number(countResult.rows[0]?.count ?? 0);

    if (toDelete === 0) {
      await client.query('ROLLBACK');
      console.info('[feature-store-purge] no rows to purge (Postgres)', {
        table: qualified,
      });
      return;
    }

    if (dryRun) {
      await client.query('ROLLBACK');
      console.info('[feature-store-purge] dry-run: rows eligible for purge (Postgres)', {
        table: qualified,
        count: toDelete,
      });
      return;
    }

    const deleteResult = await client.query(
      `DELETE FROM ${qualified}
       WHERE (expires_at IS NOT NULL AND expires_at <= $1)
          OR (generated_at < $2)`,
      [nowIso, cutoffIso]
    );

    await client.query('COMMIT');
    console.info('[feature-store-purge] purged rows from Postgres feature store', {
      table: qualified,
      deleted: deleteResult.rowCount ?? 0,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

async function purgeJsonlStore(options) {
  const { filePath, nowMs, cutoffMs, dryRun } = options;
  const exists = await fileExists(filePath);
  if (!exists) {
    console.info('[feature-store-purge] JSONL store not found; nothing to purge', { filePath });
    return;
  }

  const linesKept = [];
  let processed = 0;
  let purgedRetention = 0;
  let purgedExpired = 0;
  let purgedMissingTimestamp = 0;
  let parseErrors = 0;
  let mutated = false;

  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const rawLine of rl) {
    const line = rawLine.trim();
    if (!line) continue;
    processed += 1;
    let record;
    try {
      record = JSON.parse(line);
    } catch (err) {
      parseErrors += 1;
      linesKept.push(line);
      continue;
    }

    const expiresAt = extractExpiry(record);
    const timestamp = extractTimestamp(record);
    const expired = typeof expiresAt === 'number' && expiresAt <= nowMs;
    const olderThanRetention = typeof timestamp === 'number' && timestamp < cutoffMs;
    const missingTemporal = expiresAt === null && timestamp === null;

    if (expired || olderThanRetention || missingTemporal) {
      mutated = true;
      if (expired) purgedExpired += 1;
      else if (olderThanRetention) purgedRetention += 1;
      else purgedMissingTimestamp += 1;
      continue;
    }

    linesKept.push(line);
  }

  if (dryRun) {
    console.info('[feature-store-purge] dry-run summary (JSONL)', {
      filePath,
      processed,
      retained: linesKept.length,
      purgedExpired,
      purgedRetention,
      purgedMissingTimestamp,
      parseErrors,
    });
    return;
  }

  if (!mutated) {
    console.info('[feature-store-purge] no JSONL entries required purging', {
      filePath,
      processed,
    });
    return;
  }

  const backupPath = `${filePath}.${toIso(nowMs).replace(/[:.]/g, '-')}.bak`;
  await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
  try {
    await fsPromises.copyFile(filePath, backupPath);
  } catch (err) {
    console.warn('[feature-store-purge] unable to create JSONL backup', {
      filePath,
      backupPath,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const payload = linesKept.length > 0 ? `${linesKept.join('\n')}\n` : '';
  await fsPromises.writeFile(filePath, payload, 'utf8');

  console.info('[feature-store-purge] purged JSONL feature store records', {
    filePath,
    backupPath,
    processed,
    retained: linesKept.length,
    purgedExpired,
    purgedRetention,
    purgedMissingTimestamp,
    parseErrors,
  });
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const practiceId = determinePracticeId(args);
  const retentionInfo = determineRetentionDays(args, practiceId);
  const retentionDays = retentionInfo.days;
  const retentionMs = retentionDays * DAY_MS;
  const nowOverride = parseTemporalInput(args.now);
  if (args.now && nowOverride === null) {
    console.error('[feature-store-purge] invalid --now value; expected ISO string or epoch milliseconds', {
      raw: args.now,
    });
    process.exitCode = 1;
    return;
  }
  const nowMs = nowOverride ?? Date.now();
  const cutoffMs = nowMs - retentionMs;

  const dryRun = args.dryRun || parseBooleanFlag(process.env.FEATURE_STORE_PURGE_DRY_RUN);
  const connectionString = args.url || process.env.FEATURE_STORE_URL || null;
  const jsonlPath = path.resolve(args.input || process.env.FEATURE_STORE_DUMP || DEFAULT_JSONL_PATH);

  console.info('[feature-store-purge] starting', {
    retentionDays,
    retentionSource: retentionInfo.source,
    practiceId,
    now: toIso(nowMs),
    cutoff: toIso(cutoffMs),
    dryRun,
    target: connectionString ? 'postgres' : 'jsonl',
    destination: connectionString ? undefined : jsonlPath,
  });

  try {
    if (connectionString) {
      await purgePostgres({
        connectionString,
        nowMs,
        cutoffMs,
        dryRun,
        table: args.table,
        schema: args.schema,
      });
    } else {
      await purgeJsonlStore({
        filePath: jsonlPath,
        nowMs,
        cutoffMs,
        dryRun,
      });
    }
  } catch (err) {
    console.error('[feature-store-purge] purge failed', {
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    process.exitCode = 1;
  }
}

run().catch((err) => {
  console.error('[feature-store-purge] unexpected failure', err);
  process.exitCode = 1;
});
