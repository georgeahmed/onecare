Event Bus Topics

Align with Algorithm.md 0.3 Event Bus.

- ingest.*
- triage.*
- scribe.*
- portal.*
- telephony.*
- tasks.*
- booking.*
- booking.appointment.created.dlq (DLQ for booking publish failures)
- referral.*
- broker.*
- pharmacy.*
- analytics.*
- billing.*
- audit.*

See `packages/events/src/topics.ts` for convenient constants.

Local Broker (dev)
- Using NATS (docker compose service `nats`) for local pub/sub experiments.
- Replace with Kafka/SQS in production per ops decision.
