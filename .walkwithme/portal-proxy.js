#!/usr/bin/env node

const http = require('node:http');
const { URL } = require('node:url');
const { randomUUID, createHmac, createHash } = require('node:crypto');

const targetBase = process.env.PORTAL_PROXY_TARGET ?? 'http://127.0.0.1:3001';
const port = Number(process.env.PORTAL_PROXY_PORT ?? 4000);
const practiceId = process.env.PORTAL_PROXY_PRACTICE ?? process.env.PRACTICE_ID ?? 'demo';
const patientId = process.env.PORTAL_PROXY_PATIENT ?? 'patient-123';
const scope = process.env.PORTAL_PROXY_SCOPE ?? 'submit triage:submit booking:read';
const secret = process.env.SECURITY_SHARED_SECRET ?? 'dev-shared-secret';

const corsHeaders = (extra = {}) => ({
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'cache-control': 'no-store',
  ...extra
});

const respondWithJson = (res, status, payload, extraHeaders = {}) => {
  res.writeHead(status, corsHeaders({ 'content-type': 'application/json', ...extraHeaders }));
  res.end(JSON.stringify(payload));
};

const respondWithText = (res, status, body, extraHeaders = {}) => {
  res.writeHead(status, corsHeaders(extraHeaders));
  res.end(body);
};

const readBody = (req) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });

const toBase64Url = (buffer) =>
  buffer
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/u, '');

const signFingerprint = (fingerprint) => {
  const hmac = createHmac('sha256', secret);
  hmac.update(fingerprint);
  return toBase64Url(hmac.digest());
};

const normalizeString = (value) => (typeof value === 'string' ? value : '');

const deriveIdempotencyKey = (submission, actor) => {
  const hash = createHash('sha256');
  const base = {
    practiceId: normalizeString(submission?.practiceId),
    patientId: normalizeString(submission?.patient?.id),
    narrativeLength: submission?.narrative ? submission.narrative.length : 0,
    channel: normalizeString(submission?.channel),
    attachmentsCount: Array.isArray(submission?.attachments) ? submission.attachments.length : 0
  };
  hash.update(JSON.stringify(base));

  if (submission?.narrative) {
    const narrativeDigest = createHash('sha256').update(String(submission.narrative)).digest('hex');
    hash.update(narrativeDigest);
  }

  if (Array.isArray(submission?.attachments) && submission.attachments.length > 0) {
    const attachmentDigests = submission.attachments
      .map((attachment) => {
        const attHash = createHash('sha256');
        attHash.update(String(attachment?.contentType ?? ''));
        attHash.update('\u0000');
        attHash.update(String(attachment?.url ?? ''));
        return attHash.digest('hex');
      })
      .sort();

    for (const digest of attachmentDigests) {
      hash.update(digest);
    }
  }

  if (actor) {
    hash.update(`:${actor}`);
  }

  return hash.digest('hex');
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://localhost:${port}`);

    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders());
      res.end();
      return;
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      respondWithJson(res, 200, { status: 'ok', proxy: true, target: targetBase });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/safety-check') {
      const raw = await readBody(req);
      let submission;
      try {
        submission = JSON.parse(raw);
      } catch (error) {
        respondWithJson(res, 400, { error: 'invalid_json', detail: String(error) });
        return;
      }

      const requestId = randomUUID();
      const correlationId = randomUUID();
      const idempotencyKey = deriveIdempotencyKey(submission, patientId);
      const fingerprint = `${requestId}:${idempotencyKey}`;
      const signature = signFingerprint(fingerprint);

      const headers = {
        authorization: `Bearer ${signature}`,
        'content-type': 'application/json',
        'x-actor-type': 'patient',
        'x-actor-id': patientId,
        'x-auth-scope': scope,
        'x-request-id': requestId,
        'x-correlation-id': correlationId,
        'x-idempotency-key': idempotencyKey,
        'x-practice-id': practiceId
      };

      const upstream = await fetch(`${targetBase}/safety-check`, {
        method: 'POST',
        headers,
        body: raw
      });

      const text = await upstream.text();
      const correlation =
        upstream.headers.get('x-correlation-id') ??
        upstream.headers.get('x-idempotency-key') ??
        correlationId;

      respondWithText(res, upstream.status, text, {
        'content-type': upstream.headers.get('content-type') ?? 'application/json',
        'x-correlation-id': correlation
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/booking/slots') {
      const requestId = randomUUID();
      const correlationId = randomUUID();
      const fingerprint = `${requestId}:booking:slots`;
      const signature = signFingerprint(fingerprint);

      const upstreamUrl = new URL('/booking/slots', targetBase);
      upstreamUrl.search = url.searchParams.toString();

      const headers = {
        authorization: `Bearer ${signature}`,
        accept: 'application/json',
        'x-request-id': requestId,
        'x-correlation-id': correlationId,
        'x-actor-type': 'patient',
        'x-actor-id': patientId,
        'x-auth-scope': scope,
        'x-patient-id': url.searchParams.get('patientId') ?? patientId,
        'x-practice-id': practiceId
      };

      const upstream = await fetch(upstreamUrl, { method: 'GET', headers });
      const text = await upstream.text();
      const responseHeaders = {
        'content-type': upstream.headers.get('content-type') ?? 'application/json',
        'x-correlation-id': upstream.headers.get('x-correlation-id') ?? correlationId
      };
      const upstreamCorrelation = upstream.headers.get('x-upstream-correlation-id');
      if (upstreamCorrelation) {
        responseHeaders['x-upstream-correlation-id'] = upstreamCorrelation;
      }
      respondWithText(res, upstream.status, text, responseHeaders);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/booking/appointments') {
      const raw = await readBody(req);
      let payload;
      try {
        payload = JSON.parse(raw);
      } catch {
        payload = {};
      }

      const slotId = typeof payload?.slotId === 'string' ? payload.slotId : 'slot-demo-001';
      const appointmentId = `appt-${Date.now()}`;
      const bookingStart = typeof payload?.start === 'string' ? payload.start : new Date().toISOString();
      const bookingEnd = new Date(Date.now() + 15 * 60 * 1000).toISOString();
      const correlationId = randomUUID();

      respondWithJson(
        res,
        200,
        {
          appointmentId,
          slotId,
          start: bookingStart,
          end: bookingEnd,
          correlationId
        },
        { 'x-correlation-id': correlationId }
      );
      return;
    }

    respondWithJson(res, 404, { error: 'not_found', path: url.pathname });
  } catch (error) {
    console.error('[portal-proxy] error', error);
    respondWithJson(res, 502, { error: 'proxy_failure', detail: String(error) });
  }
});

server.listen(port, () => {
  console.log(`[portal-proxy] listening on http://127.0.0.1:${port} -> ${targetBase}`);
  console.log(`[portal-proxy] practice=${practiceId} patient=${patientId} scope="${scope}"`);
});
