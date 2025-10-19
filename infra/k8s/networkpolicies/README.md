# NetworkPolicy Templates

`egress-deny.yaml` applies a namespace-wide default egress deny stance. Extend the manifest with explicit `to` blocks per workload so only approved hosts are reachable.

`ingress-deny.yaml` is an opt-in default-deny ingress policy; apply per namespace and then add service-specific exceptions.

`egress-allowlist-example.yaml` demonstrates allowing booking pods to reach the observability stack and GP Connect egress subnet. Duplicate per workload and adjust CIDRs/ports.

Document all exceptions and review quarterly as part of the network security posture described in `docs/SECURITY.md`.
