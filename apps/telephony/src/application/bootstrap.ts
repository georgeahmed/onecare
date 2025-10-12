import type { TelephonyContext } from './types';
import type { IntentClassifier } from '../adapters/intent.classifier';
import { IntentServiceClassifier } from '../adapters/intent.client';

let singleton: IntentClassifier | undefined;
let factoryOverride: (() => IntentClassifier) | undefined;

function buildIntentClassifier(): IntentClassifier {
  if (factoryOverride) {
    return factoryOverride();
  }
  return IntentServiceClassifier.fromEnv();
}

export function getIntentClassifier(): IntentClassifier {
  if (!singleton) {
    singleton = buildIntentClassifier();
  }
  return singleton;
}

/**
 * Applies telephony dependencies (intent classifier, etc.) to the provided context.
 * Call this once per call/session before running the state machine.
 */
export function applyTelephonyDependencies<T extends TelephonyContext>(ctx: T): T {
  if (!ctx.intentClassifier) {
    ctx.intentClassifier = getIntentClassifier();
  }
  return ctx;
}

/**
 * Allows tests to inject a deterministic intent classifier factory.
 */
export function setIntentClassifierFactory(factory?: () => IntentClassifier): void {
  factoryOverride = factory;
  singleton = undefined;
}

/**
 * Allows tests to inject a pre-built classifier and memoize it.
 */
export function setIntentClassifier(instance: IntentClassifier | undefined): void {
  singleton = instance;
  factoryOverride = instance ? () => instance : undefined;
}
