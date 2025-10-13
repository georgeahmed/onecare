#!/usr/bin/env node

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function main() {
  const summaryPath = path.resolve(process.env.TRIAGE_ALERT_SUMMARY_PATH ?? 'triage-alert-summary.json');
  const reportPath = path.resolve(process.env.TRIAGE_ALERT_REPORT_PATH ?? 'triage-alert-report.json');
  const sloMs = Number(process.env.TRIAGE_ALERT_P95_LIMIT_MS ?? '25');
  const processDelay = Number(process.env.TRIAGE_ALERT_DELAY_MS ?? '25');

  const env = {
    ...process.env,
    TRIAGE_FLOW_DURATION: process.env.TRIAGE_ALERT_DURATION ?? '10',
    TRIAGE_FLOW_RATE: process.env.TRIAGE_ALERT_RATE ?? '12',
    TRIAGE_FLOW_OUTPUT: 'json',
    TRIAGE_FLOW_OUTPUT_PATH: summaryPath,
    TRIAGE_FLOW_PROCESS_DELAY_MS: String(processDelay),
  };

  console.log('[triage-alert] running triage flow probe to generate summary');
  const run = spawnSync('node', ['scripts/perf/triage_flow.js'], {
    env,
    stdio: 'inherit',
  });

  if (run.error) {
    throw run.error;
  }
  if (run.status !== 0) {
    process.exit(run.status);
  }

  if (!fs.existsSync(summaryPath)) {
    throw new Error(`Expected triage summary at ${summaryPath}`);
  }

  const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
  const observedP95 = summary?.latencyMs?.p95 ?? null;
  const triggered = typeof observedP95 === 'number' && observedP95 > sloMs;

  const report = {
    timestamp: new Date().toISOString(),
    thresholdMs: sloMs,
    observedP95Ms: observedP95,
    triggered,
    parameters: {
      durationSeconds: Number(env.TRIAGE_FLOW_DURATION ?? 0),
      ratePerSecond: Number(env.TRIAGE_FLOW_RATE ?? 0),
      processDelayMs: processDelay,
    },
    summary,
  };

  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`[triage-alert] report written to ${reportPath}`);

  if (!triggered) {
    console.error(`triage p95 ${observedP95}ms did not exceed threshold ${sloMs}ms`);
    process.exit(1);
  }

  console.log(`[triage-alert] Alert condition satisfied (p95 ${observedP95}ms > ${sloMs}ms)`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error('[triage-alert] failure:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
