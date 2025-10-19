Labeling Guidelines (Safety Samples)
====================================

This lightweight dataset is for unit tests and local experimentation only; never publish it or serve it to production paths.

Versioning & Manifest
---------------------
- Dataset releases are versioned in `manifest.json`. Each entry records the path and checksum of the corresponding artifact (golden set, labeling guide).
- The current golden set lives in `golden_set.v1.jsonl`; update the manifest and checksum when iterating on labels.
- Keep the previous versions when producing a new release so regressions can be reproduced.

Red-flag labels currently used:
- `chest_pain`: chest tightness, left-arm pain, or classic cardiac warning signs.
- `respiratory_distress`: shortness of breath, gasping, or trouble breathing.
- `severe_bleeding`: uncontrolled bleeding, large blood loss, or blood that will not clot.
- `suicidal_ideation`: self-harm intent, plan, or statements about wanting to die.

Labeling guidance:
- Add a label when the narrative contains unambiguous language for that condition; mild or historical mentions stay unlabeled.
- Mark `emergency` as `true` only when the combination of symptoms needs immediate triage (e.g., chest pain with breathing issues).
- Always keep `red_flag_labels` sorted alphabetically to ease diffing.

Golden Set Fields:
- `id`: stable identifier for traceability.
- `text`: the raw patient-submitted narrative.
- `expectedDecision`: canonical decision label (`DIVERTED`, `SAFE_TO_CONTINUE`, ...).
- `expectedRedFlags`: array of red-flag labels present in the narrative.
- `modelDecision`/`modelRedFlags`: snapshot of the current reference model outputs; used by the evaluation script to compute regression metrics.

Tooling
-------
- `eval_golden.py` computes precision/recall/F1 and decision accuracy against the golden set; integrate it into CI for regression checks.
- `docs/ml/safety_gate_labeling.md` documents labeling instructions, corner cases, and multilingual guidance.
