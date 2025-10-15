import { BaseState } from '@onecare/statekit';
import type { MachineContext, MachineEvent } from '@onecare/statekit';
import {
  mapSlotsToView,
  type SlotView,
  GpConnectClientError,
} from '../adapters/gpconnect.client';
import type { GpConnectClient, SearchSlotsParams } from '../adapters/gpconnect.client';
import type { EnhancedAccessPolicy, RejectedSlot } from './enhancedAccess';
import { applyEnhancedAccessFilters } from './enhancedAccess';
import type { FhirRepository } from '@onecare/ports';
import type { QueueNotifier } from '@onecare/ports';
import type { IdempotencyStore } from '@onecare/ports';
import { executeWithIdempotency } from '@onecare/ports';
import { logger, ensureTracing } from '@onecare/observability';
import type { MessageBus } from '@onecare/bus';
import { withMessageGuards } from '@onecare/bus';
import { Topics, createEnvelope, type AppointmentCreated } from '@onecare/events';

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
  bus?: MessageBus;
  idempotencyStore?: IdempotencyStore;
  idempotencyKey?: string;
  idempotencyTtlSeconds?: number;
}

ensureTracing('booking');

const BOOKING_ALLOWED_TOPICS = new Set<string>([Topics.booking.appointmentCreated]);

export interface BookingEvent extends MachineEvent {
  type: 'booking.search' | 'booking.select' | 'booking.book' | string;
  payload?: unknown;
}

export class BookingSearchError extends Error {
  constructor(public readonly code: string, public readonly cause?: unknown) {
    super(code);
    this.name = 'BookingSearchError';
  }
}

export class BookingAppointmentError extends Error {
  constructor(public readonly code: string, public readonly cause?: unknown) {
    super(code);
    this.name = 'BookingAppointmentError';
  }
}

interface NormalizedSearchParams {
  organisationId: string;
  serviceType: string;
  windowStart: string;
  windowEnd: string;
}

export class SearchState extends BaseState<BookingContext, BookingEvent> {
  constructor() {
    super('Search');
  }

  async handle(ctx: BookingContext, _evt: BookingEvent): Promise<string> {
    if (!ctx.client) throw new Error('gp_connect_client_missing');
    const searchParams = buildSearchRequest(ctx.searchParams);
    let response;
    try {
      response = await ctx.client.searchSlots(searchParams);
    } catch (error) {
      const friendly = mapSearchError(error);
      logger.error('booking.search.failed', {
        code: friendly.code,
        correlationId: ctx.correlationId,
      });
      throw friendly;
    }
    const slots = mapSlotsToView(response);
    applySlotsToContext(ctx, slots);
    return 'Selected';
  }
}

function buildSearchRequest(raw: Record<string, unknown> | undefined): SearchSlotsParams {
  const normalized = normalizeSearchParams(raw);
  return {
    organisationId: normalized.organisationId,
    serviceType: normalized.serviceType,
    startDate: normalized.windowStart,
    endDate: normalized.windowEnd,
  };
}

function applySlotsToContext(ctx: BookingContext, slots: SlotView[]): void {
  if (ctx.enhancedAccessPolicy) {
    const result = applyEnhancedAccessFilters(slots, ctx.enhancedAccessPolicy);
    ctx.slots = result.accepted;
    ctx.rejectedSlots = result.rejected;
  } else {
    ctx.slots = slots;
    ctx.rejectedSlots = [];
  }
}

function normalizeSearchParams(raw: Record<string, unknown> | undefined): NormalizedSearchParams {
  const source = raw ?? {};
  const serviceType = readString(source, ['serviceType', 'service_type']);
  const windowStart = readString(source, ['windowStart', 'window_start']);
  const windowEnd = readString(source, ['windowEnd', 'window_end']);
  if (!serviceType || !windowStart || !windowEnd) {
    throw new BookingSearchError('booking.search.invalid_params');
  }
  const organisation = readString(source, ['organisationId', 'organisation_id', 'location']);
  if (!organisation) {
    throw new BookingSearchError('booking.search.invalid_params');
  }
  return {
    organisationId: organisation,
    serviceType,
    windowStart,
    windowEnd,
  };
}

function readString(source: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed.length > 0) return trimmed;
    }
  }
  return undefined;
}

function mapSearchError(error: unknown): BookingSearchError {
  if (error instanceof BookingSearchError) return error;
  if (error instanceof GpConnectClientError) {
    if (error.code === 'unavailable') {
      return new BookingSearchError('booking.search.unavailable', error);
    }
  }
  return new BookingSearchError('booking.search.failed', error);
}

function mapCreateError(error: unknown): BookingAppointmentError {
  if (error instanceof BookingAppointmentError) return error;
  if (error instanceof GpConnectClientError) {
    if (error.code === 'conflict') {
      return new BookingAppointmentError('booking.create.conflict', error);
    }
    if (error.code === 'unavailable') {
      return new BookingAppointmentError('booking.create.unavailable', error);
    }
  }
  return new BookingAppointmentError('booking.create.failed', error);
}

async function refreshSlotsAfterConflict(ctx: BookingContext): Promise<void> {
  try {
    const params = buildSearchRequest(ctx.searchParams);
    const refreshed = await ctx.client?.searchSlots(params);
    if (refreshed) {
      applySlotsToContext(ctx, mapSlotsToView(refreshed));
    }
  } catch (error) {
    logger.debug('booking.conflict.refresh_skip', {
      reason: (error as Error).message,
      correlationId: ctx.correlationId,
    });
  }
}

async function publishAppointmentCreated(
  ctx: BookingContext,
  confirmation: { appointmentId: string; slotId: string; start: string; end: string },
): Promise<void> {
  const bus = ensureBookingBus(ctx);
  if (!bus) return;
  if (!ctx.patientId) return;
  const slot = ctx.selectedSlot;
  const correlationId = ensureCorrelationId(ctx);
  const payload: AppointmentCreated = {
    appointmentId: confirmation.appointmentId,
    patientId: ctx.patientId,
    start: slot?.start ?? confirmation.start,
    end: slot?.end ?? confirmation.end,
  };
  if (slot?.organisationId) {
    payload.location = slot.organisationId;
  }
  const envelope = createEnvelope(Topics.booking.appointmentCreated, payload, correlationId);
  try {
    const headers = correlationId ? { 'x-correlation-id': correlationId } : undefined;
    await bus.publish(Topics.booking.appointmentCreated, envelope, headers);
    logger.info('booking.create.event_published', {
      appointmentId: confirmation.appointmentId,
      correlationId,
    });
  } catch (error) {
    throw new BookingAppointmentError('booking.create.event_failed', error);
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
    if (!ctx.bus) throw new Error('bus_missing');
    const slot = ctx.selectedSlot;
    if (!slot) {
      throw new Error('slot_not_selected');
    }
    if (!ctx.patientId) {
      throw new Error('patient_id_missing');
    }

    const idempotencyKey = ctx.idempotencyKey ?? deriveBookingIdempotencyKey(ctx);
    const ttlSeconds = resolveIdempotencyTtl(ctx);

    const { status } = await executeWithIdempotency({
      store: ctx.idempotencyStore,
      key: idempotencyKey,
      ttlSeconds,
      execute: async () => {
        let confirmation;
        try {
          confirmation = await ctx.client!.createAppointment({
            slotId: slot.id,
            patientId: ctx.patientId!,
            reason: ctx.narrative ?? 'booking request',
          });
        } catch (error) {
          const mapped = mapCreateError(error);
          if (mapped.code === 'booking.create.conflict') {
            await refreshSlotsAfterConflict(ctx).catch((refreshError) => {
              logger.warn('booking.conflict.refresh_failed', {
                reason: (refreshError as Error).message,
                correlationId: ctx.correlationId,
              });
            });
          }
          logger.warn('booking.create.failed', {
            code: mapped.code,
            slotId: slot.id,
            correlationId: ctx.correlationId,
          });
          throw mapped;
        }

        ctx.appointmentConfirmation = {
          appointmentId: confirmation.appointmentId,
          slotId: confirmation.slotId,
        };
        await persistAppointment(ctx, confirmation);
        await notifyQueue(ctx, confirmation);
        await emitAudit(ctx, confirmation);
        await publishAppointmentCreated(ctx, confirmation);
        logger.info('booking.idempotency.executed', {
          key: idempotencyKey,
          correlationId: ctx.correlationId,
        });
        return confirmation;
      },
      onDuplicate: () => {
        logger.warn('booking.idempotency.duplicate', {
          key: idempotencyKey,
          slotId: slot.id,
          patientId: ctx.patientId,
          correlationId: ctx.correlationId,
        });
      },
      onError: (error) => {
        logger.error('booking.idempotency.failed', {
          key: idempotencyKey,
          correlationId: ctx.correlationId,
          reason: error instanceof Error ? error.message : 'unknown_error',
        });
      },
    });

    if (status === 'skipped') {
      return 'WrittenBack';
    }
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

const DEFAULT_IDEMPOTENCY_TTL_SECONDS = 10 * 60;

function deriveBookingIdempotencyKey(ctx: BookingContext): string {
  const slotId = ctx.selectedSlot?.id ?? ctx.appointmentConfirmation?.slotId ?? 'unknown-slot';
  const patientId = ctx.patientId ?? 'unknown-patient';
  const origin = ctx.originatingTaskId ?? ctx.correlationId ?? ctx.id;
  return `booking:${patientId}:${slotId}:${origin}`;
}

function resolveIdempotencyTtl(ctx: BookingContext): number {
  const ttl = ctx.idempotencyTtlSeconds;
  return typeof ttl === 'number' && Number.isFinite(ttl) && ttl > 0 ? ttl : DEFAULT_IDEMPOTENCY_TTL_SECONDS;
}

function ensureBookingBus(ctx: BookingContext): MessageBus | undefined {
  if (!ctx.bus) return undefined;
  const guarded = withMessageGuards(ctx.bus, { allowedTopics: BOOKING_ALLOWED_TOPICS });
  ctx.bus = guarded;
  return guarded;
}

function normalizeCorrelationId(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function ensureCorrelationId(ctx: BookingContext): string | undefined {
  const normalized = normalizeCorrelationId(ctx.correlationId);
  ctx.correlationId = normalized;
  return normalized;
}
