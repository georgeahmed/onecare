Team Workflow & Status

Engineer Files
- Each engineer has a file under `team/<group>/engineer-XX.md` with:
  - Status: planned | in-progress | blocked | needs-fixes | stable
  - Progress: N%
  - Dependencies: other engineers/groups
  - Tasks: checkbox list (`- [ ] task` or `- [x] task`). Add `(bug)` or `needs-fix` to flag issues.
  - Start Here: links to Algorithm.md, schemas, and code paths

Commands
- Show status: `make team-status`
- Update Progress/Status automatically from Tasks: `make team-status-write`
- JSON report: `make team-status-json`
- Generate GitHub issues from Tasks: `make team-issues`
  - Requires `GITHUB_REPOSITORY=owner/repo` and `gh` CLI (optional). Otherwise, script writes `var/gh_issues.sh` to run manually.
- Mark task done/bug/blocked/fix (auto-updates Progress/Status for one engineer):
  - `make engineer-done ENGINEER=backend/engineer-01 TASK='Normalize to FHIR'`
  - `make engineer-bug ENGINEER=backend/engineer-01 TASK='Enrichment hooks'`
  - `make engineer-blocked ENGINEER=integrations/engineer-01 TASK='OIDC client'`
  - `make engineer-fix ENGINEER=backend/engineer-01 TASK='Enrichment hooks'`

Per‑Engineer Loop (Recommended)
- Implement the task in your file (use Start Here links).
- If you touched schemas: `npm run codegen` (or `RUN_PY=1 npm run codegen`).
- Verify locally:
  - TS: `npm run build && npm run typecheck && npm run test`
  - Py (if relevant): `pytest -q services-py/tests`
- If runtime change: `docker-compose up --build` and smoke test.
- Update status:
  - `make engineer-done ENGINEER=<path> TASK='<substring>'`
  - `make team-status-write`
- If blocked/bug: use `engineer-blocked` or `engineer-bug` and write status.

One‑liner helper
- `make engineer-loop ENGINEER=<path> TASK='<substring>' SCHEMAS=1 PY=1 RUNTIME=1 SMOKE=1`
  - Runs codegen (TS), TS build/typecheck/lint/test, Python tests, brings up stack, smokes `/safety-check`, marks task done, writes status.

Pre‑commit Hook
- Automatically runs local CI and syncs team status on commit.
- Enabled via Husky (installed on npm ci): see `.husky/pre-commit`.
- If not triggered, run `npm run prepare` once to install hooks.

Conventions
- Keep tasks small (1–3 days). Check them off as you complete.
- Update Status at the end of your day or when you hand off.
- Use Dependencies to coordinate — list who you need to sync with.
