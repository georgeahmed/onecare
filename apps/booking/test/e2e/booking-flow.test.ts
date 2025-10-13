import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { Subscription } from '@onecare/bus';
import { MemoryBus } from '@onecare/bus';
import { Topics, type TypedEnvelope, type AppointmentCreated } from '@onecare/events';
import { StateMachine } from '@onecare/statekit';
import {
  SearchState,
  SelectedState,
  BookedState,
  WrittenBackState,
  ConfirmedState,
  type BookingContext,
  type BookingEvent,
} from '../../src/application/booking.state';
import type { GpConnectClient, Slot } from '../../src/adapters/gpconnect.client';

describe('booking flow e2e', () => {
  let bus: MemoryBus;
  let subscription: Subscription;
  let events: TypedEnvelope<AppointmentCreated>[];

  beforeEach(async () => {
    bus = new MemoryBus();
    events = [];
    subscription = await bus.subscribe<TypedEnvelope<AppointmentCreated>>(Topics.booking.appointmentCreated, (msg) => {
      events.push(msg.payload);
    });
  });

  afterEach(async () => {
    await subscription.unsubscribe();
    events = [];
    vi.clearAllMocks();
  });

  it('searches slots, books, and emits appointment.created envelope', async () => {
    const slots: Slot[] = [
      {
        slotId: 'slot-100',
        start: '2025-10-14T09:00:00Z',
        end: '2025-10-14T09:15:00Z',
        organisationId: 'org-10',
        serviceType: 'GP',
      },
    ];

    const gpClient: GpConnectClient = {
      searchSlots: vi.fn().mockResolvedValue(slots),
      createAppointment: vi.fn().mockResolvedValue({
        appointmentId: 'appt-100',
        slotId: slots[0]!.slotId,
        start: slots[0]!.start,
        end: slots[0]!.end,
      }),
    };

    const ctx: BookingContext = {
      id: 'booking-e2e',
      client: gpClient,
      patientId: 'patient-777',
      narrative: 'patient prefers morning slot',
      searchParams: {
        serviceType: 'GP',
        windowStart: '2025-10-14T08:00:00Z',
        windowEnd: '2025-10-14T12:00:00Z',
        location: 'org-10',
      },
      correlationId: 'corr-booking-e2e',
      bus,
    };

    const search = new SearchState();
    const selected = new SelectedState();
    const booked = new BookedState();
    const written = new WrittenBackState();
    const confirmed = new ConfirmedState();

    const machine = new StateMachine<BookingContext, BookingEvent>(search, ctx);
    machine.register(search);
    machine.register(selected);
    machine.register(booked);
    machine.register(written);
    machine.register(confirmed);

    await machine.start();

    await machine.dispatch({ type: 'booking.search' });
    await machine.dispatch({ type: 'booking.select', payload: { slotId: 'slot-100' } });
    await machine.dispatch({ type: 'booking.book' });

    expect(machine.state).toBe('WrittenBack');
    expect(gpClient.searchSlots).toHaveBeenCalledWith({
      organisationId: 'org-10',
      serviceType: 'GP',
      startDate: '2025-10-14T08:00:00Z',
      endDate: '2025-10-14T12:00:00Z',
    });
    expect(gpClient.createAppointment).toHaveBeenCalledWith({
      slotId: 'slot-100',
      patientId: 'patient-777',
      reason: 'patient prefers morning slot',
    });

    expect(events).toHaveLength(1);
    const [envelope] = events;
    expect(envelope.topic).toBe(Topics.booking.appointmentCreated);
    expect(envelope.correlationId).toBe('corr-booking-e2e');
    expect(envelope.payload).toMatchObject({
      appointmentId: 'appt-100',
      patientId: 'patient-777',
      start: slots[0]!.start,
      end: slots[0]!.end,
      location: 'org-10',
    });
  });
});
