# ADR 2025-10-18 — Triage Deduplication & Similarity

| Status | Accepted |
|--------|----------|
| Date   | 2025-10-18 |

## Context

Duplicate submissions (same patient, same narrative) overwhelm clinicians and skew downstream analytics. We require a fast, memory-friendly deduplication mechanism that:

- Detects near-identical narratives within a configurable time window.
- Is deterministic and embeddable in the event-driven consumer (no external database dependency).
- Emits only hashed references/logs to prevent PHI leaks.

## Decision

1. **In-memory shingle store**
   - We maintain a bounded per-patient cache (`createDedupStore`, max 50 entries per patient by default) keyed by patient ID.
   - Each entry stores the timestamp, normalised narrative shingles, and similarity metadata.
   - Window length and shingle size are driven by config:
     - `triage.dedup_window` (ISO-8601 duration) controls how long entries remain eligible for duplicates.
     - `triage.sim_threshold` sets the cosine similarity threshold (default `0.8`).
     - `triage.dedup_shingle_size` / `triage.dedup_normalization` fine-tune text normalisation and tokenisation.

2. **Similarity algorithm**
   - Narratives are normalised (lowercase, strip punctuation, optional stemming/stopwords) via `normalizeText`.
   - We apply a shingle TF vector and cosine similarity to existing entries for the same patient.
   - When similarity ≥ threshold within the dedup window, we mark the context as duplicate and short-circuit scoring.

3. **Duplicate handling**
   - Duplicate detection transitions the state machine to `Duplicate`, optionally invoking `ctx.handleDuplicate`.
   - Logs emit hashed patient references plus summary metrics (`triage.dedup.hit/miss`, `triage.dedup.similarity`).
   - Duplicate decisions publish `triage.decision` with `duplicateOf` referencing `<patientId>:<timestamp>` (downstream systems know to fetch historical context without exposing raw narrative).

4. **PHI minimisation**
   - Narratives are never persisted or emitted; only similarity scores and hashed IDs are logged.
   - Metrics avoid narrative text, just aggregate similarity values.

5. **Operational considerations**
   - Cache size is capped to prevent unbounded memory growth; LRU eviction removes the oldest entry.
   - Tests (`apps/triage/test/dedup.test.ts`) exercise window behaviour and similarity thresholds.

## Consequences

- Dedup is eventual: once the window elapses, new submissions are treated as fresh even if narratives match. This is intentional to avoid suppressing clinically relevant updates.
- Because the store is in-memory, restarting the consumer clears the dedup history; for long-lived duplicates, upstream orchestration should provide additional safeguards (idempotency keys).
- Config mis-tuning (e.g. low threshold) can suppress legitimate follow-ups; practice-config reviews must include clinical validation.
