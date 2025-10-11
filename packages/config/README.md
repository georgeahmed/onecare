Config Loader
=============

`@onecare/config` loads layered YAML starting from the global defaults (`config/nhs_gp_defaults.yaml`) and applying:

1. `config/global.yaml`
2. `config/ics/<ics>.yaml`
3. `config/pcn/<pcn>.yaml`
4. `config/practices/<practiceId>.yaml`
5. Runtime overrides passed to `loadConfig()`

Each layer can opt into additive array merges by using the `__meta.arrayMerge` hints (see current YAMLs for examples). Practices should specify their PCN (and optionally ICS) in `__meta` so lineage can be tracked downstream.

Safety guardrails (timeouts, thresholds, TTLs) are clamped to configured floors/ceilings and lineage metadata is exposed via `_lineage` on the resolved config.
