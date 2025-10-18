Booking Service

Purpose
- Local and federated booking via GP Connect; write-back to FHIR.

State Flow
- Search → Selected → Booked → WrittenBack → Confirmed

Metrics & Telemetry
- `booking_http_duration_ms` — histogram of end-to-end handler latency tagged by route/outcome.
- `booking_http_requests_total` — counter of request volume with HTTP status classification.
- `booking_http_backpressure_total` — counter incremented whenever concurrency limits trigger 429 responses.
- `gp_connect_*` metrics reflect upstream search/create latency, success, conflict, and error rates.

Performance Baselines
- p50 HTTP response < 500 ms; p95 < 1500 ms under normal load.
- Backpressure surfaces via 429 response envelope and `booking_http_backpressure_total` spikes.
- Appointment publish retries at most twice before a DLQ hand-off (`booking.appointment.created.dlq`).

Privacy Guardrails
- Logs avoid raw patient identifiers; idempotency keys and queue/audit notifications contain hashed patient fingerprints.
- DLQ payloads store only appointment and slot references with failure metadata.
