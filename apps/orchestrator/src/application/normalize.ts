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
  const bundleId = `urn:uuid:${cryptoRandom()}`;

  if (patientId) {
    entries.push({
      fullUrl: `urn:uuid:patient-${patientId}`,
      request: { method: 'PUT', url: `Patient/${patientId}` },
      resource: {
        resourceType: 'Patient',
        id: patientId,
      },
    });
  }

  const communicationEntry: BundleEntry = {
    fullUrl: `urn:uuid:communication-${bundleId}`,
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
    submission.attachments.forEach((attachment, idx) => {
      entries.push({
        fullUrl: `urn:uuid:docref-${bundleId}-${idx}`,
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

function cryptoRandom(): string {
  return Math.random().toString(36).slice(2, 10);
}

export async function validateProfiles(_bundle: FhirBundle): Promise<void> {
  if (process.env.MOCK_VALIDATE_PROFILES === 'fail') {
    throw new Error('profile validation failed (stub)');
  }
}
