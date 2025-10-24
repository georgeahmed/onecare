# Feature Store SDK & Notebook Examples

## Quickstart

### Offline PIT

```bash
node scripts/feature_store/pit_join_helper.js \
  --labels data/labels.jsonl \
  --snapshots data/feature-snapshots.jsonl \
  --feature-set triage-core \
  --output data/pit-training-set.jsonl
```

### Online Fetch (Node)

```javascript
import { InMemoryOnlineFeatureStore } from '@onecare/feature-store-online';

const store = new InMemoryOnlineFeatureStore();
await store.upsert({
  featureSet: 'triage-core',
  entityId: 'patient-123',
  asOf: new Date().toISOString(),
  payload: { schemaVersion: 'v1', acuity: 0.45 },
  ttlSeconds: 600,
});
const features = await store.get({ featureSet: 'triage-core', entityId: 'patient-123' });
```

## Notebook Demo

See `examples/notebooks/feature_store_demo.ipynb` for an end-to-end walkthrough covering:

1. Loading PIT snapshots and labels.
2. Generating a training matrix.
3. Querying the online store with warm cache and measuring latency.

### Authentication & Config

- Obtain Vault-issued tokens via the standard ML onboarding process.
- Set environment variables (`FEATURE_STORE_URL`, `FEATURE_STORE_TOKEN`) before running notebooks.
- Do **not** hardcode secrets inside notebooks; use `.env` or Jupyter secrets manager.

## FAQ

- **How do I add a new feature set?** Coordinate with Data Engineering, update `schemas/features/registry.json`, and regenerate SDK artefacts.
- **How do I export data?** Use the PIT helper or offline Parquet dumps; respect `docs/FEATURE_LIFECYCLE.md`.
