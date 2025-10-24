# QA Contract Drift Guardrails

Changes to JSON Schemas or generated models must not silently diverge from tests. The following guardrails catch drift early.

## Automated Checks
1. **Code generation parity** — `npm run codegen:check` runs in CI before tests. Regenerate artifacts with `npm run --workspaces=false codegen` if schemas change, then commit the updated TypeScript/Python models.
2. **Snapshot validation** — `qa/contracts/snapshots/*.json` capture representative payloads for critical contracts. `qa/contracts/snapshots.spec.ts` validates each snapshot against the schema and the envelope helper. Schema changes that alter shape will fail this suite until the snapshots are deliberately refreshed.
3. **Property tests** — `qa/contracts/property.spec.ts` exercises generators and near-misses to ensure allowed ranges stay stable.

## Updating Schemas Safely
1. Modify the JSON Schema under `schemas/` and bump the `$id` if the change is breaking.
2. Run:
   ```bash
  npm run --workspaces=false codegen
   npm run typecheck
   npm run test -- --run qa/contracts
   ```
3. Update snapshots:
   - Edit the relevant file(s) under `qa/contracts/snapshots/` to reflect the new contract.
   - Note the change in `qa/fixtures/CHANGELOG.md` (include schema ID and task/issue ID).
4. Regenerate seed data if needed (`./qa/env/seed.sh`).
5. Include doc updates/ADR notes describing the contract change and migration expectations.

## Review Checklist
- [ ] Schema `$id` bumped for breaking changes (or noted as additive).
- [ ] Codegen artifacts updated and `npm run codegen:check` passes.
- [ ] Snapshot JSON updated with reviewer sign-off (diff should be small and intentional).
- [ ] Property tests still pass (consider extending generators to cover new branches).
- [ ] Docs and downstream consumers notified (update `docs/QA_DATA.md`, service READMEs, etc.).

Treat snapshots as living documentation: every drift should go through review, not show up as an accidental regression in CI.
