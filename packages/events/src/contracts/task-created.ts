// AUTO-GENERATED from schemas. DO NOT EDIT.

export interface TaskCreated {
  taskId: string;
  patientId: string;
  priority: "STAT" | "URGENT" | "SOON" | "ROUTINE";
  owner?: string;
}
