# Safety Gate Supply-Chain Controls

- Python dependencies pinned with explicit versions (`services-py/pyproject.toml`).
- `pip-audit` runs in CI to surface CVEs before merging.
- Model bundles are served locally; remote downloads disabled unless `SAFETY_GATE_ALLOW_REMOTE_MODELS=1`.
- Dataset manifest (`services-py/safety_gate_service/data/manifest.json`) records SHA-256 checksums for golden set artefacts.
- For new releases, regenerate the evaluation metrics JSON and attach to the deployment checklist.
