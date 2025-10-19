default: 
    @just --list

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
    npm run codegen

codegen-check:
    npm run codegen:check

py-test:
    python -m venv .venv && . .venv/bin/activate && pip install -U pip && pip install fastapi uvicorn pydantic pytest httpx && pytest -q services-py/tests

py-safety:
    uvicorn services-py/safety_gate_service/main:app --reload --port 8081

py-scribe:
    uvicorn services-py/scribe_service/main:app --reload --port 8082

docker-up:
    docker-compose up --build

docker-down:
    docker-compose down -v

demo-docker:
    docker-compose up -d --build
    bash -c 'until curl -sf http://localhost:8081/docs >/dev/null; do sleep 0.5; done'
    bash -c 'until curl -sf http://localhost:3001/health >/dev/null; do sleep 0.5; done'
    curl -s -X POST http://localhost:3001/safety-check \
      -H 'content-type: application/json' \
      -H 'authorization: Bearer dev-token' \
      -H 'x-actor-type: patient' \
      -H 'x-actor-id: demo-patient' \
      -H 'x-request-id: just-demo-docker' \
      -H 'x-auth-scope: submit triage:submit' \
      -d '{"practiceId":"p1","patient":{"id":"abc"},"narrative":"I have chest pain","channel":"web"}'

demo-local:
    npm -w @onecare/app-orchestrator run build --silent
    bash -c 'uvicorn services-py/safety_gate_service/main:app --port 8081 --log-level warning & echo $$! > .pid_safety'
    bash -c 'until curl -sf http://localhost:8081/docs >/dev/null; do sleep 0.5; done'
    bash -c 'PORT=3001 PY_SAFETY_GATE_URL=http://localhost:8081 PY_SAFETY_GATE_HOST_ALLOWLIST=localhost,127.0.0.1 node apps/orchestrator/dist/index.js & echo $$! > .pid_orch'
    bash -c 'until curl -sf http://localhost:3001/health >/dev/null; do sleep 0.5; done'
    curl -s -X POST http://localhost:3001/safety-check \
      -H 'content-type: application/json' \
      -H 'authorization: Bearer dev-token' \
      -H 'x-actor-type: patient' \
      -H 'x-actor-id: demo-patient' \
      -H 'x-request-id: just-demo-local' \
      -H 'x-auth-scope: submit triage:submit' \
      -d '{"practiceId":"p1","patient":{"id":"abc"},"narrative":"mild headache","channel":"web"}'
    bash -c 'kill $$(cat .pid_orch 2>/dev/null) 2>/dev/null || true; rm -f .pid_orch'
    bash -c 'kill $$(cat .pid_safety 2>/dev/null) 2>/dev/null || true; rm -f .pid_safety'
