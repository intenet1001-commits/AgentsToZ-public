#!/usr/bin/env python3
"""Run this repository's persona checks through the common runner (thin wrapper).

Persona checks moved into the shared runner in 1.5.0 (`agentstoz-maintainer.py personas`),
so every project can own a catalog (`.agentstoz/personas.json`). This repository keeps its
legacy catalog at `tests/personas/catalog.json`; the runner reads either one.

This wrapper is what the `persona` profile check calls. That run already owns the project
lock and the report, so the personas run inline (`record=False`) instead of writing a second
report. Invalid catalogs raise — a label alone never passes, and neither does a broken file.
The verdict is only the tests' exit code; nothing here calls an AI.
"""
from __future__ import annotations

import argparse
import importlib.util
from pathlib import Path
import sys

sys.dont_write_bytecode = True
RUNNER_PATH = Path(__file__).resolve().parent / "agentstoz-maintainer.py"
_spec = importlib.util.spec_from_file_location("agentstoz_maintainer_runner", RUNNER_PATH)
runner = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(runner)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", default=".")
    parser.add_argument("--persona", action="append", default=[])
    parser.add_argument("--list", action="store_true")
    args = parser.parse_args(argv)
    root = Path(args.root).resolve()
    if args.list:
        relative, personas = runner.load_personas(root)
        if relative is None:
            print("No persona catalog (" + runner.PERSONA_CATALOG + ").")
            return runner.NOT_APPLICABLE_EXIT
        for persona in personas:
            if not args.persona or persona["id"] in args.persona:
                print(f"{persona['id']}: {persona['goal']}")
        return 0
    result = runner.run_personas(root, args.persona, record=False)
    if result is None:
        print("No persona catalog (" + runner.PERSONA_CATALOG + "). Nothing ran — this is not a pass.")
        return runner.NOT_APPLICABLE_EXIT
    return result["code"]


if __name__ == "__main__":
    sys.exit(main())
