# Red-Flag Lexicon Review Guide

Clinicians can use this guide to review and update the emergency red-flag keywords that feed the safety gate.

## Where the data lives
- **Baseline list:** `config/red_flags/core.json` (lower-case strings, one entry per line). This ships with the repo and is loaded automatically for every practice.
- **Practice/region additions:** YAML files under `config/{global,ics,pcn,practices}/**/*.yaml` can add extra entries via the `red_flag_set` array (entries are merged additively).
- **Resolved output:** `packages/config` exposes `config.red_flag_set` to the orchestrator/safety gate. Entries are normalised to lower-case and duplicates removed.

## Review cadence
1. Export the current list (baseline + overrides):
   ```bash
   node scripts/triage_dataset/list_red_flags.js
   ```
   (Script prints the merged list with the source file for each entry.)
2. Clinicians review the list for:
   - Missing phrases or synonyms encountered recently.
   - Outdated items that generate unnecessary emergency diversions.
   - Spelling/locale variants (e.g. "labour" vs "labor").
3. Capture proposed edits in a quick change log (date, reviewer, rationale).
4. Update `core.json` for global changes or the relevant YAML file for practice-specific requirements.
5. Submit the changes through the usual PR flow with clinician sign-off noted in the description.

## Adding or removing items
- **Global change:** edit `config/red_flags/core.json`. Keep entries lower-case and descriptive (e.g. `"severe abdominal pain"`).
- **Practice-specific change:** add a `red_flag_set` array (or extend the existing one) in the relevant YAML file, e.g. `config/practices/demo.yaml`:
  ```yaml
  red_flag_set:
    - "vision loss"
    - "recent head trauma"
  ```
- **Removal:** delete the entry from the JSON/YAML file. Avoid removing core items without a documented clinical reason.

## Validating changes locally
1. Run config tests:
   ```bash
   npm test --workspace=@onecare/config
   ```
2. Spot-check the resolved config for a practice:
   ```bash
   node -e "const { loadConfig } = require('@onecare/config'); console.log(loadConfig('demo').red_flag_set);"
   ```
3. (Optional) Execute the safety gate unit tests to ensure decision logic still passes:
   ```bash
   pytest services-py/tests/test_decision.py
   ```

## Checklist before merging
- [ ] Clinician reviewed the diff and approved additions/removals.
- [ ] All entries are lower-case, concise, and free of PHI.
- [ ] Automated tests pass (`npm test --workspace=@onecare/config`, `pytest services-py/tests/test_decision.py`).
- [ ] PR description notes the reviewer and rationale for changes.

Following this process keeps the deterministic safety layer aligned with real-world language while maintaining an auditable trail of changes.
