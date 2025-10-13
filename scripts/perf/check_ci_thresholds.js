#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

function readSummary(envVar, defaultName) {
  const target = process.env[envVar] ?? defaultName;
  const resolved = path.resolve(target);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Summary file not found: ${resolved}`);
  }
  return JSON.parse(fs.readFileSync(resolved, 'utf8'));
}

function ensure(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function formatMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value.toFixed(2);
  }
  return String(value);
}

function checkTriage(summary) {
  const minThroughput = Number(process.env.TRIAGE_MIN_THROUGHPUT ?? 3);
  const maxP95 = Number(process.env.TRIAGE_MAX_P95_MS ?? 10);
  ensure(summary.successes === summary.totalRequests, `triage: expected all requests to succeed (got ${summary.successes}/${summary.totalRequests})`);
  ensure(summary.throughputPerSecond >= minThroughput, `triage: throughput ${summary.throughputPerSecond.toFixed(2)} < ${minThroughput}`);
  ensure(summary.latencyMs?.p95 <= maxP95, `triage: p95 latency ${formatMs(summary.latencyMs?.p95)}ms > ${maxP95}ms`);
}

function checkBooking(summary) {
  const minThroughput = Number(process.env.BOOKING_MIN_THROUGHPUT ?? 4);
  const maxP95 = Number(process.env.BOOKING_MAX_P95_MS ?? 350);
  const maxFailureRatio = Number(process.env.BOOKING_MAX_FAILURE_RATIO ?? 0.05);
  const failureRatio = summary.totalRequests > 0 ? summary.failures / summary.totalRequests : 0;
  ensure(summary.successes > 0, 'booking: no successful bookings recorded');
  ensure(summary.throughputPerSecond >= minThroughput, `booking: throughput ${summary.throughputPerSecond.toFixed(2)} < ${minThroughput}`);
  ensure(summary.latencyMs?.p95 <= maxP95, `booking: p95 latency ${formatMs(summary.latencyMs?.p95)}ms > ${maxP95}ms`);
  ensure(failureRatio <= maxFailureRatio, `booking: failure ratio ${(failureRatio * 100).toFixed(2)}% exceeds ${(maxFailureRatio * 100).toFixed(2)}%`);
}

function checkTelephony(summary) {
  const minThroughput = Number(process.env.TELEPHONY_MIN_THROUGHPUT ?? 1000);
  ensure(summary.successes === summary.totalCalls, `telephony: expected all calls to succeed (got ${summary.successes}/${summary.totalCalls})`);
  ensure(summary.throughputPerSecond >= minThroughput, `telephony: throughput ${summary.throughputPerSecond.toFixed(2)} < ${minThroughput}`);
  const stageFailures = summary.stageFailures ?? {};
  ensure((stageFailures.ingest ?? 0) === 0, `telephony: ingest failures detected (${stageFailures.ingest})`);
  ensure((stageFailures.asr ?? 0) === 0, `telephony: ASR failures detected (${stageFailures.asr})`);
  ensure((stageFailures.classify ?? 0) === 0, `telephony: classify failures detected (${stageFailures.classify})`);
}

function main() {
  const triageSummary = readSummary('TRIAGE_FLOW_OUTPUT_PATH', 'triage-summary.json');
  const bookingSummary = readSummary('BOOKING_FLOW_OUTPUT_PATH', 'booking-summary.json');
  const telephonySummary = readSummary('TELEPHONY_PARITY_OUTPUT_PATH', 'telephony-summary.json');

  const failures = [];
  try {
    checkTriage(triageSummary);
  } catch (error) {
    failures.push(error.message);
  }
  try {
    checkBooking(bookingSummary);
  } catch (error) {
    failures.push(error.message);
  }
  try {
    checkTelephony(telephonySummary);
  } catch (error) {
    failures.push(error.message);
  }

  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(`[perf-threshold] ${failure}`);
    }
    process.exit(1);
  }

  console.log('[perf-threshold] All performance thresholds satisfied.');
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`[perf-threshold] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
