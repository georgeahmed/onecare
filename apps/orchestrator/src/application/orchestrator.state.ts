import { BaseState } from '../../../../packages/statekit/src/BaseState';
import { OrchestratorContext, OrchestratorEvent } from '../types';

export class ReceivedState extends BaseState<OrchestratorContext, OrchestratorEvent> {
  constructor() { super('Received'); }
  async handle(): Promise<string> { return 'Authorized'; }
}

export class AuthorizedState extends BaseState<OrchestratorContext, OrchestratorEvent> {
  constructor() { super('Authorized'); }
  async handle(): Promise<string> { return 'ConsentChecked'; }
}

export class ConsentCheckedState extends BaseState<OrchestratorContext, OrchestratorEvent> {
  constructor() { super('ConsentChecked'); }
  async handle(): Promise<string> { return 'Normalized'; }
}

export class NormalizedState extends BaseState<OrchestratorContext, OrchestratorEvent> {
  constructor() { super('Normalized'); }
  async handle(): Promise<string> { return 'Validated'; }
}

export class ValidatedState extends BaseState<OrchestratorContext, OrchestratorEvent> {
  constructor() { super('Validated'); }
  async handle(): Promise<string> { return 'Persisted'; }
}

export class PersistedState extends BaseState<OrchestratorContext, OrchestratorEvent> {
  constructor() { super('Persisted'); }
  async handle(): Promise<string> { return 'Enriched'; }
}

export class EnrichedState extends BaseState<OrchestratorContext, OrchestratorEvent> {
  constructor() { super('Enriched'); }
  async handle(): Promise<string> { return 'Routed'; }
}

export class RoutedState extends BaseState<OrchestratorContext, OrchestratorEvent> {
  constructor() { super('Routed'); }
  async handle(): Promise<string> { return 'Audited'; }
}

export class AuditedState extends BaseState<OrchestratorContext, OrchestratorEvent> {
  constructor() { super('Audited'); }
  async handle(): Promise<string> { return 'Audited'; } // terminal
}

