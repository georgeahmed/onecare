# NetworkPolicy Templates

`default-egress-deny` applies a namespace-wide default egress deny stance. Extend the manifest with explicit `to` blocks per workload so only approved hosts are reachable.

`allow-egress-core` demonstrates allowing orchestrator traffic to NATS and the observability stack. Duplicate the policy per workload and keep the allowed host list short. Record any deviations in `docs/SECURITY.md`.
