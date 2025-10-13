import { Topics, type TypedEnvelope, type IcsReferralRequest, type ErrorEnvelope } from '@onecare/events';
import { validate, type ValidationError } from '@onecare/domain';
import { createErrorEnvelope } from './errors';

const ENVELOPE_SCHEMA_ID = 'https://onecare/schemas/common/event-envelope.json';
const REFERRAL_SCHEMA_ID = 'https://onecare/schemas/ics/referral-request.json';

type ValidationFailureReason = 'invalid_envelope' | 'invalid_topic' | 'invalid_payload';

export type ReferralIngressValidation =
  | {
      ok: true;
      envelope: TypedEnvelope<IcsReferralRequest>;
      correlationId?: string;
    }
  | {
      ok: false;
      error: ErrorEnvelope;
      reason: ValidationFailureReason;
    };

function sanitiseErrors(errors: ValidationError[]): Array<{ path: string; keyword: string; message?: string }> {
  return errors.map(({ path, keyword, message }) => ({
    path,
    keyword,
    message,
  }));
}

export function validateReferralIngress(raw: unknown): ReferralIngressValidation {
  const envelopeResult = validate(ENVELOPE_SCHEMA_ID, raw);
  if (!envelopeResult.ok) {
    return {
      ok: false,
      reason: 'invalid_envelope',
      error: createErrorEnvelope(
        'invalid_input',
        'invalid_event_envelope',
        { errors: sanitiseErrors(envelopeResult.errors) },
      ),
    };
  }

  const envelope = raw as TypedEnvelope<IcsReferralRequest>;

  if (envelope.topic !== Topics.ics.referralRequest) {
    return {
      ok: false,
      reason: 'invalid_topic',
      error: createErrorEnvelope(
        'invalid_input',
        'unexpected_topic',
        {
          expected: Topics.ics.referralRequest,
          actual: envelope.topic,
        },
        envelope.correlationId,
      ),
    };
  }

  const payloadResult = validate(REFERRAL_SCHEMA_ID, envelope.payload);
  if (!payloadResult.ok) {
    return {
      ok: false,
      reason: 'invalid_payload',
      error: createErrorEnvelope(
        'invalid_input',
        'invalid_referral_payload',
        { errors: sanitiseErrors(payloadResult.errors) },
        envelope.correlationId,
      ),
    };
  }

  return {
    ok: true,
    envelope,
    correlationId: envelope.correlationId,
  };
}
