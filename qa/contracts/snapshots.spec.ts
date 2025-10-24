import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { createEnvelope } from '../../packages/events/src/envelope-util';
import { Topics } from '../../packages/events/src/topics';
import { validate } from '../../packages/domain/src/schema/validator';

const EVENT_ENVELOPE_SCHEMA = 'https://onecare/schemas/common/event-envelope.json';
const SNAPSHOT_DIR = join(__dirname, 'snapshots');

type SnapshotCase = {
  file: string;
  schema: string;
  topic?: string;
};

const SNAPSHOTS: SnapshotCase[] = [
  { file: 'triage-input.json', schema: 'https://onecare/schemas/triage/triage-input.json', topic: Topics.triage.input },
  { file: 'appointment-created.json', schema: 'https://onecare/schemas/booking/appointment-created.json', topic: Topics.booking.appointmentCreated },
  { file: 'pharmacy-referral.json', schema: 'https://onecare/schemas/pharmacy/pharmacy-referral.json', topic: Topics.pharmacy.referral },
  { file: 'ics-referral-request.json', schema: 'https://onecare/schemas/ics/referral-request.json', topic: Topics.ics.referralRequest },
  { file: 'ics-referral-ack.json', schema: 'https://onecare/schemas/ics/referral-ack.json', topic: Topics.ics.referralAck },
  { file: 'error-envelope.json', schema: 'https://onecare/schemas/common/error-envelope.json' },
];

describe('Contract snapshots', () => {
  for (const snapshot of SNAPSHOTS) {
    it(`validates ${snapshot.file}`, () => {
      const payload = readSnapshot(snapshot.file);
      const result = validate(snapshot.schema, payload);
      expect(result.ok).toBe(true);

      if (snapshot.topic) {
        const envelope = createEnvelope(snapshot.topic, payload, `corr:${snapshot.file}`);
        const envelopeValidation = validate(EVENT_ENVELOPE_SCHEMA, envelope);
        expect(envelopeValidation.ok).toBe(true);
      }
    });
  }
});

function readSnapshot(file: string): unknown {
  const path = join(SNAPSHOT_DIR, file);
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}
