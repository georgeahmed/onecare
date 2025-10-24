#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const { MemoryBus } = require('@onecare/bus');
let FeatureStoreOnline;
try {
  FeatureStoreOnline = require('@onecare/feature-store-online');
} catch (err) {
  FeatureStoreOnline = require('../../packages/feature-store-online/dist');
}
let FeatureIngest;
try {
  FeatureIngest = require('@onecare/feature-store-ingest');
} catch (err) {
  FeatureIngest = require('../../packages/feature-store-ingest/dist');
}
const Ports = require('@onecare/ports');

const { InMemoryOnlineFeatureStore } = FeatureStoreOnline;
const { FeatureIngestionWorker } = FeatureIngest;
const { getFeatureRegistry } = Ports;

class MemoryIdempotencyStore {
  constructor() {
    this.entries = new Map();
  }
  prune() {
    const now = Date.now();
    for (const [key, expiresAt] of this.entries.entries()) {
      if (expiresAt !== null && expiresAt <= now) {
        this.entries.delete(key);
      }
    }
  }
  async exists(key) {
    this.prune();
    return this.entries.has(key);
  }
  async put(key, ttlSeconds) {
    this.prune();
    const expiresAt = Number.isFinite(ttlSeconds) ? Date.now() + ttlSeconds * 1000 : null;
    this.entries.set(key, expiresAt);
  }
  async reserve(key, ttlSeconds) {
    this.prune();
    if (this.entries.has(key)) {
      return 'exists';
    }
    const expiresAt = Number.isFinite(ttlSeconds) ? Date.now() + ttlSeconds * 1000 : null;
    this.entries.set(key, expiresAt);
    return 'reserved';
  }
  async delete(key) {
    this.entries.delete(key);
  }
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('-')) continue;
    const next = argv[i + 1];
    if ((token === '--input' || token === '-i') && next) {
      args.input = next;
      i += 1;
    }
  }
  return args;
}

async function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  const defaultInput = path.resolve(process.cwd(), 'data/feature-stream.jsonl');
  const inputPath = path.resolve(args.input || defaultInput);

  if (!fs.existsSync(inputPath)) {
    console.error('[feature-ingest] input file not found', { inputPath });
    process.exitCode = 1;
    return;
  }

  const bus = new MemoryBus();
  const featureStore = new InMemoryOnlineFeatureStore();
  const idempotency = new MemoryIdempotencyStore();
  const registry = getFeatureRegistry();

  const worker = new FeatureIngestionWorker(
    {
      bus,
      featureStore,
      idempotency,
      mappings: [
        {
          topic: 'features.triage-core',
          featureSet: 'triage-core',
          deriveEntityId: (payload) => payload.patientId,
          deriveAsOf: (payload) => payload.generatedAt || new Date().toISOString(),
          mapPayload: (payload) => payload.features ?? payload,
        },
        {
          topic: 'features.acuity-signal',
          featureSet: 'acuity-signal',
          deriveEntityId: (payload) => payload.patientId,
          deriveAsOf: (payload) => payload.generatedAt || payload.timestamp || new Date().toISOString(),
          mapPayload: (payload) => payload.features ?? payload,
        },
      ],
    },
    {
      retries: 3,
      backoffMs: 100,
      jitterMs: 50,
      dlqTopic: 'features.ingest.dlq',
    }
  );

  await worker.start();
  const rl = readline.createInterface({
    input: fs.createReadStream(inputPath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch (err) {
      console.warn('[feature-ingest] skipping invalid JSON', { line: trimmed.slice(0, 120) });
      continue;
    }
    const topic = event.topic;
    if (!topic) {
      console.warn('[feature-ingest] event missing topic', { event });
      continue;
    }
    await bus.publish(topic, event.payload || event, event.headers || {});
  }

  await worker.stop();
  const metrics = worker.getMetrics();
  console.info('[feature-ingest] completed run', {
    inputPath,
    metrics,
    registryVersion: registry.version,
  });
}

main().catch((err) => {
  console.error('[feature-ingest] fatal error', err);
  process.exitCode = 1;
});
