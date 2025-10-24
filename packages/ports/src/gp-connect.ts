import * as https from 'node:https';
import type { IncomingHttpHeaders } from 'node:http';
import { URL } from 'node:url';
import { createHash } from 'node:crypto';
import { TLSSocket, type PeerCertificate } from 'node:tls';

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

export interface GpConnectHttpClientOptions {
  baseUrl: string;
  /**
   * Explicit allowlist for target hostnames (case-insensitive).
   * Provide entries such as `gp-connect.example` or `gp-connect.example:8443`.
   * Defaults to the hostname extracted from `baseUrl`.
   */
  allowedHosts?: string[];
  /**
   * Optional SHA-256 certificate fingerprints (hex, with or without colons).
   * When provided, the client verifies the upstream certificate matches one of the pins.
   */
  pinnedFingerprints?: string[];
  /**
   * Headers applied to every outbound request (before per-request overrides).
   */
  defaultHeaders?: Record<string, string>;
  /**
   * Default timeout (ms) for outbound calls.
   */
  timeoutMs?: number;
  /**
   * Custom transport used for dispatching requests (primarily for tests).
   */
  transport?: GpConnectTransport;
  /**
   * Optional hook invoked with redacted request/response metadata.
   */
  onLog?: (entry: GpConnectLogEntry) => void;
}

export interface GpConnectRequestInit {
  method?: HttpMethod;
  headers?: Record<string, string>;
  body?: string | Buffer | Uint8Array | Record<string, unknown>;
  timeoutMs?: number;
  correlationId?: string;
}

export interface GpConnectResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: Buffer;
}

export interface GpConnectTransportRequest {
  url: URL;
  method: HttpMethod;
  headers: Record<string, string>;
  body?: Buffer;
  timeoutMs: number;
}

export interface GpConnectTransportResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: Buffer;
  fingerprint?: string;
}

export type GpConnectTransport = (request: GpConnectTransportRequest) => Promise<GpConnectTransportResponse>;

export interface GpConnectLogEntry {
  event: 'request' | 'response' | 'error';
  method: HttpMethod;
  path: string;
  statusCode?: number;
  correlationId?: string;
  headers?: Record<string, string>;
  reason?: string;
}

export interface GpConnectHealthStatus {
  ok: boolean;
  reason?: string;
  statusCode?: number;
  checkedAt: number;
}

export interface GpConnectHealthProbeOptions {
  path?: string;
  method?: HttpMethod;
  timeoutMs?: number;
}

export interface GpConnectHealthMonitorOptions extends GpConnectHealthProbeOptions {
  cacheTtlMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_HEADER_COUNT = 24;

export class GpConnectHttpClient {
  private readonly baseUrl: URL;
  private readonly allowedHosts: Set<string>;
  private readonly timeoutMs: number;
  private readonly pinnedFingerprints: Set<string> | null;
  private readonly transport: GpConnectTransport;
  private readonly defaultHeaders: Record<string, string>;
  private readonly onLog?: (entry: GpConnectLogEntry) => void;

  constructor(options: GpConnectHttpClientOptions) {
    if (!options?.baseUrl) {
      throw createClientError('gp_connect_base_url_missing', 'GP Connect baseUrl is required');
    }
    this.baseUrl = parseAndValidateBaseUrl(options.baseUrl);
    this.allowedHosts = buildAllowedHostSet(this.baseUrl, options.allowedHosts);
    this.timeoutMs = clampTimeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    this.pinnedFingerprints = normalizeFingerprintPins(options.pinnedFingerprints);
    this.defaultHeaders = normalizeHeaders(options.defaultHeaders ?? {});
    this.onLog = options.onLog;

    const agent = createHttpsAgent();
    this.transport = options.transport ?? createDefaultTransport(agent);
  }

  async request(path: string, init: GpConnectRequestInit = {}): Promise<GpConnectResponse> {
    const method = init.method ?? 'GET';
    const normalizedPath = this.normalizePath(path);
    let requestUrl: URL;
    let logPath = '';
    try {
      requestUrl = new URL(normalizedPath, this.baseUrl);
    } catch {
      const error = createClientError('gp_connect_path_invalid', 'Invalid request path');
      this.log({
        event: 'error',
        method,
        path: normalizedPath,
        correlationId: init.correlationId,
        reason: error.message,
      });
      throw error;
    }

    let correlationId = init.correlationId;
    let headers: Record<string, string> = {};
    let bodyBuffer: Buffer | undefined;
    const timeoutMs = clampTimeout(init.timeoutMs ?? this.timeoutMs);

    try {
      this.ensureAllowedHost(requestUrl);
      bodyBuffer = serializeBody(init.body);
      headers = this.composeHeaders(init.headers, init.body, bodyBuffer);
      correlationId = correlationId ?? headers['x-correlation-id'];

      logPath = sanitizeLogPath(requestUrl);

      this.log({
        event: 'request',
        method,
        path: logPath,
        correlationId,
        headers: redactHeaders(headers),
      });

      const response = await this.transport({
        url: requestUrl,
        method,
        headers,
        body: bodyBuffer,
        timeoutMs,
      });
      this.ensurePinnedFingerprint(response.fingerprint);
      const sanitizedResponseHeaders = limitHeaders(redactHeaders(response.headers));
      this.log({
        event: 'response',
        method,
        path: logPath,
        statusCode: response.statusCode,
        correlationId,
        headers: sanitizedResponseHeaders,
      });
      return {
        statusCode: response.statusCode,
        headers: response.headers,
        body: response.body,
      };
    } catch (error) {
      this.log({
        event: 'error',
        method,
        path: logPath || sanitizeLogPath(requestUrl),
        correlationId,
        reason: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private normalizePath(path: string): string {
    const trimmed = typeof path === 'string' ? path.trim() : '';
    if (!trimmed) return this.baseUrl.pathname + this.baseUrl.search;
    if (/^[a-z]+:\/\//i.test(trimmed)) {
      throw createClientError('gp_connect_path_invalid', 'Absolute URLs are not permitted');
    }
    if (trimmed.startsWith('//')) {
      return trimmed;
    }
    return trimmed;
  }

  private ensureAllowedHost(url: URL): void {
    const hostname = url.hostname.toLowerCase();
    const hostWithPort = url.port ? `${hostname}:${url.port}` : hostname;
    if (!this.allowedHosts.has(hostname) && !this.allowedHosts.has(hostWithPort)) {
      throw createClientError('gp_connect_host_blocked', `Hostname ${hostname} is not allowlisted`);
    }
  }

  private composeHeaders(
    overrideHeaders: Record<string, string> | undefined,
    body: GpConnectRequestInit['body'],
    bodyBuffer: Buffer | undefined,
  ): Record<string, string> {
    const headers: Record<string, string> = { ...this.defaultHeaders, ...normalizeHeaders(overrideHeaders ?? {}) };
    if (body !== undefined && !hasHeader(headers, 'content-type') && !Buffer.isBuffer(body) && typeof body !== 'string') {
      headers['content-type'] = 'application/json';
    }
    if (bodyBuffer) {
      headers['content-length'] = Buffer.byteLength(bodyBuffer).toString();
    }
    return headers;
  }

  private ensurePinnedFingerprint(fingerprint?: string): void {
    if (!this.pinnedFingerprints) {
      return;
    }
    if (!fingerprint) {
      throw createClientError('gp_connect_cert_missing', 'TLS certificate fingerprint unavailable');
    }
    const normalized = normalizeFingerprint(fingerprint);
    if (!this.pinnedFingerprints.has(normalized)) {
      throw createClientError('gp_connect_cert_mismatch', 'TLS certificate fingerprint mismatch');
    }
  }

  private log(entry: GpConnectLogEntry): void {
    if (!this.onLog) return;
    this.onLog(entry);
  }
}

function parseAndValidateBaseUrl(raw: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw createClientError('gp_connect_base_url_invalid', 'GP Connect baseUrl must be a valid URL');
  }
  if (parsed.protocol !== 'https:') {
    throw createClientError('gp_connect_base_url_insecure', 'GP Connect baseUrl must use HTTPS');
  }
  parsed.pathname = parsed.pathname || '/';
  if (!parsed.pathname.endsWith('/')) {
    parsed.pathname = `${parsed.pathname}/`;
  }
  return parsed;
}

function buildAllowedHostSet(baseUrl: URL, allowedHosts?: string[]): Set<string> {
  const hostSet = new Set<string>();
  const normalizedBaseHost = baseUrl.hostname.toLowerCase();
  const baseWithPort = baseUrl.port ? `${normalizedBaseHost}:${baseUrl.port}` : normalizedBaseHost;

  const sources = allowedHosts && allowedHosts.length > 0 ? allowedHosts : [baseWithPort];
  for (const entry of sources) {
    const normalized = entry.trim().toLowerCase();
    if (!normalized) {
      throw createClientError('gp_connect_allowlist_invalid', 'Allowlist entries must be non-empty');
    }
    hostSet.add(normalized);
  }

  if (!baseUrl.port && !hostSet.has(normalizedBaseHost)) {
    hostSet.add(normalizedBaseHost);
  }
  return hostSet;
}

function normalizeHeaders(headers: Record<string, string>): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!key) continue;
    const lower = key.toLowerCase();
    normalized[lower] = value;
  }
  return normalized;
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const lower = name.toLowerCase();
  return Object.prototype.hasOwnProperty.call(headers, lower);
}

function serializeBody(body: GpConnectRequestInit['body']): Buffer | undefined {
  if (body === undefined || body === null) {
    return undefined;
  }
  if (Buffer.isBuffer(body)) {
    return body;
  }
  if (body instanceof Uint8Array) {
    return Buffer.from(body);
  }
  if (typeof body === 'string') {
    return Buffer.from(body, 'utf8');
  }
  return Buffer.from(JSON.stringify(body), 'utf8');
}

function clampTimeout(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.min(Math.max(Math.floor(value), 100), 30_000);
}

function createHttpsAgent(): https.Agent {
  const agentOptions: https.AgentOptions = {
    keepAlive: true,
    maxSockets: 25,
    timeout: 60_000,
    rejectUnauthorized: true,
  };
  // TLS pinning is performed after the response by comparing fingerprints.
  return new https.Agent(agentOptions);
}

function createDefaultTransport(agent: https.Agent): GpConnectTransport {
  return ({ url, method, headers, body, timeoutMs }) =>
    new Promise<GpConnectTransportResponse>((resolve, reject) => {
      const options: https.RequestOptions = {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port ? Number(url.port) : undefined,
        path: `${url.pathname}${url.search}`,
        method,
        headers,
        agent,
      };

      const request = https.request(options, (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        response.on('end', () => {
          const bodyBuffer = Buffer.concat(chunks);
          const headersObject = normalizeIncomingHeaders(response.headers);
          const fingerprint = extractFingerprintFromSocket(
            response.socket instanceof TLSSocket ? response.socket.getPeerCertificate(true) : undefined,
          );
          resolve({
            statusCode: response.statusCode ?? 0,
            headers: headersObject,
            body: bodyBuffer,
            fingerprint,
          });
        });
      });

      request.setTimeout(timeoutMs, () => {
        request.destroy(createClientError('gp_connect_timeout', 'GP Connect request timed out'));
      });

      request.on('error', (error) => reject(error));

      if (body) {
        request.write(body);
      }
      request.end();
    });
}

function normalizeIncomingHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      result[key.toLowerCase()] = value.join(', ');
    } else if (value !== undefined) {
      result[key.toLowerCase()] = String(value);
    }
  }
  return result;
}

function extractFingerprintFromSocket(cert: PeerCertificate | undefined): string | undefined {
  if (!cert || !cert.raw) {
    return undefined;
  }
  const digest = createHash('sha256').update(cert.raw).digest('hex').toUpperCase();
  const pairs = digest.match(/.{2}/g);
  return pairs ? pairs.join(':') : undefined;
}

function normalizeFingerprintPins(pins: string[] | undefined): Set<string> | null {
  if (!pins || pins.length === 0) {
    return null;
  }
  const set = new Set<string>();
  for (const pin of pins) {
    set.add(normalizeFingerprint(pin));
  }
  return set;
}

function normalizeFingerprint(value: string): string {
  const hex = value.replace(/[^A-Fa-f0-9]/g, '').toUpperCase();
  if (hex.length === 0 || hex.length % 2 !== 0) {
    throw createClientError('gp_connect_fingerprint_invalid', 'Invalid certificate fingerprint value');
  }
  const pairs = hex.match(/.{2}/g);
  return pairs ? pairs.join(':') : hex;
}

function limitHeaders(headers: Record<string, string>): Record<string, string> {
  const entries = Object.entries(headers);
  if (entries.length <= MAX_HEADER_COUNT) {
    return headers;
  }
  return Object.fromEntries(entries.slice(0, MAX_HEADER_COUNT));
}

const SENSITIVE_HEADERS = new Set(['authorization', 'ssp-api-key', 'x-api-key', 'cookie', 'set-cookie']);

function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const redacted: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (SENSITIVE_HEADERS.has(key.toLowerCase())) {
      redacted[key.toLowerCase()] = '[redacted]';
    } else {
      redacted[key.toLowerCase()] = value;
    }
  }
  return redacted;
}

function createClientError(code: string, message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

export { normalizeFingerprint }; // exported for unit tests

function sanitizeLogPath(url: URL): string {
  return url.pathname || '/';
}

const DEFAULT_HEALTH_PATH = '/metadata';
const DEFAULT_HEALTH_METHOD: HttpMethod = 'GET';
const HEALTH_CACHE_MIN_MS = 250;
const HEALTH_CACHE_DEFAULT_MS = 5_000;

export async function probeGpConnectHealth(
  client: GpConnectHttpClient,
  options: GpConnectHealthProbeOptions = {},
): Promise<GpConnectHealthStatus> {
  const path = options.path ?? DEFAULT_HEALTH_PATH;
  const method = options.method ?? DEFAULT_HEALTH_METHOD;
  try {
    const response = await client.request(path, {
      method,
      timeoutMs: options.timeoutMs,
    });
    const statusCode = response.statusCode;
    if (statusCode === 401 || statusCode === 403) {
      return {
        ok: false,
        reason: 'unauthorized',
        statusCode,
        checkedAt: Date.now(),
      };
    }
    if (statusCode >= 200 && statusCode < 400) {
      return {
        ok: true,
        statusCode,
        checkedAt: Date.now(),
      };
    }
    return {
      ok: false,
      reason: `status_${statusCode}`,
      statusCode,
      checkedAt: Date.now(),
    };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
      checkedAt: Date.now(),
    };
  }
}

export class GpConnectHealthMonitor {
  private lastStatus: GpConnectHealthStatus | null = null;
  private inFlight: Promise<GpConnectHealthStatus> | null = null;
  private readonly cacheTtlMs: number;

  constructor(private readonly client: GpConnectHttpClient, private readonly options: GpConnectHealthMonitorOptions = {}) {
    const ttl = Math.floor(this.options.cacheTtlMs ?? HEALTH_CACHE_DEFAULT_MS);
    this.cacheTtlMs = Math.max(HEALTH_CACHE_MIN_MS, ttl);
  }

  async check(): Promise<GpConnectHealthStatus> {
    const now = Date.now();
    if (this.lastStatus && now - this.lastStatus.checkedAt < this.cacheTtlMs) {
      return this.lastStatus;
    }
    if (!this.inFlight) {
      this.inFlight = probeGpConnectHealth(this.client, this.options)
        .then((status) => {
          this.lastStatus = status;
          return status;
        })
        .finally(() => {
          this.inFlight = null;
        });
    }
    return this.inFlight;
  }

  invalidate(): void {
    this.lastStatus = null;
  }

  getStatus(): GpConnectHealthStatus | null {
    return this.lastStatus;
  }
}
