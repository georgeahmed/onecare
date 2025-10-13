import { describe, it, expect, vi } from 'vitest';
import {
  type FhirRepository,
  validateProfile,
  createTaskResource,
  createAppointmentResource,
  createDocumentReferenceResource,
  withFhirValidation,
} from '../src/fhir';

function buildRepository() {
  const repo: FhirRepository = {
    upsertBundle: vi.fn(),
    createTask: vi.fn().mockResolvedValue({ id: 'task-123', resourceType: 'Task' }),
    createAppointment: vi.fn().mockResolvedValue({ id: 'appt-123', resourceType: 'Appointment' }),
    createDocumentReference: vi.fn().mockResolvedValue({ id: 'doc-123', resourceType: 'DocumentReference' }),
    updateTask: vi.fn().mockResolvedValue(undefined),
  };
  return repo;
}

describe('validateProfile', () => {
  it('returns true for minimal valid resource', () => {
    expect(validateProfile({ resourceType: 'Task' })).toBe(true);
  });

  it('throws invalid_fhir when resource is not an object', () => {
    expect(() => validateProfile(null)).toThrowError(/invalid_fhir/);
  });

  it('throws invalid_fhir when resourceType is missing', () => {
    expect(() => validateProfile({})).toThrowError(/invalid_fhir/);
  });

  it('throws invalid_fhir when profile option is empty string', () => {
    expect(() => validateProfile({ resourceType: 'Task' }, '')).toThrowError(/invalid_fhir/);
  });
});

describe('resource helpers', () => {
  it('validates before creating a Task', async () => {
    const repo = buildRepository();
    const resource = { resourceType: 'Task', status: 'requested' };

    await createTaskResource(repo, resource);

    expect(repo.createTask).toHaveBeenCalledWith(resource);
  });

  it('refuses to create invalid Appointment payloads', async () => {
    const repo = buildRepository();

    await expect(createAppointmentResource(repo, {})).rejects.toThrowError(/invalid_fhir/);
    expect(repo.createAppointment).not.toHaveBeenCalled();
  });

  it('validates DocumentReference with optional profile', async () => {
    const repo = buildRepository();
    const resource = { resourceType: 'DocumentReference' };

    await createDocumentReferenceResource(repo, resource, { profile: 'http://hl7.org/fhir/StructureDefinition/DocumentReference' });

    expect(repo.createDocumentReference).toHaveBeenCalledWith(resource);
  });
});

describe('withFhirValidation', () => {
  it('wraps repository calls with validation and profile defaults', async () => {
    const repo = buildRepository();
    const wrapped = withFhirValidation(repo, { profiles: { default: 'http://example.org/BaseProfile' } });
    const resource = { resourceType: 'Task' };

    await wrapped.createTask(resource);

    expect(repo.createTask).toHaveBeenCalledWith(resource);
  });

  it('prevents invalid resources from reaching the repository', async () => {
    const repo = buildRepository();
    const wrapped = withFhirValidation(repo);

    await expect(wrapped.createDocumentReference({})).rejects.toThrowError(/invalid_fhir/);
    expect(repo.createDocumentReference).not.toHaveBeenCalled();
  });

  it('validates bundle entries before upsert', async () => {
    const repo = buildRepository();
    const wrapped = withFhirValidation(repo, { profiles: { Task: 'http://example.org/TaskProfile' } });

    const bundle = {
      entry: [
        { resource: { resourceType: 'Task', status: 'requested' } },
        { resource: { resourceType: 'Task', status: 'in-progress' } },
      ],
    };

    await wrapped.upsertBundle(bundle as unknown as { entry: Array<{ resource: unknown }> });
    expect(repo.upsertBundle).toHaveBeenCalledWith(bundle);

    const invalidBundle = {
      entry: [{ resource: { resourceType: '' } }],
    };
    await expect(
      wrapped.upsertBundle(invalidBundle as unknown as { entry: Array<{ resource: unknown }> }),
    ).rejects.toThrowError(/invalid_fhir/);
    expect(repo.upsertBundle).toHaveBeenCalledTimes(1);
  });

  it('forwards optional updateTask when available', async () => {
    const repo = buildRepository();
    const wrapped = withFhirValidation(repo);

    await wrapped.updateTask?.('task-123', { status: 'completed' });

    expect(repo.updateTask).toHaveBeenCalledWith('task-123', { status: 'completed' });
  });
});
