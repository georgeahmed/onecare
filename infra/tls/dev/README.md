# Dev TLS Artifacts

Run `scripts/ops/generate-dev-certs.sh` to generate the self-signed CA, NATS server certificate, and mutual TLS client certificate used by the docker-compose stack. The private key artifacts (`*.key`, `.csr`, `.srl`) are intentionally excluded from source control—run the script locally before starting services so the required files exist.

Outputs:
- `ca.crt` / `ca.key`
- `nats.crt` / `nats.key`
- `client.crt` / `client.key`

Pass `--force` to regenerate if the certificates expire. These files are for local development only—production certificates must come from the managed secrets pipeline.
