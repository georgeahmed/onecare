import type { TelephonyContext } from './types';
import type { IntentClassifier } from '../adapters/intent.classifier';
import { IntentServiceClassifier } from '../adapters/intent.client';

let singleton: IntentClassifier | undefined;
let factoryOverride: (() => IntentClassifier) | undefined;

function normalizeBoolean(value: string | undefined): boolean | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on', 'enabled'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off', 'disabled'].includes(normalized)) return false;
  return undefined;
}

function resolveEmergencyTransferEnabled(current?: boolean): boolean {
  if (typeof current === 'boolean') return current;
  const envOverride = normalizeBoolean(process.env.TELEPHONY_EMERGENCY_TRANSFER_ENABLED);
  if (envOverride !== undefined) return envOverride;
  const configDefault = normalizeBoolean(process.env.NHS_GP_TELEPHONY_EMERGENCY_TRANSFER_ENABLED);
  if (configDefault !== undefined) return configDefault;
  return true;
}

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
  ctx.ivrPrompts = ctx.ivrPrompts ?? [];
  ctx.enqueuePrompt = ctx.enqueuePrompt ?? (() => undefined);
  ctx.emergencyTransferEnabled = resolveEmergencyTransferEnabled(ctx.emergencyTransferEnabled);
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
