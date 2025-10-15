// AUTO-GENERATED from schemas. DO NOT EDIT.

export interface TriageDecision {
  patientId: string;
  score: number;
  priority: "STAT" | "URGENT" | "SOON" | "ROUTINE";
  /**
   * @maxItems 10
   */
  reasons?:
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
    | [string, string, string, string, string, string, string, string, string, string];
  duplicateOf?: string;
  assignment?: {
    owner?: string;
    team?: string;
  };
  features?: {
    [k: string]: number | string | boolean | null;
  };
  generatedAt?: string;
}
