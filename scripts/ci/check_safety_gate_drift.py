#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser(description="Safety Gate drift guard")
    parser.add_argument("--metrics", type=Path, required=True)
    parser.add_argument("--baseline", type=Path, default=Path("services-py/safety_gate_service/data/baseline_expectations.json"))
    parser.add_argument("--tolerance", type=float, default=0.02, help="Allowed drop before failure")
    args = parser.parse_args()

    if not args.metrics.exists():
        raise SystemExit(f"metrics file not found: {args.metrics}")
    if not args.baseline.exists():
        raise SystemExit(f"baseline file not found: {args.baseline}")

    current = json.loads(args.metrics.read_text())
    baseline = json.loads(args.baseline.read_text())

    accuracy = current.get("decisions", {}).get("accuracy", 0.0)
    baseline_accuracy = baseline.get("accuracy", 0.0)

    current_recall = current.get("decisions", {}).get("recall", {})
    baseline_recall = baseline.get("recall", {})

    current_ece = current.get("ece", 1.0)
    baseline_ece = baseline.get("ece", 1.0)

    failures: list[str] = []

    if accuracy + args.tolerance < baseline_accuracy:
        failures.append(f"decision accuracy {accuracy:.3f} < baseline {baseline_accuracy:.3f} (tol {args.tolerance})")

    for key, baseline_value in baseline_recall.items():
        observed = current_recall.get(key, 0.0)
        if observed + args.tolerance < baseline_value:
            failures.append(f"recall[{key}] {observed:.3f} < baseline {baseline_value:.3f} (tol {args.tolerance})")

    if current_ece - args.tolerance > baseline_ece:
        failures.append(f"ECE {current_ece:.4f} worse than baseline {baseline_ece:.4f} (tol {args.tolerance})")

    if failures:
        for msg in failures:
            print(f"::error title=Safety Gate drift::{msg}")
        raise SystemExit(1)
    print("Safety Gate metrics within drift tolerances")


if __name__ == "__main__":
    main()
