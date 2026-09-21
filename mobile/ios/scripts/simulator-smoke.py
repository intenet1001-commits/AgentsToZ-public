"""Launch an ad-hoc signed simulator build; never enroll a real host."""
import json
from pathlib import Path
import subprocess
import time
import uuid


def run(*args, timeout=60):
    started = time.monotonic()
    print("Starting: " + " ".join(args[:4]), flush=True)
    try:
        result = subprocess.run(args, check=True, capture_output=True, text=True, timeout=timeout)
        return result.stdout
    except subprocess.CalledProcessError as error:
        print(error.stderr[-8192:], flush=True)
        raise
    except subprocess.TimeoutExpired as error:
        output = error.stdout or b""
        print(output[-8192:].decode(errors="replace") if isinstance(output, bytes) else output[-8192:], flush=True)
        raise
    finally:
        print(f"Elapsed: {time.monotonic() - started:.1f}s", flush=True)


root = Path(__file__).resolve().parents[3]
evidence = root / "mobile/ios/build/evidence"
evidence.mkdir(parents=True, exist_ok=True)
app = root / "mobile/ios/build/DerivedData/Build/Products/Debug-iphonesimulator/AgentsToZMobile.app"
if not app.is_dir():
    raise RuntimeError("Simulator application is missing")

runtimes = json.loads(run("xcrun", "simctl", "list", "runtimes", "--json"))["runtimes"]
available = [runtime for runtime in runtimes if runtime.get("isAvailable") and ".iOS-" in runtime["identifier"]]
if not available:
    raise RuntimeError("No available iPhone simulator runtime")
runtime = available[-1]
types = json.loads(run("xcrun", "simctl", "list", "devicetypes", "--json"))["devicetypes"]
phones = [device for device in types if device["name"].startswith("iPhone")]
if not phones:
    raise RuntimeError("No available iPhone simulator device type")
device = next((device for device in phones if device["name"] == "iPhone 17 Pro"), phones[-1])
identifier = run("xcrun", "simctl", "create", "AgentsToZ Onboarding " + uuid.uuid4().hex[:8],
                 device["identifier"], runtime["identifier"]).strip()
try:
    (evidence / "selected-device.json").write_text(json.dumps(device, indent=2) + "\n")
    run("codesign", "--verify", "--deep", "--strict", str(app))
    developer = run("xcode-select", "-p").strip()
    run("xcrun", "simctl", "boot", identifier)
    run("open", str(Path(developer) / "Applications/Simulator.app"), "--args", "-CurrentDeviceUDID", identifier)
    # Fresh hosted images initialize iOS data and system apps before our app is
    # installed. The observed progress screen exceeded three minutes; keep a
    # separate, bounded cold-boot budget rather than relaxing app request limits.
    run("xcrun", "simctl", "bootstatus", identifier, "-b", timeout=480)
    run("xcrun", "simctl", "install", identifier, str(app))
    run("xcrun", "simctl", "io", identifier, "screenshot", str(evidence / "before-launch.png"))
    result = run("xcrun", "simctl", "launch", identifier, "com.intenet.agentstoz.mobile", timeout=120)
    time.sleep(4)
    # A launch exit code alone does not establish that the app stayed alive.
    processes = run("xcrun", "simctl", "spawn", identifier, "launchctl", "list")
    rows = [line.split() for line in processes.splitlines() if "com.intenet.agentstoz.mobile" in line]
    if not any(row and row[0].isdigit() and int(row[0]) > 0 for row in rows):
        raise RuntimeError("App exited immediately after launch")
    run("xcrun", "simctl", "io", identifier, "screenshot", str(evidence / "onboarding.png"))
    (evidence / "simulator.json").write_text(json.dumps({
        "device": device["name"], "runtime": runtime["version"], "ownedSimulator": True, "launch": result.strip(),
        "scope": "Onboarding launch only; camera, LAN permissions and TestFlight remain unverified"
    }, ensure_ascii=False, indent=2) + "\n")
except Exception:
    diagnostics = {
        "simulator-processes.txt": ["xcrun", "simctl", "spawn", identifier, "launchctl", "list"],
        "simulator-app.log": ["xcrun", "simctl", "spawn", identifier, "log", "show", "--style", "compact",
                              "--last", "2m", "--predicate", 'process == "AgentsToZMobile" OR process == "SpringBoard"'],
        "failure-screenshot.log": ["xcrun", "simctl", "io", identifier, "screenshot", str(evidence / "failure.png")],
    }
    for filename, args in diagnostics.items():
        try:
            result = subprocess.run(args, capture_output=True, text=True, timeout=15)
            (evidence / filename).write_text((result.stdout + result.stderr)[-65536:])
        except subprocess.TimeoutExpired:
            (evidence / filename).write_text("Diagnostic command timed out\n")
    raise
finally:
    # Never shut down or erase an existing user's simulator.
    for operation in ("shutdown", "delete"):
        try:
            subprocess.run(["xcrun", "simctl", operation, identifier], capture_output=True, timeout=30)
        except subprocess.TimeoutExpired:
            print("Owned simulator cleanup timed out: " + operation, flush=True)
