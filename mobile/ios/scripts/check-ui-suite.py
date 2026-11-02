#!/usr/bin/env python3
"""Run normal SwiftUI journeys and production Screen gestures in separate owned disposable simulators."""
from pathlib import Path
import subprocess
import sys

if __name__ == "__main__":
    runner = Path(__file__).with_name("check-ui.py")
    # The combined ios-ui runtime has not yet been measured against the 1500 s
    # budget. Keep viewer coverage in the opt-in sandboxed J2 lane until it is.
    for arguments in ([], ["--screen-gestures", "--no-screen-viewer"]):
        subprocess.run([sys.executable, str(runner), *arguments], check=True)
