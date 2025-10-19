#!/usr/bin/env node

/**
 * Triage pipeline micro-benchmark.
 *
 * Requires a built triage package (`npm run build --workspace @onecare/app-triage`)
 * so that dist artifacts are available.
 */

if (!process.env.LOG_LEVEL) {
  process.env.LOG_LEVEL = 'warn';
}

const { performance } = require('node:perf_hooks');
const { MemoryBus } = require('@onecare/bus');
const { InMemoryQueueNotifier } = require('@onecare/ports');
const { logger } = require('@onecare/observability');
const { runTriageMachine } = require('../dist/application/triage.machine.js');
const { resetDedupCache } = require('../dist/application/triage.state.js');

logger.info = () => undefined;
logger.debug = () => undefined;

function parseArgs() {
  const args = process.argv.slice(2);
  let iterations = 500;
  let warmup = 50;
  for (const arg of args) {
    if (arg.startsWith('--iterations=')) {
      const value = Number(arg.split('=')[1]);
      if (Number.isFinite(value) && value > 0) {
        iterations = Math.floor(value);
      }
    } else if (arg.startsWith('--warmup=')) {
      const value = Number(arg.split('=')[1]);
      if (Number.isFinite(value) && value >= 0) {
        warmup = Math.floor(value);
      }
    }
  }
  return { iterations, warmup };
}

function buildConfig() {
  return {
    practiceId: 'bench',
    triage: {
      score_weights: {
        acuity: 1,
        risk: 0.6,
        complexity: 0.4,
        time: 0.3,
        capacity: 0.2,
      },
    },
    priority_thresholds: {
      stat: 0.9,
      urgent: 0.7,
      soon: 0.4,
      routine: 0,
    },
  };
}

function createFhirRepository() {
  return {
    async upsertBundle(bundle) {
      return { ...bundle, id: `bundle-${Math.random().toString(36).slice(2, 8)}` };
    },
    async createTask() {
      return { id: `task-${Math.random().toString(36).slice(2, 8)}`, resourceType: 'Task' };
    },
    async createAppointment() {
      throw new Error('not_supported');
    },
    async createDocumentReference() {
      throw new Error('not_supported');
    },
  };
}

function buildContext(seed, shared) {
  const features = {
    acuity: 0.9 - (seed % 5) * 0.05,
    risk: 0.6 + (seed % 3) * 0.07,
    complexity: 0.35,
    time: 0.5,
    capacity: 0.25,
  };
  const patientId = `bench-patient-${seed}`;
  const narrative = `Bench iteration ${seed} with chest discomfort and mild dizziness.`;
  return {
    id: `bench-${seed}`,
    config: shared.config,
    features,
    rawFeatures: { ...features },
    patientId,
    narrative,
    triageInput: {
      patientId,
      narrative,
      features,
    },
    bus: shared.bus,
    fhirRepository: shared.fhir,
    queueNotifier: new InMemoryQueueNotifier(),
    idempotencyKey: `bench:${patientId}:${seed}`,
    idempotencyTtlSeconds: 10 * 60,
    now: Date.now(),
  };
}

function percentile(values, fraction) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor(fraction * (sorted.length - 1)));
  return sorted[index];
}

function summarize(durations, totalMs) {
  if (durations.length === 0) {
    return {
      count: 0,
      average: 0,
      p50: 0,
      p95: 0,
      p99: 0,
      max: 0,
      throughput: 0,
    };
  }
  const total = durations.reduce((sum, value) => sum + value, 0);
  return {
    count: durations.length,
    average: total / durations.length,
    p50: percentile(durations, 0.5),
    p95: percentile(durations, 0.95),
    p99: percentile(durations, 0.99),
    max: Math.max(...durations),
    throughput: (durations.length / totalMs) * 1_000,
  };
}

async function main() {
  const options = parseArgs();
  const config = buildConfig();
  const bus = new MemoryBus();
  const fhir = createFhirRepository();
  resetDedupCache();

  const durations = [];
  const warmIterations = Math.max(0, options.warmup);
  const totalIterations = warmIterations + options.iterations;

  const totalTimerStart = performance.now();
  for (let i = 0; i < totalIterations; i += 1) {
    const context = buildContext(i, { config, bus, fhir });
    const start = performance.now();
    await runTriageMachine(context);
    const elapsed = performance.now() - start;
    if (i >= warmIterations) {
      durations.push(elapsed);
    }
  }
  const totalDurationMs = performance.now() - totalTimerStart;
  const summary = summarize(durations, totalDurationMs);

  console.log(
    `[triage-bench] iterations=${summary.count} warmup=${warmIterations} avg=${summary.average.toFixed(
      3,
    )}ms p50=${summary.p50.toFixed(3)}ms p95=${summary.p95.toFixed(3)}ms p99=${summary.p99.toFixed(
      3,
    )}ms max=${summary.max.toFixed(3)}ms throughput=${summary.throughput.toFixed(1)}/s`,
  );
}

main().catch((error) => {
  console.error('[triage-bench] failed', error);
  process.exit(1);
});
