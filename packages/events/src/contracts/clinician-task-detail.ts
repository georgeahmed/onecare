// AUTO-GENERATED from schemas. DO NOT EDIT.

export type ClinicianTaskPriority = "STAT" | "URGENT" | "SOON" | "ROUTINE";
export type ClinicianTaskStatus = "NEW" | "IN_PROGRESS" | "DONE";

export interface ClinicianTaskDetail {
  id: string;
  clinicId: string;
  priority: ClinicianTaskPriority;
  status: ClinicianTaskStatus;
  shortReason: string;
  patientId: string;
  waitMs: number;
  interpreter?: string;
  assignee?: string;
  createdAt: string;
  narrative: string;
  attachments?: ClinicianTaskAttachment[];
  /**
   * @maxItems 16
   */
  actionsAllowed:
    | []
    | [string]
    | [string, string]
    | [string, string, string]
    | [string, string, string, string]
    | [string, string, string, string, string]
    | [string, string, string, string, string, string]
    | [string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string, string, string, string]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string
      ];
  audit: ClinicianTaskAuditItem[];
  correlationId: string;
}
export interface ClinicianTaskAttachment {
  contentType: string;
  url: string;
}
export interface ClinicianTaskAuditItem {
  when: string;
  who: string;
  what: string;
}
