#!/usr/bin/env node
import http from 'node:http';
import { createLogger, json, loadJson, readRequestJson, saveJson, stableId } from './shared.mjs';

const port = Number.parseInt(process.env.PORT ?? '5012', 10);
const logger = createLogger(process.env.MOCK_SERVICE_NAME ?? 'scribe');

let transcripts = [];
let drafts = [];
let transcriptByCall = new Map();
let draftByCall = new Map();

function reload() {
  transcripts = loadJson('scribe-transcripts.json', []);
  drafts = loadJson('scribe-drafts.json', []);
  transcriptByCall = new Map();
  for (const entry of transcripts) {
    if (!entry) continue;
    const key = String(entry.callId ?? entry.audioId ?? '').trim();
    if (!key) continue;
    transcriptByCall.set(key, entry);
  }
  draftByCall = new Map();
  for (const entry of drafts) {
    if (!entry) continue;
    const key = String(entry.callId ?? entry.audioId ?? '').trim();
    if (!key) continue;
    draftByCall.set(key, entry);
  }
  logger.info('reloaded scribe fixtures', {
    transcripts: transcriptByCall.size,
    drafts: draftByCall.size,
  });
}

reload();

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url && req.url.startsWith('/health')) {
      json(res, 200, {
        status: 'ok',
        service: 'mock-scribe',
        transcripts: transcriptByCall.size,
        drafts: draftByCall.size,
      });
      return;
    }

    if (req.method === 'POST' && req.url === '/__seed') {
      const payload = (await readRequestJson(req)) ?? {};
      if (!payload || typeof payload !== 'object') {
        json(res, 400, { error: 'invalid_seed_payload' });
        return;
      }
      if (Array.isArray(payload.transcripts)) {
        saveJson('scribe-transcripts.json', payload.transcripts);
      }
      if (Array.isArray(payload.drafts)) {
        saveJson('scribe-drafts.json', payload.drafts);
      }
      reload();
      json(res, 202, { status: 'seeded', transcripts: transcriptByCall.size, drafts: draftByCall.size });
      return;
    }

    if (req.method === 'POST' && req.url === '/transcribe') {
      const request = (await readRequestJson(req)) ?? {};
      const key = String(request.callId ?? request.audioId ?? '').trim() || stableId('call', request);
      const entry = transcriptByCall.get(key);
      if (!entry) {
        logger.info('default transcript response', { key });
        json(res, 200, {
          callId: key,
          transcript: [{ speaker: 'PATIENT', text: request.prompt ?? 'Mock transcript available.' }],
          warnings: [],
        });
        return;
      }
      logger.info('serving seeded transcript', { key });
      json(res, 200, entry);
      return;
    }

    if (req.method === 'POST' && req.url === '/draft') {
      const request = (await readRequestJson(req)) ?? {};
      const key = String(request.callId ?? request.audioId ?? '').trim() || stableId('call', request);
      const entry = draftByCall.get(key);
      if (!entry) {
        logger.info('default draft response', { key });
        json(res, 200, {
          callId: key,
          summary: 'Mock summary indicates no acute findings. Continue routine follow-up.',
          highlights: [],
        });
        return;
      }
      logger.info('serving seeded draft', { key });
      json(res, 200, entry);
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
