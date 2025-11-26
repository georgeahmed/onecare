Guided Help AI Task Cards (Portal Narrative, GPT-4o)

Context snapshot
- UI: Intake page `apps/portal/src/pages/Intake.tsx`; form/wizard in `apps/portal/src/components/IntakeForm.tsx` + `apps/portal/src/features/schemaForm/SchemaForm.tsx`. The `narrative` textarea lives in the “details” step and must stay fixed. A right-hand reserved panel will host the guided-help button (“💡 Need help describing this?”) and expansion (chat-style steps + summary actions).
- Backend: `schemas/ingest/portal-submission.json` drives `POST /safety-check` in `apps/orchestrator/src/index.ts`. No guided-help/session API yet. Business/state goes in `src/application`, side effects in `src/adapters`.
- Safety: PHI minimization, 2s timeout, max 2 retries (jitter), correlation-id propagation, and contract validation apply. Narrative guardrails live in `services-py/safety_gate_service`; reuse/redact.
- LLM: GPT-4o for all question/summary generations; must be deterministic enough for tests via stubs/feature flag.

Task 1 — Contracts & topics for guided-help sessions
- Objectives:
  - Provide a single, strongly-typed contract for all guided-help interactions (steps 1–5 plus conditional step 6 and summary trigger).
  - Make every GPT-4o response structurally verifiable, idempotent, and forward-compatible without leaking PHI.
- Data model & schemas:
  - Add `schemas/ingest/guided-help-session.request.json` with fields: practiceId, patientId (hashed ref or token), sessionId, stepId, locale, seedNarrative?, conversation[], clientMeta (userAgent, tzOffsetMinutes), flags { fromSummaryButton: boolean }.
  - Add `schemas/ingest/guided-help-session.response.json` with fields: sessionId, stepId, nextStepId?, question, rationale, missingFields[], redFlags[], proceedToSummary, needsStep6, qualityScore (0–1), lowSignalReasons[], summary?, bullets?, limitations?, confidence?, telemetryMeta.
  - Define `conversation` item schema: { role: "user"|"assistant", text: string, fieldTags: string[], createdAt: string(date-time), sequence: integer }. Set `additionalProperties: false` on all schemas and use enums for stepId, fieldTags, redFlags.
- Session invariants & algorithm:
  - Enforce monotonic step transitions: allowed edges are step1→step2→step3→step4→step5→[step6 or summary]; backend rejects out-of-order or skipped steps.
  - Each canonical field in {onset, location, severity, otherSymptoms} may be marked `covered` at most once; any remaining become `missingFields` in the LLM contract.
  - Compute a simple qualityScore ∈ [0,1] based on length (word-count band), coverage (how many fields covered), and repetition rate; expose this in the response for downstream decisions.
  - Design fieldTags and coverage around a simplified history-taking pattern inspired by common clinical mnemonics (e.g., OLDCARTS), but limited to four axes to keep the flow short and patient-friendly.
  - Guarantee idempotency by deriving a stable key from (practiceId, patientId, sessionId, stepId); repeated requests with the same key must return the same logical step payload.
- API surface:
  - Add orchestrator route `POST /guided-help/step` that:
    - Validates request bodies against the request schema and rejects additional properties.
    - Normalizes identifiers, locale, and narrative using existing safety-gate helpers (strip invalid chars, enforce max length).
    - Projects a bounded, PHI-minimized view of the request into the GPT-4o adapter (no raw IDs or contact details).
    - Validates the GPT-4o output against the response schema; on validation failure, emit metrics and return a safe, generic fallback question from a static ruleset.
  - Optionally publish an audit/telemetry event (new topic) with hashed identifiers and step metadata only (no free-text content).
- AI prompt (shape/intent contract, used in validators/docs):
```
Model: gpt-4o
You are a contract-bound intake assistant. You MUST return ONLY a single JSON object matching exactly this TypeScript type:
type GuidedHelpStep = {
  sessionId: string;
  stepId: "step1" | "step2" | "step3" | "step4" | "step5";
  question: string;           // one concise question only
  rationale: string;          // short, non-clinical reason for the question
  missingFields: ("onset" | "location" | "severity" | "otherSymptoms")[];
  redFlags: ("chest_pain" | "shortness_of_breath" | "confusion" | "bleeding" | "none")[];
  proceedToSummary: boolean;
  needsStep6: boolean;
};
Rules:
- Do NOT output markdown, prose, or explanations; output JSON only.
- Do NOT diagnose or suggest treatments.
- Do NOT include names, phone numbers, addresses, or IDs.
- Use 6th-grade reading level and <25 words in "question".
- If you are unsure, keep "redFlags" empty and set "proceedToSummary" to false.
```

Task 2 — System persona, guardrails, and adapter policy (GPT-4o)
- Objectives:
  - Define a single, reusable “guided-help” persona for GPT-4o that is safe-by-default and consistent across all steps (1–6) and summary generation.
  - Encapsulate all LLM policy (timeouts, retries, temperature, logging, redaction) in one adapter so business logic never talks to GPT-4o directly.
- Prompt stack design:
  - Create `apps/orchestrator/src/application/guidedHelp.prompts.ts` that exports:
    - `buildSystemPrompt(locale: string)` → base persona string tuned for health-literacy (grade-6) and non-clinical tone.
    - `buildDeveloperPrompt(context: { stepId; requiredFields; maxSteps; })` → concise instructions about allowed step transitions, which fields remain, and hard JSON-only requirement.
    - Convenience helpers for common tasks (e.g., `buildStepPrompt`, `buildSummaryPrompt`) that assemble system + developer + user content in a predictable order.
  - Ensure every call follows the same structure: `system` (persona + safety), `developer` (contract + algorithmic constraints), `user` (seed narrative + conversation snapshot).
- Safety & communication guardrails:
  - Explicitly instruct GPT-4o to:
    - Never provide diagnoses, probabilities, or treatment recommendations.
    - Use neutral, non-alarming language; only surface safety warnings via structured `redFlags`/`userMessage` fields.
    - Always ask at most one focused question per turn, avoid multi-part “and/or” questions (reduces cognitive load and misinterpretation).
    - Use short sentences, avoid jargon, and avoid speculative language (“might be X condition”) to keep within health-literacy guidance.
  - Require that all free-text fields (question, rationale, userMessage) are safe to show directly to patients with varying literacy and anxiety levels.
- Adapter policy & call parameters:
  - Implement `apps/orchestrator/src/adapters/services/guidedHelpLLM.ts` with a single entrypoint:
    - `callGuidedHelpLLM(input, { purpose: "step" | "summary" | "quality" })` that:
      - Injects system/developer prompts from `guidedHelp.prompts`.
      - Calls GPT-4o with:
        - `model: "gpt-4o"`
        - `temperature`: 0.1–0.2 for step questions (deterministic phrasing), 0.3–0.4 for summaries (slightly more fluent).
        - `top_p`: 0.9, `max_tokens`: bounded per purpose (e.g., 256 for steps, 512 for summary).
        - `presence_penalty`/`frequency_penalty`: low but >0 to reduce verbatim repetition.
      - Applies a 2s timeout at the HTTP client level and at most 2 retries with exponential backoff + jitter for transient errors.
      - Tags each call with `correlationId`, `sessionId`, `stepId`, and `purpose` for tracing/metrics.
  - On timeout or validation failure:
    - Do NOT re-ask the user for the same input immediately; instead fall back to a deterministic, rules-based question or summary.
    - Emit structured logs and metrics (per-model, per-purpose) without embedding PHI; log only hashed identifiers and discrete fields like `stepId`, `purpose`, and error class.
- Redaction & PHI minimization:
  - Before sending to GPT-4o, strip or mask:
    - Patient identifiers, phone numbers, email addresses, URLs, addresses, and obvious ID patterns.
    - Any non-essential metadata (IP, device, precise timestamps).
  - Ensure logs never store the raw narrative or AI-generated summary in production; instead:
    - Log length, qualityScore, coveredFields, and redFlags counts.
  - Provide a “safe-mode” flag so non-prod can optionally log de-identified prompts/responses for debugging, guarded by strict access controls.
- AI prompt (system message, conceptual):
```
System (GPT-4o): You are a clinical intake note helper, not a clinician. Your job is to help patients describe their symptoms more clearly for a human clinician to review later.
You MUST:
- Ask brief, single-focus questions to clarify the patient’s description.
- Keep language simple (around 6th-grade reading level) and non-judgmental.
- Never give medical advice, diagnoses, or probabilities.
- Never recommend specific medications, tests, or treatments.
- Respect the configured step limit (5 steps, plus an optional 6th “final detail” step when answers are insufficient).
- Produce outputs that exactly follow the JSON contract given in the developer instructions, with no extra keys or commentary.
- Avoid names, phone numbers, email addresses, account numbers, or other identifiers in your outputs, even if they appear in the input.
If you are uncertain, prefer asking a short clarifying question rather than speculating.
```

Task 3 — Step 1 seeding from existing Narrative
- Objectives:
  - Use the patient’s own free-text narrative as the starting point, without moving or altering the original textarea.
  - Initialize a guided-help session that feels like a “warm start” (the AI shows it has read and understood the text) while staying within strict safety and PHI rules.
- Backend design:
  - When the frontend invokes “Start guided help”:
    - Sanitize `PortalSubmission.narrative` using the same pipeline as submission (normalize whitespace, strip invalid characters, enforce max length).
    - Generate a new `sessionId` (UUID v4 or ULID) and a `correlationId`, and persist:
      - `practiceId`, `patientId` (hashed reference where possible), `sessionId`, `stepId="step1"`, `seedNarrative`, `locale`, and timestamp.
      - A conversation array containing a single `user` message with `text = seedNarrative` and initial fieldTags empty.
    - Derive an idempotency key from `(practiceId, patientId, seedNarrative hash)`, so repeated “Start guided help” clicks for the same narrative within a short window return the same step1 question instead of re-calling GPT-4o.
    - Invoke `callGuidedHelpLLM` with `purpose: "step"` and a developer prompt that explicitly says this is `step1` and the first target is `onset`.
  - Validate GPT-4o’s JSON against the step response schema; if invalid, fall back to a curated rule-based question like “When did this start?” with a generic rationale.
- Frontend behavior:
  - Add the “💡 Need help describing this?” button to the right of the narrative textarea; keep the textarea in place and unchanged.
  - On click:
    - Disable the button while loading; call `POST /guided-help/step` with the current narrative text, locale, and existing practice/patient identifiers from the in-progress form.
    - Open a right-hand panel (or side-by-side card area) that:
      - Shows the user’s original narrative as the first bubble (read-only).
      - Shows the AI’s first question as a second bubble, with a clear label (e.g., “AI helper”).
    - Trap focus appropriately so keyboard users move into the panel without losing context; pressing Escape should close the panel but not clear the narrative.
- Algorithm & micro-behavior for step1:
  - Normalize the narrative for analysis (e.g., Unicode normalization, lowercasing for keyword checks) but keep the original text for display.
  - Use simple heuristics plus GPT-4o to avoid asking obviously irrelevant onset questions (e.g., if the narrative clearly specifies a time frame like “for 2 years”, step1 can instead confirm or refine that).
  - Ensure the question is:
    - Singular: one core idea, no “and/or” branching.
    - Time-focused (onset, duration) in most cases, because this is usually the most information-dense and least intrusive first follow-up.
    - Non-leading and non-diagnostic (e.g., “When did this start?” instead of “How long have you had this infection?”).
- AI prompt (developer + user content for step1):
```
Developer (to GPT-4o):
You are generating STEP 1 of a guided-help flow that helps a patient describe their symptoms for a clinician.
The patient has already typed a free-text "narrative" describing their concern.
Your job for STEP 1 is:
- Read the narrative.
- Identify the main complaint.
- Ask ONE short question focused on onset or timing (for example: when it started, whether it is getting better/worse, or how long it has been present).
- Fill the GuidedHelpStep JSON object as described in the system instructions.

User input:
{
  "narrative": "...",
  "locale": "en",
  "stepId": "step1"
}

Expected JSON output (example shape, not literal text):
{
  "stepId": "step1",
  "question": "When did this start?",
  "rationale": "establish onset and timing",
  "missingFields": ["onset"],
  "proceedToSummary": false,
  "needsStep6": false
}

Rules:
- Briefly reflect the patient’s own words in your internal reasoning, but DO NOT echo names, places, or identifiers in the "question" or "rationale".
- Ask only ONE question.
- Focus on onset/timing unless the narrative already clearly specifies it, in which case you may clarify frequency or pattern in time.
```

Task 4 — Step 2–5 follow-up generation with field coverage
- Objectives:
  - Systematically gather the remaining key axes (location, severity, otherSymptoms) in a small, structured sequence of follow-up questions.
  - Ensure the algorithmic backbone (which field comes next, when to stop) is clear and testable, while GPT-4o handles phrasing only within that structure.
- Backend state & algorithm:
  - Maintain a per-session state machine with:
    - `coveredFields`: subset of {onset, location, severity, otherSymptoms}.
    - `currentStepId`: one of "step1"…"step5".
    - `maxSteps = 5`, with `remainingSteps = maxSteps - (currentStepIndex)`.
  - Step-selection algorithm:
    - After step1 (onset), compute `remainingFields = [location, severity, otherSymptoms] \ coveredFields`.
    - At each subsequent step (2–5):
      - If `remainingFields` is empty, set `proceedToSummary = true` and do not call GPT-4o for a new question.
      - Otherwise, pick the next canonical field in a fixed priority order: location → severity → otherSymptoms, unless context suggests skipping (e.g., severity already numeric within 1–10 band).
    - Encode the chosen field(s) in `missingFields` when calling GPT-4o, and assert on response that the question aligns with one of these fields.
  - Guard rails:
    - Reject requests where `stepId` jumps ahead (e.g., client claims `step4` when backend state is at `step2`).
    - Persist conversation history with explicit `fieldTags` so quality/coverage metrics can be computed independently of GPT-4o.
    - On any inconsistency between requested `missingFields` and the returned question topic, discard the LLM output and use a deterministic, template-based question for that field.
- Frontend behavior:
  - Render a chat-style right-hand panel with:
    - A labeled “AI helper” bubble for each GPT-4o question.
    - A corresponding “You” bubble capturing the patient’s typed answer for that step.
  - Maintain keyboard focus inside the panel while answering each step; pressing “Next” or hitting Enter (where safe) submits the answer and scrolls to the next AI question.
  - Display a subtle progress indicator (e.g., “Step 2 of 5”) so patients understand the finite nature of the flow; do not block them from closing the panel at any time.
- AI prompt (developer + user content for follow-ups):
```
Developer (to GPT-4o):
You are generating FOLLOW-UP STEPS (2–5) in a guided-help flow. Your job is to ask ONE new question that focuses on a specific clinical axis
from this set: "onset", "location", "severity", "otherSymptoms".
The backend has already decided which axes are still missing and passes them in "missingFields". You MUST choose one of those axes and
write a question only about that axis.

Input JSON:
{
  "stepId": "step2" | "step3" | "step4" | "step5",
  "asked": ["onset"],
  "missingFields": ["location", "severity"],
  "answers": [...],
  "locale": "en"
}

Expected JSON output (example shape):
{
  "stepId": "step3",
  "question": "Where in your body do you feel it?",
  "rationale": "understand the location of the symptom",
  "missingFields": ["location"],
  "proceedToSummary": false,
  "needsStep6": false
}

Rules:
- DO NOT ask about axes that are already covered (not in missingFields).
- Ask only ONE clear question focused on a single axis (e.g., only location, or only severity on a 1–10 scale).
- Avoid clinical jargon; use simple, concrete wording suitable for a 6th-grade reading level.
- You may briefly acknowledge previous answers in under 10 words, but only inside your own reasoning, not in the "question" text.
```

Task 5 — Conditional Step 6 low-signal gate
- Objectives:
  - Avoid over-questioning by default; only open a 6th “final detail” step when there is strong evidence that the first 5 steps produced low-quality or incomplete information.
  - Make the “needsStep6” decision explainable (via `lowSignalReasons`) and driven by a combination of deterministic heuristics plus GPT-4o-assisted scoring.
- Backend quality scoring:
  - Reuse the `qualityScore` ∈ [0,1] defined in Task 1, computed from:
    - Coverage: fraction of {onset, location, severity, otherSymptoms} with non-empty, non-placeholder answers.
    - Length: total word count across answers, penalizing extremely short (<10 words total) or extremely long (>800 words) narratives.
    - Diversity: ratio of unique tokens to total tokens; down-weight answers dominated by repeated tokens or obvious placeholders.
  - Define deterministic thresholds:
    - `qualityScore >= 0.7` and at least 3 covered fields → `needsStep6 = false`.
    - `qualityScore <= 0.4` or fewer than 2 covered fields → candidate for `needsStep6 = true`, subject to GPT-4o confirmation.
    - Mid-range scores (0.4–0.7) → depend on GPT-4o’s qualitative assessment of clarity and usefulness.
  - Normalize “low-signal phrases” using a small dictionary (e.g., `"idk"`, `"don't know"`, `"n/a"`, `"nothing"`, `"fine"`) and treat answers that are only such phrases as effectively empty.
- Decision algorithm:
  - After step5 (or earlier if all axes are covered):
    - Aggregate the conversation into a compact representation (field-tagged answers, word counts, flags for low-signal phrases).
    - Run the deterministic qualityScore first; if `qualityScore >= 0.7` and ≥3 useful fields, set `needsStep6 = false` without calling GPT-4o.
    - Otherwise, call GPT-4o with a tightly-scoped “quality reviewer” prompt that:
      - Classifies the conversation into “sufficient” vs “insufficient for handoff”.
      - Produces a small list of `lowSignalReasons` and a suggested `finalQuestion` when insufficient.
  - Persist `needsStep6`, `lowSignalReasons`, and `qualityScore` into the session store for audit and tuning.
- Frontend behavior:
  - Only render the 6th-step UI (larger text box in the right-hand panel) when `needsStep6=true` comes back from the API.
  - Show a short explanation above the final question, using a safe template like:
    - “We still need a little more detail so your clinician can understand your main concern.”
  - Keep this step optional: the patient may choose to skip and go straight to summary; in that case, mark the final answer as empty and proceed.
- AI prompt (quality/step6 decision helper):
```
Developer (to GPT-4o):
You are reviewing a short conversation where a patient has answered up to 5 structured questions about their symptoms.
Your job is to decide whether there is enough information for a clinician to understand the main concern, without diagnosing or suggesting treatment.

Input JSON:
{
  "conversation": [...],                    // array of messages with role + text + fieldTags
  "requiredFields": ["onset","location","severity","otherSymptoms"],
  "coveredFields": ["onset","location"],   // fields with non-empty, non-placeholder answers
  "qualityScore": 0.35
}

You MUST return ONLY a JSON object:
{
  "needsStep6": boolean,
  "lowSignalReasons": string[],
  "finalQuestion": string
}

Rules:
- Set needsStep6 = true only when fewer than 2 useful fields are covered OR the answers are vague, generic, or inconsistent.
- lowSignalReasons should be short phrases like "missing onset", "answers are 'idk' or 'n/a'", or "no clear description of where it hurts".
- finalQuestion must be empathetic, non-leading, and under 25 words, e.g., "In your own words, what is the main problem you want the clinician to focus on today?"
- Do NOT mention specific diseases, diagnoses, or treatments in finalQuestion.
- If needsStep6 = false, you may still populate lowSignalReasons as an empty array and set finalQuestion to a generic placeholder string (it will be ignored).
```

Task 6 — Red-flag screening and safe-stop path
- Objectives:
  - Add an additional safety layer inside the guided-help flow without turning it into a diagnostic tool or duplicating the main safety gate.
  - Detect a small set of high-signal emergency patterns early and stop the conversational flow with a clear, non-diagnostic safety message.
- Safety posture:
  - Guided-help runs only after the primary safety gate has accepted the portal submission; this layer is a “safety net”, not the primary triage engine.
  - Never present guided-help as a substitute for emergency care; copy must emphasize that a clinician will review, and that emergencies should use local emergency services.
- Backend algorithm:
  - Define a constrained enum of red flags in the contract (e.g., `"chest_pain"`, `"shortness_of_breath"`, `"sudden_weakness_or_confusion"`, `"heavy_bleeding"`, `"severe_allergic_reaction"`, `"suicidal_thoughts"`, `"none"`).
  - Implement a multi-layer classifier:
    - Layer 1 — Rules: apply deterministic phrase/keyword patterns on normalized text (narrative + answers), using curated phrase lists per flag (e.g., “crushing chest pain”, “can’t breathe”, “blood won’t stop”, “thinking of ending my life”). These rules operate in-memory and are never logged with raw text.
    - Layer 2 — Existing safety service: where feasible, send a compact summary (no identifiers) to `safety_gate_service` and include its decision as a strong signal (e.g., if SafetyDecision is “ROUTE_TO_EMERGENCY”, override action to stop-and-escalate).
    - Layer 3 — GPT-4o assist: for borderline cases (no rule hit, safety gate neutral, but references to worrying symptoms), call GPT-4o with a strict classification prompt that can only emit values from the red-flag enum.
  - Decision logic:
    - If any rule-based flag is positive OR the safety gate indicates high risk → `action = "stop_and_escalate"`.
    - Else if GPT-4o flags one of the enum values with high confidence → treat as `stop_and_escalate`.
    - Otherwise → `action = "continue"` with `redFlags = ["none"]`.
  - Persist only the enum values and a coarse `riskSource` (rules | safety_gate | llm), never the raw symptom text.
- Frontend behavior:
  - When `action = "stop_and_escalate"`:
    - Immediately stop asking further guided-help questions and disable the “Generate summary” button.
    - Show a prominent, accessible alert in the right-hand panel with a short message like:
      - “Your answers suggest you may need urgent help. If you think this is an emergency, please contact your local emergency services or call 999/911 now.”
    - Keep the original narrative textarea intact; the patient can still edit or submit, but the AI helper should make it clear that it will not continue asking questions.
  - When `action = "continue"`:
    - Do not surface any red-flag UI; guided-help continues as normal.
    - Never claim that it is “safe” or that emergency care is not needed.
- AI prompt (classification helper, GPT-4o):
```
Developer (to GPT-4o):
You are a safety classifier for a patient symptom description. You are NOT a clinician and must NOT diagnose or suggest treatment.
Your job is only to:
- Look for a small set of high-risk patterns (chest pain, trouble breathing, sudden weakness/confusion, heavy bleeding, severe allergic reaction, suicidal thoughts).
- Map what you see into a fixed enum of red flags, or "none" when not present.

Input JSON:
{
  "narrative": "...",           // sanitized free-text
  "answers": [...],             // short follow-up answers
  "locale": "en"
}

You MUST return ONLY a JSON object:
{
  "redFlags": ("chest_pain" | "shortness_of_breath" | "sudden_weakness_or_confusion" | "heavy_bleeding" | "severe_allergic_reaction" | "suicidal_thoughts" | "none")[],
  "action": "stop_and_escalate" | "continue",
  "userMessage": string
}

Rules:
- If you are uncertain, set redFlags to ["none"] and action to "continue".
- Only set action = "stop_and_escalate" when there is a clear description of severe chest pain, trouble breathing, sudden weakness/confusion, heavy bleeding, severe allergic reaction, or suicidal thoughts.
- userMessage must be a single neutral sentence like:
  "If you think this is an emergency or your symptoms are suddenly getting worse, please contact local emergency services or call 999/911 now."
- Do NOT mention specific diseases, diagnoses, or treatments.
- Do NOT include names, locations, or identifiers in userMessage.
```

Task 7 — Summary generation and constraints
- Objectives:
  - Turn the collected narrative + step answers into a clear, concise description that a clinician can read quickly, without adding diagnoses or treatment advice.
  - Preserve the patient’s voice and intent while structuring the information along the four axes (onset, location, severity, otherSymptoms).
- Backend design:
  - When the patient clicks “Generate summary”:
    - Build a compact, structured input object for GPT-4o that includes:
      - `originalNarrative`
      - `fieldSummaries`: one entry per axis with `value`, `sourceStepId`, and a normalized label (e.g., `onset: "Started 3 days ago"`).
      - `coveredFields`, `qualityScore`, and any `lowSignalReasons`.
      - `locale`, `sessionId`, and `correlationId` (IDs only, no PHI text).
    - Enforce an upper bound on total text length sent to GPT-4o (e.g., truncate combined narrative+answers to a safe token/window size) to respect latency and cost budgets.
    - Call `callGuidedHelpLLM` with `purpose: "summary"` and a developer prompt that:
      - Treats the structured input as the single source of truth.
      - Requires strict JSON output with `summary`, `bullets`, `limitations`, and `confidence`.
    - Validate the response against the summary schema and apply:
      - A hard cap of ~800 characters on `summary` (truncate with an ellipsis at sentence boundaries).
      - A hard cap of 1,200 characters on any downstream textarea value (see Task 8).
    - Redact prompts and summaries from logs in production; log only content length, coverage, and confidence.
- Frontend behavior:
  - Place a “Generate summary” button at the bottom of the right-hand panel once steps 1–5 (and step6 if applicable) are completed or skipped.
  - On click:
    - Show a loading state with text like “Creating a clearer description…”.
    - Render the summary in a dedicated area:
      - One paragraph (patient voice).
      - Optional bullet list of the four axes (onset, location, severity, otherSymptoms), using the text returned by GPT-4o.
      - A short note if `limitations` is non-empty (e.g., “Some details might still be missing: missing onset date.”).
    - Below the summary, show the two action buttons from the product spec (“Use this as my description” and “Edit before using”), wired as described in Task 8.
- Clinical safety & style constraints:
  - The summary must:
    - Use first-person language where appropriate (“I have…”) to align with the patient’s narrative.
    - Avoid clinical judgment words like “mild/moderate/severe” unless they come directly from a severity scale answer (1–10) and are clearly patient-reported.
    - Avoid recommending urgency or care settings (no “should see a doctor now” or “this is likely urgent”).
    - Avoid any diagnostic labels (e.g., “migraine”, “heart attack”, “stroke”).
  - When data is missing or low quality, the summary must say so in `limitations` and avoid “filling in” information that was not provided.
- AI prompt (developer + user content for summary):
```
Developer (to GPT-4o):
You are helping rewrite a patient's own description of their symptoms so a clinician can understand it quickly.
The input you receive is already structured and tagged; you must not invent new facts or diagnoses.

Input JSON:
{
  "originalNarrative": "...",
  "fieldSummaries": {
    "onset": "Started 3 days ago.",
    "location": "Pain on the left side of the head.",
    "severity": "Pain is 7 out of 10.",
    "otherSymptoms": "Feels nauseous and sensitive to light."
  },
  "coveredFields": ["onset","location","severity","otherSymptoms"],
  "qualityScore": 0.8,
  "lowSignalReasons": [],
  "locale": "en"
}

You MUST return ONLY a JSON object:
{
  "summary": string,        // one short paragraph in first-person voice
  "bullets": string[],      // up to 4 bullets for onset, location, severity, otherSymptoms
  "limitations": string[],  // describe missing or unclear details
  "confidence": number      // 0.0–1.0, reflecting how complete the information is
}

Rules:
- Base your summary ONLY on the information in fieldSummaries and originalNarrative; do NOT speculate or add diagnoses.
- Keep "summary" under 800 characters, written in simple, clear language around a 6th-grade reading level.
- Bullets should be short phrases like "Onset: Started 3 days ago."
- Limitations should call out missing or vague details, e.g., "Onset date is unclear" or "Location is not specified."
- Do NOT recommend treatments, tests, or specific levels of urgency. Focus on describing, not deciding.
```

Task 8 — Textarea integration and edit/append behavior
- Objectives:
  - Safely flow the AI-generated summary back into the existing Narrative textarea without moving it or losing the patient’s original words.
  - Give patients explicit control over whether the summary replaces or is appended to what they already wrote.
- Frontend behavior:
  - The Narrative textarea remains rendered by `SchemaForm` for the `narrative` field; guided-help interacts with it only through the form’s value update API.
  - After a summary is generated (Task 7), render two buttons in the right-hand panel:
    - “Use this as my description”
    - “Edit before using”
  - When the user clicks “Use this as my description”:
    - If the current textarea is empty or whitespace-only:
      - Directly set the `narrative` field to the AI-generated draft value.
    - If the current textarea has content:
      - Show a small confirmation choice (inline or as a lightweight dialog):
        - Option A: Replace existing text.
        - Option B: Append the new description below the existing text, separated by a blank line.
      - Apply the chosen operation and then close the confirmation.
    - Do not automatically move keyboard focus; keep the user in the right-hand panel unless they explicitly choose to edit.
  - When the user clicks “Edit before using”:
    - Populate the Narrative textarea with the AI-generated draft value (always replace, not append).
    - Programmatically focus the textarea and scroll it into view, so the user can review and adjust.
    - Keep the guided-help panel open so the user can still see the generated summary for reference.
  - Implement a simple “undo last AI insert” buffer in the intake form state:
    - Keep a copy of the previous narrative value before applying any AI-driven replacement/append.
    - Offer an “Undo” link near the textarea for a short window (or until the next change) to restore the prior value.
- Backend behavior:
  - Extend the summary response schema to include an `editableDraft` field that is the LLM’s recommended textarea string (already capped at ≤1,200 chars).
  - Regardless of where `editableDraft` comes from, always run it through the same sanitization pipeline as user input (`sanitizeMultilineText`) before storing it in form state.
  - Ensure that neither the original narrative nor the editableDraft is logged in production; only log their lengths and whether replace/append was used.
- AI prompt (for generating an editable draft from the summary, GPT-4o):
```
Developer (to GPT-4o):
You are preparing text that will go directly into a patient's "Narrative" textarea on an intake form.
The system already has:
- The patient's original narrative.
- A structured summary of onset, location, severity, and other symptoms.
Your job is to produce ONE editable paragraph (or a short set of paragraphs) that:
- Respects the patient's own wording as much as possible.
- Reads clearly and simply for a clinician.

Input JSON:
{
  "summary": "...",          // from Task 7
  "userNarrative": "...",    // original narrative text
  "mode": "replace" | "append"
}

You MUST return ONLY a JSON object:
{
  "textareaValue": string,   // <= 1200 characters
  "note": string             // short explanation like "Rewritten for clarity" or "Ready to append below your original text"
}

Rules:
- Prefer the patient's own phrases when they are clear; gently tidy grammar and structure without changing meaning.
- Keep sentences short and avoid medical jargon.
- Never add diagnoses, treatments, or urgency recommendations.
- Never include names, phone numbers, email addresses, or identifiers, even if they appear in userNarrative.
- Ensure textareaValue can stand alone as a description of the main concern if the clinician reads only that text.
```

Task 9 — Localization, tone, and UI polish for the right panel
- Objectives:
  - Ensure the guided-help UI and AI-generated text feel natural and accessible in the patient’s preferred language and reading direction.
  - Maintain visual stability so opening the right-hand panel does not cause disruptive layout shifts.
- Backend localization strategy:
  - For core UI strings (button labels, explanations, alerts), rely on the existing i18n system (`react-intl` messages in `apps/portal/src/i18n` and locale JSON files) rather than GPT-4o.
  - For AI-generated content (questions, summaries, drafts):
    - Always send the `locale` alongside prompts.
    - Prefer generating directly in the target language when the locale is supported (e.g., "en", "es", "fr").
    - Only use a translation-style helper prompt when:
      - The base content is stable and reused across flows, or
      - You need a one-off localization of a short phrase generated earlier.
  - When using GPT-4o for localization:
    - Constrain output to plain text with register hints (formal vs plain).
    - For RTL languages, ensure punctuation and numeric scales remain readable.
- Frontend layout & accessibility:
  - Use `useLocale` to:
    - Set `dir` on the main page and on the right-hand panel container (e.g., `dir="ltr"` or `dir="rtl"`).
    - Choose alignment (panel on visual right in LTR, visual left in RTL where appropriate) while keeping the Narrative textarea in its fixed content column.
  - Panel behavior:
    - Desktop:
      - Reserve a column width for the guided-help panel so that opening/closing does not cause large content jumps.
      - Allow the panel to scroll independently if conversations grow, keeping the main form scroll unaffected.
    - Mobile:
      - Present the panel as a slide-in from the bottom or side; maintain a clear close affordance and ensure the narrative textarea remains accessible when the panel is dismissed.
  - Accessibility:
    - Add an `aria-labelledby` for the panel header and ensure focus moves into the panel when it opens.
    - Ensure all interactive elements inside the panel are reachable via keyboard in a logical order.
    - Provide visible focus outlines consistent with existing UI tokens.
- Tone & microcopy guardrails:
  - AI-generated text must:
    - Use empathetic but neutral language (no blame, no alarmist phrasing).
    - Avoid idioms and culture-specific expressions that may not translate well.
    - Respect the locale’s conventions for numbers and date expressions when describing onset/duration.
  - For languages other than English, prefer terminology commonly used in patient-facing materials rather than clinician jargon.
- AI prompt (for one-off localization of short AI text, GPT-4o):
```
Developer (to GPT-4o):
You are localizing a short, patient-facing question or sentence about symptoms.
The source text is already safe and non-diagnostic. Your job is to translate it into the target language so that:
- It is clear and natural for patients.
- It keeps a neutral, empathetic tone.
- It stays around a 6th-grade reading level.

Input JSON:
{
  "text": "Where in your body do you feel it?",
  "locale": "es"
}

You MUST return ONLY a JSON object:
{
  "localized": string,
  "register": "plain" | "formal",
  "notes": string
}

Rules:
- Preserve the meaning of the original text exactly.
- Do NOT translate medication or drug names if they appear; leave them as-is.
- Avoid idioms or slang; use standard language that is easy to understand.
- If the locale is RTL, ensure punctuation and numbers remain legible.
```

Task 10 — Testing, stubs, and observability
- Objectives:
  - Make the guided-help flow testable end-to-end without live GPT-4o calls, and observable in production without leaking PHI.
  - Catch contract drift early (schemas vs GPT-4o outputs) and ensure regressions surface quickly in CI.
- Deterministic stubs:
  - Add `apps/portal/src/dev/guidedHelpStub.ts` exposing pure functions:
    - `getStubStepResponse(seed: string, stepId: "step1"|"step2"|"step3"|"step4"|"step5")`.
    - `getStubSummary(seed: string)`.
    - `getStubRedFlag(seed: string)`.
  - Implement a simple mapping table keyed by synthetic seeds (e.g., `"headache"`, `"cough"`) that returns fixed, schema-valid JSON objects for each purpose, with no randomness.
  - Gate stub usage behind:
    - A portal env flag (e.g., `VITE_GUIDED_HELP_STUB_MODE=true`), and
    - A backend flag (e.g., `GUIDED_HELP_STUB_MODE`), so tests can run in fully stubbed mode end-to-end.
- Test suite design:
  - Contracts:
    - Add JSON Schema contract tests for the new guided-help request/response types (under `test/contracts` or equivalent).
    - Include “golden sample” payloads for common narratives and validate both request and GPT-4o response shapes.
  - Backend:
    - Unit tests for:
      - Step state machine (coveredFields, step ordering, max 5 steps, idempotency).
      - Quality scoring and `needsStep6` decisions with boundary cases.
      - Red-flag classifier behavior across rules-only, safety-gate-influenced, and GPT-4o-assisted scenarios (using stubbed outputs).
    - Integration tests for the `/guided-help/step` endpoint in stub mode, using seeded narratives (`"headache"`, `"chest pain"`, `"empty"`) to assert end-to-end JSON responses and error envelopes.
  - Frontend:
    - Component tests for the right-hand panel:
      - Step progression (1→5, optional 6), including early exit when the panel is closed.
      - “Generate summary” flow and rendering of summary, bullets, limitations, and actions.
      - Replace vs append behavior on the Narrative textarea, including undo.
    - Playwright/E2E tests covering:
      - A happy path: user writes a short narrative, uses guided-help through 3–5 steps, generates a summary, and chooses “Edit before using”.
      - A red-flag path: stub returns `stop_and_escalate`, guided-help stops, and the emergency message appears.
- Observability:
  - Metrics:
    - LLM call latency histograms by purpose (`step`, `summary`, `quality`, `redFlag`).
    - Counts of:
      - `guidedHelp.sessions.started` / `completed`.
      - `guidedHelp.steps.total` / `steps.perSession`.
      - `guidedHelp.needsStep6.rate`.
      - `guidedHelp.redFlag.rate` (broken down by source: rules, safety_gate, llm).
    - Summary length and textarea length buckets for monitoring truncation behavior.
  - Logging:
    - Use structured logs with fields: `correlationId`, `sessionId`, `stepId`, `purpose`, `llmProvider`, `llmModel`, `stubMode`.
    - Never log raw narratives, answers, or summaries; log only derived metrics (length, coverage, qualityScore, flags).
  - Tracing:
    - Add spans around:
      - Prompt building.
      - LLM HTTP calls.
      - Schema validation of responses.
    - Annotate spans with `purpose`, `stepId`, and whether stub mode is active.
- AI prompt (fixture for stub/snapshots, used only to design fixed JSON, not in prod):
```
Seed example: "headache"
Desired fixed JSON for step1 (used as a stub):
{
  "sessionId": "stub-session",
  "stepId": "step1",
  "question": "When did the headache start?",
  "rationale": "establish onset",
  "missingFields": ["onset"],
  "redFlags": ["none"],
  "proceedToSummary": false,
  "needsStep6": false
}
Stub rules:
- Static strings only; no randomness.
- Always schema-compliant with GuidedHelpStep.
- Used only in non-production environments and tests.
```
