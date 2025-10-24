#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function usage() {
  console.error('Usage: update_task.js --engineer <team/path> --action done|bug|blocked|fix [--task "substring"] [--index N]');
  process.exit(1);
}

function parseArgs() {
  const args = process.argv.slice(2);
  const out = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--engineer') out.engineer = args[++i];
    else if (a === '--action') out.action = args[++i];
    else if (a === '--task') out.task = args[++i];
    else if (a === '--index') out.index = parseInt(args[++i], 10);
  }
  if (!out.engineer || !out.action) usage();
  if (!out.task && !out.index && out.action !== 'fix-all') usage();
  return out;
}

function loadFile(p) {
  const base = p.startsWith('team/') ? p : path.join('team', p);
  if (fs.existsSync(base)) {
    return { full: base, content: fs.readFileSync(base, 'utf8') };
  }
  if (!base.endsWith('.md')) {
    const withMd = `${base}.md`;
    if (fs.existsSync(withMd)) {
      return { full: withMd, content: fs.readFileSync(withMd, 'utf8') };
    }
  }
  console.error('Engineer file not found:', base.endsWith('.md') ? base : `${base}.md`);
  process.exit(1);
}

function updateTask(content, action, matcher) {
  const lines = content.split(/\r?\n/);
  let start = -1; let end = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^Tasks\s*$/i.test(lines[i])) { start = i + 1; break; }
  }
  if (start === -1) throw new Error('Tasks section not found');
  end = start;
  while (end < lines.length && lines[end].trim() && /^-\s+\[/.test(lines[end])) end++;
  const tasks = [];
  for (let i = start; i < end; i++) {
    const m = /^-\s+\[( |x|X)\]\s+(.+)$/.exec(lines[i]);
    if (m) tasks.push({ idx: i, checked: m[1].toLowerCase() === 'x', text: m[2] });
  }
  if (tasks.length === 0) throw new Error('No tasks found');

  let target = null;
  if (matcher.index != null) {
    const n = matcher.index - 1;
    if (n < 0 || n >= tasks.length) throw new Error('Index out of range');
    target = tasks[n];
  } else if (matcher.substr) {
    const lower = matcher.substr.toLowerCase();
    target = tasks.find(t => t.text.toLowerCase().includes(lower));
    if (!target) throw new Error('Task substring not found');
  }

  function markBug(text) {
    return /\b(bug|needs[- ]?fix)\b/i.test(text) ? text : text + ' (bug)';
  }
  function markBlocked(text) {
    return /\bblocked\b/i.test(text) ? text : text + ' (blocked)';
  }
  function clearFlags(text) {
    return text.replace(/\s*\((bug|needs[- ]?fix|blocked)\)\s*/gi, ' ').replace(/\s+$/, '');
  }

  if (!target) {
    // fix-all mode could be implemented later
    throw new Error('No target task');
  }

  const line = lines[target.idx];
  if (action === 'done') {
    lines[target.idx] = line.replace(/^-\s+\[[ xX]\]/, '- [x]');
  } else if (action === 'bug') {
    const m = /^(-\s+\[[ xX]\]\s+)(.+)$/.exec(line);
    lines[target.idx] = m[1] + markBug(m[2]);
  } else if (action === 'blocked') {
    const m = /^(-\s+\[[ xX]\]\s+)(.+)$/.exec(line);
    lines[target.idx] = m[1] + markBlocked(m[2]);
  } else if (action === 'fix') {
    const m = /^(-\s+\[[ xX]\]\s+)(.+)$/.exec(line);
    lines[target.idx] = m[1] + clearFlags(m[2]);
  } else {
    throw new Error('Unknown action');
  }

  return lines.join('\n');
}

function main() {
  const args = parseArgs();
  const teamRoot = path.join(process.cwd(), 'team');
  if (!fs.existsSync(teamRoot)) {
    console.warn('Team directory not found; skipping task update.');
    return;
  }
  const { full, content } = loadFile(args.engineer);
  const matcher = { substr: args.task, index: args.index };
  const updated = updateTask(content, args.action, matcher);
  fs.writeFileSync(full, updated);
  // update status/progress for this engineer
  spawnSync('node', ['scripts/team/status.js', 'engineer', path.relative(process.cwd(), full), '--write'], { stdio: 'inherit' });
}

main();
