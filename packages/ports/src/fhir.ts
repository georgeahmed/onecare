export interface FhirBundle {
  id?: string;
}

export interface FhirResourceRef { id: string; resourceType: string }

export interface FhirRepository {
  upsertBundle(bundle: FhirBundle): Promise<FhirBundle>;
  createTask(task: unknown): Promise<FhirResourceRef>;
  createAppointment(appt: unknown): Promise<FhirResourceRef>;
  createDocumentReference(doc: unknown): Promise<FhirResourceRef>;
}

