#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');

const userArgs = process.argv.slice(2);
const hasRunFlag = userArgs.some((arg) => arg === '--run' || arg === '-r');
const vitestArgs = hasRunFlag ? userArgs : ['--run', ...userArgs];
// Derive Vitest scope hints from incoming args so QA/e2e suites bypass the default exclude list.
const scopes = new Set(
  (process.env.VITEST_SCOPE ?? '')
    .split(',')
    .map((scope) => scope.trim())
    .filter(Boolean),
);

function registerScopeFromArg(arg) {
  if (typeof arg !== 'string') return;
  if (arg.includes('qa/')) {
    scopes.add('qa');
  }
  if (arg.includes('apps/') && arg.includes('/tests/e2e')) {
    scopes.add('apps-e2e');
  }
}

for (const arg of vitestArgs) {
  registerScopeFromArg(arg);
}

const env = {
  ...process.env,
  npm_config_workspaces: 'false',
  ...(scopes.size > 0 ? { VITEST_SCOPE: Array.from(scopes).join(',') } : {}),
};
const vitestBin = require.resolve('vitest/vitest.mjs');

const result = spawnSync(process.execPath, [vitestBin, ...vitestArgs], {
  stdio: 'inherit',
  env,
});

if (result.error) {
  console.error(result.error);
  process.exit(1);
}

process.exit(result.status ?? 1);
