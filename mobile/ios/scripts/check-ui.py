#!/usr/bin/env python3
"""Run production UI through XCUITest.

Default: an owned, disposable simulator. No existing simulator, real account,
paired host, or physical device is used.

--device <id>: the same XCUITest on a USB-connected iPhone. The app under test is
signed as the isolated `com.intenet.agentstoz.mobile.uitest` host so the user's
real AgentsToZ apps (main, dev, TestFlight) and their saved connections are never
overwritten. Only that host and the UI test runner are installed and removed.
The team comes from --team or the shared rule in signingTeam.ts.

--plan prints the commands as JSON and runs nothing (no build, no device access).

Optional AGENTSTOZ_IOS_PORTAL_URL enables anonymous HTTPS checks. Evidence can
contain the personal origin/screens: keep it local, never upload it wholesale.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import subprocess
import tempfile
from urllib.parse import urlsplit
import uuid

ROOT = Path(__file__).resolve().parents[3]
TEST_HOST_BUNDLE = "com.intenet.agentstoz.mobile.uitest"
TEST_RUNNER_BUNDLE = "com.intenet.agentstoz.mobile.uitests.xctrunner"
os.umask(0o077)

parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
parser.add_argument("--device", help="USB-connected iPhone identifier (xcrun devicectl list devices)")
parser.add_argument("--team", help="10-character Apple Team ID for device signing")
parser.add_argument("--plan", action="store_true", help="print the planned commands and exit")
options = parser.parse_args()
if options.device is not None and not re.fullmatch(r"[0-9A-Fa-f-]{20,64}", options.device):
    parser.error("--device must be a connected device identifier")
if options.team is not None and not re.fullmatch(r"[A-Z0-9]{10}", options.team):
    parser.error("--team must be a 10-character Apple Team ID")
if options.team is not None and options.device is None:
    parser.error("--team only applies to --device runs")
device = options.device

portal = os.environ.get("AGENTSTOZ_IOS_PORTAL_URL", "")
if portal:
    address = urlsplit(portal)
    if (address.scheme != "https" or not address.hostname or address.username
            or address.password or address.query or address.fragment
            or address.port not in (None, 443) or address.path not in ("", "/", "/remote/")):
        raise SystemExit("Expected a plain HTTPS personal portal origin")


def resolve_team():
    """Share the installer's rule instead of re-implementing it in Python."""
    args = ["bun", str(ROOT / "mobile/ios/scripts/signingTeam.ts")]
    if options.team:
        args += ["--team", options.team]
    completed = subprocess.run(args, cwd=ROOT, capture_output=True, text=True, timeout=60)
    if completed.returncode:
        raise SystemExit(completed.stderr.strip() or "Apple Development team could not be resolved")
    return json.loads(completed.stdout)["team"]


# --plan never inspects the keychain, so an unspecified team stays a visible placeholder
# (the real run resolves it through signingTeam.ts).
PLAN_TEAM_PLACEHOLDER = "<resolved-by-signingTeam.ts>"
team = ((options.team or PLAN_TEAM_PLACEHOLDER) if options.plan else resolve_team()) if device else None


def build_args(derived):
    common = ["xcodebuild", "-project", "mobile/ios/AgentsToZMobile.xcodeproj",
              "-scheme", "AgentsToZMobile", "-configuration", "Debug", "-derivedDataPath", str(derived)]
    if not device:
        return common + ["-destination", "generic/platform=iOS Simulator",
                         "CODE_SIGN_IDENTITY=-", "CODE_SIGNING_ALLOWED=YES", "build-for-testing"]
    # AGENTSTOZ_APP_BUNDLE_ID only renames the app target. A global PRODUCT_BUNDLE_IDENTIFIER
    # would also rename the UI test runner and collide with the host.
    return common + ["-destination", "id=" + device, "-allowProvisioningUpdates",
                     "DEVELOPMENT_TEAM=" + team, "AGENTSTOZ_APP_BUNDLE_ID=" + TEST_HOST_BUNDLE,
                     "AGENTSTOZ_DISPLAY_NAME=AgentsToZ UI 시험", "AGENTSTOZ_RELEASE_CHANNEL=ui-test",
                     # The app and share extension ask for group.<bundle id> (VOC share outbox). The isolated
                     # test bundles' team profiles carry no App Group, so signing failed with "doesn't match the
                     # entitlements file's value for com.apple.security.application-groups" and the device
                     # lane never built. Creating that group is an Apple account change; the test host needs
                     # none (VocShareOutbox treats a missing container as no outbox).
                     "CODE_SIGN_ENTITLEMENTS=",
                     "build-for-testing"]


def uninstall_owned():
    return [["xcrun", "devicectl", "device", "uninstall", "app", "--device", device, bundle]
            for bundle in (TEST_HOST_BUNDLE, TEST_RUNNER_BUNDLE)]


if options.plan:
    placeholder = Path("<evidence>")
    destination = "id=" + device if device else "id=<owned-simulator>"
    commands = [build_args(placeholder / "DerivedData")]
    if device:
        commands += uninstall_owned()
    else:
        commands += [["xcrun", "simctl", "create", "AgentsToZ UI <random>", "<iPhone>", "<runtime>"]]
    commands += [["xcodebuild", "test-without-building", "-xctestrun", "<generated.xctestrun>",
                  "-destination", destination, "-parallel-testing-enabled", "NO",
                  "-resultBundlePath", str(placeholder / "UI.xcresult")]]
    cleanup = uninstall_owned() if device else [["xcrun", "simctl", action, "<owned-simulator>"]
                                                for action in ("shutdown", "delete")]
    print(json.dumps({"mode": "device" if device else "simulator", "actualIPhone": bool(device),
                      "device": device, "team": team,
                      "appBundleId": TEST_HOST_BUNDLE if device else "com.intenet.agentstoz.mobile",
                      "anonymousPortal": bool(portal), "commands": commands, "cleanup": cleanup}, indent=2))
    raise SystemExit(0)

base = ROOT / ("mobile/ios/build/ui-device-evidence" if device else "mobile/ios/build/ui-evidence")
base.mkdir(parents=True, exist_ok=True)
evidence = Path(tempfile.mkdtemp(prefix="run-", dir=base))
derived = evidence / "DerivedData"
result = evidence / "UI.xcresult"
simulator = None
device_touched = False
sources = [*sorted((ROOT / "mobile/ios/App").glob("*.swift")),
           *sorted((ROOT / "mobile/ios/AgentsToZCore/Sources/AgentsToZCore").glob("*.swift")),
           Path(__file__).resolve(),
           ROOT / "mobile/ios/UITests/WorkspaceUITests.swift",
           ROOT / "mobile/ios/AgentsToZMobile.xcodeproj/project.pbxproj",
           ROOT / "mobile/ios/AgentsToZMobile.xcodeproj/xcshareddata/xcschemes/AgentsToZMobile.xcscheme"]
head = subprocess.run(["git", "rev-parse", "HEAD"], cwd=ROOT, capture_output=True, text=True)
report = {"actualIPhone": bool(device), "anonymousPortal": bool(portal), "state": "running",
          "gitHead": head.stdout.strip() if head.returncode == 0 else None,
          "appBundleId": TEST_HOST_BUNDLE if device else "com.intenet.agentstoz.mobile",
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
    command(build_args(derived), timeout=900 if device else 600, log="build.log")
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
    if device:
        # Start from a fresh host: a previous run's stored portal would hide onboarding.
        device_touched = True
        for index, args in enumerate(uninstall_owned()):
            command(args, timeout=60, log=f"pre-clean-{index}.log", allow_failure=True)
        report.update(device=device, team=team)
        destination = "id=" + device
        print("Using the USB iPhone; only the isolated UI test host and runner are installed", flush=True)
    else:
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
        destination = "id=" + simulator
    print("Running actual UI taps and process restart checks", flush=True)
    test_exit = command(["xcodebuild", "test-without-building", "-xctestrun", str(run_file),
             "-destination", destination, "-parallel-testing-enabled", "NO",
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
    if device_touched:
        for args in uninstall_owned():
            try:
                command(args, timeout=60)
            except (subprocess.SubprocessError, RuntimeError) as error:
                print(f"Owned UI test app removal failed: {type(error).__name__}", flush=True)
    if simulator:
        for action in ("shutdown", "delete"):
            try:
                command(["xcrun", "simctl", action, simulator], timeout=60)
            except (subprocess.SubprocessError, RuntimeError) as error:
                print(f"Owned simulator cleanup {action} failed: {type(error).__name__}", flush=True)
    # Compilation products and the local portal environment are reproducible.
    # Keep only bounded-per-run logs, screenshots and the result bundle.
    shutil.rmtree(derived, ignore_errors=True)
