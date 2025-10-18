import type { ObjectStore } from './object-store';

export type FhirBundleEntry = Record<string, unknown> & {
  fullUrl?: string;
  resource?: Record<string, unknown>;
  request?: {
    method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
    url: string;
    ifMatch?: string;
    ifNoneExist?: string;
    [key: string]: unknown;
  };
};

export type FhirBundle = Record<string, unknown> & {
  id?: string;
  resourceType: 'Bundle';
  type: string;
  entry: FhirBundleEntry[];
};

export interface FhirResourceRef { id: string; resourceType: string }

export interface FhirRepository {
  upsertBundle(bundle: FhirBundle): Promise<FhirBundle>;
  createTask(task: unknown, options?: TaskCreateOptions): Promise<FhirResourceRef>;
  createAppointment(appt: unknown): Promise<FhirResourceRef>;
  createDocumentReference(doc: unknown): Promise<FhirResourceRef>;
  updateTask?(taskId: string, patch: unknown, options?: FhirUpdateOptions): Promise<void>;
  readResource?<T>(path: string, options?: FhirReadOptions): Promise<T>;
}

export interface FhirReadOptions {
  /**
   * Optional query parameters appended to the request.
   */
  searchParams?: Record<string, string | number | boolean | undefined>;
  /**
   * Optional Prefer header value (e.g. 'return=representation').
   */
  prefer?: string;
  /**
   * Additional headers (e.g. If-Match).
   */
  headers?: Record<string, string>;
}

export interface FhirUpdateOptions {
  ifMatch?: string;
}

export type InvalidFhirReason =
  | 'resource_not_object'
  | 'resource_type_missing'
  | 'profile_invalid'
  | 'stub_failure';

export interface InvalidFhirError extends Error {
  reason: InvalidFhirReason;
  resourceType?: string;
  profile?: string;
}

export interface FhirValidationOptions {
  profile?: string;
}

export interface TaskCreateOptions extends FhirValidationOptions {
  idempotencyKey?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export interface DocumentReferenceUploadContext {
  document: Record<string, unknown> & { resourceType: 'DocumentReference'; id?: string };
  attachment: Record<string, unknown>;
  index: number;
  binaryId?: string;
}

export type DocumentReferenceObjectKeyFactory = (ctx: DocumentReferenceUploadContext) => string;

export interface DocumentReferenceCreateOptions extends FhirValidationOptions {
  objectStore?: ObjectStore;
  objectKeyFactory?: DocumentReferenceObjectKeyFactory;
}

function cloneValue<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((entry) => cloneValue(entry)) as unknown as T;
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = cloneValue(entry);
    }
    return out as unknown as T;
  }
  return value;
}

function randomKeySegment(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { randomUUID } = require('crypto') as { randomUUID?: () => string };
    if (typeof randomUUID === 'function') {
      return randomUUID();
    }
  } catch {
    // ignore missing crypto support
  }
  const globalCrypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (globalCrypto && typeof globalCrypto.randomUUID === 'function') {
    return globalCrypto.randomUUID();
  }
  const entropy = Math.random().toString(36).slice(2, 10);
  return `doc-${Date.now().toString(36)}-${entropy}`;
}

function normaliseKeySegment(segment: string | undefined): string {
  if (!segment) return '';
  return segment
    .trim()
    .replace(/[^A-Za-z0-9._/-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/\/{2,}/g, '/')
    .replace(/^-|-$/g, '');
}

function decodeAttachmentData(source: unknown): Uint8Array | null {
  if (source instanceof Uint8Array) {
    return source;
  }
  if (source instanceof ArrayBuffer) {
    return new Uint8Array(source);
  }
  if (typeof source === 'string') {
    const trimmed = source.trim();
    if (!trimmed) return null;
    try {
      return Buffer.from(trimmed, 'base64');
    } catch {
      return null;
    }
  }
  return null;
}

type BinaryResource = Record<string, unknown> & { id?: string; resourceType?: string };

function collectBinaryResources(contained: unknown): Map<string, BinaryResource> {
  const map = new Map<string, BinaryResource>();
  if (!Array.isArray(contained)) return map;
  for (const resource of contained) {
    if (!isPlainObject(resource)) continue;
    if ((resource.resourceType as string | undefined) !== 'Binary') continue;
    const id = typeof resource.id === 'string' ? resource.id.trim() : undefined;
    if (!id) continue;
    map.set(id, resource);
  }
  return map;
}

function extractBinaryFromAttachment(
  attachment: Record<string, unknown>,
  binaries: Map<string, BinaryResource>,
): { bytes: Uint8Array; contentType?: string; binaryId?: string } | null {
  const inline = decodeAttachmentData(attachment.data);
  if (inline) {
    const contentType = typeof attachment.contentType === 'string' ? attachment.contentType : undefined;
    return { bytes: inline, contentType };
  }
  const rawUrl = typeof attachment.url === 'string' ? attachment.url.trim() : '';
  if (rawUrl.startsWith('#')) {
    const key = rawUrl.slice(1);
    const binary = binaries.get(key);
    if (binary) {
      const data = decodeAttachmentData(binary.data);
      if (data) {
        const contentType = typeof binary.contentType === 'string' ? binary.contentType : undefined;
        return { bytes: data, contentType, binaryId: key };
      }
    }
  }
  return null;
}

async function linkDocumentReferenceAttachments(
  document: Record<string, unknown> & { resourceType: 'DocumentReference'; id?: string; contained?: unknown; content?: unknown },
  objectStore: ObjectStore,
  objectKeyFactory?: DocumentReferenceObjectKeyFactory,
): Promise<Record<string, unknown>> {
  const clone = cloneValue(document) as Record<string, unknown> & {
    resourceType: 'DocumentReference';
    id?: string;
    contained?: unknown;
    content?: unknown;
  };
  const contentEntries = Array.isArray(clone.content) ? clone.content : [];
  const binaries = collectBinaryResources(clone.contained);
  const usedBinaryIds = new Set<string>();
  const fallbackKey = randomKeySegment();
  let mutated = false;

  for (let index = 0; index < contentEntries.length; index += 1) {
    const entry = contentEntries[index];
    if (!isPlainObject(entry)) continue;
    const attachment = isPlainObject(entry.attachment) ? (entry.attachment as Record<string, unknown>) : null;
    if (!attachment) continue;

    const binary = extractBinaryFromAttachment(attachment, binaries);
    if (!binary) continue;

    const { bytes, contentType, binaryId } = binary;
    const ctx: DocumentReferenceUploadContext = {
      document: clone,
      attachment,
      index,
      ...(binaryId ? { binaryId } : {}),
    };
    const defaultKey = `document-reference/${normaliseKeySegment(clone.id) || fallbackKey}/${index}`;
    const rawKey = objectKeyFactory ? objectKeyFactory(ctx) : defaultKey;
    const key = normaliseKeySegment(rawKey);
    if (!key) {
      throw new Error('object_store_key_invalid');
    }
    const resolvedContentType =
      (typeof attachment.contentType === 'string' && attachment.contentType.trim().length > 0
        ? attachment.contentType
        : contentType) ?? 'application/octet-stream';
    const { url } = await objectStore.put(key, bytes, resolvedContentType);
    attachment.url = url;
    if (!attachment.contentType) {
      attachment.contentType = resolvedContentType;
    }
    delete attachment.data;
    mutated = true;
    if (binaryId) {
      usedBinaryIds.add(binaryId);
    }
  }

  if (mutated && binaries.size > 0) {
    const contained = Array.isArray(clone.contained) ? (clone.contained as unknown[]) : [];
    const remaining = contained.filter((resource) => {
      if (!isPlainObject(resource)) return true;
      const id = typeof resource.id === 'string' ? resource.id : undefined;
      if (!id) return true;
      return !usedBinaryIds.has(id);
    });
    if (remaining.length === 0) {
      delete clone.contained;
    } else {
      clone.contained = remaining;
    }
  }

  return clone;
}

function createInvalidFhirError(reason: InvalidFhirReason, ctx?: { resourceType?: string; profile?: string }): InvalidFhirError {
  const error = new Error('invalid_fhir') as InvalidFhirError;
  error.reason = reason;
  if (ctx?.resourceType) {
    error.resourceType = ctx.resourceType;
  }
  if (ctx?.profile) {
    error.profile = ctx.profile;
  }
  error.name = 'InvalidFhirError';
  return error;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function validateProfile(resource: unknown, profile?: string): boolean {
  if (!isPlainObject(resource)) {
    throw createInvalidFhirError('resource_not_object');
  }
  const resourceType = resource.resourceType;
  if (typeof resourceType !== 'string' || resourceType.trim().length === 0) {
    throw createInvalidFhirError('resource_type_missing');
  }
  if (profile !== undefined && (typeof profile !== 'string' || profile.trim().length === 0)) {
    throw createInvalidFhirError('profile_invalid', { resourceType, profile: profile as string });
  }
  if (process.env.MOCK_FHIR_PROFILE_VALIDATION === 'fail') {
    throw createInvalidFhirError('stub_failure', { resourceType, profile });
  }
  return true;
}

function ensureValid(resource: unknown, options?: FhirValidationOptions): void {
  validateProfile(resource, options?.profile);
}

export async function createTaskResource(
  repository: FhirRepository,
  task: unknown,
  options?: TaskCreateOptions,
): Promise<FhirResourceRef> {
  ensureValid(task, options);
  return repository.createTask(task, options);
}

export async function createAppointmentResource(
  repository: FhirRepository,
  appointment: unknown,
  options?: FhirValidationOptions,
): Promise<FhirResourceRef> {
  ensureValid(appointment, options);
  return repository.createAppointment(appointment);
}

export async function createDocumentReferenceResource(
  repository: FhirRepository,
  document: unknown,
  options?: DocumentReferenceCreateOptions,
): Promise<FhirResourceRef> {
  let prepared = document;
  if (
    options?.objectStore &&
    isPlainObject(document) &&
    (document as { resourceType?: unknown }).resourceType === 'DocumentReference'
  ) {
    prepared = await linkDocumentReferenceAttachments(
      document as Record<string, unknown> & { resourceType: 'DocumentReference'; id?: string; contained?: unknown; content?: unknown },
      options.objectStore,
      options.objectKeyFactory,
    );
  }
  ensureValid(prepared, options);
  return repository.createDocumentReference(prepared);
}

export interface FhirValidationProfileMap {
  Task?: string;
  Appointment?: string;
  DocumentReference?: string;
  default?: string;
  [resourceType: string]: string | undefined;
}

export interface FhirValidationWrapperOptions {
  profiles?: FhirValidationProfileMap;
}

function pickProfile(profiles: FhirValidationProfileMap | undefined, resourceType: string): string | undefined {
  if (!profiles) return undefined;
  if (typeof profiles[resourceType] === 'string') {
    return profiles[resourceType];
  }
  if (typeof profiles.default === 'string') {
    return profiles.default;
  }
  return undefined;
}

export function withFhirValidation(repository: FhirRepository, options?: FhirValidationWrapperOptions): FhirRepository {
  const profiles = options?.profiles;

  return {
    upsertBundle: async (bundle) => {
      const entries = Array.isArray((bundle as { entry?: unknown })?.entry)
        ? ((bundle as { entry: Array<{ resource?: unknown }> }).entry)
        : [];
      for (const entry of entries) {
        const resource = entry?.resource;
        if (!resource) continue;
        const resourceType = (resource as { resourceType?: string }).resourceType;
        const profile = typeof resourceType === 'string' ? pickProfile(profiles, resourceType) : undefined;
        ensureValid(resource, { profile });
      }
      return repository.upsertBundle(bundle);
    },

    createTask: async (task, taskOptions) => {
      const profile = pickProfile(profiles, 'Task');
      return createTaskResource(repository, task, {
        ...(taskOptions ?? {}),
        ...(profile ? { profile } : {}),
      });
    },

    createAppointment: async (appointment) =>
      createAppointmentResource(repository, appointment, { profile: pickProfile(profiles, 'Appointment') }),

    createDocumentReference: async (document) =>
      createDocumentReferenceResource(repository, document, { profile: pickProfile(profiles, 'DocumentReference') }),

    ...(typeof repository.updateTask === 'function'
      ? {
          updateTask: async (taskId: string, patch: unknown, updateOptions?: FhirUpdateOptions) =>
            repository.updateTask!(taskId, patch, updateOptions),
        }
      : {}),

    ...(typeof repository.readResource === 'function'
      ? {
          readResource: async <T>(path: string, readOptions?: FhirReadOptions) =>
            repository.readResource!<T>(path, readOptions),
        }
      : {}),
  };
}
