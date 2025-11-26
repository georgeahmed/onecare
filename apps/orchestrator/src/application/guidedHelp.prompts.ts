import type { GuidedHelpSessionRequest } from '@onecare/events';

export type GuidedHelpPurpose = 'step' | 'summary' | 'quality' | 'redFlag';

export interface StepPromptContext {
  request: GuidedHelpSessionRequest;
  missingFields: ('onset' | 'location' | 'severity' | 'otherSymptoms')[];
  maxSteps: number;
}

export interface SummaryPromptContext {
  originalNarrative: string;
  fieldSummaries: {
    onset?: string;
    location?: string;
    severity?: string;
    otherSymptoms?: string;
  };
  coveredFields: ('onset' | 'location' | 'severity' | 'otherSymptoms')[];
  qualityScore: number;
  lowSignalReasons: string[];
  locale?: string;
}

export interface QualityPromptContext {
  conversation: unknown[];
  requiredFields: ('onset' | 'location' | 'severity' | 'otherSymptoms')[];
  coveredFields: ('onset' | 'location' | 'severity' | 'otherSymptoms')[];
  qualityScore: number;
}

export interface RedFlagPromptContext {
  narrative: string;
  answers: unknown[];
  locale?: string;
}

export const buildSystemPrompt = (locale: string | undefined): string => {
  const localeHint =
    typeof locale === 'string' && locale.trim().length > 0
      ? ` The patient's preferred locale is "${locale}". Use this locale when wording responses when possible.`
      : '';

  return [
    'You are a clinical intake note helper, not a clinician.',
    'You help patients describe their symptoms more clearly so that a human clinician can review later.',
    'You MUST NOT provide diagnoses, probabilities, or treatment recommendations.',
    'You MUST use simple, neutral language around a 6th-grade reading level.',
    'You MUST avoid names, phone numbers, email addresses, account numbers, or other identifiers in your outputs, even if they appear in the input.',
    'You MUST respect a maximum of 5 guided steps, plus an optional 6th “final detail” step when information is insufficient.',
    'You MUST produce outputs that follow the JSON contracts given in the developer instructions, with no extra keys or commentary.',
    localeHint,
  ]
    .filter(Boolean)
    .join(' ');
};

export const buildStepDeveloperPrompt = (context: StepPromptContext): string => {
  const { request, missingFields, maxSteps } = context;
  const remaining = missingFields.length > 0 ? missingFields.join(', ') : 'none';

  return [
    'You are generating a single FOLLOW-UP STEP in a guided-help flow.',
    'Your job is to ask ONE new question about a specific clinical axis from this set: "onset", "location", "severity", "otherSymptoms".',
    `The backend has already decided which axes are still missing and passes them in "missingFields". In this call, missingFields = [${remaining}].`,
    'You MUST choose one of those axes (if any are present) and write a question ONLY about that axis.',
    `The maximum number of guided steps is ${maxSteps}. The current stepId is "${request.stepId}".`,
    'You MUST return a JSON object that matches the GuidedHelpSessionResponse contract for a step, including:',
    '- sessionId (copied from the request).',
    '- stepId (copied from the request).',
    '- nextStepId (if there is another step to ask).',
    '- question (one concise question).',
    '- rationale (short, non-clinical explanation).',
    '- missingFields (axes that still need coverage after this question).',
    '- redFlags (an array of enum values, or ["none"]).',
    '- proceedToSummary (boolean).',
    '- needsStep6 (boolean).',
    '- qualityScore (0.0–1.0).',
    'You MUST NOT ask about axes that are already covered (not in missingFields).',
    'You MUST NOT ask multi-part questions (avoid "and/or" combinations).',
  ].join(' ');
};

export const buildSummaryDeveloperPrompt = (context: SummaryPromptContext): string => {
  const { qualityScore, coveredFields, lowSignalReasons } = context;
  const covered = coveredFields.length > 0 ? coveredFields.join(', ') : 'none';
  const reasons = lowSignalReasons.length > 0 ? lowSignalReasons.join('; ') : 'none';

  return [
    'You are helping rewrite a patient\'s own description of their symptoms so a clinician can understand it quickly.',
    'The input you receive is already structured and tagged; you must not invent new facts or diagnoses.',
    `The coverage across the four axes (onset, location, severity, otherSymptoms) is: ${covered}.`,
    `The current qualityScore is ${qualityScore.toFixed(2)} (0.0–1.0).`,
    `Low-signal reasons (if any): ${reasons}.`,
    'You MUST return a JSON object that matches the summary shape in GuidedHelpSessionResponse:',
    '- summary: one short paragraph in first-person voice.',
    '- bullets: up to four short bullet strings describing onset, location, severity, and otherSymptoms when available.',
    '- limitations: short phrases describing missing or unclear details.',
    '- confidence: number between 0.0 and 1.0 indicating completeness (not medical certainty).',
    'You MUST keep summary under 800 characters, in clear, simple language.',
    'You MUST NOT recommend treatments, tests, or urgency levels.',
    'You MUST NOT use diagnostic labels (for example: "migraine", "heart attack", "stroke").',
  ].join(' ');
};

export const buildQualityDeveloperPrompt = (context: QualityPromptContext): string => {
  const { requiredFields, coveredFields, qualityScore } = context;
  const required = requiredFields.join(', ');
  const covered = coveredFields.length > 0 ? coveredFields.join(', ') : 'none';

  return [
    'You are reviewing a short conversation where a patient has answered up to 5 structured questions about their symptoms.',
    'Your job is to decide whether there is enough information for a clinician to understand the main concern, without diagnosing or suggesting treatment.',
    `Required axes: ${required}.`,
    `Currently covered axes: ${covered}.`,
    `Current qualityScore estimate (0.0–1.0): ${qualityScore.toFixed(2)}.`,
    'You MUST return a JSON object with:',
    '- needsStep6: boolean.',
    '- lowSignalReasons: array of short phrases.',
    '- finalQuestion: one empathetic, non-leading question under 25 words.',
    'You MUST set needsStep6 = true only when fewer than two useful fields are covered OR the answers are vague, generic, or inconsistent.',
    'You MUST NOT mention specific diseases, diagnoses, or treatments in finalQuestion.',
  ].join(' ');
};

export const buildRedFlagDeveloperPrompt = (context: RedFlagPromptContext): string => {
  void context; // structured conversation will be passed as user input
  return [
    'You are a safety classifier for a patient symptom description. You are NOT a clinician and must NOT diagnose or suggest treatment.',
    'Your job is only to look for a small set of high-risk patterns:',
    '- chest pain,',
    '- trouble breathing,',
    '- sudden weakness or confusion,',
    '- heavy bleeding,',
    '- severe allergic reaction,',
    '- suicidal thoughts.',
    'You MUST map what you see into a fixed enum of redFlags or ["none"] when not present.',
    'You MUST return a JSON object with:',
    '- redFlags: array of enum values.',
    '- action: "stop_and_escalate" or "continue".',
    '- userMessage: one neutral safety sentence.',
    'If you are uncertain, you MUST set redFlags = ["none"] and action = "continue".',
    'You MUST NOT include diagnoses or treatment recommendations in userMessage.',
  ].join(' ');
};

