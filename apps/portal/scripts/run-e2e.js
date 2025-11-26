#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const net = require('node:net');

const canBind = () =>
  new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(0, '127.0.0.1', () => {
      server.close(() => resolve(true));
    });
  });

(async () => {
  if (process.env.PORTAL_E2E_ENABLE !== 'true') {
    console.info('Skipping portal e2e: PORTAL_E2E_ENABLE is not set to true.');
    process.exit(0);
  }
  const bindable = await canBind();
  if (!bindable) {
    console.warn('Skipping portal e2e: environment cannot bind a preview port (EPERM).');
    process.exit(0);
  }
  const env = { ...process.env };
  const result = spawnSync('npx', ['playwright', 'test'], { stdio: 'inherit', env });
  process.exit(result.status ?? 1);
})();
