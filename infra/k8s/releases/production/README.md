# Production Release Manifests

This directory hosts the production-rendered manifests (or a `kustomization.yaml`) that the CD workflow applies. Keep sensitive values in the secrets manager; reference them via `SealedSecret`/external providers instead of committing inline secrets.

Populate this folder once the shared Kubernetes baseline is ready. The deployment script will skip if no manifests are present.
