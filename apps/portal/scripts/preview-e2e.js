#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const net = require('node:net');

const log = (message) => process.stdout.write(`${message}\n`);

const host = process.env.PORTAL_E2E_HOST ?? '127.0.0.1';

const resolvePort = () => {
  const envPort = process.env.PORTAL_E2E_PORT;
  if (envPort && Number.isFinite(Number(envPort))) {
    return Number(envPort);
  }
  const server = net.createServer();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => {
      const address = server.address();
      server.close(() => {
        if (typeof address === 'object' && address && typeof address.port === 'number') {
          resolve(address.port);
        } else {
          reject(new Error('Could not determine preview port'));
        }
      });
    });
  });
};

const run = (cmd, args, env) => {
  const result = spawnSync(cmd, args, { stdio: 'inherit', env });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
};

(async () => {
  const port = await resolvePort();
  const env = {
    ...process.env,
    PORTAL_E2E_PORT: String(port),
    VITE_ORCH_URL: process.env.VITE_ORCH_URL ?? 'http://localhost:3001',
  };
  log(`Using preview port ${port} on host ${host}`);
  run('npm', ['run', 'build'], env);
  run(
    'vite',
    ['preview', '--host', host, '--port', String(port)],
    env
  );
})();
