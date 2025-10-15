import { describe, it, expect } from 'vitest';
import { normalizeToFhir, validateProfiles } from './normalize';
import type { PortalSubmission } from '@onecare/events';
import type { FhirBundleEntry } from '@onecare/ports';

describe('normalizeToFhir', () => {
  it('creates minimal bundle with patient and communication', () => {
    const submission: PortalSubmission = {
      practiceId: 'practice-1',
      patient: { id: 'pat-123' },
      narrative: 'Patient has mild headache.',
      channel: 'web',
    } as PortalSubmission;

    const bundle = validateBundle(normalizeToFhir(submission));

    expect(bundle.resourceType).toBe('Bundle');
    expect(bundle.type).toBe('transaction');
    expect(bundle.entry).toHaveLength(2);
    const [patientEntry, commEntry] = bundle.entry;
    const patientResource = patientEntry.resource!;
    const communicationResource = commEntry.resource!;
    expect(patientResource.resourceType).toBe('Patient');
    expect(communicationResource.resourceType).toBe('Communication');
    expect(communicationResource).toMatchObject({
      payload: [{ contentString: submission.narrative }],
      note: [{ text: submission.narrative }],
    });
  });

  it('adds DocumentReference entries for attachments', () => {
    const submission = {
      practiceId: 'practice-1',
      patient: { id: 'pat-123' },
      narrative: 'Sample narrative',
      channel: 'web',
      attachments: [
        { contentType: 'text/plain', url: 'https://example.com/a.txt' },
        { contentType: 'image/png', url: 'https://example.com/b.png' },
        { contentType: undefined as unknown as string, url: 'https://example.com/invalid' },
        { contentType: 'image/jpeg' },
        { contentType: '  ', url: '   ' },
      ],
    } as PortalSubmission;

    const bundle = validateBundle(normalizeToFhir(submission));
    const docEntries = bundle.entry.filter(isDocumentReference);
    expect(docEntries).toHaveLength(2);
    docEntries.forEach((entry, idx) => {
      const resource = entry.resource!;
      expect(resource.resourceType).toBe('DocumentReference');
      const content = resource.content as Array<{ attachment?: { url?: string } }> | undefined;
      const attachmentUrl = Array.isArray(content) ? content[0]?.attachment?.url ?? '' : '';
      expect(attachmentUrl).toBe(submission.attachments?.[idx]?.url);
    });
    expect(
      docEntries.every((entry) => {
        const content = entry.resource!.content as Array<{ attachment?: { url?: string } }> | undefined;
        const attUrl = Array.isArray(content) ? content[0]?.attachment?.url ?? '' : '';
        return attUrl.trim().length > 0;
      }),
    ).toBe(true);
  });

  it('omits optional fields when absent', () => {
    const submission: PortalSubmission = {
      practiceId: 'practice-1',
      patient: { id: 'pat-123' },
      narrative: '',
      channel: 'ivr',
    } as PortalSubmission;

    const bundle = validateBundle(normalizeToFhir(submission));
    const commEntry = bundle.entry.find((entry) => entry.resource?.resourceType === 'Communication');
    expect(commEntry?.resource).not.toHaveProperty('note');
    expect(commEntry?.resource).not.toHaveProperty('payload');
  });
});

describe('validateProfiles', () => {
  it('accepts normalized bundle', async () => {
    const submission: PortalSubmission = {
      practiceId: 'practice-1',
      patient: { id: 'pat-123' },
      narrative: 'Routine check-in',
      channel: 'web',
    } as PortalSubmission;

    const bundle = normalizeToFhir(submission);
    await expect(validateProfiles(bundle)).resolves.toBeUndefined();
  });

  it('rejects bundle with invalid DocumentReference attachment', async () => {
    const submission: PortalSubmission = {
      practiceId: 'practice-1',
      patient: { id: 'pat-123' },
      narrative: 'Attachment test',
      channel: 'web',
      attachments: [{ contentType: 'text/plain', url: 'https://example.com/doc.txt' }],
    } as PortalSubmission;
    const bundle = normalizeToFhir(submission);
    const docEntry = bundle.entry.find((entry) => entry.resource?.resourceType === 'DocumentReference');
    if (docEntry?.resource) {
      const resource = docEntry.resource as { content?: Array<{ attachment?: { url?: string } }> };
      if (Array.isArray(resource.content) && resource.content[0]?.attachment) {
        resource.content[0]!.attachment!.url = 'not a url';
      }
    }
    await expect(validateProfiles(bundle)).rejects.toMatchObject({
      reason: 'profile_invalid',
      resourceType: 'Bundle',
    });
  });
});

function validateBundle(bundle: ReturnType<typeof normalizeToFhir>) {
  expect(bundle).toMatchObject({
    resourceType: 'Bundle',
    type: 'transaction',
  });
  expect(Array.isArray(bundle.entry)).toBe(true);
  const seen = new Set<string>();
  bundle.entry.forEach((entry) => {
    const fullUrl = entry.fullUrl ?? '';
    expect(fullUrl).toMatch(/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(seen.has(fullUrl)).toBe(false);
    seen.add(fullUrl);
    const resource = entry.resource ?? {};
    expect(resource).toHaveProperty('resourceType');
  });
  return bundle;
}

function isDocumentReference(entry: FhirBundleEntry): boolean {
  return entry.resource?.resourceType === 'DocumentReference';
}
