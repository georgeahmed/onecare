Subjects, Streams, and ACLs (Event Bus)

Purpose
- Define and provision subjects/streams and access controls for topics and DLQ across environments.

Topics/Subjects
- Create subjects/streams for primary topics (e.g., triage.*, booking.*, pharmacy.*, ics.*) and DLQ subjects (e.g., booking.*.dlq).
- Set per-subject retention (time/size) and max message size.

ACLs
- Apply subject-level permissions (publish/subscribe) per service account.
- Separate DLQ read access for operators; restrict write access.

Ordering & Partitioning
- Define partitioning/queue groups by key (tenant/patient/task) to preserve ordering where required.

Validation
- Smoke publish/subscribe; confirm ACL enforcement; verify DLQ routing and retention with test messages.

NATS (dev) Examples
- Using the nats CLI (or nats-box container) with JetStream enabled (docker-compose provides `nats: -js`).

1) Create streams for topics and DLQ
```
# Primary topics (wildcards allowed)
nats stream add triage --subjects="triage.*" --storage=file --retention=limits --max-msgs=-1 --max-bytes=1GB --max-age=72h
nats stream add booking --subjects="booking.*" --storage=file --retention=limits --max-msgs=-1 --max-bytes=1GB --max-age=72h

# DLQ streams
nats stream add dlq --subjects="*.dlq" --storage=file --retention=limits --max-bytes=1GB --max-age=168h
```

2) Create consumer (durable) with ack policy
```
nats consumer add booking durable-booking --ack --filter="booking.appointmentCreated" --deliver=all
```

3) Publish test message and verify delivery
```
nats pub booking.appointmentCreated '{"id":"t1","payload":{}}'
nats sub booking.appointmentCreated -n 1
```

4) ACLs
- Configure NATS account/users with subject restrictions in server config (beyond scope of this doc). For local dev, prefer trusted users.

Kafka (alt)
- Use `kafka-topics.sh` to create topics (`triage.input`, `booking.appointmentCreated`, `*.dlq`) and apply retention/partitions policies.
