import { BaseState } from '@onecare/statekit';
import type { MachineContext, MachineEvent } from '@onecare/statekit';
import type { GpConnectClient } from '../adapters/gpconnect.client';
import { mapSlotsToView, type SlotView } from '../adapters/gpconnect.client';
import type { EnhancedAccessPolicy, RejectedSlot } from './enhancedAccess';
import { applyEnhancedAccessFilters } from './enhancedAccess';
import type { FhirRepository } from '@onecare/ports';
import type { QueueNotifier } from '@onecare/ports';
import { logger } from '@onecare/observability';

export interface BookingAuditPublisher {
  emit(event: { type: string; payload: Record<string, unknown> }): Promise<void>;
}

export interface BookingContext extends MachineContext {
  client: GpConnectClient;
  searchParams?: Record<string, unknown>;
  slots?: SlotView[];
  selectedSlot?: SlotView;
  appointmentConfirmation?: { appointmentId: string; slotId: string };
  patientId?: string;
  narrative?: string;
  enhancedAccessPolicy?: EnhancedAccessPolicy;
  rejectedSlots?: RejectedSlot[];
  fhirRepository?: FhirRepository;
  originatingTaskId?: string;
  queueNotifier?: QueueNotifier;
  queueName?: string;
  auditPublisher?: BookingAuditPublisher;
  correlationId?: string;
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
    const slots = mapSlotsToView(response);
    if (ctx.enhancedAccessPolicy) {
      const result = applyEnhancedAccessFilters(slots, ctx.enhancedAccessPolicy);
      ctx.slots = result.accepted;
      ctx.rejectedSlots = result.rejected;
    } else {
      ctx.slots = slots;
      ctx.rejectedSlots = [];
    }
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
    await persistAppointment(ctx, confirmation);
    await notifyQueue(ctx, confirmation);
    await emitAudit(ctx, confirmation);
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

async function persistAppointment(
  ctx: BookingContext,
  confirmation: { appointmentId: string; slotId: string },
): Promise<void> {
  const repo = ctx.fhirRepository;
  if (!repo) {
    logger.info('booking.no_fhir_repository_configured', {
      appointmentId: confirmation.appointmentId,
      correlationId: ctx.correlationId,
    });
    return;
  }

  const appointmentResource = {
    resourceType: 'Appointment',
    id: confirmation.appointmentId,
    status: 'booked',
    start: ctx.selectedSlot?.start,
    end: ctx.selectedSlot?.end,
    participant: [
      { actor: { reference: `Patient/${ctx.patientId}` }, status: 'accepted' },
    ],
  };

  let appointmentRef: { id: string; resourceType: string } | undefined;
  try {
    appointmentRef = await repo.createAppointment(appointmentResource);
  } catch (error) {
    throw new Error(`appointment_write_failed:${(error as Error).message}`);
  }

  if (repo.updateTask && ctx.originatingTaskId) {
    const patch = {
      resourceType: 'Task',
      id: ctx.originatingTaskId,
      status: 'completed',
      output: [
        {
          type: { text: 'appointment' },
          valueReference: { reference: `Appointment/${appointmentRef.id}` },
        },
      ],
    };
    try {
      await repo.updateTask(ctx.originatingTaskId, patch);
    } catch (error) {
      logger.warn('booking.task_update_failed', {
        taskId: ctx.originatingTaskId,
        correlationId: ctx.correlationId,
        reason: (error as Error).message,
      });
    }
  }
}

async function notifyQueue(
  ctx: BookingContext,
  confirmation: { appointmentId: string; slotId: string },
): Promise<void> {
  if (!ctx.queueNotifier) return;
  const payload = {
    appointmentId: confirmation.appointmentId,
    slotId: confirmation.slotId,
    patientId: ctx.patientId,
    slot: ctx.selectedSlot,
  };
  const queue = ctx.queueName ?? 'booking.notifications';
  await ctx.queueNotifier.notify(queue, payload);
}

async function emitAudit(
  ctx: BookingContext,
  confirmation: { appointmentId: string; slotId: string },
): Promise<void> {
  if (!ctx.auditPublisher) return;
  await ctx.auditPublisher.emit({
    type: 'booking.appointment.created',
    payload: {
      appointmentId: confirmation.appointmentId,
      slotId: confirmation.slotId,
      patientId: ctx.patientId,
      taskId: ctx.originatingTaskId,
      correlationId: ctx.correlationId,
    },
  });
}
