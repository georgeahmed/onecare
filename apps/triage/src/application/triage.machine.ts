import { StateMachine } from '@onecare/statekit';
import {
  IntakeState,
  ScoredState,
  TaskCreatedState,
  NotifiedState,
  CompletedState,
  DuplicateState,
  type TriageContext,
  type TriageEvent,
} from './triage.state';

const DEFAULT_EVENT: TriageEvent = { type: 'triage.evaluate' };
const TERMINAL_STATES = new Set<string>(['Completed', 'Duplicate']);

export interface RunTriageOptions {
  /**
   * Safety guard preventing infinite loops if a state misbehaves.
   */
  maxTransitions?: number;
}

export interface RunTriageResult {
  state: string;
  context: TriageContext;
}

export function createTriageMachine(context: TriageContext): StateMachine<TriageContext, TriageEvent> {
  const intake = new IntakeState();
  const machine = new StateMachine<TriageContext, TriageEvent>(intake, context);
  machine.register(intake);

  const scored = new ScoredState();
  const created = new TaskCreatedState();
  const notified = new NotifiedState();
  const duplicate = new DuplicateState();
  const completed = new CompletedState();

  machine.register(scored);
  machine.register(created);
  machine.register(notified);
  machine.register(duplicate);
  machine.register(completed);

  return machine;
}

export async function runTriageMachine(
  context: TriageContext,
  event: TriageEvent = DEFAULT_EVENT,
  options: RunTriageOptions = {},
): Promise<RunTriageResult> {
  const machine = createTriageMachine(context);
  await machine.start();

  const maxTransitions = Math.max(1, options.maxTransitions ?? 16);
  let transitions = 0;
  const dispatchEvent = event ?? DEFAULT_EVENT;

  while (!TERMINAL_STATES.has(machine.state)) {
    if (transitions >= maxTransitions) {
      throw new Error('triage_machine_max_transitions_exceeded');
    }
    await machine.dispatch(dispatchEvent);
    transitions += 1;
  }

  if (machine.state === 'Duplicate') {
    if (transitions >= maxTransitions) {
      throw new Error('triage_machine_max_transitions_exceeded');
    }
    await machine.dispatch(dispatchEvent);
    transitions += 1;
  }

  if (machine.state !== 'Completed') {
    throw new Error(`triage_machine_unexpected_terminal:${machine.state}`);
  }

  return { state: machine.state, context };
}
