## Local Secret Handling

- Generate NHS sandbox tokens on demand via `scripts/dev/fetch-nhs-token.sh`; avoid persisting real access, refresh, or id tokens in the repo.
- Store real credentials (OAuth clients, JWKS keys, PEMs) in a secure local vault or `var/private/` directory outside git. Copy the sample names (e.g. `mockjwks.json`) there if your tooling expects a fixed path.
- Never commit private keys. If you need a JWKS/Pem pair for local tests, generate one with `openssl` (example: `openssl genpkey -algorithm RSA -out var/private/test-1.pem -pkeyopt rsa_keygen_bits:4096`) and convert to JWKS with a local script; keep both files git-ignored.
- Use placeholder fixtures or `.example.json` files in git when the code requires a template. Populate them with obvious non-secrets (e.g. `"client_secret": "CHANGE-ME"`) so automated secret scanners pass.
- Before committing, run the pre-commit hooks (`pre-commit run --all-files`) to catch accidental secret additions early.
