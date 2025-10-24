#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const fsPromises = fs.promises;
const path = require('node:path');
const { execSync } = require('node:child_process');
const { logger } = require('@onecare/observability');

const DEFAULT_NAMESPACE = 'onecare.analytics';
const DEFAULT_PRODUCER = 'onecare.analytics.scripts';

let cachedCommit = null;

function resolveGitCommit() {
  if (cachedCommit) return cachedCommit;
  try {
    const commit = execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
    cachedCommit = commit || 'unknown';
  } catch {
    cachedCommit = 'unknown';
  }
  return cachedCommit;
}

function normaliseIo(items = []) {
  if (!Array.isArray(items)) return [];
  return items
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return null;
      const name = typeof entry.name === 'string' && entry.name ? entry.name : null;
      const uri = typeof entry.uri === 'string' && entry.uri ? entry.uri : null;
      if (!name && !uri) return null;
      return {
        namespace:
          typeof entry.namespace === 'string' && entry.namespace.length > 0
            ? entry.namespace
            : DEFAULT_NAMESPACE,
        name: name ?? uri,
        uri,
        type: entry.type ?? 'dataset',
        facets: entry.facets ?? undefined,
      };
    })
    .filter((entry) => entry !== null);
}

async function appendLineageEvent(event, lineagePath) {
  if (!lineagePath) return;
  try {
    await fsPromises.mkdir(path.dirname(lineagePath), { recursive: true });
    await fsPromises.appendFile(lineagePath, `${JSON.stringify(event)}\n`, 'utf8');
  } catch (err) {
    logger.warn('analytics-lineage failed to append event', {
      lineagePath,
      error: err instanceof Error ? err.message : err,
    });
  }
}

function createLineageEmitter(context) {
  const {
    jobName,
    runId,
    jobNamespace = DEFAULT_NAMESPACE,
    producer = DEFAULT_PRODUCER,
    inputs = [],
    outputs = [],
    dataset = {},
    lineagePath,
    gitCommit,
  } = context;

  if (!jobName || !runId) {
    throw new Error('createLineageEmitter requires jobName and runId');
  }

  const resolvedInputs = normaliseIo(inputs);
  const resolvedOutputs = normaliseIo(outputs);
  const commit = gitCommit || resolveGitCommit();
  const filePath =
    lineagePath ||
    process.env.ANALYTICS_LINEAGE_LOG ||
    path.join('var', 'analytics', 'lineage', `${jobName.replace(/[:/]/g, '_')}.jsonl`);

  const base = {
    job: {
      namespace: jobNamespace,
      name: jobName,
    },
    run: {
      runId,
    },
    producer,
    inputs: resolvedInputs,
    outputs: resolvedOutputs,
    dataset,
    git: {
      commit,
    },
  };

  async function emit(eventType, payload = {}) {
    const event = {
      ...base,
      eventType,
      eventTime: new Date().toISOString(),
      ...payload,
    };
    await appendLineageEvent(event, filePath);
  }

  return {
    emitStart(attributes = {}) {
      return emit('START', {
        status: 'RUNNING',
        attributes,
      });
    },
    emitComplete(status = 'COMPLETED', result = {}) {
      return emit('COMPLETE', {
        status,
        result,
      });
    },
    emitFailure(error, result = {}) {
      const message = error instanceof Error ? error.message : String(error);
      return emit('FAIL', {
        status: 'FAILED',
        error: {
          message,
        },
        result,
      });
    },
    lineagePath: filePath,
    gitCommit: commit,
  };
}

module.exports = {
  createLineageEmitter,
  appendLineageEvent,
  normaliseIo,
  resolveGitCommit,
};
