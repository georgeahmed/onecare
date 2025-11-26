/// <reference types="vitest/globals" />

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import * as api from '../src/lib/api';
import GuidedHelpPanel from '../src/components/GuidedHelpPanel';
import type { GuidedHelpSessionResponse } from '../src/lib/types';

describe('GuidedHelpPanel', () => {
  const baseResponse: GuidedHelpSessionResponse = {
    sessionId: 'session-1',
    stepId: 'step1',
    redFlags: ['none'],
    proceedToSummary: false,
    needsStep6: false,
  };

  beforeEach(() => {
    vi.spyOn(api, 'requestGuidedHelpStep').mockResolvedValue({
      data: {
        ...baseResponse,
        stepId: 'step1',
        nextStepId: 'step2',
        question: 'When did this start?',
      },
      correlationId: 'corr-1',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('starts a guided-help session and renders the first question', async () => {
    render(
      <GuidedHelpPanel
        practiceId="demo-practice"
        patientId="patient-1"
        narrative="I have a headache."
      />,
    );

    fireEvent.click(
      screen.getByRole('button', {
        name: /start guided help/i,
      }),
    );

    await waitFor(() => {
      expect(api.requestGuidedHelpStep).toHaveBeenCalledTimes(1);
    });

    expect(screen.getByText(/I have a headache\./i)).toBeInTheDocument();
    expect(screen.getByText(/When did this start\?/i)).toBeInTheDocument();
  });

  it('surfaces red-flag alerts when the backend flags risk', async () => {
    vi.mocked(api.requestGuidedHelpStep).mockResolvedValueOnce({
      data: {
        ...baseResponse,
        stepId: 'step1',
        redFlags: ['chest_pain'],
      },
      correlationId: 'corr-2',
    });

    render(
      <GuidedHelpPanel
        practiceId="demo-practice"
        patientId="patient-1"
        narrative="I have chest pain."
      />,
    );

    fireEvent.click(
      screen.getByRole('button', {
        name: /start guided help/i,
      }),
    );

    await waitFor(() => {
      expect(api.requestGuidedHelpStep).toHaveBeenCalledTimes(1);
    });

    expect(
      screen.getByText(/Your answers suggest you may need urgent help/i),
    ).toBeInTheDocument();
  });

  it('includes client meta and flags on guided-help requests', async () => {
    const spy = vi.spyOn(api, 'requestGuidedHelpStep');

    render(
      <GuidedHelpPanel
        practiceId="demo-practice"
        patientId="patient-1"
        narrative="I have a headache."
      />,
    );

    fireEvent.click(
      screen.getByRole('button', {
        name: /start guided help/i,
      }),
    );

    await waitFor(() => {
      expect(spy).toHaveBeenCalledTimes(1);
    });

    const firstPayload = spy.mock.calls[0]?.[0];
    expect(firstPayload?.clientMeta?.tzOffsetMinutes).toEqual(expect.any(Number));
    expect(firstPayload?.flags?.fromSummaryButton).toBe(false);
  });
});
