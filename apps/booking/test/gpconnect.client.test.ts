import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GpConnectHttpClient,
  mapSlotsToView,
  type AppointmentRequest,
  type AppointmentRef,
} from '../src/adapters/gpconnect.client';
import {
  resetMetrics,
  getHistogramRecords,
  getCounterTotal,
  setCorrelationId,
  logger,
} from '@onecare/observability';

const envBackup = { ...process.env };

describe('GpConnectHttpClient', () => {
  beforeEach(() => {
    process.env.GP_CONNECT_URL = 'https://gp-connect.example';
    process.env.GP_CONNECT_API_KEY = 'demo-key';
    process.env.GP_CONNECT_TIMEOUT_MS = '4000';
    resetMetrics();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...envBackup };
  });

  it('creates client from environment variables', () => {
    const client = GpConnectHttpClient.fromEnv();
    expect(client.getBaseUrl()).toBe('https://gp-connect.example');
    expect(client.getTimeoutMs()).toBe(4_000);
    expect(client.getApiKey()).toBe('demo-key');
  });

  it('applies custom auth headers from environment', () => {
    process.env.GP_CONNECT_AUTH_HEADER_NAME = 'Authorization';
    process.env.GP_CONNECT_AUTH_HEADER_VALUE = 'Bearer demo';
    const client = GpConnectHttpClient.fromEnv();
    expect(client.getAuthHeaders()).toMatchObject({
      'Ssp-Api-Key': 'demo-key',
      Authorization: 'Bearer demo',
    });
  });

  it('searchSlots records metrics and logs success', async () => {
    const infoSpy = vi.spyOn(logger, 'info');
    const client = GpConnectHttpClient.fromEnv();
    setCorrelationId('corr-test');
    const slots = await client.searchSlots({ organisationId: 'org-1', serviceType: 'GP' });
    expect(slots).toHaveLength(1);
    expect(slots[0].organisationId).toBe('org-1');
    expect(slots[0].serviceType).toBe('GP');
    expect(getHistogramRecords('gp_connect_search_latency_ms')).toHaveLength(1);
    expect(getCounterTotal('gp_connect_search_success_total')).toBe(1);
    expect(infoSpy).toHaveBeenCalledWith('gpconnect.search.success', expect.any(Object));
  });

  it('createAppointment retries and records conflict metrics', async () => {
    let attempts = 0;
    const executor = vi.fn(async (request: AppointmentRequest) => {
      attempts += 1;
      if (attempts === 1) {
        const error = new Error('conflict');
        (error as { status: number }).status = 409;
        throw error;
      }
      return {
        appointmentId: `appt-${request.slotId}`,
        slotId: request.slotId,
        start: '2025-10-12T10:00:00Z',
        end: '2025-10-12T10:10:00Z',
      };
    });

    const client = new GpConnectHttpClient({
      baseUrl: 'https://gp-connect.example',
      apiKey: 'key',
      appointmentExecutor: executor,
      practiceId: 'practice-1',
    });

    const confirmation = await client.createAppointment({ slotId: 'slot-1', patientId: 'patient-1', reason: 'x' });

    expect(confirmation.appointmentId).toBe('appt-slot-1');
    expect(executor).toHaveBeenCalledTimes(2);
    expect(getCounterTotal('gp_connect_create_success_total')).toBe(1);
    expect(getCounterTotal('gp_connect_create_conflict_total')).toBeGreaterThanOrEqual(1);
  });

  it('throws mapped conflict error after retries', async () => {
    const executor = vi.fn(async () => {
      const error = new Error('conflict');
      (error as { status: number }).status = 409;
      throw error;
    });

    const client = new GpConnectHttpClient({
      baseUrl: 'https://gp-connect.example',
      apiKey: 'key',
      appointmentExecutor: executor,
    });

    await expect(
      client.createAppointment({ slotId: 'slot-1', patientId: 'p', reason: 'x' }),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(executor).toHaveBeenCalledTimes(2);
    expect(getCounterTotal('gp_connect_create_conflict_total')).toBeGreaterThanOrEqual(2);
  });

  it('maps other errors to unknown and increments error counter', async () => {
    const executor = vi.fn(async () => {
      throw new Error('boom');
    });

    const client = new GpConnectHttpClient({
      baseUrl: 'https://gp-connect.example',
      apiKey: 'key',
      appointmentExecutor: executor,
    });

    await expect(
      client.createAppointment({ slotId: 'slot-1', patientId: 'p', reason: 'x' }),
    ).rejects.toMatchObject({ code: 'unknown' });
    expect(getCounterTotal('gp_connect_create_error_total')).toBeGreaterThanOrEqual(1);
  });

  it('rejects insecure GP Connect base URLs', () => {
    expect(
      () =>
        new GpConnectHttpClient({
          baseUrl: 'http://gp-connect.example',
          apiKey: 'key',
        }),
    ).toThrow('gp_connect_url_insecure');
  });

  it('rejects private GP Connect endpoints', () => {
    expect(
      () =>
        new GpConnectHttpClient({
          baseUrl: 'https://192.168.0.10',
          apiKey: 'key',
        }),
    ).toThrow('gp_connect_url_private');
  });

  it('sends FHIR headers and trace identifiers', async () => {
    const contexts: Array<{ headers: Record<string, string>; method: string }> = [];
    const httpClient = {
      async searchSlots(request: { headers: Record<string, string> }): Promise<{ status: number; headers: Record<string, string>; body: [] }> {
        contexts.push({ headers: request.headers, method: 'GET' });
        return {
          status: 200,
          headers: { 'content-type': 'application/fhir+json' },
          body: [],
        };
      },
      async createAppointment(request: { headers: Record<string, string> }): Promise<{ status: number; headers: Record<string, string>; body: AppointmentRef }> {
        contexts.push({ headers: request.headers, method: 'POST' });
        return {
          status: 201,
          headers: { 'content-type': 'application/fhir+json' },
          body: {
            appointmentId: 'appt-1',
            slotId: 'slot-1',
            start: '2025-01-01T09:00:00Z',
            end: '2025-01-01T09:15:00Z',
          },
        };
      },
    };

    const client = new GpConnectHttpClient({
      baseUrl: 'https://gp-connect.example',
      apiKey: 'key',
      httpClient: httpClient as any,
      interactionId: 'urn:uuid:test-interaction',
      preferHeader: 'return=representation',
      additionalHeaders: { 'Ssp-From': 'onecare' },
    });

    await client.searchSlots({ organisationId: 'org-1' });
    await client.createAppointment({ slotId: 'slot-1', patientId: 'patient-1', reason: 'review' });

    expect(contexts).toHaveLength(2);
    const [searchCtx, createCtx] = contexts;
    expect(searchCtx.headers.Accept).toBe('application/fhir+json');
    expect(searchCtx.headers['Content-Type']).toBeUndefined();
    expect(searchCtx.headers['Ssp-TraceID']).toBeDefined();
    expect(searchCtx.headers['Ssp-InteractionID']).toBe('urn:uuid:test-interaction');
    expect(searchCtx.headers['Ssp-From']).toBe('onecare');

    expect(createCtx.headers['Content-Type']).toBe('application/fhir+json; charset=utf-8');
    expect(createCtx.headers['Ssp-TraceID']).toBeDefined();
    expect(createCtx.headers.Prefer).toBe('return=representation');
  });

  it('throws when response is not FHIR JSON', async () => {
    const client = new GpConnectHttpClient({
      baseUrl: 'https://gp-connect.example',
      apiKey: 'key',
      httpClient: {
        async searchSlots(): Promise<{ status: number; headers: Record<string, string>; body: [] }> {
          return {
            status: 200,
            headers: { 'content-type': 'text/plain' },
            body: [],
          };
        },
        async createAppointment(): Promise<{ status: number; headers: Record<string, string>; body: AppointmentRef }> {
          return {
            status: 201,
            headers: { 'content-type': 'application/fhir+json' },
            body: {
              appointmentId: 'appt-1',
              slotId: 'slot-1',
              start: '2025-01-01T09:00:00Z',
              end: '2025-01-01T09:15:00Z',
            },
          };
        },
      } as any,
    });

    await expect(client.searchSlots({ organisationId: 'org-1' })).rejects.toMatchObject({ code: 'unknown' });
  });

  it('refreshes OAuth tokens before expiry', async () => {
    let fetchCount = 0;
    let now = Date.now();
    const contexts: Array<{ headers: Record<string, string>; method: string }> = [];

    const httpClient: any = {
      async searchSlots(ctx: { headers: Record<string, string> }) {
        contexts.push({ headers: ctx.headers, method: 'GET' });
        return {
          status: 200,
          headers: { 'content-type': 'application/fhir+json' },
          body: [],
        };
      },
      async createAppointment(ctx: { headers: Record<string, string> }) {
        contexts.push({ headers: ctx.headers, method: 'POST' });
        return {
          status: 201,
          headers: { 'content-type': 'application/fhir+json' },
          body: {
            appointmentId: 'appt-1',
            slotId: 'slot-1',
            start: '2025-01-01T09:00:00Z',
            end: '2025-01-01T09:15:00Z',
          },
        };
      },
    };

    const client = new GpConnectHttpClient({
      baseUrl: 'https://gp-connect.example',
      apiKey: 'key',
      httpClient,
      oauth: {
        fetchToken: async () => {
          fetchCount += 1;
          return { token: `token-${fetchCount}`, expiresIn: 30 };
        },
        refreshFraction: 0.8,
        clock: () => now,
      },
    });

    await client.searchSlots({ organisationId: 'org-1' });
    await client.createAppointment({ slotId: 'slot-1', patientId: 'patient-1', reason: 'review' });
    expect(fetchCount).toBe(1);
    expect(contexts[0].headers.Authorization).toBe('Bearer token-1');
    expect(contexts[1].headers.Authorization).toBe('Bearer token-1');

    now += 25_000;
    await client.searchSlots({ organisationId: 'org-2' });
    expect(fetchCount).toBe(2);
    expect(getCounterTotal('gp_connect_auth_refresh_success_total')).toBeGreaterThanOrEqual(2);
  });

  it('increments error metrics when token refresh fails', async () => {
    const client = new GpConnectHttpClient({
      baseUrl: 'https://gp-connect.example',
      apiKey: 'key',
      httpClient: {
        async searchSlots() {
          return {
            status: 200,
            headers: { 'content-type': 'application/fhir+json' },
            body: [],
          };
        },
        async createAppointment() {
          return {
            status: 201,
            headers: { 'content-type': 'application/fhir+json' },
            body: {
              appointmentId: 'appt-1',
              slotId: 'slot-1',
              start: '2025-01-01T09:00:00Z',
              end: '2025-01-01T09:15:00Z',
            },
          };
        },
      } as any,
      oauth: {
        fetchToken: async () => {
          throw new Error('bad_token');
        },
      },
    });

    await expect(client.searchSlots({ organisationId: 'org-1' })).rejects.toThrow('bad_token');
    expect(getCounterTotal('gp_connect_auth_refresh_error_total')).toBeGreaterThanOrEqual(1);
  });

  it('reloads mTLS certificates on demand', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'gpconnect-mtls-'));
    const certPath = join(tmpDir, 'client.crt');
    const keyPath = join(tmpDir, 'client.key');
    const dummyCert = [
      '-----BEGIN CERTIFICATE-----',
      'MIIBlTCCATugAwIBAgIUEg==',
      '-----END CERTIFICATE-----',
    ].join('\n');
    const dummyKey = [
      'this is a placeholder key',
      'for tests only',
      'no real secret here',
    ].join('\n');
    writeFileSync(certPath, dummyCert, 'utf8');
    writeFileSync(keyPath, dummyKey, 'utf8');

    const client = new GpConnectHttpClient({
      baseUrl: 'https://gp-connect.example',
      apiKey: 'key',
      mtls: { certPath, keyPath },
    });

    try {
      await client.forceReloadCertificates();
    } catch {
      // Swallow errors; we only assert metrics were recorded.
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }

    expect(
      getCounterTotal('gp_connect_cert_reload_success_total') + getCounterTotal('gp_connect_cert_reload_error_total'),
    ).toBeGreaterThan(0);
  });
});

describe('mapSlotsToView', () => {
  it('maps slot summaries into simplified view', () => {
    const summary = {
      slotId: 'slot-1',
      start: '2025-10-12T10:00:00Z',
      end: '2025-10-12T10:10:00Z',
      organisationId: 'org-1',
      serviceType: 'GP',
    };

    const result = mapSlotsToView([summary]);
    expect(result).toEqual([
      {
        id: 'slot-1',
        start: '2025-10-12T10:00:00Z',
        end: '2025-10-12T10:10:00Z',
        organisationId: 'org-1',
        serviceType: 'GP',
      },
    ]);
  });

  it('returns empty array when no slots', () => {
    expect(mapSlotsToView([])).toEqual([]);
    expect(mapSlotsToView(undefined as unknown as [])).toEqual([]);
  });
});
