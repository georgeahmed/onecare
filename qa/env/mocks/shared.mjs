#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const defaultDataDir = resolve(process.cwd(), '../mock-data');
const dataDir = process.env.MOCK_DATA_PATH ? resolve(process.env.MOCK_DATA_PATH) : defaultDataDir;

if (!existsSync(dataDir)) {
  mkdirSync(dataDir, { recursive: true });
}

export const DATA_DIR = dataDir;

export function dataPath(name) {
  return join(DATA_DIR, name);
}

export function loadJson(name, fallback) {
  const fullPath = dataPath(name);
  try {
    const content = readFileSync(fullPath, 'utf8');
    if (!content.trim()) return structuredClone(fallback);
    return JSON.parse(content);
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      return structuredClone(fallback);
    }
    throw error;
  }
}

export function saveJson(name, value) {
  const fullPath = dataPath(name);
  const serialized = JSON.stringify(value, null, 2);
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(fullPath, `${serialized}\n`, 'utf8');
  return fullPath;
}

export async function readRequestJson(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }
  if (chunks.length === 0) {
    return null;
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    throw new Error(`invalid_json: ${(error && error.message) || 'unknown'}`);
  }
}

export function json(res, statusCode, payload, extraHeaders) {
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...(extraHeaders ?? {}),
  });
  res.end(JSON.stringify(payload));
}

export function createLogger(name) {
  const prefix = `[mock-${name}]`;
  return {
    info(message, meta) {
      logWithLevel('INFO', prefix, message, meta);
    },
    warn(message, meta) {
      logWithLevel('WARN', prefix, message, meta);
    },
    error(message, meta) {
      logWithLevel('ERROR', prefix, message, meta);
    },
  };
}

function logWithLevel(level, prefix, message, meta) {
  const parts = [new Date().toISOString(), level, prefix, message];
  if (meta && Object.keys(meta).length > 0) {
    parts.push(JSON.stringify(meta));
  }
  console.log(parts.join(' '));
}

export function stableId(prefix, input) {
  const hash = createHash('sha1').update(JSON.stringify(input ?? {})).digest('hex').slice(0, 8);
  return `${prefix}-${hash}`;
}

function structuredClone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}
