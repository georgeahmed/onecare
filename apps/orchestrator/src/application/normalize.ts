import { randomUUID } from 'node:crypto';
import type { PortalSubmission } from '@onecare/events';

export interface FhirBundle {
  resourceType: 'Bundle';
  type: 'transaction';
  entry: BundleEntry[];
}

export interface BundleEntry {
  fullUrl: string;
  request: {
    method: 'POST' | 'PUT';
    url: string;
  };
  resource: Record<string, unknown> & {
    resourceType: string;
  };
}

export function normalizeToFhir(submission: PortalSubmission): FhirBundle {
  const entries: BundleEntry[] = [];

  const patientId = submission.patient?.id;
  const createFullUrl = () => `urn:uuid:${randomUUID()}`;

  if (patientId) {
    entries.push({
      fullUrl: createFullUrl(),
      request: { method: 'PUT', url: `Patient/${patientId}` },
      resource: {
        resourceType: 'Patient',
        id: patientId,
      },
    });
  }

  const communicationEntry: BundleEntry = {
    fullUrl: createFullUrl(),
    request: { method: 'POST', url: 'Communication' },
    resource: {
      resourceType: 'Communication',
      status: 'completed',
      topic: submission.practiceId ? { text: submission.practiceId } : undefined,
      subject: patientId ? { reference: `Patient/${patientId}` } : undefined,
      medium: submission.channel ? [{ text: submission.channel }] : undefined,
      ...(submission.narrative
        ? { payload: [{ contentString: submission.narrative }], note: [{ text: submission.narrative }] }
        : {}),
    },
  };
  entries.push(communicationEntry);

  if (Array.isArray(submission.attachments)) {
    submission.attachments
      .filter(
        (attachment) =>
          typeof attachment?.contentType === 'string' &&
          attachment.contentType.trim().length > 0 &&
          typeof attachment?.url === 'string' &&
          attachment.url.trim().length > 0
      )
      .forEach((attachment) => {
        entries.push({
          fullUrl: createFullUrl(),
          request: { method: 'POST', url: 'DocumentReference' },
          resource: {
            resourceType: 'DocumentReference',
            status: 'current',
            subject: patientId ? { reference: `Patient/${patientId}` } : undefined,
            content: [
              {
                attachment: {
                  contentType: attachment.contentType,
                  url: attachment.url,
                },
              },
            ],
          },
        });
      });
  }

  return {
    resourceType: 'Bundle',
    type: 'transaction',
    entry: entries,
  };
}

export async function validateProfiles(_bundle: FhirBundle): Promise<void> {
  if (process.env.MOCK_VALIDATE_PROFILES === 'fail') {
    throw new Error('profile validation failed (stub)');
  }
}
