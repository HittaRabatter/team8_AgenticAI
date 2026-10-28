#!/usr/bin/env python3
"""Generate five predictive-maintenance tables for a selected machine."""

from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path
from typing import Any

SCRIPT_DIR = Path(__file__).resolve().parent
DATA_DIR = SCRIPT_DIR / "agentic-factory-hack" / "challenge-0" / "data"


def load_json(filename: str) -> list[dict[str, Any]]:
    path = DATA_DIR / filename
    if not path.exists():
        raise FileNotFoundError(f"Could not find seeded data file: {path}")
    with path.open(encoding="utf-8") as file:
        value = json.load(file)
    return value if isinstance(value, list) else [value]


def text(value: Any) -> str:
    if isinstance(value, (dict, list)):
        return json.dumps(value, separators=(",", ":"))
    return str(value)


def print_table(title: str, columns: list[str], rows: list[list[Any]]) -> None:
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
            rows.append([metric, value, rule["unit"], severity, f"warning={warning}; critical={critical}"])
    return rows


def get_machine_analysis(machine_number: str) -> dict[str, Any]:
    """Return structured predictive-maintenance data for a three-digit machine number."""
    if not machine_number.isdigit() or len(machine_number) != 3:
        raise ValueError("Machine number must be exactly three digits, for example 001")

    machine_id = f"machine-{machine_number}"
    machines = load_json("machines.json")
    telemetry = [item for item in load_json("telemetry-samples.json") if item.get("machineId") == machine_id]
    machine = next((item for item in machines if item.get("id") == machine_id), None)
    if not telemetry or not machine:
        raise ValueError(f"No seeded machine or telemetry found for {machine_id}")

    machine_type = machine.get("type", "")
    thresholds = [item for item in load_json("thresholds.json") if item.get("machineType") == machine_type]
    parts = [
        item for item in load_json("parts-inventory.json")
        if machine_type in item.get("compatibleMachines", [])
    ]
    windows = [item for item in load_json("maintenance-windows.json") if item.get("isAvailable")]
    latest = max(telemetry, key=lambda item: parse_time(item["timestamp"]))
    anomalies = classify_anomalies(latest, thresholds)
    warning_count = sum(row[3] == "warning" for row in anomalies)
    critical_count = sum(row[3] == "critical" for row in anomalies)
    severity = "critical" if critical_count else "warning" if warning_count else "normal"

    selected_window = min(
        windows,
        key=lambda item: (item.get("productionImpact") != "Low", item.get("startTime", "")),
        default={},
    )
    suppliers = load_json("suppliers.json")
    part_numbers = {part.get("partNumber") for part in parts}
    matching_suppliers = [
        supplier for supplier in suppliers
        if part_numbers.intersection(supplier.get("partsSupplied", []))
    ]

    return {
        "machine": machine,
        "machine_id": machine_id,
        "machine_type": machine_type,
        "telemetry": telemetry,
        "latest": latest,
        "anomalies": anomalies,
        "severity": severity,
        "warning_count": warning_count,
        "critical_count": critical_count,
        "parts": parts,
        "suppliers": matching_suppliers,
        "selected_window": selected_window,
    }


def generate_machine_report(machine_number: str) -> None:
    """Print the five predictive-maintenance tables for a three-digit machine number."""
    analysis = get_machine_analysis(machine_number)
    machine = analysis["machine"]
    machine_id = analysis["machine_id"]
    machine_type = analysis["machine_type"]
    telemetry = analysis["telemetry"]
    latest = analysis["latest"]
    anomalies = analysis["anomalies"]
    severity = analysis["severity"]
    warning_count = analysis["warning_count"]
    critical_count = analysis["critical_count"]
    parts = analysis["parts"]

    print(f"Team 8 Challenge 0 - Predictive Maintenance Report for {machine_id}")
    print(f"Machine: {machine.get('name', machine_id)} | Type: {machine_type}")
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
        ["Fault", f"{machine_type} process deviation"],
        ["Likely root cause", "Multiple operating metrics exceeded warning thresholds"],
        ["Evidence", f"{warning_count} warning violation(s), {critical_count} critical violation(s) in latest sample"],
        ["Recommended checks", "Inspect affected sensors, calibration, seals, and the machine process recipe"],
        ["Diagnosis status", "Maintenance required" if severity != "normal" else "Monitor"],
    ]
    print_table("3. Fault diagnosis", ["Field", "Finding"], diagnosis)

    selected_window = analysis["selected_window"]
    repair_rows = [
        ["Priority", "high" if severity == "warning" else severity],
        ["Work type", "corrective"],
        ["Repair tasks", "Validate sensors; inspect affected components; perform calibration cycle"],
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


def main() -> None:
    machine_number = input("Enter the machine number (3 digits, for example 001): ").strip()
    try:
        generate_machine_report(machine_number)
    except (ValueError, FileNotFoundError) as error:
        print(f"Error: {error}")


if __name__ == "__main__":
    main()
