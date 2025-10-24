// AUTO-GENERATED from schemas. DO NOT EDIT.

export type ClinicianTaskSummaryPriority = "STAT" | "URGENT" | "SOON" | "ROUTINE";
export type ClinicianTaskSummaryStatus = "NEW" | "IN_PROGRESS" | "DONE";

export interface ClinicianTaskSummary {
  id: string;
  clinicId: string;
  priority: ClinicianTaskSummaryPriority;
  status: ClinicianTaskSummaryStatus;
  shortReason: string;
  patientId: string;
  waitMs: number;
  interpreter?: string;
  assignee?: string;
  createdAt: string;
}
