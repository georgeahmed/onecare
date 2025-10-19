import { describe, expect, it } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import portalSubmissionSchema from '../../../../schemas/ingest/portal-submission.json';
import {
  createIntakeWizardSteps,
  getNextStepId,
  getPreviousStepId,
  findStepIndex
} from './intakeWizard';

describe('createIntakeWizardSteps', () => {
  it('produces base steps without attachments when not included', () => {
    const steps = createIntakeWizardSteps(portalSubmissionSchema, {
      accessibilityEnabled: false,
      includeAttachments: false
    });

    expect(steps.map((step) => step.id)).toEqual([
      'practice',
      'patient',
      'details',
      'review'
    ]);
  });

  it('includes attachments step when flagged', () => {
    const steps = createIntakeWizardSteps(portalSubmissionSchema, {
      accessibilityEnabled: true,
      includeAttachments: true
    });

    expect(steps.map((step) => step.id)).toEqual([
      'practice',
      'patient',
      'details',
      'attachments',
      'review'
    ]);
    const attachments = steps.find((step) => step.id === 'attachments');
    expect(attachments?.optional).toBe(true);
    expect(attachments?.schema?.properties).toHaveProperty('attachments');
  });
});

describe('navigation helpers', () => {
  const steps = createIntakeWizardSteps(portalSubmissionSchema, {
    accessibilityEnabled: false,
    includeAttachments: true
  });

  it('resolves next and previous ids', () => {
    expect(getNextStepId(steps, 'practice')).toBe('patient');
    expect(getPreviousStepId(steps, 'patient')).toBe('practice');
  });

  it('handles terminal cases', () => {
    expect(getPreviousStepId(steps, 'practice')).toBeNull();
    expect(getNextStepId(steps, 'review')).toBeNull();
  });

  it('returns -1 when step missing', () => {
    expect(findStepIndex(steps, 'practice')).toBe(0);
    expect(findStepIndex(steps, 'review')).toBe(steps.length - 1);
    expect(findStepIndex(steps, 'attachments')).toBe(3);
  });
});
