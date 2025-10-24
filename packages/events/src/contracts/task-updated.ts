// AUTO-GENERATED from schemas. DO NOT EDIT.

export type TaskUpdatedPriority = "STAT" | "URGENT" | "SOON" | "ROUTINE";
export type TaskUpdatedPreviousPriority = "STAT" | "URGENT" | "SOON" | "ROUTINE";

export interface TaskUpdated {
  taskId: string;
  patientId: string;
  priority: TaskUpdatedPriority;
  previousPriority?: TaskUpdatedPreviousPriority;
  reason: string;
  updatedAt?: string;
  breached?: boolean;
}
