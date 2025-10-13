Feature Store Queries
=====================

Purpose
-------
- Provide ML/Data teams with ready-to-run examples for exploring and exporting features stored in Postgres (Aurora) or JSONL backfills.
- Demonstrate common patterns: filtering by feature set, exploding JSON payloads, exporting to CSV/Parquet for training jobs.

Assumptions
-----------
- Feature store schema (Postgres):

```sql
CREATE TABLE feature_values (
  feature_set   TEXT      NOT NULL,
  entity_id     TEXT      NOT NULL,
  generated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  payload       JSONB     NOT NULL,
  expires_at    TIMESTAMPTZ,
  PRIMARY KEY (feature_set, entity_id, generated_at)
);
```

- JSON payloads conform to schemas in `schemas/features/*.json`.
- Replace `:practice_id` or dates with real values before running queries.

Triage Core Features
--------------------

### Daily snapshot (latest per entity)

```sql
WITH ranked AS (
  SELECT
    feature_set,
    entity_id,
    payload,
    generated_at,
    ROW_NUMBER() OVER (PARTITION BY feature_set, entity_id ORDER BY generated_at DESC) AS row_rank
  FROM feature_values
  WHERE feature_set = 'triage-core'
    AND generated_at >= NOW() - INTERVAL '7 days'
)
SELECT
  entity_id,
  payload->>'schemaVersion' AS schema_version,
  (payload->>'generatedAt')::timestamptz AS generated_at,
  (payload->>'acuity')::double precision AS acuity,
  (payload->>'risk')::double precision AS risk,
  (payload->>'complexity')::double precision AS complexity,
  (payload->>'time')::double precision AS time_signal,
  (payload->>'capacity')::double precision AS capacity,
  (payload->>'compositeScore')::double precision AS composite_score,
  payload->>'source' AS source
FROM ranked
WHERE row_rank = 1;
```

### Aggregated distribution (p95)

```sql
SELECT
  date_trunc('day', (payload->>'generatedAt')::timestamptz) AS day,
  percentile_cont(0.95) WITHIN GROUP (ORDER BY (payload->>'acuity')::double precision) AS acuity_p95,
  percentile_cont(0.95) WITHIN GROUP (ORDER BY (payload->>'risk')::double precision)   AS risk_p95
FROM feature_values
WHERE feature_set = 'triage-core'
  AND generated_at >= NOW() - INTERVAL '30 days'
GROUP BY 1
ORDER BY 1;
```

Acuity Signal Features
----------------------

```sql
SELECT
  entity_id,
  (payload->>'generatedAt')::timestamptz AS generated_at,
  payload->>'modelVersion' AS model_version,
  payload->>'predictedClass' AS predicted_class,
  (payload->>'emergencyProbability')::double precision AS emergency_probability,
  (payload->>'urgentProbability')::double precision     AS urgent_probability,
  (payload->>'routineProbability')::double precision    AS routine_probability,
  jsonb_array_length(payload->'symptomEmbedding')       AS embedding_dim
FROM feature_values
WHERE feature_set = 'acuity-signal'
  AND generated_at BETWEEN NOW() - INTERVAL '1 day' AND NOW()
ORDER BY generated_at DESC
LIMIT 100;
```

Exploding Embeddings for ML Pipelines
-------------------------------------

```sql
WITH embeddings AS (
  SELECT
    entity_id,
    generated_at,
    payload->'symptomEmbedding' AS embedding
  FROM feature_values
  WHERE feature_set = 'acuity-signal'
    AND generated_at >= NOW() - INTERVAL '3 days'
)
SELECT
  entity_id,
  generated_at,
  elem.index AS dimension,
  (elem.value)::double precision AS value
FROM embeddings,
LATERAL jsonb_array_elements(embedding) WITH ORDINALITY AS elem(value, index);
```

Exporting to CSV (psql)
-----------------------

```bash
psql "$FEATURE_STORE_URL" -c "\
  \COPY (
    SELECT entity_id,
           (payload->>'generatedAt')::timestamptz AS generated_at,
           (payload->>'acuity')::double precision AS acuity,
           (payload->>'risk')::double precision   AS risk,
           (payload->>'complexity')::double precision AS complexity
    FROM feature_values
    WHERE feature_set = 'triage-core'
      AND generated_at >= NOW() - INTERVAL '14 days'
  ) TO STDOUT WITH CSV HEADER" > triage-core-latest.csv
```

Exporting to Parquet (DuckDB CLI)
---------------------------------

```sql
-- Inside DuckDB shell
.open feature_store.duckdb
INSTALL postgres_scanner;
LOAD postgres_scanner;

ATTACH 'postgres://user:pass@host:5432/feature_store' AS feature_store_db (TYPE POSTGRES);

COPY (
  SELECT entity_id,
         (payload->>'generatedAt')::timestamptz AS generated_at,
         (payload->>'compositeScore')::double precision AS composite_score
  FROM feature_store_db.feature_values
  WHERE feature_set = 'triage-core'
    AND generated_at >= NOW() - INTERVAL '30 days'
) TO 'triage-core.parquet' (FORMAT PARQUET, COMPRESSION 'ZSTD');
```

Working with JSONL Backfills
----------------------------

```bash
# Convert backfilled JSONL features to CSV using jq
jq -r '
  [.entityId,
   .payload.generatedAt,
   .payload.acuity,
   .payload.risk,
   .payload.compositeScore] | @csv
' var/features/triage-core.jsonl > triage-core.csv
```

Notes & Recommendations
-----------------------
- Always validate schema versions (`schemaVersion`) before training; break glass if a new payload version appears with unexpected fields.
- Retention: combine with `scripts/feature_compact.js` to keep the working set small when exporting from JSONL.
- Privacy: exported datasets may contain PHI proxies (patient IDs, comorbidity flags). Follow the DPIA and governance checklists before sharing.
