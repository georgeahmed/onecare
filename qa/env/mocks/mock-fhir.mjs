#!/usr/bin/env node
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { URL } from 'node:url';
import { createLogger, json, loadJson, readRequestJson, saveJson, stableId } from './shared.mjs';

const port = Number.parseInt(process.env.PORT ?? '9500', 10);
const logger = createLogger(process.env.MOCK_SERVICE_NAME ?? 'fhir');
const basePath = normalizeBasePath(process.env.FHIR_BASE_PATH ?? '/fhir');

let state = { bundles: [], resources: [] };
let resourceIndex = new Map();

function normalizeBasePath(path) {
  if (!path) return '/fhir';
  return path.startsWith('/') ? path.replace(/\/$/, '') : `/${path.replace(/\/$/, '')}`;
}

function reload() {
  state = loadJson('fhir-state.json', { bundles: [], resources: [] });
  resourceIndex = new Map();
  for (const resource of state.resources ?? []) {
    if (!resource || typeof resource !== 'object') continue;
    const type = String(resource.resourceType ?? '').trim();
    const id = String(resource.id ?? '').trim();
    if (!type || !id) continue;
    resourceIndex.set(`${type}/${id}`, resource);
  }
  logger.info('reloaded fhir state', { resources: resourceIndex.size, bundles: state.bundles?.length ?? 0 });
}

reload();

function persist() {
  saveJson('fhir-state.json', state);
  reload();
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://mock.local');

    if (req.method === 'GET' && url.pathname.startsWith('/health')) {
      json(res, 200, {
        status: 'ok',
        service: 'mock-fhir',
        resources: resourceIndex.size,
        bundles: state.bundles?.length ?? 0,
        basePath,
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/__seed') {
      const payload = (await readRequestJson(req)) ?? {};
      if (!payload || typeof payload !== 'object') {
        json(res, 400, { error: 'invalid_seed_payload' });
        return;
      }
      const resources = Array.isArray(payload.resources) ? payload.resources : [];
      const bundles = Array.isArray(payload.bundles) ? payload.bundles : [];
      state = {
        bundles,
        resources,
      };
      persist();
      json(res, 202, {
        status: 'seeded',
        resources: resourceIndex.size,
        bundles: state.bundles?.length ?? 0,
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === basePath) {
      const body = (await readRequestJson(req)) ?? {};
      if (!body || body.resourceType !== 'Bundle' || body.type !== 'transaction') {
        json(res, 400, { error: 'invalid_bundle' });
        return;
      }
      const entries = Array.isArray(body.entry) ? body.entry : [];
      const responseEntries = [];
      for (const entry of entries) {
        const resource = entry?.resource;
        if (!resource || typeof resource !== 'object') {
          responseEntries.push({ response: { status: '400' } });
          continue;
        }
        const type = String(resource.resourceType ?? '').trim() || 'Basic';
        if (!resource.id) {
          resource.id = resource.identifier?.value ?? stableId(type.toLowerCase(), resource);
        }
        const versionId = resource.meta?.versionId ?? randomUUID();
        resource.meta = {
          ...(resource.meta ?? {}),
          versionId,
          lastUpdated: new Date().toISOString(),
        };
        const key = `${type}/${resource.id}`;
        resourceIndex.set(key, resource);
        state.resources = Array.from(resourceIndex.values());
        responseEntries.push({
          response: {
            status: '201',
            location: `${type}/${resource.id}/_history/${versionId}`,
            etag: `W/\"${versionId}\"`,
          },
        });
      }
      state.bundles = state.bundles ?? [];
      state.bundles.push({
        id: body.id ?? randomUUID(),
        timestamp: new Date().toISOString(),
        entryCount: entries.length,
      });
      persist();
      json(
        res,
        200,
        {
          resourceType: 'Bundle',
          type: 'transaction-response',
          total: responseEntries.length,
          entry: responseEntries,
        },
        { 'content-location': `${basePath}` }
      );
      return;
    }

    if (req.method === 'GET' && url.pathname.startsWith(`${basePath}/`)) {
      const [, , type, id] = url.pathname.split('/', 4);
      if (!type || !id) {
        json(res, 404, { error: 'not_found' });
        return;
      }
      const key = `${type}/${id}`;
      const resource = resourceIndex.get(key);
      if (!resource) {
        json(res, 404, { error: 'not_found' });
        return;
      }
      json(res, 200, resource);
      return;
    }

    json(res, 404, { error: 'not_found', path: url.pathname });
  } catch (error) {
    logger.error('request failed', { error: error?.message });
    json(res, 500, { error: 'mock_failure', message: error?.message ?? 'unknown' });
  }
});

server.listen(port, () => {
  logger.info('listening', { port, basePath });
});
