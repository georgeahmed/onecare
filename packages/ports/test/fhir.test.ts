import { describe, it, expect, vi } from 'vitest';
import {
  type FhirRepository,
  validateProfile,
  createTaskResource,
  createAppointmentResource,
  createDocumentReferenceResource,
} from '../src/fhir';

function buildRepository() {
  const repo: FhirRepository = {
    upsertBundle: vi.fn(),
    createTask: vi.fn().mockResolvedValue({ id: 'task-123', resourceType: 'Task' }),
    createAppointment: vi.fn().mockResolvedValue({ id: 'appt-123', resourceType: 'Appointment' }),
    createDocumentReference: vi.fn().mockResolvedValue({ id: 'doc-123', resourceType: 'DocumentReference' }),
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
