# Secrets Integration Reference

This directory holds non-sensitive scaffolding for the secrets workflow:

- Vault Agent configuration snippets used to render secrets into pods.
- SealedSecret examples that demonstrate how to safely store bootstrap data in git.
- Environment-specific notes on secret paths and rotation expectations.

## Vault Agent Sidecar

- `vault-agent-config.hcl` configures authentication (Kubernetes service account), template rendering, and automatic reload hooks.
- Mount the config as a ConfigMap and start the agent alongside the workload container. Example Helm values:
  ```yaml
  vaultAgent:
    enabled: true
    configMap: vault-agent-config
    image: hashicorp/vault:1.16.2
    resources:
      limits:
        cpu: 50m
        memory: 64Mi
  ```
- Templates write secrets into `/vault/secrets/<file>`; point your application to that path or use an init container to populate environment variables.

## Sealed Secrets

- `sealedsecret-example.yaml` illustrates encrypting a bootstrap token or API key using `kubeseal`.
- Run `kubeseal --controller-name sealed-secrets --controller-namespace sealed-secrets --format yaml < secret.yaml > sealedsecret-example.yaml`.
- Keep sealed secrets environment-scoped (e.g., `sealedsecret-staging.yaml` vs `sealedsecret-prod.yaml`) and avoid sharing keys across environments.

## Operational Notes

- Never store plaintext credentials or Vault root tokens in this directory.
- Reference the rotation procedure in `docs/runbooks/secret-rotation.md` when updating secrets.
- Ensure CI/CD pipelines have permission to decrypt and apply sealed secrets (restricted service account).
- Periodically verify that sealed secret certificates are valid; rotate them ahead of expiry to keep GitOps workflows functional.
