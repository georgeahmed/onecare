# Streaming Feature Ingestion

## Components
- **Feature Registry**: Defines schema + TTL (`schemas/features/registry.json`).
- **Online Store Adapter**: `@onecare/feature-store-online` (in-memory implementation, Redis target TBD).
- **Ingestion Worker**: `@onecare/feature-store-ingest` consuming events via `@onecare/bus` with idempotency safeguards.

## Workflow
1. Subscribe to feature topics (e.g., `features.triage-core`).
2. Map event payloads to registry-backed feature sets.
3. Validate payload with `validateFeaturePayload(featureSet, payload)`.
4. Upsert into online store with TTL (default derived from registry, override per mapping).
5. Emit DLQ entry on repeated failure.

## Usage
```ts
import { MemoryBus } from '@onecare/bus';
import { InMemoryOnlineFeatureStore } from '@onecare/feature-store-online';
import { FeatureIngestionWorker } from '@onecare/feature-store-ingest';

const worker = new FeatureIngestionWorker({
  bus: new MemoryBus(),
  featureStore: new InMemoryOnlineFeatureStore(),
  idempotency: myIdempotencyStore,
  mappings: [
    {
      topic: 'features.triage-core',
      featureSet: 'triage-core',
      deriveEntityId: (payload) => payload.patientId,
      deriveAsOf: (payload) => payload.generatedAt,
      mapPayload: (payload) => payload.features,
    },
  ],
});
await worker.start();
```

## Reliability
- **Idempotency**: Uses `reserve`/`exists` from `IdempotencyStore` to guard duplicates.
- **Retries**: Exponential-ish backoff with jitter; DLQ after `options.retries` attempts.
- **Metrics**: `getMetrics()` returns processed/skipped/retries/dlq counts.

## Scripts
- CLI runner: `npm run feature:ingest` (see `scripts/feature_store/ingest_stream.js`).
- Backfill: `npm run feature:backfill` (existing).
- Compaction: `node scripts/feature_compact.js`.

