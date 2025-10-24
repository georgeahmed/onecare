# Feature Store Data Quality & Freshness

This guide covers the automated checks that protect feature correctness and freshness across both batch and
streaming ingestion. Pair with `docs/FEATURE_GOVERNANCE.md` for privacy controls and `docs/FEATURE_FRESHNESS.md`
for SLO guidance.

## Configuration (`config/feature-store/dq.json`)

Constraints are defined per feature set. Example excerpt:

```json
{
  "triage-core": {
    "freshness": { "maxAgeSeconds": 3600 },
    "constraints": {
      "acuity": { "type": "range", "min": 0, "max": 1 },
      "source": { "type": "domain", "values": ["triage-service", "backfill", "playback"] },
      "generatedAt": { "type": "notNull" },
      "sequence": { "type": "monotonic", "direction": "nondecreasing" }
    }
  }
}
```

Supported constraint types:

| Type | Description |
|------|-------------|
| `range` | Numeric value must be within `[min, max]` (inclusive). |
| `domain` | String value must match one of the configured elements. |
| `notNull` | Field must be present and non-empty. |
| `monotonic` | Value must be non-decreasing or non-increasing per entity (configurable via `direction`). |

Freshness checks evaluate `asOf` (or `payload.generatedAt`) and flag records older than `maxAgeSeconds`.

## Checker CLI (`scripts/feature_store/dq.js`)

```
node scripts/feature_store/dq.js \
  --input var/features/triage-core.jsonl \
  --config config/feature-store/dq.json \
  --quarantine var/features/dq-quarantine.jsonl
```

Options:

| Flag | Description | Default |
|------|-------------|---------|
| `--input` / `-i` | JSONL file of feature records (`{ featureSet, entityId, asOf, payload }`) | `var/features/triage-core.jsonl` |
| `--config` | Path to constraint configuration | `config/feature-store/dq.json` |
| `--quarantine` / `-q` | Output NDJSON file containing violations | `var/features/dq-quarantine.jsonl` |
| `--now` | Override reference time (ISO string) for freshness calculations | current time |

**Output** — the script prints a JSON summary (`records`, violations per feature set, freshness percentiles) and writes
quarantine entries (one JSON object per line) describing the failing constraint. Sample summary:

```json
{
  "summary": {
    "records": 4200,
    "featureSets": [
      { "featureSet": "triage-core", "total": 3000, "violations": 12, "freshnessBreaches": 5 },
      { "featureSet": "acuity-signal", "total": 1200, "violations": 3, "freshnessBreaches": 0 }
    ],
    "constraintViolations": [
      { "featureSet": "triage-core", "field": "acuity", "reason": "range", "count": 8 },
      { "featureSet": "triage-core", "field": "sequence", "reason": "monotonic_nondecreasing", "count": 4 }
    ],
    "freshness": {
      "samples": 4200,
      "p50Ms": 28000,
      "p95Ms": 310000,
      "maxMs": 7200000,
      "breaches": [
        { "featureSet": "triage-core", "entityId": "patient-184", "ageMs": 7200000, "maxAgeSeconds": 3600 }
      ]
    }
  }
}
```

## Automation Cadence

- **Ingestion guardrail** — run the checker on each batch (post-ingest) before publishing to downstream warehouses.
- **Streaming monitor** — schedule the script hourly against a rolling export of the online store; raise alerts when
  violations > 0 or freshness p95 exceeds SLO thresholds.
- **Quarantine handling** — violations are written to `var/features/dq-quarantine.jsonl`; ship the file to cold storage
  once remediated. Pair with the analytics retention cron where possible.

## Alerting & Metrics

- Emit summary metrics (e.g., counts per `reason`) into Prometheus or pushgateway to drive dashboards.
- Trigger incidents when:
  - Range/domain violations occur for three consecutive runs.
  - Freshness `p95` exceeds the configured maximum by >10% for more than 30 minutes.
  - Monotonic breaches appear after a deploy (indicates ordering/regression issues).

## Next Steps

- Extend the configuration to cover new feature sets when they are onboarded.
- Integrate the checker into CI once fixtures for regression testing are finalised.
- Feed violation counts into the feature-store operations channel for daily review.
