// AUTO-GENERATED from schemas. DO NOT EDIT.

export interface GuidedHelpSessionResponse {
  sessionId: string;
  stepId: "step1" | "step2" | "step3" | "step4" | "step5";
  nextStepId?: "step2" | "step3" | "step4" | "step5";
  question?: string;
  rationale?: string;
  missingFields?: ("onset" | "location" | "severity" | "otherSymptoms")[];
  redFlags?: (
    | "chest_pain"
    | "shortness_of_breath"
    | "sudden_weakness_or_confusion"
    | "heavy_bleeding"
    | "severe_allergic_reaction"
    | "suicidal_thoughts"
    | "none"
  )[];
  proceedToSummary?: boolean;
  needsStep6?: boolean;
  qualityScore?: number;
  /**
   * @maxItems 8
   */
  lowSignalReasons?:
    | []
    | [string]
    | [string, string]
    | [string, string, string]
    | [string, string, string, string]
    | [string, string, string, string, string]
    | [string, string, string, string, string, string]
    | [string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string];
  summary?: string;
  /**
   * @maxItems 8
   */
  bullets?:
    | []
    | [string]
    | [string, string]
    | [string, string, string]
    | [string, string, string, string]
    | [string, string, string, string, string]
    | [string, string, string, string, string, string]
    | [string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string];
  /**
   * @maxItems 8
   */
  limitations?:
    | []
    | [string]
    | [string, string]
    | [string, string, string]
    | [string, string, string, string]
    | [string, string, string, string, string]
    | [string, string, string, string, string, string]
    | [string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string];
  confidence?: number;
  telemetryMeta?: GuidedHelpTelemetryMeta;
}
export interface GuidedHelpTelemetryMeta {
  llmProvider?: string;
  llmModel?: string;
}
