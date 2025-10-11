import { StateMachine } from '../../../../packages/statekit/src/StateMachine';
import { OrchestratorContext, OrchestratorEvent } from '../types';
import {
  ReceivedState,
  AuthorizedState,
  ConsentCheckedState,
  NormalizedState,
  ValidatedState,
  PersistedState,
  EnrichedState,
  RoutedState,
  AuditedState,
} from './orchestrator.state';

export function buildOrchestratorMachine(ctx: OrchestratorContext) {
  const received = new ReceivedState();
  const machine = new StateMachine<OrchestratorContext, OrchestratorEvent>(received, ctx);

  const states = [
    received,
    new AuthorizedState(),
    new ConsentCheckedState(),
    new NormalizedState(),
    new ValidatedState(),
    new PersistedState(),
    new EnrichedState(),
    new RoutedState(),
    new AuditedState(),
  ];

  states.forEach(s => machine.register(s));
  return machine;
}

