import { createEnvelope, Topics, type BookingAssistedOutcome } from '@onecare/events';
import type { FhirRepository, QueueNotifier } from '@onecare/ports';
import { withMessageGuards, type MessageBus } from '@onecare/bus';
import { callWithGuard } from '../adapters/callWithGuard';
import type { BookingAuditPublisher } from './booking.state';
import { hashIdentifier } from '@onecare/security';
import { logger } from '@onecare/observability';

export interface AssistedOutcomeCommand extends BookingAssistedOutcome {
  correlationId?: string;
}

export interface AssistedOutcomeDependencies {
  fhirRepository: FhirRepository;
  bus: MessageBus;
  queueNotifier?: QueueNotifier;
  auditPublisher?: BookingAuditPublisher;
  queueName?: string;
}

export interface AssistedOutcomeResult {
  appointmentId?: string;
  taskReference: string;
  patientReference: string;
}

export class AssistedOutcomeError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = 'AssistedOutcomeError';
  }
}

const DEFAULT_QUEUE_NAME = 'booking.notifications';

interface NormalisedReference {
  id: string;
  reference: string;
}

interface AppointmentReference {
  id: string;
  resourceType: string;
}

interface AssistedQueuePayload {
  taskId: string;
  outcome: BookingAssistedOutcome['outcome'];
  recordedAt: string;
  appointmentId?: string;
  slot?: BookingAssistedOutcome['slot'];
  notes?: string;
}

export async function recordAssistedOutcome(
  command: AssistedOutcomeCommand,
  deps: AssistedOutcomeDependencies,
): Promise<AssistedOutcomeResult> {
  const repo = deps.fhirRepository;
  if (!repo) {
    throw new AssistedOutcomeError('fhir_repository_missing', 'fhir_repository_missing');
  }
  if (!deps.bus) {
    throw new AssistedOutcomeError('bus_missing', 'bus_missing');
  }

  const taskRef = normaliseReference('Task', command.taskId);
  const patientRef = normaliseReference('Patient', command.patientId);
  const recordedAt = normaliseTimestamp(command.recordedAt);
  const slot = command.slot ?? null;
  const notes = command.notes;

  let appointmentRef: AppointmentReference | undefined;
  if (command.outcome === 'booked') {
    if (!slot) {
      throw new AssistedOutcomeError('slot_required_when_booked', 'slot_required');
    }
    appointmentRef = await createAppointment(repo, patientRef.reference, slot, notes, command.correlationId);
  }

  await updateTaskOutcome(repo, taskRef.reference, command, appointmentRef, recordedAt, notes, command.recordedBy, command.correlationId);
  await notifyQueue(
    deps.queueNotifier,
    deps.queueName ?? DEFAULT_QUEUE_NAME,
    {
      taskId: taskRef.reference,
      outcome: command.outcome,
      recordedAt,
      appointmentId: appointmentRef?.id,
      slot: slot ?? undefined,
      notes,
    },
    command.correlationId,
  );
  await emitAudit(deps.auditPublisher, {
    taskId: taskRef.reference,
    patientHash: hashIdentifier(patientRef.id),
    outcome: command.outcome,
    appointmentId: appointmentRef?.id,
    recordedAt,
    correlationId: command.correlationId,
    recordedBy: command.recordedBy,
  });

  const eventPayload: BookingAssistedOutcome = {
    ...command,
    taskId: taskRef.reference,
    patientId: patientRef.reference,
    recordedAt,
  };
  if (appointmentRef?.id) {
    eventPayload.appointmentId = appointmentRef.id;
  }
  if (slot) {
    eventPayload.slot = {
      start: slot.start,
      end: slot.end,
      location: slot.location ?? null,
      serviceType: slot.serviceType ?? null,
    };
  } else {
    delete (eventPayload as { slot?: unknown }).slot;
  }

  const bus = withMessageGuards(deps.bus, { allowedTopics: [Topics.booking.assistedCompleted] });
  const envelope = createEnvelope(Topics.booking.assistedCompleted, eventPayload, command.correlationId);
  const headers = createPublishHeaders(command.correlationId, envelope.id);
  await bus.publish(Topics.booking.assistedCompleted, envelope, headers);

  logger.info('booking.assisted.outcome_published', {
    taskId: taskRef.reference,
    outcome: command.outcome,
    appointmentId: appointmentRef?.id,
    correlationId: command.correlationId,
  });

  return {
    appointmentId: appointmentRef?.id,
    taskReference: taskRef.reference,
    patientReference: patientRef.reference,
  };
}

function normaliseReference(resourceType: string, value: string): NormalisedReference {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new AssistedOutcomeError(`${resourceType.toLowerCase()}_id_missing`, `${resourceType.toLowerCase()}_missing`);
  }
  const trimmed = value.trim();
  const segments = trimmed.split('/').filter((segment) => segment.trim().length > 0);
  let id = trimmed;
  if (segments.length >= 2) {
    const candidateType = segments[segments.length - 2];
    if (candidateType.toLowerCase() === resourceType.toLowerCase()) {
      id = segments[segments.length - 1];
    } else {
      id = segments[segments.length - 1];
    }
  }
  const cleanId = id.replace(/^\s+|\s+$/g, '');
  if (!cleanId) {
    throw new AssistedOutcomeError(`${resourceType.toLowerCase()}_id_invalid`, `${resourceType.toLowerCase()}_invalid`);
  }
  return {
    id: cleanId,
    reference: `${resourceType}/${cleanId}`,
  };
}

function normaliseTimestamp(value: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return new Date().toISOString();
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return new Date().toISOString();
  }
  return date.toISOString();
}

async function createAppointment(
  repo: FhirRepository,
  patientReference: string,
  slot: NonNullable<BookingAssistedOutcome['slot']>,
  notes: string | undefined,
  correlationId?: string,
): Promise<AppointmentReference> {
  const resource: Record<string, unknown> = {
    resourceType: 'Appointment',
    status: 'booked',
    start: slot.start,
    end: slot.end,
    participant: [
      { actor: { reference: patientReference }, status: 'accepted' },
    ],
  };
  if (slot.serviceType) {
    resource.serviceType = [{ text: slot.serviceType }];
  }
  if (slot.location) {
    resource.description = slot.location;
  }
  if (notes) {
    resource.comment = notes;
  }
  try {
    const ref = await callWithGuard('fhir.createAppointment', async () => repo.createAppointment(resource), {
      timeoutMs: 2_000,
      maxRetries: 0,
      correlationId,
    });
    return ref;
  } catch (error) {
    logger.error('booking.assisted.appointment_create_failed', {
      reason: error instanceof Error ? error.message : 'unknown_error',
      correlationId,
    });
    throw new AssistedOutcomeError('appointment_create_failed', 'appointment_create_failed');
  }
}

async function updateTaskOutcome(
  repo: FhirRepository,
  taskReference: string,
  command: AssistedOutcomeCommand,
  appointmentRef: AppointmentReference | undefined,
  recordedAt: string,
  notes: string | undefined,
  recordedBy: string,
  correlationId?: string,
): Promise<void> {
  if (!repo.updateTask) {
    logger.info('booking.assisted.task_update_skipped', {
      taskId: taskReference,
      correlationId,
    });
    return;
  }
  const patch: Record<string, unknown> = {
    resourceType: 'Task',
    id: taskReference.replace(/^Task\//, ''),
    lastModified: recordedAt,
    businessStatus: { text: command.outcome },
  };
  if (notes) {
    patch.note = [
      {
        text: notes,
        time: recordedAt,
        authorString: recordedBy,
      },
    ];
  }
  switch (command.outcome) {
    case 'booked':
      patch.status = 'completed';
      if (appointmentRef?.id) {
        patch.output = [
          {
            type: { text: 'appointment' },
            valueReference: { reference: `Appointment/${appointmentRef.id}` },
          },
        ];
      }
      break;
    case 'pharmacy_referral_sent':
      patch.status = 'completed';
      break;
    case 'no_time':
    default:
      patch.status = 'in-progress';
      break;
  }
  try {
    await callWithGuard('fhir.updateTask', async () => repo.updateTask!(taskReference, patch), {
      timeoutMs: 2_000,
      maxRetries: 0,
      correlationId,
    });
  } catch (error) {
    logger.warn('booking.assisted.task_update_failed', {
      taskId: taskReference,
      correlationId,
      reason: error instanceof Error ? error.message : 'unknown_error',
    });
  }
}

async function notifyQueue(
  notifier: QueueNotifier | undefined,
  queueName: string,
  payload: AssistedQueuePayload,
  correlationId?: string,
): Promise<void> {
  if (!notifier) return;
  try {
    await notifier.notify(queueName, payload);
  } catch (error) {
    logger.warn('booking.assisted.queue_notify_failed', {
      queue: queueName,
      correlationId,
      reason: error instanceof Error ? error.message : 'unknown_error',
    });
  }
}

async function emitAudit(
  publisher: BookingAuditPublisher | undefined,
  payload: Record<string, unknown>,
): Promise<void> {
  if (!publisher) return;
  try {
    await publisher.emit({ type: 'booking.assisted.outcome', payload });
  } catch (error) {
    logger.warn('booking.assisted.audit_failed', {
      reason: error instanceof Error ? error.message : 'unknown_error',
    });
  }
}

function createPublishHeaders(correlationId: string | undefined, messageId: string): Record<string, string> {
  const headers: Record<string, string> = { 'x-message-id': messageId };
  if (correlationId) {
    headers['x-correlation-id'] = correlationId;
  }
  return headers;
}
