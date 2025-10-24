#!/usr/bin/env node
import http from 'node:http';
import { createLogger, json, loadJson, readRequestJson, saveJson, stableId } from './shared.mjs';

const port = Number.parseInt(process.env.PORT ?? '5011', 10);
const logger = createLogger(process.env.MOCK_SERVICE_NAME ?? 'safety-gate');

let decisions = [];
let decisionsByPatient = new Map();

function reloadDecisions() {
  decisions = loadJson('safety-decisions.json', []);
  decisionsByPatient = new Map();
  for (const entry of decisions) {
    if (!entry || typeof entry !== 'object') continue;
    const patientId = String(entry.patientId ?? entry.patient?.id ?? '').trim();
    if (!patientId) continue;
    decisionsByPatient.set(patientId, {
      outcome: entry.decision?.outcome ?? 'SAFE_TO_CONTINUE',
      reason: entry.decision?.reason ?? entry.reason ?? null,
    });
  }
  logger.info('reloaded safety decisions', { count: decisionsByPatient.size });
}

reloadDecisions();

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url && req.url.startsWith('/health')) {
      json(res, 200, { status: 'ok', service: 'mock-safety-gate', decisions: decisionsByPatient.size });
      return;
    }

    if (req.method === 'POST' && req.url === '/__seed') {
      const payload = (await readRequestJson(req)) ?? {};
      if (!payload || typeof payload !== 'object') {
        json(res, 400, { error: 'invalid_seed_payload' });
        return;
      }
      const entries = Array.isArray(payload.decisions) ? payload.decisions : [];
      saveJson('safety-decisions.json', entries);
      reloadDecisions();
      json(res, 202, { status: 'seeded', count: decisionsByPatient.size });
      return;
    }

    if (req.method === 'POST' && req.url === '/analyze') {
      const submission = (await readRequestJson(req)) ?? {};
      const patientId = String(submission?.patient?.id ?? '').trim();
      const correlationId = submission?.correlationId ?? stableId('corr', submission);
      const decision = patientId && decisionsByPatient.get(patientId);
      if (!decision) {
        logger.info('default safety decision', { patientId: patientId || 'unknown', correlationId });
        json(res, 200, { outcome: 'SAFE_TO_CONTINUE', reason: 'MOCK_ALLOW' }, { 'x-correlation-id': correlationId });
        return;
      }
      logger.info('matched seeded safety decision', { patientId, outcome: decision.outcome, correlationId });
      json(res, 200, decision, { 'x-correlation-id': correlationId });
      return;
    }

    json(res, 404, { error: 'not_found', path: req.url ?? '' });
  } catch (error) {
    logger.error('request failed', { error: error?.message });
    json(res, 500, { error: 'mock_failure', message: error?.message ?? 'unknown' });
  }
});

server.listen(port, () => {
  logger.info('listening', { port });
});
