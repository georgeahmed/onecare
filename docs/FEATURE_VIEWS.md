# Feature Views

Feature views provide curated projections of underlying feature sets for model training and
serving. They aggregate or join one or more feature sets into a Point-in-Time (PIT) consistent
structure consumable by downstream jobs.

## View Definition

Views are defined in `scripts/feature_store/views.js` (and the associated registry metadata). Each
view specifies:

- `viewId` — unique identifier (e.g., `triage-core.sliding-windows`).
- Source feature sets and entity keys required for joins.
- Aggregations and lookback windows.
- Output schema (documented in `docs/FEATURE_SCHEMAS.md`).

Example snippet:

```js
{
  viewId: 'triage-core.sliding-windows',
  featureSets: ['triage-core'],
  windows: ['5m', '1h', '24h'],
  aggregates: ['mean', 'max', 'min'],
}
```

## CLI

`npm run feature:views` wraps the view planner and materialises view outputs.

```
npm run feature:views -- \
  --input data/triage-core.jsonl \
  --view triage-core.sliding-windows \
  --output var/features/views/triage-core-sliding.jsonl \
  --online
```

Key flags:

| Flag | Description |
|------|-------------|
| `--input` | Source JSONL of base feature snapshots |
| `--view` | View identifier (see registry) |
| `--output` | Target JSONL output |
| `--online` | Push results into the online store in addition to writing JSONL |
| `--dry-run` | Parse and validate without writing |

## Best Practices

- **PIT correctness** — Always supply snapshots that include `asOf` timestamps; the view planner filters out records newer than the requested evaluation time.
- **Backfill workflow** — Run `scripts/feature_backfill.js` followed by the view materialisation to ensure upstream features are up to date.
- **Validation** — After generating a view, run `scripts/feature_store/dq.js` against the view output if DQ rules are defined.
- **Storage** — Persist view outputs to Delta Lake under `feature_views/<viewId>/eventDate=YYYY-MM-DD/` for reproducibility.

## Onboarding a New View

1. Update the registry entry with view metadata (ownership, aggregation config).
2. Extend `scripts/feature_store/views.js` with the transformation logic.
3. Add monitoring entries (SLOs + alerts) to cover the new view.
4. Document the view (purpose, consumers) in this file.

## Existing Views

| View | Description |
|------|-------------|
| `triage-core.sliding-windows` | Rolling aggregates of triage-core features over 5m/1h/24h windows. |

Keep this table in sync as new views are created.
