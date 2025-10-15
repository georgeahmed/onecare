#!/usr/bin/env node

const { readFileSync, readdirSync } = require('node:fs');
const { join, relative } = require('node:path');
const { parse } = require('yaml');

const CONFIG_ROOT = join(__dirname, '..', '..', 'config');
const RED_FLAG_DIR = join(CONFIG_ROOT, 'red_flags');
const DEFAULT_SOURCE = 'red_flags/core.json';

function main() {
  const sources = new Map();

  const corePath = join(CONFIG_ROOT, DEFAULT_SOURCE);
  const coreFlags = loadJsonArray(corePath);
  addEntries(sources, coreFlags, DEFAULT_SOURCE);

  const yamlFiles = listYamlFiles(CONFIG_ROOT);
  for (const filePath of yamlFiles) {
    const doc = parse(readFileSync(filePath, 'utf8'));
    const additions = extractRedFlags(doc);
    if (additions.length === 0) continue;
    const rel = relative(CONFIG_ROOT, filePath);
    addEntries(sources, additions, rel);
  }

  const rows = Array.from(sources.entries())
    .sort(([a], [b]) => a.localeCompare(b));

  const output = rows.map(([flag, origin]) => ({
    flag,
    sources: Array.from(origin).sort(),
  }));

  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

function loadJsonArray(path) {
  const raw = readFileSync(path, 'utf8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`Expected array in ${path}`);
  }
  return parsed;
}

function extractRedFlags(document) {
  if (!document || typeof document !== 'object') return [];
  const values = document.red_flag_set;
  if (!Array.isArray(values)) return [];
  return values
    .filter((value) => typeof value === 'string')
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length > 0);
}

function addEntries(index, entries, source) {
  for (const entry of entries) {
    const key = entry.trim().toLowerCase();
    if (!key) continue;
    if (!index.has(key)) {
      index.set(key, new Set());
    }
    index.get(key).add(source);
  }
}

function listYamlFiles(root) {
  const results = [];
  const queue = [root];
  while (queue.length > 0) {
    const current = queue.pop();
    const entries = readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'red_flags') continue;
        queue.push(path);
      } else if (entry.isFile() && entry.name.endsWith('.yaml')) {
        results.push(path);
      }
    }
  }
  return results;
}

main();
