#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const vitestBin = require.resolve('vitest/vitest.mjs');
const argv = process.argv.slice(2);
let runs = 20;
let pattern;
const files = [];

for (let i = 0; i < argv.length; i += 1) {
  const current = argv[i];
  if (current === '--runs' || current === '-r') {
    const value = argv[i + 1];
    if (!value) {
      throw new Error('Missing value for --runs');
    }
    runs = Math.max(1, Number.parseInt(value, 10));
    i += 1;
  } else if (current === '--pattern' || current === '-p') {
    const value = argv[i + 1];
    if (!value) {
      throw new Error('Missing value for --pattern');
    }
    pattern = value;
    i += 1;
  } else if (current === '--help' || current === '-h') {
    printHelp();
    process.exit(0);
  } else {
    files.push(current);
  }
}

if (!process.env.NODE_ENV) {
  process.env.NODE_ENV = 'test';
}

(async () => {
  for (let attempt = 1; attempt <= runs; attempt += 1) {
    console.log(`\n▶︎ Attempt ${attempt}/${runs}`);
    const exitCode = await runVitest(files, pattern);
    if (exitCode !== 0) {
      console.error(`✖️  Failed on attempt ${attempt}`);
      process.exit(exitCode);
    }
  }
  console.log(`\n✅ ${runs}/${runs} runs succeeded`);
})();

function runVitest(targetFiles, testNamePattern) {
  const args = ['--run'];
  if (testNamePattern) {
    args.push('--testNamePattern', testNamePattern);
  }
  if (Array.isArray(targetFiles) && targetFiles.length > 0) {
    args.push(...targetFiles.map((file) => resolve(file)));
  }
  const env = { ...process.env, npm_config_workspaces: 'false' };
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [vitestBin, ...args], {
      stdio: 'inherit',
      env,
    });
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
  });
}

function printHelp() {
  console.log(`Usage: node qa/tools/stress-test.mjs [options] [<test files...>]

Options:
  -r, --runs <count>       Number of iterations (default: 20)
  -p, --pattern <regex>    Apply a test name pattern filter
  -h, --help               Show this help message

Examples:
  node qa/tools/stress-test.mjs qa/e2e/dlq.spec.ts -r 50
  node qa/tools/stress-test.mjs -r 100 -p "DLQ" qa/e2e/dlq.spec.ts
`);
}
