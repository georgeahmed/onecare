#!/usr/bin/env node
import { access, cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, join } from 'node:path';

const scriptDir = new URL('.', import.meta.url).pathname.replace(/\/$/, '');
const projectRoot = resolve(scriptDir, '..', '..');
const fixtureDir = join(projectRoot, 'qa', 'fixtures', 'seeds');
const dataDir = join(projectRoot, 'qa', 'env', 'mock-data');

const SAFETY_URL = process.env.SAFETY_URL ?? 'http://127.0.0.1:5011/__seed';
const SCRIBE_URL = process.env.SCRIBE_URL ?? 'http://127.0.0.1:5012/__seed';
const FHIR_URL = process.env.FHIR_URL ?? 'http://127.0.0.1:9500/__seed';

const targets = [
  {
    name: 'safety gate',
    fixture: 'safety-decisions.json',
    dataFile: 'safety-decisions.json',
    endpoint: SAFETY_URL,
    transform: (data) => ({ decisions: data ?? [] }),
  },
  {
    name: 'scribe',
    fixture: ['scribe-transcripts.json', 'scribe-drafts.json'],
    dataFile: null,
    endpoint: SCRIBE_URL,
    buildPayload: async () => {
      const transcripts = await loadFixture('scribe-transcripts.json');
      const drafts = await loadFixture('scribe-drafts.json');
      return { transcripts, drafts };
    },
  },
  {
    name: 'fhir',
    fixture: ['fhir-resources.json', 'fhir-bundles.json'],
    dataFile: null,
    endpoint: FHIR_URL,
    buildPayload: async () => {
      const resources = await loadFixture('fhir-resources.json');
      const bundles = await loadFixture('fhir-bundles.json');
      return { resources, bundles };
    },
  },
];

async function main() {
  await mkdir(dataDir, { recursive: true });

  if (!(await pathExists(fixtureDir))) {
    log(`fixture directory ${fixtureDir} missing; only HTTP seeding will run if data already present`);
  }

  for (const target of targets) {
    if (Array.isArray(target.fixture)) {
      for (const name of target.fixture) {
        await syncFixtureFile(name);
      }
    } else if (typeof target.fixture === 'string') {
      await syncFixtureFile(target.fixture, target.dataFile ?? target.fixture);
    }
  }

  for (const target of targets) {
    const payload = target.buildPayload
      ? await target.buildPayload()
      : target.transform
        ? target.transform(await loadFixture(target.fixture))
        : await loadFixture(target.fixture);

    if (!payload) {
      log(`skipping ${target.name} seeding (no payload)`);
      continue;
    }
    if (target.name === 'safety gate' && Array.isArray(payload.decisions) && payload.decisions.length === 0) {
      log('skipping safety gate seeding (no decisions)');
      continue;
    }
    if (target.name === 'scribe' && (!Array.isArray(payload.transcripts) || payload.transcripts.length === 0) && (!Array.isArray(payload.drafts) || payload.drafts.length === 0)) {
      log('skipping scribe seeding (no transcripts or drafts)');
      continue;
    }
    if (target.name === 'fhir' && (!Array.isArray(payload.resources) || payload.resources.length === 0) && (!Array.isArray(payload.bundles) || payload.bundles.length === 0)) {
      log('skipping fhir seeding (no resources or bundles)');
      continue;
    }

    await seedEndpoint(target.name, target.endpoint, payload);
  }

  log('seeding complete');
}

async function syncFixtureFile(sourceName, destinationName = sourceName) {
  const sourcePath = join(fixtureDir, sourceName);
  const destinationPath = join(dataDir, destinationName);
  if (!(await pathExists(sourcePath))) {
    log(`fixture ${sourceName} missing; skipping file sync`);
    return;
  }
  await cp(sourcePath, destinationPath);
  log(`synced ${sourceName}`);
}

async function loadFixture(name) {
  const path = join(fixtureDir, name);
  if (!(await pathExists(path))) {
    const existing = join(dataDir, name);
    if (await pathExists(existing)) {
      const content = await readFile(existing, 'utf8');
      return parseJsonSafe(content, []);
    }
    return [];
  }
  const content = await readFile(path, 'utf8');
  const parsed = parseJsonSafe(content, []);
  const dataPath = join(dataDir, name);
  await writeFile(dataPath, JSON.stringify(parsed, null, 2) + '\n', 'utf8');
  return parsed;
}

function parseJsonSafe(raw, fallback) {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return fallback;
  try {
    return JSON.parse(trimmed);
  } catch (error) {
    throw new Error(`Invalid JSON fixture: ${error.message}`);
  }
}

async function seedEndpoint(name, url, payload) {
  if (!url) {
    log(`skipping ${name} seeding (endpoint missing)`);
    return;
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    let response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload ?? {}),
        signal: controller.signal,
      });
    } catch (error) {
      if (error && error.name === 'AbortError') {
        throw new Error('request timed out');
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
    const ok = response.ok;
    const status = `${response.status} ${response.statusText}`.trim();
    if (!ok) {
      const text = await response.text().catch(() => '<no-body>');
      throw new Error(`${status} :: ${text}`);
    }
    log(`seeded ${name} (${status})`);
  } catch (error) {
    log(`warning: failed to seed ${name}: ${error.message}`);
  }
}

async function pathExists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function log(message) {
  console.log(`[qa-env] ${message}`);
}

main().catch((error) => {
  console.error('[qa-env] seeding failed', error);
  process.exitCode = 1;
});
