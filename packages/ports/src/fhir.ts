export interface FhirBundle {
  id?: string;
}

export interface FhirResourceRef { id: string; resourceType: string }

export interface FhirRepository {
  upsertBundle(bundle: FhirBundle): Promise<FhirBundle>;
  createTask(task: unknown): Promise<FhirResourceRef>;
  createAppointment(appt: unknown): Promise<FhirResourceRef>;
  createDocumentReference(doc: unknown): Promise<FhirResourceRef>;
  updateTask?(taskId: string, patch: unknown): Promise<void>;
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
  options?: FhirValidationOptions,
): Promise<FhirResourceRef> {
  ensureValid(task, options);
  return repository.createTask(task);
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
  options?: FhirValidationOptions,
): Promise<FhirResourceRef> {
  ensureValid(document, options);
  return repository.createDocumentReference(document);
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
    upsertBundle: async (bundle) => repository.upsertBundle(bundle),

    createTask: async (task) =>
      createTaskResource(repository, task, { profile: pickProfile(profiles, 'Task') }),

    createAppointment: async (appointment) =>
      createAppointmentResource(repository, appointment, { profile: pickProfile(profiles, 'Appointment') }),

    createDocumentReference: async (document) =>
      createDocumentReferenceResource(repository, document, { profile: pickProfile(profiles, 'DocumentReference') }),
  };
}
