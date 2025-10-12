import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  GpConnectClient,
  mapSlotsToView,
  AppointmentRequest,
} from '../src/adapters/gpconnect.client';
import {
  resetMetrics,
  getHistogramRecords,
  getCounterTotal,
  setCorrelationId,
  logger,
} from '@onecare/observability';

const envBackup = { ...process.env };

describe('GpConnectClient', () => {
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
    const client = GpConnectClient.fromEnv();
    expect(client.getBaseUrl()).toBe('https://gp-connect.example');
    expect(client.getTimeoutMs()).toBe(4_000);
    expect(client.getApiKey()).toBe('demo-key');
  });

  it('searchSlots records metrics and logs success', async () => {
    const infoSpy = vi.spyOn(logger, 'info');
    const client = GpConnectClient.fromEnv();
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

    const client = new GpConnectClient({
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

    const client = new GpConnectClient({
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

    const client = new GpConnectClient({
      baseUrl: 'https://gp-connect.example',
      apiKey: 'key',
      appointmentExecutor: executor,
    });

    await expect(
      client.createAppointment({ slotId: 'slot-1', patientId: 'p', reason: 'x' }),
    ).rejects.toMatchObject({ code: 'unknown' });
    expect(getCounterTotal('gp_connect_create_error_total')).toBeGreaterThanOrEqual(1);
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
