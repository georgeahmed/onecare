# Triage Dataset Pipeline – Source Setup & Schedule

This note explains how to connect the dataset builder to real export locations and automate snapshot creation. Follow this once the schema/governance docs (`docs/triage/data-schema.md`, `docs/compliance/triage-data-governance.md`) and tooling (`scripts/triage_dataset/`) are in place.

## 1. Create a Source Config

1. Copy the template to a config you control (keep outside of version control if it contains sensitive paths):
   ```bash
   cp config/triage_dataset_sources.example.json config/triage_dataset_sources.prod.json
   ```
2. Edit `config/triage_dataset_sources.prod.json` so each section points to your actual export locations. Example:
   ```json
   {
     "submissions": [
       { "type": "s3", "bucket": "onecare-ops-prod", "prefix": "triage/submissions/2025-03/" },
       { "type": "local", "path": "/mnt/logs/orchestrator/submissions" }
     ],
     "safetyGate": [
       { "type": "s3", "bucket": "onecare-ops-prod", "prefix": "triage/safety-gate/2025-03/" }
     ],
     "clinician": [
       { "type": "local", "glob": "/mnt/audit/triage/clinician/*.jsonl" }
     ]
   }
   ```
   Notes:
   - `type` can be `local` (single path or glob) or `s3` (bucket + prefix). Globs/paths may include environment variables.
   - If you need both S3 and local sources, list multiple entries. The pipeline downloads S3 files to a scratch directory before processing.

## 2. Run the Pipeline Manually

1. Set the hashing salt (keep the secret outside scripts, e.g., in a secure shell or CI secret store):
   ```bash
   export TRIAGE_DATASET_SALT="<your-secret-salt>"
   ```
2. Run the pipeline script with your config and desired date window:
   ```bash
   python3 scripts/triage_dataset/run_pipeline.py \
     --config config/triage_dataset_sources.prod.json \
     --dataset-version v$(date +%Y%m%d) \
     --output-dir data/triage \
     --since 2025-03-01T00:00:00Z \
     --until 2025-03-31T23:59:59Z
   ```
   - `--dataset-version` tags the output directory (e.g. `v20250331`). Default is todays date if omitted.
   - `--since/--until` filter submissions by submission timestamp. Leave blank to pull everything available.
   - Add `--keep-inputs` to retain the intermediate JSONL files (`triage_submissions.jsonl`, `safety_gate.jsonl`, `clinician_outcomes.jsonl`) beneath the dataset output for debugging.
3. Inspect the summary printed to stdout. The dataset snapshot (JSONL + manifest) lives under `data/triage/<dataset-version>/`.
4. Verify the manifest (`manifest.json`) and dataset (`dataset.jsonl`) follow the schema. Confirm the record count and emergency positive rate look reasonable.

## 3. Automate the Snapshot

Choose how often you want to refresh the dataset (e.g. monthly). Options:

- **Cron / systemd timer**: add a cron entry (ensure environment has Python, repo checkout, network access, and `TRIAGE_DATASET_SALT` stored securely, e.g. in a sourced file).
- **CI/CD job (GitHub Actions, Jenkins, etc.)**: create a job that runs the same command. Store `TRIAGE_DATASET_SALT` and any S3 credentials as encrypted secrets. Point the working directory at the repo checkout.
- **MLOps scheduler**: integrate the command into your existing data pipeline orchestrator (Airflow, Prefect, etc.). Use the `run_pipeline.py` arguments to match your time window.

Suggested cron snippet (runs on the 1st of each month at 02:00 UTC):
```cron
0 2 1 * * TRIAGE_DATASET_SALT=... /usr/bin/python3 /path/to/repo/scripts/triage_dataset/run_pipeline.py \
  --config /secure/config/triage_dataset_sources.prod.json \
  --dataset-version v$(date +\%Y\%m\%d) \
  --output-dir /secure/datasets/triage \
  --since $(date -d "-1 month" +\%Y-\%m-01)T00:00:00Z \
  --until $(date -d "-1 day" +\%Y-\%m-%d)T23:59:59Z
```
Adjust paths/dates to your retention policy. If your scheduler cannot expand the `$(...)` expressions, compute the date window upstream and pass explicit values.

## 4. Store Outputs Securely

- Ensure `data/triage/<version>` (or your chosen destination) resides in an encrypted storage location with access limited to the ML/compliance team.
- Keep the `config/triage_dataset_sources.prod.json` file out of the repository if it contains sensitive paths. Ideally store it in a secrets manager or protected configuration repo.
- Rotate or audit the `TRIAGE_DATASET_SALT` per governance policy.

## 5. Validation Checklist

After your first production run:
- [ ] Manifest stats match expectations (record count, consent breakdown, emergency rate).
- [ ] Spot-check random rows for proper masking (no raw identifiers, attachments redacted).
- [ ] Confirm clinician overrides and labels populated as expected.
- [ ] Log the dataset version + manifest in your model card / data catalog.

Once these steps are complete, you have a ready-to-train snapshot aligned with the research plan.
