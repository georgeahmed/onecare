import { describe, expect, it } from 'vitest';
import { validate } from '../src/schema/validator';

const TRIAGE_INPUT_ID = 'https://onecare/schemas/triage/triage-input.json';
const APPOINTMENT_CREATED_ID = 'https://onecare/schemas/booking/appointment-created.json';
const ERROR_ENVELOPE_ID = 'https://onecare/schemas/common/error-envelope.json';
const DLQ_EVENT_ID = 'https://onecare.example/schemas/common/dlq-event.json';
const ANALYTICS_METRIC_ID = 'https://onecare/schemas/analytics/metric.json';

describe('schema validation harness', () => {
  describe('triage.input', () => {
    const validPayload = {
      patientId: 'patient-123',
      narrative: 'Needs follow-up consultation',
      features: { severity: 'high', priority: 10, escalationRequired: true },
    };

    it('accepts a valid payload', () => {
      const result = validate(TRIAGE_INPUT_ID, validPayload);
      expect(result).toEqual({ ok: true });
    });

    it('reports path and keyword for invalid payloads', () => {
      const invalidPayload = {
        narrative: 'Missing patient and has noise',
        unexpected: 'nope',
      };

      const result = validate(TRIAGE_INPUT_ID, invalidPayload);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('Expected validation failure');
      const errorShape = result.errors.map(({ path, keyword, params }) => ({ path, keyword, params }));
      expect(errorShape).toMatchInlineSnapshot(`
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
  });

  describe('appointment.created', () => {
    const validPayload = {
      appointmentId: 'appt-1',
      patientId: 'patient-123',
      start: '2025-01-01T09:00:00.000Z',
      end: '2025-01-01T09:30:00.000Z',
      location: 'Clinic A',
    };

    it('permits valid appointment payloads', () => {
      const result = validate(APPOINTMENT_CREATED_ID, validPayload);
      expect(result).toEqual({ ok: true });
    });

    it('yields deterministic errors for invalid payloads', () => {
      const invalidPayload = {
        appointmentId: 'appt-2',
        patientId: 'patient-123',
        start: 'not-a-date',
        end: '2025-01-01', // not RFC3339
        location: 123,
      };

      const result = validate(APPOINTMENT_CREATED_ID, invalidPayload);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('Expected validation failure');
      const errorShape = result.errors.map(({ path, keyword, params }) => ({ path, keyword, params }));
      expect(errorShape).toMatchInlineSnapshot(`
        [
          {
            "keyword": "format",
            "params": {
              "format": "date-time",
            },
            "path": "/end",
          },
          {
            "keyword": "type",
            "params": {
              "type": [
                "string",
                "null",
              ],
            },
            "path": "/location",
          },
          {
            "keyword": "format",
            "params": {
              "format": "date-time",
            },
            "path": "/start",
          },
        ]
      `);
    });
  });

  describe('error-envelope', () => {
    const validPayload = {
      error: {
        code: 'invalid_input',
        message: 'Invalid request body',
        details: { field: 'start' },
        correlationId: 'corr-123',
      },
    };

    it('accepts envelopes that match the contract', () => {
      const result = validate(ERROR_ENVELOPE_ID, validPayload);
      expect(result).toEqual({ ok: true });
    });

    it('flags invalid envelopes with stable error output', () => {
      const invalidPayload = {
        error: {
          code: 'unknown_code',
          correlationId: 'corr-123',
          extra: true,
        },
      };

      const result = validate(ERROR_ENVELOPE_ID, invalidPayload);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('Expected validation failure');
      const errorShape = result.errors.map(({ path, keyword, params }) => ({ path, keyword, params }));
      expect(errorShape).toMatchInlineSnapshot(`
        [
          {
            "keyword": "enum",
            "params": {
              "allowedValues": [
                "unauthorized",
                "forbidden",
                "invalid_input",
                "not_found",
                "unsupported_media_type",
                "payload_too_large",
                "conflict",
                "upstream_timeout",
                "upstream_unavailable",
                "internal_error",
                "too_many_requests",
                "rate_limited",
                "busy",
                "over_capacity",
                "invalid_fhir",
              ],
            },
            "path": "/error/code",
          },
          {
            "keyword": "additionalProperties",
            "params": {
              "additionalProperty": "extra",
            },
            "path": "/error/extra",
          },
          {
            "keyword": "required",
            "params": {
              "missingProperty": "message",
            },
            "path": "/error/message",
          },
        ]
      `);
    });
  });

  describe('dlq-event', () => {
    const validPayload = {
      originalTopic: 'triage.input',
      correlationId: 'corr-456',
      errorCode: 'validation_failed',
      errorMessage: 'schema mismatch',
      payloadRef: { bucket: 'events', key: 'triage/input/123' },
      ts: '2025-01-01T00:00:00.000Z',
    };

    it('validates DLQ events successfully', () => {
      const result = validate(DLQ_EVENT_ID, validPayload);
      expect(result).toEqual({ ok: true });
    });

    it('surfaces missing required fields and type issues', () => {
      const invalidPayload = {
        correlationId: 'corr-456',
        ts: 'yesterday',
        payloadRef: 42,
      };

      const result = validate(DLQ_EVENT_ID, invalidPayload);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('Expected validation failure');
      const errorShape = result.errors.map(({ path, keyword, params }) => ({ path, keyword, params }));
      expect(errorShape).toMatchInlineSnapshot(`
        [
          {
            "keyword": "required",
            "params": {
              "missingProperty": "originalTopic",
            },
            "path": "/originalTopic",
          },
          {
            "keyword": "type",
            "params": {
              "type": [
                "object",
                "string",
              ],
            },
            "path": "/payloadRef",
          },
          {
            "keyword": "format",
            "params": {
              "format": "date-time",
            },
            "path": "/ts",
          },
        ]
      `);
    });
  });

  describe('analytics.metric', () => {
    const validMetric = {
      name: 'requests_total',
      value: 12,
      labels: { service: 'booking' },
      timestamp: '2025-10-12T10:00:00.000Z',
    };

    it('accepts analytics metrics that align with the schema', () => {
      const result = validate(ANALYTICS_METRIC_ID, validMetric);
      expect(result).toEqual({ ok: true });
    });

    it('rejects metrics missing required fields and additional properties', () => {
      const invalidMetric = {
        value: 'not-numeric',
        labels: { service: 'booking' },
        extra: true,
      };

      const result = validate(ANALYTICS_METRIC_ID, invalidMetric);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('Expected validation failure');
      const errorShape = result.errors.map(({ path, keyword, params }) => ({ path, keyword, params }));
      expect(errorShape).toMatchInlineSnapshot(`
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
              "missingProperty": "name",
            },
            "path": "/name",
          },
        ]
      `);
    });
  });
});
