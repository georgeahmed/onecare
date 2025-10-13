#!/usr/bin/env node
/*
 Real codegen script
 - Generates TypeScript contracts from JSON Schemas using json-schema-to-typescript (json2ts CLI)
 - Optionally triggers Python model generation via datamodel-code-generator when RUN_PY=1
*/
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const os = require('os');

const root = process.cwd();
const schemaDir = path.join(root, 'schemas');

const mappings = [
  { in: 'common/event-envelope.json', out: 'packages/events/src/contracts/envelope.ts' },
  { in: 'common/error-envelope.json', out: 'packages/events/src/contracts/error-envelope.ts' },
  { in: 'common/dlq-event.json', out: 'packages/events/src/contracts/dlq-event.ts' },
  { in: 'ingest/portal-submission.json', out: 'packages/events/src/contracts/ingest.ts' },
  { in: 'triage/triage-input.json', out: 'packages/events/src/contracts/triage.ts' },
  { in: 'booking/booking-search-request.json', out: 'packages/events/src/contracts/booking.ts' },
  { in: 'pharmacy/pharmacy-referral.json', out: 'packages/events/src/contracts/pharmacy.ts' },
  { in: 'scribe/scribe-audio.json', out: 'packages/events/src/contracts/scribe.ts' },
  { in: 'safety/safety-decision.json', out: 'packages/events/src/contracts/safety.ts' },
  { in: 'telephony/call-transcribed.json', out: 'packages/events/src/contracts/call-transcribed.ts' },
  { in: 'telephony/intent-classified.json', out: 'packages/events/src/contracts/intent-classified.ts' },
  { in: 'tasks/task-created.json', out: 'packages/events/src/contracts/task-created.ts' },
  { in: 'booking/appointment-created.json', out: 'packages/events/src/contracts/appointment-created.ts' },
  { in: 'audit/audit-event.json', out: 'packages/events/src/contracts/audit-event.ts' },
  { in: 'analytics/metric.json', out: 'packages/events/src/contracts/metric.ts' },
  { in: 'ics/referral-request.json', out: 'packages/events/src/contracts/ics-referral-request.ts' },
  { in: 'ics/referral-ack.json', out: 'packages/events/src/contracts/ics-referral-ack.ts' },
  { in: 'config/orchestrator.json', out: 'packages/config/src/contracts/orchestrator.ts' },
  { in: 'portal/notify.json', out: 'packages/events/src/contracts/portal.ts' },
];

function ensureDir(p) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
}

function resolveJson2tsBinary() {
  const binName = process.platform === 'win32' ? 'json2ts.cmd' : 'json2ts';
  const candidate = path.join(root, 'node_modules', '.bin', binName);
  if (fs.existsSync(candidate)) {
    return candidate;
  }
  console.error('json2ts CLI not found. Run `npm install` to install dev dependencies.');
  process.exit(1);
}

function generateTS() {
  if (process.env.DRY_RUN === '1') {
    console.log('DRY_RUN=1 set; skipping TS generation.');
    return 0;
  }
  const json2tsBin = resolveJson2tsBinary();
  const spawnOpts = { stdio: 'ignore', shell: process.platform === 'win32' };
  const json2ts = spawnSync(json2tsBin, ['--help'], spawnOpts);
  if (json2ts.status !== 0) {
    console.error('json-schema-to-typescript CLI failed to execute. Ensure devDependency is installed.');
    process.exit(1);
  }

  for (const m of mappings) {
    const input = path.join(schemaDir, m.in);
    const output = path.join(root, m.out);
    if (!fs.existsSync(input)) {
      console.error(`Missing schema: ${input}`);
      process.exit(1);
    }
    ensureDir(output);
    const banner = '// AUTO-GENERATED from schemas. DO NOT EDIT.\n';
    const args = ['-i', input, '-o', output, '--bannerComment', banner];
    const res = spawnSync(json2tsBin, args, { stdio: 'inherit', shell: process.platform === 'win32' });
    if (res.status !== 0) {
      console.error(`Failed generating TS from ${input}`);
      process.exit(res.status || 1);
    }
  }
}

function generatePy() {
  if (process.env.DRY_RUN === '1') {
    console.log('DRY_RUN=1 set; skipping Python generation.');
    return 0;
  }
  const runPy = process.env.RUN_PY === '1';
  if (!runPy) {
    console.log('RUN_PY not set; skipping Python model generation.');
    return;
  }
  const stagingDir = stageSchemas(schemaDir);
  const out = path.join(root, 'services-py/common/contracts/models.py');
  ensureDir(out);
  try {
    const res = spawnSync(
      'python3',
      [
        '-m', 'datamodel_code_generator',
        '--input', stagingDir,
        '--input-file-type', 'jsonschema',
        '--output', out,
        '--target-python-version', '3.11',
        '--use-standard-collections',
        '--collapse-root-models',
      ],
      { stdio: 'inherit' }
    );
    if (res.status !== 0) {
      console.error('Failed generating Python models from schemas');
      process.exit(res.status || 1);
    }
  } finally {
    cleanupDir(stagingDir);
  }
}

function stageSchemas(sourceDir) {
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'onecare-schemas-'));
  copyJsonFiles(sourceDir, staging);
  return staging;
}

function copyJsonFiles(src, dest) {
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = path.join(src, entry.name);
    const targetPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(targetPath, { recursive: true });
      copyJsonFiles(sourcePath, targetPath);
    } else if (entry.isFile() && entry.name.endsWith('.json')) {
      ensureDir(targetPath);
      fs.copyFileSync(sourcePath, targetPath);
    }
  }
}

function cleanupDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    console.warn('Failed to clean up staging dir', { dir, error: err instanceof Error ? err.message : String(err) });
  }
}

function main() {
  if (!fs.existsSync(schemaDir)) {
    console.error('schemas/ not found');
    process.exit(1);
  }
  if (process.env.DRY_RUN === '1') {
    // Verify mapping inputs/outputs exist and contain expected symbols
    const expected = {
      'packages/events/src/contracts/envelope.ts': 'interface EventEnvelope',
      'packages/events/src/contracts/error-envelope.ts': 'interface ErrorEnvelope',
      'packages/events/src/contracts/dlq-event.ts': 'interface DlqEvent',
      'packages/events/src/contracts/ingest.ts': 'interface PortalSubmission',
      'packages/events/src/contracts/triage.ts': 'interface TriageInput',
      'packages/events/src/contracts/booking.ts': 'interface BookingSearchRequest',
      'packages/events/src/contracts/pharmacy.ts': 'interface PharmacyReferral',
      'packages/events/src/contracts/scribe.ts': 'interface ScribeAudio',
      'packages/events/src/contracts/safety.ts': 'interface SafetyDecision',
      'packages/events/src/contracts/call-transcribed.ts': 'interface CallTranscribed',
      'packages/events/src/contracts/intent-classified.ts': 'interface IntentClassified',
      'packages/events/src/contracts/task-created.ts': 'interface TaskCreated',
      'packages/events/src/contracts/appointment-created.ts': 'interface AppointmentCreated',
      'packages/events/src/contracts/audit-event.ts': 'interface AuditEvent',
      'packages/events/src/contracts/metric.ts': 'interface Metric',
      'packages/events/src/contracts/ics-referral-request.ts': 'interface IcsReferralRequest',
      'packages/events/src/contracts/ics-referral-ack.ts': 'interface IcsReferralAck',
      'packages/config/src/contracts/orchestrator.ts': 'interface OrchestratorConfig',
      'packages/events/src/contracts/portal.ts': 'interface PortalNotify',
    };
    let ok = true;
    for (const m of mappings) {
      const inPath = path.join(schemaDir, m.in);
      const outPath = path.join(root, m.out);
      if (!fs.existsSync(inPath)) {
        console.error('Missing schema:', m.in);
        ok = false;
      }
      if (!fs.existsSync(outPath)) {
        console.error('Missing generated TS:', m.out);
        ok = false;
      } else {
        const content = fs.readFileSync(outPath, 'utf8');
        const marker = expected[m.out];
        if (marker && !content.includes(marker)) {
          console.error(`Generated TS missing expected symbol in ${m.out}: ${marker}`);
          ok = false;
        }
      }
    }
    if (!ok) {
      process.exit(2);
    }
    console.log('Codegen DRY RUN check passed.');
    return;
  }
  console.log('Generating TypeScript contracts from schemas/...');
  generateTS();
  console.log('TypeScript contracts updated.');
  generatePy();
}

main();
