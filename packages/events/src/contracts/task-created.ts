// AUTO-GENERATED from schemas. DO NOT EDIT.

export type TaskCreatedPriority = "STAT" | "URGENT" | "SOON" | "ROUTINE";

export interface TaskCreated {
  taskId: string;
  patientId: string;
  priority: TaskCreatedPriority;
  owner?: string;
}
