#!/usr/bin/env node
'use strict';

const { performance } = require('node:perf_hooks');
const crypto = require('node:crypto');

let OnlineStore;
try {
  ({ InMemoryOnlineFeatureStore: OnlineStore } = require('@onecare/feature-store-online'));
} catch (error) {
  OnlineStore = class {
    constructor() {
      this.store = new Map();
    }
    async upsert({ featureSet, entityId, asOf, payload, ttlSeconds }) {
      const key = `${featureSet}:${entityId}`;
      this.store.set(key, { asOf, payload, expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null });
    }
    async get({ featureSet, entityId }) {
      const key = `${featureSet}:${entityId}`;
      return this.store.get(key) || null;
    }
  };
}

const DEFAULT_DURATION = 60;
const DEFAULT_CONCURRENCY = 16;
const DEFAULT_ENTITY_COUNT = 2000;
const DEFAULT_WRITE_RATIO = 0.2;
const DEFAULT_FEATURE_SET = 'triage-core';

function parseArgs(argv) {
  const args = {
    duration: DEFAULT_DURATION,
    concurrency: DEFAULT_CONCURRENCY,
    entityCount: DEFAULT_ENTITY_COUNT,
    writeRatio: DEFAULT_WRITE_RATIO,
    featureSet: DEFAULT_FEATURE_SET,
    payloadSize: 'small',
    ttlSeconds: 3600,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = argv[i + 1];
    switch (token) {
      case '--duration':
        args.duration = Number(next);
        i += 1;
        break;
      case '--concurrency':
        args.concurrency = Number(next);
        i += 1;
        break;
      case '--entity-count':
        args.entityCount = Number(next);
        i += 1;
        break;
      case '--write-ratio':
        args.writeRatio = Number(next);
        i += 1;
        break;
      case '--feature-set':
        args.featureSet = next;
        i += 1;
        break;
      case '--payload-size':
        args.payloadSize = next;
        i += 1;
        break;
      case '--ttl-seconds':
        args.ttlSeconds = Number(next);
        i += 1;
        break;
      default:
        break;
    }
  }
  if (!Number.isFinite(args.duration) || args.duration <= 0) throw new Error('duration must be > 0');
  if (!Number.isFinite(args.concurrency) || args.concurrency <= 0) throw new Error('concurrency must be > 0');
  if (!Number.isFinite(args.entityCount) || args.entityCount <= 0) throw new Error('entity-count must be > 0');
  if (!Number.isFinite(args.writeRatio) || args.writeRatio < 0 || args.writeRatio > 1) {
    throw new Error('write-ratio must be between 0 and 1');
  }
  return args;
}

function buildPayload(size) {
  const now = new Date().toISOString();
  switch (size) {
    case 'large':
      return {
        schemaVersion: 'v1.0.0',
        generatedAt: now,
        acuity: Math.random(),
        risk: Math.random(),
        complexity: Math.random(),
        time: Math.random(),
        capacity: Math.random(),
        compositeScore: Math.random(),
        extensions: { notes: crypto.randomBytes(64).toString('hex') },
      };
    case 'medium':
      return {
        schemaVersion: 'v1.0.0',
        generatedAt: now,
        acuity: Math.random(),
        risk: Math.random(),
        compositeScore: Math.random(),
      };
    case 'small':
    default:
      return {
        schemaVersion: 'v1.0.0',
        generatedAt: now,
        acuity: Math.random(),
        compositeScore: Math.random(),
      };
  }
}

class Tracker {
  constructor() {
    this.reads = 0;
    this.writes = 0;
    this.failures = 0;
    this.readLatency = [];
    this.writeLatency = [];
  }
  recordRead(latencyMs, success) {
    this.reads += 1;
    this.readLatency.push(latencyMs);
    if (!success) this.failures += 1;
  }
  recordWrite(latencyMs, success) {
    this.writes += 1;
    this.writeLatency.push(latencyMs);
    if (!success) this.failures += 1;
  }
  percentile(collection, ratio) {
    if (collection.length === 0) return 0;
    const sorted = [...collection].sort((a, b) => a - b);
    const index = Math.min(sorted.length - 1, Math.floor(ratio * (sorted.length - 1)));
    return sorted[index];
  }
  summary() {
    return {
      reads: this.reads,
      writes: this.writes,
      failures: this.failures,
      readLatency: {
        p50: this.percentile(this.readLatency, 0.5),
        p95: this.percentile(this.readLatency, 0.95),
      },
      writeLatency: {
        p50: this.percentile(this.writeLatency, 0.5),
        p95: this.percentile(this.writeLatency, 0.95),
      },
    };
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const store = new OnlineStore();
  const tracker = new Tracker();
  const entityIds = Array.from({ length: args.entityCount }, (_, idx) => `entity-${idx}`);

  // warm-up writes
  for (const entityId of entityIds) {
    await store.upsert({
      featureSet: args.featureSet,
      entityId,
      asOf: new Date().toISOString(),
      payload: buildPayload(args.payloadSize),
      ttlSeconds: args.ttlSeconds,
    });
  }

  const endAt = Date.now() + args.duration * 1000;
  const workers = [];

  for (let i = 0; i < args.concurrency; i += 1) {
    workers.push(
      (async () => {
        while (Date.now() < endAt) {
          const entityId = entityIds[Math.floor(Math.random() * entityIds.length)];
          if (Math.random() < args.writeRatio) {
            const started = performance.now();
            try {
              await store.upsert({
                featureSet: args.featureSet,
                entityId,
                asOf: new Date().toISOString(),
                payload: buildPayload(args.payloadSize),
                ttlSeconds: args.ttlSeconds,
              });
              tracker.recordWrite(performance.now() - started, true);
            } catch (error) {
              tracker.recordWrite(performance.now() - started, false);
            }
          } else {
            const started = performance.now();
            try {
              const result = await store.get({ featureSet: args.featureSet, entityId });
              tracker.recordRead(performance.now() - started, Boolean(result));
            } catch (error) {
              tracker.recordRead(performance.now() - started, false);
            }
          }
        }
      })()
    );
  }

  await Promise.all(workers);

  const summary = tracker.summary();
  summary.durationSeconds = args.duration;
  summary.concurrency = args.concurrency;
  summary.entityCount = args.entityCount;
  summary.writeRatio = args.writeRatio;
  summary.featureSet = args.featureSet;
  summary.payloadSize = args.payloadSize;

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error('[feature-store-load] fatal error', error);
  process.exitCode = 1;
});
