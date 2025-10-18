// AUTO-GENERATED from schemas. DO NOT EDIT.

export interface ClinicianTaskDetail {
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
  narrative: string;
  attachments?: {
    contentType: string;
    url: string;
  }[];
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
  audit: {
    when: string;
    who: string;
    what: string;
  }[];
  correlationId: string;
}
