#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const TEAM_DIR = path.join(process.cwd(), 'team');
const OUT = path.join(process.cwd(), 'docs', 'TASK_INDEX.md');

function findTaskFiles() {
  const out = [];
  function walk(dir) {
    const entries = fs.readdirSync(dir);
    for (const e of entries) {
      const full = path.join(dir, e);
      const st = fs.statSync(full);
      if (st.isDirectory()) walk(full);
      else if (/\/tasks\/.+\.md$/.test(full)) out.push(full);
    }
  }
  walk(TEAM_DIR);
  return out.sort();
}

function titleFromFile(file) {
  const text = fs.readFileSync(file, 'utf8');
  const m = text.match(/^Task:\s*(.+)$/m);
  if (m) return m[1].trim();
  // fallback to filename
  return path.basename(file, '.md');
}

function groupByDepartment(files) {
  const groups = new Map();
  for (const f of files) {
    // team/<dept>/tasks/<name>.md
    const parts = f.split(path.sep);
    const idx = parts.indexOf('team');
    const dept = parts[idx + 1];
    if (!groups.has(dept)) groups.set(dept, []);
    groups.get(dept).push(f);
  }
  for (const [k, arr] of groups) arr.sort();
  return groups;
}

function toRel(p) {
  return path.relative(path.join(process.cwd(), 'docs'), p).replace(/\\/g, '/');
}

function build() {
  const files = findTaskFiles();
  const groups = groupByDepartment(files);
  const lines = [];
  lines.push('Task Index');
  lines.push('');
  lines.push('Run a task: `make engineer-loop ENGINEER=<team/path> TASK=\'<task-id>\'`');
  lines.push('');
  const order = [
    'backend','integrations','telephony-voice','ml','mlops','data-engineering','qa-automation','frontend','devops-sre','security'
  ];
  for (const dept of order) {
    if (!groups.has(dept)) continue;
    lines.push(`## ${dept}`);
    const arr = groups.get(dept);
    for (const f of arr) {
      const title = titleFromFile(f);
      const rel = toRel(f);
      lines.push(`- [${path.basename(f, '.md')}](${rel}) — ${title}`);
    }
    lines.push('');
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, lines.join('\n'));
  console.log(`Wrote ${OUT} with ${files.length} tasks`);
}

build();

