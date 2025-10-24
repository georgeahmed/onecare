import { describe, it, expect, vi } from 'vitest';
import type { Mock } from 'vitest';
import {
  type FhirRepository,
  validateProfile,
  createTaskResource,
  createAppointmentResource,
  createDocumentReferenceResource,
  withFhirValidation,
} from '../src/fhir';
import type { ObjectStore } from '../src/object-store';

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

    expect(repo.createTask).toHaveBeenCalledWith(resource, undefined);
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

  it('uploads Binary attachment data to the object store before creating a DocumentReference', async () => {
    const repo = buildRepository();
    const put = vi.fn<Required<ObjectStore>['put']>().mockResolvedValue({
      url: 'https://object.example/documents/doc-123/0',
    });
    const store: ObjectStore = {
      put,
      get: vi.fn<Required<ObjectStore>['get']>().mockResolvedValue(new Uint8Array()),
    };

    const payload = Buffer.from('Hello world!', 'utf8').toString('base64');
    const resource = {
      resourceType: 'DocumentReference',
      id: 'doc-123',
      content: [
        {
          attachment: {
            contentType: 'text/plain',
            data: payload,
          },
        },
      ],
    };

    await createDocumentReferenceResource(repo, resource, { objectStore: store });

    expect(put).toHaveBeenCalledTimes(1);
    const [key, data, contentType] = put.mock.calls[0]!;
    expect(key).toMatch(/^document-reference\//);
    expect(contentType).toBe('text/plain');
    expect(Buffer.from(data).toString('utf8')).toBe('Hello world!');

    const created = (repo.createDocumentReference as unknown as Mock).mock.calls[0]![0];
    expect(created.content[0]?.attachment?.url).toBe('https://object.example/documents/doc-123/0');
    expect(created.content[0]?.attachment?.data).toBeUndefined();
  });

  it('honours contained Binary resources referenced by attachment URLs', async () => {
    const repo = buildRepository();
    const put = vi.fn<Required<ObjectStore>['put']>().mockResolvedValue({
      url: 'https://object.example/documents/doc-456/0',
    });
    const store: ObjectStore = {
      put,
      get: vi.fn<Required<ObjectStore>['get']>().mockResolvedValue(new Uint8Array()),
    };

    const resource = {
      resourceType: 'DocumentReference',
      id: 'doc-456',
      content: [
        {
          attachment: {
            url: '#binary-1',
          },
        },
      ],
      contained: [
        {
          resourceType: 'Binary',
          id: 'binary-1',
          contentType: 'image/png',
          data: Buffer.from('PNGDATA').toString('base64'),
        },
      ],
    };

    await createDocumentReferenceResource(repo, resource, { objectStore: store });

    expect(put).toHaveBeenCalledWith(
      expect.stringMatching(/^document-reference\//),
      expect.any(Uint8Array),
      'image/png',
    );
    const created = (repo.createDocumentReference as unknown as Mock).mock.calls[0]![0];
    expect(created.content[0]?.attachment?.url).toBe('https://object.example/documents/doc-456/0');
    expect(created.content[0]?.attachment?.contentType).toBe('image/png');
    expect(created.contained).toBeUndefined();
  });

  it('sanitises custom object store keys to avoid traversal', async () => {
    const repo = buildRepository();
    const put = vi.fn<Required<ObjectStore>['put']>().mockResolvedValue({
      url: 'https://object.example/docs/safe/0',
    });
    const store: ObjectStore = {
      put,
      get: vi.fn<Required<ObjectStore>['get']>().mockResolvedValue(new Uint8Array()),
    };
    const payload = Buffer.from('safe', 'utf8').toString('base64');
    const resource = {
      resourceType: 'DocumentReference',
      content: [
        {
          attachment: {
            data: payload,
          },
        },
      ],
    };

    await createDocumentReferenceResource(repo, resource, {
      objectStore: store,
      objectKeyFactory: () => '../../../../../secret\\path ',
    });

    expect(put).toHaveBeenCalledTimes(1);
    const [key] = put.mock.calls[0]!;
    expect(key).toBe('secret-path');
  });

  it('rejects attachments with invalid base64 payloads', async () => {
    const repo = buildRepository();
    const store: ObjectStore = {
      put: vi.fn(),
      get: vi.fn<Required<ObjectStore>['get']>(),
    };
    const resource = {
      resourceType: 'DocumentReference',
      content: [
        {
          attachment: {
            data: 'not-base64',
          },
        },
      ],
    };

    await expect(createDocumentReferenceResource(repo, resource, { objectStore: store })).rejects.toThrow(
      /invalid_base64/,
    );
    expect(store.put).not.toHaveBeenCalled();
    expect(repo.createDocumentReference).not.toHaveBeenCalled();
  });
});

describe('withFhirValidation', () => {
  it('wraps repository calls with validation and profile defaults', async () => {
    const repo = buildRepository();
    const wrapped = withFhirValidation(repo, { profiles: { default: 'http://example.org/BaseProfile' } });
    const resource = { resourceType: 'Task' };

    await wrapped.createTask(resource);

    expect(repo.createTask).toHaveBeenCalledWith(resource, { profile: 'http://example.org/BaseProfile' });
  });

  it('forwards object store options through the validation wrapper', async () => {
    const repo = buildRepository();
    const put = vi.fn<Required<ObjectStore>['put']>().mockResolvedValue({
      url: 'https://object.example/documents/doc-789/0',
    });
    const store: ObjectStore = {
      put,
      get: vi.fn<Required<ObjectStore>['get']>(),
    };

    const wrapped = withFhirValidation(repo);

    const payload = {
      resourceType: 'DocumentReference',
      content: [
        {
          attachment: {
            data: Buffer.from('payload', 'utf8').toString('base64'),
          },
        },
      ],
    };

    await wrapped.createDocumentReference(payload, {
      objectStore: store,
      objectKeyFactory: () => 'custom/safe/key',
    });

    expect(put).toHaveBeenCalledWith('custom/safe/key', expect.any(Uint8Array), 'application/octet-stream');
    expect(repo.createDocumentReference).toHaveBeenCalledWith(
      expect.objectContaining({
        content: [
          expect.objectContaining({
            attachment: expect.objectContaining({ url: 'https://object.example/documents/doc-789/0' }),
          }),
        ],
      }),
    );
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

    expect(repo.updateTask).toHaveBeenCalledWith('task-123', { status: 'completed' }, undefined);
  });
});
