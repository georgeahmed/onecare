import { BaseState } from '@onecare/statekit';
import type { MachineContext, MachineEvent } from '@onecare/statekit';
import { mapSlotsToView, type SlotView, GpConnectClientError } from '../adapters/gpconnect.client';
import type { GpConnectClient, SearchSlotsParams } from '../adapters/gpconnect.client';
import { callWithGuard } from '../adapters/callWithGuard';
import type { EnhancedAccessPolicy, RejectedSlot as EnhancedAccessRejectedSlot } from './enhancedAccess';
import { applyEnhancedAccessFilters } from './enhancedAccess';
import type { FhirRepository } from '@onecare/ports';
import type { QueueNotifier } from '@onecare/ports';
import type { IdempotencyStore } from '@onecare/ports';
import { executeWithIdempotency } from '@onecare/ports';
import { logger, ensureTracing, createCounter } from '@onecare/observability';
import type { MessageBus } from '@onecare/bus';
import { withMessageGuards } from '@onecare/bus';
import {
  Topics,
  createEnvelope,
  type AppointmentCreated,
  type BookingSearchRequest,
  type BookingSearchResponse,
  type RejectedSlot as BookingRejectedSlot,
  type DlqEvent,
} from '@onecare/events';
import { hashIdentifier } from '@onecare/security';
import {
  validateAppointmentCreatedEvent,
  validateBookingSearchRequest,
  validateBookingSearchResponse,
} from './contracts';

export interface BookingAuditPublisher {
  emit(event: { type: string; payload: Record<string, unknown> }): Promise<void>;
}

type RejectedSlot = BookingRejectedSlot | EnhancedAccessRejectedSlot;

export interface BookingContext extends MachineContext {
  client: GpConnectClient;
  searchParams?: Record<string, unknown>;
  slots?: SlotView[];
  lastSearchResponse?: BookingSearchResponse;
  selectedSlot?: SlotView;
  appointmentConfirmation?: { appointmentId: string; slotId: string };
  lastBookingStatus?: 'executed' | 'duplicate';
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
  featureFlags?: BookingFeatureFlags;
}

ensureTracing('booking');

const BOOKING_ALLOWED_TOPICS = new Set<string>([
  Topics.booking.appointmentCreated,
  Topics.booking.appointmentCreatedDlq,
]);

const appointmentEventFailureCounter = createCounter('booking_event_publish_error_total');
const appointmentEventDlqCounter = createCounter('booking_event_dlq_total');
const MAX_EVENT_PUBLISH_ATTEMPTS = 2;

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
  const candidate = raw ?? {};
  const validation = validateBookingSearchRequest(candidate);
  if (!validation.ok) {
    throw new BookingSearchError('booking.search.invalid_params', validation.errors);
  }
  const normalized = normalizeSearchParams(validation.value);
  return {
    organisationId: normalized.organisationId,
    serviceType: normalized.serviceType,
    startDate: normalized.windowStart,
    endDate: normalized.windowEnd,
  };
}

function applySlotsToContext(ctx: BookingContext, slots: SlotView[]): void {
  const { response, outcome } = buildValidatedSearchResponse(slots, ctx.enhancedAccessPolicy);
  ctx.slots = outcome.accepted.map((slot) => ({ ...slot }));
  ctx.rejectedSlots = outcome.rejected.map((entry) => ({
    slot: { ...entry.slot },
    reasons: [...entry.reasons],
  }));
  ctx.lastBookingStatus = undefined;
  ctx.lastSearchResponse = response;
}

function normalizeSearchParams(request: BookingSearchRequest): NormalizedSearchParams {
  return {
    organisationId: request.location,
    serviceType: request.serviceType,
    windowStart: request.windowStart,
    windowEnd: request.windowEnd,
  };
}

interface SearchOutcome {
  accepted: SlotView[];
  rejected: EnhancedAccessRejectedSlot[];
}

function buildValidatedSearchResponse(
  slots: SlotView[],
  policy?: EnhancedAccessPolicy,
): { response: BookingSearchResponse; outcome: SearchOutcome } {
  const outcome = applyPolicyToSlots(slots, policy);
  const contractResponse = outcomeToContractResponse(outcome);
  const validation = validateBookingSearchResponse(contractResponse);
  if (!validation.ok) {
    throw new BookingSearchError('booking.search.response_invalid', validation.errors);
  }
  return { response: validation.value, outcome };
}

function applyPolicyToSlots(slots: SlotView[], policy?: EnhancedAccessPolicy): SearchOutcome {
  if (!policy) {
    return {
      accepted: [...slots],
      rejected: [],
    };
  }
  const filtered = applyEnhancedAccessFilters(slots, policy);
  return {
    accepted: filtered.accepted,
    rejected: filtered.rejected.map((entry) => ({
      slot: entry.slot,
      reasons: sanitizeReasons(entry.reasons),
    })),
  };
}

function outcomeToContractResponse(outcome: SearchOutcome): BookingSearchResponse {
  const slots = outcome.accepted.map((slot) => mapSlotToContract(slot));
  const rejected = outcome.rejected.map((entry) => mapRejectedToContract(entry));
  if (rejected.length > 0) {
    return {
      slots,
      rejectedSlots: rejected,
    };
  }
  return { slots };
}

function mapSlotToContract(slot: SlotView): BookingSearchResponse['slots'][number] {
  const contractSlot: BookingSearchResponse['slots'][number] = {
    id: slot.id,
    start: slot.start,
    end: slot.end,
    organisationId: slot.organisationId,
  };
  if (typeof slot.serviceType === 'string' && slot.serviceType.trim().length > 0) {
    contractSlot.serviceType = slot.serviceType.trim();
  }
  return contractSlot;
}

function mapRejectedToContract(entry: EnhancedAccessRejectedSlot): BookingRejectedSlot {
  const reasonsArray = entry.reasons.length > 0 ? entry.reasons : ['unknown_reason'];
  const reasons = reasonsArray as [string, ...string[]];
  return {
    slot: mapSlotToContract(entry.slot),
    reasons,
  };
}

function sanitizeReasons(reasons: string[]): string[] {
  const normalized = reasons
    .map((reason) => reason.trim().toLowerCase().replace(/[^a-z0-9_.-]/g, '_'))
    .filter((reason) => reason.length > 0);
  if (normalized.length === 0) {
    return ['unknown_reason'];
  }
  return normalized;
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
  const eventValidation = validateAppointmentCreatedEvent(payload);
  if (!eventValidation.ok) {
    throw new BookingAppointmentError('booking.create.invalid_event', eventValidation.errors);
  }
  const envelope = createEnvelope(Topics.booking.appointmentCreated, eventValidation.value, correlationId);
  let attempts = 0;
  let publishError: unknown;
  while (attempts < MAX_EVENT_PUBLISH_ATTEMPTS) {
    attempts += 1;
    try {
      const headers = createPublishHeaders(correlationId, envelope.id);
      await bus.publish(Topics.booking.appointmentCreated, envelope, headers);
      logger.info('booking.create.event_published', {
        appointmentId: confirmation.appointmentId,
        correlationId,
        attempts,
      });
      return;
    } catch (error) {
      publishError = error;
      appointmentEventFailureCounter.add(1, { stage: 'publish', attempts });
      logger.error('booking.create.event_publish_failed', {
        attempt: attempts,
        correlationId,
        reason: (error as Error).message,
      });
    }
  }

  await publishAppointmentDlq(ctx, confirmation, eventValidation.value, correlationId, publishError, attempts);
  throw new BookingAppointmentError('booking.create.event_failed', publishError);
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
          keyFingerprint: fingerprintIdempotencyKey(idempotencyKey),
          correlationId: ctx.correlationId,
        });
        return confirmation;
      },
      onDuplicate: () => {
        logger.warn('booking.idempotency.duplicate', {
          keyFingerprint: fingerprintIdempotencyKey(idempotencyKey),
          slotId: slot.id,
          correlationId: ctx.correlationId,
        });
      },
      onError: (error) => {
        logger.error('booking.idempotency.failed', {
          keyFingerprint: fingerprintIdempotencyKey(idempotencyKey),
          correlationId: ctx.correlationId,
          reason: error instanceof Error ? error.message : 'unknown_error',
        });
      },
    });

    ctx.lastBookingStatus = status === 'skipped' ? 'duplicate' : 'executed';

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
    appointmentRef = await callWithGuard('fhir.createAppointment', async () => repo.createAppointment(appointmentResource), {
      timeoutMs: 2_000,
      maxRetries: 0,
      correlationId: ctx.correlationId,
    });
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
      await callWithGuard('fhir.updateTask', async () => repo.updateTask!(ctx.originatingTaskId!, patch), {
        timeoutMs: 2_000,
        maxRetries: 0,
        correlationId: ctx.correlationId,
      });
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
  const payload: Record<string, unknown> = {
    appointmentId: confirmation.appointmentId,
    slotId: confirmation.slotId,
    slot: ctx.selectedSlot,
  };
  if (ctx.patientId) {
    payload.patientHash = hashIdentifier(ctx.patientId);
  }
  const queue = ctx.queueName ?? 'booking.notifications';
  await ctx.queueNotifier.notify(queue, payload);
}

async function emitAudit(
  ctx: BookingContext,
  confirmation: { appointmentId: string; slotId: string },
): Promise<void> {
  if (!ctx.auditPublisher) return;
  const payload: Record<string, unknown> = {
    appointmentId: confirmation.appointmentId,
    slotId: confirmation.slotId,
    taskId: ctx.originatingTaskId,
    correlationId: ctx.correlationId,
  };
  if (ctx.patientId) {
    payload.patientHash = hashIdentifier(ctx.patientId);
  }
  await ctx.auditPublisher.emit({
    type: 'booking.appointment.created',
    payload,
  });
}

export const DEFAULT_IDEMPOTENCY_TTL_SECONDS = 10 * 60;

export function deriveBookingIdempotencyKey(ctx: BookingContext): string {
  const slotId = ctx.selectedSlot?.id ?? ctx.appointmentConfirmation?.slotId ?? 'unknown-slot';
  const patientId = ctx.patientId ?? 'unknown-patient';
  const origin = ctx.originatingTaskId ?? ctx.correlationId ?? ctx.id;
  const patientFingerprint = hashIdentifier(patientId);
  return `booking:${patientFingerprint}:${slotId}:${origin}`;
}

export function resolveIdempotencyTtl(ctx: BookingContext): number {
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

function fingerprintIdempotencyKey(key: string): string {
  return hashIdentifier(key).slice(0, 16);
}

function classifyErrorCode(error: unknown): string | undefined {
  if (!error) return undefined;
  const code = (error as { code?: string }).code ?? (error as { name?: string }).name;
  return code ? String(code).toLowerCase() : undefined;
}

function createPublishHeaders(correlationId: string | undefined, messageId: string): Record<string, string> {
  const headers: Record<string, string> = { 'x-message-id': messageId };
  if (correlationId) headers['x-correlation-id'] = correlationId;
  return headers;
}

async function publishAppointmentDlq(
  ctx: BookingContext,
  confirmation: { appointmentId: string; slotId: string },
  payload: AppointmentCreated,
  correlationId: string | undefined,
  error: unknown,
  attempts: number,
): Promise<void> {
  const bus = ensureBookingBus(ctx);
  if (!bus) return;
  const dlqPayload: DlqEvent = {
    originalTopic: Topics.booking.appointmentCreated,
    correlationId,
    errorCode: classifyErrorCode(error) ?? 'event_publish_failed',
    errorMessage: error instanceof Error ? error.message : 'unknown_error',
    payloadRef: {
      appointmentId: payload.appointmentId,
      slotId: confirmation.slotId,
    },
    attempts,
    ts: new Date().toISOString(),
  };
  const envelope = createEnvelope(Topics.booking.appointmentCreatedDlq, dlqPayload, correlationId);
  try {
    const headers = createPublishHeaders(correlationId, envelope.id);
    await bus.publish(Topics.booking.appointmentCreatedDlq, envelope, headers);
    appointmentEventDlqCounter.add(1, { topic: Topics.booking.appointmentCreated });
    logger.warn('booking.create.event_dlq_published', {
      appointmentId: confirmation.appointmentId,
      attempts,
      correlationId,
    });
  } catch (dlqError) {
    logger.error('booking.create.event_dlq_failed', {
      correlationId,
      reason: dlqError instanceof Error ? dlqError.message : 'unknown_error',
    });
  }
}
export interface BookingFeatureFlags {
  gpConnectBooking?: boolean;
}
