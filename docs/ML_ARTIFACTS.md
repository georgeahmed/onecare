# ML Artifact Lifecycle

This service keeps model bundles under `services-py/models`. Each artifact is stored with semantic
versioning so we can track upgrades and roll back safely.

## Naming Convention
- Binary: `<model>-v<semver>.bin` (pickle payload).
- Metadata: `<model>-v<semver>.meta.json` (JSON describing calibration, schema, etc.).
- Pointer: `<model>-latest.bin` and `<model>-latest.meta.json` (symlink; falls back to a copy on
  platforms that cannot create symlinks).

Example:
```
services-py/models/
├─ acuity-v0.1.0.bin
├─ acuity-v0.1.0.meta.json
├─ acuity-latest.bin  -> acuity-v0.1.0.bin
└─ acuity-latest.meta.json -> acuity-v0.1.0.meta.json
```

## Saving an Artifact
Use `common.model_io.save_model_artifact`:
```python
from common.model_io import save_model_artifact

save_model_artifact(
    "acuity",
    "0.1.0",
    artifact_payload,
    metadata_payload,
)
```
This writes the versioned files and refreshes the latest pointer.

## Loading an Artifact
Use `common.model_io.load_model_artifact`:
```python
from common.model_io import load_model_artifact

bundle = load_model_artifact("acuity")  # latest
# bundle.artifact -> pickled payload
# bundle.metadata["modelVersion"] -> resolved version string
```
Pass `version="0.1.0"` to target a specific release. Environment overrides for the FastAPI
service:
- `SAFETY_GATE_ACUITY_MODEL_VERSION` = preferred version
- `SAFETY_GATE_MODELS_DIR` = alternate directory root

Explicit `SAFETY_GATE_ACUITY_MODEL_PATH` / `SAFETY_GATE_ACUITY_META_PATH` still work for
legacy deployments.

## Version Bump Workflow
1. Run (or update) the training routine:
   ```
   python3 services-py/train_acuity.py
   ```
   Override the version with `export ACUITY_MODEL_VERSION=0.2.0` when needed.
2. Commit the new `acuity-v<version>.bin` + `.meta.json` and ensure `acuity-latest.*` resolves to
   the same version.
3. Update tests or configuration if consumers should pin to the new version.
4. Document behavioural changes as part of release notes/ADR if applicable.
