# Safety Gate Labeling Guidelines

_Last updated: 2025-10-21_

## Scope
The labeling workflow governs the lightweight Safety Gate dataset and golden set used for regression tests. Labels capture:

- **Decision**: `DIVERTED`, `SAFE_TO_CONTINUE`, `ESCALATE_TO_CLINICIAN`, etc.
- **Red flags**: discrete triggers such as `chest_pain`, `respiratory_distress`, `severe_bleeding`, `suicidal_ideation`.

This guide is designed for rapid internal annotation; production datasets must still pass PHI scrubbing and data governance reviews.

## Narrative Handling

- Work with the raw patient narrative (`text`) exactly as submitted. Do not add synthetic wording or corrections.
- Record the narrative language in the metadata (e.g., `en-GB`, `es-ES`) when available. Non-English narratives should be preserved verbatim.
- Expand common abbreviations only when the clinical meaning would be ambiguous (e.g., spell out “CP” if the context does not clearly indicate “chest pain”).

## Decision Labels

- **`DIVERTED`**: Immediate emergency response required (e.g., chest pain + dyspnea, uncontrolled bleeding, active suicidal intent).
- **`SAFE_TO_CONTINUE`**: Narrative consistent with low-risk symptoms; reinforce self-care guidance only if mentioned explicitly.
- **`ESCALATE_TO_CLINICIAN`**: Non-emergent but requires professional follow-up (persistent high fever, medication conflicts, etc.).

Document the rationale for any borderline decisions in the annotation notes to simplify audits.

## Red-Flag Tags

| Label                | Positive Indicators                                                                      | Negative Indicators (do NOT label)               |
|----------------------|-------------------------------------------------------------------------------------------|--------------------------------------------------|
| `chest_pain`         | Crushing or radiating chest pain, pressure with exertion                                  | Heartburn explicitly relieved by antacids        |
| `respiratory_distress` | Severe shortness of breath, gasping, inability to speak full sentences                    | Mild congestion without dyspnea                  |
| `severe_bleeding`    | Active bleeding that “won’t stop”, passing large blood clots                              | Small cuts, controlled nosebleeds                |
| `suicidal_ideation`  | Statements about wanting to die, plans for self-harm, recent attempt                      | Passing mention of stress without self-harm      |

Always keep the `expectedRedFlags` array sorted alphabetically for diff stability.

## Edge Cases

- **Negations**: “No chest pain” or “denies suicidal thoughts” must *not* trigger the corresponding label.
- **Temporal qualifiers**: Historical events (“last year”) should be excluded unless the patient claims the issue has returned.
- **Multilingual narratives**: Use the same label set; provide a short English gloss in annotation notes for reviewers.

## Golden Set Workflow

1. Capture a minimal subset of narratives representative of high-risk and low-risk flows.
2. Annotate decisions and red flags using the rubric above.
3. Record the current model outputs (`modelDecision`, `modelRedFlags`) after running the release candidate.
4. Update `golden_set.v1.jsonl` and recompute the checksum in `manifest.json`.
5. Run `python data/eval_golden.py` to capture updated metrics and paste the summary into the PR description.

### Golden Set Fields

- `id`: stable identifier for traceability.
- `text`: raw narrative (no additional scrubbing).
- `expectedDecision`, `expectedRedFlags`: canonical ground-truth labels.
- `modelDecision`, `modelRedFlags`, `modelProbEmergency`: snapshot of the current reference model outputs.
- `slice`: cohort identifier (e.g., `web_en_gb`, `telephony_ivr`) used for drift/fairness monitoring.

## Quality Gates

- A change may only ship if decision accuracy stays at or above 0.95 on the golden set.
- Red-flag F1 must not regress by more than 0.05 compared to the baseline published in the manifest.
- All annotations require peer review; track sign-off in the PR and link to this guide.

## PHI & Privacy

Annotations never include direct patient identifiers. If a narrative contains PHI that is not already anonymised, redact before sharing outside the core triage team.
