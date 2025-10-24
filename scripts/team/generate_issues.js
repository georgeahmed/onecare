#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function listEngineerFiles(root) {
  const files = [];
  function walk(p) {
    for (const entry of fs.readdirSync(p)) {
      const full = path.join(p, entry);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) walk(full);
      else if (/team\/.+\/engineer-\d+\.md$/.test(full)) files.push(full);
    }
  }
  walk(root);
  return files;
}

function extractTasks(md) {
  const res = [];
  const lines = md.split(/\r?\n/);
  let inTasks = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^Tasks\s*$/i.test(line)) { inTasks = true; continue; }
    if (inTasks) {
      if (!line.trim()) { inTasks = false; continue; }
      const m = /^-\s+\[( |x|X)\]\s+(.+)$/.exec(line);
      if (m) res.push({ done: m[1].toLowerCase() === 'x', text: m[2] });
      else if (/^[A-Za-z]/.test(line)) { inTasks = false; }
    }
  }
  return res;
}

function main() {
  const args = process.argv.slice(2);
  const execute = args.includes('--execute');
  const repo = process.env.GITHUB_REPOSITORY || '';
  const root = process.cwd();
  const teamDir = path.join(root, 'team');
  if (!fs.existsSync(teamDir)) {
    fs.mkdirSync(path.join(root, 'var'), { recursive: true });
    fs.writeFileSync(path.join(root, 'var', 'issues.json'), JSON.stringify([], null, 2));
    fs.writeFileSync(path.join(root, 'var', 'gh_issues.sh'), '#!/usr/bin/env bash\nset -euo pipefail\necho "Team directory not found; no issues generated." >&2\n');
    console.log('No team directory found; skipping issue generation.');
    return;
  }
  const files = listEngineerFiles(teamDir);
  const issues = [];
  for (const f of files) {
    const md = fs.readFileSync(f, 'utf8');
    const tasks = extractTasks(md).filter((t) => !t.done);
    const engineer = path.relative(path.join(root, 'team'), f);
    for (const t of tasks) {
      const title = `[Team] ${engineer} :: ${t.text}`;
      const body = `Auto-generated from ${engineer} on ${new Date().toISOString()}\n\nTask:\n- ${t.text}\n`;
      issues.push({ title, body, engineer });
    }
  }

  fs.mkdirSync(path.join(root, 'var'), { recursive: true });
  fs.writeFileSync(path.join(root, 'var', 'issues.json'), JSON.stringify(issues, null, 2));
  const script = ["#!/usr/bin/env bash", "set -euo pipefail"]; 
  if (!repo) script.push("echo 'Set GITHUB_REPOSITORY=owner/repo to create issues' >&2; exit 1");
  for (const i of issues) {
    script.push(`gh issue create --repo \"${repo}\" --title ${JSON.stringify(i.title)} --body ${JSON.stringify(i.body)}`);
  }
  fs.writeFileSync(path.join(root, 'var', 'gh_issues.sh'), script.join('\n'));

  if (execute && repo) {
    try {
      execSync(`bash var/gh_issues.sh`, { stdio: 'inherit' });
    } catch (e) {
      process.exit(1);
    }
  } else {
    console.log(`Prepared ${issues.length} issues. Review var/issues.json and run: bash var/gh_issues.sh`);
  }
}

main();
