#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const fsPromises = fs.promises;
const path = require('node:path');
const readline = require('node:readline');
const { logger, createCounter, createHistogram } = require('@onecare/observability');

const DEFAULT_INPUT = process.env.FEATURE_VIEW_INPUT || 'var/features/triage-core.jsonl';
const DEFAULT_OUTPUT = process.env.FEATURE_VIEW_OUTPUT || 'var/features/feature-views.jsonl';
const DEFAULT_AS_OF = process.env.FEATURE_VIEW_AS_OF || null;
const DEFAULT_VIEW = process.env.FEATURE_VIEW_NAME || 'triage-core.sliding-windows';
const DEFAULT_ONLINE_TTL = Number(process.env.FEATURE_VIEW_ONLINE_TTL_SECONDS || '3600');

const viewRunCounter = createCounter('feature.views.run');
const viewDurationHistogram = createHistogram('feature.views.duration_ms');

function loadOfflineModules() {
  try {
    // eslint-disable-next-line global-require, import/no-dynamic-require
    const layout = require('../../packages/feature-store-offline/dist/layout.js');
    // eslint-disable-next-line global-require, import/no-dynamic-require
    const views = require('../../packages/feature-store-offline/dist/views.js');
    return { layout, views };
  } catch (error) {
    logger.error(
      'feature-view materialiser missing build artefacts. Run `npx tsc -p packages/feature-store-offline/tsconfig.json`.',
      { error: error instanceof Error ? error.message : error }
    );
    throw error;
  }
}

function loadOnlineModule(moduleName) {
  const candidates = moduleName
    ? [moduleName]
    : ['@onecare/feature-store-online', '../../packages/feature-store-online/dist'];
  for (const candidate of candidates) {
    try {
      // eslint-disable-next-line global-require, import/no-dynamic-require
      return require(candidate);
    } catch (error) {
      if (candidate === candidates[candidates.length - 1]) {
        logger.error('feature-view materialiser could not load online feature store module', {
          module: moduleName ?? '@onecare/feature-store-online',
          error: error instanceof Error ? error.message : error,
        });
        throw error;
      }
    }
  }
  return null;
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
    } else if ((token === '--output' || token === '-o') && next) {
      args.output = next;
      i += 1;
    } else if ((token === '--view' || token === '-v') && next) {
      args.view = next;
      i += 1;
    } else if ((token === '--as-of' || token === '-a') && next) {
      args.asOf = next;
      i += 1;
    } else if (token === '--dry-run') {
      args.dryRun = true;
    } else if ((token === '--online-module' || token === '-m') && next) {
      args.onlineModule = next;
      i += 1;
    } else if (token === '--online') {
      args.online = true;
    } else if ((token === '--online-ttl' || token === '-t') && next) {
      args.onlineTtlSeconds = Number(next);
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

async function readSnapshots(inputPath) {
  const exists = await fileExists(inputPath);
  if (!exists) {
    logger.info('feature-view materialiser input file not found', { inputPath });
    return [];
  }

  const stream = fs.createReadStream(inputPath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const snapshots = [];

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      snapshots.push(parsed);
    } catch (err) {
      logger.warn('feature-view materialiser failed to parse line', {
        line: trimmed.slice(0, 120),
        error: err instanceof Error ? err.message : err,
      });
    }
  }

  return snapshots;
}

function materialise(viewName, snapshots, asOf, viewsModule) {
  if (viewName === 'all') {
    return viewsModule.materializeAllFeatureViews({ snapshots, asOf });
  }
  const materialised = viewsModule.materializeFeatureView(viewName, { snapshots, asOf });
  return { [viewName]: materialised };
}

async function writeOutputs(recordsByView, outputPath, dryRun) {
  if (dryRun) {
    return;
  }
  await fsPromises.mkdir(path.dirname(outputPath), { recursive: true });
  const existing = new Map();
  if (await fileExists(outputPath)) {
    const content = await fsPromises.readFile(outputPath, 'utf8');
    const lines = content
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        const key = `${parsed.featureSet}::${parsed.entityId}::${parsed.generatedAt}`;
        existing.set(key, parsed);
      } catch (err) {
        logger.warn('feature-view materialiser failed to parse existing output line', {
          error: err instanceof Error ? err.message : err,
        });
      }
    }
  }

  for (const list of Object.values(recordsByView)) {
    for (const snapshot of list) {
      const key = `${snapshot.featureSet}::${snapshot.entityId}::${snapshot.generatedAt}`;
      existing.set(key, snapshot);
    }
  }

  const ordered = Array.from(existing.values()).sort((a, b) => {
    if (a.featureSet === b.featureSet) {
      if (a.entityId === b.entityId) {
        return a.generatedAt.localeCompare(b.generatedAt);
      }
      return a.entityId.localeCompare(b.entityId);
    }
    return a.featureSet.localeCompare(b.featureSet);
  });

  const lines = ordered.map((record) => JSON.stringify(record));
  await fsPromises.writeFile(outputPath, `${lines.join('\n')}\n`, 'utf8');
}

function summarise(recordsByView, outputRoot, layoutModule) {
  const summaries = [];
  for (const [viewName, snapshots] of Object.entries(recordsByView)) {
    for (const snapshot of snapshots) {
      const plan = layoutModule.planPartition(outputRoot, snapshot, { fileExtension: 'parquet' });
      summaries.push({
        viewName,
        entityId: snapshot.entityId,
        featureSet: snapshot.featureSet,
        filePath: plan.filePath,
        windowCounts: snapshot.payload?.counts,
      });
    }
  }
  return summaries;
}

async function upsertOnline(recordsByView, options) {
  const { moduleName, ttlSeconds } = options;
  const normalisedTtl = typeof ttlSeconds === 'number' && Number.isFinite(ttlSeconds) && ttlSeconds > 0 ? ttlSeconds : undefined;
  const onlineModule = loadOnlineModule(moduleName);
  if (!onlineModule || typeof onlineModule.InMemoryOnlineFeatureStore !== 'function') {
    logger.error('feature-view materialiser online store missing InMemoryOnlineFeatureStore export', {
      moduleName: moduleName ?? '@onecare/feature-store-online',
    });
    return;
  }
  const store = new onlineModule.InMemoryOnlineFeatureStore();
  const records = [];
  for (const snapshots of Object.values(recordsByView)) {
    for (const snapshot of snapshots) {
    records.push({
      featureSet: snapshot.featureSet,
      entityId: snapshot.entityId,
      payload: snapshot.payload,
      asOf: snapshot.generatedAt,
      ttlSeconds: normalisedTtl,
      correlationId: snapshot.metadata?.correlationId,
      metadata: snapshot.metadata,
    });
  }
  }
  if (store.batchUpsert && typeof store.batchUpsert === 'function') {
    await store.batchUpsert(records);
  } else {
    // eslint-disable-next-line no-restricted-syntax
    for (const record of records) {
      // eslint-disable-next-line no-await-in-loop
      await store.upsert(record);
    }
  }
  logger.info('feature-view materialiser upserted records to online store', {
    moduleName: moduleName ?? '@onecare/feature-store-online',
    count: records.length,
    ttlSeconds: normalisedTtl,
  });
}

async function run(argv = process.argv.slice(2)) {
  const startedAt = Date.now();
  const modules = loadOfflineModules();
  const { input, output, view, asOf, dryRun, online, onlineModule, onlineTtlSeconds } = parseArgs(argv);
  const inputPath = path.resolve(input || DEFAULT_INPUT);
  const outputPath = path.resolve(output || DEFAULT_OUTPUT);
  const viewName = view || DEFAULT_VIEW;
  const asOfTimestamp = asOf || DEFAULT_AS_OF || undefined;
  const onlineTtl = Number.isFinite(onlineTtlSeconds) ? Number(onlineTtlSeconds) : DEFAULT_ONLINE_TTL;

  logger.info('feature-view materialiser starting', {
    inputPath,
    outputPath,
    view: viewName,
    asOf: asOfTimestamp,
    dryRun: Boolean(dryRun),
    online: Boolean(online),
    onlineModule: onlineModule ?? '@onecare/feature-store-online',
  });
  const snapshots = await readSnapshots(inputPath);
  if (!snapshots.length) {
    logger.info('feature-view materialiser exiting (no snapshots)');
    return;
  }

  const records = materialise(viewName, snapshots, asOfTimestamp, modules.views);
  if (!dryRun) {
    await writeOutputs(records, outputPath, false);
  }
  if (online) {
    await upsertOnline(records, { moduleName: onlineModule, ttlSeconds: onlineTtl });
  }

  const durationMs = Date.now() - startedAt;
  viewRunCounter.add(1, { view: viewName });
  viewDurationHistogram.record(durationMs, { view: viewName });

  logger.info('feature-view materialiser completed', {
    view: viewName,
    durationMs,
    materialised: Object.fromEntries(Object.entries(records).map(([name, rows]) => [name, rows.length])),
  });

  if (process.env.FEATURE_VIEW_PARTITION_ROOT) {
    const summaries = summarise(
      records,
      path.resolve(process.env.FEATURE_VIEW_PARTITION_ROOT),
      modules.layout
    );
    for (const summary of summaries) {
      logger.info('feature-view materialiser partition plan', summary);
    }
  }
}

if (require.main === module) {
  run().catch((err) => {
    logger.error('feature-view materialiser fatal error', {
      error: err instanceof Error ? err.message : err,
    });
    process.exitCode = 1;
  });
}

module.exports = {
  parseArgs,
  readSnapshots,
  materialise,
  writeOutputs,
  summarise,
  upsertOnline,
  run,
};
