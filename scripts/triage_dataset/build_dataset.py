#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Dict, Iterable, List, Mapping

ROOT = Path(__file__).resolve().parents[2]
SERVICES_DIR = ROOT / "services-py"
if str(SERVICES_DIR) not in sys.path:
    sys.path.insert(0, str(SERVICES_DIR))

from triage_dataset import (  # noqa: E402
    DatasetBuildConfig,
    SanitizerConfig,
    build_dataset,
    build_row_sanitizer,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Build a triage training dataset from extracted submissions/safety/audit JSONL inputs.",
    )
    parser.add_argument("--submissions", required=True, type=Path, help="JSONL file of submissions.")
    parser.add_argument("--safety-gate", required=True, type=Path, help="JSONL file of safety gate decisions.")
    parser.add_argument("--clinician", required=True, type=Path, help="JSONL file of clinician dispositions.")
    parser.add_argument("--output-dir", required=True, type=Path, help="Directory root for dataset output.")
    parser.add_argument("--dataset-version", required=True, help="Dataset version tag (e.g. v20250315).")
    parser.add_argument("--deident-version", required=True, help="Identifier for the de-identification rule set.")
    parser.add_argument("--source-range", action="append", default=[], metavar="KEY=VALUE", help="Optional source ranges.")
    parser.add_argument("--salt", help="Hashing salt; defaults to TRIAGE_DATASET_SALT env var.")
    parser.add_argument("--overwrite", action="store_true", help="Allow overwriting an existing dataset version.")
    parser.add_argument("--redact-field", action="append", default=[], help="Additional top-level fields to remove.")
    return parser.parse_args()


def main() -> None:
    args = parse_args()

    salt = args.salt or os.getenv("TRIAGE_DATASET_SALT")
    if not salt:
        raise SystemExit("Salt must be provided via --salt or TRIAGE_DATASET_SALT.")

    submissions = _read_jsonl(args.submissions)
    safety = _read_jsonl(args.safety_gate)
    clinician = _read_jsonl(args.clinician)

    config = DatasetBuildConfig(
        output_dir=args.output_dir,
        dataset_version=args.dataset_version,
        overwrite=args.overwrite,
    )
    sanitizer = build_row_sanitizer(SanitizerConfig(salt=salt, redact_fields=args.redact_field))
    result = build_dataset(
        config=config,
        submissions=submissions,
        safety_gate_records=safety,
        clinician_records=clinician,
        sanitize_row=sanitizer,
        deident_version=args.deident_version,
        source_ranges=_parse_source_ranges(args.source_range),
    )

    print(json.dumps(result.manifest.to_dict(), indent=2))  # noqa: T201


def _read_jsonl(path: Path) -> List[Mapping[str, object]]:
    rows: List[Mapping[str, object]] = []
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            rows.append(json.loads(line))
    return rows


def _parse_source_ranges(values: Iterable[str]) -> Dict[str, str]:
    ranges: Dict[str, str] = {}
    for item in values:
        if "=" not in item:
            continue
        key, value = item.split("=", 1)
        key = key.strip()
        value = value.strip()
        if key:
            ranges[key] = value
    return ranges


if __name__ == "__main__":
    main()

