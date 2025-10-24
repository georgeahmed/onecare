#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { buildPointInTimeTable, selectPointInTime } = require('@onecare/feature-store-offline');

function parseArgs(argv) {
  const args = {
    featureSets: [],
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = argv[i + 1];
    switch (token) {
      case '--labels':
      case '-l':
        if (next) {
          args.labels = next;
          i += 1;
        }
        break;
      case '--snapshots':
      case '-s':
        if (next) {
          args.snapshots = next;
          i += 1;
        }
        break;
      case '--output':
      case '-o':
        if (next) {
          args.output = next;
          i += 1;
        }
        break;
      case '--feature-set':
      case '-f':
        if (next) {
          args.featureSets.push(next);
          i += 1;
        }
        break;
      case '--timestamp-field':
        if (next) {
          args.timestampField = next;
          i += 1;
        }
        break;
      case '--entity-field':
        if (next) {
          args.entityField = next;
          i += 1;
        }
        break;
      default:
        break;
    }
  }
  return args;
}

function readJsonLines(filePath) {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`File not found: ${resolved}`);
  }
  const data = fs.readFileSync(resolved, 'utf8');
  const lines = data.split(/\r?\n/);
  const payload = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      payload.push(JSON.parse(trimmed));
    } catch (error) {
      throw new Error(`Invalid JSON in ${resolved}: ${error.message}`);
    }
  }
  return payload;
}

function hashEntity(entityId) {
  return Buffer.from(entityId).toString('base64url');
}

async function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  if (!args.labels || !args.snapshots) {
    console.error('Usage: pit_join_helper.js --labels labels.jsonl --snapshots snapshots.jsonl --feature-set triage-core --feature-set acuity-signal --output joined.jsonl');
    process.exit(1);
    return;
  }
  const featureSets = args.featureSets.length > 0 ? args.featureSets : ['triage-core'];
  const timestampField = args.timestampField ?? 'timestamp';
  const entityField = args.entityField ?? 'entityId';
  const outputPath = path.resolve(args.output ?? 'data/pit-training-set.jsonl');

  const labels = readJsonLines(args.labels);
  const snapshotsRaw = readJsonLines(args.snapshots);
  const snapshots = snapshotsRaw.filter((snapshot) => featureSets.includes(snapshot.featureSet));
  const pitTable = buildPointInTimeTable(snapshots);

  const out = fs.createWriteStream(outputPath, { encoding: 'utf8' });
  for (const label of labels) {
    const entityId = label[entityField];
    const asOf = label[timestampField];
    if (!entityId || !asOf) {
      console.warn('[pit-helper] skipping label missing entity/timestamp', { label });
      continue;
    }
    const row = {
      entityId,
      entityHash: hashEntity(String(entityId)),
      asOf,
      label: label.label ?? null,
      metadata: label.metadata ?? null,
    };
    for (const featureSet of featureSets) {
      const pitRow = selectPointInTime(pitTable, {
        featureSet,
        entityId,
        asOf,
      });
      if (pitRow?.payload) {
        row[`features_${featureSet}`] = pitRow.payload;
      } else {
        row[`features_${featureSet}`] = null;
      }
    }
    out.write(`${JSON.stringify(row)}\n`);
  }
  out.end();
  console.info('[pit-helper] wrote dataset', { outputPath, labels: labels.length, featureSets });
}

main().catch((error) => {
  console.error('[pit-helper] fatal error', error);
  process.exitCode = 1;
});
