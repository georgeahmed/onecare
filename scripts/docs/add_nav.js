#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

function listTaskFiles() {
  const root = path.join(process.cwd(), 'team');
  const results = [];
  if (!fs.existsSync(root)) return results;
  function walk(dir) {
    for (const entry of fs.readdirSync(dir)) {
      const full = path.join(dir, entry);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) walk(full);
      else if (/team\/.+\/tasks\/.+\.md$/.test(full)) results.push(full);
    }
  }
  walk(root);
  return results.sort();
}

function groupByDir(files) {
  const groups = new Map();
  for (const f of files) {
    const dir = path.dirname(f);
    if (!groups.has(dir)) groups.set(dir, []);
    groups.get(dir).push(f);
  }
  for (const [dir, arr] of groups) arr.sort();
  return groups;
}

function ensureNav(file, prev, next) {
  const repoRoot = process.cwd();
  const taskIndexPath = path.join(repoRoot, 'docs', 'TASK_INDEX.md');
  const relToIndex = fs.existsSync(taskIndexPath)
    ? path.relative(path.dirname(file), taskIndexPath) || 'docs/TASK_INDEX.md'
    : 'docs/TASK_INDEX.md';
  const flowPath = path.join(repoRoot, 'team', 'all-tasks-flow.md');
  const relToFlow = fs.existsSync(flowPath)
    ? path.relative(path.dirname(file), flowPath) || 'team/all-tasks-flow.md'
    : 'team/all-tasks-flow.md';
  const prevLink = prev ? `[Prev](${path.relative(path.dirname(file), prev)})` : 'Prev: —';
  const nextLink = next ? `[Next](${path.relative(path.dirname(file), next)})` : 'Next: —';
  const nav = `Navigation: [Task Index](${relToIndex}) | [All Tasks Flow](${relToFlow}) | ${prevLink} | ${nextLink}`;

  const content = fs.readFileSync(file, 'utf8');
  if (content.startsWith('Navigation:')) return; // already has nav
  const updated = nav + '\n\n' + content;
  fs.writeFileSync(file, updated);
}

function main() {
  const files = listTaskFiles();
  const groups = groupByDir(files);
  for (const [dir, arr] of groups) {
    for (let i = 0; i < arr.length; i++) {
      const f = arr[i];
      const prev = i > 0 ? arr[i - 1] : null;
      const next = i < arr.length - 1 ? arr[i + 1] : null;
      ensureNav(f, prev, next);
    }
  }
  console.log(`Updated navigation for ${files.length} task files.`);
}

main();
