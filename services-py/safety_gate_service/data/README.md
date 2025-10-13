Labeling Guidelines (Safety Samples)
====================================

This lightweight dataset is for unit tests and local experimentation only; never publish it or serve it to production paths.

Red-flag labels currently used:
- `chest_pain`: chest tightness, left-arm pain, or classic cardiac warning signs.
- `respiratory_distress`: shortness of breath, gasping, or trouble breathing.
- `severe_bleeding`: uncontrolled bleeding, large blood loss, or blood that will not clot.
- `suicidal_ideation`: self-harm intent, plan, or statements about wanting to die.

Labeling guidance:
- Add a label when the narrative contains unambiguous language for that condition; mild or historical mentions stay unlabeled.
- Mark `emergency` as `true` only when the combination of symptoms needs immediate triage (e.g., chest pain with breathing issues).
- Always keep `red_flag_labels` sorted alphabetically to ease diffing.

Fields:
- `text`: the raw patient-submitted narrative.
- `red_flag_labels`: array of zero or more labels from the list above.
- `emergency`: boolean indicator of urgent escalation.
