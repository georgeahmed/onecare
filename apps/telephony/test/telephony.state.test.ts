import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TranscribedState } from '../src/application/telephony.state';
import type { TelephonyContext } from '../src/application/types';
import { buildCallTranscribed } from '../src/adapters/asr.client';
import type { MessageBus } from '@onecare/bus';
import { Topics, type TypedEnvelope, type CallTranscribed } from '@onecare/events';

describe('TranscribedState', () => {
  let publishSpy: ReturnType<typeof vi.fn>;
  let bus: MessageBus;

  beforeEach(() => {
    publishSpy = vi.fn(async () => {});
    bus = {
      publish: publishSpy,
      subscribe: vi.fn(async () => ({
        unsubscribe: async () => {},
      })),
    };
  });

  it('transcribes audio, builds payload, and publishes call transcribed event', async () => {
    const transcribe = vi.fn(async () => ({
      text: '  thank you for calling  ',
      lang: ' en-GB ',
    }));

    const ctx: TelephonyContext = {
      id: 'call-001',
      callId: 'call-001',
      audioRef: 'memory://call-001',
      correlationId: 'corr-123',
      patientId: '  patient-9  ',
      asrClient: { transcribe },
      buildCallTranscribed,
      bus,
      now: () => 1_725_000_000_000,
    };

    const state = new TranscribedState();
    const next = await state.handle(ctx, { type: 'telephony.call.received' });

    expect(next).toBe('IntentClassified');
    expect(transcribe).toHaveBeenCalledWith('call-001', 'memory://call-001');

    expect(ctx.callTranscribed).toMatchObject({
      callId: 'call-001',
      transcript: 'thank you for calling',
      lang: 'en-GB',
      patientId: 'patient-9',
    });

    expect(publishSpy).toHaveBeenCalledTimes(1);
    const [topic, envelope, headers] = publishSpy.mock.calls[0] as [
      string,
      TypedEnvelope<CallTranscribed>,
      Record<string, string> | undefined,
    ];
    expect(topic).toBe(Topics.telephony.callTranscribed);
    expect(envelope.payload).toMatchObject({
      callId: 'call-001',
      transcript: 'thank you for calling',
    });
    expect(headers).toEqual({ 'x-correlation-id': 'corr-123' });
    expect(ctx.callTranscribedEnvelope).toEqual(envelope);
    expect(ctx.callTranscribedPublishedAt).toBe(1_725_000_000_000);
  });
});

