// AUTO-GENERATED from schemas. DO NOT EDIT.

export interface GuidedHelpSessionRequest {
  practiceId: string;
  patientId: string;
  sessionId: string;
  stepId: "step1" | "step2" | "step3" | "step4" | "step5";
  locale?: string;
  seedNarrative?: string;
  /**
   * @maxItems 64
   */
  conversation?: GuidedHelpConversationItem[];
  clientMeta?: GuidedHelpClientMeta;
  flags?: GuidedHelpFlags;
}
export interface GuidedHelpConversationItem {
  role: "user" | "assistant";
  text: string;
  fieldTags?: ("onset" | "location" | "severity" | "otherSymptoms")[];
  createdAt?: string;
  sequence?: number;
}
export interface GuidedHelpClientMeta {
  userAgent?: string;
  tzOffsetMinutes?: number;
}
export interface GuidedHelpFlags {
  fromSummaryButton?: boolean;
}
