/// <reference types="vitest/globals" />

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as dataClient from '../src/lib/dataClient';
import { fetchBookingSlots, confirmBooking } from '../src/lib/api';

describe('portal api helpers', () => {
  beforeEach(() => {
    vi.spyOn(dataClient, 'getJson').mockResolvedValue([]);
    vi.spyOn(dataClient, 'postJson').mockResolvedValue({
      data: {
        appointmentId: 'appt-1',
        slotId: 'slot-1',
        start: '2025-01-01T09:00:00.000Z',
        end: '2025-01-01T09:30:00.000Z',
      },
      response: {
        headers: {
          get: (name: string) => (name.toLowerCase() === 'x-correlation-id' ? 'resp-correlation' : null),
        } as unknown as Headers,
      } as Response,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses distinct cache keys per booking API base URL', async () => {
    await fetchBookingSlots({}, { baseUrl: 'https://booking-a.example' });
    await fetchBookingSlots({}, { baseUrl: 'https://booking-b.example' });

    const getJsonMock = vi.mocked(dataClient.getJson);
    const calls = getJsonMock.mock.calls;
    expect(calls).toHaveLength(2);
    const cacheKeys = calls.map(([, options]) => (options as { cacheKey?: string }).cacheKey);
    const uniqueCacheKeys = new Set(cacheKeys);
    expect(uniqueCacheKeys.size).toBe(2);
  });

  it('normalizes booking slot modalities from varied casing', async () => {
    vi.mocked(dataClient.getJson).mockResolvedValueOnce([
      {
        id: 'slot-phone',
        start: '2025-02-01T09:00:00.000Z',
        end: '2025-02-01T09:15:00.000Z',
        modality: 'PHONE',
        location: 'Clinic A',
        serviceType: 'gp-consult',
      },
      {
        id: 'slot-in-person',
        start: '2025-02-01T10:00:00.000Z',
        end: '2025-02-01T10:15:00.000Z',
        modality: 'in-person',
        serviceType: 'pharmacy',
      },
      {
        id: 'slot-ignored',
        start: '2025-02-01T11:00:00.000Z',
        end: '2025-02-01T11:15:00.000Z',
        modality: 'video',
      },
    ]);

    const slots = await fetchBookingSlots();

    expect(slots).toHaveLength(2);
    expect(slots[0]?.modality).toBe('phone');
    expect(slots[1]?.modality).toBe('in_person');
    expect(slots[0]?.serviceType).toBe('gp-consult');
    expect(slots[1]?.serviceType).toBe('pharmacy');
  });

  it('passes service type and location filters to the booking API', async () => {
    const getJsonMock = vi.mocked(dataClient.getJson);
    getJsonMock.mockResolvedValueOnce([]);

    await fetchBookingSlots(
      { serviceType: 'gp-consult', location: 'Clinic-A' },
      { baseUrl: 'https://booking.example', correlationId: 'corr-123' },
    );

    expect(getJsonMock).toHaveBeenCalledTimes(1);
    const [path] = getJsonMock.mock.calls[0] ?? [];
    expect(path).toContain('serviceType=gp-consult');
    expect(path).toContain('location=Clinic-A');
  });

  it('sends the idempotency key header using canonical casing', async () => {
    await confirmBooking(
      { slotId: 'slot-1', patientId: 'patient-1' },
      {
        idempotencyKey: 'key-123',
        baseUrl: 'https://booking.example',
      },
    );

    const postJsonMock = vi.mocked(dataClient.postJson);
    const calls = postJsonMock.mock.calls;
    expect(calls).toHaveLength(1);
    const [, options] = calls[0] ?? [];
    expect((options as { headers?: Record<string, string> }).headers?.['Idempotency-Key']).toBe('key-123');
  });
});
