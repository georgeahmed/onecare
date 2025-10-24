import http from 'node:http';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { logger, setCorrelationId, createHistogram, createCounter } from '@onecare/observability';
import type { FhirRepository } from '@onecare/ports';
import type { MessageBus } from '@onecare/bus';
import type { MeshClient } from './adapters/mesh.client';
import {
  sendDocument,
  type SendDocumentCommand,
  type SendDocumentConfig,
  type SendDocumentDependencies,
  type SendDocumentResult,
  SendDocumentError,
} from './application/sendDocument';
import { validateSendDocumentRequest } from './application/contracts';
import { createErrorEnvelope as errorEnvelope, mapErrorCodeToStatus as mapErrorToStatus, type ErrorCode } from '@onecare/events';

const JSON_CONTENT_TYPE = 'application/json';
const DEFAULT_BODY_LIMIT = 256 * 1024;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000;
const DEFAULT_READINESS_CACHE_MS = 1_000;

const messagingHttpDuration = createHistogram('messaging_http_duration_ms');
const messagingHttpRequests = createCounter('messaging_http_requests_total');

export interface MessagingServerOptions {
  fhirRepository: FhirRepository;
  meshClient: MeshClient;
  bus: MessageBus;
  config: SendDocumentConfig;
  fetcher?: SendDocumentDependencies['fetcher'];
  now?: () => Date;
  readinessCheck?: () => Promise<boolean>;
}

export interface MessagingHttpServer extends http.Server {
  initiateShutdown(timeoutMs?: number): Promise<void>;
}

interface ReadinessStatus {
  ok: boolean;
  checkedAt: number;
  reason?: string;
}

interface ReadinessManager {
  check(): Promise<ReadinessStatus>;
  markShutdown(): void;
  isShuttingDown(): boolean;
  getStatus(): ReadinessStatus | null;
}

export function createMessagingServer(options: MessagingServerOptions): MessagingHttpServer {
  const server = http.createServer(async (req, res) => {
    const start = Date.now();
    const correlationId = ensureCorrelationId(req);
    setCorrelationId(correlationId);
    let outcomeRecorded = false;
    const routeLabel = req.url ? normalizePath(req.url) : 'unknown';

    const recordOutcome = (outcome: string, status: number) => {
      outcomeRecorded = true;
      const elapsed = Date.now() - start;
      messagingHttpRequests.add(1, { route: routeLabel, method: req.method ?? 'unknown', outcome });
      messagingHttpDuration.record(elapsed, { route: routeLabel, method: req.method ?? 'unknown' });
    };

    try {
      if (!req.url) {
        const status = sendError(res, 'invalid_input', 'Missing request URL', correlationId);
        recordOutcome('invalid', status);
        return;
      }
      const path = normalizePath(req.url);
      if (req.method === 'GET' && path === '/healthz') {
        const status = sendJson(res, 200, { ok: true });
        recordOutcome('success', status);
        return;
      }
      if (req.method === 'GET' && path === '/readyz') {
        const statusInfo = await readiness.check();
        const status = statusInfo.ok ? sendJson(res, 200, { ok: true }) : sendJson(res, 503, { ok: false, reason: statusInfo.reason ?? 'dependency_unavailable' });
        recordOutcome(statusInfo.ok ? 'success' : 'dependency_unavailable', status);
        return;
      }
      if (req.method === 'POST' && path === '/messaging/send-document') {
        const status = await handleSendDocument(req, res, correlationId, options);
        recordOutcome(status < 300 ? 'success' : status >= 500 ? 'server_error' : 'client_error', status);
        return;
      }

      res.statusCode = 404;
      res.end();
      recordOutcome('not_found', 404);
    } catch (error) {
      logger.error('messaging.http.unhandled', {
        reason: error instanceof Error ? error.message : 'unknown_error',
        correlationId,
      });
      const status = sendError(res, 'internal_error', 'Unexpected messaging error', correlationId);
      recordOutcome('unhandled_error', status);
    } finally {
      if (!outcomeRecorded && res.statusCode) {
        recordOutcome('unknown', res.statusCode);
      }
      setCorrelationId(undefined);
    }
  }) as MessagingHttpServer;

  const readiness = createReadinessManager(options);

  const sockets = new Set<Socket>();
  let shutdownPromise: Promise<void> | null = null;

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  server.initiateShutdown = async (timeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS) => {
    if (shutdownPromise) return shutdownPromise;
    readiness.markShutdown();
    shutdownPromise = (async () => {
      logger.warn('messaging.shutdown.start', { timeoutMs });
      const closePromise = new Promise<void>((resolve) => server.close(() => resolve()));
      const deadline = Date.now() + Math.max(0, timeoutMs);
      while (Date.now() < deadline && sockets.size > 0) {
        await sleep(50);
      }
      if (sockets.size > 0) {
        logger.warn('messaging.shutdown.force_close', { sockets: sockets.size });
        for (const socket of sockets) {
          try {
            socket.destroy();
          } catch {
            // ignore
          }
        }
      }
      await closePromise;
      logger.info('messaging.shutdown.complete');
    })().finally(() => {
      shutdownPromise = null;
    });
    return shutdownPromise;
  };

  return server;
}

function createReadinessManager(options: MessagingServerOptions): ReadinessManager {
  const cacheMs = DEFAULT_READINESS_CACHE_MS;
  let shuttingDown = false;
  let lastStatus: ReadinessStatus | null = null;
  let inflight: Promise<ReadinessStatus> | null = null;

  const runProbe = async (): Promise<ReadinessStatus> => {
    if (typeof options.readinessCheck === 'function') {
      try {
        const ok = await options.readinessCheck();
        return { ok: Boolean(ok), checkedAt: Date.now(), reason: ok ? undefined : 'dependency_unavailable' };
      } catch (error) {
        return { ok: false, checkedAt: Date.now(), reason: error instanceof Error ? error.message : 'readiness_failed' };
      }
    }
    return { ok: true, checkedAt: Date.now() };
  };

  return {
    async check(): Promise<ReadinessStatus> {
      if (shuttingDown) {
        return { ok: false, checkedAt: Date.now(), reason: 'shutting_down' };
      }
      const cached = lastStatus;
      if (cached && Date.now() - cached.checkedAt <= cacheMs) {
        return cached;
      }
      if (inflight) return inflight;
      inflight = runProbe().finally(() => {
        inflight = null;
      });
      lastStatus = await inflight;
      return lastStatus;
    },
    markShutdown(): void {
      shuttingDown = true;
      lastStatus = null;
    },
    isShuttingDown(): boolean {
      return shuttingDown;
    },
    getStatus(): ReadinessStatus | null {
      return lastStatus;
    },
  };
}

async function handleSendDocument(
  req: IncomingMessage,
  res: ServerResponse,
  correlationId: string,
  options: MessagingServerOptions,
): Promise<number> {
  try {
    enforceJsonContentType(req);
  } catch (error) {
    if (error instanceof RequestError) {
      return sendError(res, error.code, error.message, correlationId, error.details);
    }
    throw error;
  }
  const body = await readJson(req);
  const validation = validateSendDocumentRequest(body);
  if (!validation.ok) {
    return sendError(res, 'invalid_input', 'Invalid send-document request', correlationId, {
      errors: validation.errors,
    });
  }
  const command: SendDocumentCommand = {
    ...(validation.value as SendDocumentCommand),
    correlationId,
  };
  try {
    const result = await sendDocument(command, buildDependencies(options));
    return sendJson(res, 202, toResponse(result, correlationId));
  } catch (error) {
    return handleSendDocumentError(res, error, correlationId);
  }
}

function buildDependencies(options: MessagingServerOptions): SendDocumentDependencies {
  return {
    fhirRepository: options.fhirRepository,
    meshClient: options.meshClient,
    bus: options.bus,
    config: options.config,
    fetcher: options.fetcher,
    now: options.now,
  };
}

function toResponse(result: SendDocumentResult, correlationId: string) {
  return {
    status: 'accepted',
    messageId: result.messageId,
    mexLocalId: result.mexLocalId,
    taskId: result.taskReference,
    ackDueAt: result.ackDueAt,
    correlationId,
  };
}

function handleSendDocumentError(res: ServerResponse, error: unknown, correlationId: string): number {
  if (error instanceof SendDocumentError) {
    switch (error.code) {
      case 'pdf_fetch_failed':
      case 'pdf_too_large':
      case 'pdf_url_invalid':
      case 'pdf_insecure':
      case 'pdf_host_not_allowed':
      case 'pdf_content_type_invalid':
      case 'task_missing_patient':
      case 'patient_identifier_missing':
      case 'nhs_number_missing':
      case 'birthdate_missing':
      case 'surname_missing':
      case 'practice_ods_missing':
        return sendError(res, 'invalid_input', error.message, correlationId, { code: error.code });
      case 'fetch_not_available':
      case 'fhir_read_failed':
      case 'fhir_read_unsupported':
      case 'pdf_fetch_error_status':
      case 'appointment_create_failed':
      default:
        return sendError(res, 'upstream_unavailable', 'Unable to send document', correlationId, { code: error.code });
    }
  }
  logger.error('messaging.send_document.error', {
    correlationId,
    reason: error instanceof Error ? error.message : 'unknown_error',
  });
  return sendError(res, 'internal_error', 'Failed to send document', correlationId);
}

class RequestError extends Error {
  constructor(public readonly code: ErrorCode, message: string, public readonly details?: Record<string, unknown>) {
    super(message);
    this.name = 'RequestError';
  }
}

function enforceJsonContentType(req: IncomingMessage): void {
  const contentType = req.headers['content-type'];
  if (!contentType) {
    throw new RequestError('invalid_input', 'Missing content-type header');
  }
  if (Array.isArray(contentType)) {
    if (!contentType.some((value) => value.includes('application/json'))) {
      throw new RequestError('unsupported_media_type', 'Content-Type must be application/json');
    }
    return;
  }
  if (!contentType.includes('application/json')) {
    throw new RequestError('unsupported_media_type', 'Content-Type must be application/json');
  }
}

async function readJson(req: IncomingMessage, limit = DEFAULT_BODY_LIMIT): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  return new Promise<unknown>((resolve, reject) => {
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > limit) {
        reject(new RequestError('payload_too_large', 'Request body exceeds limit', { limit }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw.length > 0 ? JSON.parse(raw) : {});
      } catch {
        reject(new RequestError('invalid_input', 'Invalid JSON payload'));
      }
    });
    req.on('error', (error) => reject(error));
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): number {
  const normalized = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('content-type', JSON_CONTENT_TYPE);
  res.end(normalized);
  return status;
}

function sendError(
  res: ServerResponse,
  code: ErrorCode,
  message: string,
  correlationId: string,
  details?: Record<string, unknown>,
): number {
  const envelope = errorEnvelope(code, message, details, correlationId);
  const status = mapErrorToStatus(code);
  res.statusCode = status;
  res.setHeader('content-type', JSON_CONTENT_TYPE);
  res.end(JSON.stringify(envelope));
  return status;
}

function normalizePath(url: string): string {
  const idx = url.indexOf('?');
  return idx >= 0 ? url.slice(0, idx) : url;
}

function ensureCorrelationId(req: IncomingMessage): string {
  const header = req.headers['x-correlation-id'];
  if (typeof header === 'string' && header.trim().length > 0) return header.trim();
  if (Array.isArray(header) && header.length > 0) {
    const candidate = header[0]?.trim();
    if (candidate) return candidate;
  }
  return randomUUID();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export { sendDocument } from './application/sendDocument';
