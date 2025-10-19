import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { createEnvelope } from '../../packages/events/src/envelope-util';
import { Topics } from '../../packages/events/src/topics';
import { validate } from '../../packages/domain/src/schema/validator';
import type { AppointmentCreated } from '../../packages/events/src/contracts/appointment-created';
import type { ErrorEnvelope } from '../../packages/events/src/contracts/error-envelope';
import type { IcsReferralAck } from '../../packages/events/src/contracts/ics-referral-ack';
import type { IcsReferralRequest } from '../../packages/events/src/contracts/ics-referral-request';
import type { PharmacyReferral } from '../../packages/events/src/contracts/pharmacy';
import {
  appointmentCreatedArb,
  errorEnvelopeArb,
  icsReferralAckArb,
  icsReferralRequestArb,
  NegativeCase,
  pharmacyReferralArb,
  triageInputArb,
  triageNearMissArb,
} from '../fixtures/generators';

const EVENT_ENVELOPE_SCHEMA = 'https://onecare/schemas/common/event-envelope.json';
const TRIAGE_INPUT_SCHEMA = 'https://onecare/schemas/triage/triage-input.json';
const APPOINTMENT_CREATED_SCHEMA = 'https://onecare/schemas/booking/appointment-created.json';
const PHARMACY_REFERRAL_SCHEMA = 'https://onecare/schemas/pharmacy/pharmacy-referral.json';
const ICS_REFERRAL_REQUEST_SCHEMA = 'https://onecare/schemas/ics/referral-request.json';
const ICS_REFERRAL_ACK_SCHEMA = 'https://onecare/schemas/ics/referral-ack.json';
const ERROR_ENVELOPE_SCHEMA = 'https://onecare/schemas/common/error-envelope.json';
const PROPERTY_CONFIG: fc.Parameters = { numRuns: 40, seed: 20250117 };

function expectInvalid(result: ReturnType<typeof validate>, expected: { path: string; keyword: string }) {
  expect(result.ok).toBe(false);
  const match = result.ok
    ? undefined
    : result.errors.find((err) => {
        if (err.keyword !== expected.keyword) return false;
        if (err.path === expected.path) return true;
        if (expected.path && err.path.startsWith(`${expected.path}/`)) return true;
        if (err.path && expected.path.startsWith(`${err.path}/`)) return true;
        return false;
      });
  expect(match).toBeTruthy();
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

const appointmentNearMissArb: fc.Arbitrary<NegativeCase<AppointmentCreated>> = appointmentCreatedArb.chain((valid) => {
  const cases: NegativeCase<AppointmentCreated>[] = [
    (() => {
      const mutated = deepClone(valid);
      delete (mutated as Record<string, unknown>).start;
      return { payload: mutated, expected: { path: '/start', keyword: 'required' } };
    })(),
    (() => {
      const mutated = deepClone(valid);
      mutated.end = 'not-a-date';
      return { payload: mutated, expected: { path: '/end', keyword: 'format' } };
    })(),
    (() => {
      const mutated = deepClone(valid);
      (mutated as Record<string, unknown>).extra = 'nope';
      return { payload: mutated, expected: { path: '/extra', keyword: 'additionalProperties' } };
    })(),
  ];
  return fc.constantFrom(...cases);
});

const pharmacyNearMissArb: fc.Arbitrary<NegativeCase<PharmacyReferral>> = pharmacyReferralArb.chain((valid) => {
  const base = deepClone(valid);
  const cases: NegativeCase<PharmacyReferral>[] = [
    (() => {
      const mutated = deepClone(base);
      delete (mutated as Record<string, unknown>).patientId;
      return { payload: mutated, expected: { path: '/patientId', keyword: 'required' } };
    })(),
    (() => {
      const mutated = deepClone(base);
      mutated.patientId = '';
      return { payload: mutated, expected: { path: '/patientId', keyword: 'minLength' } };
    })(),
    (() => {
      const mutated = deepClone(base);
      mutated.slot = { start: base.slot && typeof base.slot === 'object' ? base.slot.start : base.slot ?? '2025-01-01T00:00:00.000Z' } as PharmacyReferral['slot'];
      return { payload: mutated, expected: { path: '/slot/end', keyword: 'required' } };
    })(),
    (() => {
      const mutated = deepClone(base) as Record<string, unknown>;
      mutated.phiLeak = 'should-not-be-here';
      return { payload: mutated as PharmacyReferral, expected: { path: '/phiLeak', keyword: 'additionalProperties' } };
    })(),
  ];
  return fc.constantFrom(...cases);
});

const icsRequestNearMissArb: fc.Arbitrary<NegativeCase<IcsReferralRequest>> = icsReferralRequestArb.chain((valid) => {
  const cases: NegativeCase<IcsReferralRequest>[] = [
    (() => {
      const mutated = deepClone(valid);
      (mutated as Record<string, unknown>).reason = 42;
      return { payload: mutated, expected: { path: '/reason', keyword: 'type' } };
    })(),
    (() => {
      const mutated = deepClone(valid);
      delete (mutated as Record<string, unknown>).org;
      return { payload: mutated, expected: { path: '/org', keyword: 'required' } };
    })(),
    (() => {
      const mutated = deepClone(valid) as Record<string, unknown>;
      mutated.extra = true;
      return { payload: mutated as IcsReferralRequest, expected: { path: '/extra', keyword: 'additionalProperties' } };
    })(),
  ];
  return fc.constantFrom(...cases);
});

const icsAckNearMissArb: fc.Arbitrary<NegativeCase<IcsReferralAck>> = icsReferralAckArb.chain((valid) => {
  const cases: NegativeCase<IcsReferralAck>[] = [
    (() => {
      const mutated = deepClone(valid);
      delete (mutated as Record<string, unknown>).referralId;
      return { payload: mutated, expected: { path: '/referralId', keyword: 'required' } };
    })(),
    (() => {
      const mutated = deepClone(valid);
      (mutated as Record<string, unknown>).accepted = 'yes';
      return { payload: mutated, expected: { path: '/accepted', keyword: 'type' } };
    })(),
    (() => {
      const mutated = deepClone(valid) as Record<string, unknown>;
      mutated.notes = 'nope';
      return { payload: mutated as IcsReferralAck, expected: { path: '/notes', keyword: 'additionalProperties' } };
    })(),
  ];
  return fc.constantFrom(...cases);
});

const errorEnvelopeNearMissArb: fc.Arbitrary<NegativeCase<ErrorEnvelope>> = errorEnvelopeArb.chain((valid) => {
  const cases: NegativeCase<ErrorEnvelope>[] = [
    (() => {
      const mutated = deepClone(valid);
      delete (mutated as Record<string, unknown>).error;
      return { payload: mutated, expected: { path: '/error', keyword: 'required' } };
    })(),
    (() => {
      const mutated = deepClone(valid);
      mutated.error.code = 'unexpected' as ErrorEnvelope['error']['code'];
      return { payload: mutated, expected: { path: '/error/code', keyword: 'enum' } };
    })(),
    (() => {
      const mutated = deepClone(valid) as Record<string, unknown>;
      mutated.context = 'phi';
      return { payload: mutated as ErrorEnvelope, expected: { path: '/context', keyword: 'additionalProperties' } };
    })(),
  ];
  return fc.constantFrom(...cases);
});

describe('Contract property tests', () => {
  it('triage.input payloads validate together with envelopes', async () => {
    await fc.assert(
      fc.asyncProperty(triageInputArb, async (payload) => {
        const envelope = createEnvelope(Topics.triage.input, payload, 'corr-triage');
        expect(validate(EVENT_ENVELOPE_SCHEMA, envelope).ok).toBe(true);
        expect(validate(TRIAGE_INPUT_SCHEMA, envelope.payload).ok).toBe(true);
      }),
      PROPERTY_CONFIG,
    );
  });

  it('triage.input near-misses fail with stable errors', async () => {
    await fc.assert(
      fc.asyncProperty(triageNearMissArb, async ({ payload, expected }) => {
        const result = validate(TRIAGE_INPUT_SCHEMA, payload);
        expectInvalid(result, expected);
      }),
      { ...PROPERTY_CONFIG, endOnFailure: true },
    );
  });

  it('appointment.created payloads satisfy schema', async () => {
    await fc.assert(
      fc.asyncProperty(appointmentCreatedArb, async (payload) => {
        const envelope = createEnvelope(Topics.booking.appointmentCreated, payload, 'corr-appointment');
        expect(validate(EVENT_ENVELOPE_SCHEMA, envelope).ok).toBe(true);
        expect(validate(APPOINTMENT_CREATED_SCHEMA, envelope.payload).ok).toBe(true);
      }),
      PROPERTY_CONFIG,
    );
  });

  it('appointment.created near-misses are rejected predictably', async () => {
    await fc.assert(
      fc.asyncProperty(appointmentNearMissArb, async ({ payload, expected }) => {
        const result = validate(APPOINTMENT_CREATED_SCHEMA, payload);
        expectInvalid(result, expected);
      }),
      { ...PROPERTY_CONFIG, endOnFailure: true },
    );
  });

  it('pharmacy.referral payloads cover optional branches', async () => {
    await fc.assert(
      fc.asyncProperty(pharmacyReferralArb, async (payload) => {
        const envelope = createEnvelope(Topics.pharmacy.referral, payload, 'corr-pharmacy');
        expect(validate(EVENT_ENVELOPE_SCHEMA, envelope).ok).toBe(true);
        expect(validate(PHARMACY_REFERRAL_SCHEMA, envelope.payload).ok).toBe(true);
      }),
      PROPERTY_CONFIG,
    );
  });

  it('pharmacy.referral near-misses surface schema drift', async () => {
    await fc.assert(
      fc.asyncProperty(pharmacyNearMissArb, async ({ payload, expected }) => {
        const result = validate(PHARMACY_REFERRAL_SCHEMA, payload);
        expectInvalid(result, expected);
      }),
      { ...PROPERTY_CONFIG, endOnFailure: true },
    );
  });

  it('ics.referral.request payloads respect schema boundaries', async () => {
    await fc.assert(
      fc.asyncProperty(icsReferralRequestArb, async (payload) => {
        const envelope = createEnvelope(Topics.ics.referralRequest, payload, 'corr-ics-req');
        expect(validate(EVENT_ENVELOPE_SCHEMA, envelope).ok).toBe(true);
        expect(validate(ICS_REFERRAL_REQUEST_SCHEMA, envelope.payload).ok).toBe(true);
      }),
      PROPERTY_CONFIG,
    );
  });

  it('ics.referral.request near-misses fail deterministically', async () => {
    await fc.assert(
      fc.asyncProperty(icsRequestNearMissArb, async ({ payload, expected }) => {
        const result = validate(ICS_REFERRAL_REQUEST_SCHEMA, payload);
        expectInvalid(result, expected);
      }),
      { ...PROPERTY_CONFIG, endOnFailure: true },
    );
  });

  it('ics.referral.ack payloads satisfy schema', async () => {
    await fc.assert(
      fc.asyncProperty(icsReferralAckArb, async (payload) => {
        const envelope = createEnvelope(Topics.ics.referralAck, payload, 'corr-ics-ack');
        expect(validate(EVENT_ENVELOPE_SCHEMA, envelope).ok).toBe(true);
        expect(validate(ICS_REFERRAL_ACK_SCHEMA, envelope.payload).ok).toBe(true);
      }),
      PROPERTY_CONFIG,
    );
  });

  it('ics.referral.ack near-misses are rejected predictably', async () => {
    await fc.assert(
      fc.asyncProperty(icsAckNearMissArb, async ({ payload, expected }) => {
        const result = validate(ICS_REFERRAL_ACK_SCHEMA, payload);
        expectInvalid(result, expected);
      }),
      { ...PROPERTY_CONFIG, endOnFailure: true },
    );
  });

  it('error envelopes respect minimal safe payloads', async () => {
    await fc.assert(
      fc.asyncProperty(errorEnvelopeArb, async (payload) => {
        expect(validate(ERROR_ENVELOPE_SCHEMA, payload).ok).toBe(true);
      }),
      PROPERTY_CONFIG,
    );
  });

  it('error envelope near-misses expose schema deviations', async () => {
    await fc.assert(
      fc.asyncProperty(errorEnvelopeNearMissArb, async ({ payload, expected }) => {
        const result = validate(ERROR_ENVELOPE_SCHEMA, payload);
        expectInvalid(result, expected);
      }),
      { ...PROPERTY_CONFIG, endOnFailure: true },
    );
  });
});
