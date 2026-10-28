#!/usr/bin/env python3
"""Console entry point for the Team 8 machine report."""

import importlib.util
from pathlib import Path


FUNCTION_FILE = Path(__file__).resolve().parent / "team8-challenge0-machineFunction.py"


def load_machine_function_module():
    spec = importlib.util.spec_from_file_location("machine_function", FUNCTION_FILE)
    if spec is None or spec.loader is None:
        raise ImportError(f"Could not load {FUNCTION_FILE}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main() -> None:
    machine_number = input("Enter the machine number (3 digits, for example 001): ").strip()
    module = load_machine_function_module()
    try:
        module.generate_machine_report(machine_number)
    except (ValueError, FileNotFoundError) as error:
        print(f"Error: {error}")


if __name__ == "__main__":
    main()
