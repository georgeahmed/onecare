#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

USE_COLOR=true
if [[ ! -t 1 ]] || [[ -n "${NO_COLOR:-}" ]]; then
  USE_COLOR=false
fi

if $USE_COLOR; then
  BOLD="$(tput bold || true)"
  DIM="$(tput dim || true)"
  GREEN="$(tput setaf 2 || true)"
  YELLOW="$(tput setaf 3 || true)"
  BLUE="$(tput setaf 4 || true)"
  CYAN="$(tput setaf 6 || true)"
  RED="$(tput setaf 1 || true)"
  RESET="$(tput sgr0 || true)"
else
  BOLD=""; DIM=""; GREEN=""; YELLOW=""; BLUE=""; CYAN=""; RED=""; RESET=""
fi

STEP=0

print_banner() {
  printf '\n%s═══════════════════════════════════════════════════════════════════%s\n' "$CYAN" "$RESET"
  printf '%s│%s %sONECARE Dev Operations Guide%s\n' "$CYAN" "$RESET" "$BOLD" "$RESET"
  printf '%s═══════════════════════════════════════════════════════════════════%s\n\n' "$CYAN" "$RESET"
}

print_step() {
  STEP=$((STEP + 1))
  printf '\n%s[%02d]%s %s%s%s\n' "$BLUE" "$STEP" "$RESET" "$BOLD" "$1" "$RESET"
}

print_info() {
  printf '   %s•%s %s\n' "$DIM" "$RESET" "$1"
}

print_warn() {
  printf '   %s!%s %s\n' "$YELLOW" "$RESET" "$1"
}

prompt_continue() {
  printf '\n%sPress Enter to continue...%s' "$DIM" "$RESET"
  # shellcheck disable=SC2034
  read -r _
}

confirm_action() {
  local prompt="$1"
  local default_choice="${2:-Y}"
  local answer
  printf '%s%s [Y/n]: %s' "$BOLD" "$prompt" "$RESET"
  read -r answer || answer=""
  answer="${answer:-$default_choice}"
  if [[ "$answer" =~ ^[Yy]$ ]]; then
    return 0
  fi
  return 1
}

launch_terminal() {
  local title="$1"
  local command="$2"
  local prepared="cd $(printf '%q' "$REPO_ROOT") && $command"

  if [[ "$OSTYPE" == darwin* ]] && command -v osascript >/dev/null 2>&1; then
    osascript <<EOF >/dev/null
tell application "Terminal"
  do script "$prepared"
  activate
end tell
EOF
    print_info "Opened new Terminal window for: ${title}"
    return 0
  fi

  if command -v gnome-terminal >/dev/null 2>&1; then
    gnome-terminal -- bash -lc "$prepared" >/dev/null 2>&1 &
    print_info "Opened GNOME Terminal for: ${title}"
    return 0
  fi

  if command -v xterm >/dev/null 2>&1; then
    xterm -T "${title}" -e bash -lc "$prepared" >/dev/null 2>&1 &
    print_info "Opened xterm for: ${title}"
    return 0
  fi

  print_warn "Unable to launch a new terminal automatically. Run manually:"
  printf '      %s%s%s\n' "$BOLD" "$prepared" "$RESET"
  return 1
}

run_command() {
  local description="$1"
  shift
  print_step "$description"
  if confirm_action "Run now?"; then
    print_info "Executing: $*"
    (cd "$REPO_ROOT" && "$@")
  else
    print_warn "Skipped. You can run it later with:"
    printf '      %s%s%s\n' "$BOLD" "$*" "$RESET"
  fi
  prompt_continue
}

show_overview() {
  print_step "Welcome"
  cat <<'EOF'
This guided helper walks you through preparing, running, testing, and observing
the ONECARE stack. Each section explains the *why* behind the command and
offers interactive prompts, so feel free to explore at your own pace.

Core phases:
  1. Prepare dependencies and generated contracts.
  2. Start the runtime stack (local or Docker).
  3. Exercise API flows and frontends with sample credentials.
  4. Run automated tests and smoke checks for confidence.
  5. Review observability, troubleshooting, and clean-up tips.

Use the menu to jump between phases. When a step recommends running something
in its own terminal, the helper will offer to launch one for you. If the system
cannot open a new window automatically, it prints the command to copy-paste.
EOF
  prompt_continue
}

show_sample_credentials() {
  print_step "Sample credentials and configuration"
  cat <<'EOF'
Suggested dev/test values:
  • Practice ID: demo
  • Authorization header: Bearer dev-token
  • Actor headers:
      x-actor-type: patient
      x-actor-id: demo-patient
  • Correlation IDs: x-request-id: demo-request-1 (or any UUID)
  • Booking base URL (local docker stack): http://localhost:4000
  • Safety Gate URL: http://localhost:8081
  • Orchestrator URL: http://localhost:3001

Environment variables for local workflows:
  export PRACTICE_ID=demo
  export PY_SAFETY_GATE_URL=http://localhost:8081
  export PY_SAFETY_GATE_HOST_ALLOWLIST=localhost,127.0.0.1
  export BOOKING_BASE_URL=http://localhost:4000

When using curl against /safety-check:
  curl -s -X POST http://localhost:3001/safety-check \
    -H 'content-type: application/json' \
    -H 'authorization: Bearer dev-token' \
    -H 'x-actor-type: patient' \
    -H 'x-actor-id: demo-patient' \
    -H 'x-request-id: demo-request-1' \
    -H 'x-auth-scope: submit triage:submit' \
    -d '{"practiceId":"demo","patient":{"id":"demo-patient"},"narrative":"mild headache","channel":"web"}'
EOF
  prompt_continue
}

bootstrap_dependencies() {
  print_step "Bootstrap project requirements"
  cat <<'EOF'
This installs Node.js workspace dependencies, provisions the Python virtualenv
for services-py, and checks for optional tooling (k6, newman, nats CLI, etc.).

Command: ./scripts/setup-requirements.sh
EOF
  if confirm_action "Run setup now?"; then
    (cd "$REPO_ROOT" && bash ./scripts/setup-requirements.sh)
  else
    print_warn "Skipped. Run later with ./scripts/setup-requirements.sh"
  fi
  prompt_continue
}

generate_contracts() {
  print_step "Generate TypeScript/Python contracts from schemas"
  cat <<'EOF'
Run code generation after modifying JSON Schemas so that downstream TypeScript
and Python models stay in sync.

Commands:
  1) npm run --workspaces=false codegen                # TS generation (json-schema-to-typescript)
  2) RUN_PY=1 npm run --workspaces=false codegen       # TS + Python (requires datamodel-codegen)

Tip: If datamodel-codegen is missing, install via pipx (brew install pipx &&
pipx install datamodel-code-generator).
EOF
  if confirm_action "Run npm run --workspaces=false codegen now?"; then
    if ! (cd "$REPO_ROOT" && npm run --workspaces=false codegen); then
      print_warn "Codegen failed. Review the output above; ensure schemas build cleanly."
    fi
  fi
  if confirm_action "Also run RUN_PY=1 npm run --workspaces=false codegen?" "n"; then
    if ! (cd "$REPO_ROOT" && RUN_PY=1 npm run --workspaces=false codegen); then
      print_warn "Python codegen failed. Install datamodel-code-generator via pipx and retry."
    fi
  fi
  prompt_continue
}

start_runtime_menu() {
  while true; do
    cat <<'EOF'

Choose a stack launcher:
  1) Local orchestrator + Safety Gate (make dev-run)
  2) Full developer stack (npm run --workspaces=false dev:all)
  3) Docker compose stack (make docker-up)
  4) Back to main menu
EOF
    printf '%sSelect option:%s ' "$BOLD" "$RESET"
    read -r choice
    case "$choice" in
      1)
        explain_dev_run
        ;;
      2)
        explain_dev_all
        ;;
      3)
        explain_docker_up
        ;;
      4)
        break
        ;;
      *)
        print_warn "Invalid choice."
        ;;
    esac
  done
}

explain_dev_run() {
  print_step "Start orchestrator + Safety Gate (make dev-run)"
  cat <<'EOF'
This builds the orchestrator once, launches the Python Safety Gate via
uvicorn, then starts the Node orchestrator with in-memory bus implementation.
It runs both services in the foreground until you stop them (Ctrl+C).

Ports:
  • Safety Gate API: http://localhost:8081
  • Orchestrator API: http://localhost:3001

Use this flow when you want the minimal local stack without Docker.
EOF
  if confirm_action "Launch in a new terminal window?"; then
    launch_terminal "ONECARE dev-run" "make dev-run"
  else
    print_info "Run manually in this shell: make dev-run"
  fi
  prompt_continue
}

explain_dev_all() {
  print_step "Start full developer stack (npm run --workspaces=false dev:all)"
  cat <<'EOF'
This script starts Safety Gate, Orchestrator, Booking stub, Proxy, and Portal
UI with live reload. Ideal for validating end-to-end flows locally without
Docker.

Important environment variables before launch:
  export PRACTICE_ID=demo
  export FHIR_BASE_URL=http://localhost:8000   # replace with your sandbox
  export FHIR_TOKEN=dev-token

The helper command automatically uses BUS_IMPL=memory.
EOF
  if confirm_action "Launch npm run --workspaces=false dev:all in new terminal?"; then
    launch_terminal "ONECARE dev-all" "npm run --workspaces=false dev:all"
  else
    print_info "Run manually: npm run --workspaces=false dev:all"
  fi
  prompt_continue
}

explain_docker_up() {
  print_step "Start Docker compose stack"
  cat <<'EOF'
Docker Compose builds and runs the containerised stack (orchestrator, Safety
Gate, Postgres mocks, etc.). Use this when mirroring production-like topology.

Health endpoints to watch:
  curl -s http://localhost:8081/docs
  curl -s http://localhost:3001/health

Stop with: make docker-down
EOF
  if confirm_action "Launch make docker-up in new terminal?"; then
    launch_terminal "ONECARE docker-up" "make docker-up"
  else
    print_info "Run manually: make docker-up"
  fi
  prompt_continue
}

run_tests_menu() {
  while true; do
    cat <<'EOF'

Test helpers:
  1) TypeScript unit tests (npm run test)
  2) Python tests (services-py/run-tests.sh)
  3) Contract tests (npm run test:contracts)
  4) Performance smoke (make perf-smoke)
  5) Back to main menu
EOF
    printf '%sPick a test suite:%s ' "$BOLD" "$RESET"
    read -r choice
    case "$choice" in
      1)
        run_command "Run Vitest unit suite" npm run test
        ;;
      2)
        run_command "Run Python pytest suite" ./services-py/run-tests.sh
        ;;
      3)
        run_command "Run contract test suite" npm run test:contracts
        ;;
      4)
        print_step "Performance smoke prerequisites"
        cat <<'EOF'
Requires k6 and newman installed. Uses BOOKING_BASE_URL and SAFETY_CHECK_BASE_URL
environment variables.

Example:
  BOOKING_BASE_URL=http://localhost:4000 \
  SAFETY_CHECK_BASE_URL=http://localhost:3001 \
  make perf-smoke
EOF
        if confirm_action "Run make perf-smoke now?" "n"; then
          (cd "$REPO_ROOT" && BOOKING_BASE_URL=http://localhost:4000 SAFETY_CHECK_BASE_URL=http://localhost:3001 make perf-smoke)
        fi
        prompt_continue
        ;;
      5)
        break
        ;;
      *)
        print_warn "Invalid choice."
        ;;
    esac
  done
}

observability_help() {
  print_step "Observability and troubleshooting"
  cat <<'EOF'
Monitoring tips:
  • Logs: services print to stdout. Use tail -f var/logs/* or docker logs.
  • Traces: When running locally, check console spans emitted with correlation IDs.
  • Metrics: Safety Gate exposes Prometheus metrics at http://localhost:8081/metrics.

Troubleshooting checklist:
  1. Ensure .env is populated (copy from .env.example).
  2. Validate required services are reachable (curl health endpoints).
  3. Reset Docker stack if ports are stuck: make docker-down && docker ps (verify).
  4. Regenerate contracts after schema edits: npm run --workspaces=false codegen.

To stream orchestrator logs in a new window using npm workspaces:
  npm run --workspace @onecare/app-orchestrator dev

To shut down background dev-run processes created by this assistant:
  make dev-stop
EOF
  prompt_continue
}

cleanup_guidance() {
  print_step "Shut down services and clean up"
  cat <<'EOF'
Stop processes launched earlier:
  • make dev-stop             # stops orchestrator + Safety Gate from dev-run
  • npm run --workspaces=false dev:all:stop      # stops full dev stack helper
  • make docker-down          # stops Compose stack and removes containers

Optional resets:
  • npm run clean             # removes dist caches
  • rm -rf services-py/.venv  # rebuild Python virtualenv on next setup run
EOF
  if confirm_action "Run make dev-stop now?" "n"; then
    (cd "$REPO_ROOT" && make dev-stop)
  fi
  if confirm_action "Run npm run --workspaces=false dev:all:stop?" "n"; then
    (cd "$REPO_ROOT" && npm run --workspaces=false dev:all:stop)
  fi
  if confirm_action "Run make docker-down?" "n"; then
    (cd "$REPO_ROOT" && make docker-down)
  fi
  prompt_continue
}

main_menu() {
  while true; do
    cat <<'EOF'

Main menu:
  1) Overview of the operations journey
  2) Bootstrap dependencies (setup-requirements)
  3) Generate contracts from schemas
  4) Start runtime stack
  5) Run tests and smokes
  6) Sample credentials & API helpers
  7) Observability & troubleshooting tips
  8) Clean-up / stop services
  9) Exit
EOF
    printf '%sChoose an option:%s ' "$BOLD" "$RESET"
    read -r option
    case "$option" in
      1) show_overview ;;
      2) bootstrap_dependencies ;;
      3) generate_contracts ;;
      4) start_runtime_menu ;;
      5) run_tests_menu ;;
      6) show_sample_credentials ;;
      7) observability_help ;;
      8) cleanup_guidance ;;
      9)
        print_info "Good luck, and happy shipping!"
        break
        ;;
      *) print_warn "Please choose a valid option." ;;
    esac
  done
}

print_banner
main_menu
