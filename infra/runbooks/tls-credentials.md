TLS & Credentials Runbook

Purpose
- Standardize provisioning and rotation of TLS materials and credentials for outbound clients (GP Connect/CPCS/FHIR) and bus connections.

Checklist
- Certificates
  - Obtain service/client certificates from the authority (sandbox or production).
  - Store private keys and certs in secrets manager; mount as files/env in deployment.
  - Maintain truststore/CA bundle for outbound TLS verification.
- Configuration
  - Expose env vars for key paths/passwords (e.g., TLS_KEY, TLS_CERT, TLS_CA).
  - Enable hostname verification and strict TLS versions (TLS1.2+).
- Rotation
  - Track expiry; rotate proactively and test canary pods with new certs.
- Access Control
  - Limit secret scope per service/namespace; audit access.

Validation
- Connectivity tests to endpoints; verify certificate chain; confirm strict TLS and hostname checks.

Docker Compose example (mounting certs)
```yaml
services:
  booking:
    build:
      context: .
      dockerfile: apps/booking/Dockerfile
    environment:
      - TLS_KEY=/certs/client.key
      - TLS_CERT=/certs/client.crt
      - TLS_CA=/certs/ca.crt
    volumes:
      - ./var/certs:/certs:ro
```

Kubernetes Secret example
```yaml
apiVersion: v1
kind: Secret
metadata:
  name: booking-tls
type: kubernetes.io/tls
data:
  tls.crt: <base64>
  tls.key: <base64>
```
