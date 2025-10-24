import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { MemoryBus } from '@onecare/bus';
import type { FhirRepository } from '@onecare/ports';
import type { MeshClient } from '../src/adapters/mesh.client';
import { createMessagingServer, type MessagingServerOptions } from '../src/index';
import type { SendDocumentConfig } from '../src/application/sendDocument';

describe('messaging HTTP server', () => {
  let server: http.Server;
  let baseUrl: string;
  let meshClient: MeshClient;
  let repo: FhirRepository;
  let config: SendDocumentConfig;

  beforeEach(async () => {
    meshClient = {
      sendDocument: async () => ({ messageId: 'MSG123', mexLocalId: 'LOCAL123' }),
    };
    repo = {
      async readResource(reference: string): Promise<any> {
        if (reference.startsWith('Task/')) {
          return {
            resourceType: 'Task',
            id: '12345',
            for: { reference: 'Patient/abc' },
          };
        }
        if (reference.startsWith('Patient/')) {
          return {
            resourceType: 'Patient',
            id: 'abc',
            identifier: [
              { system: 'https://fhir.nhs.uk/Id/nhs-number', value: '9999999999' },
            ],
            birthDate: '2000-01-01',
            name: [{ family: 'Smith' }],
            managingOrganization: { reference: 'Organization/A12345' },
          };
        }
        if (reference.startsWith('Bundle/')) {
          return { resourceType: 'Bundle', id: 'bundle-1', type: 'document' };
        }
        throw new Error(`unexpected reference ${reference}`);
      },
      async updateTask() {
        // ignore
      },
    } as unknown as FhirRepository;
    config = {
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

    server = createMessagingServer(buildOptions());
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('accepts send document requests', async () => {
    const response = await fetchJson(`${baseUrl}/messaging/send-document`, {
      taskId: 'Task/12345',
      pdfUrl: 'https://example.com/doc.pdf',
      compositionBundleRef: 'Bundle/bundle-1',
    });
    expect(response.status).toBe(202);
    const body = await response.json();
    expect(body.status).toBe('accepted');
    expect(body.messageId).toBe('MSG123');
  });

  it('rejects invalid content type', async () => {
    const response = await fetch(`${baseUrl}/messaging/send-document`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'not json',
    });
    expect(response.status).toBe(415);
  });

  function buildOptions(overrides: Partial<MessagingServerOptions> = {}): MessagingServerOptions {
    const bus = new MemoryBus();
    const base: MessagingServerOptions = {
      meshClient,
      fhirRepository: repo,
      bus,
      config,
      fetcher: async () => new Response(Buffer.from('%PDF-1.7'), { headers: { 'content-type': 'application/pdf' } }),
    };
    return { ...base, ...overrides };
  }
});

async function fetchJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
