import { describe, expect, it, vi, beforeEach } from 'vitest';
import { MemoryBus } from '@onecare/bus';
import type { FhirRepository } from '@onecare/ports';
import type { MeshClient } from '../src/adapters/mesh.client';
import { sendDocument, type SendDocumentConfig, type SendDocumentCommand } from '../src/application/sendDocument';
import { Topics } from '@onecare/events';

describe('sendDocument', () => {
  const config: SendDocumentConfig = {
    mesh: {
      workflowId: 'GPCONNECT_SEND_DOCUMENT',
      ackWorkflowId: 'GPCONNECT_SEND_DOCUMENT_ACK',
      senderMailbox: 'SENDER123',
      ackTimeoutMinutes: 30,
      maxRetries: 5,
      backoffSchedule: ['PT1M', 'PT5M'],
    },
    pdsLookup: true,
    pdfMaxMb: 2,
  };

  let repo: FhirRepository;
  let meshClient: MeshClient;
  let bus: MemoryBus;
  let fetcher: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

  beforeEach(() => {
    const taskResource = {
      resourceType: 'Task',
      id: '12345',
      for: { reference: 'Patient/abc' },
    };
    const patientResource = {
      resourceType: 'Patient',
      id: 'abc',
      identifier: [
        {
          system: 'https://fhir.nhs.uk/Id/nhs-number',
          value: '9999999999',
        },
      ],
      birthDate: '2000-01-01',
      name: [
        {
          family: 'Smith',
        },
      ],
      managingOrganization: {
        reference: 'Organization/A12345',
      },
    };
    const bundleResource = {
      resourceType: 'Bundle',
      id: 'bundle-1',
      type: 'document',
    };

    repo = {
      async readResource(reference: string): Promise<any> {
        if (reference.startsWith('Task/')) return taskResource;
        if (reference.startsWith('Patient/')) return patientResource;
        if (reference.startsWith('Bundle/')) return bundleResource;
        throw new Error(`unexpected reference ${reference}`);
      },
      async updateTask() {
        // noop for tests
      },
    } as unknown as FhirRepository;

    meshClient = {
      sendDocument: vi.fn(async () => ({ messageId: 'MSG123', mexLocalId: 'LOCAL123' })),
    };

    bus = new MemoryBus();
    fetcher = async () => new Response(Buffer.from('%PDF-1.7'), { headers: { 'content-type': 'application/pdf' } });
  });

  it('sends document and emits events', async () => {
    const events: Array<{ topic: string; payload: unknown }> = [];
    await bus.subscribe(Topics.messaging.sendDocRequested, async (msg) => events.push({ topic: msg.topic, payload: msg.payload }));
    await bus.subscribe(Topics.messaging.sendDocSent, async (msg) => events.push({ topic: msg.topic, payload: msg.payload }));

    const command: SendDocumentCommand = {
      taskId: 'Task/12345',
      pdfUrl: 'https://example.com/patient.pdf',
      compositionBundleRef: 'Bundle/bundle-1',
      correlationId: 'corr-test',
    };

    const result = await sendDocument(command, {
      fhirRepository: repo,
      meshClient,
      bus,
      config,
      fetcher,
      now: () => new Date('2025-01-01T09:00:00Z'),
    });

    expect(result).toMatchObject({
      messageId: 'MSG123',
      mexLocalId: 'LOCAL123',
      taskReference: 'Task/12345',
    });
    expect(events.map((evt) => evt.topic)).toEqual([
      Topics.messaging.sendDocRequested,
      Topics.messaging.sendDocSent,
    ]);
    expect((events[1]?.payload as { messageId: string }).messageId).toBe('MSG123');
  });
});
