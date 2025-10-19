export { TriageConsumer, type TriageConsumerOptions } from './adapters/consumer';
export {
  createTriageMachine,
  runTriageMachine,
  type RunTriageOptions,
  type RunTriageResult,
} from './application/triage.machine';
export type { TriageContext, DuplicateHandler } from './application/triage.state';
export {
  TriageSlaScheduler,
  type TriageSlaSchedulerOptions,
  type TriageSlaTracker,
  type TrackTaskInput,
  startTriageSlaScheduler,
} from './sla/aging';
export type {
  AssignmentConsentEvaluator,
  AssignmentConsentDecision,
  AssignmentConsentInput,
} from './application/triage.state';
export {
  startTriageRuntime,
  type TriageRuntimeOptions,
  type TriageRuntime,
} from './runtime';
