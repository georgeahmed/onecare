// AUTO-GENERATED from schemas. DO NOT EDIT.

export interface TaskUpdated {
  taskId: string;
  patientId: string;
  priority: "STAT" | "URGENT" | "SOON" | "ROUTINE";
  previousPriority?: "STAT" | "URGENT" | "SOON" | "ROUTINE";
  reason: string;
  updatedAt?: string;
  breached?: boolean;
}
