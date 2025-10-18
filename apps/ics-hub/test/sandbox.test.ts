import { describe, it, expect } from 'vitest';
import { createSandboxHarness } from '../src/dev/sandbox';

describe('Sandbox harness', () => {
  const harness = createSandboxHarness();

  it('lists available fixtures', () => {
    const names = harness.list();
    expect(names).toEqual(
      expect.arrayContaining([
        'cpcs-referral-success',
        'cpcs-referral-error',
        'ics-referral-request',
        'ics-referral-ack',
      ]),
    );
  });

  it('provides CPCS success scenario with expected referral shape', () => {
    const scenario = harness.cpcsSuccess();
    expect(scenario.serviceRequest.presentingComplaintCode).toBe('S76');
    expect(scenario.expected.status).toBe('accepted');
  });

  it('provides ICS request and ack fixtures', () => {
    const request = harness.icsRequest();
    expect(request.envelope.topic).toBe('ics.referral.request');
    const ack = harness.icsAck();
    expect(ack.ack.accepted).toBe(true);
  });
});
