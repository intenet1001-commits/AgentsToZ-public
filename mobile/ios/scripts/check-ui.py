#!/usr/bin/env python3
"""Run production UI through XCUITest on an owned, disposable simulator.

Optional AGENTSTOZ_IOS_PORTAL_URL enables anonymous HTTPS checks. Evidence can
contain the personal origin/screens: keep it local, never upload it wholesale.
No existing simulator, real account, paired host, or physical device is used.
"""
import hashlib
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import tempfile
from urllib.parse import urlsplit
import uuid

ROOT = Path(__file__).resolve().parents[3]
os.umask(0o077)
portal = os.environ.get("AGENTSTOZ_IOS_PORTAL_URL", "")
if portal:
    address = urlsplit(portal)
    if (address.scheme != "https" or not address.hostname or address.username
            or address.password or address.query or address.fragment
            or address.port not in (None, 443) or address.path not in ("", "/", "/remote/")):
        raise SystemExit("Expected a plain HTTPS personal portal origin")

base = ROOT / "mobile/ios/build/ui-evidence"
base.mkdir(parents=True, exist_ok=True)
evidence = Path(tempfile.mkdtemp(prefix="run-", dir=base))
derived = evidence / "DerivedData"
result = evidence / "UI.xcresult"
simulator = None
sources = [*sorted((ROOT / "mobile/ios/App").glob("*.swift")),
           *sorted((ROOT / "mobile/ios/AgentsToZCore/Sources/AgentsToZCore").glob("*.swift")),
           Path(__file__).resolve(),
           ROOT / "mobile/ios/UITests/WorkspaceUITests.swift",
           ROOT / "mobile/ios/AgentsToZMobile.xcodeproj/project.pbxproj",
           ROOT / "mobile/ios/AgentsToZMobile.xcodeproj/xcshareddata/xcschemes/AgentsToZMobile.xcscheme"]
report = {"actualIPhone": False, "anonymousPortal": bool(portal), "state": "running",
          "sources": {str(p.relative_to(ROOT)): hashlib.sha256(p.read_bytes()).hexdigest() for p in sources}}


def command(args, timeout=120, log=None, allow_failure=False):
    if log:
        with (evidence / log).open("w") as output:
            completed = subprocess.run(args, cwd=ROOT, stdout=output,
                                       stderr=subprocess.STDOUT, timeout=timeout)
        if completed.returncode and not allow_failure:
            raise RuntimeError(f"{args[0]} failed ({completed.returncode}); inspect {evidence / log}")
        return completed.returncode
    return subprocess.check_output(args, cwd=ROOT, stderr=subprocess.PIPE,
                                   timeout=timeout, text=True).strip()


try:
    print(f"Private UI evidence: {evidence}", flush=True)
    command(["xcodebuild", "-project", "mobile/ios/AgentsToZMobile.xcodeproj",
             "-scheme", "AgentsToZMobile", "-configuration", "Debug", "-destination",
             "generic/platform=iOS Simulator", "-derivedDataPath", str(derived),
             "CODE_SIGN_IDENTITY=-", "CODE_SIGNING_ALLOWED=YES", "build-for-testing"],
            timeout=600, log="build.log")
    run_files = list((derived / "Build/Products").glob("*.xctestrun"))
    if len(run_files) != 1:
        raise RuntimeError("Expected exactly one generated xctestrun")
    run_file = run_files[0]
    specification = plistlib.loads(run_file.read_bytes())
    version = specification["__xctestrun_metadata__"]["FormatVersion"]
    if version == 1:
        candidates = [value for key, value in specification.items() if not key.startswith("__")]
    elif version == 2:
        candidates = [target for config in specification["TestConfigurations"] for target in config["TestTargets"]]
    else:
        raise RuntimeError("Unsupported generated xctestrun format")
    targets = [target for target in candidates if target.get("BlueprintName") == "AgentsToZMobileUITests"]
    if len(targets) != 1:
        raise RuntimeError("Expected exactly one UI test target")
    if portal:
        targets[0].setdefault("EnvironmentVariables", {})["AGENTSTOZ_IOS_PORTAL_URL"] = portal
    run_file.write_bytes(plistlib.dumps(specification))
    runtimes = json.loads(command(["xcrun", "simctl", "list", "runtimes", "--json"]))["runtimes"]
    runtime = next(r for r in reversed(runtimes) if r["isAvailable"] and ".iOS-" in r["identifier"])
    types = json.loads(command(["xcrun", "simctl", "list", "devicetypes", "--json"]))["devicetypes"]
    phone = next((t for t in types if t["name"] == "iPhone 17 Pro"),
                 next(t for t in types if t["name"].startswith("iPhone")))
    simulator = command(["xcrun", "simctl", "create", "AgentsToZ UI " + uuid.uuid4().hex[:8],
                         phone["identifier"], runtime["identifier"]])
    report.update(simulator=phone["name"], runtime=runtime["version"])
    command(["xcrun", "simctl", "boot", simulator])
    print("Booting owned simulator; existing devices are untouched", flush=True)
    command(["xcrun", "simctl", "bootstatus", simulator, "-b"], timeout=480, log="boot.log")
    print("Running actual UI taps and process restart checks", flush=True)
    test_exit = command(["xcodebuild", "test-without-building", "-xctestrun", str(run_file),
             "-destination", "id=" + simulator, "-parallel-testing-enabled", "NO",
             "-resultBundlePath", str(result)], timeout=600, log="test.log", allow_failure=True)
    summary = json.loads(command(["xcrun", "xcresulttool", "get", "test-results", "summary",
                                  "--path", str(result)]))
    (evidence / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    command(["xcrun", "xcresulttool", "export", "attachments", "--path", str(result),
             "--output-path", str(evidence / "attachments")], log="attachments.log")
    report.update(passed=summary["passedTests"], skipped=summary["skippedTests"], failed=summary["failedTests"])
    if test_exit or summary["failedTests"] or summary["passedTests"] != (2 if portal else 1) or summary["skippedTests"] != (0 if portal else 1):
        raise RuntimeError("Unexpected pass/fail/skip counts; inspect summary.json")
    report.update(state="passed", passed=summary["passedTests"], skipped=summary["skippedTests"])
    print(json.dumps({key: report[key] for key in ("state", "actualIPhone", "anonymousPortal", "passed", "skipped")}), flush=True)
except BaseException:
    report["state"] = "failed"
    raise
finally:
    (evidence / "result.json").write_text(json.dumps(report, indent=2) + "\n")
    if simulator:
        for action in ("shutdown", "delete"):
            try:
                command(["xcrun", "simctl", action, simulator], timeout=60)
            except (subprocess.SubprocessError, RuntimeError) as error:
                print(f"Owned simulator cleanup {action} failed: {type(error).__name__}", flush=True)
    # Compilation products and the local portal environment are reproducible.
    # Keep only bounded-per-run logs, screenshots and the result bundle.
    shutil.rmtree(derived, ignore_errors=True)
