Codegen

Purpose
- Generate strongly-typed contracts from `schemas/` to TypeScript and Python.

Recommended tools
- TypeScript: json-schema-to-typescript (or quicktype)
- Python: datamodel-code-generator (pydantic v2)

Usage (conceptual)
- npm run codegen (runs scripts/codegen/generate.js)

Note
- Current repo includes minimal hand-generated types under `packages/events/src/contracts` and `services-py/common/contracts/models.py`. Replace them with tool-generated code in future.

