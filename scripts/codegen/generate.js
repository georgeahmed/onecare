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
  { in: 'features/triage-core.json', out: 'packages/events/src/contracts/triage-core-features.ts' },
  { in: 'features/acuity-signal.json', out: 'packages/events/src/contracts/acuity-signal-features.ts' },
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
  const out = path.join(root, 'services-py/common/contracts/models.py');
  const schemaFiles = collectSchemaFiles(schemaDir);
  if (schemaFiles.length === 0) {
    console.warn('No JSON Schemas found for Python generation.');
    return;
  }
  const combined = buildPythonModels(schemaFiles);
  ensureDir(out);
  fs.writeFileSync(out, combined, 'utf8');
}

function collectSchemaFiles(dir) {
  const files = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSchemaFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.json')) {
      files.push(fullPath);
    }
  }
  return files;
}

function buildPythonModels(schemaFiles) {
  const fromImports = new Map();
  const plainImports = new Set();
  const sections = [];

  const sortedFiles = schemaFiles.slice().sort();
  for (const filePath of sortedFiles) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onecare-model-'));
    const tmpFile = path.join(tmpDir, 'model.py');
    ensureDir(tmpFile);
    const res = spawnSync(
      'python3',
      [
        '-m', 'datamodel_code_generator',
        '--input', filePath,
        '--input-file-type', 'jsonschema',
        '--output', tmpFile,
        '--target-python-version', '3.11',
        '--use-standard-collections',
        '--collapse-root-models',
      ],
      { stdio: 'inherit' }
    );
    if (res.status !== 0) {
      console.error('Failed generating Python model for schema:', filePath);
      cleanupDir(tmpDir);
      process.exit(res.status || 1);
    }
    const raw = fs.readFileSync(tmpFile, 'utf8');
    cleanupDir(tmpDir);
    const relativeLabel = path.relative(schemaDir, filePath);
    const sectionLines = extractPythonSection(raw, fromImports, plainImports);
    if (sectionLines.length > 0) {
      sections.push(`# --- ${relativeLabel} ---`, ...sectionLines, '');
    }
  }
  const importLines = [];
  if (plainImports.size > 0) {
    importLines.push(...Array.from(plainImports).sort());
  }
  const sortedFrom = Array.from(fromImports.entries()).sort(([a], [b]) => a.localeCompare(b));
  for (const [module, symbols] of sortedFrom) {
    const symbolList = Array.from(symbols).sort((a, b) => a.localeCompare(b));
    importLines.push(`from ${module} import ${symbolList.join(', ')}`);
  }

  const header = [
    '"""AUTO-GENERATED from schemas/. DO NOT EDIT MANUALLY."""',
    'from __future__ import annotations',
    '',
  ];

  const combinedImports = importLines.length > 0 ? [...importLines, ''] : [];
  const body = sections.length > 0 ? sections : [];
  return [...header, ...combinedImports, ...body].join('\n').replace(/\n+$/u, '\n');
}

function extractPythonSection(content, fromImports, plainImports) {
  const lines = content.split(/\r?\n/u);
  const section = [];
  for (const line of lines) {
    if (!line) {
      if (section.length === 0 || section[section.length - 1] === '') continue;
      section.push('');
      continue;
    }
    if (line.startsWith('# generated by datamodel-codegen')) continue;
    if (line.startsWith('#   filename:')) continue;
    if (line.startsWith('#   timestamp:')) continue;
    if (line.startsWith('from __future__ import')) continue;
    if (line.startsWith('from ') || line.startsWith('import ')) {
      const fromMatch = /^from\s+([\w.]+)\s+import\s+(.+)$/.exec(line);
      if (fromMatch) {
        const [, module, names] = fromMatch;
        const existing = fromImports.get(module) ?? new Set();
        for (const name of names.split(',').map((item) => item.trim()).filter(Boolean)) {
          existing.add(name);
        }
        fromImports.set(module, existing);
      } else {
        plainImports.add(line);
      }
      continue;
    }
    section.push(line);
  }
  while (section.length > 0 && section[section.length - 1] === '') {
    section.pop();
  }
  return section;
}

function cleanupDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    console.warn('Failed to clean up temp dir', { dir, error: err instanceof Error ? err.message : String(err) });
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
      'packages/events/src/contracts/triage-core-features.ts': 'interface TriageCoreFeatures',
      'packages/events/src/contracts/acuity-signal-features.ts': 'interface AcuitySignalFeatures',
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
