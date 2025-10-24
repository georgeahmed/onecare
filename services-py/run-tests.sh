#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV_DIR="${VENV_DIR:-${SCRIPT_DIR}/.venv}"

choose_python() {
  local candidates=()
  if [ -n "${PYTHON_BIN:-}" ]; then
    candidates+=("${PYTHON_BIN}")
  else
    candidates+=(python3.12 python3.11 python3.10 python3)
  fi

  for candidate in "${candidates[@]}"; do
    if ! command -v "${candidate}" >/dev/null 2>&1; then
      continue
    fi
    if "${candidate}" -c 'import sys; sys.exit(0 if (3, 10) <= sys.version_info < (3, 13) else 1)' >/dev/null 2>&1; then
      PYTHON_BIN="${candidate}"
      return 0
    fi
  done

  echo "error: Python 3.10–3.12 interpreter not found. Set PYTHON_BIN to a supported executable." >&2
  exit 1
}

choose_python

if [ -x "${VENV_DIR}/bin/python" ]; then
  if ! "${VENV_DIR}/bin/python" -c 'import sys; sys.exit(0 if (3, 10) <= sys.version_info < (3, 13) else 1)' >/dev/null 2>&1; then
    rm -rf "${VENV_DIR}"
  fi
fi

if [ ! -x "${VENV_DIR}/bin/python" ]; then
  "${PYTHON_BIN}" -m venv "${VENV_DIR}"
fi

"${VENV_DIR}/bin/python" -m pip install --upgrade pip >/dev/null

REQ_FILE="${SCRIPT_DIR}/requirements-dev.txt"
if [ -f "${REQ_FILE}" ]; then
  "${VENV_DIR}/bin/python" -m pip install -r "${REQ_FILE}" >/dev/null
fi

export PYTHONPATH="${PYTHONPATH:-}:${SCRIPT_DIR}"

exec "${VENV_DIR}/bin/python" -m pytest "$@"
