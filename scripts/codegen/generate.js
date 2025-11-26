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
  { in: 'billing/claim.json', out: 'packages/events/src/contracts/billing-claim.ts' },
  { in: 'billing/response.json', out: 'packages/events/src/contracts/billing-response.ts' },
  { in: 'common/event-envelope.json', out: 'packages/events/src/contracts/envelope.ts' },
  { in: 'common/error-envelope.json', out: 'packages/events/src/contracts/error-envelope.ts' },
  { in: 'common/dlq-event.json', out: 'packages/events/src/contracts/dlq-event.ts' },
  { in: 'ingest/portal-submission.json', out: 'packages/events/src/contracts/ingest.ts' },
  { in: 'ingest/guided-help-session.request.json', out: 'packages/events/src/contracts/guided-help-session-request.ts' },
  { in: 'ingest/guided-help-session.response.json', out: 'packages/events/src/contracts/guided-help-session-response.ts' },
  { in: 'triage/triage-input.json', out: 'packages/events/src/contracts/triage.ts' },
  { in: 'triage/triage-decision.json', out: 'packages/events/src/contracts/triage-decision.ts' },
  { in: 'booking/booking-search-request.json', out: 'packages/events/src/contracts/booking.ts' },
  { in: 'booking/booking-search-response.json', out: 'packages/events/src/contracts/booking-search-response.ts' },
  { in: 'booking/assisted-outcome.json', out: 'packages/events/src/contracts/booking-assisted-outcome.ts' },
  { in: 'pharmacy/pharmacy-referral.json', out: 'packages/events/src/contracts/pharmacy.ts' },
  { in: 'pharmacy/pharmacy-notification.json', out: 'packages/events/src/contracts/pharmacy-notification.ts' },
  { in: 'pharmacy/pharmacy-outcome.json', out: 'packages/events/src/contracts/pharmacy-outcome.ts' },
  { in: 'scribe/scribe-audio.json', out: 'packages/events/src/contracts/scribe.ts' },
  { in: 'safety/safety-decision.json', out: 'packages/events/src/contracts/safety.ts' },
  { in: 'telephony/call-transcribed.json', out: 'packages/events/src/contracts/call-transcribed.ts' },
  { in: 'telephony/intent-classified.json', out: 'packages/events/src/contracts/intent-classified.ts' },
  { in: 'features/triage-core.json', out: 'packages/events/src/contracts/triage-core-features.ts' },
  { in: 'features/acuity-signal.json', out: 'packages/events/src/contracts/acuity-signal-features.ts' },
  { in: 'features/registry.schema.json', out: 'packages/events/src/contracts/feature-registry.ts' },
  { in: 'tasks/task-created.json', out: 'packages/events/src/contracts/task-created.ts' },
  { in: 'tasks/task-updated.json', out: 'packages/events/src/contracts/task-updated.ts' },
  { in: 'booking/appointment-created.json', out: 'packages/events/src/contracts/appointment-created.ts' },
  { in: 'audit/audit-event.json', out: 'packages/events/src/contracts/audit-event.ts' },
  { in: 'analytics/metric.json', out: 'packages/events/src/contracts/metric.ts' },
  { in: 'ics/referral-request.json', out: 'packages/events/src/contracts/ics-referral-request.ts' },
  { in: 'ics/referral-ack.json', out: 'packages/events/src/contracts/ics-referral-ack.ts' },
  { in: 'messaging/send-document-request.json', out: 'packages/events/src/contracts/send-document-request.ts' },
  { in: 'messaging/send-document-requested.json', out: 'packages/events/src/contracts/send-document-requested.ts' },
  { in: 'messaging/send-document-sent.json', out: 'packages/events/src/contracts/send-document-sent.ts' },
  { in: 'messaging/send-document-ack.json', out: 'packages/events/src/contracts/send-document-ack.ts' },
  { in: 'messaging/send-document-nack.json', out: 'packages/events/src/contracts/send-document-nack.ts' },
  { in: 'messaging/send-document-retry.json', out: 'packages/events/src/contracts/send-document-retry.ts' },
  { in: 'fhir/patient.json', out: 'packages/events/src/contracts/fhir-patient.ts' },
  { in: 'fhir/communication.json', out: 'packages/events/src/contracts/fhir-communication.ts' },
  { in: 'fhir/document-reference.json', out: 'packages/events/src/contracts/fhir-document-reference.ts' },
  { in: 'fhir/bundle-entry-resource.json', out: 'packages/events/src/contracts/fhir-bundle-entry-resource.ts' },
  { in: 'fhir/bundle-transaction.json', out: 'packages/events/src/contracts/fhir-bundle-transaction.ts' },
  { in: 'config/orchestrator.json', out: 'packages/config/src/contracts/orchestrator.ts' },
  { in: 'portal/notify.json', out: 'packages/events/src/contracts/portal.ts' },
  { in: 'clinician/task-summary.json', out: 'packages/events/src/contracts/clinician-task-summary.ts' },
  { in: 'clinician/task-detail.json', out: 'packages/events/src/contracts/clinician-task-detail.ts' },
  { in: 'clinician/assign.json', out: 'packages/events/src/contracts/clinician-assign.ts' },
  { in: 'clinician/resolve.json', out: 'packages/events/src/contracts/clinician-resolve.ts' },
  { in: 'clinician/schedule-callback.json', out: 'packages/events/src/contracts/clinician-schedule-callback.ts' },
  { in: 'clinician/book-slot.json', out: 'packages/events/src/contracts/clinician-book-slot.ts' },
];

const schemaSkipList = new Set(['features/registry.json']);

function isExecutable(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    const stat = fs.statSync(filePath);
    return stat.isFile();
  } catch (err) {
    return false;
  }
}

function findExecutable(cmd) {
  if (!cmd) {
    return null;
  }
  if (path.isAbsolute(cmd) && isExecutable(cmd)) {
    return cmd;
  }

  const pathEnv = process.env.PATH || '';
  const paths = pathEnv.split(path.delimiter).filter(Boolean);
  if (paths.length === 0) {
    return null;
  }

  const isWin = process.platform === 'win32';
  const extensions = isWin
    ? (process.env.PATHEXT ? process.env.PATHEXT.split(';') : ['.EXE', '.CMD', '.BAT', '.COM'])
    : [''];

  const candidates = new Set();
  candidates.add(cmd);
  if (isWin) {
    const lowerCmd = cmd.toLowerCase();
    for (const ext of extensions) {
      if (!ext) continue;
      if (lowerCmd.endsWith(ext.toLowerCase())) {
        candidates.add(cmd);
      } else {
        candidates.add(`${cmd}${ext}`);
      }
    }
  }

  for (const dir of paths) {
    for (const candidate of candidates) {
      const fullPath = path.join(dir, candidate);
      if (isExecutable(fullPath)) {
        return fullPath;
      }
    }
  }
  return null;
}

function pythonCanImport(moduleName, pythonBin) {
  const python = pythonBin || 'python3';
  const probe = spawnSync(
    python,
    ['-c', `import importlib.util, sys; sys.exit(0 if importlib.util.find_spec("${moduleName}") else 1)`],
    { stdio: 'ignore' }
  );
  return probe.status === 0;
}

function resolveDatamodelCodegenInvoker() {
  const envCmd = process.env.DATAMODEL_CODEGEN_BIN;
  if (envCmd) {
    return { command: envCmd, args: [] };
  }

  const cliPath = findExecutable('datamodel-codegen');
  if (cliPath) {
    return { command: cliPath, args: [] };
  }

  // Attempt to inspect pipx venvs for datamodel-code-generator
  const pipxPath = findExecutable('pipx');
  if (pipxPath) {
    try {
      const pipxList = spawnSync(pipxPath, ['list', '--json'], { encoding: 'utf8', stdio: 'pipe' });
      if (pipxList.status === 0 && pipxList.stdout) {
        const data = JSON.parse(pipxList.stdout);
        const venvs = data && data.venvs ? data.venvs : {};
        const entry = venvs['datamodel-code-generator'];
        if (entry && entry.metadata && entry.metadata.source_interpreter && entry.metadata.source_interpreter.__Path__) {
          const interpreter = entry.metadata.source_interpreter.__Path__;
          if (pythonCanImport('datamodel_code_generator', interpreter)) {
            return { command: interpreter, args: ['-m', 'datamodel_code_generator'] };
          }
        }
        if (entry && entry.metadata && entry.metadata.main_package && Array.isArray(entry.metadata.main_package.app_paths)) {
          for (const item of entry.metadata.main_package.app_paths) {
            if (item && item.__Path__ && isExecutable(item.__Path__)) {
              return { command: item.__Path__, args: [] };
            }
          }
        }
      }
    } catch (err) {
      // ignore pipx inspection failures
    }
  }

  const pythonCandidates = [
    process.env.DATAMODEL_CODEGEN_PYTHON,
    process.env.PYTHON_CODEGEN,
    process.env.PYTHON,
    'python3',
  ].filter(Boolean);

  for (const python of pythonCandidates) {
    if (pythonCanImport('datamodel_code_generator', python)) {
      return { command: python, args: ['-m', 'datamodel_code_generator'] };
    }
  }

  throw new Error(
    'datamodel-code-generator is required for Python model generation. Install it via `python3 -m pip install --user datamodel-code-generator`, or ensure the `datamodel-codegen` CLI is on PATH (e.g., `pipx install datamodel-code-generator && pipx ensurepath`).'
  );
}

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
    const res = spawnSync(json2tsBin, args, {
      stdio: 'inherit',
      shell: process.platform === 'win32',
      cwd: path.dirname(input),
    });
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
  let invoker;
  try {
    invoker = resolveDatamodelCodegenInvoker();
  } catch (err) {
    console.error(String(err));
    process.exit(1);
  }
  const out = path.join(root, 'services-py/common/contracts/models.py');
  const schemaFiles = collectSchemaFiles(schemaDir);
  if (schemaFiles.length === 0) {
    console.warn('No JSON Schemas found for Python generation.');
    return;
  }
  const combined = buildPythonModels(schemaFiles, invoker);
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
      const relative = path.relative(schemaDir, fullPath);
      if (schemaSkipList.has(relative)) continue;
      files.push(fullPath);
    }
  }
  return files;
}

function buildPythonModels(schemaFiles, invoker) {
  const fromImports = new Map();
  const plainImports = new Set();
  const sections = [];

  const sortedFiles = schemaFiles.slice().sort();
  for (const filePath of sortedFiles) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onecare-model-'));
    const tmpFile = path.join(tmpDir, 'model.py');
    ensureDir(tmpFile);
    const res = spawnSync(
      invoker.command,
      [
        ...invoker.args,
        '--input', filePath,
        '--input-file-type', 'jsonschema',
        '--output', tmpFile,
        '--target-python-version', '3.11',
        '--use-standard-collections',
        '--collapse-root-models',
        '--use-title-as-name',
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
    const sectionLines = postProcessSection(
      relativeLabel,
      extractPythonSection(raw, fromImports, plainImports)
    );
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
  const combined = [...header, ...combinedImports, ...body]
    .join('\n')
    .replace(/\n+$/u, '\n');
  return dedupePythonOutput(combined);
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

function postProcessSection(relativeLabel, sectionLines) {
  if (sectionLines.length === 0) {
    return sectionLines;
  }
  if (relativeLabel === 'fhir/bundle-entry-resource.json') {
    const replacementMap = {
      BundleEntryPatient: 'Patient',
      BundleEntryCommunication: 'Communication',
      BundleEntryDocumentReference: 'DocumentReference',
    };
    let currentClass = null;
    return sectionLines.map((line) => {
      const classMatch = line.match(/^class\s+(\w+)/);
      if (classMatch) {
        currentClass = classMatch[1];
        return line;
      }
      if (
        currentClass &&
        line.includes("-datamodel-code-generator-#-allOf-#-special-#") &&
        replacementMap[currentClass]
      ) {
        return line.replace(
          /Literal\['[^']+'\]/,
          `Literal['${replacementMap[currentClass]}']`
        );
      }
      return line;
    });
  }

  if (relativeLabel === 'common/event-envelope.json') {
    sectionLines = sectionLines.map((line) => {
      const match = /^(\s*)payload:\s*Optional\[Union\[(.+)\]\]$/u.exec(line);
      if (match) {
        return `${match[1]}payload: Union[${match[2]}, None]`;
      }
      return line;
    });
  }

  return sectionLines;
}

function dedupePythonOutput(content) {
  const lines = content.split('\n');
  const result = [];
  const seen = new Set();

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const classMatch = /^class\s+(\w+)/.exec(line);
    if (classMatch) {
      const name = classMatch[1];
      let j = i + 1;
      while (
        j < lines.length &&
        !/^class\s+\w+/.test(lines[j]) &&
        !/^# --- /.test(lines[j])
      ) {
        j += 1;
      }
      if (!seen.has(name)) {
        seen.add(name);
        result.push(...lines.slice(i, j));
      }
      i = j;
      continue;
    }
    result.push(line);
    i += 1;
  }

  return result.join('\n').replace(/\n+$/u, '\n');
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
      'packages/events/src/contracts/booking-search-response.ts': 'interface BookingSearchResponse',
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
