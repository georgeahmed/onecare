import { MachineContext } from '../../../packages/statekit/src/types';

export interface OrchestratorContext extends MachineContext {
  // Minimal placeholders based on Algorithm.md
  subject?: { type: 'patient'|'practitioner'|'system'; id: string };
  fhirBundleId?: string;
  routes?: string[];
}

export type OrchestratorEvent = { type: string; payload?: unknown };

