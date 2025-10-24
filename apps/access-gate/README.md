Access Front Door & Safety Gate

Purpose
- Keep portal open within core hours; apply transformer-based urgent diversion.

State Flow (Portal)
- HoursChecked → PortalStateEnsured

State Flow (Safety)
- Analyzed → Diverted | Proceed

Operations
- Liveness: GET `/healthz` returns `ok`.
- Readiness: GET `/readyz` returns 200 once the portal scheduler has completed an initial run and is healthy.
- Shutdown: SIGTERM/SIGINT drains portal ticks (10s budget) before exit; emits metrics `shutdown.start` and `shutdown.timeout`.
