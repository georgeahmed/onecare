# Triage Intake Dataset Schema

Purpose: define the minimum dataset we must curate from operational systems to train, evaluate, and monitor emergency-detection and triage-scoring models while staying compliant with OneCare policies.

## Scope and Versioning
- Dataset covers patient-facing intake submissions (web, IVR, assisted) that enter the orchestrator safety-gate flow.
- Each record represents a single submission after normalization and de-identification according to the local consent flag.
- Store dataset snapshots under `data/triage/<version>/` with semantic tags (`vYYYYMMDD`, `pilot`, `shadow-eval`) and record lineage in `docs/adr`.

## Source Systems
- Portal/web intake (`apps/portal`): patient narrative, attachments metadata, locale.
- Telephony/IVR (`apps/telephony`, `services-py/scribe_service`): transcripts, diarization, ASR confidence.
- Orchestrator (`apps/orchestrator`): derived safety-gate scores, correlation IDs, audit trail, routing decision.
- Clinician tasking/EMR integration: final disposition, overrides, follow-up timestamps.
- Extraction helpers: use `scripts/triage_dataset/extract_inputs.py` to convert raw JSONL exports into builder inputs (`triage_submissions.jsonl`, `safety_gate.jsonl`, `clinician_outcomes.jsonl`). The script accepts a source config (see `config/triage_dataset_sources.example.json`) for local directories or S3 prefixes.

## Record Layout

| Field | Type | Source | Notes |
| --- | --- | --- | --- |
| `submissionId` | string | Orchestrator | Stable identifier (idempotency key hash); keep reversible mapping offline. |
| `practiceId` | string | Intake payload | Pseudonymise for training; retain mapping in secure lookup. |
| `patientKey` | string | Intake payload | Generated hash combining patient id + salt; no raw MRN/ID in dataset. |
| `consentScope` | string | Consent ledger | Enum (`training_allowed`, `ops_only`, `opt_out`); filter upstream. |
| `channel` | string | Intake payload | `web`, `ivr`, `assisted`; feeds feature analysis. |
| `submittedAt` | datetime | Intake | ISO8601 UTC truncated to hour unless explicit consent for minute-level timing. |
| `narrative` | string | Intake | De-identified text (see PHI handling). Preserve medical terminology casing. |
| `attachments` | object[] | Intake | Array of `{contentType, redactedUrl}`; drop binary; redact filenames. |
| `patientAgeYears` | number | Intake/EMR | Rounded to nearest year, clamp 0–120. |
| `patientSex` | string | Intake/EMR | Optional; use standard codes (`female`, `male`, `other`, `unknown`). |
| `patientLocale` | string | Intake | BCP 47 tag; blank if absent. |
| `comorbidities` | object | Intake/EMR | Map of boolean flags (`cardiac`, `respiratory`, `diabetes`, etc.). |
| `vitals` | object | EMR/triage | Optional; key/value floats (`bp_systolic`, `heart_rate`). Include unit metadata if available. |
| `safetyGate` | object | Safety gate | Nested payload containing decision metadata (`redFlags`, classifier scores, acuity scores). |
| `safetyGateDecision` | string | Safety gate | `DIVERTED` or `SAFE_TO_CONTINUE`. |
| `safetyGateReason` | string | Safety gate | Sanitised rationale key (`red_flag:chest_pain`, `classifier:probability`). |
| `clinicianDisposition` | string | Tasking/EMR | Canonical outcome (`er_transfer`, `clinic_followup`, `self_care`). |
| `clinicianOverride` | boolean | Tasking/EMR | `true` if clinician overrode gate decision. |
| `overrideNotes` | string | Tasking | De-identified free-text rationale; mask names/locations. |
| `resolutionTimeMinutes` | number | Tasking | Minutes from submission to clinician decision. |
| `followUpRequired` | boolean | Tasking | Flag if additional outreach scheduled. |
| `labels` | object | Labeling workflow | Contains `emergency` boolean and `priorityBand` enumeration. |
| `auditTrailIds` | string[] | Audit service | IDs of audit events for traceability; stored separately. |

### Derived Feature Views
- Generate feature matrices compatible with `services-py/common/features/features.json`:
  - `symptom_embedding`: run current encoder on `narrative` + `safetyGate.redFlags`.
  - `age_years` and `comorbidity_flags`: sourced from patient context.
- Additional engineered features (release gating):
  - `narrative_length_tokens`, `sentiment_score`, `temporal_mentions`, `negation_flags`.
  - `llm_suggested_flags` (shadow-only until approved).

## PHI Handling and De-identification
- Apply configurable PHI masking pipeline before writing dataset:
  - Step 1: deterministic hashes for patient/practice identifiers with salted SHA-256.
  - Step 2: rule-based scrub (emails, phone numbers, URLs, attachment filenames).
  - Step 3: NER-driven masking for names, locations, dates; retain placeholders (`<NAME_1>`).
  - Step 4: manual spot checks for samples flagged by uncertainty metrics.
- Maintain linkage tables in encrypted storage accessible only to the compliance-approved analytics group.
- Record `deidentVersion` metadata in dataset manifest to track masking rules.

## Consent, Retention, and Access
- Only include rows where `consentScope == training_allowed`.
- Attach per-row `consentCapturedAt` timestamp to support audits.
- Retain raw training dataset for ≤18 months unless extended by DPIA; derived model artifacts may persist per retention policy documented in `config/`.
- Access limited to ML engineers + clinical reviewers with documented training; enforce quarterly access review.

## Lineage and Quality Metadata
- Store dataset manifest (`manifest.json`) alongside data:
  - `source_systems`, `extraction_range`, `record_count`, `emergency_positive_rate`.
  - Data quality checks (missing narrative %, invalid scores).
- Log ETL run metadata to `observability` pipeline for reproducibility.
- Reference manifest in model cards when publishing new safety-gate artifacts.
- See `docs/triage/manifest.example.json` for a sample manifest structure generated by the builder CLI.

## Future Extensions
- Pediatric-specific schema variant once sufficient data available; add `guardianNotified` field.
- Integrate ASR confidence and diarization metrics for IVR submissions to study correlation with overrides.
- Evaluate inclusion of social determinants (if captured) under separate consent tier.
