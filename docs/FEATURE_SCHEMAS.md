Feature Schemas
===============

Purpose
-------
- Provide versioned JSON Schemas for feature vectors persisted in the feature store.
- Ensure downstream consumers (ML services, analytics, monitoring) can validate payloads and reason about freshness, ownership, and privacy classification.

Entity Model
------------
- **Entity**: `patientId` (hashed/tenant-scoped). Additional dimensions such as practiceId or encounterId are handled in the feature store key, not within the payload.
- **Namespace**: `featureSet` identifies the schema (`triage-core`, `acuity-signal`, ...).
- **Freshness**: Each payload carries `generatedAt` and optional `expiresAt`. Pipelines should refresh vectors before expiry.

Available Schemas
-----------------

### 1. `triage-core` (`schemas/features/triage-core.json`)

- **Purpose**: Inputs to the triage prioritisation state machine; derived from scoring services and operational signals.
- **Freshness SLA**: 15 minutes (values older than this should be recomputed).
- **Owner**: Data Engineering + Triage team.
- **Fields**

| Field            | Type      | Constraints                   | Notes                                            |
|------------------|-----------|-------------------------------|--------------------------------------------------|
| `schemaVersion`  | string    | `^v[0-9]+(\.[0-9]+){0,2}$`    | Bump on breaking changes.                        |
| `generatedAt`    | date-time |                               | UTC timestamp when the vector was computed.      |
| `acuity`         | number    | 0–1                           | Emergency probability/severity.                  |
| `risk`           | number    | 0–1                           | Risk of deterioration.                           |
| `complexity`     | number    | 0–1                           | Care coordination/complexity signal.             |
| `time`           | number    | 0–1                           | Time-sensitivity/urgency.                        |
| `capacity`       | number    | 0–1                           | Capacity pressure modifier.                      |
| `compositeScore` | number    |                               | Weighted score used for queue ordering.          |
| `source`         | string    | ≤64 chars                     | Pipeline or model identifier.                    |
| `expiresAt`      | date-time | optional                      | Rescore after expiry.                            |
| `extensions`     | object    | lowerCamelCase keys           | Optional map for additive signals (number/string/boolean/null). |

- **Sample Payload**

```json
{
  "schemaVersion": "v1.0.0",
  "generatedAt": "2025-10-12T09:30:00Z",
  "acuity": 0.82,
  "risk": 0.54,
  "complexity": 0.25,
  "time": 0.60,
  "capacity": 0.18,
  "compositeScore": 0.59,
  "source": "triage-pipeline-v3",
  "expiresAt": "2025-10-12T09:45:00Z",
  "extensions": {
    "pediatricModifier": 0.1
  }
}
```

### 2. `acuity-signal` (`schemas/features/acuity-signal.json`)

- **Purpose**: Raw outputs and diagnostic artefacts from the safety gate / acuity ensemble (ner + classifier + gradient boosting).
- **Freshness SLA**: 5 minutes while patient narrative is under review.
- **Owner**: Data Engineering + Safety Gate (ML).
- **Fields**

| Field                 | Type      | Constraints                       | Notes                                          |
|-----------------------|-----------|-----------------------------------|------------------------------------------------|
| `schemaVersion`       | string    | `^v[0-9]+(\.[0-9]+){0,2}$`        | Payload version.                               |
| `generatedAt`         | date-time |                                   | UTC timestamp created.                         |
| `modelVersion`        | string    | ≤64 chars                         | Model artifact/version id.                     |
| `predictedClass`      | string    | `emergency|urgent|routine`        | Hard decision from classifier.                 |
| `emergencyProbability`| number    | 0–1                               | Optional probability for emergency.            |
| `urgentProbability`   | number    | 0–1                               | Optional probability for urgent.               |
| `routineProbability`  | number    | 0–1                               | Optional probability for routine.              |
| `symptomEmbedding`    | number[]  | 1–512 numbers                     | Dense embedding of symptom features.           |
| `patientAgeYears`     | integer   | 0–120                             | Patient age used by model.                     |
| `comorbidityFlags`    | object    | snake_case keys → boolean         | Model-ready comorbidity indicators.            |
| `explanations`        | object[]  | up to 32 `{feature, contribution}`| Attribution artefacts (SHAP-style).            |
| `expiresAt`           | date-time | optional                          | Recompute after expiry.                        |

- **Sample Payload**

```json
{
  "schemaVersion": "v1.0.0",
  "generatedAt": "2025-10-12T09:29:45Z",
  "modelVersion": "acuity-ensemble-2025-10-01",
  "predictedClass": "urgent",
  "emergencyProbability": 0.21,
  "urgentProbability": 0.62,
  "routineProbability": 0.17,
  "symptomEmbedding": [0.12, -0.04, 0.33],
  "patientAgeYears": 67,
  "comorbidityFlags": {
    "diabetes_type2": true,
    "copd": false
  },
  "explanations": [
    { "feature": "symptom_embedding_5", "contribution": 0.14 },
    { "feature": "patientAgeYears", "contribution": 0.08 }
  ]
}
```

Conventions & Next Steps
------------------------
- File naming: `schemas/features/<feature-set>.json` (kebab-case). `$id` mirrors the path under `https://onecare/schemas/features/`.
- All schemas set `additionalProperties: false`; additive signals should be placed under the `extensions` map (triage) or require a schema bump.
- When introducing a new feature set, add a corresponding entry in this document capturing owner, freshness SLA, join keys, and sample payload.
- Pipelines (including `scripts/feature_backfill.js`) must validate payloads with the `@onecare/ports` helpers before writing to the feature store. A failing validation should be treated as a data quality incident (surface to DLQ/alerts).
