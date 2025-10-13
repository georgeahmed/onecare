ADR: Orchestrator Architecture (State Machine, Ports)

Status: Proposed
Date: 2025-10-11

Context
- We need a clear, testable orchestrator with strong separation of concerns, contract-first validation, and resilience.

Decision
- Model orchestrator as a state machine (@onecare/statekit). Keep business decisions in `application/*`; perform side-effects via ports/adapters.
- Use Error Envelopes for HTTP; EventEnvelope for bus payloads with `correlationId`.
- Enforce time budgets and backpressure; idempotency at ingress; privacy-by-default.

Consequences
- Easier to test transitions; adapters can be mocked. Clear timeouts/retries. Predictable envelopes.

