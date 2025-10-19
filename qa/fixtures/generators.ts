import fc from 'fast-check';
import type { PortalSubmission } from '../../packages/events/src/contracts/portal';
import type { TriageInput } from '../../packages/events/src/contracts/triage';
import type { AppointmentCreated } from '../../packages/events/src/contracts/appointment-created';
import type { PharmacyReferral } from '../../packages/events/src/contracts/pharmacy';
import type { IcsReferralRequest } from '../../packages/events/src/contracts/ics-referral-request';
import type { IcsReferralAck } from '../../packages/events/src/contracts/ics-referral-ack';
import type { TaskCreated } from '../../packages/events/src/contracts/task-created';
import type { CallTranscribed } from '../../packages/events/src/contracts/call-transcribed';
import type { SafetyDecision } from '../../packages/events/src/contracts/safety';
import type { ErrorEnvelope } from '../../packages/events/src/contracts/error-envelope';

export interface NegativeCase<T> {
  payload: T;
  expected: { path: string; keyword: string };
}

export const portalSubmissionArb: fc.Arbitrary<PortalSubmission> = fc
  .record({
    practiceId: fc.constant('demo'),
    patient: fc.record({
      id: fc.string({ minLength: 8, maxLength: 24 }),
      dob: fc.option(fc.date({ min: new Date('1940-01-01'), max: new Date('2020-12-31') }).map((d) => d.toISOString().slice(0, 10)), {
        nil: undefined,
      }),
      locale: fc.option(fc.constantFrom('en-GB', 'es-ES'), { nil: undefined }),
    }),
    narrative: fc.string({ minLength: 24, maxLength: 220 }),
    attachments: fc.option(
      fc.array(
        fc.record({
          contentType: fc.constantFrom('application/pdf', 'image/png'),
          url: fc.webUrl({ authoritySettings: { withIpv4: false, withIpv6: false, withUserInfo: false } }),
        }),
        { minLength: 1, maxLength: 3 },
      ),
      { nil: undefined },
    ),
    interpreterPreferences: fc.option(
      fc.record({
        requiresInterpreter: fc.boolean(),
        preferredLanguages: fc.option(fc.array(fc.constantFrom('en', 'es', 'fr'), { minLength: 1, maxLength: 3 }), {
          nil: undefined,
        }),
        notes: fc.option(fc.string({ minLength: 4, maxLength: 100 }), { nil: undefined }),
        requiresInterpreterConfirmed: fc.option(fc.boolean(), { nil: undefined }),
      }),
      { nil: undefined },
    ),
    channel: fc.constantFrom('web', 'ivr'),
  })
  .map((submission) => normalizePortalSubmission(submission));

export const triageInputArb: fc.Arbitrary<TriageInput> = fc
  .record({
    patientId: fc.string({ minLength: 8, maxLength: 24 }),
    narrative: fc.string({ minLength: 12, maxLength: 512 }),
    features: fc.option(
      fc.dictionary(
        fc.string({ minLength: 3, maxLength: 24 }),
        fc.oneof(
          fc.string({ maxLength: 64 }),
          fc.double({ min: -1_000, max: 1_000, noDefaultInfinity: true, noNaN: true }),
          fc.boolean(),
          fc.constant(null),
        ),
        { maxKeys: 6 },
      ),
      { nil: undefined },
    ),
  })
  .map((raw) => {
    const features = raw.features ?? undefined;
    if (features && Object.keys(features).length === 0) {
      delete raw.features;
    }
    return raw as TriageInput;
  });

export const appointmentCreatedArb: fc.Arbitrary<AppointmentCreated> = fc
  .record({
    appointmentId: fc.uuid(),
    patientId: fc.string({ minLength: 8, maxLength: 24 }),
    start: isoDateTimeArbitrary(),
    durationMinutes: fc.integer({ min: 10, max: 45 }),
    location: fc.option(fc.string({ minLength: 4, maxLength: 48 }), { nil: undefined }),
  })
  .map(({ durationMinutes, location, ...rest }) => {
    const startTs = Date.parse(rest.start);
    const endTs = startTs + durationMinutes * 60_000;
    const payload: AppointmentCreated = {
      ...rest,
      end: new Date(endTs).toISOString(),
    };
    if (location !== undefined && location !== null) {
      payload.location = location;
    }
    return payload;
  });

export const pharmacyReferralArb: fc.Arbitrary<PharmacyReferral> = fc
  .record({
    patientId: fc.string({ minLength: 8, maxLength: 24 }),
    condition: fc.string({ minLength: 4, maxLength: 64 }),
    pharmacyOrg: fc.string({ minLength: 4, maxLength: 24 }),
    patientAgeYears: fc.option(fc.integer({ min: 0, max: 120 }), { nil: undefined }).map((value) => value ?? null),
    patientSex: fc.option(fc.constantFrom('female', 'male', 'other', 'unknown'), { nil: undefined }).map((value) => value ?? null),
    severity: fc.option(fc.string({ minLength: 3, maxLength: 32 }), { nil: undefined }).map((value) => value ?? null),
    exclusionFlags: fc.option(fc.array(fc.string({ minLength: 3, maxLength: 32 }), { maxLength: 4 }), { nil: undefined }),
    slot: fc.option(
      fc.oneof(
        fc.constant(null),
        fc.record({
          start: isoDateTimeArbitrary(),
          offsetMinutes: fc.integer({ min: 5, max: 60 }),
          locationOdsCode: fc.option(fc.string({ minLength: 4, maxLength: 32 }), { nil: undefined }),
          reference: fc.option(fc.string({ minLength: 4, maxLength: 32 }), { nil: undefined }),
        }),
      ),
      { nil: undefined },
    ),
  })
  .map((raw) => normalizePharmacyReferral(raw));

export const icsReferralRequestArb: fc.Arbitrary<IcsReferralRequest> = fc.record({
  referralId: fc.uuid(),
  patientId: fc.string({ minLength: 8, maxLength: 24 }),
  org: fc.string({ minLength: 4, maxLength: 36 }),
  reason: fc.string({ minLength: 8, maxLength: 128 }),
});

export const icsReferralAckArb: fc.Arbitrary<IcsReferralAck> = fc
  .record({
    referralId: fc.uuid(),
    accepted: fc.boolean(),
    note: fc.option(fc.string({ minLength: 4, maxLength: 96 }), { nil: undefined }).map((value) => value ?? null),
  })
  .map((raw) => raw as IcsReferralAck);

export const taskCreatedArb: fc.Arbitrary<TaskCreated> = fc.record({
  taskId: fc.uuid(),
  patientId: fc.string({ minLength: 8, maxLength: 24 }),
  priority: fc.constantFrom('STAT', 'URGENT', 'SOON', 'ROUTINE'),
  owner: fc.option(fc.string({ minLength: 4, maxLength: 48 }), { nil: undefined }),
});

export const callTranscribedArb: fc.Arbitrary<CallTranscribed> = fc.record({
  callId: fc.uuid(),
  patientId: fc.option(fc.string({ minLength: 8, maxLength: 24 }), { nil: undefined }).map((value) => value ?? null),
  transcript: fc.string({ minLength: 24, maxLength: 320 }),
  lang: fc.option(fc.constantFrom('en', 'es', 'cy'), { nil: undefined }).map((value) => value ?? null),
});

export const safetyDecisionArb: fc.Arbitrary<SafetyDecision> = fc.record({
  outcome: fc.constantFrom('SAFE_TO_CONTINUE', 'DIVERTED'),
  reason: fc.option(fc.string({ minLength: 4, maxLength: 64 }), { nil: undefined }).map((value) => value ?? null),
});

export const errorEnvelopeArb: fc.Arbitrary<ErrorEnvelope> = fc.record({
  error: fc.record({
    code: fc.constantFrom(
      'unauthorized',
      'forbidden',
      'invalid_input',
      'unsupported_media_type',
      'payload_too_large',
      'conflict',
      'upstream_timeout',
      'upstream_unavailable',
      'internal_error',
      'too_many_requests',
      'busy',
      'invalid_fhir',
    ),
    message: fc.string({ minLength: 8, maxLength: 160 }),
    details: fc.option(
      fc.dictionary(fc.string({ minLength: 2, maxLength: 24 }), fc.oneof(fc.string({ maxLength: 64 }), fc.integer({ min: -10_000, max: 10_000 }), fc.boolean(), fc.constant(null)), {
        maxKeys: 4,
      }),
      { nil: undefined },
    ),
    correlationId: fc.option(fc.string({ minLength: 12, maxLength: 36 }), { nil: undefined }),
  }),
});

export const triageNearMissArb: fc.Arbitrary<NegativeCase<TriageInput>> = triageInputArb.chain((valid) => {
  const base = deepClone(valid);
  const cases: NegativeCase<TriageInput>[] = [
    (() => {
      const mutated = deepClone(base);
      mutated.patientId = null as unknown as string;
      return { payload: mutated, expected: { path: '/patientId', keyword: 'type' } };
    })(),
    (() => {
      const mutated = deepClone(base);
      const features = { ...(mutated.features ?? {}) } as Record<string, unknown>;
      features.symptomDurationHours = [] as unknown as number;
      mutated.features = features as TriageInput['features'];
      return { payload: mutated, expected: { path: '/features/symptomDurationHours', keyword: 'type' } };
    })(),
  ];
  return fc.constantFrom(...cases);
});

function normalizePortalSubmission(submission: PortalSubmission): PortalSubmission {
  const normalized: PortalSubmission = { ...submission, patient: { ...submission.patient } };
  if (normalized.interpreterPreferences && normalized.interpreterPreferences.preferredLanguages) {
    const deduped = Array.from(new Set(normalized.interpreterPreferences.preferredLanguages));
    normalized.interpreterPreferences.preferredLanguages = deduped as PortalSubmission['interpreterPreferences']['preferredLanguages'];
  }
  return normalized;
}

function normalizePharmacyReferral(raw: PharmacyReferral & { slot?: PharmacyReferral['slot'] | { offsetMinutes: number } }): PharmacyReferral {
  const cloned = deepClone(raw);
  if (cloned.exclusionFlags && cloned.exclusionFlags.length) {
    cloned.exclusionFlags = Array.from(new Set(cloned.exclusionFlags)).sort();
  }
  if (cloned.slot && 'offsetMinutes' in (cloned.slot as Record<string, unknown>)) {
    const slot = cloned.slot as unknown as { start: string; offsetMinutes: number; locationOdsCode?: string; reference?: string };
    const end = new Date(Date.parse(slot.start) + slot.offsetMinutes * 60_000).toISOString();
    cloned.slot = {
      start: slot.start,
      end,
      locationOdsCode: slot.locationOdsCode,
      reference: slot.reference,
    };
  }
  return cloned as PharmacyReferral;
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isoDateTimeArbitrary(): fc.Arbitrary<string> {
  const start = new Date('2024-01-01T00:00:00.000Z').getTime();
  const end = new Date('2026-12-31T23:59:59.000Z').getTime();
  return fc
    .integer({ min: 0, max: end - start })
    .map((offset) => new Date(start + offset).toISOString());
}
