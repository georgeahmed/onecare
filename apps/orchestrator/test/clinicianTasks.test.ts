import { beforeAll, afterAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createHmac } from 'node:crypto';
import type { FhirRepository, FhirBundle } from '@onecare/ports';
import type { ClinicianTaskSummary, ClinicianTaskDetail } from '@onecare/events';
import {
  server,
  setFhirRepositoryForTest,
  resetFhirRepositoryForTest,
  setBusReadyForTest,
} from '../src/index';

describe('GET /clinician/tasks', () => {
  let baseUrl: () => string;
  let startedServer = false;

  beforeAll(async () => {
    setBusReadyForTest(true);
    if (!server.listening) {
      await new Promise<void>((resolve) => {
        server.listen(0, resolve);
      });
      startedServer = true;
    }
    baseUrl = () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('Server not listening');
      }
      return `http://127.0.0.1:${(address as AddressInfo).port}`;
    };
    process.env.SECURITY_SHARED_SECRET = 'test-shared-secret';
  });
  describe('POST /clinician/tasks/:id/book-slot', () => {
    const realFetch = global.fetch;

    beforeEach(() => {
      process.env.BOOKING_SERVICE_URL = 'https://booking.example/';
    });

    afterEach(() => {
      if (realFetch) {
        global.fetch = realFetch;
      }
      delete process.env.BOOKING_SERVICE_URL;
      vi.restoreAllMocks();
    });

    it('books a slot via booking service and updates the task', async () => {
      const clinicId = 'demo-clinic';
      const taskId = 'task-book-1';
      vi.setSystemTime(new Date('2025-04-01T12:00:00Z'));

      const taskResource = {
        resourceType: 'Task',
        id: taskId,
        status: 'in-progress',
        priority: 'urgent',
        description: 'Book appointment',
        owner: { reference: `Organization/${clinicId}` },
        for: { reference: 'Patient/patient-42' },
        input: [
          {
            type: { coding: [{ system: 'http://onecare/clinician', code: 'slot' }] },
            valueString: JSON.stringify({
              id: 'slot-1',
              start: '2025-04-01T14:00:00Z',
              end: '2025-04-01T14:15:00Z',
              organisationId: 'org-1',
              serviceType: 'GP',
            }),
          },
        ],
        meta: { versionId: '19' },
      } as Record<string, unknown>;

      const updateTask = vi.fn(async () => {});
      setFhirRepositoryForTest({
        readResource: async () => taskResource as unknown,
        updateTask,
        upsertBundle: async () => {
          throw new Error('not implemented');
        },
        createTask: async () => {
          throw new Error('not implemented');
        },
        createAppointment: async () => {
          throw new Error('not implemented');
        },
        createDocumentReference: async () => {
          throw new Error('not implemented');
        },
      });

      const originalFetch = global.fetch;
      const fetchMock = vi.spyOn(global, 'fetch').mockImplementation(async (input: RequestInfo, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        if (url.startsWith('https://booking.example/')) {
          expect(init?.method).toBe('POST');
          const headers = new Headers(init?.headers as HeadersInit);
          expect(headers.get('content-type')).toBe('application/json');
          return new Response(
            JSON.stringify({
              appointmentId: 'appt-123',
              slotId: 'slot-1',
              status: 'booked',
            }),
            {
              status: 200,
              headers: { 'content-type': 'application/json' },
            },
          );
        }
        return originalFetch(input, init);
      });

      const requestId = 'req-book-1';
      const fingerprint = `${requestId}:clinician:task:${taskId}:book-slot`;
      const headers = buildAuthHeaders(
        clinicId,
        {
          'x-request-id': requestId,
          'x-correlation-id': 'corr-book-1',
          'x-auth-scope': `clinician:tasks:write clinic:${clinicId}`,
        },
        fingerprint,
      );

      const response = await fetch(`${baseUrl()}/clinician/tasks/${taskId}/book-slot`, {
        method: 'POST',
        headers: {
          ...headers,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ slotId: 'slot-1', location: 'Room 2A' }),
      });

      expect(response.status).toBe(200);
      const detail = (await response.json()) as ClinicianTaskDetail;
      expect(detail.status).toBe('IN_PROGRESS');
      expect(detail.audit.find((entry) => entry.what.includes('book'))).toBeDefined();

      expect(updateTask).toHaveBeenCalledTimes(1);
      const [, patch, options] = updateTask.mock.calls[0] as [string, Record<string, unknown>, { ifMatch?: string }];
      expect(options.ifMatch).toBe('W/"19"');
      expect((patch.businessStatus as { text?: string } | undefined)?.text).toBe('appointment_booked');

      fetchMock.mockRestore();
    });

    it('returns conflict when booking service reports duplicate', async () => {
      const clinicId = 'demo-clinic';
      const taskId = 'task-book-2';
      vi.setSystemTime(new Date('2025-04-01T12:00:00Z'));

      const taskResource = {
        resourceType: 'Task',
        id: taskId,
        status: 'in-progress',
        owner: { reference: `Organization/${clinicId}` },
        for: { reference: 'Patient/patient-42' },
        input: [
          {
            type: { coding: [{ system: 'http://onecare/clinician', code: 'slot' }] },
            valueString: JSON.stringify({
              id: 'slot-2',
              start: '2025-04-01T15:00:00Z',
              end: '2025-04-01T15:15:00Z',
              organisationId: 'org-1',
            }),
          },
        ],
      } as Record<string, unknown>;

      const updateTask = vi.fn();
      setFhirRepositoryForTest({
        readResource: async () => taskResource as unknown,
        updateTask,
        upsertBundle: async () => {
          throw new Error('not implemented');
        },
        createTask: async () => {
          throw new Error('not implemented');
        },
        createAppointment: async () => {
          throw new Error('not implemented');
        },
        createDocumentReference: async () => {
          throw new Error('not implemented');
        },
      });

      const fetchMock = vi.spyOn(global, 'fetch').mockImplementation(async () => {
        return new Response(
          JSON.stringify({ error: { code: 'conflict', message: 'Slot already booked upstream' } }),
          {
            status: 409,
            headers: {
              'content-type': 'application/json',
              'retry-after': '30',
            },
          },
        );
      });

      const requestId = 'req-book-2';
      const fingerprint = `${requestId}:clinician:task:${taskId}:book-slot`;
      const headers = buildAuthHeaders(
        clinicId,
        {
          'x-request-id': requestId,
          'x-correlation-id': 'corr-book-2',
          'x-auth-scope': `clinician:tasks:write clinic:${clinicId}`,
        },
        fingerprint,
      );

      const response = await fetch(`${baseUrl()}/clinician/tasks/${taskId}/book-slot`, {
        method: 'POST',
        headers: {
          ...headers,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ slotId: 'slot-2' }),
      });

      expect(response.status).toBe(409);
      expect(response.headers.get('retry-after')).toBe('30');
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe('conflict');
      expect(updateTask).not.toHaveBeenCalled();

      fetchMock.mockRestore();
    });

    it('returns rate limit when booking service throttles request', async () => {
      const clinicId = 'demo-clinic';
      const taskId = 'task-book-3';
      vi.setSystemTime(new Date('2025-04-01T12:00:00Z'));

      const taskResource = {
        resourceType: 'Task',
        id: taskId,
        status: 'in-progress',
        owner: { reference: `Organization/${clinicId}` },
        for: { reference: 'Patient/patient-42' },
        input: [
          {
            type: { coding: [{ system: 'http://onecare/clinician', code: 'slot' }] },
            valueString: JSON.stringify({
              id: 'slot-3',
              start: '2025-04-01T16:00:00Z',
              end: '2025-04-01T16:15:00Z',
              organisationId: 'org-1',
            }),
          },
        ],
      } as Record<string, unknown>;

      const updateTask = vi.fn();
      setFhirRepositoryForTest({
        readResource: async () => taskResource as unknown,
        updateTask,
        upsertBundle: async () => {
          throw new Error('not implemented');
        },
        createTask: async () => {
          throw new Error('not implemented');
        },
        createAppointment: async () => {
          throw new Error('not implemented');
        },
        createDocumentReference: async () => {
          throw new Error('not implemented');
        },
      });

      const fetchMock = vi.spyOn(global, 'fetch').mockImplementation(async () => {
        return new Response(JSON.stringify({ error: { code: 'rate_limited' } }), {
          status: 429,
          headers: { 'content-type': 'application/json', 'retry-after': '60' },
        });
      });

      const requestId = 'req-book-3';
      const fingerprint = `${requestId}:clinician:task:${taskId}:book-slot`;
      const headers = buildAuthHeaders(
        clinicId,
        {
          'x-request-id': requestId,
          'x-correlation-id': 'corr-book-3',
          'x-auth-scope': `clinician:tasks:write clinic:${clinicId}`,
        },
        fingerprint,
      );

      const response = await fetch(`${baseUrl()}/clinician/tasks/${taskId}/book-slot`, {
        method: 'POST',
        headers: {
          ...headers,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ slotId: 'slot-3' }),
      });

      expect(response.status).toBe(429);
      expect(response.headers.get('retry-after')).toBe('60');
      expect(updateTask).not.toHaveBeenCalled();

      fetchMock.mockRestore();
    });
  });

  afterAll(async () => {
    delete process.env.SECURITY_SHARED_SECRET;
    if (startedServer) {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetFhirRepositoryForTest();
  });

  function buildAuthHeaders(
    clinicId: string,
    overrides: Record<string, string> = {},
    fingerprintOverride?: string,
  ): Record<string, string> {
    const requestId = overrides['x-request-id'] ?? 'req-123';
    const fingerprint = fingerprintOverride ?? `${requestId}:clinician:tasks:${clinicId}`;
    const token = createHmac('sha256', process.env.SECURITY_SHARED_SECRET ?? '')
      .update(fingerprint)
      .digest('base64url');
    return {
      authorization: overrides.authorization ?? `Bearer ${token}`,
      'x-request-id': requestId,
      'x-actor-id': overrides['x-actor-id'] ?? 'practitioner-1',
      'x-actor-type': overrides['x-actor-type'] ?? 'practitioner',
      'x-auth-scope': overrides['x-auth-scope'] ?? `clinician:tasks:read clinic:${clinicId}`,
      'x-correlation-id': overrides['x-correlation-id'] ?? 'corr-123',
    };
  }

  function stubFhirRepository(response: FhirBundle, onRead?: (path: string) => void): void {
    const repo: FhirRepository = {
      upsertBundle: async () => {
        throw new Error('not implemented');
      },
      createTask: async () => {
        throw new Error('not implemented');
      },
      createAppointment: async () => {
        throw new Error('not implemented');
      },
      createDocumentReference: async () => {
        throw new Error('not implemented');
      },
      readResource: async (path: string) => {
        onRead?.(path);
        return response as unknown;
      },
      updateTask: async () => {
        throw new Error('not implemented');
      },
    };
    setFhirRepositoryForTest(repo);
  }

  it('returns clinician task summaries with filters applied', async () => {
    const clinicId = 'demo-clinic';
    vi.setSystemTime(new Date('2025-04-01T12:30:00Z'));

    const bundle: FhirBundle = {
      resourceType: 'Bundle',
      type: 'searchset',
      total: 1,
      entry: [
        {
          resource: {
            resourceType: 'Task',
            id: 'task-123',
            status: 'requested',
            priority: 'stat',
            description: 'Chest pain follow-up',
            authoredOn: '2025-04-01T12:00:00Z',
            owner: { reference: `Organization/${clinicId}` },
            for: { reference: 'Patient/patient-42' },
            performer: [
              {
                actor: {
                  display: 'Dr. Gomez',
                  reference: 'Practitioner/prac-7',
                },
              },
            ],
          },
        },
      ],
      link: [
        {
          relation: 'next',
          url: `https://fhir.example.org/Task?_getpages=c1&_count=10&owner=Organization/${clinicId}`,
        },
      ],
    };

    let capturedPath: string | null = null;
    stubFhirRepository(bundle, (path) => {
      capturedPath = path;
    });

    const headers = buildAuthHeaders(clinicId);
    const response = await fetch(
      `${baseUrl()}/clinician/tasks?clinicId=${clinicId}&priority=STAT&status=NEW&limit=10`,
      { headers },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('x-correlation-id')).toBe(headers['x-correlation-id']);
    const payload = (await response.json()) as { items: ClinicianTaskSummary[]; nextCursor?: string };
    expect(payload.items).toHaveLength(1);
    const summary = payload.items[0]!;
    expect(summary).toMatchObject({
      id: 'task-123',
      clinicId,
      priority: 'STAT',
      status: 'NEW',
      shortReason: 'Chest pain follow-up',
      patientId: 'patient-42',
      assignee: 'Dr. Gomez',
      createdAt: '2025-04-01T12:00:00.000Z',
    });
    expect(summary.waitMs).toBe(30 * 60 * 1000);
    expect(payload.nextCursor).toBeDefined();
    expect(capturedPath).toContain(`owner=${encodeURIComponent(`Organization/${clinicId}`)}`);
    expect(capturedPath).toContain('priority=stat');
    expect(capturedPath).toContain('status=requested');
  });

  it('follows next cursor when provided', async () => {
    const clinicId = 'demo-clinic';
    vi.setSystemTime(new Date('2025-04-02T09:00:00Z'));

    const firstBundle: FhirBundle = {
      resourceType: 'Bundle',
      type: 'searchset',
      entry: [],
      link: [
        {
          relation: 'next',
          url: `https://fhir.example.org/Task?_getpages=abc123&_count=5&owner=Organization/${clinicId}`,
        },
      ],
    };

    const secondBundle: FhirBundle = {
      resourceType: 'Bundle',
      type: 'searchset',
      entry: [
        {
          resource: {
            resourceType: 'Task',
            id: 'task-999',
            status: 'in-progress',
            priority: 'urgent',
            description: 'Follow up fever',
            authoredOn: '2025-04-02T07:00:00Z',
            owner: { reference: `Organization/${clinicId}` },
            for: { reference: 'Patient/patient-99' },
          },
        },
      ],
    };

    const readCalls: string[] = [];
    const repo: FhirRepository = {
      upsertBundle: async () => {
        throw new Error('not implemented');
      },
      createTask: async () => {
        throw new Error('not implemented');
      },
      createAppointment: async () => {
        throw new Error('not implemented');
      },
      createDocumentReference: async () => {
        throw new Error('not implemented');
      },
      readResource: async (path: string) => {
        readCalls.push(path);
        if (readCalls.length === 1) {
          return firstBundle as unknown;
        }
        return secondBundle as unknown;
      },
      updateTask: async () => {
        throw new Error('not implemented');
      },
    };
    setFhirRepositoryForTest(repo);

    const headers = buildAuthHeaders(clinicId, { 'x-request-id': 'req-200', 'x-correlation-id': 'corr-200' });
    const initialResponse = await fetch(`${baseUrl()}/clinician/tasks?clinicId=${clinicId}&limit=5`, { headers });
    expect(initialResponse.status).toBe(200);
    const initialBody = (await initialResponse.json()) as { items: ClinicianTaskSummary[]; nextCursor?: string };
    expect(initialBody.nextCursor).toBeDefined();

    const nextHeaders = buildAuthHeaders(clinicId, {
      'x-request-id': 'req-201',
      'x-correlation-id': 'corr-201',
    });
    const cursorResponse = await fetch(
      `${baseUrl()}/clinician/tasks?clinicId=${clinicId}&cursor=${initialBody.nextCursor}`,
      { headers: nextHeaders },
    );
    expect(cursorResponse.status).toBe(200);
    const cursorBody = (await cursorResponse.json()) as { items: ClinicianTaskSummary[] };
    expect(cursorBody.items).toHaveLength(1);
    expect(cursorBody.items[0]?.id).toBe('task-999');
    expect(readCalls[1]).toBe('Task?_getpages=abc123&_count=5&owner=Organization/demo-clinic');
  });

  it('rejects requests without clinic scope', async () => {
    const clinicId = 'demo-clinic';
    stubFhirRepository({ resourceType: 'Bundle', type: 'searchset', entry: [] });

    const headers = buildAuthHeaders(clinicId, {
      'x-auth-scope': 'clinician:tasks:read', // no clinic scope
    });
    const response = await fetch(`${baseUrl()}/clinician/tasks?clinicId=${clinicId}`, { headers });
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body?.error?.code).toBe('forbidden');
  });

  it('rejects invalid cursor values', async () => {
    const clinicId = 'demo-clinic';
    stubFhirRepository({ resourceType: 'Bundle', type: 'searchset', entry: [] });

    const headers = buildAuthHeaders(clinicId, { 'x-request-id': 'req-300' });
    const response = await fetch(`${baseUrl()}/clinician/tasks?clinicId=${clinicId}&cursor=!!!`, { headers });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body?.error?.code).toBe('invalid_input');
  });

  it('requires practitioner actor when assignee=me', async () => {
    const clinicId = 'demo-clinic';
    stubFhirRepository({ resourceType: 'Bundle', type: 'searchset', entry: [] });

    const headers = buildAuthHeaders(clinicId, {
      'x-actor-id': 'system-1',
      'x-actor-type': 'system',
      'x-request-id': 'req-400',
      'x-correlation-id': 'corr-400',
    });
    const response = await fetch(`${baseUrl()}/clinician/tasks?clinicId=${clinicId}&assignee=me`, { headers });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body?.error?.code).toBe('invalid_input');
  });

  describe('GET /clinician/tasks/:id', () => {
    it('returns clinician task detail with audit and attachments', async () => {
      const clinicId = 'demo-clinic';
      const taskId = 'task-123';
      vi.setSystemTime(new Date('2025-04-01T12:30:00Z'));

      const taskResource = {
        resourceType: 'Task',
        id: taskId,
        status: 'requested',
        priority: 'urgent',
        description: 'Chest pain follow-up',
        authoredOn: '2025-04-01T12:00:00Z',
        owner: { reference: `Organization/${clinicId}` },
        for: { reference: 'Patient/patient-42' },
        performer: [{ actor: { display: 'Dr. Gomez' } }],
        note: [
          {
            text: 'Called patient and left voicemail',
            time: '2025-04-01T12:10:00Z',
            authorString: 'Nurse Lee',
          },
        ],
        supportingInfo: [{ reference: 'DocumentReference/doc-1' }],
        identifier: [{ system: 'https://onecare.app/correlation', value: 'corr-task-123' }],
      };

      const documentReference = {
        resourceType: 'DocumentReference',
        id: 'doc-1',
        subject: { reference: 'Patient/patient-42' },
        content: [
          {
            attachment: {
              contentType: 'application/pdf',
              url: 'https://objects.example/doc-1.pdf?token=abc123',
            },
          },
        ],
      };

      const readResource = vi.fn(async (path: string) => {
        if (path === 'Task/task-123') {
          return taskResource as unknown;
        }
        if (path === 'DocumentReference/doc-1') {
          return documentReference as unknown;
        }
        throw Object.assign(new Error('not found'), { status: 404 });
      });

      const repo: FhirRepository = {
        upsertBundle: async () => {
          throw new Error('not implemented');
        },
        createTask: async () => {
          throw new Error('not implemented');
        },
        createAppointment: async () => {
          throw new Error('not implemented');
        },
        createDocumentReference: async () => {
          throw new Error('not implemented');
        },
        readResource,
        updateTask: async () => {
          throw new Error('not implemented');
        },
      };
      setFhirRepositoryForTest(repo);

      const requestId = 'req-detail-1';
      const fingerprint = `${requestId}:clinician:task:${taskId}`;
      const headers = buildAuthHeaders(
        clinicId,
        { 'x-request-id': requestId, 'x-correlation-id': 'corr-detail-1' },
        fingerprint,
      );
      const response = await fetch(`${baseUrl()}/clinician/tasks/${taskId}`, { headers });
      expect(response.status).toBe(200);
      expect(response.headers.get('x-correlation-id')).toBe('corr-detail-1');

      const detail = (await response.json()) as ClinicianTaskDetail;

      expect(detail).toMatchObject({
        id: taskId,
        clinicId,
        priority: 'URGENT',
        status: 'NEW',
        shortReason: 'Chest pain follow-up',
        patientId: 'patient-42',
        narrative: 'Called patient and left voicemail',
        correlationId: 'corr-task-123',
        waitMs: 30 * 60 * 1000,
      });
      expect(detail.attachments).toBeDefined();
      expect(detail.attachments).toHaveLength(1);
      expect(detail.attachments?.[0]).toMatchObject({
        contentType: 'application/pdf',
        url: 'https://objects.example/doc-1.pdf?token=abc123',
      });
      expect(detail.audit).toHaveLength(1);
      expect(detail.audit[0]).toMatchObject({
        who: 'Nurse Lee',
        what: 'Called patient and left voicemail',
      });
      expect(detail.actionsAllowed).toEqual(
        expect.arrayContaining(['CALL', 'SCHEDULE', 'RESOLVE', 'ESCALATE', 'ASSIGN']),
      );
      expect(readResource).toHaveBeenCalledWith('Task/task-123');
      expect(readResource).toHaveBeenCalledWith('DocumentReference/doc-1');
    });

    it('returns 404 when task is missing', async () => {
      const clinicId = 'demo-clinic';
      const taskId = 'missing-1';
      vi.setSystemTime(new Date('2025-04-01T09:00:00Z'));

      const readResource = vi.fn(async (path: string) => {
        if (path === `Task/${encodeURIComponent(taskId)}`) {
          throw Object.assign(new Error('not found'), { status: 404 });
        }
        throw new Error(`unexpected path ${path}`);
      });
      const repo: FhirRepository = {
        upsertBundle: async () => {
          throw new Error('not implemented');
        },
        createTask: async () => {
          throw new Error('not implemented');
        },
        createAppointment: async () => {
          throw new Error('not implemented');
        },
        createDocumentReference: async () => {
          throw new Error('not implemented');
        },
        readResource,
        updateTask: async () => {
          throw new Error('not implemented');
        },
      };
      setFhirRepositoryForTest(repo);

      const requestId = 'req-detail-404';
      const fingerprint = `${requestId}:clinician:task:${taskId}`;
      const headers = buildAuthHeaders(
        clinicId,
        { 'x-request-id': requestId, 'x-correlation-id': 'corr-detail-404' },
        fingerprint,
      );
      const response = await fetch(`${baseUrl()}/clinician/tasks/${taskId}`, { headers });
      const payload = await response.json();
      expect(response.status).toBe(404);
      expect(payload?.error?.code).toBe('not_found');
    });

    it('denies access when clinic scope does not match the task owner', async () => {
      const clinicId = 'demo-clinic';
      const taskId = 'task-401';
      vi.setSystemTime(new Date('2025-04-01T10:00:00Z'));

      const taskResource = {
        resourceType: 'Task',
        id: taskId,
        status: 'requested',
        priority: 'routine',
        description: 'Routine follow-up',
        authoredOn: '2025-04-01T09:00:00Z',
        owner: { reference: 'Organization/other-clinic' },
        for: { reference: 'Patient/patient-99' },
      };
      const readResource = vi.fn(async (path: string) => {
        if (path === 'Task/task-401') {
          return taskResource as unknown;
        }
        throw new Error(`unexpected path ${path}`);
      });
      const repo: FhirRepository = {
        upsertBundle: async () => {
          throw new Error('not implemented');
        },
        createTask: async () => {
          throw new Error('not implemented');
        },
        createAppointment: async () => {
          throw new Error('not implemented');
        },
        createDocumentReference: async () => {
          throw new Error('not implemented');
        },
        readResource,
        updateTask: async () => {
          throw new Error('not implemented');
        },
      };
      setFhirRepositoryForTest(repo);

      const requestId = 'req-detail-403';
      const fingerprint = `${requestId}:clinician:task:${taskId}`;
      const headers = buildAuthHeaders(
        clinicId,
        { 'x-request-id': requestId, 'x-correlation-id': 'corr-detail-403' },
        fingerprint,
      );
      const response = await fetch(`${baseUrl()}/clinician/tasks/${taskId}`, { headers });
      expect(response.status).toBe(403);
      const payload = await response.json();
      expect(payload?.error?.code).toBe('forbidden');
      expect(readResource).toHaveBeenCalledWith('Task/task-401');
    });
  });

  describe('POST /clinician/tasks/:id/assign', () => {
    it('assigns task to practitioner and returns updated detail', async () => {
      const clinicId = 'demo-clinic';
      const taskId = 'task-assign-1';
      vi.setSystemTime(new Date('2025-04-01T11:00:00Z'));

      const taskResource = {
        resourceType: 'Task',
        id: taskId,
        status: 'requested',
        priority: 'urgent',
        description: 'Follow up with patient',
        owner: { reference: `Organization/${clinicId}` },
        for: { reference: 'Patient/patient-42' },
        meta: { versionId: '7' },
      } as Record<string, unknown>;

      const updateTask = vi.fn(async () => {});
      setFhirRepositoryForTest({
        readResource: async () => taskResource as unknown,
        updateTask,
        upsertBundle: async () => {
          throw new Error('not implemented');
        },
        createTask: async () => {
          throw new Error('not implemented');
        },
        createAppointment: async () => {
          throw new Error('not implemented');
        },
        createDocumentReference: async () => {
          throw new Error('not implemented');
        },
      });

      const requestId = 'req-assign-1';
      const fingerprint = `${requestId}:clinician:task:${taskId}:assign`;
      const headers = buildAuthHeaders(
        clinicId,
        {
          'x-request-id': requestId,
          'x-correlation-id': 'corr-assign-1',
          'x-auth-scope': `clinician:tasks:write clinic:${clinicId}`,
        },
        fingerprint,
      );

      const response = await fetch(`${baseUrl()}/clinician/tasks/${taskId}/assign`, {
        method: 'POST',
        headers: {
          ...headers,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ assignee: 'Dr Gomez' }),
      });

      expect(response.status).toBe(200);
      const detail = (await response.json()) as ClinicianTaskDetail;
      expect(detail.status).toBe('IN_PROGRESS');
      expect(detail.assignee).toBe('Dr Gomez');
      expect(detail.audit).not.toHaveLength(0);
      expect(detail.audit[detail.audit.length - 1]?.what).toContain('assign');

      expect(updateTask).toHaveBeenCalledTimes(1);
      const [patch, options] = updateTask.mock.calls[0]!.slice(1) as [Record<string, unknown>, { ifMatch?: string } | undefined];
      expect(patch).toMatchObject({
        resourceType: 'Task',
        status: 'in-progress',
      });
      const performer = Array.isArray(patch.performer) ? patch.performer[0] : undefined;
      expect(performer?.actor?.reference).toBe('Practitioner/practitioner-1');
      expect(performer?.actor?.display).toBe('Dr Gomez');
      expect(options?.ifMatch).toBe('W/"7"');
    });

    it('is idempotent when assignment unchanged', async () => {
      const clinicId = 'demo-clinic';
      const taskId = 'task-assign-2';

      const taskResource = {
        resourceType: 'Task',
        id: taskId,
        status: 'in-progress',
        priority: 'urgent',
        description: 'Check status',
        owner: { reference: `Organization/${clinicId}` },
        for: { reference: 'Patient/patient-42' },
        performer: [
          {
            actor: {
              reference: 'Practitioner/practitioner-1',
              display: 'Dr Gomez',
            },
          },
        ],
      } as Record<string, unknown>;

      const updateTask = vi.fn();
      setFhirRepositoryForTest({
        readResource: async () => taskResource as unknown,
        updateTask,
        upsertBundle: async () => {
          throw new Error('not implemented');
        },
        createTask: async () => {
          throw new Error('not implemented');
        },
        createAppointment: async () => {
          throw new Error('not implemented');
        },
        createDocumentReference: async () => {
          throw new Error('not implemented');
        },
      });

      const requestId = 'req-assign-2';
      const fingerprint = `${requestId}:clinician:task:${taskId}:assign`;
      const headers = buildAuthHeaders(
        clinicId,
        {
          'x-request-id': requestId,
          'x-correlation-id': 'corr-assign-2',
          'x-auth-scope': `clinician:tasks:write clinic:${clinicId}`,
        },
        fingerprint,
      );

      const response = await fetch(`${baseUrl()}/clinician/tasks/${taskId}/assign`, {
        method: 'POST',
        headers: {
          ...headers,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ assignee: 'Dr Gomez' }),
      });

      expect(response.status).toBe(200);
      const detail = (await response.json()) as ClinicianTaskDetail;
      expect(detail.assignee).toBe('Dr Gomez');
      expect(updateTask).not.toHaveBeenCalled();
    });
  });

  describe('POST /clinician/tasks/:id/unassign', () => {
    it('clears task assignee and returns updated detail', async () => {
      const clinicId = 'demo-clinic';
      const taskId = 'task-unassign-1';
      vi.setSystemTime(new Date('2025-04-01T12:00:00Z'));

      const taskResource = {
        resourceType: 'Task',
        id: taskId,
        status: 'in-progress',
        priority: 'urgent',
        description: 'Follow up required',
        owner: { reference: `Organization/${clinicId}` },
        for: { reference: 'Patient/patient-42' },
        performer: [
          {
            actor: {
              reference: 'Practitioner/practitioner-1',
              display: 'Dr Gomez',
            },
          },
        ],
        meta: { versionId: '8' },
      } as Record<string, unknown>;

      const updateTask = vi.fn(async () => {});
      setFhirRepositoryForTest({
        readResource: async () => taskResource as unknown,
        updateTask,
        upsertBundle: async () => {
          throw new Error('not implemented');
        },
        createTask: async () => {
          throw new Error('not implemented');
        },
        createAppointment: async () => {
          throw new Error('not implemented');
        },
        createDocumentReference: async () => {
          throw new Error('not implemented');
        },
      });

      const requestId = 'req-unassign-1';
      const fingerprint = `${requestId}:clinician:task:${taskId}:unassign`;
      const headers = buildAuthHeaders(
        clinicId,
        {
          'x-request-id': requestId,
          'x-correlation-id': 'corr-unassign-1',
          'x-auth-scope': `clinician:tasks:write clinic:${clinicId}`,
        },
        fingerprint,
      );

      const response = await fetch(`${baseUrl()}/clinician/tasks/${taskId}/unassign`, {
        method: 'POST',
        headers,
      });

      expect(response.status).toBe(200);
      const detail = (await response.json()) as ClinicianTaskDetail;
      expect(detail.status).toBe('NEW');
      expect(detail.assignee).toBeUndefined();
      expect(detail.audit[detail.audit.length - 1]?.what).toContain('unassign');

      expect(updateTask).toHaveBeenCalledTimes(1);
      const [, options] = updateTask.mock.calls[0]!.slice(1) as [Record<string, unknown>, { ifMatch?: string } | undefined];
      expect(options?.ifMatch).toBe('W/"8"');
    });
  });

  describe('POST /clinician/tasks/:id/resolve', () => {
    it('marks task as completed with outcome and note', async () => {
      const clinicId = 'demo-clinic';
      const taskId = 'task-resolve-1';
      vi.setSystemTime(new Date('2025-04-01T12:00:00Z'));

      const taskResource = {
        resourceType: 'Task',
        id: taskId,
        status: 'in-progress',
        priority: 'urgent',
        description: 'Follow up on lab results',
        owner: { reference: `Organization/${clinicId}` },
        for: { reference: 'Patient/patient-42' },
        performer: [
          {
            actor: {
              reference: 'Practitioner/practitioner-1',
              display: 'Dr Gomez',
            },
          },
        ],
        meta: { versionId: '11' },
        note: [
          { text: 'assign:Dr Gomez', time: '2025-04-01T11:00:00Z', authorString: 'practitioner-1' },
        ],
      } as Record<string, unknown>;

      const updateTask = vi.fn(async () => {});
      setFhirRepositoryForTest({
        readResource: async () => taskResource as unknown,
        updateTask,
        upsertBundle: async () => {
          throw new Error('not implemented');
        },
        createTask: async () => {
          throw new Error('not implemented');
        },
        createAppointment: async () => {
          throw new Error('not implemented');
        },
        createDocumentReference: async () => {
          throw new Error('not implemented');
        },
      });

      const requestId = 'req-resolve-1';
      const fingerprint = `${requestId}:clinician:task:${taskId}:resolve`;
      const headers = buildAuthHeaders(
        clinicId,
        {
          'x-request-id': requestId,
          'x-correlation-id': 'corr-resolve-1',
          'x-auth-scope': `clinician:tasks:write clinic:${clinicId}`,
        },
        fingerprint,
      );

      const payload = { outcome: 'completed_follow_up', note: 'Patient contacted and informed' };
      const response = await fetch(`${baseUrl()}/clinician/tasks/${taskId}/resolve`, {
        method: 'POST',
        headers: {
          ...headers,
          'content-type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      expect(response.status).toBe(200);
      const detail = (await response.json()) as ClinicianTaskDetail;
      expect(detail.status).toBe('DONE');
      expect(detail.audit[detail.audit.length - 1]?.what).toContain('resolve');

      expect(updateTask).toHaveBeenCalledTimes(1);
      const [, patch, options] = updateTask.mock.calls[0] as [string, Record<string, unknown>, { ifMatch?: string }];
      expect(patch.status).toBe('completed');
      expect((patch.businessStatus as { text?: string } | undefined)?.text).toBe('completed_follow_up');
      expect(Array.isArray(patch.note)).toBe(true);
      const noteEntry = (patch.note as Array<{ text?: string }>)[(patch.note as Array<unknown>).length - 1];
      expect(noteEntry.text).toContain('resolve:completed_follow_up');
      expect(options.ifMatch).toBe('W/"11"');
    });

    it('is idempotent when task already resolved with same outcome and note', async () => {
      const clinicId = 'demo-clinic';
      const taskId = 'task-resolve-2';

      const taskResource = {
        resourceType: 'Task',
        id: taskId,
        status: 'completed',
        businessStatus: { text: 'completed_follow_up' },
        priority: 'routine',
        description: 'Follow up on lab results',
        owner: { reference: `Organization/${clinicId}` },
        for: { reference: 'Patient/patient-42' },
        note: [
          {
            text: 'resolve:completed_follow_up:Patient contacted and informed',
            time: '2025-04-01T12:00:00Z',
            authorString: 'practitioner-1',
          },
        ],
      } as Record<string, unknown>;

      const updateTask = vi.fn();
      setFhirRepositoryForTest({
        readResource: async () => taskResource as unknown,
        updateTask,
        upsertBundle: async () => {
          throw new Error('not implemented');
        },
        createTask: async () => {
          throw new Error('not implemented');
        },
        createAppointment: async () => {
          throw new Error('not implemented');
        },
        createDocumentReference: async () => {
          throw new Error('not implemented');
        },
      });

      const requestId = 'req-resolve-2';
      const fingerprint = `${requestId}:clinician:task:${taskId}:resolve`;
      const headers = buildAuthHeaders(
        clinicId,
        {
          'x-request-id': requestId,
          'x-correlation-id': 'corr-resolve-2',
          'x-auth-scope': `clinician:tasks:write clinic:${clinicId}`,
        },
        fingerprint,
      );

      const response = await fetch(`${baseUrl()}/clinician/tasks/${taskId}/resolve`, {
        method: 'POST',
        headers: {
          ...headers,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ outcome: 'completed_follow_up', note: 'Patient contacted and informed' }),
      });

      expect(response.status).toBe(200);
      const detail = (await response.json()) as ClinicianTaskDetail;
      expect(detail.status).toBe('DONE');
      expect(updateTask).not.toHaveBeenCalled();
    });
  });

  describe('POST /clinician/tasks/:id/schedule-callback', () => {
    it('schedules a callback and returns updated detail', async () => {
      const clinicId = 'demo-clinic';
      const taskId = 'task-callback-1';
      vi.setSystemTime(new Date('2025-04-01T12:00:00Z'));

      const taskResource = {
        resourceType: 'Task',
        id: taskId,
        status: 'in-progress',
        priority: 'urgent',
        description: 'Call patient back regarding results',
        owner: { reference: `Organization/${clinicId}` },
        for: { reference: 'Patient/patient-42' },
        performer: [
          {
            actor: {
              reference: 'Practitioner/practitioner-1',
              display: 'Dr Gomez',
            },
          },
        ],
        meta: { versionId: '15' },
        note: [
          { text: 'assign:Dr Gomez', time: '2025-04-01T11:00:00Z', authorString: 'practitioner-1' },
        ],
      } as Record<string, unknown>;

      const updateTask = vi.fn(async () => {});
      setFhirRepositoryForTest({
        readResource: async () => taskResource as unknown,
        updateTask,
        upsertBundle: async () => {
          throw new Error('not implemented');
        },
        createTask: async () => {
          throw new Error('not implemented');
        },
        createAppointment: async () => {
          throw new Error('not implemented');
        },
        createDocumentReference: async () => {
          throw new Error('not implemented');
        },
      });

      const requestId = 'req-callback-1';
      const fingerprint = `${requestId}:clinician:task:${taskId}:schedule-callback`;
      const headers = buildAuthHeaders(
        clinicId,
        {
          'x-request-id': requestId,
          'x-correlation-id': 'corr-callback-1',
          'x-auth-scope': `clinician:tasks:write clinic:${clinicId}`,
        },
        fingerprint,
      );

      const payload = {
        when: '2025-04-01T14:30:00Z',
        window: '14:30-15:00',
        note: 'Patient requested afternoon call',
      };
      const response = await fetch(`${baseUrl()}/clinician/tasks/${taskId}/schedule-callback`, {
        method: 'POST',
        headers: {
          ...headers,
          'content-type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      expect(response.status).toBe(200);
      const detail = (await response.json()) as ClinicianTaskDetail;
      expect(detail.status).toBe('IN_PROGRESS');
      expect(detail.audit[detail.audit.length - 1]?.what).toContain('callback');

      expect(updateTask).toHaveBeenCalledTimes(1);
      const [, patch, options] = updateTask.mock.calls[0] as [string, Record<string, unknown>, { ifMatch?: string }];
      expect(options.ifMatch).toBe('W/"15"');
      expect((patch.businessStatus as { text?: string } | undefined)?.text).toBe('callback_scheduled');
      const noteEntry = Array.isArray(patch.note) ? patch.note[patch.note.length - 1] : undefined;
      expect(typeof noteEntry?.text).toBe('string');
      expect((noteEntry?.text as string).startsWith('callback:')).toBe(true);
    });

    it('returns conflict when callback already scheduled', async () => {
      const clinicId = 'demo-clinic';
      const taskId = 'task-callback-2';
      const scheduledWhen = '2025-04-01T15:00:00Z';
      vi.setSystemTime(new Date('2025-04-01T12:00:00Z'));

      const taskResource = {
        resourceType: 'Task',
        id: taskId,
        status: 'in-progress',
        priority: 'routine',
        description: 'Follow up',
        owner: { reference: `Organization/${clinicId}` },
        for: { reference: 'Patient/patient-99' },
        note: [
          {
            text: `callback:${JSON.stringify({ when: scheduledWhen, window: '15:00-15:30', note: 'Already scheduled' })}`,
            time: '2025-04-01T10:00:00Z',
            authorString: 'practitioner-1',
          },
        ],
      } as Record<string, unknown>;

      const updateTask = vi.fn();
      setFhirRepositoryForTest({
        readResource: async () => taskResource as unknown,
        updateTask,
        upsertBundle: async () => {
          throw new Error('not implemented');
        },
        createTask: async () => {
          throw new Error('not implemented');
        },
        createAppointment: async () => {
          throw new Error('not implemented');
        },
        createDocumentReference: async () => {
          throw new Error('not implemented');
        },
      });

      const requestId = 'req-callback-2';
      const fingerprint = `${requestId}:clinician:task:${taskId}:schedule-callback`;
      const headers = buildAuthHeaders(
        clinicId,
        {
          'x-request-id': requestId,
          'x-correlation-id': 'corr-callback-2',
          'x-auth-scope': `clinician:tasks:write clinic:${clinicId}`,
        },
        fingerprint,
      );

      const response = await fetch(`${baseUrl()}/clinician/tasks/${taskId}/schedule-callback`, {
        method: 'POST',
        headers: {
          ...headers,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ when: scheduledWhen }),
      });

      expect(response.status).toBe(409);
      expect(response.headers.get('retry-after')).not.toBeNull();
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe('conflict');
      expect(updateTask).not.toHaveBeenCalled();
    });
  });
});
