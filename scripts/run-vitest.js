#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');

const env = {
  ...process.env,
  npm_config_workspaces: 'false',
};

const userArgs = process.argv.slice(2);
const hasRunFlag = userArgs.some((arg) => arg === '--run' || arg === '-r');
const vitestArgs = hasRunFlag ? userArgs : ['--run', ...userArgs];
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
