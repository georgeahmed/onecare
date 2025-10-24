// AUTO-GENERATED from schemas. DO NOT EDIT.

export type TriageDecisionPriority = "STAT" | "URGENT" | "SOON" | "ROUTINE";

export interface TriageDecision {
  patientId: string;
  score: number;
  priority: TriageDecisionPriority;
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
  assignment?: TriageDecisionAssignment;
  features?: {
    [k: string]: number | string | boolean | null;
  };
  generatedAt?: string;
}
export interface TriageDecisionAssignment {
  owner?: string;
  team?: string;
}
