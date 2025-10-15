import { StateMachine } from '@onecare/statekit';
import type { OrchestratorContext, OrchestratorEvent } from '../types';
import {
  ReceivedState,
  AuthorizedState,
  ConsentCheckedState,
  IdempotencyReservedState,
  SafetyEvaluatedState,
  NormalizedState,
  ValidatedState,
  PersistedState,
  RoutedState,
  AuditedState,
} from './orchestrator.state';

export function buildOrchestratorMachine(ctx: OrchestratorContext): StateMachine<OrchestratorContext, OrchestratorEvent> {
  const received = new ReceivedState();
  const machine = new StateMachine<OrchestratorContext, OrchestratorEvent>(received, ctx);

  const states = [
    received,
    new AuthorizedState(),
    new ConsentCheckedState(),
    new IdempotencyReservedState(),
    new SafetyEvaluatedState(),
    new NormalizedState(),
    new ValidatedState(),
    new PersistedState(),
    new RoutedState(),
    new AuditedState(),
  ];

  states.forEach((state) => machine.register(state));
  return machine;
}

export async function runOrchestratorMachine(
  machine: StateMachine<OrchestratorContext, OrchestratorEvent>,
  terminalState = 'Audited',
): Promise<void> {
  await machine.start();
  let guard = 0;
  while (machine.state !== terminalState) {
    guard += 1;
    if (guard > 20) {
      throw new Error('orchestrator state machine exceeded transition limit');
    }
    await machine.dispatch({ type: 'proceed' });
  }
}
