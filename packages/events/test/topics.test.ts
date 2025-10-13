import { describe, it, expect } from 'vitest';
import { expectTypeOf } from 'vitest';
import { Topics, type Topic } from '../src/topics';

describe('Topics type', () => {
  it('exposes topic literals as a string union', () => {
    expectTypeOf<Topic>().toBeString();
    expectTypeOf(Topics.portal.notify).toMatchTypeOf<Topic>();

    const sample: Topic[] = [
      Topics.ingest.portal,
      Topics.portal.notify,
      Topics.triage.input,
    ];

    expect(sample).toContain(Topics.triage.input);
  });

  it('rejects non-topic strings at compile time', () => {
    expectTypeOf<Topic>().not.toMatchTypeOf<Record<string, unknown>>();
    const acceptsTopic = (topic: Topic) => topic;
    expect(acceptsTopic(Topics.booking.appointmentCreated)).toBe(Topics.booking.appointmentCreated);
  });
});
