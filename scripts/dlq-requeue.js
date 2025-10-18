#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const process = require('node:process');
const { getBus } = require('@onecare/bus');

async function main() {
  const [topic, payloadPath] = process.argv.slice(2);
  if (!topic || !payloadPath) {
    console.error('Usage: node scripts/dlq-requeue.js <topic> <payload.json> [--header key=value]...');
    process.exit(1);
  }

  const absolutePath = path.resolve(payloadPath);
  if (!fs.existsSync(absolutePath)) {
    console.error(`Payload file not found: ${absolutePath}`);
    process.exit(1);
  }

  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(absolutePath, 'utf8'));
  } catch (err) {
    console.error(`Failed to parse payload JSON: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  const headerArgs = process.argv.slice(4).filter((arg) => arg.startsWith('--header'));
  const headers = {};
  for (const arg of headerArgs) {
    const [, pair] = arg.split('=');
    if (!pair) continue;
    const [key, value] = pair.split(':');
    if (key && value !== undefined) {
      headers[key.trim()] = value.trim();
    }
  }

  const bus = getBus();
  try {
    await bus.publish(topic, payload, Object.keys(headers).length > 0 ? headers : undefined);
    console.log(`Republished payload to ${topic}`);
    process.exit(0);
  } catch (err) {
    console.error(`Failed to republish payload: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

void main();
