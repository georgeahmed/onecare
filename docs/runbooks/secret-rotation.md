# Secret Rotation Runbook

Purpose: provide a repeatable, auditable process for rotating Vault-backed credentials and sealed secrets across environments.

## Pre-Rotation Checklist

- [ ] Confirm the secret path (`kv/<domain>/<service>/<secret>`) and consumer services.
- [ ] Ensure dual credential support (new + old) is available or schedule coordinated downtime.
- [ ] Update the change ticket with scope, environment, and rollback owner.
- [ ] For Kubernetes workloads, fetch the current sealed secret manifest to use as a baseline.

## Staging Rehearsal

1. Generate the new secret value (e.g., API key, password). Store it in the secure scratchpad (1Password vault).
2. Write the secret to Vault staging path: `vault kv put kv/<domain>/<service>/<secret> value=<NEW>`.
3. Render a sealed secret (if required):
   ```sh
   kubectl --namespace operations create secret generic my-secret --from-literal=value=<NEW> --dry-run=client -o yaml \
     | kubeseal --controller-namespace sealed-secrets --controller-name sealed-secrets \
     > infra/secrets/sealedsecret-my-secret.yaml
   ```
4. Commit and apply the manifest: `kubectl apply -f infra/secrets/sealedsecret-my-secret.yaml`.
5. Restart the target deployment or let Vault Agent reload (`pkill -HUP vault-agent`).
6. Validate:
   - Kubernetes pod logs show successful template reload.
   - Service readiness probe passes.
   - Smoke tests (HTTP endpoints / integration tests) succeed.
7. Update the change ticket with validation evidence.

## Production Rotation

1. Repeat steps 1–6 using the production Vault path and sealed secret scope.
2. Schedule a short change window and notify on-call.
3. After deployment, monitor:
   - Readiness probes.
   - Key business metrics (latency, error rate).
   - Secrets-specific telemetry (e.g., authentication success counters).
4. Once stable for 10 minutes, revoke the previous credential in Vault (`vault kv delete` or upstream portal).
5. Purge any local copies from scratchpads and shell history.

## Rollback Procedure

1. Restore the previous secret in Vault (recorded in change ticket).
2. Re-apply the prior sealed secret manifest (kept in git history).
3. Trigger redeploy/pod restart and verify service health.
4. Document rollback reason and schedule follow-up.

## Audit Logging

- Record rotation metadata (secret path, operator, timestamp, environment, validation steps) in the security change log.
- Attach the git commit SHA containing updated sealed secrets.
- Ensure Vault audit log entries exist for the write/delete operations; export them to the security archive.

## Automation Hooks

- Future work: create `scripts/ops/vault-rotate.sh` to streamline steps 1–4.
- Evaluate using Vault `leases` and dynamic secrets where providers support it, reducing manual rotation burden.
