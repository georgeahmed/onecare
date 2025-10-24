import { StateMachine } from '@onecare/statekit';
import type { StateName } from '@onecare/statekit';
import type { IcsOrganisationPolicy } from '@onecare/config';
import {
  AckedState,
  BlockedState,
  InboundState,
  InvalidState,
  RateLimitedState,
  RoutedState,
  ValidatedState,
  type IcsContext,
  type IcsEvent,
  type RoutingConfig,
  type InboundStateOptions,
} from './ics.state';

export interface BuildIcsMachineOptions {
  policies?: Record<string, IcsOrganisationPolicy>;
  routing?: RoutingConfig;
  inboundOptions?: InboundStateOptions;
}

const DEFAULT_TERMINAL_STATES = new Set<StateName>(['Acked', 'Blocked', 'RateLimited', 'Invalid']);

export function buildIcsMachine(
  ctx: IcsContext,
  options: BuildIcsMachineOptions = {},
): StateMachine<IcsContext, IcsEvent> {
  const inbound = new InboundState(options.policies ?? {}, options.routing ?? {}, options.inboundOptions);
  const machine = new StateMachine<IcsContext, IcsEvent>(inbound, ctx);
  const states = [
    inbound,
    new ValidatedState(),
    new BlockedState(),
    new RateLimitedState(),
    new InvalidState(),
    new RoutedState(),
    new AckedState(),
  ];
  states.forEach((state) => machine.register(state));
  return machine;
}

export interface RunIcsMachineOptions {
  event?: IcsEvent;
  maxTransitions?: number;
  terminalStates?: Iterable<StateName>;
}

export async function runIcsMachine(
  machine: StateMachine<IcsContext, IcsEvent>,
  options: RunIcsMachineOptions = {},
): Promise<void> {
  const event = options.event ?? ({ type: 'ics.route' } as IcsEvent);
  const maxTransitions = options.maxTransitions ?? 10;
  const terminalStates = options.terminalStates
    ? new Set(options.terminalStates)
    : DEFAULT_TERMINAL_STATES;

  await machine.start();
  let transitions = 0;
  while (!terminalStates.has(machine.state)) {
    transitions += 1;
    if (transitions > maxTransitions) {
      throw new Error('ics.state_machine_transition_limit_exceeded');
    }
    await machine.dispatch(event);
  }

  // Execute the terminal state's handler once to flush side effects (ack publication, etc.).
  await machine.dispatch(event);
}
