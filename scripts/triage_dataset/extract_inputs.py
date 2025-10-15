#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path
from typing import Iterable, List, Mapping

ROOT = Path(__file__).resolve().parents[2]
SERVICES_DIR = ROOT / "services-py"
if str(SERVICES_DIR) not in sys.path:
    sys.path.insert(0, str(SERVICES_DIR))

from triage_dataset import (  # noqa: E402
    extract_clinician_outcomes,
    extract_portal_submissions,
    extract_safety_gate_records,
)
from triage_dataset.source_config import (  # noqa: E402
    load_source_config,
    resolve_source_paths,
)


DEFAULT_SUBMISSIONS_FILE = "triage_submissions.jsonl"
DEFAULT_SAFETY_FILE = "safety_gate.jsonl"
DEFAULT_CLINICIAN_FILE = "clinician_outcomes.jsonl"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Extract triage submissions, safety gate decisions, and clinician outcomes into JSONL inputs for dataset building.",
    )
    parser.add_argument(
        "--submissions",
        action="append",
        default=[],
        type=Path,
        help="Path(s) to submissions JSONL files or directories.",
    )
    parser.add_argument(
        "--safety-gate",
        action="append",
        default=[],
        type=Path,
        help="Path(s) to safety gate JSONL files or directories.",
    )
    parser.add_argument(
        "--audit",
        action="append",
        default=[],
        type=Path,
        help="Path(s) to clinician audit JSONL files or directories.",
    )
    parser.add_argument(
        "--output-dir",
        required=True,
        type=Path,
        help="Directory where extracted JSONL files will be written.",
    )
    parser.add_argument(
        "--submissions-output",
        default=DEFAULT_SUBMISSIONS_FILE,
        help=f"Filename for submissions output (default: {DEFAULT_SUBMISSIONS_FILE}).",
    )
    parser.add_argument(
        "--safety-output",
        default=DEFAULT_SAFETY_FILE,
        help=f"Filename for safety gate output (default: {DEFAULT_SAFETY_FILE}).",
    )
    parser.add_argument(
        "--audit-output",
        default=DEFAULT_CLINICIAN_FILE,
        help=f"Filename for clinician outcomes output (default: {DEFAULT_CLINICIAN_FILE}).",
    )
    parser.add_argument(
        "--since",
        help="Optional ISO8601 timestamp filter (inclusive lower bound).",
    )
    parser.add_argument(
        "--until",
        help="Optional ISO8601 timestamp filter (inclusive upper bound).",
    )
    parser.add_argument(
        "--config",
        type=Path,
        help="Optional JSON/YAML source config describing submissions/safety/audit exports.",
    )
    parser.add_argument(
        "--scratch-dir",
        type=Path,
        default=ROOT / "var" / "triage-downloads",
        help="Directory for temporary downloads (used for S3 sources).",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    since = _parse_timestamp(args.since)
    until = _parse_timestamp(args.until)

    output_dir = args.output_dir
    output_dir.mkdir(parents=True, exist_ok=True)

    submissions_paths = list(_normalize_paths(args.submissions))
    safety_paths = list(_normalize_paths(args.safety_gate))
    audit_paths = list(_normalize_paths(args.audit))

    if args.config:
        source_config = load_source_config(args.config)
        scratch_dir = args.scratch_dir
        submissions_paths.extend(
            resolve_source_paths(source_config.get("submissions", []), scratch_dir=scratch_dir, label="submissions")
        )
        safety_paths.extend(
            resolve_source_paths(source_config.get("safetyGate", []), scratch_dir=scratch_dir, label="safety")
        )
        audit_paths.extend(
            resolve_source_paths(source_config.get("clinician", []), scratch_dir=scratch_dir, label="clinician")
        )

    submissions = extract_portal_submissions(submissions_paths, since=since, until=until)
    safety = extract_safety_gate_records(safety_paths, since=since, until=until)
    clinician = extract_clinician_outcomes(audit_paths, since=since, until=until)

    submissions_path = output_dir / args.submissions_output
    safety_path = output_dir / args.safety_output
    clinician_path = output_dir / args.audit_output

    _write_jsonl(submissions_path, submissions)
    _write_jsonl(safety_path, safety)
    _write_jsonl(clinician_path, clinician)

    summary = {
        "submissions": len(submissions),
        "safetyGate": len(safety),
        "clinician": len(clinician),
        "output": {
            "submissions": str(submissions_path),
            "safetyGate": str(safety_path),
            "clinician": str(clinician_path),
        },
    }
    print(json.dumps(summary, indent=2))  # noqa: T201


def _normalize_paths(paths: Iterable[Path]) -> List[Path]:
    normalized: List[Path] = []
    for path in paths:
        if path is None:
            continue
        normalized.append(path)
    return normalized


def _parse_timestamp(value: str | None) -> datetime | None:
    if not value:
        return None
    trimmed = value.strip()
    if not trimmed:
        return None
    if trimmed.endswith("Z"):
        trimmed = trimmed[:-1] + "+00:00"
    try:
        return datetime.fromisoformat(trimmed)
    except ValueError:
        raise SystemExit(f"Invalid ISO8601 timestamp: {value}")


def _write_jsonl(path: Path, rows: Iterable[Mapping[str, object]]) -> None:
    with path.open("w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, separators=(",", ":")))
            handle.write("\n")


if __name__ == "__main__":
    main()
