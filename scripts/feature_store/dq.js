#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const fsPromises = require('node:fs/promises');
const path = require('node:path');
const readline = require('node:readline');

const DEFAULT_INPUT = 'var/features/triage-core.jsonl';
const DEFAULT_CONFIG = 'config/feature-store/dq.json';
const DEFAULT_QUARANTINE = 'var/features/dq-quarantine.jsonl';

function parseArgs(argv) {
  const args = {
    input: DEFAULT_INPUT,
    config: DEFAULT_CONFIG,
    quarantine: DEFAULT_QUARANTINE,
    now: Date.now(),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = argv[i + 1];
    switch (token) {
      case '--input':
      case '-i':
        if (next) {
          args.input = next;
          i += 1;
        }
        break;
      case '--config':
        if (next) {
          args.config = next;
          i += 1;
        }
        break;
      case '--quarantine':
      case '-q':
        if (next) {
          args.quarantine = next;
          i += 1;
        }
        break;
      case '--now':
        if (next) {
          const parsed = Date.parse(next);
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

async function loadConfig(configPath) {
  const absolute = path.resolve(configPath);
  const raw = await fsPromises.readFile(absolute, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Failed to parse DQ config (${absolute}): ${error instanceof Error ? error.message : String(error)}`);
  }
}

function getTimestamp(record) {
  if (typeof record.asOf === 'string') {
    return record.asOf;
  }
  if (record.payload && typeof record.payload.generatedAt === 'string') {
    return record.payload.generatedAt;
  }
  return null;
}

function getPayloadValue(payload, field) {
  if (!payload || typeof payload !== 'object') return undefined;
  if (Object.prototype.hasOwnProperty.call(payload, field)) {
    return payload[field];
  }
  return undefined;
}

class DQTracker {
  constructor(nowMs) {
    this.nowMs = nowMs;
    this.summary = {
      records: 0,
      featureSets: new Map(),
      constraints: new Map(),
      freshness: [],
      freshnessBreaches: [],
      violations: [],
    };
    this.monotonicState = new Map(); // featureSet -> field -> entityId -> lastValue
  }

  recordFeatureSet(featureSet) {
    const entry = this.summary.featureSets.get(featureSet) ?? { total: 0, violations: 0, freshnessBreaches: 0 };
    entry.total += 1;
    this.summary.featureSets.set(featureSet, entry);
  }

  recordViolation(featureSet, field, reason, record) {
    const key = `${featureSet}:${field}:${reason}`;
    const entry = this.summary.constraints.get(key) ?? 0;
    this.summary.constraints.set(key, entry + 1);
    const featureEntry = this.summary.featureSets.get(featureSet);
    if (featureEntry) {
      featureEntry.violations += 1;
    }
    this.summary.violations.push({
      featureSet,
      field,
      reason,
      entityId: record.entityId,
    });
  }

  recordFreshness(featureSet, ageMs, breached, record) {
    this.summary.freshness.push(ageMs);
    const featureEntry = this.summary.featureSets.get(featureSet);
    if (breached && featureEntry) {
      featureEntry.freshnessBreaches += 1;
    }
    if (breached) {
      this.summary.freshnessBreaches.push({
        featureSet,
        ageMs,
        entityId: record.entityId,
      });
    }
  }

  updateMonotonic(featureSet, field, entityId, value) {
    if (!this.monotonicState.has(featureSet)) {
      this.monotonicState.set(featureSet, new Map());
    }
    const fields = this.monotonicState.get(featureSet);
    if (!fields.has(field)) {
      fields.set(field, new Map());
    }
    const entities = fields.get(field);
    const previous = entities.get(entityId);
    entities.set(entityId, value);
    return previous;
  }

  finalSummary() {
    const freshnessSorted = [...this.summary.freshness].sort((a, b) => a - b);
    const percentile = (collection, ratio) => {
      if (collection.length === 0) return 0;
      const idx = Math.min(collection.length - 1, Math.floor(ratio * (collection.length - 1)));
      return collection[idx];
    };
    return {
      records: this.summary.records,
      featureSets: Array.from(this.summary.featureSets.entries()).map(([featureSet, stats]) => ({
        featureSet,
        ...stats,
      })),
      constraintViolations: Array.from(this.summary.constraints.entries()).map(([key, count]) => {
        const [featureSet, field, reason] = key.split(':');
        return { featureSet, field, reason, count };
      }),
      freshness: {
        samples: this.summary.freshness.length,
        p50Ms: percentile(freshnessSorted, 0.5),
        p95Ms: percentile(freshnessSorted, 0.95),
        maxMs: freshnessSorted.length > 0 ? freshnessSorted[freshnessSorted.length - 1] : 0,
        breaches: this.summary.freshnessBreaches,
      },
    };
  }
}

async function ensureQuarantineReady(quarantinePath) {
  await fsPromises.mkdir(path.dirname(quarantinePath), { recursive: true });
  await fsPromises.rm(quarantinePath, { force: true });
}

async function appendQuarantine(quarantinePath, entry) {
  const line = `${JSON.stringify(entry)}\n`;
  await fsPromises.appendFile(quarantinePath, line, { encoding: 'utf8' });
}

function evaluateConstraints(featureSet, config, record, tracker, quarantinePath) {
  const payload = record.payload ?? {};
  const constraints = config.constraints ?? {};
  const entityId = record.entityId ?? 'unknown';
  for (const [field, definition] of Object.entries(constraints)) {
    const value = getPayloadValue(payload, field);
    const type = definition.type;
    if (type === 'range') {
      if (typeof value !== 'number' || Number.isNaN(value) || value < definition.min || value > definition.max) {
        tracker.recordViolation(featureSet, field, 'range', record);
        appendQuarantine(quarantinePath, { reason: 'range', featureSet, field, entityId, value }).catch(() => {});
      }
    } else if (type === 'domain') {
      if (typeof value !== 'string' || !definition.values.includes(value)) {
        tracker.recordViolation(featureSet, field, 'domain', record);
        appendQuarantine(quarantinePath, { reason: 'domain', featureSet, field, entityId, value }).catch(() => {});
      }
    } else if (type === 'notNull') {
      if (value === null || value === undefined || value === '') {
        tracker.recordViolation(featureSet, field, 'not_null', record);
        appendQuarantine(quarantinePath, { reason: 'not_null', featureSet, field, entityId }).catch(() => {});
      }
    } else if (type === 'monotonic') {
      if (value === null || value === undefined) continue;
      const previous = tracker.updateMonotonic(featureSet, field, entityId, value);
      if (previous !== undefined) {
        const direction = definition.direction ?? 'nondecreasing';
        let violates = false;
        if (direction === 'nondecreasing' && value < previous) {
          violates = true;
        } else if (direction === 'nonincreasing' && value > previous) {
          violates = true;
        }
        if (violates) {
          tracker.recordViolation(featureSet, field, `monotonic_${direction}`, record);
          appendQuarantine(quarantinePath, {
            reason: `monotonic_${direction}`,
            featureSet,
            field,
            entityId,
            previous,
            value,
          }).catch(() => {});
        }
      }
    }
  }
}

function evaluateFreshness(featureSet, config, record, tracker, quarantinePath) {
  const freshnessConfig = config.freshness;
  if (!freshnessConfig) return;
  const timestamp = getTimestamp(record);
  if (!timestamp) {
    tracker.recordFreshness(featureSet, Number.POSITIVE_INFINITY, true, record);
    appendQuarantine(quarantinePath, { reason: 'missing_timestamp', featureSet, entityId: record.entityId }).catch(() => {});
    return;
  }
  const parsed = Date.parse(timestamp);
  if (Number.isNaN(parsed)) {
    tracker.recordFreshness(featureSet, Number.POSITIVE_INFINITY, true, record);
    appendQuarantine(quarantinePath, { reason: 'invalid_timestamp', featureSet, entityId: record.entityId, timestamp }).catch(() => {});
    return;
  }
  const ageMs = tracker.nowMs - parsed;
  const breached = Number.isFinite(freshnessConfig.maxAgeSeconds)
    ? ageMs > freshnessConfig.maxAgeSeconds * 1000
    : false;
  tracker.recordFreshness(featureSet, ageMs, breached, record);
  if (breached) {
    appendQuarantine(quarantinePath, {
      reason: 'freshness',
      featureSet,
      entityId: record.entityId,
      ageMs,
      maxAgeSeconds: freshnessConfig.maxAgeSeconds,
    }).catch(() => {});
  }
}

async function processFile(args, config) {
  const tracker = new DQTracker(args.now);
  const inputPath = path.resolve(args.input);
  const quarantinePath = path.resolve(args.quarantine);

  if (!fs.existsSync(inputPath)) {
    throw new Error(`Input file not found: ${inputPath}`);
  }

  await ensureQuarantineReady(quarantinePath);

  const rl = readline.createInterface({
    input: fs.createReadStream(inputPath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let record;
    try {
      record = JSON.parse(trimmed);
    } catch (error) {
      await appendQuarantine(quarantinePath, { reason: 'parse_error', line: trimmed.slice(0, 200) });
      tracker.summary.records += 1;
      continue;
    }
    tracker.summary.records += 1;
    const featureSet = record.featureSet;
    if (!featureSet || !config[featureSet]) {
      continue;
    }
    tracker.recordFeatureSet(featureSet);
    const featureConfig = config[featureSet];
    evaluateConstraints(featureSet, featureConfig, record, tracker, quarantinePath);
    evaluateFreshness(featureSet, featureConfig, record, tracker, quarantinePath);
  }

  return tracker.finalSummary();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = await loadConfig(args.config);
  const summary = await processFile(args, config);
  console.log(JSON.stringify({ args, summary }, null, 2));
}

main().catch((error) => {
  console.error('[feature-dq] fatal error', error);
  process.exitCode = 1;
});
