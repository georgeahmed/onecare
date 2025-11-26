import { describe, it, expect } from 'vitest';
import type { GuidedHelpSessionRequest } from '@onecare/events';
import { buildGuidedHelpStubResponse } from '../src/application/guidedHelp.stub';

const baseRequest: Pick<GuidedHelpSessionRequest, 'practiceId' | 'patientId' | 'sessionId'> = {
  practiceId: 'demo-practice',
  patientId: 'patient-1',
  sessionId: 'session-1',
};

describe('buildGuidedHelpStubResponse', () => {
  it('returns onset question and missingFields for step1', () => {
    const request: GuidedHelpSessionRequest = {
      ...baseRequest,
      stepId: 'step1',
      seedNarrative: 'I have a mild headache.',
      conversation: [],
    };

    const response = buildGuidedHelpStubResponse(request);

    expect(response.stepId).toBe('step1');
    expect(response.nextStepId).toBe('step2');
    expect(response.question).toContain('When did this start');
    expect(response.missingFields).toEqual(['onset']);
    expect(response.qualityScore).toBeGreaterThanOrEqual(0);
    expect(response.qualityScore).toBeLessThanOrEqual(1);
    expect(response.redFlags).toEqual(['none']);
  });

  it('flags low-signal answers and requires final detail on step5', () => {
    const request: GuidedHelpSessionRequest = {
      ...baseRequest,
      stepId: 'step5',
      seedNarrative: 'Not sure.',
      conversation: [
        { role: 'user', text: 'idk', sequence: 0 },
        { role: 'user', text: 'n/a', sequence: 1 },
      ],
    };

    const response = buildGuidedHelpStubResponse(request);

    expect(response.stepId).toBe('step5');
    expect(response.needsStep6).toBe(true);
    expect(response.proceedToSummary).toBe(false);
    expect(response.limitations).toBeDefined();
    expect((response.limitations ?? []).length).toBeGreaterThan(0);
  });

  it('allows proceeding to summary when coverage and quality are sufficient', () => {
    const request: GuidedHelpSessionRequest = {
      ...baseRequest,
      stepId: 'step5',
      seedNarrative: 'Headache started 3 days ago.',
      conversation: [
        { role: 'user', text: 'Started 3 days ago.', sequence: 0, fieldTags: ['onset'] },
        { role: 'user', text: 'Pain on the left side of my head.', sequence: 1, fieldTags: ['location'] },
        { role: 'user', text: 'It is about 7 out of 10.', sequence: 2, fieldTags: ['severity'] },
        { role: 'user', text: 'I also feel nauseous and sensitive to light.', sequence: 3, fieldTags: ['otherSymptoms'] },
      ],
    };

    const response = buildGuidedHelpStubResponse(request);

    expect(response.stepId).toBe('step5');
    expect(response.needsStep6).toBe(false);
    expect(response.proceedToSummary).toBe(true);
    expect(response.summary).toBeDefined();
    expect(response.confidence).toBeGreaterThan(0);
  });

  it('detects simple red-flag phrases in narrative', () => {
    const request: GuidedHelpSessionRequest = {
      ...baseRequest,
      stepId: 'step1',
      seedNarrative: 'I have chest pain and feel short of breath.',
      conversation: [],
    };

    const response = buildGuidedHelpStubResponse(request);

    expect(response.redFlags).toBeDefined();
    const flags = response.redFlags ?? [];
    expect(flags).toContain('chest_pain');
    expect(flags).toContain('shortness_of_breath');
  });
});
