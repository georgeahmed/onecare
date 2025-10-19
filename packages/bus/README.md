Bus (Message Broker Abstraction)

Purpose
- Provide a small interface for publishing/subscribing to topics.
- Keep implementation pluggable (memory or external broker like NATS/Kafka).

Usage
- `getBus()` selects an implementation based on configuration. Passing an explicit `connection` always returns a `NatsBus`, even when `BUS_IMPL=memory`, so integration tests can inject a pre-wired JetStream connection.
- Wrap the bus with `withMessageGuards()` to enforce envelope contracts, correlation headers, and optional idempotency without blocking messages that lack a stable identifier.
