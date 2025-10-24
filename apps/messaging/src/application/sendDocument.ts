import { randomUUID } from 'node:crypto';
import { logger } from '@onecare/observability';
import { createEnvelope, Topics, type SendDocumentRequest, type SendDocumentRequested, type SendDocumentSent } from '@onecare/events';
import type { FhirRepository } from '@onecare/ports';
import type { MessageBus } from '@onecare/bus';
import { withMessageGuards } from '@onecare/bus';
import type { MeshClient, MeshSendDocumentPayload } from '../adapters/mesh.client';

export interface SendDocumentCommand extends SendDocumentRequest {
  correlationId?: string;
}

export interface SendDocumentDependencies {
  fhirRepository: FhirRepository;
  meshClient: MeshClient;
  bus: MessageBus;
  config: SendDocumentConfig;
  fetcher?: Fetcher;
  now?: () => Date;
}

export interface SendDocumentConfig {
  mesh: {
    workflowId: string;
    ackWorkflowId: string;
    senderMailbox: string;
    ackTimeoutMinutes: number;
    maxRetries: number;
    backoffSchedule: string[];
  };
  pdsLookup: boolean;
  pdfMaxMb: number;
  pdfHostAllowlist?: string[];
}

export interface SendDocumentResult {
  messageId: string;
  mexLocalId: string;
  taskReference: string;
  ackDueAt: string | null;
}

export type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export class SendDocumentError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = 'SendDocumentError';
  }
}

interface NormalisedReference {
  id: string;
  reference: string;
}

interface PatientDetails {
  patientReference: string;
  patientId: string;
  nhsNumber: string;
  dateOfBirth: string;
  surname: string;
  practiceOds: string;
}

const ALLOWED_TOPICS = [
  Topics.messaging.sendDocRequested,
  Topics.messaging.sendDocSent,
];

export async function sendDocument(
  command: SendDocumentCommand,
  deps: SendDocumentDependencies,
): Promise<SendDocumentResult> {
  const nowFn = deps.now ?? (() => new Date());
  const fetcher = deps.fetcher ?? globalThis.fetch?.bind(globalThis);
  if (typeof fetcher !== 'function') {
    throw new SendDocumentError('fetch_not_available', 'fetch_not_available');
  }

  const taskRef = normaliseReference('Task', command.taskId);
  const correlationId = normaliseCorrelationId(command.correlationId);

  const bus = withMessageGuards(deps.bus, { allowedTopics: ALLOWED_TOPICS });

  const requestedEvent: SendDocumentRequested = {
    taskId: taskRef.reference,
    patientId: '',
    pdfUrl: command.pdfUrl,
    compositionBundleRef: command.compositionBundleRef,
    requestedAt: nowFn().toISOString(),
    correlationId: correlationId ?? randomUUID(),
  };

  const patient = await resolvePatient(deps.fhirRepository, taskRef.reference, deps.config.pdsLookup, correlationId);
  requestedEvent.patientId = patient.patientReference;

  await publishEvent(bus, Topics.messaging.sendDocRequested, requestedEvent, correlationId);

  const bundle = await readResource<Record<string, unknown>>(deps.fhirRepository, command.compositionBundleRef, correlationId);
  const pdfBytes = await downloadPdf(
    fetcher,
    command.pdfUrl,
    deps.config.pdfMaxMb,
    correlationId,
    deps.config.pdfHostAllowlist,
  );

  const mexLocalId = randomUUID();
  const ackWorkflowId = deps.config.mesh.ackWorkflowId?.trim();
  const meshPayload: MeshSendDocumentPayload = {
    workflowId: deps.config.mesh.workflowId,
    mexWorkflowId: deps.config.mesh.workflowId,
    ...(ackWorkflowId ? { mexAckWorkflowId: ackWorkflowId } : {}),
    mexTo: buildMexTo(patient),
    mexLocalId,
    senderMailbox: deps.config.mesh.senderMailbox,
    subject: buildSubject(patient, command.metadata),
    pdf: {
      contentType: 'application/pdf',
      data: pdfBytes,
    },
    bundle,
  };

  const meshResult = await deps.meshClient.sendDocument(meshPayload);

  await updateTaskStatus(
    deps.fhirRepository,
    taskRef,
    patient.patientReference,
    meshResult.messageId,
    meshResult.mexLocalId,
    nowFn(),
    correlationId,
  );

  const ackDueAt = computeAckDeadline(nowFn(), deps.config.mesh.ackTimeoutMinutes);
  const retryAfter = determineInitialRetryAfter(nowFn(), deps.config.mesh.backoffSchedule, deps.config.mesh.ackTimeoutMinutes);
  const sentEvent: SendDocumentSent = {
    taskId: taskRef.reference,
    patientId: patient.patientReference,
    messageId: meshResult.messageId,
    mexTo: meshPayload.mexTo,
    mexWorkflowId: deps.config.mesh.workflowId,
    ...(ackWorkflowId ? { mexAckWorkflowId: ackWorkflowId } : {}),
    mexLocalId: meshResult.mexLocalId,
    sentAt: nowFn().toISOString(),
    attempt: 1,
    retryAfter: deps.config.mesh.maxRetries > 0 ? retryAfter : null,
  };

  await publishEvent(bus, Topics.messaging.sendDocSent, sentEvent, correlationId);

  logger.info('messaging.send_document.sent', {
    taskId: taskRef.reference,
    patientRef: patient.patientReference,
    messageId: meshResult.messageId,
    mexLocalId: meshResult.mexLocalId,
    correlationId,
  });

  return {
    messageId: meshResult.messageId,
    mexLocalId: meshResult.mexLocalId,
    taskReference: taskRef.reference,
    ackDueAt,
  };
}

async function publishEvent<T>(bus: MessageBus, topic: string, payload: T, correlationId?: string | null): Promise<void> {
  const envelope = createEnvelope(topic, payload, correlationId ?? undefined);
  const headers = createPublishHeaders(correlationId ?? undefined, envelope.id);
  await bus.publish(topic, envelope, headers);
}

async function resolvePatient(
  repo: FhirRepository,
  taskReference: string,
  requirePractice: boolean,
  correlationId?: string,
): Promise<PatientDetails> {
  const task = await readResource<Record<string, unknown>>(repo, taskReference, correlationId);
  const patientRef = extractPatientReference(task);
  const patientResource = await readResource<Record<string, unknown>>(repo, patientRef.reference, correlationId);
  const nhsNumber = extractNhsNumber(patientResource);
  const dateOfBirth = extractBirthDate(patientResource);
  const surname = extractSurname(patientResource);
  const practiceOds = requirePractice ? extractPracticeOds(patientResource) : 'UNKNOWN';
  return {
    patientReference: patientRef.reference,
    patientId: patientRef.id,
    nhsNumber,
    dateOfBirth,
    surname,
    practiceOds,
  };
}

async function readResource<T>(repo: FhirRepository, reference: string, correlationId?: string): Promise<T> {
  if (!repo.readResource) {
    throw new SendDocumentError('fhir_read_unsupported', 'fhir_read_unsupported');
  }
  const normalised = normaliseReferenceFromAny(reference);
  try {
    return await repo.readResource<T>(normalised.reference, {
      headers: correlationId ? { 'x-correlation-id': correlationId } : undefined,
    });
  } catch (error) {
    logger.error('messaging.send_document.fhir_read_failed', {
      reference: normalised.reference,
      correlationId,
      reason: error instanceof Error ? error.message : 'unknown_error',
    });
    throw new SendDocumentError('fhir_read_failed', 'fhir_read_failed');
  }
}

async function downloadPdf(
  fetcher: Fetcher,
  url: string,
  maxMb: number,
  correlationId?: string,
  allowedHosts?: string[],
): Promise<Uint8Array> {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new SendDocumentError('pdf_url_invalid', 'pdf_url_invalid');
  }
  if (parsedUrl.protocol !== 'https:') {
    throw new SendDocumentError('pdf_insecure', 'pdf_insecure');
  }
  const normalizedHost = parsedUrl.host.toLowerCase();
  if (Array.isArray(allowedHosts) && allowedHosts.length > 0) {
    const allowList = allowedHosts.map((entry) => entry.trim().toLowerCase()).filter(Boolean);
    if (allowList.length > 0 && !allowList.includes(normalizedHost)) {
      throw new SendDocumentError('pdf_host_not_allowed', 'pdf_host_not_allowed');
    }
  }

  let response: Response;
  try {
    response = await fetcher(parsedUrl.toString());
  } catch (error) {
    logger.error('messaging.send_document.pdf_fetch_failed', {
      url: parsedUrl.toString(),
      correlationId,
      reason: error instanceof Error ? error.message : 'unknown_error',
    });
    throw new SendDocumentError('pdf_fetch_failed', 'pdf_fetch_failed');
  }
  if (!response.ok) {
    logger.error('messaging.send_document.pdf_fetch_error_status', {
      url: parsedUrl.toString(),
      status: response.status,
      correlationId,
    });
    throw new SendDocumentError('pdf_fetch_failed', 'pdf_fetch_failed');
  }
  const contentType = response.headers.get('content-type');
  if (!contentType || !contentType.toLowerCase().includes('application/pdf')) {
    throw new SendDocumentError('pdf_content_type_invalid', 'pdf_content_type_invalid');
  }
  const arrayBuffer = await response.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  const maxBytes = Math.max(1, Math.floor(maxMb * 1024 * 1024));
  if (bytes.byteLength > maxBytes) {
    throw new SendDocumentError('pdf_too_large', 'pdf_too_large');
  }
  return bytes;
}

function buildMexTo(patient: PatientDetails): string {
  const dob = patient.dateOfBirth.replace(/[^0-9]/g, '');
  const nhsNumber = patient.nhsNumber.replace(/[^0-9]/g, '');
  const surname = patient.surname.replace(/[^A-Za-z]/g, '').toUpperCase() || 'UNKNOWN';
  return `GPPROVIDER_${nhsNumber}_${dob}_${surname}`;
}

function buildSubject(patient: PatientDetails, metadata?: Record<string, string>): string {
  if (metadata && typeof metadata.subject === 'string' && metadata.subject.trim().length > 0) {
    return metadata.subject.trim();
  }
  return `Clinical document for ${patient.patientReference}`;
}

async function updateTaskStatus(
  repo: FhirRepository,
  taskRef: NormalisedReference,
  patientReference: string,
  messageId: string,
  mexLocalId: string,
  now: Date,
  correlationId?: string,
): Promise<void> {
  if (!repo.updateTask) {
    return;
  }
  const patch: Record<string, unknown> = {
    resourceType: 'Task',
    id: taskRef.id,
    status: 'in-progress',
    businessStatus: { text: 'document_sent' },
    note: [
      {
        text: `Document dispatch queued (messageId=${messageId})`,
        time: now.toISOString(),
        authorString: 'messaging-send-document-service',
      },
    ],
    output: [
      {
        type: { text: 'messaging.senddoc' },
        valueString: JSON.stringify({ messageId, mexLocalId, patient: patientReference }),
      },
    ],
  };
  try {
    await repo.updateTask(taskRef.id, patch);
  } catch (error) {
    logger.warn('messaging.send_document.task_update_failed', {
      taskReference: taskRef.reference,
      correlationId,
      reason: error instanceof Error ? error.message : 'unknown_error',
    });
  }
}

function extractPatientReference(task: Record<string, unknown>): NormalisedReference {
  const forField = task.for as { reference?: string } | undefined;
  if (forField && typeof forField.reference === 'string') {
    return normaliseReferenceFromAny(forField.reference);
  }
  const owner = task.owner as { reference?: string } | undefined;
  if (owner && typeof owner.reference === 'string') {
    return normaliseReferenceFromAny(owner.reference);
  }
  throw new SendDocumentError('task_missing_patient', 'task_missing_patient');
}

function extractNhsNumber(patient: Record<string, unknown>): string {
  const identifiers = patient.identifier;
  if (!Array.isArray(identifiers)) {
    throw new SendDocumentError('patient_identifier_missing', 'patient_identifier_missing');
  }
  for (const entry of identifiers) {
    if (!entry || typeof entry !== 'object') continue;
    const system = (entry as { system?: string }).system;
    if (system && system === 'https://fhir.nhs.uk/Id/nhs-number') {
      const value = (entry as { value?: string }).value;
      if (typeof value === 'string' && value.trim().length > 0) {
        return value.trim();
      }
    }
  }
  throw new SendDocumentError('nhs_number_missing', 'nhs_number_missing');
}

function extractBirthDate(patient: Record<string, unknown>): string {
  const birthDate = patient.birthDate;
  if (typeof birthDate === 'string' && birthDate.trim().length > 0) {
    return birthDate.trim();
  }
  throw new SendDocumentError('birthdate_missing', 'birthdate_missing');
}

function extractSurname(patient: Record<string, unknown>): string {
  const names = patient.name;
  if (!Array.isArray(names)) {
    throw new SendDocumentError('surname_missing', 'surname_missing');
  }
  for (const entry of names) {
    if (!entry || typeof entry !== 'object') continue;
    const family = (entry as { family?: string }).family;
    if (typeof family === 'string' && family.trim().length > 0) {
      return family.trim();
    }
  }
  throw new SendDocumentError('surname_missing', 'surname_missing');
}

function extractPracticeOds(patient: Record<string, unknown>): string {
  const gp = patient.generalPractitioner;
  if (Array.isArray(gp) && gp.length > 0) {
    for (const entry of gp) {
      if (!entry || typeof entry !== 'object') continue;
      const identifier = (entry as { identifier?: { system?: string; value?: string } }).identifier;
      if (identifier && identifier.system === 'https://fhir.nhs.uk/Id/ods-organization-code' && identifier.value) {
        return identifier.value.trim();
      }
      const reference = (entry as { reference?: string }).reference;
      if (reference) {
        return extractReferenceCode(reference);
      }
    }
  }
  const managingOrg = patient.managingOrganization as { reference?: string } | undefined;
  if (managingOrg?.reference) {
    return extractReferenceCode(managingOrg.reference);
  }
  throw new SendDocumentError('practice_ods_missing', 'practice_ods_missing');
}

function extractReferenceCode(reference: string): string {
  const normalised = normaliseReferenceFromAny(reference);
  return normalised.id;
}

function normaliseReference(resourceType: string, value: string): NormalisedReference {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new SendDocumentError(`${resourceType.toLowerCase()}_missing`, `${resourceType.toLowerCase()}_missing`);
  }
  const trimmed = value.trim();
  if (/^https?:/i.test(trimmed)) {
    const parts = trimmed.split('/');
    const id = parts[parts.length - 1] ?? trimmed;
    return { id, reference: `${resourceType}/${id}` };
  }
  if (trimmed.includes('/')) {
    const [type, id] = trimmed.split('/');
    if (id && type && type.toLowerCase() === resourceType.toLowerCase()) {
      return { id, reference: `${resourceType}/${id}` };
    }
    return { id: id ?? trimmed, reference: trimmed };
  }
  return { id: trimmed, reference: `${resourceType}/${trimmed}` };
}

function normaliseReferenceFromAny(value: string): NormalisedReference {
  const trimmed = value.trim();
  if (!trimmed) {
    return { id: '', reference: '' };
  }
  let parts: string[];
  try {
    const asUrl = new URL(trimmed);
    parts = asUrl.pathname.split('/').filter(Boolean);
  } catch {
    parts = trimmed.split('/').filter(Boolean);
  }
  if (parts.length >= 4 && parts[parts.length - 2].toLowerCase() === '_history') {
    const type = parts[parts.length - 4];
    const id = parts[parts.length - 3];
    return { id, reference: `${type}/${id}` };
  }
  if (parts.length >= 2) {
    const type = parts[parts.length - 2];
    const id = parts[parts.length - 1];
    return { id, reference: `${type}/${id}` };
  }
  const first = parts[0] ?? trimmed;
  return { id: first, reference: trimmed };
}

function computeAckDeadline(now: Date, ackTimeoutMinutes: number): string | null {
  if (!Number.isFinite(ackTimeoutMinutes) || ackTimeoutMinutes <= 0) {
    return null;
  }
  const timeoutMs = ackTimeoutMinutes * 60 * 1000;
  return new Date(now.getTime() + timeoutMs).toISOString();
}

function createPublishHeaders(correlationId: string | undefined, messageId: string): Record<string, string> {
  const headers: Record<string, string> = { 'x-message-id': messageId };
  if (correlationId) {
    headers['x-correlation-id'] = correlationId;
  }
  return headers;
}

function normaliseCorrelationId(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function determineInitialRetryAfter(now: Date, schedule: string[], ackTimeoutMinutes: number): string | null {
  const first = schedule.find((entry) => typeof entry === 'string' && entry.trim().length > 0);
  if (first) {
    const parsed = parseIsoDurationMs(first.trim());
    if (parsed && parsed > 0) {
      return new Date(now.getTime() + parsed).toISOString();
    }
  }
  return computeAckDeadline(now, ackTimeoutMinutes);
}

function parseIsoDurationMs(value: string): number | null {
  const pattern = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i;
  const match = pattern.exec(value);
  if (!match) {
    return null;
  }
  const [, days, hours, minutes, seconds] = match;
  const totalMs =
    (days ? Number(days) * 24 * 60 * 60 * 1000 : 0) +
    (hours ? Number(hours) * 60 * 60 * 1000 : 0) +
    (minutes ? Number(minutes) * 60 * 1000 : 0) +
    (seconds ? Number(seconds) * 1000 : 0);
  return Number.isFinite(totalMs) && totalMs > 0 ? totalMs : null;
}
