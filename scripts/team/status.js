#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

function listEngineerFiles(root) {
  const files = [];
  function walk(p) {
    for (const entry of fs.readdirSync(p)) {
      const full = path.join(p, entry);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) {
        walk(full);
      } else if (/team\/.+\/engineer-\d+\.md$/.test(full)) {
        files.push(full);
      }
    }
  }
  walk(root);
  return files;
}

function parseEngineer(md) {
  const lines = md.split(/\r?\n/);
  let status = 'planned';
  let progress = null;
  let inTasks = false;
  let done = 0, total = 0, bugs = 0, blocked = 0;
  let deps = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^Status:\s*(.+)/i.test(line)) {
      status = RegExp.$1.trim();
    }
    if (/^Progress:\s*(\d+)%/i.test(line)) {
      progress = parseInt(RegExp.$1, 10);
    }
    if (/^Dependencies\s*$/i.test(line)) {
      // collect following - lines until blank or non-bullet
      let j = i + 1;
      while (j < lines.length && /^-\s+/.test(lines[j])) {
        const dep = lines[j].replace(/^-\s+/, '').trim();
        if (dep) deps.push(dep);
        j++;
      }
    }
    if (/^Tasks\s*$/i.test(line)) {
      inTasks = true;
      continue;
    }
    if (inTasks) {
      if (!line.trim()) { inTasks = false; continue; }
      if (/^-\s+\[( |x|X)\]\s+/.test(line)) {
        total++;
        const checked = /^-\s+\[(x|X)\]/.test(line);
        if (/(bug|needs[- ]?fix|:bug:)/i.test(line)) bugs++;
        if (/(blocked)/i.test(line)) blocked++;
        if (checked) done++;
      } else if (/^[A-Za-z]/.test(line)) {
        // reached another section
        inTasks = false;
      }
    }
  }

  let computedProgress = progress != null ? progress : 0;
  if (total > 0) computedProgress = Math.round((done / total) * 100);

  let computedStatus = status;
  if (blocked > 0) computedStatus = 'blocked';
  else if (bugs > 0) computedStatus = 'needs-fixes';
  else if (total > 0 && done === total) computedStatus = 'stable';
  else if (total > 0 && done > 0) computedStatus = 'in-progress';
  else if (total === 0) computedStatus = status || 'planned';

  return { lines, status, progress, deps, done, total, bugs, blocked, computedProgress, computedStatus };
}

function updateEngineerFile(file, parsed) {
  const out = parsed.lines.map((line) => {
    if (/^Progress:\s*/i.test(line)) return `Progress: ${parsed.computedProgress}%`;
    if (/^Status:\s*/i.test(line)) return `Status: ${parsed.computedStatus}`;
    return line;
  });
  // if missing Progress/Status lines, append them at end
  const hasStatus = parsed.lines.some((l) => /^Status:\s*/i.test(l));
  const hasProgress = parsed.lines.some((l) => /^Progress:\s*/i.test(l));
  if (!hasStatus) out.push(`\nStatus: ${parsed.computedStatus}`);
  if (!hasProgress) out.push(`Progress: ${parsed.computedProgress}%`);
  fs.writeFileSync(file, out.join('\n'));
}

function main() {
  const args = process.argv.slice(2);
  const write = args.includes('--write');
  const json = args.includes('--json');
  const engineerArg = args.find((a) => a === 'engineer');
  let target = null;
  if (engineerArg) {
    const idx = args.indexOf('engineer');
    target = args[idx + 1];
  }
  const root = path.join(process.cwd(), 'team');
  let files = listEngineerFiles(root);
  if (target) files = files.filter((f) => f.includes(target));
  const rows = [];
  for (const f of files) {
    const md = fs.readFileSync(f, 'utf8');
    const p = parseEngineer(md);
    if (write) updateEngineerFile(f, p);
    rows.push({ file: path.relative(process.cwd(), f), status: p.computedStatus, progress: p.computedProgress, done: p.done, total: p.total, bugs: p.bugs, blocked: p.blocked, deps: p.deps.length });
  }
  if (json) {
    console.log(JSON.stringify(rows, null, 2));
  } else {
    console.log('Engineer Status');
    for (const r of rows) {
      console.log(`${r.file} :: ${r.status} ${r.progress}% (${r.done}/${r.total}) bugs:${r.bugs} deps:${r.deps}`);
    }
    // write aggregated markdown
    const md = ['TEAM STATUS', '', '| Engineer | Status | Progress | Done/Total | Bugs | Deps |', '|---|---|---|---:|---:|---:|'];
    for (const r of rows) md.push(`| ${r.file} | ${r.status} | ${r.progress}% | ${r.done}/${r.total} | ${r.bugs} | ${r.deps} |`);
    fs.mkdirSync(path.join(process.cwd(), 'docs'), { recursive: true });
    fs.writeFileSync(path.join(process.cwd(), 'docs', 'TEAM_STATUS.md'), md.join('\n'));
  }
}

main();

