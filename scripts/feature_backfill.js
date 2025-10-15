#!/usr/bin/env node
'use strict';

/** @typedef {import('@onecare/events').TriageCoreFeatures} TriageCoreFeatures */
/** @typedef {import('@onecare/events').AcuitySignalFeatures} AcuitySignalFeatures */

/**
 * Backfill script that hydrates the feature store from historical triage events.
 * - Reads JSONL files containing triage input envelopes or payloads.
 * - Derives feature vectors (triage-core) and validates them against the schema registry.
 * - Writes validated vectors to the configured feature store (default: JSONL sink via in-memory store).
 *
 * Usage:
 *   node scripts/feature_backfill.js --input data/backfill/triage-input.jsonl --output var/features/triage-core.jsonl
 *
 * Environment overrides:
 *   FEATURE_BACKFILL_INPUT, FEATURE_BACKFILL_OUTPUT, FEATURE_BACKFILL_SET
 */

const fs = require('fs');
const fsPromises = fs.promises;
const path = require('path');
const readline = require('readline');

const FEATURE_SCHEMAS = {
  'triage-core': 'https://onecare/schemas/features/triage-core.json',
  'acuity-signal': 'https://onecare/schemas/features/acuity-signal.json',
};

let validateFeaturePayload = null;
let getFeatureSchemaId = null;

try {
  // eslint-disable-next-line global-require
  ({ validateFeaturePayload, getFeatureSchemaId } = require('@onecare/ports'));
} catch (err) {
  console.warn('[feature-backfill] unable to load feature registry helpers from @onecare/ports', { message: err.message });
}

if (typeof validateFeaturePayload !== 'function') {
  // eslint-disable-next-line global-require
  const { validate } = require('@onecare/domain');
  validateFeaturePayload = (featureSet, payload) => {
    const schemaId = FEATURE_SCHEMAS[featureSet];
    if (!schemaId) {
      throw new Error(`Unknown feature set: ${featureSet}`);
    }
    return validate(schemaId, payload);
  };
}

if (typeof getFeatureSchemaId !== 'function') {
  getFeatureSchemaId = (featureSet) => FEATURE_SCHEMAS[featureSet];
}

let InMemoryFeatureStore;
try {
  // Prefer compiled workspace package if available.
  // eslint-disable-next-line global-require
  InMemoryFeatureStore = require('@onecare/feature-store-memory').InMemoryFeatureStore;
} catch (err) {
  console.warn('[feature-backfill] Falling back to local in-memory store implementation', { message: err.message });
  InMemoryFeatureStore = class {
    constructor() {
      this.store = new Map();
    }
    async putFeatures(key, features) {
      this.store.set(key, JSON.parse(JSON.stringify(features)));
    }
    async getFeatures(key) {
      const value = this.store.get(key);
      return value ? JSON.parse(JSON.stringify(value)) : null;
    }
  };
}

const DEFAULT_INPUT = process.env.FEATURE_BACKFILL_INPUT || 'data/backfill/triage-input.jsonl';
const DEFAULT_OUTPUT = process.env.FEATURE_BACKFILL_OUTPUT || 'var/features/triage-core.jsonl';
const DEFAULT_FEATURE_SET = process.env.FEATURE_BACKFILL_SET || 'triage-core';

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
    } else if ((token === '--feature-set' || token === '-f') && next) {
      args.featureSet = next;
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

function clamp(value, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function safeNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (!Number.isNaN(parsed) && Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/**
 * @param {unknown} envelopeOrPayload
 * @returns {{ patientId: string; features: TriageCoreFeatures } | null}
 */
function deriveTriageCoreFeatures(envelopeOrPayload) {
  const envelope = envelopeOrPayload || {};
  const payload = envelope.payload && typeof envelope.payload === 'object' ? envelope.payload : envelope;
  if (!payload || typeof payload !== 'object') return null;

  const patientId = payload.patientId || payload.patient_id || payload.entityId;
  if (!patientId || typeof patientId !== 'string') {
    return null;
  }

  const base = payload.features && typeof payload.features === 'object' ? payload.features : {};
  const nowIso = new Date().toISOString();
  const generatedAt =
    (typeof envelope.timestamp === 'string' && envelope.timestamp) ||
    (typeof payload.generatedAt === 'string' && payload.generatedAt) ||
    nowIso;

  const scores = ['acuity', 'risk', 'complexity', 'time', 'capacity'].reduce((acc, key) => {
    const raw = safeNumber(base[key]);
    acc[key] = clamp(raw ?? 0, 0, 1);
    return acc;
  }, {});

  const compositeSource =
    safeNumber(base.compositeScore) ??
    Object.values(scores).reduce((sum, value) => sum + (typeof value === 'number' ? value : 0), 0) /
      Object.keys(scores).length;

  const extensions = {};
  for (const [key, value] of Object.entries(base)) {
    if (key in scores || key === 'compositeScore') continue;
    extensions[key] = value;
  }

  /** @type {TriageCoreFeatures} */
  const featureVector = {
    schemaVersion: typeof base.schemaVersion === 'string' ? base.schemaVersion : 'v1.0.0',
    generatedAt,
    ...scores,
    compositeScore: compositeSource ?? 0,
    source: typeof base.source === 'string' ? base.source : 'backfill',
  };

  if (typeof base.expiresAt === 'string') {
    featureVector.expiresAt = base.expiresAt;
  }

  if (Object.keys(extensions).length > 0) {
    featureVector.extensions = extensions;
  }

  return { patientId, features: featureVector };
}

async function writeJsonl(outputPath, records) {
  if (!records.length) return;
  await fsPromises.mkdir(path.dirname(outputPath), { recursive: true });
  const lines = records.map((record) => JSON.stringify(record));
  await fsPromises.writeFile(outputPath, `${lines.join('\n')}\n`, 'utf8');
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  const inputPath = path.resolve(args.input || DEFAULT_INPUT);
  const outputPath = path.resolve(args.output || DEFAULT_OUTPUT);
  const featureSet = args.featureSet || DEFAULT_FEATURE_SET;

  if (!getFeatureSchemaId(featureSet)) {
    console.error('[feature-backfill] unknown feature set', { featureSet });
    process.exitCode = 1;
    return;
  }

  if (!(await fileExists(inputPath))) {
    console.warn('[feature-backfill] input file not found, nothing to backfill', { inputPath });
    return;
  }

  const store = new InMemoryFeatureStore();
  const rl = readline.createInterface({
    input: fs.createReadStream(inputPath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  let processed = 0;
  let written = 0;
  let skippedMissingKey = 0;
  let skippedInvalid = 0;
  const outputRecords = [];

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    processed += 1;
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch (err) {
      skippedInvalid += 1;
      console.warn('[feature-backfill] skipping invalid JSON', { line: trimmed.slice(0, 120), error: err.message });
      continue;
    }

    const derived = deriveTriageCoreFeatures(event);
    if (!derived) {
      skippedMissingKey += 1;
      continue;
    }

    const validation = validateFeaturePayload(featureSet, derived.features);
    if (!validation.ok) {
      skippedInvalid += 1;
      console.warn('[feature-backfill] feature payload failed validation', {
        patientId: derived.patientId,
        errors: validation.errors,
      });
      continue;
    }

    await store.putFeatures(derived.patientId, derived.features);
    outputRecords.push({
      entityId: derived.patientId,
      featureSet,
      payload: derived.features,
    });
    written += 1;
  }

  await writeJsonl(outputPath, outputRecords);

  console.info('[feature-backfill] completed', {
    inputPath,
    outputPath,
    featureSet,
    processed,
    written,
    skippedMissingKey,
    skippedInvalid,
  });
}

run().catch((err) => {
  console.error('[feature-backfill] fatal error', err);
  process.exitCode = 1;
});
