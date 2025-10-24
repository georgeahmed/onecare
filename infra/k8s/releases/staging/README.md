# Staging Release Manifests

This directory should contain the rendered Kubernetes manifests (or a `kustomization.yaml`) for the staging environment. The CI/CD pipeline applies everything here via `scripts/ci/deploy.sh staging`.

Populate this folder with environment-specific overlays that reference the shared base once the Kubernetes baseline (SRE-01.16) lands.
