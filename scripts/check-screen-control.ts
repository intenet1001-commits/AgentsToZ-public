// Screen-control security core checks (native/screen-control). Compiles the sources with the checks as one
// module (swiftc -D CORE_CHECKS), so it runs without Xcode's XCTest, like mobile/ios/scripts/check-native.ts.
// `bun scripts/check-screen-control.ts [packageDir]` — the optional directory lets a mutated copy be checked.
// Then the status file the main app's work-mode panel reads (ScreenHost/ScreenStatusFile.swift): written by the Swift
// type, it must equal Tests/StatusContract/status.json, the sample src-tauri/src/screen_helper.rs is tested against.
import {deepStrictEqual, strictEqual} from 'node:assert';
import {existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';

const packagePath = resolve(process.argv[2] ?? join(import.meta.dir, '..', 'native', 'screen-control'));
const sourceDir = join(packagePath, 'Sources', 'ScreenControlCore');
const checkDir = join(packagePath, 'Tests', 'ScreenControlCoreTests');
const temporary = mkdtempSync(join(tmpdir(), 'agentstoz-screen-control-'));
try {
  const swiftFiles = (dir: string) => readdirSync(dir).filter(name => name.endsWith('.swift')).sort().map(name => join(dir, name));
  const binary = join(temporary, 'checks');
  const compile = Bun.spawnSync(['swiftc', '-swift-version', '6', '-D', 'CORE_CHECKS', '-parse-as-library',
    ...swiftFiles(sourceDir), ...swiftFiles(checkDir), '-o', binary], {stderr: 'pipe'});
  if (compile.exitCode !== 0) throw Error('Swift compilation failed:\n' + compile.stderr.toString());
  const run = Bun.spawnSync([binary], {stdout: 'pipe', stderr: 'pipe', timeout: 60_000});
  console.log(run.stdout.toString().trim());
  if (run.exitCode !== 0) throw Error('Screen-control checks failed ' + run.stderr.toString());

  const statusDir = join(temporary, 'status'), statusPath = join(statusDir, 'AgentsToZ Screen', 'status.json');
  const statusMain = join(temporary, 'main.swift'), statusBinary = join(temporary, 'status-check');
  writeFileSync(statusMain, `import Foundation
let url = URL(fileURLWithPath: CommandLine.arguments[1])
var status = ScreenStatus(pid: 4242, power: .off, viewing: false, devices: 0, capture: false, control: true, loginItem: .off, updatedAt: 1)
try ScreenStatusFile.write(status, to: url)
status = ScreenStatus(pid: 4242, power: .on, viewing: true, devices: 2, capture: true, control: false, loginItem: .approval, updatedAt: 1793000000000)
try ScreenStatusFile.write(status, to: url)
var later = status; later.updatedAt += 5000
var changed = status; changed.devices = 3
guard status.sameState(as: later), !status.sameState(as: changed), !status.sameState(as: nil) else { exit(2) }
// On but off an approved network: the spelling src-tauri/src/screen_helper.rs and src/workModeScreenHelper.ts read.
var waiting = status; waiting.power = .waiting
guard let json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(waiting)) as? [String: Any],
      json["power"] as? String == "waiting", !status.sameState(as: waiting) else { exit(5) }
// Quitting removes only its own file: another process's stays, its own goes.
ScreenStatusFile.remove(at: url, pid: 1)
guard FileManager.default.fileExists(atPath: url.path) else { exit(3) }
let own = url.deletingLastPathComponent().appending(path: "own.json")
try ScreenStatusFile.write(status, to: own)
ScreenStatusFile.remove(at: own, pid: 4242)
guard !FileManager.default.fileExists(atPath: own.path) else { exit(4) }
`);
  const statusCompile = Bun.spawnSync(['swiftc', '-swift-version', '6', join(packagePath, 'Sources', 'ScreenHost', 'ScreenStatusFile.swift'),
    statusMain, '-o', statusBinary], {stderr: 'pipe'});
  if (statusCompile.exitCode !== 0) throw Error('Status file compilation failed:\n' + statusCompile.stderr.toString());
  const statusRun = Bun.spawnSync([statusBinary, statusPath], {stderr: 'pipe'});
  if (statusRun.exitCode !== 0) throw Error('Status file check failed ' + statusRun.stderr.toString());
  deepStrictEqual(JSON.parse(readFileSync(statusPath, 'utf8')),
    JSON.parse(readFileSync(join(packagePath, 'Tests', 'StatusContract', 'status.json'), 'utf8')));
  strictEqual(statSync(statusPath).mode & 0o777, 0o600);
  strictEqual(statSync(join(statusDir, 'AgentsToZ Screen')).mode & 0o777, 0o700);
  deepStrictEqual(readdirSync(join(statusDir, 'AgentsToZ Screen')), ['status.json']);
  if (!existsSync(statusPath)) throw Error('status file missing');
  console.log('status file: matches the main app contract, owner-only, replaced in one rename');
  // The shared portable suite cannot compile macOS event taps. Keep the pure native ledger regressions in the
  // configured ios-core check too; these tests never create a tap, request TCC or post an input event.
  // ScreenControllerTests: the Mac controllers store, grant, session limits and capture exclusion, in memory, never the keychain.
  // WeeklyUsageOutboxTests: the main app's weekly-alert hand-off files, read strictly and removed before sending, in a temp folder.
  if (process.platform === 'darwin') {
    const host = Bun.spawnSync(['swift', 'test', '--package-path', packagePath, '--filter', 'LocalInputMonitorTests|ScreenControllerTests|WeeklyUsageOutboxTests'],
      {stdout: 'pipe', stderr: 'pipe', timeout: 180_000});
    if (host.exitCode !== 0) throw Error('Native local-input ledger checks failed:\n' + host.stdout.toString() + host.stderr.toString());
    console.log(host.stdout.toString().trim());
  }

} finally {
  rmSync(temporary, {recursive: true, force: true});
}
