#!/usr/bin/env python3
"""Repeatable real-app probe. Never substitutes a mock for a missing native bundle."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import signal
import shutil
import subprocess
import sys
import time
import tempfile

ROOT = Path(__file__).resolve().parent
BINARY = ROOT / 'bundle/agentstoz-browser-spike.app/Contents/MacOS/agentstoz-browser-spike'

def identity():
    digest = hashlib.sha256()
    files = [ROOT / 'Cargo.toml', ROOT / 'Cargo.lock', ROOT / 'build.rs', ROOT / 'tauri.conf.json', ROOT / 'verify.py']
    files += sorted((ROOT / 'src').rglob('*')) + sorted((ROOT / 'ui').rglob('*'))
    for path in files:
        if path.is_file():
            digest.update(str(path.relative_to(ROOT)).encode()); digest.update(b'\0'); digest.update(path.read_bytes())
    return digest.hexdigest()

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--build', action='store_true', help='download/build pinned official dependencies if needed')
    parser.add_argument('--contracts-only', action='store_true')
    parser.add_argument('--repeat', type=int, default=3)
    args = parser.parse_args()
    if platform.system() != 'Darwin':
        print('UNAVAILABLE: this native feasibility probe requires macOS, not a browser fixture', file=sys.stderr); return 2
    if not 1 <= args.repeat <= 5:
        parser.error('--repeat must be 1..5')
    os.chdir(ROOT)
    before = identity()
    if args.build:
        subprocess.run(['cargo', 'build', '--locked', '--bins'], check=True)
        subprocess.run([str(ROOT / 'target/debug/bundle-browser-spike')], check=True)
    if args.contracts_only:
        if not shutil.which('rustc'):
            print('UNAVAILABLE: rustc is required', file=sys.stderr); return 2
        with tempfile.TemporaryDirectory(prefix='agentstoz-browser-contracts-') as temporary:
            for name in ['control','fixture']:
                binary = Path(temporary) / name
                subprocess.run(['rustc','--edition=2021','--cfg','atz_control_standalone','--test',f'src/{name}.rs','-o',str(binary)],check=True)
                subprocess.run([str(binary)],check=True)
        return 0
    if not BINARY.is_file():
        print('UNAVAILABLE: build the native bundle with verify.py --build first', file=sys.stderr); return 2
    runs = []
    report = {'kind':'real-macos-tauri-cef-local-fixture', 'realParticipants':0, 'liveAccounts':0, 'sourceDigest':before, 'runs':runs}
    out = ROOT / 'evidence'; out.mkdir(exist_ok=True)
    for attempt in range(args.repeat):
        env = dict(os.environ, AGENTSTOZ_BROWSER_SMOKE='1')
        started = time.monotonic()
        process = subprocess.Popen([str(BINARY)], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, env=env, start_new_session=True)
        try:
            log, _ = process.communicate(timeout=40)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            log, _ = process.communicate()
        (out / f'native-{attempt + 1}.log').write_text(log)
        payloads = [line[len('ATZ_SMOKE:'):] for line in log.splitlines() if line.startswith('ATZ_SMOKE:')]
        smoke = json.loads(payloads[0]) if len(payloads) == 1 else None
        checks = smoke.get('checks', []) if smoke else []
        run = {'attempt':attempt+1, 'exitCode':process.returncode, 'seconds':round(time.monotonic()-started,3), 'checks':checks, 'state':smoke.get('state') if smoke else None}
        run['bundleMatchesSource'] = bool(smoke and smoke.get('state',{}).get('buildDigest') == before)
        run['passed'] = run['bundleMatchesSource'] and process.returncode == 0 and 'ATZ_CLEAN_EXIT:0' in log and len(checks)>=10 and all(c.get('pass') is True for c in checks)
        runs.append(run)
        print(f"native attempt {attempt+1}: {'PASS' if run['passed'] else 'FAIL'} · {len(checks)} checks · exit {process.returncode}", flush=True)
        if not run['passed']: break
    report['sourceUnchanged'] = identity() == before
    report['passed'] = len(runs) == args.repeat and all(run['passed'] for run in runs) and report['sourceUnchanged']
    (out / 'native-report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
    return 0 if report['passed'] else 1

if __name__ == '__main__':
    sys.exit(main())
