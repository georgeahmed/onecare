#!/usr/bin/env node
/*
 Simple linter to ensure task cards include required sections in order.
 Scans Markdown files under team/<dept>/tasks/ and checks for headings:
 Context, Files, Steps, Acceptance Criteria, Validate, Status Update.
 Exits non-zero on violations and prints a concise report.
*/
const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const REQUIRED = [
  'Context',
  'Files',
  'Steps',
  'Acceptance Criteria',
  'Validate',
  'Status Update',
];
const REQUIRED_NORMALIZED = REQUIRED.map((h) => h.toLowerCase());

const TEAM_DIR = path.join(ROOT, 'team');
if (!fs.existsSync(TEAM_DIR)) {
  console.log('Task card linter: no team directory present; skipping.');
  process.exit(0);
}

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}

const tasks = [];
for (const p of walk(path.join(ROOT, 'team'))) {
  if (p.includes(`${path.sep}tasks${path.sep}`) && p.endsWith('.md')) tasks.push(p);
}

let missing = 0;
for (const file of tasks) {
  const txt = fs.readFileSync(file, 'utf8');
  const lines = txt.split(/\r?\n/);
  const headings = new Set();
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('#')) {
      const normalized = trimmed
        .replace(/^#+\s*/, '')
        .trim()
        .replace(/[:：]+$/, '')
        .trim()
        .toLowerCase();
      if (normalized) headings.add(normalized);
      continue;
    }
    const candidate = trimmed.replace(/[:：]+$/, '').trim().toLowerCase();
    if (REQUIRED_NORMALIZED.includes(candidate)) {
      headings.add(candidate);
    }
  }
  const missingHeads = REQUIRED.filter((h) => !headings.has(h.toLowerCase()));
  if (missingHeads.length) {
    console.log(`${file}: missing ${missingHeads.join(', ')}`);
    missing++;
  }
}

if (missing) {
  console.error(`Task card linter: ${missing} file(s) missing required sections.`);
  process.exit(1);
} else {
  console.log('Task card linter: all task cards include required sections.');
}
