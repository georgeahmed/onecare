/// <reference types="vitest/globals" />

import { describe, expect, it } from 'vitest';
import { __intakeDraftHelpers } from '../src/components/IntakeForm';

const { coercePortalSubmission } = __intakeDraftHelpers;

describe('coercePortalSubmission', () => {
  it('returns null for non-object input', () => {
    expect(coercePortalSubmission(null)).toBeNull();
    expect(coercePortalSubmission('value')).toBeNull();
  });

  it('fills defaults when values missing', () => {
    const submission = coercePortalSubmission({ practiceId: 'demo', patient: { id: 'patient' } });
    expect(submission).not.toBeNull();
    expect(submission?.practiceId).toBe('demo');
    expect(submission?.patient.id).toBe('patient');
    expect(submission?.channel).toBe('web');
    expect(submission?.attachments).toEqual([]);
  });

  it('filters attachment entries without data', () => {
    const submission = coercePortalSubmission({
      practiceId: 'demo',
      patient: { id: 'patient' },
      attachments: [
        { contentType: 'application/pdf', url: 'https://example.com/a.pdf' },
        { contentType: '', url: '' }
      ]
    });

    expect(submission?.attachments).toEqual([
      { contentType: 'application/pdf', url: 'https://example.com/a.pdf' }
    ]);
  });
});
