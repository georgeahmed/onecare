#!/usr/bin/env node
'use strict';

/**
 * Feature compaction and retention script.
 * - Reads feature JSONL payloads (entityId, featureSet, payload).
 * - Drops entries that exceed the retention window or whose payload has expired.
 * - Optionally deduplicates by keeping the most recent record per (featureSet, entityId).
 *
 * Usage:
 *   node scripts/feature_compact.js \
 *     --input var/features/triage-core.jsonl \
 *     --output var/features/triage-core.compacted.jsonl \
 *     --retention-days 7
 *
 * Environment overrides:
 *   FEATURE_COMPACT_INPUT, FEATURE_COMPACT_OUTPUT, FEATURE_COMPACT_RETENTION_DAYS
 */

const fs = require('fs');
const fsPromises = fs.promises;
const path = require('path');
const readline = require('readline');

const DEFAULT_INPUT = process.env.FEATURE_COMPACT_INPUT || 'var/features/triage-core.jsonl';
const DEFAULT_OUTPUT =
  process.env.FEATURE_COMPACT_OUTPUT || 'var/features/triage-core.compacted.jsonl';
const DEFAULT_RETENTION_DAYS = Number(process.env.FEATURE_COMPACT_RETENTION_DAYS || '7');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('-')) continue;
    const next = argv[i + 1];
    if ((token === '--input' || token === '-i') && next) {
      args.input = next;
      i += 1;
    } else if ((token === '--output' || token === '-o') && next) {
      args.output = next;
      i += 1;
    } else if ((token === '--retention-days' || token === '-r') && next) {
      const parsed = Number(next);
      if (!Number.isNaN(parsed) && parsed > 0) {
        args.retentionDays = parsed;
      }
      i += 1;
    } else if ((token === '--now' || token === '-n') && next) {
      args.now = next;
      i += 1;
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

function parseDate(value) {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function determineTimestamp(record) {
  if (!record || typeof record !== 'object') return null;
  if (record.payload && typeof record.payload === 'object') {
    const expiresAt = parseDate(record.payload.expiresAt);
    if (expiresAt !== null) return expiresAt;
    const generatedAt = parseDate(record.payload.generatedAt);
    if (generatedAt !== null) return generatedAt;
  }
  const envelopeTimestamp = parseDate(record.timestamp);
  if (envelopeTimestamp !== null) return envelopeTimestamp;
  return null;
}

function formatIso(epochMs) {
  return new Date(epochMs).toISOString();
}

async function writeJsonl(outputPath, records) {
  await fsPromises.mkdir(path.dirname(outputPath), { recursive: true });
  const lines = records.map((record) => JSON.stringify(record));
  await fsPromises.writeFile(outputPath, `${lines.join('\n')}\n`, 'utf8');
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  const inputPath = path.resolve(args.input || DEFAULT_INPUT);
  const outputPath = path.resolve(args.output || DEFAULT_OUTPUT);
  const retentionDays = args.retentionDays || DEFAULT_RETENTION_DAYS;
  const now = args.now ? Date.parse(args.now) : Date.now();

  if (Number.isNaN(now)) {
    console.error('[feature-compact] invalid --now value');
    process.exitCode = 1;
    return;
  }

  if (!(await fileExists(inputPath))) {
    console.warn('[feature-compact] input file not found, nothing to compact', { inputPath });
    return;
  }

  const retentionMs = retentionDays * 24 * 60 * 60 * 1000;
  const cutoff = now - retentionMs;
  const rl = readline.createInterface({
    input: fs.createReadStream(inputPath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  let processed = 0;
  let removedExpired = 0;
  let removedRetention = 0;
  let dedupCollapsed = 0;
  const kept = new Map();

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    processed += 1;
    let record;
    try {
      record = JSON.parse(trimmed);
    } catch (err) {
      console.warn('[feature-compact] skipping invalid JSON', {
        error: err.message,
        line: trimmed.slice(0, 120),
      });
      continue;
    }

    const key = record && record.entityId && record.featureSet ? `${record.featureSet}::${record.entityId}` : null;
    if (!key) {
      removedRetention += 1;
      continue;
    }

    const timestamp = determineTimestamp(record);
    if (timestamp === null) {
      // Missing timestamps are treated as stale.
      removedRetention += 1;
      continue;
    }

    if (record.payload && typeof record.payload === 'object') {
      const expiresAt = parseDate(record.payload.expiresAt);
      if (expiresAt !== null && expiresAt <= now) {
        removedExpired += 1;
        continue;
      }
    }

    if (timestamp <= cutoff) {
      removedRetention += 1;
      continue;
    }

    const previous = kept.get(key);
    if (!previous || previous.timestamp < timestamp) {
      if (previous) dedupCollapsed += 1;
      kept.set(key, { timestamp, record });
    } else {
      dedupCollapsed += 1;
    }
  }

  const outputRecords = Array.from(kept.values())
    .sort((a, b) => a.timestamp - b.timestamp)
    .map((entry) => entry.record);

  await writeJsonl(outputPath, outputRecords);

  console.info('[feature-compact] completed', {
    inputPath,
    outputPath,
    retentionDays,
    retentionCutoff: formatIso(cutoff),
    processed,
    kept: outputRecords.length,
    removedExpired,
    removedRetention,
    dedupCollapsed,
  });
}

run().catch((err) => {
  console.error('[feature-compact] fatal error', err);
  process.exitCode = 1;
});
