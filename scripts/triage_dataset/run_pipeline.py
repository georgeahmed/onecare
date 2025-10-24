#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SERVICES_DIR = ROOT / "services-py"
if str(SERVICES_DIR) not in sys.path:
    sys.path.insert(0, str(SERVICES_DIR))

from triage_dataset import (  # noqa: E402
    DatasetBuildConfig,
    SanitizerConfig,
    build_dataset,
    build_row_sanitizer,
    extract_clinician_outcomes,
    extract_portal_submissions,
    extract_safety_gate_records,
)
from triage_dataset.source_config import (  # noqa: E402
    load_source_config,
    resolve_source_paths,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run triage dataset extraction + build pipeline")
    parser.add_argument("--config", required=True, type=Path, help="Source config JSON/YAML for submissions/safety/audit.")
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=ROOT / "data" / "triage",
        help="Root directory for versioned dataset outputs.",
    )
    parser.add_argument(
        "--scratch-dir",
        type=Path,
        default=ROOT / "var" / "triage-downloads",
        help="Directory for temporary downloads (used for remote sources).",
    )
    parser.add_argument(
        "--dataset-version",
        help="Dataset version tag (default: vYYYYMMDD).",
    )
    parser.add_argument(
        "--deident-version",
        default="deid-v1",
        help="Identifier for de-identification rule set stored with manifest.",
    )
    parser.add_argument(
        "--since",
        help="Inclusive ISO8601 lower bound for submission timestamps.",
    )
    parser.add_argument(
        "--until",
        help="Inclusive ISO8601 upper bound for submission timestamps.",
    )
    parser.add_argument(
        "--salt",
        help="Hashing salt (falls back to TRIAGE_DATASET_SALT env var).",
    )
    parser.add_argument(
        "--redact-field",
        action="append",
        default=[],
        help="Optional additional top-level fields to strip during sanitization.",
    )
    parser.add_argument(
        "--keep-inputs",
        action="store_true",
        help="Write intermediate extracted JSONL files alongside dataset (for debugging).",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()

    dataset_version = args.dataset_version or datetime.utcnow().strftime("v%Y%m%d")
    salt = args.salt or os.getenv("TRIAGE_DATASET_SALT")
    if not salt:
        raise SystemExit("Salt must be provided via --salt or TRIAGE_DATASET_SALT env var.")

    source_cfg = load_source_config(args.config)
    scratch_dir = args.scratch_dir

    submissions_paths = resolve_source_paths(source_cfg.get("submissions", []), scratch_dir=scratch_dir, label="submissions")
    safety_paths = resolve_source_paths(source_cfg.get("safetyGate", []), scratch_dir=scratch_dir, label="safety")
    clinician_paths = resolve_source_paths(source_cfg.get("clinician", []), scratch_dir=scratch_dir, label="clinician")

    since_dt = _parse_timestamp(args.since)
    until_dt = _parse_timestamp(args.until)

    submissions = extract_portal_submissions(submissions_paths, since=since_dt, until=until_dt)
    safety = extract_safety_gate_records(safety_paths, since=since_dt, until=until_dt)
    clinician = extract_clinician_outcomes(clinician_paths, since=since_dt, until=until_dt)

    extraction_info = {
        "submissions": len(submissions),
        "safetyGate": len(safety),
        "clinician": len(clinician),
    }

    if args.keep_inputs:
        inputs_dir = args.output_dir / dataset_version / "inputs"
        inputs_dir.mkdir(parents=True, exist_ok=True)
        _write_jsonl(inputs_dir / "triage_submissions.jsonl", submissions)
        _write_jsonl(inputs_dir / "safety_gate.jsonl", safety)
        _write_jsonl(inputs_dir / "clinician_outcomes.jsonl", clinician)

    config = DatasetBuildConfig(
        output_dir=args.output_dir,
        dataset_version=dataset_version,
        overwrite=False,
    )
    sanitizer = build_row_sanitizer(SanitizerConfig(salt=salt, redact_fields=args.redact_field))
    result = build_dataset(
        config=config,
        submissions=submissions,
        safety_gate_records=safety,
        clinician_records=clinician,
        sanitize_row=sanitizer,
        deident_version=args.deident_version,
        source_ranges=_build_source_ranges(args.since, args.until),
    )

    summary = {
        "datasetVersion": dataset_version,
        "manifest": result.manifest.to_dict(),
        "extraction": extraction_info,
        "outputPath": str(result.output_path),
    }
    print(json.dumps(summary, indent=2))  # noqa: T201


def _parse_timestamp(value: str | None):
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


def _build_source_ranges(since: str | None, until: str | None) -> Dict[str, str]:
    ranges: Dict[str, str] = {}
    if since or until:
        start = since or ""
        end = until or ""
        ranges["submissions"] = f"{start}/{end}".strip("/")
    return ranges


def _write_jsonl(path: Path, rows) -> None:
    with path.open("w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, separators=(",", ":")))
            handle.write("\n")


if __name__ == "__main__":
    main()

