#!/usr/bin/env python3
"""Show the challenge-0 predictive-maintenance flow for machine-001.

This standalone report reads the seeded challenge-0 JSON files and prints five
console tables: telemetry, anomaly classification, fault diagnosis, repair and
maintenance, and parts order and execution plan.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

MACHINE_ID = "machine-001"
SCRIPT_DIR = Path(__file__).resolve().parent
DATA_DIR = SCRIPT_DIR / "agentic-factory-hack" / "challenge-0" / "data"


def load_json(filename: str) -> list[dict[str, Any]]:
    """Load a JSON array from the seeded challenge-0 data directory."""
    path = DATA_DIR / filename
    if not path.exists():
        raise FileNotFoundError(f"Could not find seeded data file: {path}")
    with path.open(encoding="utf-8") as file:
        value = json.load(file)
    return value if isinstance(value, list) else [value]


def text(value: Any) -> str:
    """Convert values to compact table-safe text."""
    if isinstance(value, (dict, list)):
        return json.dumps(value, separators=(",", ":"))
    return str(value)


def print_table(title: str, columns: list[str], rows: list[list[Any]]) -> None:
    """Print a small dependency-free table."""
    rendered = [[text(cell) for cell in row] for row in rows]
    widths = [len(column) for column in columns]
    for row in rendered:
        for index, cell in enumerate(row):
            widths[index] = max(widths[index], len(cell))

    border = "+-" + "-+-".join("-" * width for width in widths) + "-+"
    print(f"\n{title}")
    print(border)
    print("| " + " | ".join(column.ljust(widths[index]) for index, column in enumerate(columns)) + " |")
    print(border)
    for row in rendered:
        print("| " + " | ".join(cell.ljust(widths[index]) for index, cell in enumerate(row)) + " |")
    print(border)


def parse_time(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def classify_anomalies(telemetry: dict[str, Any], thresholds: list[dict[str, Any]]) -> list[list[Any]]:
    threshold_by_metric = {item["metric"]: item for item in thresholds}
    rows = []
    for metric, value in telemetry["metrics"].items():
        rule = threshold_by_metric.get(metric)
        if not rule:
            continue
        critical = rule["criticalThreshold"]
        warning = rule["warningThreshold"]
        if metric == "throughput":
            severity = "critical" if value <= critical else "warning" if value <= warning else "normal"
        else:
            severity = "critical" if value >= critical else "warning" if value >= warning else "normal"
        if severity != "normal":
            rows.append([
                metric,
                value,
                rule["unit"],
                severity,
                f"warning={warning}; critical={critical}",
            ])
    return rows


def choose_parts(parts: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [part for part in parts if "tire_curing_press" in part.get("compatibleMachines", [])]


def main() -> None:
    machines = load_json("machines.json")
    telemetry = [item for item in load_json("telemetry-samples.json") if item.get("machineId") == MACHINE_ID]
    thresholds = [item for item in load_json("thresholds.json") if item.get("machineType") == "tire_curing_press"]
    parts = choose_parts(load_json("parts-inventory.json"))
    windows = [item for item in load_json("maintenance-windows.json") if item.get("isAvailable")]
    machine = next((item for item in machines if item.get("id") == MACHINE_ID), {"id": MACHINE_ID})

    if not telemetry:
        raise RuntimeError(f"No telemetry found for {MACHINE_ID}")
    latest = max(telemetry, key=lambda item: parse_time(item["timestamp"]))
    anomalies = classify_anomalies(latest, thresholds)
    warning_count = sum(row[3] == "warning" for row in anomalies)
    critical_count = sum(row[3] == "critical" for row in anomalies)
    severity = "critical" if critical_count else "warning" if warning_count else "normal"

    print(f"Team 8 Challenge 0 - Predictive Maintenance Report for {MACHINE_ID}")
    print(f"Machine: {machine.get('name', 'Tire Curing Press A1')} | Type: {machine.get('type', 'tire_curing_press')}")
    print(f"Latest sample: {latest['timestamp']} | Overall status: {latest.get('status', 'unknown')}")

    telemetry_rows = [
        [item["timestamp"], metric, value]
        for item in sorted(telemetry, key=lambda item: item["timestamp"])
        for metric, value in item["metrics"].items()
    ]
    print_table("1. Telemetry data", ["Timestamp", "Metric", "Value"], telemetry_rows)

    print_table(
        "2. Anomaly classification",
        ["Metric", "Observed", "Unit", "Severity", "Thresholds"],
        anomalies or [["-", "-", "-", "normal", "No threshold violations"]],
    )

    diagnosis = [
        ["Fault", "Curing process deviation"],
        ["Likely root cause", "Elevated curing temperature and extended cycle time"],
        ["Evidence", f"{warning_count} warning violation(s), {critical_count} critical violation(s) in latest sample"],
        ["Recommended checks", "Inspect heating element calibration, temperature sensor, mold seal, and process recipe"],
        ["Diagnosis status", "Maintenance required" if severity != "normal" else "Monitor"],
    ]
    print_table("3. Fault diagnosis", ["Field", "Finding"], diagnosis)

    selected_window = min(
        windows,
        key=lambda item: (item.get("productionImpact") != "Low", item.get("startTime", "")),
        default={},
    )
    repair_rows = [
        ["Priority", "high" if severity == "warning" else severity],
        ["Work type", "corrective"],
        ["Repair tasks", "Validate temperature sensor; inspect heater; inspect bladder/seal; run calibration cycle"],
        ["Estimated duration", "120 minutes"],
        ["Maintenance window", selected_window.get("startTime", "No available window")],
        ["Production impact", selected_window.get("productionImpact", "Unknown")],
        ["Work order action", "Create and schedule maintenance work order"],
    ]
    print_table("4. Repair and maintenance", ["Field", "Plan"], repair_rows)

    part_rows = []
    total_cost = 0.0
    for part in parts:
        quantity = 1
        total_cost += quantity * float(part.get("unitCost", 0))
        action = "Reserve from inventory" if part.get("quantityInStock", 0) > 0 else "Order from supplier"
        part_rows.append([
            part.get("partNumber", ""),
            part.get("name", ""),
            quantity,
            part.get("quantityInStock", 0),
            action,
        ])
    part_rows.append(["TOTAL", "Estimated parts value", "", "", f"${total_cost:,.2f}"])
    print_table("5. Parts order and execution plan", ["Part", "Description", "Qty", "Stock", "Execution"], part_rows)

    print("\nWorkflow: Telemetry -> Anomaly Classification -> Fault Diagnosis -> Repair/Maintenance -> Parts Order and Execution")
    print("Data source: seeded challenge-0 JSON files (standalone local report; no Azure service call required).")


if __name__ == "__main__":
    main()
