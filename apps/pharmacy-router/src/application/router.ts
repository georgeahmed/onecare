import { StateMachine } from '@onecare/statekit';
import type { ResolvedConfig, PharmacyEligibilityRuleset } from '@onecare/config';
import {
  ClassifiedState,
  EligibleState,
  IneligibleState,
  ReferredState,
  OutcomeRecordedState,
  type PharmacyContext,
  type PharmacyEvent,
} from './pharmacy.state';

export interface PharmacyRouterResult {
  state: string;
  context: PharmacyContext;
}

export interface PharmacyRouterOptions {
  config?: ResolvedConfig;
  ruleset?: PharmacyEligibilityRuleset;
}

export function createPharmacyRouterMachine(
  context: PharmacyContext,
  options: PharmacyRouterOptions = {},
): StateMachine<PharmacyContext, PharmacyEvent> {
  const config = options.config ?? context.config;
  const ruleset = options.ruleset ?? context.ruleset;

  const classified = ruleset
    ? new ClassifiedState(ruleset)
    : config
      ? ClassifiedState.fromConfig(config)
      : new ClassifiedState();

  const machine = new StateMachine<PharmacyContext, PharmacyEvent>(classified, context);
  machine.register(classified);

  const eligible = new EligibleState();
  const ineligible = new IneligibleState();
  const referred = new ReferredState();
  const outcome = new OutcomeRecordedState();

  machine.register(eligible);
  machine.register(ineligible);
  machine.register(referred);
  machine.register(outcome);

  return machine;
}

export async function runPharmacyReferral(
  context: PharmacyContext,
  event: PharmacyEvent = { type: 'pharmacy.route' },
  options: PharmacyRouterOptions = {},
): Promise<PharmacyRouterResult> {
  const machine = createPharmacyRouterMachine(context, options);
  await machine.start();

  const terminalStates = new Set(['Ineligible', 'OutcomeRecorded']);

  do {
    await machine.dispatch(event);
  } while (!terminalStates.has(machine.state));

  // Execute terminal state handler once to perform side effects (write-back/escalation).
  await machine.dispatch(event);

  return { state: machine.state, context };
}
