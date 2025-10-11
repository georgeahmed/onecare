import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { validate } from '../../src/schema/validator';

const FIXTURE_ROOT = path.join(__dirname, '..', 'fixtures', 'events');

const EVENT_ENVELOPE_ID = 'https://onecare/schemas/common/event-envelope.json';
const TRIAGE_INPUT_ID = 'https://onecare/schemas/triage/triage-input.json';
const TASK_CREATED_ID = 'https://onecare/schemas/tasks/task-created.json';
const APPOINTMENT_CREATED_ID = 'https://onecare/schemas/booking/appointment-created.json';

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
});
