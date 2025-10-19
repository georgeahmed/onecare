import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createBookingServer, type BookingServerOptions, type BookingHttpServer } from '../src/index';
import type { GpConnectClient, AppointmentRef, Slot, AppointmentRequest } from '../src/adapters/gpconnect.client';
import type { FhirRepository, QueueNotifier, IdempotencyStore } from '@onecare/ports';
import { MemoryBus } from '@onecare/bus';

describe('booking HTTP server', () => {
  let server: http.Server;
  let baseUrl: string;

  beforeEach(async () => {
    server = createBookingServer(buildOptions());
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('supports booking search and honors idempotency on booking', async () => {
    const searchResponse = await fetchJson(`${baseUrl}/booking/search`, {
      serviceType: 'GP',
      windowStart: '2025-10-14T09:00:00Z',
      windowEnd: '2025-10-14T10:00:00Z',
      location: 'org-1',
    });
    expect(searchResponse.status).toBe(200);
    const body = await searchResponse.json();
    expect(Array.isArray(body.slots)).toBe(true);

    const appointmentPayload = {
      slot: {
        id: 'slot-1',
        start: '2025-10-14T09:15:00Z',
        end: '2025-10-14T09:30:00Z',
        organisationId: 'org-1',
        serviceType: 'GP',
      },
      patientId: 'patient-123',
      narrative: 'routine checkup',
      searchParams: {
        serviceType: 'GP',
        windowStart: '2025-10-14T09:00:00Z',
        windowEnd: '2025-10-14T10:00:00Z',
        location: 'org-1',
      },
    };

    const createResponse = await fetchJson(`${baseUrl}/booking/appointments`, appointmentPayload, {
      'x-idempotency-key': 'req-1',
    });
    expect(createResponse.status).toBe(201);
    const createBody = await createResponse.json();
    expect(createBody).toMatchObject({
      appointmentId: 'appt-slot-1',
      status: 'booked',
    });

    const duplicateResponse = await fetchJson(`${baseUrl}/booking/appointments`, appointmentPayload, {
      'x-idempotency-key': 'req-1',
    });
    expect(duplicateResponse.status).toBe(409);
    const duplicateBody = await duplicateResponse.json();
    expect(duplicateBody.error.code).toBe('conflict');
  });

  it('returns 503 on /readyz when readiness fails', async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    server = createBookingServer(
      buildOptions({
        readinessCheck: async () => false,
      }),
    );
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;

    const readyResponse = await fetch(`${baseUrl}/readyz`);
    expect(readyResponse.status).toBe(503);
    const body = (await readyResponse.json()) as { ok: boolean };
    expect(body.ok).toBe(false);
  });

  it('supports graceful shutdown via initiateShutdown', async () => {
    const bookingServer = server as BookingHttpServer;
    await expect(bookingServer.initiateShutdown(100)).resolves.toBeUndefined();
  });
});

function buildOptions(overrides: Partial<BookingServerOptions> = {}): BookingServerOptions {
  const appointments = new Map<string, AppointmentRef>();

  const client: GpConnectClient = {
    async searchSlots(params) {
      return [
        {
          slotId: 'slot-1',
          start: params.startDate ?? '2025-10-14T09:15:00Z',
          end: params.endDate ?? '2025-10-14T09:30:00Z',
          organisationId: params.organisationId,
          serviceType: params.serviceType,
        },
      ];
    },
    async createAppointment(request: AppointmentRequest) {
      if (appointments.has(request.slotId)) {
        const error = new Error('conflict');
        (error as { status?: number }).status = 409;
        throw error;
      }
      const ref: AppointmentRef = {
        appointmentId: `appt-${request.slotId}`,
        slotId: request.slotId,
        start: '2025-10-14T09:15:00Z',
        end: '2025-10-14T09:30:00Z',
      };
      appointments.set(request.slotId, ref);
      return ref;
    },
  };

  const fhirRepository: FhirRepository = {
    async createAppointment(appt: unknown) {
      const appointment = appt as { id?: string; slot?: Slot };
      const id = appointment.id ?? `appt-${(appointment.slot as Slot | undefined)?.slotId ?? 'unknown'}`;
      return { id, resourceType: 'Appointment' };
    },
    async createTask() {
      return { id: 'Task/1', resourceType: 'Task' };
    },
    async upsertBundle() {
      return { resourceType: 'Bundle', type: 'transaction', entry: [] };
    },
    async createDocumentReference() {
      return { id: 'DocumentReference/1', resourceType: 'DocumentReference' };
    },
  };

  const queueNotifier: QueueNotifier = {
    notify: async () => undefined,
  };

  const auditPublisher = {
    emit: async () => undefined,
  };

  const idempotencyStore = createIdempotencyStore();

  const base: BookingServerOptions = {
    client,
    bus: new MemoryBus(),
    fhirRepository,
    queueNotifier,
    auditPublisher,
    idempotencyStore,
  };
  return { ...base, ...overrides };
}

async function fetchJson(url: string, body?: unknown, headers?: Record<string, string>): Promise<Response> {
  const init: RequestInit = {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(headers ?? {}),
    },
    body: JSON.stringify(body ?? {}),
  };
  return await fetch(url, init);
}

function createIdempotencyStore(): IdempotencyStore {
  const keys = new Map<string, number>();
  return {
    exists: async (key: string) => keys.has(key),
    put: async (key: string, ttlSeconds: number) => {
      keys.set(key, ttlSeconds);
    },
    reserve: async (key: string, ttlSeconds: number) => {
      if (keys.has(key)) return 'exists';
      keys.set(key, ttlSeconds);
      return 'reserved';
    },
    delete: async (key: string) => {
      keys.delete(key);
    },
  };
}
