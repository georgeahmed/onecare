import { describe, it, expect, vi } from 'vitest';
import type { AppointmentRequest, Slot, GpConnectClient } from '../src/adapters/gpconnect.client';
import { GpConnectHttpClient, GpConnectClientError } from '../src/adapters/gpconnect.client';
import type { EnhancedAccessPolicy } from '../src/application/enhancedAccess';
import { applyEnhancedAccessFilters } from '../src/application/enhancedAccess';
import {
  BookingContext,
  SearchState,
  SelectedState,
  BookedState,
  type BookingAuditPublisher,
} from '../src/application/booking.state';
import type { FhirRepository, QueueNotifier, IdempotencyStore } from '@onecare/ports';
import type { MessageBus, Subscription } from '@onecare/bus';
import { Topics } from '@onecare/events';

function createBusMock() {
  const publish = vi.fn().mockResolvedValue(undefined);
  const subscribe = vi.fn(async (): Promise<Subscription> => ({ unsubscribe: vi.fn() }));
  const bus: MessageBus = { publish, subscribe };
  return { bus, publish };
}

function createIdempotencyStore(): IdempotencyStore {
  const keys = new Map<string, boolean>();
  return {
    exists: async (key: string) => keys.has(key),
    put: async (key: string) => {
      keys.set(key, true);
    },
    reserve: async (key: string) => {
      if (keys.has(key)) return 'exists';
      keys.set(key, true);
      return 'reserved';
    },
    delete: async (key: string) => {
      keys.delete(key);
    },
  };
}

describe('Booking state machine integration', () => {
  it('searches, selects, and books with retry-aware client', async () => {
    const slots: Slot[] = [
      {
        slotId: 'slot-123',
        start: '2025-10-13T18:30:00+01:00',
        end: '2025-10-13T18:45:00+01:00',
        organisationId: 'org-1',
        serviceType: 'GP',
      },
    ];

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
        start: '2025-10-13T18:30:00+01:00',
        end: '2025-10-13T18:45:00+01:00',
      };
    });

    const searchClient = new GpConnectHttpClient({
      baseUrl: 'https://gp-connect.example',
      apiKey: 'key',
      appointmentExecutor: executor,
    });
    const searchStub = vi.spyOn(searchClient, 'searchSlots').mockResolvedValue(slots);
    const policy: EnhancedAccessPolicy = {
      timezone: 'Europe/London',
      windows: [
        { name: 'evening', days: [1, 2, 3, 4, 5], startMinutes: 18 * 60, endMinutes: 21 * 60 },
      ],
      allowedSlotTypes: ['GP'],
      fairness: {},
    };
    const updateTask = vi.fn().mockResolvedValue(undefined);
    const createAppointment = vi.fn().mockResolvedValue({ id: 'appt-slot-123', resourceType: 'Appointment' });
    const fhirRepository = {
      createAppointment,
      createTask: vi.fn(),
      upsertBundle: vi.fn(),
      createDocumentReference: vi.fn(),
      updateTask,
    } as unknown as FhirRepository;

    const queueNotify = vi.fn().mockResolvedValue(undefined);
    const queueNotifier: QueueNotifier = { notify: queueNotify };
    const auditEmit = vi.fn().mockResolvedValue(undefined);
    const auditPublisher: BookingAuditPublisher = { emit: auditEmit };
    const { bus, publish } = createBusMock();

    const windowStart = '2025-10-13T17:00:00Z';
    const windowEnd = '2025-10-13T22:00:00Z';

    const ctx: BookingContext = {
      id: 'booking-ctx',
      client: searchClient,
      patientId: 'patient-1',
      searchParams: { serviceType: 'GP', windowStart, windowEnd, location: 'org-1' },
      enhancedAccessPolicy: policy,
      fhirRepository,
      originatingTaskId: 'task-1',
      queueNotifier,
      queueName: 'booking.queue',
      auditPublisher,
      correlationId: 'corr-123',
      bus,
    };

    const manualFiltered = applyEnhancedAccessFilters(
      slots.map((slot) => ({
        id: slot.slotId,
        start: slot.start,
        end: slot.end,
        organisationId: slot.organisationId,
        serviceType: slot.serviceType,
      })),
      policy,
    );
    expect(manualFiltered.accepted).toHaveLength(1);

    const search = new SearchState();
    const nextAfterSearch = await search.handle(ctx, { type: 'booking.search' });
    expect(nextAfterSearch).toBe('Selected');
    expect(searchStub).toHaveBeenCalledWith({
      organisationId: 'org-1',
      serviceType: 'GP',
      startDate: windowStart,
      endDate: windowEnd,
    });
    expect(ctx.slots?.[0]?.id).toBe('slot-123');
    expect(ctx.rejectedSlots).toEqual([]);

    const select = new SelectedState();
    const nextAfterSelect = await select.handle(ctx, { type: 'booking.select' });
    expect(nextAfterSelect).toBe('Booked');
    expect(ctx.selectedSlot?.id).toBe('slot-123');

    const book = new BookedState();
    const nextAfterBook = await book.handle(ctx, { type: 'booking.book' });
    expect(nextAfterBook).toBe('WrittenBack');
    expect(ctx.appointmentConfirmation?.appointmentId).toBe('appt-slot-123');
    expect(executor).toHaveBeenCalledTimes(2);
    expect(createAppointment).toHaveBeenCalledTimes(1);
    expect(updateTask).toHaveBeenCalledWith('task-1', expect.objectContaining({ status: 'completed' }));
    expect(queueNotify).toHaveBeenCalledWith('booking.queue', expect.objectContaining({ appointmentId: 'appt-slot-123' }));
    expect(auditEmit).toHaveBeenCalledWith({
      type: 'booking.appointment.created',
      payload: expect.objectContaining({ appointmentId: 'appt-slot-123', correlationId: 'corr-123' }),
    });
    expect(publish).toHaveBeenCalledWith(
      Topics.booking.appointmentCreated,
      expect.objectContaining({
        payload: expect.objectContaining({ appointmentId: 'appt-slot-123', patientId: 'patient-1' }),
        correlationId: 'corr-123',
      }),
      { 'x-correlation-id': 'corr-123' },
    );
  });

  it('suppresses duplicate booking side-effects when idempotency key exists', async () => {
    const idempotencyStore = createIdempotencyStore();
    const createAppointment = vi
      .fn()
      .mockResolvedValue({ appointmentId: 'appt-slot-9', slotId: 'slot-9', start: '2025-01-01T09:00:00Z', end: '2025-01-01T09:15:00Z' });
    const client = {
      createAppointment: async (request: AppointmentRequest) => createAppointment(request),
      searchSlots: vi.fn(),
    } as unknown as GpConnectClient;

    const createTask = vi.fn().mockResolvedValue({ id: 'Task/1', resourceType: 'Task' });
    const createFhirAppointment = vi.fn().mockResolvedValue({ id: 'appt-slot-9', resourceType: 'Appointment' });
    const fhirRepository = {
      createTask,
      createAppointment: createFhirAppointment,
      upsertBundle: vi.fn(),
      createDocumentReference: vi.fn(),
      updateTask: vi.fn(),
    } as unknown as FhirRepository;

    const queueNotify = vi.fn().mockResolvedValue(undefined);
    const queueNotifier: QueueNotifier = { notify: queueNotify };
    const auditEmit = vi.fn().mockResolvedValue(undefined);
    const auditPublisher: BookingAuditPublisher = { emit: auditEmit };
    const { bus, publish } = createBusMock();

    const baseContext: BookingContext = {
      id: 'booking-duplicate',
      client,
      selectedSlot: { id: 'slot-9', start: '2025-01-01T09:00:00Z', end: '2025-01-01T09:15:00Z', organisationId: 'org-9' },
      patientId: 'patient-9',
      narrative: 'checkup',
      fhirRepository,
      queueNotifier,
      queueName: 'booking.queue',
      auditPublisher,
      bus,
      correlationId: 'corr-dup',
      idempotencyStore,
      idempotencyKey: 'booking:test:slot-9',
    };

    const booked = new BookedState();
    await booked.handle(baseContext, { type: 'booking.book' });

    expect(createAppointment).toHaveBeenCalledTimes(1);
    expect(queueNotify).toHaveBeenCalledTimes(1);
    expect(auditEmit).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledTimes(1);

    const duplicateContext: BookingContext = {
      ...baseContext,
      appointmentConfirmation: undefined,
    };

    await booked.handle(duplicateContext, { type: 'booking.book' });

    expect(createAppointment).toHaveBeenCalledTimes(1);
    expect(queueNotify).toHaveBeenCalledTimes(1);
    expect(auditEmit).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('throws invalid params when organisation id is missing', async () => {
    const searchClient = new GpConnectHttpClient({
      baseUrl: 'https://gp-connect.example',
      apiKey: 'key',
    });
    const ctx: BookingContext = {
      id: 'search-invalid-org',
      client: searchClient,
      patientId: 'patient-1',
      searchParams: {
        serviceType: 'GP',
        windowStart: '2025-10-13T17:00:00Z',
        windowEnd: '2025-10-13T22:00:00Z',
      },
      correlationId: 'corr-invalid-org',
    };
    const search = new SearchState();
    await expect(search.handle(ctx, { type: 'booking.search' })).rejects.toThrow(
      'booking.search.invalid_params',
    );
    expect(ctx.slots).toBeUndefined();
  });
});

describe('SearchState error handling', () => {
  it('surfaces friendly error when GP Connect is unavailable', async () => {
    const searchClient = new GpConnectHttpClient({
      baseUrl: 'https://gp-connect.example',
      apiKey: 'key',
    });
    vi.spyOn(searchClient, 'searchSlots').mockRejectedValue(
      new GpConnectClientError('unavailable', 'down'),
    );

    const ctx: BookingContext = {
      id: 'search-error',
      client: searchClient,
      patientId: 'patient-1',
      searchParams: {
        serviceType: 'GP',
        windowStart: '2025-10-13T17:00:00Z',
        windowEnd: '2025-10-13T22:00:00Z',
        location: 'org-1',
      },
      correlationId: 'corr-err',
    };

    const search = new SearchState();
    await expect(search.handle(ctx, { type: 'booking.search' })).rejects.toThrow(
      'booking.search.unavailable',
    );
    expect(ctx.slots).toBeUndefined();
  });

  it('throws invalid params when window is missing', async () => {
    const searchClient = new GpConnectHttpClient({
      baseUrl: 'https://gp-connect.example',
      apiKey: 'key',
    });
    const ctx: BookingContext = {
      id: 'search-invalid',
      client: searchClient,
      patientId: 'patient-1',
      searchParams: { serviceType: 'GP', windowStart: '2025-10-13T17:00:00Z' },
      correlationId: 'corr-invalid',
    };
    const search = new SearchState();
    await expect(search.handle(ctx, { type: 'booking.search' })).rejects.toThrow(
      'booking.search.invalid_params',
    );
  });

  it('throws invalid params when organisation id is missing', async () => {
    const searchClient = new GpConnectHttpClient({
      baseUrl: 'https://gp-connect.example',
      apiKey: 'key',
    });
    const ctx: BookingContext = {
      id: 'search-invalid-org',
      client: searchClient,
      patientId: 'patient-1',
      searchParams: {
        serviceType: 'GP',
        windowStart: '2025-10-13T17:00:00Z',
        windowEnd: '2025-10-13T22:00:00Z',
      },
      correlationId: 'corr-invalid-org',
    };
    const search = new SearchState();
    await expect(search.handle(ctx, { type: 'booking.search' })).rejects.toThrow(
      'booking.search.invalid_params',
    );
    expect(ctx.slots).toBeUndefined();
  });
});

describe('BookedState error handling', () => {
  it('refreshes slots and throws conflict-friendly error', async () => {
    const client = new GpConnectHttpClient({
      baseUrl: 'https://gp-connect.example',
      apiKey: 'key',
    });
    const conflictError = new GpConnectClientError('conflict', 'conflict');
    vi.spyOn(client, 'createAppointment').mockRejectedValue(conflictError);
    const refreshedSlot: Slot = {
      slotId: 'slot-999',
      start: '2025-10-13T19:00:00Z',
      end: '2025-10-13T19:15:00Z',
      organisationId: 'org-2',
      serviceType: 'GP',
    };
    const searchSpy = vi
      .spyOn(client, 'searchSlots')
      .mockResolvedValue([refreshedSlot]);
    const { bus, publish } = createBusMock();

    const ctx: BookingContext = {
      id: 'booking-conflict',
      client,
      patientId: 'patient-1',
      searchParams: {
        serviceType: 'GP',
        windowStart: '2025-10-13T17:00:00Z',
        windowEnd: '2025-10-13T22:00:00Z',
        location: 'org-1',
      },
      slots: [
        {
          id: 'slot-123',
          start: '2025-10-13T18:30:00Z',
          end: '2025-10-13T18:45:00Z',
          organisationId: 'org-1',
          serviceType: 'GP',
        },
      ],
      selectedSlot: {
        id: 'slot-123',
        start: '2025-10-13T18:30:00Z',
        end: '2025-10-13T18:45:00Z',
        organisationId: 'org-1',
        serviceType: 'GP',
      },
      correlationId: 'corr-conflict',
      bus,
    };

    const book = new BookedState();
    await expect(book.handle(ctx, { type: 'booking.book' })).rejects.toThrow(
      'booking.create.conflict',
    );
    expect(searchSpy).toHaveBeenCalledWith({
      organisationId: 'org-1',
      serviceType: 'GP',
      startDate: '2025-10-13T17:00:00Z',
      endDate: '2025-10-13T22:00:00Z',
    });
    expect(ctx.slots?.[0]?.id).toBe('slot-999');
    expect(publish).not.toHaveBeenCalled();
  });

  it('wraps unavailable errors from GP Connect', async () => {
    const client = new GpConnectHttpClient({
      baseUrl: 'https://gp-connect.example',
      apiKey: 'key',
    });
    vi.spyOn(client, 'createAppointment').mockRejectedValue(
      new GpConnectClientError('unavailable', 'down'),
    );
    const { bus, publish } = createBusMock();

    const ctx: BookingContext = {
      id: 'booking-unavailable',
      client,
      patientId: 'patient-1',
      searchParams: {
        serviceType: 'GP',
        windowStart: '2025-10-13T17:00:00Z',
        windowEnd: '2025-10-13T22:00:00Z',
        location: 'org-1',
      },
      slots: [
        {
          id: 'slot-123',
          start: '2025-10-13T18:30:00Z',
          end: '2025-10-13T18:45:00Z',
          organisationId: 'org-1',
          serviceType: 'GP',
        },
      ],
      selectedSlot: {
        id: 'slot-123',
        start: '2025-10-13T18:30:00Z',
        end: '2025-10-13T18:45:00Z',
        organisationId: 'org-1',
        serviceType: 'GP',
      },
      correlationId: 'corr-unavailable',
      bus,
    };

    const book = new BookedState();
    await expect(book.handle(ctx, { type: 'booking.book' })).rejects.toThrow(
      'booking.create.unavailable',
    );
    expect(publish).not.toHaveBeenCalled();
  });
});
