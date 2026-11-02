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

--screen-gestures uses the real touch surface in an isolated simulator probe and never replaces the production
app's entry point. Its gesture tests connect nowhere. Its viewer tests (ScreenViewerUITests, J2-SCREEN-SIM,
「Core + 표면만」) connect only to the fixture Screen host this script starts on 127.0.0.1
(scripts/emulator-e2e/screenFixtureHost.ts serve --mode viewer: sandboxed, synthetic capture, input recorded and never
injected), with keys that host made for this run. Its pins file stays in an owner-only scratch folder that is deleted
at the end; only that file's path goes into the xctestrun. Both ends are judged by
scripts/emulator-e2e/screenViewerJudge.ts. --no-screen-viewer leaves the viewer tests and the host out; the probe
and its simulator-only loopback transport are compiled either way, so the fallback builds the same app target.

The normal simulator lane also runs the same-network journey (test20, J1-LAN-APP): a sandboxed LAN journey host
(lan-journey-host.ts supervise: its own Seatbelt profile and LAN binding guard, fixture projects, a fake CLI, scripted
consent) listens on this Mac's en0 private IPv4, and the real app pairs with it by its one-time same-network URL. The
URL stays in a 0600 file the test reads; only the journey folder goes into the xctestrun. Whether the journey can run
is asked before anything is built (lan-journey-host.ts probe): with no private address on en0, or with the macOS
application firewall on (a listener on en0 could raise a prompt nobody may answer), test20 is skipped — recorded as
`lanJourneyBlocked` in result.json and expected as a skip, never counted as a pass — and the rest of the lane runs as
before. --require-lan-journey (the emulator harness lane) turns that into a blocked run instead (exit 78, before the
build). A device run skips test20 and starts no host.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import plistlib
import queue
import re
import shutil
import subprocess
import tempfile
import threading
import time
from urllib.parse import urlsplit
import uuid

ROOT = Path(__file__).resolve().parents[3]
TEST_HOST_BUNDLE = "com.intenet.agentstoz.mobile.uitest"
TEST_RUNNER_BUNDLE = "com.intenet.agentstoz.mobile.uitests.xctrunner"
LAN_JOURNEY_HOST = "mobile/ios/scripts/lan-journey-host.ts"
LAN_JOURNEY_ENV = "AGENTSTOZ_LAN_JOURNEY_DIR"
BLOCKED_EXIT = 78
GESTURE_LANE_PASSES = 7
# The normal lane's tests and when each one runs (the rest skip). Counts are derived from this table, so a new
# test adds one line here: "always", "portal" (AGENTSTOZ_IOS_PORTAL_URL given) or "lan" (a simulator run whose
# same-network journey host can run on this Mac: not --device, en0 private IPv4, firewall off).
NORMAL_LANE_TESTS = (
    ("test00OnboardingAcceptsKoreanInputAndRejectsUnsupportedAddress", "always"),
    ("test10PersonalWorkspaceSettingsTabsAndColdLaunch", "portal"),
    ("test20SameNetworkJourneyPairsProjectAndWorkroom", "lan"),
    ("test30MacControllerInviteIsRejectedByDeviceRegistration", "simulator"),
)
# XCTest's activity log and the result bundle record what test20 typed: the one-time pairing URL, consumed by then.
CONSUMED_TOKEN_EVIDENCE = ("UI.xcresult", "test.log", "attachments")
PAIR_TOKEN = re.compile(r"#pair=[A-Za-z0-9_-]{8,}")
SCREEN_VIEWER_PASSES = 2
SCREEN_FIXTURE_HOST = "scripts/emulator-e2e/screenFixtureHost.ts"
SCREEN_VIEWER_JUDGE = "scripts/emulator-e2e/screenViewerJudge.ts"
SCREEN_FIXTURE_PINS_ENV = "AGENTSTOZ_SCREEN_FIXTURE_PINS"
# (source under mobile/ios, the copied project's file it sits beside: same group, same target)
# The probe app refers to the loopback transport in every --screen-gestures build (its viewer mode is chosen at launch),
# so that file is compiled into the gesture-only fallback too; only the viewer UI tests depend on the fixture host.
SCREEN_GESTURE_SOURCES = (("UITests/Fixtures/LoopbackFrameTransport.swift", "AgentsToZMobileApp.swift"),)
# (source under mobile/ios, the copied project's file it replaces): the probe is the app's entry point there.
SCREEN_GESTURE_REPLACEMENTS = (("UITests/Fixtures/ScreenGestureProbeApp.swift", "App/AgentsToZMobileApp.swift"),
                               ("UITests/ScreenGestureUITests.swift", "UITests/WorkspaceUITests.swift"))
SCREEN_VIEWER_SOURCES = (("UITests/ScreenViewerUITests.swift", "WorkspaceUITests.swift"),)
RESERVED_PORTS = (3001, 52741, 4723)
os.umask(0o077)


def expected_outcomes(on_device, with_portal, screen_gestures, lan_journey=True):
    """Expected passes/skips (and the outcome of each normal-lane test) for this run's mode."""
    if screen_gestures:
        return {"passed": GESTURE_LANE_PASSES + (SCREEN_VIEWER_PASSES if SCREEN_VIEWER else 0), "skipped": 0, "tests": None}
    tests = {}
    for name, condition in NORMAL_LANE_TESTS:
        runs = (condition == "always" or (condition == "portal" and with_portal)
                or (condition == "lan" and not on_device and lan_journey)
                or (condition == "simulator" and not on_device))
        tests[name] = "passed" if runs else "skipped"
    passed = sum(1 for outcome in tests.values() if outcome == "passed")
    return {"passed": passed, "skipped": len(tests) - passed, "tests": tests}


def test_case_outcomes(log_text):
    """`Test Case '-[AgentsToZMobileUITests.WorkspaceUITests <name>]' passed|failed|skipped` lines of test.log."""
    pattern = r"Test Case '-\[AgentsToZMobileUITests\.WorkspaceUITests (\w+)\]' (passed|failed|skipped)"
    return {name: outcome for name, outcome in re.findall(pattern, log_text)}

parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
parser.add_argument("--device", help="USB-connected iPhone identifier (xcrun devicectl list devices)")
parser.add_argument("--team", help="10-character Apple Team ID for device signing")
parser.add_argument("--plan", action="store_true", help="print the planned commands and exit")
parser.add_argument("--screen-gestures", action="store_true", help="test the production touch surface in an isolated simulator probe")
parser.add_argument("--boundary-only", action="store_true", help="run only the simulator's synthetic controller invitation rejection")
parser.add_argument("--evidence-root", help="folder that receives this run's run-* evidence (the emulator harness lane's own folder)")
parser.add_argument("--lan-address", help="en0 private IPv4 for the same-network journey host (default: measured by the host)")
parser.add_argument("--lan-port", type=int, help="port for the same-network journey host (default: a free port on en0, chosen when the host starts)")
parser.add_argument("--require-lan-journey", action="store_true",
                    help="a journey that cannot run here makes the run blocked (exit 78) instead of skipping test20")
parser.add_argument("--no-screen-viewer", action="store_true", help="--screen-gestures without the fixture Screen host viewer tests")
parser.add_argument("--screen-host-sandbox-base", help="SBPL base file for the fixture Screen host (the emulator harness's host profile)")
parser.add_argument("--screen-host-state-parent", help="folder (outside the real home) for the fixture Screen host's owner-only scratch")
options = parser.parse_args()
if options.boundary_only and (options.device or options.screen_gestures or options.lan_address or options.lan_port or options.require_lan_journey):
    parser.error("--boundary-only is simulator-only and cannot start the LAN or gesture lanes")
if options.screen_gestures and options.device:
    parser.error("--screen-gestures only runs in an owned disposable simulator")
if (options.lan_address or options.lan_port or options.require_lan_journey) and (options.device or options.screen_gestures):
    parser.error("--lan-address/--lan-port/--require-lan-journey apply only to the normal simulator lane")
if options.lan_address is not None and not re.fullmatch(r"(10|172|192)\.\d{1,3}\.\d{1,3}\.\d{1,3}", options.lan_address):
    parser.error("--lan-address must be a private IPv4 address")
if options.lan_port is not None and (not 1024 <= options.lan_port <= 65535 or options.lan_port in (3001, 52741, 4723)):
    parser.error("--lan-port must be 1024-65535 and not a reserved port (3001, 52741, 4723)")
if (options.no_screen_viewer or options.screen_host_sandbox_base or options.screen_host_state_parent) and not options.screen_gestures:
    parser.error("--no-screen-viewer and --screen-host-* apply only to --screen-gestures")
if options.no_screen_viewer and (options.screen_host_sandbox_base or options.screen_host_state_parent):
    parser.error("--screen-host-* need the viewer tests (drop --no-screen-viewer)")
SCREEN_VIEWER = bool(options.screen_gestures and not options.no_screen_viewer)
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
EXPECTED_COUNTS = ({"passed": GESTURE_LANE_PASSES + (SCREEN_VIEWER_PASSES if SCREEN_VIEWER else 0), "skipped": 0}
                   if options.screen_gestures else {"passed": 2 if portal else 1, "skipped": 0 if portal else 1})


def gesture_project_sources():
    """What --screen-gestures copies into the disposable project: (source under mobile/ios, copied as)."""
    if not options.screen_gestures:
        return []
    added = SCREEN_GESTURE_SOURCES + (SCREEN_VIEWER_SOURCES if SCREEN_VIEWER else ())
    return [*SCREEN_GESTURE_REPLACEMENTS,
            *((source, ("App/" if sibling == "AgentsToZMobileApp.swift" else "UITests/") + Path(source).name)
              for source, sibling in added)]


def screen_host_args(state_dir, evidence_dir):
    args = ["bun", "--env-file=/dev/null", SCREEN_FIXTURE_HOST, "serve", "--mode", "viewer",
            "--state-dir", str(state_dir), "--evidence-dir", str(evidence_dir)]
    if options.screen_host_sandbox_base:
        args += ["--sandbox-base", options.screen_host_sandbox_base]
    return args


LAN_JOURNEY = not device and not options.screen_gestures and not options.boundary_only
EXPECTED = expected_outcomes(bool(device), bool(portal), options.screen_gestures)
if options.boundary_only:
    EXPECTED = {"passed": 1, "skipped": 0, "tests": {"test30MacControllerInviteIsRejectedByDeviceRegistration": "passed"}}
# What this run expects when the journey turns out not to be able to run here (probe before the build, or the host
# refusing at start): test20 skipped. With --require-lan-journey that case is a blocked run instead.
EXPECTED_IF_LAN_BLOCKED = expected_outcomes(bool(device), bool(portal), options.screen_gestures, lan_journey=False)


def lan_probe_args():
    args = ["bun", "--env-file=/dev/null", LAN_JOURNEY_HOST, "probe"]
    if options.lan_address:
        args += ["--address", options.lan_address]
    return args


def lan_host_args(evidence_dir):
    args = ["bun", "--env-file=/dev/null", LAN_JOURNEY_HOST, "supervise", "--evidence-dir", str(evidence_dir)]
    if options.lan_address:
        args += ["--address", options.lan_address]
    if options.lan_port:
        args += ["--port", str(options.lan_port)]
    return args


def build_args(derived):
    project = (str(derived.parent / "GestureProject/AgentsToZMobile.xcodeproj")
               if options.screen_gestures else "mobile/ios/AgentsToZMobile.xcodeproj")
    common = ["xcodebuild", "-project", project,
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
    only_boundary = ["-only-testing:AgentsToZMobileUITests/WorkspaceUITests/test30MacControllerInviteIsRejectedByDeviceRegistration"] if options.boundary_only else []
    commands += [["xcodebuild", "test-without-building", "-xctestrun", "<generated.xctestrun>",
                  "-destination", destination, "-parallel-testing-enabled", "NO",
                  "-resultBundlePath", str(placeholder / "UI.xcresult"), *only_boundary]]
    if LAN_JOURNEY:
        # Asked before the build (binds nothing); the host starts after the boot, before the tests, and stops (stdin
        # closed) right after them.
        commands.insert(0, lan_probe_args())
        commands.insert(len(commands) - 1, lan_host_args(placeholder / "lan-journey"))
    if SCREEN_VIEWER:
        # Started before the build (it builds and gates the fixture meanwhile), ready before the tests, stopped after them.
        commands.insert(len(commands) - 1, screen_host_args(Path("<owner-only scratch>"), placeholder / "screen-host"))
        commands.append(["bun", "--env-file=/dev/null", SCREEN_VIEWER_JUDGE, "judge", "--run-dir", str(placeholder)])
    cleanup = uninstall_owned() if device else [["xcrun", "simctl", action, "<owned-simulator>"]
                                                for action in ("shutdown", "delete")]
    print(json.dumps({"mode": "device" if device else "simulator", "actualIPhone": bool(device),
                      "device": device, "team": team,
                      "appBundleId": TEST_HOST_BUNDLE if device else "com.intenet.agentstoz.mobile",
                      "anonymousPortal": bool(portal), "lanJourney": LAN_JOURNEY,
                      "requireLanJourney": options.require_lan_journey, "expected": EXPECTED_COUNTS if options.screen_gestures else EXPECTED,
                      "expectedIfLanBlocked": None if options.require_lan_journey else EXPECTED_IF_LAN_BLOCKED,
                      "screenGestures": options.screen_gestures, "screenViewer": SCREEN_VIEWER,
                      "gestureProjectSources": [{"source": "mobile/ios/" + source, "as": copied}
                                                for source, copied in gesture_project_sources()],
                      "commands": commands, "cleanup": cleanup}, indent=2))
    raise SystemExit(0)

base = (Path(options.evidence_root).resolve() if options.evidence_root
        else ROOT / ("mobile/ios/build/ui-device-evidence" if device else "mobile/ios/build/ui-evidence"))
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
           ROOT / LAN_JOURNEY_HOST,
           ROOT / "mobile/ios/AgentsToZMobile.xcodeproj/project.pbxproj",
           ROOT / "mobile/ios/AgentsToZMobile.xcodeproj/xcshareddata/xcschemes/AgentsToZMobile.xcscheme"]
head = subprocess.run(["git", "rev-parse", "HEAD"], cwd=ROOT, capture_output=True, text=True)
report = {"actualIPhone": bool(device), "anonymousPortal": bool(portal), "state": "running",
          "lanJourney": LAN_JOURNEY, "expected": EXPECTED,
          "gitHead": head.stdout.strip() if head.returncode == 0 else None,
          "appBundleId": TEST_HOST_BUNDLE if device else "com.intenet.agentstoz.mobile",
          "sources": {str(p.relative_to(ROOT)): hashlib.sha256(p.read_bytes()).hexdigest() for p in sources}}
if options.screen_gestures:
    for relative in (*(f"mobile/ios/{source}" for source, _ in gesture_project_sources()), SCREEN_VIEWER_JUDGE,
                     *((SCREEN_FIXTURE_HOST,) if SCREEN_VIEWER else ())):
        report["sources"][relative] = hashlib.sha256((ROOT / relative).read_bytes()).hexdigest()
    report["mode"] = "screen-gestures"
    report.update(screenViewer=SCREEN_VIEWER, expected=EXPECTED_COUNTS, label="Core+표면만" if SCREEN_VIEWER else None)
timings = {}
started = time.monotonic()


def timed(name, since):
    timings[name] = round(time.monotonic() - since, 1)
    report["timings"] = timings
    return time.monotonic()


def prepare_gesture_project():
    """Copy only the test host. The production app entry point and project stay unchanged."""
    source = ROOT / "mobile/ios"
    project = evidence / "GestureProject"
    shutil.copytree(source / "AgentsToZMobile.xcodeproj", project / "AgentsToZMobile.xcodeproj")
    shutil.copytree(source / "App", project / "App")
    (project / "UITests").mkdir()
    for relative, copied in SCREEN_GESTURE_REPLACEMENTS:
        shutil.copy2(source / relative, project / copied)
    for name in ("Config", "ShareExtension", "scripts"):
        (project / name).symlink_to(source / name, target_is_directory=True)
    (project / "build").mkdir()
    (project / "build/portal-web").symlink_to(source / "build/portal-web", target_is_directory=True)
    pbx = project / "AgentsToZMobile.xcodeproj/project.pbxproj"
    converted = subprocess.check_output(["plutil", "-convert", "xml1", "-o", "-", str(pbx)])
    specification = plistlib.loads(converted)
    for item in specification["objects"].values():
        if item.get("isa") == "XCLocalSwiftPackageReference":
            item["relativePath"] = str((source / item["relativePath"]).resolve())
    for relative, sibling in SCREEN_GESTURE_SOURCES + (SCREEN_VIEWER_SOURCES if SCREEN_VIEWER else ()):
        folder = project / ("App" if sibling == "AgentsToZMobileApp.swift" else "UITests")
        shutil.copy2(source / relative, folder / Path(relative).name)
        add_source_beside(specification["objects"], sibling, Path(relative).name)
    pbx.write_bytes(plistlib.dumps(specification))


lan_host = None

def only(items, what):
    if len(items) != 1:
        raise RuntimeError(f"expected exactly one {what} in the copied project, found {len(items)}")
    return items[0]


def add_source_beside(objects, sibling, name):
    """Adds `name` to the group and the Sources phase that hold `sibling`: one file reference, one build file."""
    reference = only([key for key, item in objects.items() if item.get("isa") == "PBXFileReference" and item.get("path") == sibling],
                     f"file reference {sibling}")
    group = only([item for item in objects.values() if item.get("isa") == "PBXGroup" and reference in item.get("children", [])],
                 f"group holding {sibling}")
    built = only([key for key, item in objects.items() if item.get("isa") == "PBXBuildFile" and item.get("fileRef") == reference],
                 f"build file for {sibling}")
    phase = only([item for item in objects.values() if item.get("isa") == "PBXSourcesBuildPhase" and built in item.get("files", [])],
                 f"Sources phase compiling {sibling}")
    new_reference, new_build = (uuid.uuid4().hex[:24].upper() for _ in range(2))
    objects[new_reference] = {"isa": "PBXFileReference", "lastKnownFileType": "sourcecode.swift", "path": name, "sourceTree": "<group>"}
    objects[new_build] = {"isa": "PBXBuildFile", "fileRef": new_reference}
    group["children"].append(new_reference)
    phase["files"].append(new_build)


screen_host = None


def write_report():
    (evidence / "result.json").write_text(json.dumps(report, indent=2) + "\n")


class Blocked(Exception):
    pass


def probe_lan_journey():
    """Before anything is built: can the journey host run on this Mac (en0 private IPv4, firewall off)? Binds nothing.
    Returns None when it can, else the reason. A probe that answers neither way is a failure, not a skip."""
    bun = shutil.which("bun")
    if not bun:
        raise RuntimeError("bun is not on PATH; the same-network journey host cannot start")
    args = lan_probe_args()
    args[0] = bun
    completed = subprocess.run(args, cwd=ROOT, capture_output=True, text=True, timeout=60)
    answer = None
    try:
        answer = json.loads(completed.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        pass
    report["lanJourneyProbe"] = {"exit": completed.returncode, "available": (answer or {}).get("available"),
                                 "firewall": (answer or {}).get("firewall"), "reason": (answer or {}).get("reason")}
    if completed.returncode == 0 and answer and answer.get("available") is True:
        return None
    if completed.returncode == BLOCKED_EXIT and answer and answer.get("available") is False and answer.get("reason"):
        return str(answer["reason"])
    raise RuntimeError(f"the same-network journey probe failed (exit {completed.returncode}); stderr: {completed.stderr.strip()[-300:]}")


def skip_lan_journey(reason):
    """The journey cannot run here: test20 is expected to skip (never a pass) and the reason is on the record."""
    global LAN_JOURNEY, EXPECTED
    LAN_JOURNEY = False
    EXPECTED = EXPECTED_IF_LAN_BLOCKED
    report.update(lanJourney=False, lanJourneyBlocked=reason, expected=EXPECTED)
    write_report()
    print(f"Same-network journey blocked: {reason} — test20 will be skipped (not counted as a pass)", flush=True)


def start_lan_host():
    """Starts the sandboxed journey host and waits for its one ready line (it carries no token)."""
    bun = shutil.which("bun")
    if not bun:
        raise RuntimeError("bun is not on PATH; the same-network journey host cannot start")
    host_evidence = evidence / "lan-journey"
    args = lan_host_args(host_evidence)
    args[0] = bun
    stderr = (evidence / "lan-journey-supervisor.log").open("w")
    process = subprocess.Popen(args, cwd=ROOT, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=stderr, text=True)
    lines = queue.Queue()

    def pump():
        for line in process.stdout:
            lines.put(line)
        lines.put(None)
    threading.Thread(target=pump, daemon=True).start()
    try:
        line = lines.get(timeout=150)
    except queue.Empty:
        line = None
    ready = None
    if line:
        try:
            ready = json.loads(line)
        except ValueError:
            ready = None
    if not ready or ready.get("ready") is not True:
        try:
            process.stdin.close()
            process.wait(timeout=60)
        except (OSError, subprocess.TimeoutExpired):
            process.kill()
            process.wait()
        stderr.close()
        if process.returncode == BLOCKED_EXIT or (ready and ready.get("blocked")):
            raise Blocked(str((ready or {}).get("blocked") or "the same-network journey host is blocked"))
        raise RuntimeError(f"the same-network journey host did not become ready (exit {process.returncode}); inspect {host_evidence}")
    report["lanJourneyHost"] = {"address": ready.get("address"), "port": ready.get("port"), "profileSha256": ready.get("profileSha256")}
    return {"process": process, "stderr": stderr, "journeyDir": ready["journeyDir"], "evidence": host_evidence}


def stop_lan_host(host):
    """Closing stdin stops the host; the supervisor then judges its receipts into host-verdict.json."""
    process = host["process"]
    try:
        process.stdin.close()
    except OSError:
        pass
    try:
        process.wait(timeout=120)
    except subprocess.TimeoutExpired:
        process.terminate()
        try:
            process.wait(timeout=60)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
    host["stderr"].close()
    verdict = None
    try:
        verdict = json.loads((host["evidence"] / "host-verdict.json").read_text())
    except (OSError, ValueError):
        pass
    report["lanJourneyVerdict"] = {"exit": process.returncode, "ok": bool(verdict and verdict.get("ok")),
                                   "problems": (verdict or {}).get("problems", ["no host-verdict.json"])[:20],
                                   "counts": (verdict or {}).get("counts")}
    return process.returncode == 0 and bool(verdict and verdict.get("ok"))


def token_leaks():
    """Evidence files outside the marked consumed-token files that carry a #pair= token."""
    leaks = []
    for path in sorted(evidence.rglob("*")):
        relative = path.relative_to(evidence)
        if relative.parts[0] in CONSUMED_TOKEN_EVIDENCE or relative.parts[0] == "DerivedData" or not path.is_file():
            continue
        try:
            if path.stat().st_size <= 32 * 1024 * 1024 and PAIR_TOKEN.search(path.read_bytes().decode("utf-8", "replace")):
                leaks.append(str(relative))
        except OSError:
            continue
    return leaks

def start_screen_host():
    """Starts the fixture Screen host's `serve` and returns at once: it builds and gates the fixture while the app builds."""
    bun = shutil.which("bun")
    if not bun:
        raise RuntimeError("bun is not on PATH; the fixture Screen host cannot start")
    state = Path(tempfile.mkdtemp(prefix="agentstoz-screen-host-", dir=options.screen_host_state_parent or None))
    args = screen_host_args(state, evidence / "screen-host")
    report["screenViewerHost"] = {"command": args[:], "state": "owner-only scratch, deleted at the end"}
    args[0] = bun
    log = (evidence / "screen-host-serve.log").open("w")
    process = subprocess.Popen(args, cwd=ROOT, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=log, text=True)
    host = {"process": process, "log": log, "state": state, "events": [], "condition": threading.Condition(),
            "done": threading.Event()}

    def pump():
        for line in process.stdout:
            try:
                event = json.loads(line)
            except ValueError:
                event = None
            with host["condition"]:
                host["events"].append(event if isinstance(event, dict) else {"event": "unparsed", "line": line[:200]})
                host["condition"].notify_all()
        with host["condition"]:
            host["events"].append({"event": "closed"})
            host["condition"].notify_all()
    threading.Thread(target=pump, daemon=True).start()
    return host


def host_event(host, test, timeout):
    deadline = time.monotonic() + timeout
    with host["condition"]:
        while True:
            found = next((event for event in host["events"] if test(event)), None)
            remaining = deadline - time.monotonic()
            if found is not None or remaining <= 0:
                return found
            host["condition"].wait(remaining)


def send_host(host, command):
    host["process"].stdin.write(json.dumps(command) + "\n")
    host["process"].stdin.flush()


def screen_host_ready(host):
    """Waits for the ready line (no key material: the keys stay in the pins file) and checks where it points."""
    ready = host_event(host, lambda event: event.get("event") in ("ready", "error", "closed", "host-exited"), 600)
    if not ready or ready.get("event") != "ready":
        raise RuntimeError(f"the fixture Screen host did not become ready ({json.dumps(ready)[:300]}); inspect screen-host-serve.log")
    pins = Path(str(ready.get("pinsPath", ""))).resolve()
    if ready.get("mode") != "viewer" or not isinstance(ready.get("port"), int) or ready["port"] in RESERVED_PORTS:
        raise RuntimeError(f"unexpected fixture Screen host: mode {ready.get('mode')} port {ready.get('port')}")
    if host["state"].resolve() not in pins.parents or not pins.is_file() or (pins.stat().st_mode & 0o777) != 0o600:
        raise RuntimeError("the fixture pins file is not an owner-only file in the host's own scratch")
    (evidence / "screen-host-ready.json").write_text(json.dumps(ready, indent=2) + "\n")
    host["barAck"] = pins.parent / "bar-view-observed"
    report["screenViewerHost"].update(port=ready["port"], protocolVersion=ready.get("protocolVersion"),
                                      macFingerprint=ready.get("macFingerprint"), label=(ready.get("label") or {}).get("label"),
                                      sandboxProfileSha256=ready.get("sandboxProfileSha256"))
    threading.Thread(target=end_after_text, args=(host,), daemon=True).start()
    return str(pins)


def end_after_text(host):
    """Once the host has recorded the probe's text-and-Return, ends that session from the Mac (scripted and recorded)."""
    path = evidence / "screen-host" / "input-events.jsonl"
    while not host["done"].is_set():
        try:
            lines = path.read_text(errors="replace").splitlines()
        except OSError:
            lines = []
        for line in lines:
            try:
                record = json.loads(line)
            except ValueError:
                continue
            event = record.get("event") if isinstance(record, dict) else None
            if record.get("source") == "phone" and isinstance(event, dict) and event.get("kind") == "textAndReturn" and event.get("text") == "hello":
                try:
                    for action in ("status", "pause", "view"):
                        request_id = "bar-" + action
                        send_host(host, {"id": request_id, "op": "bar", "action": action})
                        reply = host_event(host, lambda item: item.get("event") == "reply" and item.get("id") == request_id, 30)
                        report["screenViewerHost"].setdefault("bar", {})[action] = reply
                    deadline = time.monotonic() + 30
                    while not host["barAck"].is_file() and time.monotonic() < deadline and not host["done"].is_set():
                        host["done"].wait(0.1)
                    report["screenViewerHost"]["barObservedByPhone"] = host["barAck"].is_file()
                    send_host(host, {"id": "end-after-text", "op": "end", "reason": "endedAtMac"})
                except (OSError, ValueError):
                    return
                reply = host_event(host, lambda item: item.get("event") == "reply" and item.get("id") == "end-after-text", 30)
                report["screenViewerHost"]["endReply"] = reply
                return
        host["done"].wait(0.5)


def stop_screen_host(host):
    """Stops the host (it writes its stopped receipt), then deletes its scratch: keys, pins and the fixture build."""
    host["done"].set()
    process = host["process"]
    try:
        send_host(host, {"op": "stop"})
        process.stdin.close()
    except (OSError, ValueError):
        pass
    try:
        process.wait(timeout=90)
    except subprocess.TimeoutExpired:
        process.terminate()
        try:
            process.wait(timeout=30)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
    host["log"].close()
    stopped = host_event(host, lambda event: event.get("event") == "stopped", 5)
    shutil.rmtree(host["state"], ignore_errors=True)
    report["screenViewerHost"].update(exit=process.returncode, stopped=stopped, stateRemoved=not host["state"].exists())
    return process.returncode == 0 and stopped is not None


def judge_screen_viewer():
    """Both ends of this run (phone attachments and test outcomes, host receipts) with the shared judge."""
    bun = shutil.which("bun")
    if not bun:
        return {"ok": False, "problems": ["bun is not on PATH; the run could not be judged"]}
    args = [bun, "--env-file=/dev/null", SCREEN_VIEWER_JUDGE, "judge", "--run-dir", str(evidence)]
    completed = subprocess.run(args + ([] if SCREEN_VIEWER else ["--no-screen-viewer"]), cwd=ROOT,
                               capture_output=True, text=True, timeout=120)
    try:
        verdict = json.loads(completed.stdout)
    except ValueError:
        verdict = {"ok": False, "problems": [f"the judge printed no verdict (exit {completed.returncode}): {completed.stderr[-300:]}"]}
    (evidence / "screen-viewer-verdict.json").write_text(json.dumps(verdict, indent=2) + "\n")
    return verdict


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
    if LAN_JOURNEY:
        # Before the build and boot: a Mac where the journey cannot run learns it now, not twenty minutes in.
        lan_unavailable = probe_lan_journey()
        if lan_unavailable:
            if options.require_lan_journey:
                raise Blocked(lan_unavailable)
            skip_lan_journey(lan_unavailable)
    if options.screen_gestures:
        prepare_gesture_project()
    if SCREEN_VIEWER:
        screen_host = start_screen_host()
    phase = time.monotonic()
    command(["bun", "mobile/ios/scripts/build-portal-web.ts"], timeout=300, log="portal-build.log")
    phase = timed("portalBuild", phase)
    command(build_args(derived), timeout=900 if device else 600, log="build.log")
    phase = timed("build", phase)
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
    if portal and not options.screen_gestures:
        targets[0].setdefault("EnvironmentVariables", {})["AGENTSTOZ_IOS_PORTAL_URL"] = portal
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
        # Recorded at once, so a run killed before its cleanup still names the device to remove.
        report.update(simulator=phone["name"], runtime=runtime["version"], simulatorUdid=simulator,
                      simulatorRuntime=runtime["identifier"])
        write_report()
        command(["xcrun", "simctl", "boot", simulator])
        print("Booting owned simulator; existing devices are untouched", flush=True)
        command(["xcrun", "simctl", "bootstatus", simulator, "-b"], timeout=480, log="boot.log")
        destination = "id=" + simulator
        phase = timed("simulatorBoot", phase)
    if LAN_JOURNEY:
        try:
            lan_host = start_lan_host()
        except Blocked as blocked:
            # en0 or the firewall changed since the probe. The harness lane wants a blocked run; a plain run skips test20.
            if options.require_lan_journey:
                raise
            skip_lan_journey(str(blocked))
    if lan_host:
        # Only the journey folder: the one-time URL stays in its 0600 file there.
        targets[0].setdefault("EnvironmentVariables", {})[LAN_JOURNEY_ENV] = lan_host["journeyDir"]
        report["consumedFixtureToken"] = {"files": list(CONSUMED_TOKEN_EVIDENCE),
                                          "note": "test20 typed the one-time same-network URL; the host consumed it and has stopped"}
        print("Same-network journey host ready (sandboxed, en0 only)", flush=True)
    if screen_host:
        # Only the pins file's path: the keys stay in that owner-only file in the host's scratch.
        targets[0].setdefault("EnvironmentVariables", {})[SCREEN_FIXTURE_PINS_ENV] = screen_host_ready(screen_host)
        phase = timed("screenHostReadyWait", phase)
        print("Fixture Screen host ready (sandboxed, 127.0.0.1 only, synthetic capture, input recorded)", flush=True)
    run_file.write_bytes(plistlib.dumps(specification))
    print("Running actual UI taps and process restart checks", flush=True)
    only_boundary = ["-only-testing:AgentsToZMobileUITests/WorkspaceUITests/test30MacControllerInviteIsRejectedByDeviceRegistration"] if options.boundary_only else []
    test_exit = command(["xcodebuild", "test-without-building", "-xctestrun", str(run_file),
             "-destination", destination, "-parallel-testing-enabled", "NO",
             "-resultBundlePath", str(result), *only_boundary], timeout=600, log="test.log", allow_failure=True)
    phase = timed("tests", phase)
    lan_host_was_started = bool(lan_host)
    host_ok = None
    if lan_host:
        host_ok = stop_lan_host(lan_host)
        lan_host = None
    if screen_host:
        host_ok = stop_screen_host(screen_host)
        screen_host = None
    summary = json.loads(command(["xcrun", "xcresulttool", "get", "test-results", "summary",
                                  "--path", str(result)]))
    (evidence / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    command(["xcrun", "xcresulttool", "export", "attachments", "--path", str(result),
             "--output-path", str(evidence / "attachments")], log="attachments.log")
    outcomes = test_case_outcomes((evidence / "test.log").read_text(errors="replace"))
    report.update(passed=summary["passedTests"], skipped=summary["skippedTests"], failed=summary["failedTests"], tests=outcomes)
    problems = []
    if test_exit or summary["failedTests"] or summary["passedTests"] != EXPECTED["passed"] or summary["skippedTests"] != EXPECTED["skipped"]:
        problems.append(f"counts passed {summary['passedTests']}/skipped {summary['skippedTests']}/failed {summary['failedTests']}"
                        f" (exit {test_exit}), expected {EXPECTED['passed']}/{EXPECTED['skipped']}/0")
    if EXPECTED["tests"] is not None and outcomes != EXPECTED["tests"]:
        problems.append(f"per-test outcomes {outcomes} != expected {EXPECTED['tests']}")
    if host_ok is False and lan_host_was_started:
        problems.append("the same-network journey host's receipts failed; inspect lan-journey/host-verdict.json")
    leaks = token_leaks()
    if leaks:
        problems.append(f"#pair= token outside the marked files: {', '.join(leaks)}")
    if options.screen_gestures:
        verdict = judge_screen_viewer()
        report["screenViewerVerdict"] = {"ok": verdict.get("ok") is True, "problems": (verdict.get("problems") or [])[:20],
                                         "tests": (verdict.get("tests") or {}).get("observed"), "phone": verdict.get("phone"),
                                         "host": verdict.get("host")}
        if verdict.get("ok") is not True:
            problems.append("both-ends verdict: " + "; ".join((verdict.get("problems") or ["no verdict"])[:10]))
    if host_ok is False and options.screen_gestures:
        problems.append("the fixture Screen host did not stop cleanly; inspect screen-host-serve.log")
    report["problems"] = problems
    if problems:
        raise RuntimeError("Unexpected UI test result: " + "; ".join(problems))
    report.update(state="passed", passed=summary["passedTests"], skipped=summary["skippedTests"])
    print(json.dumps({key: report.get(key) for key in ("state", "actualIPhone", "anonymousPortal", "lanJourney", "lanJourneyBlocked", "passed", "skipped")}), flush=True)
except Blocked as blocked:
    report.update(state="blocked", reason=str(blocked))
    print(json.dumps({"state": "blocked", "reason": str(blocked)}), flush=True)
    raise SystemExit(BLOCKED_EXIT)
except BaseException:
    report["state"] = "failed"
    raise
finally:
    if lan_host:
        try:
            stop_lan_host(lan_host)
        except Exception as error:  # cleanup continues to the simulator
            print(f"Same-network journey host stop failed: {type(error).__name__}", flush=True)
    if screen_host:
        try:
            stop_screen_host(screen_host)
        except Exception as error:  # cleanup continues to the simulator
            print(f"Fixture Screen host stop failed: {type(error).__name__}", flush=True)
            shutil.rmtree(screen_host["state"], ignore_errors=True)
    timings["total"] = round(time.monotonic() - started, 1)
    report["timings"] = timings
    write_report()
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
    if options.screen_gestures:
        shutil.rmtree(evidence / "GestureProject", ignore_errors=True)
