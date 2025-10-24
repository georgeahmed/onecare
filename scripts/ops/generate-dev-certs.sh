#!/usr/bin/env bash
set -euo pipefail

show_help() {
  cat <<'USAGE'
Usage: scripts/ops/generate-dev-certs.sh [--out DIR] [--force]

Generates a self-signed CA plus NATS server/client certificates for the local dev stack.
Outputs files (ca.crt/key, nats.{crt,key}, client.{crt,key}) into DIR (default: infra/tls/dev).
USAGE
}

OUTPUT_DIR="infra/tls/dev"
FORCE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --out|-o)
      if [[ $# -lt 2 ]]; then
        echo "ERROR: missing argument for $1" >&2
        exit 1
      fi
      OUTPUT_DIR="$2"
      shift 2
      ;;
    --force|-f)
      FORCE=1
      shift
      ;;
    --help|-h)
      show_help
      exit 0
      ;;
    *)
      echo "ERROR: unknown argument '$1'" >&2
      show_help >&2
      exit 1
      ;;
  esac
done

OUTPUT_DIR="${OUTPUT_DIR%/}"
mkdir -p "$OUTPUT_DIR"

if [[ $FORCE -eq 1 ]]; then
  find "$OUTPUT_DIR" -maxdepth 1 \( -name '*.crt' -o -name '*.key' -o -name '*.csr' -o -name '*.srl' \) -type f -print0 | xargs -0 -r rm -f
fi

required_files=("ca.crt" "ca.key" "nats.crt" "nats.key" "client.crt" "client.key")
missing=0
for file in "${required_files[@]}"; do
  if [[ -e "$OUTPUT_DIR/$file" ]]; then
    continue
  fi
  missing=1
  break
done

if [[ $missing -eq 0 ]]; then
  echo "TLS materials already exist in $OUTPUT_DIR. Use --force to overwrite." >&2
  exit 1
fi

openssl genrsa -out "$OUTPUT_DIR/ca.key" 4096
openssl req -x509 -new -nodes -key "$OUTPUT_DIR/ca.key" \
  -sha256 -days 825 -out "$OUTPUT_DIR/ca.crt" \
  -subj "/CN=OneCare Dev Root CA"

openssl genrsa -out "$OUTPUT_DIR/nats.key" 4096
openssl req -new -key "$OUTPUT_DIR/nats.key" -out "$OUTPUT_DIR/nats.csr" \
  -subj "/CN=nats.onecare.internal"
cat > "$OUTPUT_DIR/nats.ext" <<'EXT'
subjectAltName = @alt_names
extendedKeyUsage = serverAuth
[alt_names]
DNS.1 = nats
DNS.2 = localhost
IP.1 = 127.0.0.1
EXT
openssl x509 -req -in "$OUTPUT_DIR/nats.csr" -CA "$OUTPUT_DIR/ca.crt" -CAkey "$OUTPUT_DIR/ca.key" \
  -CAcreateserial -out "$OUTPUT_DIR/nats.crt" -days 365 -sha256 -extfile "$OUTPUT_DIR/nats.ext"
rm -f "$OUTPUT_DIR/nats.csr" "$OUTPUT_DIR/nats.ext"

openssl genrsa -out "$OUTPUT_DIR/client.key" 4096
openssl req -new -key "$OUTPUT_DIR/client.key" -out "$OUTPUT_DIR/client.csr" \
  -subj "/CN=onecare-dev-client"
cat > "$OUTPUT_DIR/client.ext" <<'EXT'
extendedKeyUsage = clientAuth
keyUsage = digitalSignature
subjectAltName = URI:spiffe://onecare/dev/client
EXT
openssl x509 -req -in "$OUTPUT_DIR/client.csr" -CA "$OUTPUT_DIR/ca.crt" -CAkey "$OUTPUT_DIR/ca.key" \
  -CAcreateserial -out "$OUTPUT_DIR/client.crt" -days 365 -sha256 -extfile "$OUTPUT_DIR/client.ext"
rm -f "$OUTPUT_DIR/client.csr" "$OUTPUT_DIR/client.ext"

chmod 600 "$OUTPUT_DIR"/*.key

cat <<SUMMARY
✅ Generated development TLS materials in $OUTPUT_DIR:
  - ca.crt / ca.key (root CA)
  - nats.crt / nats.key (server)
  - client.crt / client.key (mutual TLS client)

Add the following volume to docker-compose services that need TLS access:
  - ./infra/tls/dev:/etc/onecare/tls:ro
SUMMARY
