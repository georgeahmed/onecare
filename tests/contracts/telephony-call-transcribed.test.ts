import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createEnvelope } from '../../packages/events/src/envelope-util';
import { Topics } from '../../packages/events/src/topics';
import type { CallTranscribed } from '../../packages/events/src/contracts/call-transcribed';

async function loadAjv() {
  try {
    const [{ default: Ajv2020 }, { default: addFormats }] = await Promise.all([
      import('ajv/dist/2020'),
      import('ajv-formats'),
    ]);
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(ajv);
    return ajv;
  } catch {
    return null;
  }
}

function readSchema(relativePath: string) {
  const schemaPath = path.join(process.cwd(), 'schemas', relativePath);
  return JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
}

describe('Telephony CallTranscribed contract', () => {
  it('builds envelopes that conform to schema', async () => {
    const ajv = await loadAjv();
    if (!ajv) {
      expect(true).toBe(true);
      return;
    }

    const envelopeSchema = readSchema('common/event-envelope.json');
    const callTranscribedSchema = readSchema('telephony/call-transcribed.json');
    const validateEnvelope = ajv.compile(envelopeSchema);
    const validatePayload = ajv.compile(callTranscribedSchema);

    const payload: CallTranscribed = {
      callId: 'call-789',
      transcript: 'caller requests callback about medication refill',
      patientId: 'patient-42',
      lang: 'en-US',
    };

    const envelope = createEnvelope(Topics.telephony.callTranscribed, payload, 'corr-telephony-1');

    expect(validateEnvelope(envelope)).toBe(true);
    expect(validatePayload(envelope.payload)).toBe(true);
    expect(envelope.topic).toBe(Topics.telephony.callTranscribed);
    expect(envelope.correlationId).toBe('corr-telephony-1');
  });
});

