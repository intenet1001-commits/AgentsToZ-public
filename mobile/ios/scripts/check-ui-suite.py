#!/usr/bin/env python3
"""Run normal SwiftUI journeys and production Screen gestures in separate owned disposable simulators."""
from pathlib import Path
import subprocess
import sys

if __name__ == "__main__":
    runner = Path(__file__).with_name("check-ui.py")
    for arguments in ([], ["--screen-gestures"]):
        subprocess.run([sys.executable, str(runner), *arguments], check=True)
