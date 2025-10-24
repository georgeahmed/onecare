.PHONY: install build typecheck lint format test codegen codegen-check py-test py-safety py-scribe docker-up docker-down demo-docker demo-local team-status team-status-write team-status-json team-issues engineer-done engineer-bug engineer-blocked engineer-fix engineer-loop ci-local stack-up stack-smoke docs-nav perf-smoke
 .PHONY: dev-run dev-stop

install:
	npm ci

build:
	npm run build

typecheck:
	npm run typecheck

lint:
	npm run lint

format:
	npm run format

test:
	npm run test

codegen:
	npm run --workspaces=false codegen

codegen-check:
	npm run codegen:check

py-test:
	./services-py/run-tests.sh

py-safety:
	PYTHONPATH=services-py services-py/.venv/bin/uvicorn safety_gate_service.main:app --reload --port 8081

py-scribe:
	PYTHONPATH=services-py services-py/.venv/bin/uvicorn scribe_service.main:app --reload --port 8082

docker-up:
	docker-compose up --build

docker-down:
	docker-compose down -v

demo-docker:
	@echo "[demo] Starting docker compose..."
	docker-compose up -d --build
	@echo "[demo] Waiting for services..."
	@bash -c 'until curl -sf http://localhost:8081/docs >/dev/null; do sleep 0.5; done'
	@bash -c 'until curl -sf http://localhost:3001/health >/dev/null; do sleep 0.5; done'
	@echo "[demo] Calling orchestrator /safety-check"
	@curl -s -X POST http://localhost:3001/safety-check \
	  -H 'content-type: application/json' \
	  -H 'authorization: Bearer dev-token' \
	  -H 'x-actor-type: patient' \
	  -H 'x-actor-id: demo-patient' \
	  -H 'x-request-id: demo-docker-req' \
	  -H 'x-auth-scope: submit triage:submit' \
	  -d '{"practiceId":"p1","patient":{"id":"abc"},"narrative":"I have chest pain","channel":"web"}' | tee /dev/stderr
	@echo "\n[demo] Done. Stop stack with: make docker-down"

demo-local:
	@echo "[demo] Building orchestrator..."
	npm -w @onecare/app-orchestrator run build --silent
	@echo "[demo] Starting safety gate (requires uvicorn/fastapi installed)..."
	@bash -c 'PYTHONPATH=services-py services-py/.venv/bin/uvicorn safety_gate_service.main:app --port 8081 --log-level warning & echo $$! > .pid_safety'
	@bash -c 'until curl -sf http://localhost:8081/docs >/dev/null; do sleep 0.5; done'
	@echo "[demo] Starting orchestrator..."
	@bash -c 'PORT=3001 PRACTICE_ID=demo PY_SAFETY_GATE_URL=http://localhost:8081 PY_SAFETY_GATE_HOST_ALLOWLIST=localhost,127.0.0.1 BUS_IMPL=memory node apps/orchestrator/dist/index.js & echo $$! > .pid_orch'
	@bash -c 'until curl -sf http://localhost:3001/health >/dev/null; do sleep 0.5; done'
	@echo "[demo] Calling orchestrator /safety-check"
	@curl -s -X POST http://localhost:3001/safety-check \
	  -H 'content-type: application/json' \
	  -H 'authorization: Bearer dev-token' \
	  -H 'x-actor-type: patient' \
	  -H 'x-actor-id: demo-patient' \
	  -H 'x-request-id: demo-local-req' \
	  -H 'x-auth-scope: submit triage:submit' \
	  -d '{"practiceId":"p1","patient":{"id":"abc"},"narrative":"mild headache","channel":"web"}' | tee /dev/stderr
	@echo "\n[demo] Cleaning up..."
	-@bash -c 'kill $$(cat .pid_orch 2>/dev/null) 2>/dev/null || true; rm -f .pid_orch'
	-@bash -c 'kill $$(cat .pid_safety 2>/dev/null) 2>/dev/null || true; rm -f .pid_safety'
	@echo "[demo] Done."

# Dev: start Safety Gate + Orchestrator and keep them running
dev-run:
	@echo "[dev] Building orchestrator..."
	npm -w @onecare/app-orchestrator run build --silent
	@echo "[dev] Starting Safety Gate..."
	@bash -c 'PYTHONPATH=services-py services-py/.venv/bin/uvicorn safety_gate_service.main:app --port 8081 --log-level warning & echo $$! > .pid_safety'
	@scripts/dev/wait-for-ready.sh \
	  --name "Safety Gate" \
	  --url http://localhost:8081/docs \
	  --pid-file .pid_safety \
	  || { \
	    make -s dev-stop; \
	    exit 1; \
	  }
	@echo "[dev] Starting Orchestrator..."
	@bash -c 'set -a; [ -f ./.env.dev ] && source ./.env.dev; [ -f ./.env ] && source ./.env; set +a; \
	  export PORT=$${PORT:-3001}; \
	  export PRACTICE_ID=$${PRACTICE_ID:-demo}; \
	  export PY_SAFETY_GATE_URL=$${PY_SAFETY_GATE_URL:-http://localhost:8081}; \
	  export PY_SAFETY_GATE_HOST_ALLOWLIST=$${PY_SAFETY_GATE_HOST_ALLOWLIST:-localhost,127.0.0.1}; \
	  export BUS_IMPL=$${BUS_IMPL:-memory}; \
	  export FHIR_BASE_URL="$${FHIR_BASE_URL:-https://hapi.fhir.org/baseR4}"; \
	  node apps/orchestrator/dist/index.js & echo $$! > .pid_orch'
	@scripts/dev/wait-for-ready.sh \
	  --name "Orchestrator" \
	  --url http://localhost:3001/health \
	  --pid-file .pid_orch \
	  || { \
	    make -s dev-stop; \
	    exit 1; \
	  }
	@echo "[dev] Up. Try: curl -s http://localhost:3001/health && echo" 
	@echo "[dev] Stop with: make dev-stop"

dev-stop:
	@echo "[dev] Stopping services..."
	-@bash -c 'kill $$(cat .pid_orch 2>/dev/null) 2>/dev/null || true; rm -f .pid_orch'
	-@bash -c 'kill $$(cat .pid_safety 2>/dev/null) 2>/dev/null || true; rm -f .pid_safety'
	@echo "[dev] Stopped."

ci-local:
	@echo "[ci] TS build/typecheck/lint/test"
	npm run build && npm run typecheck && npm run lint && npm run test
	@echo "[ci] Py tests"
	make -s py-test || true

.PHONY: perf-orchestrator
perf-orchestrator:
	bash scripts/perf/orchestrator.sh 10

.PHONY: perf-smoke
perf-smoke:
	@echo "[perf] safety-check smoke (k6)"
	k6 run qa/perf/k6_safety_check.js
	@if [ -z "$${BOOKING_BASE_URL}" ]; then \
	  echo "BOOKING_BASE_URL must be set (e.g., http://localhost:4000)"; \
	  exit 1; \
	fi
	@echo "[perf] booking smoke (newman)"
	newman run qa/perf/newman_collection.json \
	  --reporters cli \
	  --env-var baseUrl=$${BOOKING_BASE_URL} \
	  --env-var correlationPrefix=$${BOOKING_CORRELATION_PREFIX:-perf-smoke} \
	  --env-var serviceType=$${BOOKING_SERVICE_TYPE:-GP} \
	  --env-var location=$${BOOKING_LOCATION:-org-demo}

stack-up:
	docker-compose up -d --build
	@bash -c 'until curl -sf http://localhost:3001/health >/dev/null; do sleep 0.5; done'
	@echo "[stack] up and healthy"

stack-smoke:
	@echo "[smoke] /safety-check"
	curl -s -X POST http://localhost:3001/safety-check \
	  -H 'content-type: application/json' \
	  -H 'authorization: Bearer dev-token' \
	  -H 'x-actor-type: patient' \
	  -H 'x-actor-id: demo-patient' \
	  -H 'x-request-id: stack-smoke-req' \
	  -H 'x-auth-scope: submit triage:submit' \
	  -d '{"practiceId":"p1","patient":{"id":"abc"},"narrative":"mild headache","channel":"web"}' || true

engineer-loop:
	@[ -n "$(ENGINEER)" ] || (echo "Usage: make engineer-loop ENGINEER=backend/engineer-01 TASK='substring' [SCHEMAS=1] [PY=1] [RUNTIME=1] [SMOKE=1]" && exit 1)
	bash scripts/team/engineer_loop.sh --engineer $(ENGINEER) --task "$(TASK)" $(if $(SCHEMAS),--schemas,) $(if $(PY),--py,) $(if $(RUNTIME),--runtime,) $(if $(SMOKE),--smoke,)

docs-nav:
	node scripts/docs/add_nav.js

.PHONY: agent-closeout
agent-closeout:
	@echo "[agent] Codegen → typecheck → test → team status write"
	npm run --workspaces=false codegen && npm run typecheck && npm run test && node scripts/team/status.js --write

team-status:
	node scripts/team/status.js

team-status-write:
	node scripts/team/status.js --write
	@# Auto-commit and push team status to dev branch
	@which git >/dev/null 2>&1 && ( \
	  git add -A && \
	  git commit -m "chore(team): update team status [skip ci]" >/dev/null 2>&1 || true; \
	  git push origin dev >/dev/null 2>&1 || true \
	) || true

team-status-json:
	node scripts/team/status.js --json

team-issues:
	node scripts/team/generate_issues.js

.PHONY: check-task-cards
check-task-cards:
	node scripts/ci/check_task_cards.js

engineer-done:
	@[ -n "$(ENGINEER)" ] || (echo "Usage: make ENGINEER=backend/engineer-01 TASK='substring' engineer-done" && exit 1)
	node scripts/team/update_task.js --engineer $(ENGINEER) --action done --task "$(TASK)"

engineer-bug:
	@[ -n "$(ENGINEER)" ] || (echo "Usage: make ENGINEER=backend/engineer-01 TASK='substring' engineer-bug" && exit 1)
	node scripts/team/update_task.js --engineer $(ENGINEER) --action bug --task "$(TASK)"

engineer-blocked:
	@[ -n "$(ENGINEER)" ] || (echo "Usage: make ENGINEER=backend/engineer-01 TASK='substring' engineer-blocked" && exit 1)
	node scripts/team/update_task.js --engineer $(ENGINEER) --action blocked --task "$(TASK)"

engineer-fix:
	@[ -n "$(ENGINEER)" ] || (echo "Usage: make ENGINEER=backend/engineer-01 TASK='substring' engineer-fix" && exit 1)
	node scripts/team/update_task.js --engineer $(ENGINEER) --action fix --task "$(TASK)"
