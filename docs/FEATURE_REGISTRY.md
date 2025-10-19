# Feature Registry

## Purpose
- Canonical catalogue of entities, join keys, and feature set ownership.
- Drives code generation for typed feature payloads and orchestrates offline/online materialisation rules.
- Enables downstream automation: ingestion workers, training pipelines, and governance reporting.

## Version
- Registry document: `schemas/features/registry.json`
- Schema definition: `schemas/features/registry.schema.json`
- Current version: `v1.0.0`

## Entities
- **patient**
  - Keys: `patientId`
  - Surrogate Keys: `practiceId`
  - Classification: `phi`
  - Notes: Tenant-scoped hashed identifier; all feature sets hydrate against this key.
- **triageSubmission**
  - Keys: `submissionId`
  - Classification: `phi`
  - Notes: Represents a single intake narrative. Used for back-references from feature snapshots to operational events.

## Feature Sets

### triage-core
- Entity: `patient`
- Schema: `schemas/features/triage-core.json`
- Owners: Data Engineering, Triage
- Sources: Triage service, historical backfill job
- Freshness: SLA 15 minutes, hard expiry 30 minutes
- Offline Materialisation: Delta Lake (`feature_pit.triage_core`), partitioned by `featureSet/eventDate/entityBucket`
- Online Materialisation: Redis adapter, TTL 900 seconds
- Tags: triage, core, prioritisation
- Payload Fields: see `docs/FEATURE_SCHEMAS.md`

### acuity-signal
- Entity: `patient`
- Schema: `schemas/features/acuity-signal.json`
- Owners: Data Engineering, Safety Gate
- Sources: Safety Gate service
- Freshness: SLA 5 minutes, hard expiry 10 minutes
- Offline Materialisation: Delta Lake (`feature_pit.acuity_signal`), partitioned by `featureSet/eventDate/entityBucket`
- Online Materialisation: Redis adapter, TTL 600 seconds
- Tags: safety, acuity
- Payload Fields: see `docs/FEATURE_SCHEMAS.md`

## Consuming the Registry
- TypeScript types generated at `packages/events/src/contracts/feature-registry.ts`
- Runtime helpers in `@onecare/ports` (`packages/ports/src/features.ts`)
  - `listFeatureSets()` – enumerate metadata
  - `getFeatureSchemaId(featureSet)` – contract lookup
  - `validateFeaturePayload(featureSet, payload)` – AJV backed validation
  - `getEntityDefinition(name)` – join key metadata for ingestion jobs
- Python models available via `services-py/common/contracts/models.py` after `RUN_PY=1 npm run codegen`
- Registry changes must bump `version` and update dependent docs/ADR.

## Workflow
1. Update or add feature payload schema (`schemas/features/*.json`).
2. Extend registry entry with ownership, freshness, and materialisation updates.
3. Run `npm run codegen` to refresh generated contracts.
4. Update ingestion/monitoring components that act on the changed feature set.
5. Review governance implications (`docs/FEATURE_GOVERNANCE.md`) and update monitoring/backfill docs (`docs/FEATURE_BACKFILL.md`, `docs/FEATURE_MONITORING.md`).

## Validation
- `npm run codegen:check` ensures schema + registry remain accessible.
- Unit tests live in:
  - `packages/ports/test/features.registry.test.ts`
  - `packages/feature-store-offline/test/*`
  - `packages/feature-store-ingest/test/*`
