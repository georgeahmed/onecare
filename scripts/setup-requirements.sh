#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
PY_SERVICES_DIR="${REPO_ROOT}/services-py"
PY_VENV_DIR="${PY_SERVICES_DIR}/.venv"

DRY_RUN=false
PYTHON_CMD=""
PYTHON_VERSION=""

# UI feature toggles (auto-detected, override via flags/env)
USE_COLOR=true
USE_UNICODE=true
USE_SPINNER=true

# Respect standard NO_COLOR spec and allow overrides
if [[ -n "${NO_COLOR:-}" ]]; then USE_COLOR=false; fi
if [[ -n "${ONECARE_SETUP_NO_COLOR:-}" ]]; then USE_COLOR=false; fi
if [[ -n "${ONECARE_SETUP_NO_UNICODE:-}" ]]; then USE_UNICODE=false; fi
if [[ -n "${ONECARE_SETUP_NO_SPINNER:-}" ]]; then USE_SPINNER=false; fi

# Presentation helpers --------------------------------------------------------

# Determine basic capabilities
if [[ ! -t 1 ]]; then
  USE_COLOR=false
  USE_SPINNER=false
fi

# Crude UTF-8 capability check
if [[ -z "${LANG:-}" && -z "${LC_ALL:-}" ]]; then
  USE_UNICODE=false
elif [[ ! "${LANG:-}${LC_ALL:-}" =~ UTF-8|utf-8 ]]; then
  USE_UNICODE=false
fi

if $USE_COLOR; then
  BOLD="$(tput bold || true)"
  DIM="$(tput dim || true)"
  RESET="$(tput sgr0 || true)"
  GREEN="$(tput setaf 2 || true)"
  YELLOW="$(tput setaf 3 || true)"
  BLUE="$(tput setaf 4 || true)"
  CYAN="$(tput setaf 6 || true)"
  MAGENTA="$(tput setaf 5 || true)"
  RED="$(tput setaf 1 || true)"
else
  BOLD=""
  DIM=""
  RESET=""
  GREEN=""
  YELLOW=""
  BLUE=""
  CYAN=""
  MAGENTA=""
  RED=""
fi

STEP_IDX=0
STEP_SYMBOL=">>"

# Emoji/unicode icons with ASCII fallbacks
if $USE_UNICODE; then
  ICON_OK="✔"
  ICON_WARN="⚠"
  ICON_SKIP="⏭"
  ICON_FAIL="✖"
  ICON_STEP="◼"
else
  ICON_OK="[+]"
  ICON_WARN="[!]"
  ICON_SKIP="[~]"
  ICON_FAIL="[x]"
  ICON_STEP=">>"
fi

print_rule() {
  if $USE_UNICODE; then
    printf '%s\n' "──────────────────────────────────────────────────────────────"
  else
    printf '%s\n' "=============================================================="
  fi
}

print_header() {
  local title="ONECARE Setup Assistant"
  if $USE_UNICODE; then
    # Box inner width: 62 runes; content area: 60 (one space padding on each side)
    printf '%s╭──────────────────────────────────────────────────────────────╮%s\n' "$CYAN" "$RESET"
    printf '%s│ %s%-60s%s %s│%s\n' "$CYAN" "$BOLD" "$title" "$RESET$CYAN" "$CYAN" "$RESET"
    if [[ "$DRY_RUN" == "true" ]]; then
      printf '%s│ %s%-60s%s %s│%s\n' "$CYAN" "$DIM" "DRY-RUN MODE: preview only" "$RESET$CYAN" "$CYAN" "$RESET"
    else
      printf '%s│ %s%-60s%s %s│%s\n' "$CYAN" "$DIM" "Preparing local environment requirements" "$RESET$CYAN" "$CYAN" "$RESET"
    fi
    printf '%s╰──────────────────────────────────────────────────────────────╯%s\n' "$CYAN" "$RESET"
  else
    print_rule
    printf '%s%s%s\n' "$BOLD" "$title" "$RESET"
    if [[ "$DRY_RUN" == "true" ]]; then
      printf '%sDRY-RUN MODE: preview only%s\n' "$DIM" "$RESET"
    else
      printf '%sPreparing local environment requirements%s\n' "$DIM" "$RESET"
    fi
    print_rule
  fi
}

print_footer() {
  if $USE_UNICODE; then
    # Match header box: inner width 62, content 60 with single-side padding
    printf '%s╭──────────────────────────────────────────────────────────────╮%s\n' "$CYAN" "$RESET"
    printf '%s│ %s%-60s%s %s│%s\n' "$CYAN" "$BOLD" "Setup assistant finished" "$RESET$CYAN" "$CYAN" "$RESET"
    printf '%s╰──────────────────────────────────────────────────────────────╯%s\n' "$CYAN" "$RESET"
  else
    print_rule
    printf '%sSetup assistant finished.%s\n' "$BOLD" "$RESET"
    print_rule
  fi
}

usage() {
  cat <<'USAGE'
Usage: scripts/setup-requirements.sh [options]

Install project requirements:
  • Installs Node.js workspace dependencies with npm ci
  • Provisions a Python virtualenv under services-py/.venv and installs dev extras
  • Reports any manual prerequisites you must install yourself (Docker, etc.)

Options:
  --dry-run   Show the actions without executing installs
  --no-color  Disable ANSI colors
  --no-unicode  Disable unicode/emoji glyphs
  --no-spinner  Disable live spinner during long steps
  --plain     Equivalent to --no-color --no-unicode --no-spinner
  -h, --help  Show this help
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --no-color)
      USE_COLOR=false
      shift
      ;;
    --no-unicode)
      USE_UNICODE=false
      shift
      ;;
    --no-spinner)
      USE_SPINNER=false
      shift
      ;;
    --plain)
      USE_COLOR=false; USE_UNICODE=false; USE_SPINNER=false
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage
      exit 1
      ;;
  esac
done

log_step() {
  STEP_IDX=$((STEP_IDX + 1))
  local marker="$STEP_SYMBOL"
  if $USE_UNICODE; then marker="$ICON_STEP"; fi
  printf '\n%s[%02d]%s %s %s%s%s\n' "$BLUE" "$STEP_IDX" "$RESET" "$marker" "$BOLD" "$1" "$RESET"
}

log_info() {
  printf '      %s\n' "$1"
}

log_error() {
  printf '%sERROR:%s %s\n' "$RED" "$RESET" "$1" >&2
}

log_status() {
  local status="$1"
  local message="$2"
  local meta="${3:-}"
  case "$status" in
    ok)
      printf '    %s%s%s %s' "$GREEN" "$ICON_OK" "$RESET" "$message"
      ;;
    warn)
      printf '    %s%s%s %s' "$YELLOW" "$ICON_WARN" "$RESET" "$message"
      ;;
    skip)
      printf '    %s%s%s %s' "$DIM" "$ICON_SKIP" "$RESET" "$message"
      ;;
    fail)
      printf '    %s%s%s %s' "$RED" "$ICON_FAIL" "$RESET" "$message"
      ;;
    *)
      printf '    %s%s%s %s' "$BLUE" "$STEP_SYMBOL" "$RESET" "$message"
      ;;
  esac
  if [[ -n "$meta" ]]; then printf ' %s' "$meta"; fi
  printf '\n'
}

run_quiet() {
  local desc="$1"; shift
  local tmp_log
  tmp_log="$(mktemp "${TMPDIR:-/tmp}/onecare-setup.XXXXXX")"

  # Spinner-enhanced path for TTYs
  if $USE_SPINNER && $USE_UNICODE; then
    local frames=("⠋" "⠙" "⠹" "⠸" "⠼" "⠴" "⠦" "⠧" "⠇" "⠏")
    local i=0
    local start_ts
    start_ts=$(date +%s)
    (
      "$@" >"$tmp_log" 2>&1
    ) &
    local cmd_pid=$!

    # Draw spinner until command exits
    while kill -0 "$cmd_pid" >/dev/null 2>&1; do
      printf '\r    %s %s%s%s' "${frames[i]}" "$DIM" "$desc" "$RESET"
      i=$(((i + 1) % ${#frames[@]}))
      sleep 0.08
    done
    # Ensure spinner line cleared
    printf '\r' >/dev/tty 2>/dev/null || true

    local status
    if wait "$cmd_pid"; then
      status=0
    else
      status=$?
    fi
    local end_ts
    end_ts=$(date +%s)
    local dur=$((end_ts - start_ts))
    local meta="${DIM}(${dur}s)${RESET}"

    if [[ $status -eq 0 ]]; then
      log_status ok "$desc" "$meta"
      rm -f "$tmp_log"
      return 0
    else
      log_status fail "$desc" "$meta"
      if [[ -s "$tmp_log" ]]; then
        sed 's/^/      | /' "$tmp_log" >&2
      fi
      log_error "Command failed: ${desc}. Full log: ${tmp_log}"
      return "$status"
    fi
  fi

  # Plain path (no spinner)
  local start_ts
  start_ts=$(date +%s)
  if "$@" >"$tmp_log" 2>&1; then
    local end_ts
    end_ts=$(date +%s)
    local dur=$((end_ts - start_ts))
    log_status ok "$desc" "${DIM}(${dur}s)${RESET}"
    rm -f "$tmp_log"
    return 0
  fi

  log_status fail "$desc"
  if [[ -s "$tmp_log" ]]; then
    sed 's/^/      | /' "$tmp_log" >&2
  fi
  log_error "Command failed: ${desc}. Full log: ${tmp_log}"
  return 1
}

version_ge() {
  local current="${1#v}"
  local required="${2#v}"

  IFS='.' read -r -a current_parts <<<"$current"
  IFS='.' read -r -a required_parts <<<"$required"

  for ((i=${#current_parts[@]}; i<3; i++)); do current_parts[i]=0; done
  for ((i=${#required_parts[@]}; i<3; i++)); do required_parts[i]=0; done

  for i in 0 1 2; do
    local current_val=$((10#${current_parts[i]}))
    local required_val=$((10#${required_parts[i]}))
    if (( current_val > required_val )); then
      return 0
    elif (( current_val < required_val )); then
      return 1
    fi
  done
  return 0
}

declare -a manual_required_missing=()
declare -a manual_optional_missing=()
declare -a manual_required_present=()
declare -a manual_optional_present=()

node_ready=false
npm_ready=false
python_ready=false

check_node() {
  local label="Node.js >= 20.x"
  if ! command -v node >/dev/null 2>&1; then
    manual_required_missing+=("${label} (install via https://nodejs.org/ or nvm/asdf)")
    log_status warn "Node.js not detected; skipping Node dependency install."
    return
  fi

  local node_version
  node_version="$(node --version 2>/dev/null || true)"
  node_version="${node_version#v}"
  if [[ -z "$node_version" ]]; then
    manual_required_missing+=("${label} (unable to determine version; reinstall Node.js)")
    log_status warn "Unable to determine Node.js version; skipping Node dependency install."
    return
  fi

  if ! version_ge "$node_version" "20.0.0"; then
    manual_required_missing+=("${label} (found ${node_version}; update via https://nodejs.org/ or nvm/asdf)")
    log_status warn "Node.js ${node_version} < 20 detected; skipping Node dependency install."
    return
  fi

  manual_required_present+=("Node.js ${node_version}")
  log_status ok "Node.js ${node_version}"
  node_ready=true
}

check_npm() {
  local label="npm >= 9"
  if ! command -v npm >/dev/null 2>&1; then
    manual_required_missing+=("${label} (bundled with Node.js 20+)")
    log_status warn "npm not detected; skipping Node dependency install."
    return
  fi

  local npm_version
  npm_version="$(npm --version 2>/dev/null || true)"
  if [[ -z "$npm_version" ]]; then
    manual_required_missing+=("${label} (unable to determine version; reinstall Node.js)")
    log_status warn "Unable to determine npm version; skipping Node dependency install."
    return
  fi

  if ! version_ge "$npm_version" "9.0.0"; then
    manual_required_missing+=("${label} (found ${npm_version}; update Node.js/npm)")
    log_status warn "npm ${npm_version} < 9 detected; skipping Node dependency install."
    return
  fi

  manual_required_present+=("npm ${npm_version}")
  log_status ok "npm ${npm_version}"
  npm_ready=true
}

check_python() {
  local label="Python >= 3.11"
  local required_version="3.11.0"
  local best_cmd=""
  local best_version=""
  local python_cmd=""
  local python_version=""
  local candidates=(
    python3.12
    python3.11
    python3
    python
  )

  for candidate in "${candidates[@]}"; do
    if ! command -v "$candidate" >/dev/null 2>&1; then
      continue
    fi
    local resolved
    resolved="$(command -v "$candidate")"
    local version
    version="$("$resolved" -c 'import sys; print(".".join(map(str, sys.version_info[:3])))' 2>/dev/null || true)"
    if [[ -z "$version" ]]; then
      continue
    fi

    if version_ge "$version" "$required_version"; then
      python_cmd="$resolved"
      python_version="$version"
      break
    fi

    if [[ -z "$best_version" ]] || version_ge "$version" "$best_version"; then
      best_version="$version"
      best_cmd="$resolved"
    fi
  done

  if [[ -z "$python_cmd" ]]; then
    if [[ -n "$best_version" ]]; then
      manual_required_missing+=("${label} (found ${best_version}; upgrade to 3.11+)")
      log_status warn "Python ${best_version} < 3.11 detected; skipping Python dependency install."
    else
      manual_required_missing+=("${label} (install via https://www.python.org/downloads/ or your package manager)")
      log_status warn "Python not detected; skipping Python dependency install."
    fi
    return
  fi

  manual_required_present+=("Python ${python_version}")
  PYTHON_CMD="$python_cmd"
  PYTHON_VERSION="$python_version"
  log_status ok "Python ${python_version} (${PYTHON_CMD})"
  python_ready=true
}

check_docker() {
  local label="Docker Engine + CLI"
  if command -v docker >/dev/null 2>&1; then
    local docker_version
    docker_version="$(docker --version 2>/dev/null || true)"
    manual_required_present+=("Docker (${docker_version})")
    log_status ok "${docker_version}"
  else
    manual_required_missing+=("${label} (install via https://docs.docker.com/get-docker/)")
    log_status warn "Docker not detected; local stack commands will fail."
  fi
}

check_docker_compose() {
  local label="Docker Compose plugin"
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    manual_required_present+=("Docker Compose (plugin)")
    log_status ok "Docker Compose plugin"
    return
  fi

  if command -v docker-compose >/dev/null 2>&1; then
    manual_required_present+=("docker-compose $(docker-compose --version 2>/dev/null | awk '{print $3}')")
    log_status ok "docker-compose standalone binary"
    return
  fi

  manual_required_missing+=("${label} (install via https://docs.docker.com/compose/install/)")
  log_status warn "Docker Compose not detected."
}

check_optional_tool() {
  local cmd="$1"
  local label="$2"
  local hint="$3"

  if command -v "$cmd" >/dev/null 2>&1; then
    manual_optional_present+=("${label}")
  else
    manual_optional_missing+=("${label} (${hint})")
  fi
}

ensure_node_dependencies() {
  log_step "Node.js workspace dependencies"
  if $DRY_RUN; then
    log_status skip "Dry-run: npm ci"
    return 0
  fi

  run_quiet "npm ci" npm --prefix "$REPO_ROOT" ci --loglevel error --no-progress
}

ensure_python_dependencies() {
  log_step "Python virtual environment"
  if ! $python_ready; then
    log_status skip "Skipping Python dependency install because Python 3.11+ is missing."
    return 0
  fi
  if [[ -z "$PYTHON_CMD" ]]; then
    log_status fail "Python interpreter unavailable; cannot manage services-py environment."
    return 1
  fi
  if [[ -z "$PYTHON_VERSION" ]]; then
    PYTHON_VERSION="$("$PYTHON_CMD" -c 'import sys; print(".".join(map(str, sys.version_info[:3])))')"
  fi

  if $DRY_RUN; then
    log_status skip "Dry-run: manage services-py/.venv"
    log_status skip "Dry-run: install services-py dependencies"
    return 0
  fi

  local venv_python="${PY_VENV_DIR}/bin/python"
  if [[ -d "$PY_VENV_DIR" && -x "${PY_VENV_DIR}/bin/python" ]]; then
    local venv_version
    venv_version="$("${PY_VENV_DIR}/bin/python" -c 'import sys; print(".".join(map(str, sys.version_info[:3])))' 2>/dev/null || true)"
    if [[ -n "$venv_version" && "$venv_version" != "$PYTHON_VERSION" ]]; then
      log_status warn "Recreating virtualenv (found Python ${venv_version}, target ${PYTHON_VERSION})"
      rm -rf "$PY_VENV_DIR"
    else
      log_status ok "Virtualenv already using Python ${venv_version:-${PYTHON_VERSION}}"
    fi
  fi

  if [[ ! -d "$PY_VENV_DIR" ]]; then
    run_quiet "Create virtualenv (${PYTHON_VERSION})" "$PYTHON_CMD" -m venv "$PY_VENV_DIR"
    venv_python="${PY_VENV_DIR}/bin/python"
  fi

  if [[ ! -x "$venv_python" ]]; then
    log_status fail "Virtualenv python not found at ${venv_python}"
    return 1
  fi

  run_quiet "Upgrade pip tooling" "$venv_python" -m pip install --quiet --upgrade pip setuptools wheel
  run_quiet "Install services-py editable deps" "$venv_python" -m pip install --quiet -e "${PY_SERVICES_DIR}[dev]"
  if [[ -f "${PY_SERVICES_DIR}/requirements-dev.txt" ]]; then
    run_quiet "Install services-py requirements-dev" "$venv_python" -m pip install --quiet -r "${PY_SERVICES_DIR}/requirements-dev.txt"
  fi
}

print_manual_summary() {
  log_step "Manual prerequisites"

  if ((${#manual_required_missing[@]} == 0)); then
    log_status ok "All required prerequisites satisfied."
  else
    log_status warn "Still required:"
    for item in "${manual_required_missing[@]}"; do
      log_info "$item"
    done
  fi

  if ((${#manual_optional_missing[@]} > 0)); then
    log_status skip "Optional helpers to consider:"
    for item in "${manual_optional_missing[@]}"; do
      log_info "$item"
    done
  elif ((${#manual_optional_present[@]} > 0)); then
    log_status ok "Optional helpers already installed."
  else
    log_status skip "Optional helpers: none detected."
  fi
}

# Detect prerequisites
print_header
log_step "Checking environment prerequisites"
check_node
check_npm
check_python
check_docker
check_docker_compose
check_optional_tool "make" "make (task runner)" "optional but used by Makefile targets"
check_optional_tool "just" "just (task runner)" "install via brew install just (macOS) or see https://github.com/casey/just#packages"
check_optional_tool "k6" "k6 (performance smoke tests)" "install via brew install k6 (macOS) or see https://k6.io/docs/getting-started/installation/"
check_optional_tool "newman" "newman (Postman CLI for perf smoke)" "install via one of: npm install --location=global newman (npm 9+), brew install newman (macOS), or npx -y newman@latest"
check_optional_tool "jq" "jq (JSON CLI for ops scripts)" "install via https://stedolan.github.io/jq/download/"
check_optional_tool "pre-commit" "pre-commit (git hook runner)" "install via pipx install pre-commit or brew install pre-commit"
check_optional_tool "nats" "nats CLI (JetStream tooling)" "install via: brew install nats-io/nats-tools/nats (docs: https://github.com/nats-io/natscli)"
check_optional_tool "syft" "syft (SBOM generator)" "install via: brew install syft (docs: https://github.com/anchore/syft)"
check_optional_tool "datamodel-codegen" "datamodel-code-generator (schema -> Pydantic)" "install via: brew install pipx && pipx install datamodel-code-generator; run pipx ensurepath afterward (docs: https://github.com/koxudaxi/datamodel-code-generator)"

# Install managed dependencies
if $node_ready && $npm_ready; then
  ensure_node_dependencies
else
  log_status skip "Node.js prerequisites missing; skipped npm ci."
fi

ensure_python_dependencies

# Report manual requirements
print_manual_summary

if ((${#manual_required_missing[@]} > 0)); then
  log_status fail "Environment setup incomplete due to missing manual prerequisites."
  print_rule
  exit 1
fi

log_step "All managed dependencies installed successfully."
print_footer
exit 0
