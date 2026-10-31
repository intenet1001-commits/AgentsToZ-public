// AgentsToZ Control checks (native/computer-use). Builds nothing that runs on its own and starts no service.
// 1. Compiles the pure core (Sources/ComputerUseControlCore) and the approval contract with the checks as one module
//    (swiftc -D CORE_CHECKS), so it runs without Xcode's XCTest or the Peekaboo checkout, and runs them against the
//    shared XPC samples (Tests/ControlContract/requests.json).
// 2. Lints the Info.plist, LaunchAgent and entitlements the packaging script writes (scripts/computerUseControlBundle.ts).
// The main app's client bridge belongs to the main app (src-tauri/native/computer-use) and is checked there.
// `bun scripts/check-computer-use-control.ts [packageDir]`.
import {mkdtempSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {controlEntitlements, controlInfoPlist, controlLaunchAgentPlist} from './computerUseControlBundle';

const packagePath = resolve(process.argv[2] ?? join(import.meta.dir, '..', 'native', 'computer-use'));
const temporary = mkdtempSync(join(tmpdir(), 'agentstoz-computer-use-control-'));
const swiftFiles = (dir: string) => readdirSync(dir).filter(name => name.endsWith('.swift')).sort().map(name => join(dir, name));
try {
  const binary = join(temporary, 'checks');
  const compile = Bun.spawnSync(['swiftc', '-swift-version', '6', '-D', 'CORE_CHECKS', '-parse-as-library',
    ...swiftFiles(join(packagePath, 'Sources', 'ComputerUseApproval')),
    ...swiftFiles(join(packagePath, 'Sources', 'ComputerUseControlCore')),
    ...swiftFiles(join(packagePath, 'Tests', 'ComputerUseControlCoreChecks')), '-o', binary], {stderr: 'pipe'});
  if (compile.exitCode !== 0) throw Error('Swift compilation failed:\n' + compile.stderr.toString());
  const run = Bun.spawnSync([binary, join(packagePath, 'Tests', 'ControlContract', 'requests.json')], {stdout: 'pipe', stderr: 'pipe', timeout: 60_000});
  console.log(run.stdout.toString().trim());
  if (run.exitCode !== 0) throw Error('Computer-use control checks failed ' + run.stderr.toString());

  for (const [name, text] of [['Info.plist', controlInfoPlist('0.1')], ['agent.plist', controlLaunchAgentPlist()],
    ['entitlements.plist', controlEntitlements()]] as const) {
    const path = join(temporary, name); writeFileSync(path, text);
    const lint = Bun.spawnSync(['plutil', '-lint', path], {stdout: 'pipe', stderr: 'pipe'});
    if (lint.exitCode !== 0) throw Error(`${name} is not a valid property list:\n${lint.stdout}${lint.stderr}`);
  }
  console.log('bundle templates: Info.plist, LaunchAgent and entitlements are valid property lists');
} finally {
  rmSync(temporary, {recursive: true, force: true});
}
