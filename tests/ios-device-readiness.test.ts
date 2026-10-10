import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DEFAULT_IOS_DEVELOPMENT_TEAM, resolveDevelopmentTeam } from '../mobile/ios/scripts/signingTeam';

const root = resolve(import.meta.dir, '..');
const checkUi = resolve(root, 'mobile/ios/scripts/check-ui.py');
const DEVICE = '00008110-000A1B2C3D4E5F60';

// This Mac carries two Apple Development teams. The README command used to fail outright
// with "Several Apple Development teams are installed" because nothing chose between them.
test('USB signing prefers the TestFlight team when several development teams are installed', () => {
  expect(DEFAULT_IOS_DEVELOPMENT_TEAM).toBe('DA8QKAQ2C9');
  expect(resolveDevelopmentTeam(['76FK5FFLTC', 'DA8QKAQ2C9'])).toEqual({ team: 'DA8QKAQ2C9', source: 'default' });
});

test('an explicit team wins, and a single installed team needs no flag', () => {
  expect(resolveDevelopmentTeam(['76FK5FFLTC', 'DA8QKAQ2C9'], '76FK5FFLTC')).toEqual({ team: '76FK5FFLTC', source: 'requested' });
  expect(resolveDevelopmentTeam(['76FK5FFLTC'])).toEqual({ team: '76FK5FFLTC', source: 'only-installed' });
});

test('team resolution never guesses: missing default, unknown request or no identity all fail with the choices', () => {
  expect(() => resolveDevelopmentTeam(['AAAAAAAAAA', 'BBBBBBBBBB'])).toThrow(/--team <team-id>.*AAAAAAAAAA, BBBBBBBBBB/);
  expect(() => resolveDevelopmentTeam(['76FK5FFLTC', 'DA8QKAQ2C9'], 'CCCCCCCCCC')).toThrow(/CCCCCCCCCC.*76FK5FFLTC, DA8QKAQ2C9/);
  expect(() => resolveDevelopmentTeam([])).toThrow('A matching Apple Development signing identity is required.');
  expect(() => resolveDevelopmentTeam(['DA8QKAQ2C9'], 'lowercase1')).toThrow('--team must be a 10-character Apple Team ID.');
});

test('install-development resolves the team through the shared rule, not its own copy', () => {
  const script = readFileSync(resolve(root, 'mobile/ios/scripts/install-development.ts'), 'utf8');
  expect(script).toContain('resolveDevelopmentTeam(');
  expect(script).not.toContain('Several Apple Development teams are installed. Retry with --team');
});

// A device UI run installs a test host, so it must never reuse the bundle of the user's real
// app (main, dev or TestFlight): overwriting it would destroy the saved Mac connection.
test('the app target bundle is a build setting so a device UI run can use an isolated host', () => {
  const project = readFileSync(resolve(root, 'mobile/ios/AgentsToZMobile.xcodeproj/project.pbxproj'), 'utf8');
  expect(project.match(/AGENTSTOZ_APP_BUNDLE_ID = com\.intenet\.agentstoz\.mobile;/g)).toHaveLength(2);
  expect(project.match(/PRODUCT_BUNDLE_IDENTIFIER = "\$\(AGENTSTOZ_APP_BUNDLE_ID\)";/g)).toHaveLength(2);
  expect(project.match(/PRODUCT_BUNDLE_IDENTIFIER = com\.intenet\.agentstoz\.mobile\.uitests;/g)).toHaveLength(2);
});

function plan(...args: string[]) {
  const run = Bun.spawnSync(['python3', checkUi, ...args, '--plan'], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  return { code: run.exitCode, out: new TextDecoder().decode(run.stdout), err: new TextDecoder().decode(run.stderr) };
}

test('check-ui --device plans a signed real-device run against an isolated, owned test host', () => {
  const result = plan('--device', DEVICE, '--team', 'DA8QKAQ2C9');
  expect(result.code).toBe(0);
  const parsed = JSON.parse(result.out) as { mode: string; actualIPhone: boolean; appBundleId: string; team: string; commands: string[][]; cleanup: string[][] };
  expect(parsed.mode).toBe('device');
  expect(parsed.actualIPhone).toBe(true);
  expect(parsed.team).toBe('DA8QKAQ2C9');
  expect(parsed.appBundleId).toBe('com.intenet.agentstoz.mobile.uitest');
  const flat = parsed.commands.map(command => command.join(' ')).join('\n');
  expect(flat).toContain(`-destination id=${DEVICE}`);
  expect(flat).toContain('-allowProvisioningUpdates');
  expect(flat).toContain('DEVELOPMENT_TEAM=DA8QKAQ2C9');
  expect(flat).toContain('AGENTSTOZ_APP_BUNDLE_ID=com.intenet.agentstoz.mobile.uitest');
  // A global PRODUCT_BUNDLE_IDENTIFIER would also rename the UI test runner.
  expect(flat).not.toContain('PRODUCT_BUNDLE_IDENTIFIER=');
  expect(flat).not.toMatch(/simctl|CODE_SIGN_IDENTITY=-/);
  // The isolated test profiles have no App Group; requesting one made the device build fail (2026-10-09).
  expect(parsed.commands[0]).toContain('CODE_SIGN_ENTITLEMENTS=');
  // Only the bundles this run owns are ever removed from the phone.
  const removed = parsed.cleanup.filter(command => command.includes('uninstall')).map(command => command.at(-1));
  expect(removed.sort()).toEqual(['com.intenet.agentstoz.mobile.uitest', 'com.intenet.agentstoz.mobile.uitests.xctrunner']);
  for (const real of ['com.intenet.agentstoz.mobile', 'com.intenet.agentstoz.mobile.dev', 'com.intenet.agentstoz.mobile.testflight']) {
    expect(`${flat}\n${parsed.cleanup.map(command => command.join(' ')).join('\n')}`).not.toMatch(new RegExp(`(^|[ =])${real.replaceAll('.', '\\.')}($|\\s)`, 'm'));
  }
});

// The checklist tells people to preview a device run with `--device <id> --plan` and no team.
// That used to crash with a Python TypeError instead of printing the plan.
test('check-ui --device --plan without --team prints a placeholder team instead of crashing', () => {
  const result = plan('--device', DEVICE);
  expect(result.err).not.toContain('Traceback');
  expect(result.code).toBe(0);
  const parsed = JSON.parse(result.out) as { team: string; commands: string[][] };
  expect(parsed.team).toBe('<resolved-by-signingTeam.ts>');
  expect(parsed.commands[0]).toContain('DEVELOPMENT_TEAM=<resolved-by-signingTeam.ts>');
});

test('check-ui keeps the simulator default and rejects malformed device or team values', () => {
  const simulator = JSON.parse(plan().out) as { mode: string; actualIPhone: boolean; commands: string[][] };
  expect(simulator.mode).toBe('simulator');
  expect(simulator.actualIPhone).toBe(false);
  expect(simulator.commands.map(command => command.join(' ')).join('\n')).toContain('CODE_SIGN_IDENTITY=-');
  expect(plan('--device', 'not a device', '--team', 'DA8QKAQ2C9').code).not.toBe(0);
  expect(plan('--device', DEVICE, '--team', 'short').code).not.toBe(0);
  expect(plan('--team', 'DA8QKAQ2C9').code).not.toBe(0);
});
