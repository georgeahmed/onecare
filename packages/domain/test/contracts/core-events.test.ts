import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { validate } from '../../src/schema/validator';

const FIXTURE_ROOT = path.join(__dirname, '..', 'fixtures', 'events');

const EVENT_ENVELOPE_ID = 'https://onecare/schemas/common/event-envelope.json';
const TRIAGE_INPUT_ID = 'https://onecare/schemas/triage/triage-input.json';
const TASK_CREATED_ID = 'https://onecare/schemas/tasks/task-created.json';
const APPOINTMENT_CREATED_ID = 'https://onecare/schemas/booking/appointment-created.json';
const PHARMACY_REFERRAL_ID = 'https://onecare/schemas/pharmacy/pharmacy-referral.json';
const PHARMACY_OUTCOME_ID = 'https://onecare/schemas/pharmacy/pharmacy-outcome.json';
const ICS_REFERRAL_REQUEST_ID = 'https://onecare/schemas/ics/referral-request.json';
const ICS_REFERRAL_ACK_ID = 'https://onecare/schemas/ics/referral-ack.json';

type EventEnvelope = {
  id: string;
  topic: string;
  timestamp: string;
  correlationId?: string;
  payload: Record<string, unknown>;
};

type EventFixture = {
  minimal: { envelope: EventEnvelope };
  maximal: { envelope: EventEnvelope };
};

function loadFixture(name: string): EventFixture {
  const file = path.join(FIXTURE_ROOT, name);
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as EventFixture;
  return parsed;
}

function expectValidEnvelope(envelope: EventEnvelope) {
  expect(typeof envelope.correlationId).toBe('string');
  expect(envelope.correlationId ?? '').not.toHaveLength(0);

  const envelopeResult = validate(EVENT_ENVELOPE_ID, envelope);
  expect(envelopeResult).toEqual({ ok: true });
}

function expectValidPayload(schemaId: string, payload: Record<string, unknown>) {
  const payloadResult = validate(schemaId, payload);
  expect(payloadResult).toEqual({ ok: true });
}

function collectErrorShape(schemaId: string, payload: Record<string, unknown>) {
  const result = validate(schemaId, payload);
  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error('Expected validation failure');
  }
  return result.errors.map(({ path, keyword, params }) => ({ path, keyword, params }));
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe('core event contracts', () => {
  describe('triage.input', () => {
    const fixture = loadFixture('triage.input.json');

    it('accepts minimal and maximal payloads', () => {
      for (const variant of [fixture.minimal, fixture.maximal]) {
        const env = variant.envelope;
        expectValidEnvelope(env);
        expectValidPayload(TRIAGE_INPUT_ID, env.payload);
      }
    });

    it('rejects missing required fields and additional properties', () => {
      const invalidPayload = clone(fixture.minimal.envelope.payload);
      delete invalidPayload.patientId;
      // @ts-expect-error - injecting invalid property for test
      invalidPayload.unexpected = 'nope';

      const errors = collectErrorShape(TRIAGE_INPUT_ID, invalidPayload as Record<string, unknown>);
      expect(errors).toMatchInlineSnapshot(`
        [
          {
            "keyword": "required",
            "params": {
              "missingProperty": "patientId",
            },
            "path": "/patientId",
          },
          {
            "keyword": "additionalProperties",
            "params": {
              "additionalProperty": "unexpected",
            },
            "path": "/unexpected",
          },
        ]
      `);
    });

    it('enforces RFC3339 timestamps in the envelope', () => {
      const invalidEnvelope = clone(fixture.minimal.envelope);
      invalidEnvelope.timestamp = '2025/01/01 12:00:00';

      const result = validate(EVENT_ENVELOPE_ID, invalidEnvelope);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('Expected timestamp validation failure');
      const errorShape = result.errors.map(({ path, keyword, params }) => ({ path, keyword, params }));
      expect(errorShape).toMatchInlineSnapshot(`
        [
          {
            "keyword": "format",
            "params": {
              "format": "date-time",
            },
            "path": "/timestamp",
          },
        ]
      `);
    });
  });

  describe('tasks.created', () => {
    const fixture = loadFixture('tasks.created.json');

    it('accepts minimal and maximal payloads', () => {
      for (const variant of [fixture.minimal, fixture.maximal]) {
        const env = variant.envelope;
        expectValidEnvelope(env);
        expectValidPayload(TASK_CREATED_ID, env.payload);
      }
    });

    it('rejects missing required fields and additional properties', () => {
      const invalidPayload = clone(fixture.minimal.envelope.payload);
      delete invalidPayload.priority;
      // @ts-expect-error - injecting invalid property for test
      invalidPayload.unexpected = 'extra';

      const errors = collectErrorShape(TASK_CREATED_ID, invalidPayload as Record<string, unknown>);
      expect(errors).toMatchInlineSnapshot(`
        [
          {
            "keyword": "required",
            "params": {
              "missingProperty": "priority",
            },
            "path": "/priority",
          },
          {
            "keyword": "additionalProperties",
            "params": {
              "additionalProperty": "unexpected",
            },
            "path": "/unexpected",
          },
        ]
      `);
    });

    it('enforces RFC3339 timestamps in the envelope', () => {
      const invalidEnvelope = clone(fixture.maximal.envelope);
      invalidEnvelope.timestamp = '01-04-2025T09:45:10Z';

      const result = validate(EVENT_ENVELOPE_ID, invalidEnvelope);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('Expected timestamp validation failure');
      const errorShape = result.errors.map(({ path, keyword, params }) => ({ path, keyword, params }));
      expect(errorShape).toMatchInlineSnapshot(`
        [
          {
            "keyword": "format",
            "params": {
              "format": "date-time",
            },
            "path": "/timestamp",
          },
        ]
      `);
    });
  });

  describe('booking.appointment.created', () => {
    const fixture = loadFixture('appointment.created.json');

    it('accepts minimal and maximal payloads', () => {
      for (const variant of [fixture.minimal, fixture.maximal]) {
        const env = variant.envelope;
        expectValidEnvelope(env);
        expectValidPayload(APPOINTMENT_CREATED_ID, env.payload);
      }
    });

    it('rejects missing required fields and additional properties', () => {
      const invalidPayload = clone(fixture.minimal.envelope.payload);
      delete invalidPayload.end;
      // @ts-expect-error - injecting invalid property for test
      invalidPayload.unexpected = true;

      const errors = collectErrorShape(APPOINTMENT_CREATED_ID, invalidPayload as Record<string, unknown>);
      expect(errors).toMatchInlineSnapshot(`
        [
          {
            "keyword": "required",
            "params": {
              "missingProperty": "end",
            },
            "path": "/end",
          },
          {
            "keyword": "additionalProperties",
            "params": {
              "additionalProperty": "unexpected",
            },
            "path": "/unexpected",
          },
        ]
      `);
    });

    it('enforces RFC3339 timestamps in the envelope', () => {
      const invalidEnvelope = clone(fixture.maximal.envelope);
      invalidEnvelope.timestamp = 'Monday, 06 Jan 2025 15:45:00 GMT';

      const result = validate(EVENT_ENVELOPE_ID, invalidEnvelope);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('Expected timestamp validation failure');
      const errorShape = result.errors.map(({ path, keyword, params }) => ({ path, keyword, params }));
      expect(errorShape).toMatchInlineSnapshot(`
        [
          {
            "keyword": "format",
            "params": {
              "format": "date-time",
            },
            "path": "/timestamp",
          },
        ]
      `);
    });
  });

  describe('pharmacy.referral', () => {
    const fixture = loadFixture('pharmacy.referral.json');

    it('accepts minimal and maximal payloads', () => {
      for (const variant of [fixture.minimal, fixture.maximal]) {
        const env = variant.envelope;
        expectValidEnvelope(env);
        expectValidPayload(PHARMACY_REFERRAL_ID, env.payload);
      }
    });

    it('rejects missing required fields and additional properties', () => {
      const invalidPayload = clone(fixture.minimal.envelope.payload);
      delete invalidPayload.condition;
      // @ts-expect-error - injecting invalid property for test
      invalidPayload.extra = 'unexpected';

      const errors = collectErrorShape(PHARMACY_REFERRAL_ID, invalidPayload as Record<string, unknown>);
      expect(errors).toMatchInlineSnapshot(`
        [
          {
            "keyword": "required",
            "params": {
              "missingProperty": "condition",
            },
            "path": "/condition",
          },
          {
            "keyword": "additionalProperties",
            "params": {
              "additionalProperty": "extra",
            },
            "path": "/extra",
          },
        ]
      `);
    });

    it('requires RFC3339 timestamps within slot', () => {
      const invalidPayload = clone(fixture.maximal.envelope.payload) as Record<string, unknown> & {
        slot?: { start: string; end: string } | null;
      };
      if (invalidPayload.slot) {
        invalidPayload.slot.start = '08-01-2025 09:00';
      }

      const errors = collectErrorShape(PHARMACY_REFERRAL_ID, invalidPayload as Record<string, unknown>);
      expect(errors).toMatchInlineSnapshot(`
        [
          {
            "keyword": "format",
            "params": {
              "format": "date-time",
            },
            "path": "/slot/start",
          },
        ]
      `);
    });
  });

  describe('pharmacy.outcome', () => {
    const fixture = loadFixture('pharmacy.outcome.json');

    it('accepts minimal and maximal payloads', () => {
      for (const variant of [fixture.minimal, fixture.maximal]) {
        const env = variant.envelope;
        expectValidEnvelope(env);
        expectValidPayload(PHARMACY_OUTCOME_ID, env.payload);
      }
    });

    it('rejects missing required fields and additional properties', () => {
      const invalidPayload = clone(fixture.minimal.envelope.payload);
      delete invalidPayload.referralReference;
      // @ts-expect-error - injecting invalid property for test
      invalidPayload.extra = 'unexpected';

      const errors = collectErrorShape(PHARMACY_OUTCOME_ID, invalidPayload as Record<string, unknown>);
      expect(errors).toMatchInlineSnapshot(`
        [
          {
            "keyword": "additionalProperties",
            "params": {
              "additionalProperty": "extra",
            },
            "path": "/extra",
          },
          {
            "keyword": "required",
            "params": {
              "missingProperty": "referralReference",
            },
            "path": "/referralReference",
          },
        ]
      `);
    });

    it('requires RFC3339 recordedAt timestamps', () => {
      const invalidPayload = clone(fixture.maximal.envelope.payload);
      invalidPayload.recordedAt = '07-01-2025 11:05:05';

      const errors = collectErrorShape(PHARMACY_OUTCOME_ID, invalidPayload as Record<string, unknown>);
      expect(errors).toMatchInlineSnapshot(`
        [
          {
            "keyword": "format",
            "params": {
              "format": "date-time",
            },
            "path": "/recordedAt",
          },
        ]
      `);
    });
  });

  describe('ics.referral.request', () => {
    const fixture = loadFixture('ics.referral.request.json');

    it('accepts minimal and maximal payloads', () => {
      for (const variant of [fixture.minimal, fixture.maximal]) {
        const env = variant.envelope;
        expectValidEnvelope(env);
        expectValidPayload(ICS_REFERRAL_REQUEST_ID, env.payload);
      }
    });

    it('rejects missing required fields and additional properties', () => {
      const invalidPayload = clone(fixture.minimal.envelope.payload);
      delete invalidPayload.org;
      // @ts-expect-error - injecting invalid property for test
      invalidPayload.metadata = { priority: 'low' };

      const errors = collectErrorShape(ICS_REFERRAL_REQUEST_ID, invalidPayload as Record<string, unknown>);
      expect(errors).toMatchInlineSnapshot(`
        [
          {
            "keyword": "additionalProperties",
            "params": {
              "additionalProperty": "metadata",
            },
            "path": "/metadata",
          },
          {
            "keyword": "required",
            "params": {
              "missingProperty": "org",
            },
            "path": "/org",
          },
        ]
      `);
    });
  });

  describe('ics.referral.ack', () => {
    const fixture = loadFixture('ics.referral.ack.json');

    it('accepts minimal and maximal payloads', () => {
      for (const variant of [fixture.minimal, fixture.maximal]) {
        const env = variant.envelope;
        expectValidEnvelope(env);
        expectValidPayload(ICS_REFERRAL_ACK_ID, env.payload);
      }
    });

    it('rejects missing required fields and additional properties', () => {
      const invalidPayload = clone(fixture.minimal.envelope.payload);
      delete invalidPayload.referralId;
      // @ts-expect-error - injecting invalid property for test
      invalidPayload.details = 'extra context';

      const errors = collectErrorShape(ICS_REFERRAL_ACK_ID, invalidPayload as Record<string, unknown>);
      expect(errors).toMatchInlineSnapshot(`
        [
          {
            "keyword": "additionalProperties",
            "params": {
              "additionalProperty": "details",
            },
            "path": "/details",
          },
          {
            "keyword": "required",
            "params": {
              "missingProperty": "referralId",
            },
            "path": "/referralId",
          },
        ]
      `);
    });
  });
});
