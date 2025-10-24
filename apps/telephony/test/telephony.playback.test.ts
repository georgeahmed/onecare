import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { MemoryBus } from '@onecare/bus';
import { Topics } from '@onecare/events';

import { applyTelephonyDependencies } from '../src/application/bootstrap';
import {
  CallReceivedState,
  LanguageSelectionState,
  TranscribedState,
  IntentClassifiedState,
  RoutedState,
} from '../src/application/telephony.state';
import type { TelephonyContext } from '../src/application/types';

interface PlaybackScenario {
  callId: string;
  audioRef: string;
  patientId?: string;
  transcript: string;
  intent: string;
  confidence?: number;
  language?: string;
  correlationId?: string;
}

const scenariosPath = join(process.cwd(), 'fixtures', 'telephony', 'playback-scenarios.json');
const scenarios: PlaybackScenario[] = JSON.parse(readFileSync(scenariosPath, 'utf8')) as PlaybackScenario[];

describe('Telephony playback harness', () => {
  it('replays recorded scenarios deterministically', async () => {
    const asrMap = new Map<string, PlaybackScenario>();
    scenarios.forEach((scenario) => {
      asrMap.set(scenario.callId, scenario);
    });

    const asrClient = {
      transcribe: vi.fn(async (callId: string) => {
        const scenario = asrMap.get(callId);
        if (!scenario) {
          throw new Error(`scenario ${callId} missing`);
        }
        return {
          text: scenario.transcript,
          lang: scenario.language ?? null,
        };
      }),
    };

    const intentClassifier = {
      classify: vi.fn(async ({ callId }: { callId: string }) => {
        const scenario = asrMap.get(callId);
        if (!scenario) {
          throw new Error(`scenario ${callId} missing`);
        }
        return {
          intent: scenario.intent,
          confidence: scenario.confidence,
        };
      }),
    };

    const bus = new MemoryBus();
    const callMessages: unknown[] = [];
    const intentMessages: unknown[] = [];

    await bus.subscribe(Topics.telephony.callTranscribed, async (message) => {
      callMessages.push(message);
    });

    await bus.subscribe(Topics.telephony.intentClassified, async (message) => {
      intentMessages.push(message);
    });

    const callState = new CallReceivedState();
    const languageState = new LanguageSelectionState();
    const transcribedState = new TranscribedState();
    const intentState = new IntentClassifiedState();
    const routedState = new RoutedState();

    for (const scenario of scenarios) {
      const ctx: TelephonyContext = applyTelephonyDependencies({
        id: scenario.callId,
        callId: scenario.callId,
        audioRef: scenario.audioRef,
        patientId: scenario.patientId,
        correlationId: scenario.correlationId,
        asrClient,
        intentClassifier,
        bus,
      } as TelephonyContext);

      await callState.handle(ctx, { type: 'telephony.call.received' });
      await languageState.handle(ctx, { type: 'telephony.language.selection' });
      await transcribedState.handle(ctx, { type: 'telephony.call.transcribed' });
      await intentState.handle(ctx, { type: 'telephony.intent.classified' });
      await routedState.handle(ctx, { type: 'telephony.call.routed' });

      if (scenario.intent === 'telephony.emergency') {
        expect(ctx.intentRouteTarget).toBe('emergency');
      }
    }

    expect(callMessages).toHaveLength(scenarios.length);
    expect(intentMessages).toHaveLength(scenarios.length);

    const publishedIntentPayloads = intentMessages.map((msg: unknown) =>
      (msg as { payload: { payload: { intent: string } } }).payload.payload.intent,
    );
    expect(publishedIntentPayloads).toEqual(scenarios.map((scenario) => scenario.intent));
  });
});
