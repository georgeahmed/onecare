#!/usr/bin/env node

/**
 * Triage flow load probe
 *
 * Publishes triage.input envelopes onto a memory bus, drives the triage state machine,
 * and measures the time until the corresponding tasks.created envelope is observed.
 */

const { performance } = require('node:perf_hooks');
const { MemoryBus } = require('@onecare/bus');
const { Topics, createEnvelope } = require('@onecare/events');
const {
  IntakeState,
  ScoredState,
  TaskCreatedState,
  NotifiedState,
  CompletedState,
  DuplicateState,
  resetDedupCache,
} = require('../../apps/triage/dist/application/triage.state.js');

const DEFAULT_DURATION_SECONDS = 60;
const DEFAULT_RATE_PER_SECOND = 20;
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_BATCH_SLEEP_MS = 1000;

const durationSeconds = Number(process.env.TRIAGE_FLOW_DURATION ?? DEFAULT_DURATION_SECONDS);
const ratePerSecond = Number(process.env.TRIAGE_FLOW_RATE ?? DEFAULT_RATE_PER_SECOND);
const timeoutMs = Number(process.env.TRIAGE_FLOW_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
const batchSleepMs = Number(process.env.TRIAGE_FLOW_BATCH_SLEEP_MS ?? DEFAULT_BATCH_SLEEP_MS);
const practiceId = process.env.TRIAGE_FLOW_PRACTICE_ID ?? 'demo';
const taskOwner = process.env.TRIAGE_FLOW_TASK_OWNER ?? 'Organization/demo-triage';

if (Number.isNaN(durationSeconds) || durationSeconds <= 0) {
  console.error('Duration must be a positive number of seconds');
  process.exit(1);
}
if (Number.isNaN(ratePerSecond) || ratePerSecond <= 0) {
  console.error('Rate must be a positive number (messages per second)');
  process.exit(1);
}

const config = {
  practiceId,
  triage: {
    score_weights: {
      acuity: 0.6,
      risk: 0.3,
      complexity: 0.05,
      time: 0.05,
    },
  },
  priority_thresholds: {
    stat: 0.92,
    urgent: 0.7,
    soon: 0.4,
    routine: 0,
  },
};

const fhirRepository = {
  async upsertBundle(bundle) {
    return { ...bundle, id: `bundle-${createId('bundle')}` };
  },
  async createTask(task) {
    return {
      id: createId('task'),
      resourceType: 'Task',
      task,
    };
  },
  async createAppointment(appt) {
    return {
      id: createId('appt'),
      resourceType: 'Appointment',
      appointment: appt,
    };
  },
  async createDocumentReference(doc) {
    return {
      id: createId('doc'),
      resourceType: 'DocumentReference',
      document: doc,
    };
  },
};

const queueNotifier = {
  async notify(queue, payload) {
    return { queue, payload };
  },
};

const states = {
  Intake: new IntakeState(),
  Scored: new ScoredState(),
  TaskCreated: new TaskCreatedState(),
  Notified: new NotifiedState(),
  Completed: new CompletedState(),
  Duplicate: new DuplicateState(),
};

const bus = new MemoryBus();
const inflight = new Map();
const latencies = [];
const metrics = {
  total: 0,
  success: 0,
  failures: 0,
  duplicate: 0,
};

const conveyors = {
  async processEnvelope(envelope) {
    const payload = envelope.payload;
    const baseCtx = {
      id: envelope.id,
      config,
      features: deriveFeatures(payload),
      patientId: payload.patientId,
      narrative: payload.narrative,
      correlationId: envelope.correlationId,
      bus,
      fhirRepository,
      queueNotifier,
      taskOwner,
      now: Date.now(),
    };

    let current = 'Intake';
    const event = { type: 'triage.evaluate' };

    while (true) {
      switch (current) {
        case 'Intake':
          current = await states.Intake.handle(baseCtx, event);
          break;
        case 'Scored':
          current = await states.Scored.handle(baseCtx, event);
          break;
        case 'TaskCreated':
          current = await states.TaskCreated.handle(baseCtx, event);
          break;
        case 'Notified':
          current = await states.Notified.handle(baseCtx, event);
          break;
        case 'Duplicate':
          metrics.duplicate += 1;
          current = await states.Duplicate.handle(baseCtx, event);
          break;
        case 'Completed':
          return;
        default:
          throw new Error(`Unknown state transition: ${current}`);
      }
    }
  },
};

bus.subscribe(Topics.triage.input, async (message) => {
  const envelope = message.payload;
  const correlationId = envelope?.correlationId;
  try {
    await conveyors.processEnvelope(envelope);
  } catch (error) {
    console.error('triage processing error', {
      correlationId,
      error: error instanceof Error ? error.message : String(error),
    });
    settleFailure(correlationId);
  }
});

bus.subscribe(Topics.tasks.created, (message) => {
  const envelope = message.payload;
  const correlationId = envelope?.correlationId;
  settleSuccess(correlationId);
});

async function main() {
  resetDedupCache();
  const batchesPerSecond = Math.max(1, Math.floor(1000 / batchSleepMs));
  const perBatch = Math.max(1, Math.round(ratePerSecond / batchesPerSecond));

  console.log(
    `[triage-flow] duration=${durationSeconds}s rate≈${ratePerSecond} req/s timeout=${timeoutMs}ms practice=${practiceId}`,
  );

  const start = performance.now();
  const endTime = start + durationSeconds * 1000;

  while (performance.now() < endTime) {
    const publishPromises = [];
    for (let i = 0; i < perBatch; i += 1) {
      publishPromises.push(publishTriageInput());
    }
    await Promise.all(publishPromises);
    await sleep(batchSleepMs);
  }

  await waitForInflightSettled(timeoutMs);
  const totalTimeSeconds = (performance.now() - start) / 1000;

  const summary = buildSummary(totalTimeSeconds);
  printSummary(summary);

  if (process.env.TRIAGE_FLOW_OUTPUT === 'json') {
    console.log(JSON.stringify(summary, null, 2));
  }
}

async function publishTriageInput() {
  const correlationId = createId('corr');
  const patientId = `patient-${Math.floor(Math.random() * 10_000)}`;
  const narrative = sampleNarrative();

  const payload = {
    patientId,
    narrative,
  };

  const envelope = createEnvelope(Topics.triage.input, payload, correlationId);
  trackRequest(correlationId);
  metrics.total += 1;
  const headers = correlationId ? { 'x-correlation-id': correlationId } : undefined;
  await bus.publish(envelope.topic, envelope, headers);
}

function deriveFeatures(payload) {
  const text = String(payload.narrative ?? '');
  const lengthScore = Math.min(1, text.length / 240);
  const painBoost = /pain|emergency|severe/i.test(text) ? 0.2 : 0;
  const acuity = Math.min(1, 0.5 + lengthScore + painBoost);
  const risk = Math.min(1, 0.3 + lengthScore * 0.5 + painBoost);
  const complexity = 0.2 + Math.random() * 0.2;
  const time = 0.3 + Math.random() * 0.1;

  return {
    acuity,
    risk,
    complexity,
    time,
  };
}

function sampleNarrative() {
  const options = [
    'Patient reports persistent chest discomfort and shortness of breath.',
    'Mild headache continuing for several days, no other symptoms.',
    'Parent notes high fever and lethargy lasting 24 hours.',
    'Pain in lower back with limited mobility, no recent injury.',
    'Severe abdominal cramps accompanied by nausea.',
    'Dizziness episodes when standing quickly.',
    'Shortness of breath during light exercise.',
    'Skin rash spreading across arms with mild itching.',
  ];
  return options[Math.floor(Math.random() * options.length)];
}

function trackRequest(correlationId) {
  const record = {
    start: performance.now(),
    settled: false,
    timeout: null,
  };
  record.timeout = setTimeout(() => {
    if (record.settled) return;
    record.settled = true;
    metrics.failures += 1;
    inflight.delete(correlationId);
  }, timeoutMs);
  inflight.set(correlationId, record);
}

function settleSuccess(correlationId) {
  if (!correlationId) return;
  const record = inflight.get(correlationId);
  if (!record || record.settled) {
    return;
  }
  record.settled = true;
  clearTimeout(record.timeout);
  const latency = performance.now() - record.start;
  latencies.push(latency);
  metrics.success += 1;
  inflight.delete(correlationId);
}

function settleFailure(correlationId) {
  if (!correlationId) return;
  const record = inflight.get(correlationId);
  if (!record || record.settled) {
    return;
  }
  record.settled = true;
  clearTimeout(record.timeout);
  metrics.failures += 1;
  inflight.delete(correlationId);
}

async function waitForInflightSettled(maxWaitMs) {
  const start = performance.now();
  while (inflight.size > 0 && performance.now() - start < maxWaitMs) {
    await sleep(25);
  }
  for (const [corrId, record] of inflight.entries()) {
    if (!record.settled) {
      settleFailure(corrId);
    }
  }
}

function buildSummary(durationSeconds) {
  const sorted = [...latencies].sort((a, b) => a - b);
  const percentile = (p) => {
    if (sorted.length === 0) return 0;
    const rank = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
    return sorted[rank];
  };

  const mean =
    sorted.length === 0 ? 0 : sorted.reduce((acc, value) => acc + value, 0) / sorted.length;

  return {
    totalRequests: metrics.total,
    successes: metrics.success,
    failures: metrics.failures,
    duplicateDetected: metrics.duplicate,
    durationSeconds,
    throughputPerSecond: durationSeconds > 0 ? metrics.success / durationSeconds : 0,
    latencyMs: {
      count: sorted.length,
      average: mean,
      p50: percentile(50),
      p90: percentile(90),
      p95: percentile(95),
      p99: percentile(99),
      max: sorted.length === 0 ? 0 : sorted[sorted.length - 1],
    },
  };
}

function printSummary(summary) {
  console.log('');
  console.log('=== triage flow load summary ===');
  console.log(`Requests        : ${summary.totalRequests}`);
  console.log(`Successes       : ${summary.successes}`);
  console.log(`Failures        : ${summary.failures}`);
  console.log(`Duplicates      : ${summary.duplicateDetected}`);
  console.log(`Duration (s)    : ${summary.durationSeconds.toFixed(2)}`);
  console.log(`Throughput (rps): ${summary.throughputPerSecond.toFixed(2)}`);
  if (summary.latencyMs.count > 0) {
    console.log('Latency (ms)');
    console.log(`  count : ${summary.latencyMs.count}`);
    console.log(`  avg   : ${summary.latencyMs.average.toFixed(2)}`);
    console.log(`  p50   : ${summary.latencyMs.p50.toFixed(2)}`);
    console.log(`  p90   : ${summary.latencyMs.p90.toFixed(2)}`);
    console.log(`  p95   : ${summary.latencyMs.p95.toFixed(2)}`);
    console.log(`  p99   : ${summary.latencyMs.p99.toFixed(2)}`);
    console.log(`  max   : ${summary.latencyMs.max.toFixed(2)}`);
  } else {
    console.log('No successful task completions recorded.');
  }
}

function createId(prefix) {
  const rand = Math.random().toString(16).slice(2, 8);
  return `${prefix}-${Date.now()}-${rand}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[triage-flow] load probe failed', error);
    process.exit(1);
  });
}
