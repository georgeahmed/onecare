import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { watch } from 'node:fs';
import https from 'node:https';
import { createHistogram, createCounter, startSpan, getCorrelationId, logger } from '@onecare/observability';
import { SpanStatusCode } from '@opentelemetry/api';
import { callWithGuard, type GuardOptions } from './callWithGuard';
import { URL } from 'node:url';
import { isIP } from 'node:net';

export interface GpConnectClientOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
  appointmentExecutor?: AppointmentExecutor;
  practiceId?: string;
  authHeaders?: Record<string, string>;
  httpClient?: HttpClientTransport;
  oauth?: OAuthOptions;
  mtls?: MtlsConfig;
  fetchImpl?: typeof fetch;
  interactionId?: string;
  preferHeader?: string;
  traceIdFactory?: () => string;
  additionalHeaders?: Record<string, string>;
}

export interface OAuthOptions {
  tokenUrl?: string;
  clientId?: string;
  clientSecret?: string;
  scope?: string;
  audience?: string;
  fetchToken?: () => Promise<OAuthToken>;
  refreshFraction?: number;
  clock?: () => number;
}

interface OAuthToken {
  token: string;
  expiresIn?: number;
  expiresAt?: number;
}

export interface MtlsConfig {
  certPath: string;
  keyPath: string;
  caPath?: string;
  watch?: boolean;
  reloadSignals?: NodeJS.Signals[];
}

export interface SearchSlotsParams {
  organisationId: string;
  serviceType?: string;
  startDate?: string;
  endDate?: string;
}

export interface Slot {
  slotId: string;
  start: string;
  end: string;
  organisationId: string;
  serviceType?: string;
}

export interface AppointmentRequest {
  slotId: string;
  patientId: string;
  reason: string;
  performerId?: string;
}

export interface AppointmentRef {
  appointmentId: string;
  slotId: string;
  start: string;
  end: string;
}

export interface SlotView {
  id: string;
  start: string;
  end: string;
  organisationId: string;
  serviceType?: string;
}

export type AppointmentExecutor = (request: AppointmentRequest) => Promise<AppointmentRef>;

export type GpConnectErrorCode = 'conflict' | 'unavailable' | 'unknown';

export class GpConnectClientError extends Error {
  constructor(public readonly code: GpConnectErrorCode, message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'GpConnectClientError';
  }
}

const searchLatencyHistogram = createHistogram('gp_connect_search_latency_ms');
const createLatencyHistogram = createHistogram('gp_connect_create_latency_ms');
const searchSuccessCounter = createCounter('gp_connect_search_success_total');
const searchErrorCounter = createCounter('gp_connect_search_error_total');
const createSuccessCounter = createCounter('gp_connect_create_success_total');
const createErrorCounter = createCounter('gp_connect_create_error_total');
const createConflictCounter = createCounter('gp_connect_create_conflict_total');
const authRefreshSuccessCounter = createCounter('gp_connect_auth_refresh_success_total');
const authRefreshErrorCounter = createCounter('gp_connect_auth_refresh_error_total');
const certReloadSuccessCounter = createCounter('gp_connect_cert_reload_success_total');
const certReloadErrorCounter = createCounter('gp_connect_cert_reload_error_total');

export interface GpConnectClient {
  searchSlots(params: SearchSlotsParams): Promise<Slot[]>;
  createAppointment(request: AppointmentRequest): Promise<AppointmentRef>;
  checkHealth?(): Promise<{ ok: boolean; reason?: string }>;
}

interface HttpRequestContext<TBody = unknown> {
  url: URL;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: TBody;
  signal: AbortSignal;
  agent?: https.Agent;
}

interface HttpResponse<T> {
  status: number;
  headers: Record<string, string>;
  body: T;
}

interface HttpClientTransport {
  searchSlots(context: HttpRequestContext<SearchSlotsParams>): Promise<HttpResponse<Slot[]>>;
  createAppointment(context: HttpRequestContext<AppointmentRequest>): Promise<HttpResponse<AppointmentRef>>;
}

export class GpConnectHttpClient implements GpConnectClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly practiceId?: string;
  private readonly authHeaders: Record<string, string>;
  private readonly additionalHeaders: Record<string, string>;
  private readonly httpClient: HttpClientTransport;
  private readonly tokenManager?: AccessTokenManager;
  private readonly mtlsManager?: MtlsAgentManager;
  private readonly fetchImpl: typeof fetch;
  private readonly interactionId?: string;
  private readonly preferHeader?: string;
  private readonly traceIdFactory: () => string;

  constructor(options: GpConnectClientOptions) {
    assertSafeEndpoint(options.baseUrl);
    this.baseUrl = options.baseUrl;
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.practiceId = options.practiceId;
    this.authHeaders = buildAuthHeaders(options.apiKey, options.authHeaders);
    this.additionalHeaders = { ...(options.additionalHeaders ?? {}) };
    this.httpClient = options.httpClient ?? new DefaultHttpClientTransport(options.appointmentExecutor);
    this.fetchImpl = options.fetchImpl ?? (globalThis.fetch?.bind(globalThis) as typeof fetch);
    this.interactionId = options.interactionId;
    this.preferHeader = options.preferHeader ?? 'return=representation';
    this.traceIdFactory = options.traceIdFactory ?? (() => randomUUID());

    if (options.oauth) {
      this.tokenManager = new AccessTokenManager({
        ...options.oauth,
        fetchImpl: this.fetchImpl,
      });
    }

    if (options.mtls) {
      this.mtlsManager = new MtlsAgentManager(options.mtls);
    }
  }

  private guardOptions(operation: 'search' | 'create'): GuardOptions {
    const baseDelay = Math.max(50, Math.floor(this.timeoutMs * 0.1));
    return {
      timeoutMs: this.timeoutMs,
      baseDelayMs: baseDelay,
      maxRetries: operation === 'search' ? 1 : 0,
      correlationId: getCorrelationId(),
    };
  }

  private async guardCall<T>(operation: 'search' | 'create', handler: (signal: AbortSignal) => Promise<T>): Promise<T> {
    return callWithGuard(`gpconnect.${operation}`, handler, this.guardOptions(operation));
  }

  static fromEnv(): GpConnectHttpClient {
    const baseUrl = process.env.GP_CONNECT_URL?.trim();
    const apiKey = process.env.GP_CONNECT_API_KEY?.trim();
    if (!baseUrl) throw new Error('gp_connect_url_missing');
    if (!apiKey) throw new Error('gp_connect_api_key_missing');

    const timeoutMs = Number(process.env.GP_CONNECT_TIMEOUT_MS ?? '5000');
    const headerName = process.env.GP_CONNECT_AUTH_HEADER_NAME?.trim();
    const headerValue = process.env.GP_CONNECT_AUTH_HEADER_VALUE?.trim();
    const authHeaders = headerName && headerValue ? { [headerName]: headerValue } : undefined;
    const practiceId = process.env.GP_CONNECT_PRACTICE_ID?.trim();
    const interactionId = process.env.GP_CONNECT_INTERACTION_ID?.trim();
    const preferHeader = process.env.GP_CONNECT_PREFER?.trim();

    const additionalHeaders: Record<string, string> = {};
    const preferEnvironmentHeader = process.env.GP_CONNECT_EXTRA_HEADERS;
    if (preferEnvironmentHeader) {
      try {
        const parsed = JSON.parse(preferEnvironmentHeader) as Record<string, unknown>;
        for (const [key, value] of Object.entries(parsed)) {
          if (typeof value === 'string' && value.trim().length > 0) {
            additionalHeaders[key] = value.trim();
          }
        }
      } catch {
        logger.warn('gpconnect.env.extra_headers_invalid', { value: preferEnvironmentHeader });
      }
    }

    const oauth: OAuthOptions | undefined = (() => {
      if (process.env.GP_CONNECT_TOKEN_URL && process.env.GP_CONNECT_CLIENT_ID && process.env.GP_CONNECT_CLIENT_SECRET) {
        return {
          tokenUrl: process.env.GP_CONNECT_TOKEN_URL,
          clientId: process.env.GP_CONNECT_CLIENT_ID,
          clientSecret: process.env.GP_CONNECT_CLIENT_SECRET,
          scope: process.env.GP_CONNECT_TOKEN_SCOPE,
          audience: process.env.GP_CONNECT_TOKEN_AUDIENCE,
          refreshFraction: Number(process.env.GP_CONNECT_TOKEN_REFRESH_FRACTION ?? '') || undefined,
        };
      }
      return undefined;
    })();

    const mtls: MtlsConfig | undefined = (() => {
      const certPath = process.env.GP_CONNECT_MTLS_CERT_PATH?.trim();
      const keyPath = process.env.GP_CONNECT_MTLS_KEY_PATH?.trim();
      if (!certPath || !keyPath) return undefined;
      const signals = process.env.GP_CONNECT_MTLS_RELOAD_SIGNALS
        ? process.env.GP_CONNECT_MTLS_RELOAD_SIGNALS.split(',').map((entry) => entry.trim()).filter(Boolean)
        : undefined;
      return {
        certPath,
        keyPath,
        caPath: process.env.GP_CONNECT_MTLS_CA_PATH?.trim(),
        watch: parseBoolean(process.env.GP_CONNECT_MTLS_WATCH),
        reloadSignals: signals as NodeJS.Signals[] | undefined,
      };
    })();

    return new GpConnectHttpClient({
      baseUrl,
      apiKey,
      timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : 5_000,
      authHeaders,
      practiceId: practiceId || undefined,
      oauth,
      mtls,
      interactionId: interactionId || undefined,
      preferHeader: preferHeader || undefined,
      additionalHeaders: Object.keys(additionalHeaders).length > 0 ? additionalHeaders : undefined,
    });
  }

  async searchSlots(params: SearchSlotsParams): Promise<Slot[]> {
    const attributes = buildMetricAttributes('search', this.practiceId, params.organisationId);
    const span = startSpan('gpconnect.search', {
      attributes: {
        'gpconnect.operation': 'search_slots',
        'gpconnect.base_url': this.baseUrl,
        'gpconnect.organisation_id': params.organisationId ?? 'unknown',
        'gpconnect.practice_id': this.practiceId ?? 'unknown',
      },
    });
    const startedAt = performance.now();
    try {
      const response = await this.guardCall('search', async (signal) => {
        const context = await this.prepareSearchRequest(params, signal);
        return this.httpClient.searchSlots(context);
      });
      this.ensureFhirResponse('search', response.headers);
      recordLatency(searchLatencyHistogram, startedAt, attributes);
      searchSuccessCounter.add(1, attributes);
      span.setStatus({ code: SpanStatusCode.OK });
      span.end();
      logger.info('gpconnect.search.success', {
        durationMs: performance.now() - startedAt,
        organisationId: params.organisationId,
        practiceId: this.practiceId,
        correlationId: getCorrelationId(),
      });
      return response.body;
    } catch (error) {
      recordLatency(searchLatencyHistogram, startedAt, attributes);
      searchErrorCounter.add(1, attributes);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
      span.end();
      logger.error('gpconnect.search.error', {
        reason: (error as Error).message,
        organisationId: params.organisationId,
        practiceId: this.practiceId,
        correlationId: getCorrelationId(),
      });
      throw error;
    }
  }

  async createAppointment(request: AppointmentRequest): Promise<AppointmentRef> {
    let attempt = 0;
    let lastError: unknown;
    const attributes = buildMetricAttributes('create', this.practiceId, request.performerId ?? request.slotId);

    while (attempt < 2) {
      const span = startSpan('gpconnect.create_appointment', {
        attributes: {
          'gpconnect.operation': 'create_appointment',
          'gpconnect.base_url': this.baseUrl,
          'gpconnect.slot_id': request.slotId,
          'gpconnect.practice_id': this.practiceId ?? 'unknown',
        },
      });
      const startedAt = performance.now();
      try {
        const response = await this.guardCall('create', async (signal) => {
          const context = await this.prepareCreateRequest(request, signal);
          return this.httpClient.createAppointment(context);
        });
        this.ensureFhirResponse('create', response.headers);
        recordLatency(createLatencyHistogram, startedAt, attributes);
        createSuccessCounter.add(1, attributes);
        span.setStatus({ code: SpanStatusCode.OK });
        span.end();
        logger.info('gpconnect.create.success', {
          slotId: request.slotId,
          appointmentId: response.body.appointmentId,
          practiceId: this.practiceId,
          correlationId: getCorrelationId(),
          durationMs: performance.now() - startedAt,
        });
        return response.body;
      } catch (error) {
        lastError = error;
        const conflict = isConflictError(error);
        recordLatency(createLatencyHistogram, startedAt, attributes);
        if (conflict) {
          createConflictCounter.add(1, attributes);
          logger.warn('gpconnect.create.conflict', {
            slotId: request.slotId,
            attempt,
            practiceId: this.practiceId,
            correlationId: getCorrelationId(),
          });
        } else {
          createErrorCounter.add(1, attributes);
          logger.error('gpconnect.create.error', {
            slotId: request.slotId,
            reason: (error as Error).message,
            practiceId: this.practiceId,
            correlationId: getCorrelationId(),
          });
        }

        if (conflict && attempt === 0) {
          const backoffMs = Math.min(200, Math.max(50, this.timeoutMs * 0.05));
          await delay(backoffMs + Math.random() * 25);
          attempt += 1;
          span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
          span.end();
          continue;
        }
        const mapped = mapToClientError(error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: mapped.message });
        span.end();
        throw mapped;
      }
    }

    throw mapToClientError(lastError);
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  getTimeoutMs(): number {
    return this.timeoutMs;
  }

  getApiKey(): string {
    return this.apiKey;
  }

  getAuthHeaders(): Record<string, string> {
    return { ...this.authHeaders };
  }

  async checkHealth(): Promise<{ ok: boolean; reason?: string }> {
    if (!this.fetchImpl) {
      return { ok: true };
    }
    let healthUrl: URL;
    try {
      healthUrl = new URL('/metadata', this.baseUrl);
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }

    const controller = new AbortController();
    const timeout = Math.min(this.timeoutMs, 3_000);
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const headers = await this.buildHeaders('GET');
      const response = await this.fetchImpl(healthUrl.toString(), {
        method: 'GET',
        headers,
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (response.status === 401 || response.status === 403) {
        return { ok: false, reason: 'unauthorized' };
      }
      if (response.ok) {
        return { ok: true };
      }
      return { ok: false, reason: `status_${response.status}` };
    } catch (error) {
      clearTimeout(timer);
      if (error instanceof Error && error.name === 'AbortError') {
        return { ok: false, reason: 'timeout' };
      }
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  async forceRefreshToken(): Promise<void> {
    await this.tokenManager?.forceRefresh();
  }

  async forceReloadCertificates(): Promise<void> {
    await this.mtlsManager?.reload();
  }

  private async prepareSearchRequest(params: SearchSlotsParams, signal: AbortSignal): Promise<HttpRequestContext<SearchSlotsParams>> {
    const url = new URL('/Slot', this.baseUrl);
    url.searchParams.set('_count', '20');
    if (params.organisationId) {
      url.searchParams.set('schedule.actor', params.organisationId);
    }
    if (params.serviceType) {
      url.searchParams.set('service-type', params.serviceType);
    }
    if (params.startDate) {
      url.searchParams.set('start', params.startDate);
    }
    if (params.endDate) {
      url.searchParams.set('end', params.endDate);
    }
    const headers = await this.buildHeaders('GET');
    return {
      url,
      method: 'GET',
      headers,
      body: params,
      signal,
      agent: this.mtlsManager?.getAgent(),
    };
  }

  private async prepareCreateRequest(request: AppointmentRequest, signal: AbortSignal): Promise<HttpRequestContext<AppointmentRequest>> {
    const url = new URL('/Appointment', this.baseUrl);
    const headers = await this.buildHeaders('POST');
    return {
      url,
      method: 'POST',
      headers,
      body: request,
      signal,
      agent: this.mtlsManager?.getAgent(),
    };
  }

  private async buildHeaders(method: 'GET' | 'POST'): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      Accept: 'application/fhir+json',
    };
    if (method !== 'GET') {
      headers['Content-Type'] = 'application/fhir+json; charset=utf-8';
    }
    const traceId = this.traceIdFactory();
    if (traceId) {
      headers['Ssp-TraceID'] = traceId;
    }
    if (this.interactionId) {
      headers['Ssp-InteractionID'] = this.interactionId;
    }
    if (this.preferHeader) {
      headers.Prefer = this.preferHeader;
    }
    Object.assign(headers, this.authHeaders);
    Object.assign(headers, this.additionalHeaders);

    if (this.tokenManager) {
      const token = await this.tokenManager.getToken();
      headers.Authorization = `Bearer ${token}`;
    }
    return headers;
  }

  private ensureFhirResponse(operation: string, rawHeaders: Record<string, string>): void {
    const contentType = getHeaderValue(rawHeaders, 'content-type');
    if (!contentType || !contentType.toLowerCase().includes('application/fhir+json')) {
      logger.error('gpconnect.response.invalid_content_type', { operation, contentType });
      throw new GpConnectClientError('unknown', 'Unexpected content-type from GP Connect', contentType);
    }
    const version = getHeaderValue(rawHeaders, 'ssp-version') ?? getHeaderValue(rawHeaders, 'x-gp-connect-version');
    if (version) {
      logger.debug('gpconnect.response.version', { operation, version });
    }
  }
}

class AccessTokenManager {
  private currentToken: { value: string; expiresAt: number } | null = null;
  private refreshing: Promise<string> | null = null;

  constructor(private readonly options: OAuthOptions & { fetchImpl?: typeof fetch }) {}

  async getToken(): Promise<string> {
    const now = (this.options.clock ?? Date.now)();
    if (this.currentToken && now < this.currentToken.expiresAt) {
      return this.currentToken.value;
    }
    if (!this.refreshing) {
      this.refreshing = this.refreshToken().finally(() => {
        this.refreshing = null;
      });
    }
    return this.refreshing;
  }

  async forceRefresh(): Promise<void> {
    this.currentToken = null;
    await this.getToken();
  }

  private async refreshToken(): Promise<string> {
    try {
      const token = await this.fetchToken();
      const now = (this.options.clock ?? Date.now)();
      const expiresAt = this.resolveExpiry(token, now);
      this.currentToken = { value: token.token, expiresAt };
      authRefreshSuccessCounter.add(1);
      logger.info('gpconnect.oauth.refresh.success', {
        expiresAt,
      });
      return token.token;
    } catch (error) {
      authRefreshErrorCounter.add(1);
      logger.error('gpconnect.oauth.refresh.error', {
        reason: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private resolveExpiry(token: OAuthToken, now: number): number {
    if (token.expiresAt && Number.isFinite(token.expiresAt)) {
      const margin = Math.max(5_000, Math.floor((token.expiresAt - now) * (this.options.refreshFraction ?? 0.85)));
      return token.expiresAt - margin;
    }
    const lifetimeMs = (token.expiresIn ?? 3600) * 1000;
    const refreshFraction = this.options.refreshFraction ?? 0.85;
    const refreshWindow = Math.max(5_000, Math.floor(lifetimeMs * refreshFraction));
    return now + (lifetimeMs - refreshWindow);
  }

  private async fetchToken(): Promise<OAuthToken> {
    if (typeof this.options.fetchToken === 'function') {
      return this.options.fetchToken();
    }
    if (!this.options.tokenUrl || !this.options.clientId || !this.options.clientSecret) {
      throw new Error('gpconnect_oauth_configuration_missing');
    }

    const form = new URLSearchParams();
    form.set('grant_type', 'client_credentials');
    form.set('client_id', this.options.clientId);
    form.set('client_secret', this.options.clientSecret);
    if (this.options.scope) {
      form.set('scope', this.options.scope);
    }
    if (this.options.audience) {
      form.set('audience', this.options.audience);
    }

    const response = await (this.options.fetchImpl ?? fetch)(this.options.tokenUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: form.toString(),
    });
    if (!response.ok) {
      throw new Error(`token_request_failed_${response.status}`);
    }
    const json = (await response.json()) as { access_token?: string; expires_in?: number };
    if (!json.access_token) {
      throw new Error('token_response_missing_access_token');
    }
    return {
      token: json.access_token,
      expiresIn: json.expires_in,
    };
  }
}

class MtlsAgentManager {
  private agent?: https.Agent;
  private readonly watchers: fs.FSWatcher[] = [];

  constructor(private readonly config: MtlsConfig) {
    void this.reload().catch((error) => {
      logger.warn('gpconnect.mtls.initial_load_failed', {
        reason: error instanceof Error ? error.message : String(error),
      });
    });
    if (config.watch) {
      this.registerWatchers();
    }
    this.registerSignals();
  }

  getAgent(): https.Agent | undefined {
    return this.agent;
  }

  async reload(): Promise<void> {
    try {
      const [cert, key, ca] = await Promise.all([
        fs.readFile(this.config.certPath, 'utf8'),
        fs.readFile(this.config.keyPath, 'utf8'),
        this.config.caPath ? fs.readFile(this.config.caPath, 'utf8') : Promise.resolve(undefined),
      ]);
      this.agent = new https.Agent({
        cert,
        key,
        ca,
        keepAlive: true,
      });
      certReloadSuccessCounter.add(1);
      logger.info('gpconnect.mtls.reload.success', {
        certPath: this.config.certPath,
        keyPath: this.config.keyPath,
        caPath: this.config.caPath ?? null,
      });
    } catch (error) {
      certReloadErrorCounter.add(1);
      logger.error('gpconnect.mtls.reload.error', {
        reason: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private registerSignals(): void {
    const signals = this.config.reloadSignals && this.config.reloadSignals.length > 0 ? this.config.reloadSignals : ['SIGHUP'];
    for (const signal of signals) {
      process.on(signal, () => {
        void this.reload();
      });
    }
  }

  private registerWatchers(): void {
    const paths = [this.config.certPath, this.config.keyPath, this.config.caPath].filter((value): value is string => Boolean(value));
    for (const path of paths) {
      const watcher = watch(path, { persistent: false }, () => {
        void this.reload();
      });
      this.watchers.push(watcher);
    }
  }
}

class DefaultHttpClientTransport implements HttpClientTransport {
  constructor(private readonly appointmentExecutor?: AppointmentExecutor) {}

  async searchSlots(context: HttpRequestContext<SearchSlotsParams>): Promise<HttpResponse<Slot[]>> {
    await ensureNotAborted(context.signal);
    await delay(5);
    const slot: Slot = {
      slotId: 'demo-slot-1',
      start: new Date().toISOString(),
      end: new Date(Date.now() + 15 * 60 * 1_000).toISOString(),
      organisationId: context.body?.organisationId ?? 'org-1',
      serviceType: context.body?.serviceType,
    };
    return {
      status: 200,
      headers: createFhirHeaders(),
      body: [slot],
    };
  }

  async createAppointment(context: HttpRequestContext<AppointmentRequest>): Promise<HttpResponse<AppointmentRef>> {
    await ensureNotAborted(context.signal);
    await delay(5);
    const executor = this.appointmentExecutor ?? defaultAppointmentExecutor;
    const body = context.body ?? {
      slotId: 'missing-slot',
      patientId: 'patient',
      reason: 'appointment',
    };
    const result = await executor(body);
    return {
      status: 201,
      headers: createFhirHeaders(),
      body: result,
    };
  }
}

export function mapSlotsToView(slots: Slot[]): SlotView[] {
  if (!Array.isArray(slots) || slots.length === 0) return [];
  return slots.map((slot) => ({
    id: slot.slotId,
    start: slot.start,
    end: slot.end,
    organisationId: slot.organisationId,
    serviceType: slot.serviceType,
  }));
}

function buildAuthHeaders(apiKey: string, overrides?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = {};
  if (apiKey) {
    headers['Ssp-Api-Key'] = apiKey;
  }
  if (overrides) {
    for (const [key, value] of Object.entries(overrides)) {
      if (value) headers[key] = value;
    }
  }
  return headers;
}

async function defaultAppointmentExecutor(request: AppointmentRequest): Promise<AppointmentRef> {
  await delay(5);
  return {
    appointmentId: `appt-${request.slotId}`,
    slotId: request.slotId,
    start: new Date().toISOString(),
    end: new Date(Date.now() + 15 * 60 * 1_000).toISOString(),
  };
}

function isConflictError(error: unknown): boolean {
  if (!error) return false;
  if (typeof error === 'object') {
    const status = (error as { status?: number }).status ?? (error as { response?: { status?: number } }).response?.status;
    if (status === 409) return true;
    const code = (error as { code?: string }).code;
    if (code?.toLowerCase() === 'conflict') return true;
  }
  if (typeof error === 'string') {
    return error.toLowerCase().includes('conflict');
  }
  return false;
}

function mapToClientError(error: unknown): GpConnectClientError {
  if (isConflictError(error)) {
    return new GpConnectClientError('conflict', 'Appointment slot already booked', error);
  }
  if (typeof error === 'object' && error) {
    const status = (error as { status?: number }).status ?? (error as { response?: { status?: number } }).response?.status;
    if (status && status >= 500) {
      return new GpConnectClientError('unavailable', 'GP Connect service unavailable', error);
    }
  }
  return new GpConnectClientError('unknown', 'GP Connect request failed', error);
}

function recordLatency(histogram: ReturnType<typeof createHistogram>, start: number, attributes: Record<string, unknown>): void {
  histogram.record(performance.now() - start, attributes);
}

function buildMetricAttributes(operation: 'search' | 'create', practiceId?: string, identifier?: string): Record<string, unknown> {
  return {
    operation,
    practiceId: practiceId ?? 'unknown',
    target: identifier ?? 'unknown',
  };
}

function assertSafeEndpoint(raw: string): void {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('gp_connect_url_invalid');
  }
  if (parsed.protocol !== 'https:') {
    throw new Error('gp_connect_url_insecure');
  }
  if (isPrivateHostname(parsed.hostname)) {
    throw new Error('gp_connect_url_private');
  }
}

function isPrivateHostname(hostname: string): boolean {
  if (!hostname) return true;
  const lower = hostname.toLowerCase();
  if (lower === 'localhost' || lower.endsWith('.local') || lower.endsWith('.internal')) {
    return true;
  }
  const ipType = isIP(hostname);
  if (ipType === 4) {
    const parts = hostname.split('.').map((part) => Number(part));
    if (parts[0] === 10) return true;
    if (parts[0] === 127) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  }
  if (ipType === 6) {
    const normalized = hostname.toLowerCase();
    if (normalized === '::1') return true;
    if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
    if (normalized.startsWith('fe80')) return true;
  }
  return false;
}

function getHeaderValue(headers: Record<string, string>, key: string): string | undefined {
  const direct = headers[key];
  if (direct) return direct;
  const lowered = key.toLowerCase();
  for (const [headerKey, value] of Object.entries(headers)) {
    if (headerKey.toLowerCase() === lowered) {
      return value;
    }
  }
  return undefined;
}

function parseBoolean(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on';
}

async function ensureNotAborted(signal: AbortSignal): Promise<void> {
  if (!signal.aborted) return;
  throw Object.assign(new Error('Request aborted'), { name: 'AbortError' });
}

function createFhirHeaders(): Record<string, string> {
  return {
    'content-type': 'application/fhir+json; charset=utf-8',
    'ssp-version': '1.5.0',
  };
}
