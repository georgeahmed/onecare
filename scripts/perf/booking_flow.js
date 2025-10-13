#!/usr/bin/env node

/**
 * Booking flow load probe
 *
 * Simulates booking slot search + appointment creation using the booking state machine,
 * measuring throughput, latency, and conflict handling under load with a stubbed GP Connect client.
 */

const { performance } = require('node:perf_hooks');
const { MemoryBus } = require('@onecare/bus');
const { Topics } = require('@onecare/events');
const {
  SearchState,
  SelectedState,
  BookedState,
  WrittenBackState,
  ConfirmedState,
} = require('../../apps/booking/dist/application/booking.state.js');
const { GpConnectHttpClient } = require('../../apps/booking/dist/adapters/gpconnect.client.js');

const DEFAULT_DURATION_SECONDS = 60;
const DEFAULT_RATE_PER_SECOND = 15;
const DEFAULT_CONFLICT_RATE = 0.1;
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_BATCH_SLEEP_MS = 1000;

const durationSeconds = sanitizePositiveNumber(process.env.BOOKING_FLOW_DURATION ?? DEFAULT_DURATION_SECONDS);
const ratePerSecond = sanitizePositiveNumber(process.env.BOOKING_FLOW_RATE ?? DEFAULT_RATE_PER_SECOND);
const conflictRate = clampProbability(process.env.BOOKING_FLOW_CONFLICT_RATE ?? DEFAULT_CONFLICT_RATE);
const timeoutMs = sanitizePositiveNumber(process.env.BOOKING_FLOW_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
const batchSleepMs = sanitizePositiveNumber(process.env.BOOKING_FLOW_BATCH_SLEEP_MS ?? DEFAULT_BATCH_SLEEP_MS);

const practiceId = process.env.BOOKING_FLOW_PRACTICE_ID ?? 'demo';
const serviceType = process.env.BOOKING_FLOW_SERVICE_TYPE ?? 'GP';
const organisationId = process.env.BOOKING_FLOW_ORG ?? 'org.demo';

if (!durationSeconds || !ratePerSecond || !timeoutMs || !batchSleepMs) {
  console.error('Duration, rate, timeout, and batch sleep must be positive numbers');
  process.exit(1);
}

const bus = new MemoryBus();

const auditPublisher = {
  async emit() {
    /** no-op */
  },
};

const queueNotifier = {
  async notify() {
    /** no-op */
  },
};

const fhirRepository = {
  async upsertBundle(bundle) {
    return { ...bundle, id: createId('bundle') };
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
  async updateTask() {
    /** no-op */
  },
};

let conflictCounter = 0;
let retryCounter = 0;

const gpClient = new GpConnectHttpClient({
  baseUrl: 'https://gp-connect.example',
  apiKey: 'load-probe',
  appointmentExecutor: async (request) => {
    retryCounter += 1;
    if (Math.random() < conflictRate) {
      conflictCounter += 1;
      const error = new Error('conflict');
      error.status = 409;
      throw error;
    }
    return {
      appointmentId: createId('appt'),
      slotId: request.slotId,
      start: request.start ?? new Date().toISOString(),
      end: request.end ?? new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    };
  },
});

const slots = [
  {
    slotId: 'slot-100',
    start: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    end: new Date(Date.now() + 45 * 60 * 1000).toISOString(),
    organisationId,
    serviceType,
  },
];

const states = {
  Search: new SearchState(),
  Selected: new SelectedState(),
  Booked: new BookedState(),
  WrittenBack: new WrittenBackState(),
  Confirmed: new ConfirmedState(),
};

const metrics = {
  total: 0,
  success: 0,
  failures: 0,
  conflicts: 0,
};

const latencies = [];

async function main() {
  const batchesPerSecond = Math.max(1, Math.floor(1000 / batchSleepMs));
  const perBatch = Math.max(1, Math.round(ratePerSecond / batchesPerSecond));

  console.log(
    `[booking-flow] duration=${durationSeconds}s rate≈${ratePerSecond} req/s conflictRate=${conflictRate} timeout=${timeoutMs}ms`,
  );

  const start = performance.now();
  const endTime = start + durationSeconds * 1000;

  while (performance.now() < endTime) {
    const publishPromises = [];
    for (let i = 0; i < perBatch; i += 1) {
      publishPromises.push(runBookingFlow());
    }
    await Promise.all(publishPromises);
    await sleep(batchSleepMs);
  }

  const elapsedSeconds = (performance.now() - start) / 1000;
  const summary = buildSummary(elapsedSeconds);
  printSummary(summary);
  persistSummary(summary, process.env.BOOKING_FLOW_OUTPUT, process.env.BOOKING_FLOW_OUTPUT_PATH);
}

async function runBookingFlow() {
  metrics.total += 1;

  const correlationId = createId('corr');
  const patientId = `patient-${Math.floor(Math.random() * 10_000)}`;

  const ctx = {
    id: createId('booking'),
    client: gpClient,
    correlationId,
    bus,
    fhirRepository,
    queueNotifier,
    auditPublisher,
    queueName: 'booking.notifications',
    patientId,
    narrative: 'Load probe booking request',
    searchParams: {
      serviceType,
      windowStart: new Date().toISOString(),
      windowEnd: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(),
      location: organisationId,
    },
    config: {
      practiceId,
      triage: { score_weights: { acuity: 1 } },
    },
  };

  let selectedSlotId = slots[0]?.slotId;
  const start = performance.now();

  try {
    const current = await states.Search.handle(ctx, { type: 'booking.search' });
    if (current !== 'Selected') throw new Error(`Unexpected state ${current} after search`);

    if (ctx.slots && ctx.slots.length > 0) {
      selectedSlotId = ctx.slots[0].id;
    }

    const afterSelect = await states.Selected.handle(ctx, {
      type: 'booking.select',
      payload: { slotId: selectedSlotId },
    });
    if (afterSelect !== 'Booked') throw new Error(`Unexpected state ${afterSelect} after select`);

    const afterBook = await states.Booked.handle(ctx, { type: 'booking.book' });
    if (afterBook !== 'WrittenBack') throw new Error(`Unexpected state ${afterBook} after book`);

    const afterWritten = await states.WrittenBack.handle(ctx, { type: 'booking.book' });
    if (afterWritten !== 'Confirmed') throw new Error(`Unexpected state ${afterWritten} after written`);

    await states.Confirmed.handle(ctx, { type: 'booking.book' });

    const latency = performance.now() - start;
    latencies.push(latency);
    metrics.success += 1;
  } catch (error) {
    metrics.failures += 1;
    console.error('[booking-flow] scenario failed', {
      correlationId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function buildSummary(durationSeconds) {
  const sorted = [...latencies].sort((a, b) => a - b);
  const percentile = (p) => {
    if (sorted.length === 0) return 0;
    const rank = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
    return sorted[rank];
  };
  const average = sorted.length === 0 ? 0 : sorted.reduce((acc, val) => acc + val, 0) / sorted.length;

  return {
    totalRequests: metrics.total,
    successes: metrics.success,
    failures: metrics.failures,
    conflicts: conflictCounter,
    retries: retryCounter,
    durationSeconds,
    throughputPerSecond: durationSeconds > 0 ? metrics.success / durationSeconds : 0,
    latencyMs: {
      count: sorted.length,
      average,
      p50: percentile(50),
      p90: percentile(90),
      p95: percentile(95),
      p99: percentile(99),
      max: sorted.length === 0 ? 0 : sorted[sorted.length - 1],
    },
  };
}

function persistSummary(summary, mode, outputPath) {
  if (mode === 'json' || typeof outputPath === 'string') {
    if (typeof outputPath === 'string' && outputPath.trim().length > 0) {
      const path = outputPath.trim();
      require('node:fs').writeFileSync(path, JSON.stringify(summary, null, 2));
    }
  }
  if (mode === 'json') {
    console.log(JSON.stringify(summary, null, 2));
  }
}

function printSummary(summary) {
  console.log('');
  console.log('=== booking flow load summary ===');
  console.log(`Requests        : ${summary.totalRequests}`);
  console.log(`Successes       : ${summary.successes}`);
  console.log(`Failures        : ${summary.failures}`);
  console.log(`Conflicts       : ${summary.conflicts}`);
  console.log(`Retries (attempts): ${summary.retries}`);
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
    console.log('No successful bookings recorded.');
  }
}

function sanitizePositiveNumber(raw) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return null;
  return value;
}

function clampProbability(raw) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return 0;
  if (value > 1) return 1;
  return value;
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
    console.error('[booking-flow] load probe failed', error);
    process.exit(1);
  });
}
