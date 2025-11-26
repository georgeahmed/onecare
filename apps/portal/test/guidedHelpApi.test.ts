/// <reference types="vitest/globals" />

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as dataClient from '../src/lib/dataClient';
import { requestGuidedHelpStep } from '../src/lib/api';
import type { GuidedHelpSessionRequest, GuidedHelpSessionResponse } from '../src/lib/types';

describe('guided help API helper', () => {
  beforeEach(() => {
    vi.spyOn(dataClient, 'postJson').mockResolvedValue({
      data: {
        sessionId: 'session-1',
        stepId: 'step1',
        redFlags: ['none'],
        proceedToSummary: false,
        needsStep6: false,
        question: 'When did this start?',
      } as GuidedHelpSessionResponse,
      response: {
        headers: {
          get: (name: string) =>
            name.toLowerCase() === 'x-correlation-id' ? 'resp-guided-help-correlation' : null,
        } as unknown as Headers,
      } as Response,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('posts guided-help step requests with locale header', async () => {
    const payload: GuidedHelpSessionRequest = {
      practiceId: 'demo-practice',
      patientId: 'patient-1',
      sessionId: 'session-1',
      stepId: 'step1',
      locale: 'en',
    };

    const result = await requestGuidedHelpStep(payload, { locale: 'en' });

    expect(result.data.stepId).toBe('step1');
    const postJsonMock = vi.mocked(dataClient.postJson);
    expect(postJsonMock).toHaveBeenCalledTimes(1);
    const [path, options] = postJsonMock.mock.calls[0] ?? [];
    expect(path).toBe('guided-help/step');
    const headers = (options as { headers?: Record<string, string> }).headers ?? {};
    expect(headers['accept-language']).toBe('en');
  });
});

