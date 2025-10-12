import { describe, it, expect, vi } from 'vitest';
import type { AppointmentRequest, AppointmentConfirmation, SlotSummary } from '../src/adapters/gpconnect.client';
import { GpConnectClient } from '../src/adapters/gpconnect.client';
import type { EnhancedAccessPolicy } from '../src/application/enhancedAccess';
import { applyEnhancedAccessFilters } from '../src/application/enhancedAccess';
import {
  BookingContext,
  SearchState,
  SelectedState,
  BookedState,
  type BookingAuditPublisher,
} from '../src/application/booking.state';
import type { FhirRepository, QueueNotifier } from '@onecare/ports';

function buildClient(slots: SlotSummary[], executor: (req: AppointmentRequest) => Promise<AppointmentConfirmation>) {
  return new GpConnectClient({
    baseUrl: 'https://gp-connect.example',
    apiKey: 'key',
    appointmentExecutor: executor,
  });
}

describe('Booking state machine integration', () => {
  it('searches, selects, and books with retry-aware client', async () => {
    const slots: SlotSummary[] = [
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

    const searchClient = new GpConnectClient({
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

    const ctx: BookingContext = {
      id: 'booking-ctx',
      client: searchClient,
      patientId: 'patient-1',
      searchParams: { organisationId: 'org-1', serviceType: 'GP' },
      enhancedAccessPolicy: policy,
      fhirRepository,
      originatingTaskId: 'task-1',
      queueNotifier,
      queueName: 'booking.queue',
      auditPublisher,
      correlationId: 'corr-123',
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
    expect(searchStub).toHaveBeenCalledWith({ organisationId: 'org-1', serviceType: 'GP' });
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
  });
});
