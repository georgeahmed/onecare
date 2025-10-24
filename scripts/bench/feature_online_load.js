#!/usr/bin/env node
'use strict';

const { performance } = require('node:perf_hooks');
const crypto = require('node:crypto');

const { InMemoryOnlineFeatureStore } = require('@onecare/feature-store-online');

function parseArgs(argv) {
  const args = {
    duration: 60,
    concurrency: 16,
    entityCount: 1000,
    readRatio: 0.8,
    payloadSize: 'small',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = argv[i + 1];
    switch (token) {
      case '--duration':
        args.duration = Number(next) || args.duration;
        i += 1;
        break;
      case '--concurrency':
        args.concurrency = Number(next) || args.concurrency;
        i += 1;
        break;
      case '--entity-count':
        args.entityCount = Number(next) || args.entityCount;
        i += 1;
        break;
      case '--read-ratio':
        args.readRatio = Number(next) || args.readRatio;
        i += 1;
        break;
      case '--payload-size':
        args.payloadSize = next || args.payloadSize;
        i += 1;
        break;
      default:
        break;
    }
  }
  return args;
}

function buildPayload(size) {
  switch (size) {
    case 'large':
      return { schemaVersion: 'v1', generatedAt: new Date().toISOString(), values: Array.from({ length: 128 }, () => Math.random()) };
    case 'medium':
      return { schemaVersion: 'v1', generatedAt: new Date().toISOString(), values: Array.from({ length: 32 }, () => Math.random()) };
    case 'small':
    default:
      return { schemaVersion: 'v1', generatedAt: new Date().toISOString(), score: Math.random() };
  }
}

async function main() {
  const argv = parseArgs(process.argv.slice(2));
  const store = new InMemoryOnlineFeatureStore();
  const featureSet = 'triage-core';
  const entityIds = Array.from({ length: argv.entityCount }, (_, idx) => `entity-${idx}`);

  for (const entityId of entityIds) {
    await store.upsert({
      featureSet,
      entityId,
      asOf: new Date().toISOString(),
      payload: buildPayload(argv.payloadSize),
      ttlSeconds: 600,
    });
  }

  const endTime = Date.now() + argv.duration * 1000;
  const latencies = [];
  let reads = 0;
  let writes = 0;

  const worker = async () => {
    while (Date.now() < endTime) {
      const entityId = entityIds[Math.floor(Math.random() * entityIds.length)];
      if (Math.random() < argv.readRatio) {
        const start = performance.now();
        await store.get({ featureSet, entityId });
        latencies.push(performance.now() - start);
        reads += 1;
      } else {
        const start = performance.now();
        await store.upsert({
          featureSet,
          entityId,
          asOf: new Date().toISOString(),
          payload: buildPayload(argv.payloadSize),
          ttlSeconds: 600,
          correlationId: crypto.randomUUID(),
        });
        latencies.push(performance.now() - start);
        writes += 1;
      }
    }
  };

  await Promise.all(Array.from({ length: argv.concurrency }, () => worker()));

  latencies.sort((a, b) => a - b);
  const percentile = (p) => {
    if (latencies.length === 0) return 0;
    const idx = Math.floor((latencies.length - 1) * p);
    return latencies[idx];
  };

  console.log(JSON.stringify({
    durationSeconds: argv.duration,
    concurrency: argv.concurrency,
    entityCount: argv.entityCount,
    readRatio: argv.readRatio,
    payloadSize: argv.payloadSize,
    reads,
    writes,
    totalOps: reads + writes,
    p50: percentile(0.5),
    p95: percentile(0.95),
    p99: percentile(0.99),
  }, null, 2));
}

main().catch((err) => {
  console.error('[feature-bench] failed', err);
  process.exit(1);
});
