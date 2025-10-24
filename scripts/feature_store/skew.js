#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const fsPromises = require('node:fs/promises');
const path = require('node:path');
const readline = require('node:readline');

function usage(message) {
  if (message) {
    console.error(`[feature-skew] ${message}`);
  }
  console.error('Usage: node scripts/feature_store/skew.js --offline <file> --online <file> --feature-set <name> --fields field1,field2 [--bins 10] [--threshold 0.2]');
  process.exit(1);
}

function parseArgs(argv) {
  const args = {
    offline: null,
    online: null,
    featureSet: null,
    fields: [],
    bins: 10,
    threshold: 0.2,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = argv[i + 1];
    switch (token) {
      case '--offline':
        args.offline = next;
        i += 1;
        break;
      case '--online':
        args.online = next;
        i += 1;
        break;
      case '--feature-set':
        args.featureSet = next;
        i += 1;
        break;
      case '--fields':
        args.fields = next.split(',').map((entry) => entry.trim()).filter(Boolean);
        i += 1;
        break;
      case '--bins':
        args.bins = Number.parseInt(next, 10);
        i += 1;
        break;
      case '--threshold':
        args.threshold = Number(next);
        i += 1;
        break;
      default:
        usage(`unknown argument: ${token}`);
    }
  }
  if (!args.offline || !args.online) usage('both --offline and --online are required');
  if (!args.featureSet) usage('--feature-set is required');
  if (args.fields.length === 0) usage('--fields must list at least one feature');
  if (!Number.isFinite(args.bins) || args.bins <= 0) usage('--bins must be > 0');
  if (!Number.isFinite(args.threshold) || args.threshold < 0) usage('--threshold must be >= 0');
  return args;
}

async function readJsonl(filePath, featureSet) {
  const results = [];
  const rl = readline.createInterface({
    input: fs.createReadStream(path.resolve(filePath), { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const record = JSON.parse(trimmed);
      if (!record || typeof record !== 'object') continue;
      if (record.featureSet && record.featureSet !== featureSet) continue;
      results.push(record);
    } catch (error) {
      console.warn('[feature-skew] skipping invalid JSON line', trimmed.slice(0, 80));
    }
  }
  return results;
}

function collectFieldValues(records, field) {
  const values = [];
  for (const record of records) {
    const payload = record.payload ?? {};
    const value = payload[field];
    if (typeof value === 'number' && Number.isFinite(value)) {
      values.push(value);
    }
  }
  return values;
}

function computeHistogram(values, bins, min, max) {
  const counts = new Array(bins).fill(0);
  const width = (max - min) / bins || 1;
  for (const value of values) {
    let index;
    if (max === min) {
      index = 0;
    } else {
      index = Math.min(bins - 1, Math.floor((value - min) / width));
    }
    counts[index] += 1;
  }
  return counts;
}

function psi(expectedCounts, actualCounts) {
  const epsilon = 1e-6;
  let total = 0;
  const expectedTotal = expectedCounts.reduce((acc, value) => acc + value, 0) || 1;
  const actualTotal = actualCounts.reduce((acc, value) => acc + value, 0) || 1;
  for (let i = 0; i < expectedCounts.length; i += 1) {
    const expectedRatio = (expectedCounts[i] || 0) / expectedTotal + epsilon;
    const actualRatio = (actualCounts[i] || 0) / actualTotal + epsilon;
    total += (expectedRatio - actualRatio) * Math.log(expectedRatio / actualRatio);
  }
  return total;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const offlineRecords = await readJsonl(args.offline, args.featureSet);
  const onlineRecords = await readJsonl(args.online, args.featureSet);

  if (offlineRecords.length === 0) {
    usage('offline dataset yielded no records');
  }
  if (onlineRecords.length === 0) {
    usage('online dataset yielded no records');
  }

  const summaries = [];
  for (const field of args.fields) {
    const offlineValues = collectFieldValues(offlineRecords, field);
    const onlineValues = collectFieldValues(onlineRecords, field);
    if (offlineValues.length === 0 || onlineValues.length === 0) {
      summaries.push({ field, psi: null, status: 'insufficient_data' });
      continue;
    }
    const min = Math.min(...offlineValues, ...onlineValues);
    const max = Math.max(...offlineValues, ...onlineValues);
    const offlineHist = computeHistogram(offlineValues, args.bins, min, max);
    const onlineHist = computeHistogram(onlineValues, args.bins, min, max);
    const value = psi(offlineHist, onlineHist);
    const status = value > args.threshold ? 'breach' : 'ok';
    summaries.push({ field, psi: Number(value.toFixed(4)), status, min, max });
  }

  const breaches = summaries.filter((entry) => entry.status === 'breach');
  const output = {
    featureSet: args.featureSet,
    offlineSamples: offlineRecords.length,
    onlineSamples: onlineRecords.length,
    bins: args.bins,
    threshold: args.threshold,
    summaries,
  };

  console.log(JSON.stringify(output, null, 2));

  if (breaches.length > 0) {
    process.exitCode = 2;
  }
}

main().catch((error) => {
  console.error('[feature-skew] fatal error', error);
  process.exitCode = 1;
});
