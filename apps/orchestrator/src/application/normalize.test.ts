import { describe, it, expect, vi } from 'vitest';
import { normalizeToFhir } from './normalize';
import type { PortalSubmission } from '@onecare/events';

vi.mock('./normalize', async () => {
  const actual = await vi.importActual<typeof import('./normalize')>('./normalize');
  return {
    ...actual,
    validateProfiles: vi.fn(),
  };
});

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
    expect(patientEntry.resource.resourceType).toBe('Patient');
    expect(commEntry.resource.resourceType).toBe('Communication');
    expect(commEntry.resource).toMatchObject({
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
      ],
    } as PortalSubmission;

    const bundle = validateBundle(normalizeToFhir(submission));
    const docEntries = bundle.entry.filter((e) => e.resource.resourceType === 'DocumentReference');
    expect(docEntries).toHaveLength(2);
    docEntries.forEach((entry, idx) => {
      expect(entry.resource).toMatchObject({ resourceType: 'DocumentReference' });
      const content = entry.resource.content as unknown;
      const attachmentUrl = Array.isArray(content)
        ? (content[0] as { attachment?: { url?: string } }).attachment?.url
        : undefined;
      expect(attachmentUrl).toBe(submission.attachments?.[idx]?.url);
    });
  });

  it('omits optional fields when absent', () => {
    const submission: PortalSubmission = {
      practiceId: 'practice-1',
      patient: { id: 'pat-123' },
      narrative: '',
      channel: 'ivr',
    } as PortalSubmission;

    const bundle = validateBundle(normalizeToFhir(submission));
    const commEntry = bundle.entry.find((e) => e.resource.resourceType === 'Communication');
    expect(commEntry?.resource).not.toHaveProperty('note');
    expect(commEntry?.resource).not.toHaveProperty('payload');
  });
});

function validateBundle(bundle: ReturnType<typeof normalizeToFhir>) {
  expect(bundle).toMatchObject({
    resourceType: 'Bundle',
    type: 'transaction',
  });
  expect(Array.isArray(bundle.entry)).toBe(true);
  bundle.entry.forEach((entry) => {
    expect(typeof entry.fullUrl).toBe('string');
    expect(entry.resource).toHaveProperty('resourceType');
  });
  return bundle;
}
