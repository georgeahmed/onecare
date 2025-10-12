import { BaseState } from '@onecare/statekit';
import type { MachineContext, MachineEvent } from '@onecare/statekit';
import type { GpConnectClient } from '../adapters/gpconnect.client';
import { mapSlotsToView, type SlotView } from '../adapters/gpconnect.client';

export interface BookingContext extends MachineContext {
  client: GpConnectClient;
  searchParams?: Record<string, unknown>;
  slots?: SlotView[];
  selectedSlot?: SlotView;
  appointmentConfirmation?: { appointmentId: string; slotId: string };
  patientId?: string;
  narrative?: string;
}

export interface BookingEvent extends MachineEvent {
  type: 'booking.search' | 'booking.select' | 'booking.book' | string;
  payload?: unknown;
}

export class SearchState extends BaseState<BookingContext, BookingEvent> {
  constructor() {
    super('Search');
  }

  async handle(ctx: BookingContext, _evt: BookingEvent): Promise<string> {
    if (!ctx.client) throw new Error('gp_connect_client_missing');
    const params = ctx.searchParams ?? {};
    const response = await ctx.client.searchSlots({
      organisationId: String((params as { organisationId?: string }).organisationId ?? 'demo-org'),
      serviceType: (params as { serviceType?: string }).serviceType,
    });
    ctx.slots = mapSlotsToView(response);
    return 'Selected';
  }
}

export class SelectedState extends BaseState<BookingContext, BookingEvent> {
  constructor() {
    super('Selected');
  }

  async handle(ctx: BookingContext, evt: BookingEvent): Promise<string> {
    const slots = ctx.slots ?? [];
    if (slots.length === 0) {
      return 'Selected';
    }
    const preferredId = (evt.payload as { slotId?: string } | undefined)?.slotId;
    ctx.selectedSlot = slots.find((slot) => slot.id === preferredId) ?? slots[0];
    return 'Booked';
  }
}

export class BookedState extends BaseState<BookingContext, BookingEvent> {
  constructor() {
    super('Booked');
  }

  async handle(ctx: BookingContext, _evt: BookingEvent): Promise<string> {
    if (!ctx.client) throw new Error('gp_connect_client_missing');
    const slot = ctx.selectedSlot;
    if (!slot) {
      throw new Error('slot_not_selected');
    }
    if (!ctx.patientId) {
      throw new Error('patient_id_missing');
    }

    const confirmation = await ctx.client.createAppointment({
      slotId: slot.id,
      patientId: ctx.patientId,
      reason: ctx.narrative ?? 'booking request',
    });
    ctx.appointmentConfirmation = {
      appointmentId: confirmation.appointmentId,
      slotId: confirmation.slotId,
    };
    return 'WrittenBack';
  }
}

export class WrittenBackState extends BaseState<BookingContext, BookingEvent> {
  constructor() {
    super('WrittenBack');
  }

  async handle(_ctx: BookingContext, _evt: BookingEvent): Promise<string> {
    return 'Confirmed';
  }
}

export class ConfirmedState extends BaseState<BookingContext, BookingEvent> {
  constructor() {
    super('Confirmed');
  }

  async handle(_ctx: BookingContext, _evt: BookingEvent): Promise<string> {
    return 'Confirmed';
  }
}
