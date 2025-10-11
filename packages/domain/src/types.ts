export type PatientRef = { id: string };
export type FhirBundleRef = { id: string };
export type TaskRef = { id: string };
export type AppointmentRef = { id: string };

export interface OrchestratorCtxBase {
  requestId: string;
  subject?: { type: 'patient'|'practitioner'|'system'; id: string };
  patient?: PatientRef;
  bundle?: FhirBundleRef;
  routes?: string[];
}

