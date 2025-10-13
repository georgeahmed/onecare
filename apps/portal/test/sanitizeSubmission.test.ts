import { describe, it, expect } from 'vitest';
import type { PortalSubmission } from '../src/lib/types';
import { sanitizeSubmission } from '../src/components/IntakeForm';

const baseSubmission: PortalSubmission = {
  practiceId: ' practice-123 ',
  patient: {
    id: ' patient-456 ',
  },
  narrative: '  Headache persists ',
  channel: 'ivr',
};

describe('sanitizeSubmission', () => {
  it('normalizes fields, enforces channel, and filters unsafe attachments', () => {
    const submission: PortalSubmission = {
      ...baseSubmission,
      channel: 'fax' as PortalSubmission['channel'],
      attachments: [
        { contentType: ' image/png ', url: ' https://files.example/doc.png ' },
        { contentType: 'application/pdf', url: 'javascript:alert(1)' },
        { contentType: 'text/plain', url: 'http://internal.local/file.txt' },
        { contentType: '', url: 'https://ignored.example/file' },
      ],
    };

    const sanitized = sanitizeSubmission(submission);

    expect(sanitized.practiceId).toBe('practice-123');
    expect(sanitized.patient.id).toBe('patient-456');
    expect(sanitized.narrative).toBe('Headache persists');
    expect(sanitized.channel).toBe('web');
    expect(sanitized.attachments).toEqual([
      {
        contentType: 'image/png',
        url: 'https://files.example/doc.png',
      },
    ]);
  });

  it('preserves IVR channel when supplied and omits empty attachments', () => {
    const submission: PortalSubmission = {
      ...baseSubmission,
      channel: 'ivr',
      attachments: [
        { contentType: 'application/pdf', url: 'https://files.example/doc.pdf' },
        { contentType: 'application/pdf', url: '' },
      ],
    };

    const sanitized = sanitizeSubmission(submission);
    expect(sanitized.channel).toBe('ivr');
    expect(sanitized.attachments).toEqual([
      { contentType: 'application/pdf', url: 'https://files.example/doc.pdf' },
    ]);
  });

  it('trims patient locale values', () => {
    const submission: PortalSubmission = {
      ...baseSubmission,
      patient: {
        ...baseSubmission.patient,
        locale: ' es '
      },
    };

    const sanitized = sanitizeSubmission(submission);
    expect(sanitized.patient.locale).toBe('es');
  });

  it('removes unsupported locale values', () => {
    const submission: PortalSubmission = {
      ...baseSubmission,
      patient: {
        ...baseSubmission.patient,
        locale: 'fr'
      },
    };

    const sanitized = sanitizeSubmission(submission);
    expect(sanitized.patient.locale).toBeUndefined();
  });
});
