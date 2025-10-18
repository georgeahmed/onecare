// AUTO-GENERATED from schemas. DO NOT EDIT.

export interface ClinicianTaskSummary {
  id: string;
  clinicId: string;
  priority: "STAT" | "URGENT" | "SOON" | "ROUTINE";
  status: "NEW" | "IN_PROGRESS" | "DONE";
  shortReason: string;
  patientId: string;
  waitMs: number;
  interpreter?: string;
  assignee?: string;
  createdAt: string;
}
