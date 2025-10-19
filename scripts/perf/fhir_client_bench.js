#!/usr/bin/env node

/**
 * Approximate microbench for FHIR bundle serialization and object upload staging.
 * Simulates the same JSON/Buffer work the HttpFhirRepository and HttpObjectStore perform
 * (stringify, content-length calculations) without requiring a live upstream.
 */

const { performance } = globalThis;

function percentile(values, fraction) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor(fraction * (sorted.length - 1)));
  return sorted[index];
}

function summarize(label, durations, totalMs) {
  if (durations.length === 0) {
    console.log(`[${label}] no samples recorded`);
    return;
  }
  const total = durations.reduce((sum, value) => sum + value, 0);
  const avg = total / durations.length;
  const throughput = (durations.length / totalMs) * 1_000;
  const p50 = percentile(durations, 0.5);
  const p95 = percentile(durations, 0.95);
  const p99 = percentile(durations, 0.99);
  const max = Math.max(...durations);
  console.log(
    `[%s] count=%d avg=%sms p50=%sms p95=%sms p99=%sms max=%sms throughput=%s/s`,
    label,
    durations.length,
    avg.toFixed(3),
    p50.toFixed(3),
    p95.toFixed(3),
    p99.toFixed(3),
    max.toFixed(3),
    throughput.toFixed(1),
  );
}

async function main() {
  const iterations = Number(process.env.BENCH_ITERATIONS ?? '10000');
  const bundle = {
    resourceType: 'Bundle',
    type: 'transaction',
    entry: Array.from({ length: 4 }, (_, i) => ({
      fullUrl: `urn:uuid:bench-${i}`,
      request: { method: 'POST', url: 'Task' },
      resource: {
        resourceType: 'Task',
        status: 'requested',
        priority: 'routine',
        authoredOn: new Date().toISOString(),
      },
    })),
  };
  const responsePayload = JSON.stringify({ resourceType: 'Bundle', type: 'transaction-response', entry: [] });
  const uploadBuffer = Buffer.alloc(256 * 1024, 'a');

  const fhirDurations = [];
  const fhirTotalStart = performance.now();
  for (let i = 0; i < iterations; i += 1) {
    const start = performance.now();
    const body = JSON.stringify(bundle);
    // Simulate minimal parse work on the response body as the client would perform.
    JSON.parse(responsePayload);
    fhirDurations.push(performance.now() - start);
    // Prevent V8 from optimising everything away.
    if (body.length === 0) throw new Error('unexpected length');
  }
  const fhirTotalDuration = performance.now() - fhirTotalStart;

  const objectDurations = [];
  const objectTotalStart = performance.now();
  for (let i = 0; i < iterations; i += 1) {
    const start = performance.now();
    // Simulate the PUT body preflight (Buffer copy + length maths)
    const clone = Buffer.from(uploadBuffer);
    objectDurations.push(performance.now() - start);
    if (clone.length !== uploadBuffer.length) throw new Error('size mismatch');
  }
  const objectTotalDuration = performance.now() - objectTotalStart;

  summarize('fhir.transaction', fhirDurations, fhirTotalDuration);
  summarize('object.put', objectDurations, objectTotalDuration);
}

main().catch((error) => {
  console.error('[fhir-client-bench] failed', error);
  process.exit(1);
});
