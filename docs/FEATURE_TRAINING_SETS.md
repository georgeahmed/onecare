# Training Set PIT Helper

The `scripts/feature_store/pit_join_helper.js` utility builds leakage-safe training datasets by joining labels with feature snapshots using point-in-time semantics.

## Usage

```
node scripts/feature_store/pit_join_helper.js \
  --labels data/labels.jsonl \
  --snapshots data/feature-snapshots.jsonl \
  --feature-set triage-core \
  --feature-set acuity-signal \
  --output data/pit-training-set.jsonl
```

Input format:

- **Labels JSONL**: each line contains `{ "entityId": "patient-123", "timestamp": "2025-01-12T08:30:00Z", "label": 1 }`.
- **Snapshots JSONL**: each line is a feature snapshot `{ "featureSet": "triage-core", "entityId": "patient-123", "generatedAt": "2025-01-12T08:00:00Z", "payload": { ... } }`.

Output format: JSON lines with `entityId`, `entityHash`, `asOf`, `label`, and one column per requested feature set (`features_<featureSet>`). The helper never writes raw identifiers; `entityHash` (base64url) can be used for joins downstream.

## Implementation Notes

- Uses `packages/feature-store-offline` `buildPointInTimeTable` / `selectPointInTime` to guarantee leakage-safe joins.
- Accepts `--timestamp-field` and `--entity-field` to map alt schemas.
- Extend with notebooks/examples under `notebooks/pit/` (see ML repo) referencing this CLI for reproducible builds.

## Testing & Validation

- Add unit tests for PIT helpers in `packages/feature-store-offline/test/` when new feature sets are introduced.
- Before large training runs, sample output rows and confirm `generatedAt <= label timestamp` for all features.
- Retain generated datasets for ≤30 days unless aggregated according to the data retention policy.
