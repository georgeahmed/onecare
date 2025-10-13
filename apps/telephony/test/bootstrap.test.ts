import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  applyTelephonyDependencies,
  getIntentClassifier,
  setIntentClassifier,
  setIntentClassifierFactory,
} from '../src/application/bootstrap';
import type { TelephonyContext } from '../src/application/types';
import type { IntentClassifier } from '../src/adapters/intent.classifier';

describe('telephony bootstrap', () => {
  beforeEach(() => {
    setIntentClassifier(undefined);
    setIntentClassifierFactory(undefined);
  });

  afterEach(() => {
    setIntentClassifier(undefined);
    setIntentClassifierFactory(undefined);
  });

  it('memoizes intent classifier from factory override', () => {
    const classify = vi.fn(async () => ({ intent: 'demo', confidence: 0.9 }));
    const instance: IntentClassifier = { classify };
    const factory = vi.fn(() => instance);
    setIntentClassifierFactory(factory);

    const ctx = applyTelephonyDependencies({ id: 'call', callId: 'call' } as TelephonyContext);

    expect(ctx.intentClassifier).toBe(instance);
    expect(factory).toHaveBeenCalledTimes(1);

    const again = getIntentClassifier();
    expect(again).toBe(instance);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('allows tests to inject memoized classifier', () => {
    const classify = vi.fn(async () => ({ intent: 'manual', confidence: 0.1 }));
    const injected: IntentClassifier = { classify };
    setIntentClassifier(injected);

    const ctx = applyTelephonyDependencies({ id: 'call', callId: 'call' } as TelephonyContext);
    expect(ctx.intentClassifier).toBe(injected);

    const again = getIntentClassifier();
    expect(again).toBe(injected);
  });
});

