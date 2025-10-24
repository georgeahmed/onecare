// AUTO-GENERATED from schemas. DO NOT EDIT.

export type SafetyDecisionOutcome = "DIVERTED" | "SAFE_TO_CONTINUE";

export interface SafetyDecision {
  outcome: SafetyDecisionOutcome;
  reason?: string | null;
}
