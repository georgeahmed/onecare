Schemas & Contracts

Source of truth: `schemas/` JSON Schemas.

Generated
- TypeScript: `packages/events/src/contracts/*` via `json-schema-to-typescript`
- Python: `services-py/common/contracts/models.py` via `datamodel-code-generator`

Run locally
- TS: npm run --workspaces=false codegen
- Py: RUN_PY=1 npm run --workspaces=false codegen (requires `datamodel-code-generator` installed)

CI
- Codegen job runs on PRs to sync generated files and commit changes when needed.
