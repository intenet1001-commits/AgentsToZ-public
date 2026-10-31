import {afterAll, describe, expect, test} from 'bun:test';
import {existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename, join} from 'node:path';
import {CONTROL_AGENT_LABEL, CONTROL_AGENT_PLIST, CONTROL_BUNDLE_ID, CONTROL_EXECUTABLE, CONTROL_HELPER_REQUIREMENT, CONTROL_MACH_SERVICE,
  CONTROL_PRODUCT, CONTROL_TEAM_ID, controlEntitlements, controlInfoPlist, controlLaunchAgentPlist} from '../scripts/computerUseControlBundle';
import {controlBuildSummary, controlCodesignArguments, controlNotaryPaths, notarizeControlApp, parseControlBuildArgs, readControlSignature}
  from '../scripts/build-computer-use-control-app';
import type {CheckProcessResult, CheckRunner} from '../src/macOSNotaryPreflight';

// AgentsToZ Control's bundle files agree with the Swift constants and the main app's bridge contract (CONTRACT.md),
// and the packaging script cannot install, register, start or sign implicitly.
const native = (path: string) => readFileSync(join(import.meta.dir, '..', 'native', 'computer-use', path), 'utf8');

describe('AgentsToZ Control bundle', () => {
  test('the bundle, Mach service and LaunchAgent names match the Swift contract', () => {
    const protocol = native('Sources/ComputerUseControlCore/ControlProtocol.swift');
    expect(protocol).toContain(`machService = "${CONTROL_MACH_SERVICE}"`);
    expect(protocol).toContain(`agentLabel = "${CONTROL_AGENT_LABEL}"`);
    expect(protocol).toContain(`agentPlistName = "${CONTROL_AGENT_PLIST}"`);
    const approval = native('Sources/ComputerUseApproval/Approval.swift');
    expect(approval).toContain(`helperIdentifier = "${CONTROL_BUNDLE_ID}"`);
    expect(approval).toContain(`team = "${CONTROL_TEAM_ID}"`);
    expect(native('Package.swift')).toContain(`.executable(name: "${CONTROL_PRODUCT}", targets: ["AgentsToZControl"])`);
  });

  test('Info.plist: a menu bar app with its own identity', () => {
    const info = controlInfoPlist('0.1');
    expect(info).toContain(`<key>CFBundleIdentifier</key><string>${CONTROL_BUNDLE_ID}</string>`);
    expect(info).toContain(`<key>CFBundleExecutable</key><string>${CONTROL_EXECUTABLE}</string>`);
    expect(info).toContain('<key>LSUIElement</key><true/>');
    expect(() => controlInfoPlist('1.0; rm -rf')).toThrow();
  });

  test('the LaunchAgent starts the app on demand for the one Mach service, never at load', () => {
    const agent = controlLaunchAgentPlist();
    expect(agent).toContain(`<key>Label</key><string>${CONTROL_AGENT_LABEL}</string>`);
    expect(agent).toContain(`<key>BundleProgram</key><string>Contents/MacOS/${CONTROL_EXECUTABLE}</string>`);
    expect(agent).toContain(`<key>MachServices</key><dict><key>${CONTROL_MACH_SERVICE}</key><true/></dict>`);
    expect(agent).toContain(`<key>AssociatedBundleIdentifiers</key><array><string>${CONTROL_BUNDLE_ID}</string></array>`);
    expect(agent).toContain('<key>RunAtLoad</key><false/>');
    expect(agent).not.toContain('ProgramArguments');
    expect(agent).not.toContain('EnvironmentVariables');
  });

  test('entitlements give the approval key its own keychain group, nothing more', () => {
    const entitlements = controlEntitlements();
    expect(entitlements).toContain(`<key>keychain-access-groups</key><array><string>${CONTROL_TEAM_ID}.${CONTROL_BUNDLE_ID}</string></array>`);
    expect(entitlements).not.toContain('get-task-allow');
    expect(entitlements).not.toContain('disable-library-validation');
    expect(entitlements).not.toContain('allow-dyld-environment-variables');
  });

  test("the requirement checked after signing is the main app bridge's helper requirement", () => {
    expect(CONTROL_HELPER_REQUIREMENT).toBe('anchor apple generic and identifier "com.intenet.agentstozbycs.control" and certificate leaf[subject.OU] = "DA8QKAQ2C9" and certificate leaf[field.1.2.840.113635.100.6.1.13] exists');
    expect(native('CONTRACT.md')).toContain(CONTROL_HELPER_REQUIREMENT);
  });

  test('the packaging script only builds: no install, launchctl, SMAppService, permission prompt or implicit identity', () => {
    const script = readFileSync(join(import.meta.dir, '..', 'scripts', 'build-computer-use-control-app.ts'), 'utf8');
    const code = script.split('\n').filter(line => !line.trimStart().startsWith('//')).join('\n');
    for (const forbidden of ['launchctl', 'SMAppService', '/Applications', "'open'", 'tccutil', 'AXIsProcessTrustedWithOptions', '--install',
      'store-credentials', '--password', '--apple-id'])
      expect(code).not.toContain(forbidden);
    expect(code).toContain("'--disable-automatic-resolution'");
    expect(code).toContain("throw Error('--sign and --profile go together')");
    // Importing the script for its helpers must not build anything.
    expect(code).toContain('if (import.meta.main) main();');
  });
});

describe('AgentsToZ Control signing timestamp and opt-in notarization', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'agentstoz-control-test-'));
  const provisioning = join(scratch, 'control.provisionprofile');
  writeFileSync(provisioning, 'fixture');
  const defaultApp = join(scratch, 'AgentsToZ Control.app');
  const signedArgs = ['--sign', 'Developer ID Application: Test (DA8QKAQ2C9)', '--profile', provisioning];
  afterAll(() => rmSync(scratch, {recursive: true, force: true}));

  test('a signed build asks codesign for a secure timestamp by default', () => {
    // Regression: without an explicit --timestamp the signature used --timestamp=none, which Apple's notary service rejects.
    const options = parseControlBuildArgs(signedArgs, defaultApp);
    expect(options.timestamp).toBe('secure');
    const codesign = controlCodesignArguments(options.identity!, '/tmp/e.plist', defaultApp, options.timestamp);
    expect(codesign).toContain('--timestamp');
    expect(codesign).not.toContain('--timestamp=none');
    expect(codesign.slice(0, 3)).toEqual(['--force', '--options', 'runtime']);
    // The old explicit flag still works and means the same.
    expect(parseControlBuildArgs([...signedArgs, '--timestamp'], defaultApp).timestamp).toBe('secure');
    expect(controlBuildSummary({appPath: defaultApp, configuration: 'release', signed: true, timestamp: 'secure', secureTimestamp: 'Oct 28, 2026 at 10:07:50'}))
      .toMatchObject({signed: true, secureTimestamp: true, notarizable: true, notarized: false});
  });

  test('--timestamp=none is an explicit local-only opt-out that says it is not notarizable', () => {
    const options = parseControlBuildArgs([...signedArgs, '--timestamp=none'], defaultApp);
    expect(options.timestamp).toBe('none');
    expect(controlCodesignArguments(options.identity!, '/tmp/e.plist', defaultApp, options.timestamp)).toContain('--timestamp=none');
    const summary = controlBuildSummary({appPath: defaultApp, configuration: 'release', signed: true, timestamp: 'none', secureTimestamp: null});
    expect(summary).toMatchObject({signed: true, secureTimestamp: false, notarizable: false, notarized: false});
    expect(summary.note).toContain('not notarizable');
    expect(() => parseControlBuildArgs(['--timestamp=none'], defaultApp)).toThrow('--timestamp=none applies only to a signed build');
    expect(() => parseControlBuildArgs([...signedArgs, '--timestamp', '--timestamp=none'], defaultApp)).toThrow('not both');
    expect(() => parseControlBuildArgs([...signedArgs, '--timestamp=none', '--notarize', '--notary-profile', 'p'], defaultApp))
      .toThrow('never notarizable');
    expect(controlBuildSummary({appPath: defaultApp, configuration: 'debug', signed: false, timestamp: 'secure'}))
      .toMatchObject({signed: false, notarizable: false, notarized: false});
  });

  test('the signature display tells a secure timestamp from a local signing time', () => {
    const cdHash = 'CDHash=0123456789abcdef0123456789abcdef01234567';
    expect(readControlSignature(`Identifier=${CONTROL_BUNDLE_ID}\n${cdHash}\nTimestamp=Oct 28, 2026 at 10:07:50 AM\n`))
      .toEqual({secureTimestamp: 'Oct 28, 2026 at 10:07:50 AM', cdHash: '0123456789abcdef0123456789abcdef01234567'});
    // What the handoff's helper showed: Developer ID and hardened runtime, but only `Signed Time=`.
    expect(readControlSignature(`${cdHash}\nSigned Time=Oct 28, 2026 at 10:07:50 AM\n`).secureTimestamp).toBeNull();
    expect(readControlSignature(`${cdHash}\nTimestamp=none\n`).secureTimestamp).toBeNull();
    expect(() => readControlSignature('Timestamp=Oct 28, 2026')).toThrow('CDHash');
  });

  test('--notarize is opt-in, needs a signed build and an existing profile, and validates it before anything runs', () => {
    expect(parseControlBuildArgs(signedArgs, defaultApp).notary).toBeUndefined();
    expect(parseControlBuildArgs([...signedArgs, '--notarize', '--notary-profile', 'agentstoz-release'], defaultApp).notary)
      .toEqual({profile: 'agentstoz-release'});
    expect(parseControlBuildArgs([...signedArgs, '--notarize', '--notary-profile', 'p', '--notary-keychain', '/k/login.keychain-db'], defaultApp).notary)
      .toEqual({profile: 'p', keychain: '/k/login.keychain-db'});
    expect(() => parseControlBuildArgs(['--notarize', '--notary-profile', 'p'], defaultApp)).toThrow('needs a signed build');
    expect(() => parseControlBuildArgs([...signedArgs, '--notarize'], defaultApp)).toThrow('--notary-profile');
    expect(() => parseControlBuildArgs([...signedArgs, '--notary-profile', 'p'], defaultApp)).toThrow('go with --notarize');
    expect(() => parseControlBuildArgs([...signedArgs, '--notarize', '--notary-profile', 'p\npassword'], defaultApp)).toThrow();
    expect(() => parseControlBuildArgs([...signedArgs, '--notarize', '--notary-profile', 'p', '--notary-keychain', 'login.keychain-db'], defaultApp)).toThrow();
  });

  const SUBMISSION = '2f1c3d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
  const CD_HASH = '0123456789abcdef0123456789abcdef01234567';
  type Reply = Partial<CheckProcessResult> & {writeLog?: string};
  // `recheck`/`recheckLocked` answer only the read-only preflight that runs after an unconfirmed submission.
  function notaryFixture(overrides: {screenLocked?: boolean | null; history?: Reply; submit?: Reply; log?: Reply; spctl?: Reply;
    recheck?: Reply; recheckLocked?: boolean} = {}) {
    const dir = mkdtempSync(join(scratch, 'out-'));
    const appPath = join(dir, 'AgentsToZ Control.app');
    const calls: {command: string; args: string[]}[] = [];
    const reply = (value: Reply | undefined, fallback: CheckProcessResult): CheckProcessResult => ({...fallback, ...value});
    const submitted = () => calls.some(call => call.args[0] === 'notarytool' && call.args[1] === 'submit');
    const run: CheckRunner = (command, args) => {
      calls.push({command, args});
      if (command === '/usr/bin/osascript') {
        const locked = submitted() && overrides.recheckLocked !== undefined ? overrides.recheckLocked : overrides.screenLocked ?? false;
        return {status: 0, stdout: JSON.stringify({screenLocked: locked}), stderr: ''};
      }
      if (args[0] === 'notarytool' && args[1] === 'history') {
        return reply(submitted() && overrides.recheck ? overrides.recheck : overrides.history, {status: 0, stdout: '{"history":[]}', stderr: ''});
      }
      if (args[0] === 'notarytool' && args[1] === 'submit') return reply(overrides.submit, {status: 0, stdout: JSON.stringify({id: SUBMISSION, status: 'Accepted', message: 'Processing complete'}), stderr: ''});
      if (args[0] === 'notarytool' && args[1] === 'log') {
        const answer = overrides.log ?? {writeLog: JSON.stringify({jobId: SUBMISSION, status: 'Accepted', issues: null})};
        if (answer.writeLog !== undefined) writeFileSync(args[args.length - 1]!, answer.writeLog);
        return reply(answer, {status: 0, stdout: '', stderr: ''});
      }
      if (command === '/usr/sbin/spctl') return reply(overrides.spctl, {status: 0, stdout: '', stderr: `${appPath}: accepted\nsource=Notarized Developer ID\norigin=Developer ID Application: Test (DA8QKAQ2C9)`});
      return {status: 0, stdout: '', stderr: ''};
    };
    const lines: string[] = [];
    const notarize = () => notarizeControlApp({appPath, version: '0.1', cdHash: CD_HASH, secureTimestamp: 'Oct 28, 2026 at 10:07:50 AM',
      notary: {profile: 'agentstoz-release'}, workDir: dir}, run, line => lines.push(line));
    const steps = () => calls.map(call => call.command === '/usr/bin/xcrun' ? `${call.args[0]} ${call.args[1]}` : basename(call.command));
    return {dir, appPath, calls, lines, notarize, steps, paths: controlNotaryPaths(appPath)};
  }
  const auth = ['--keychain-profile', 'agentstoz-release'];

  test('notarization preflights, submits with --wait using the same auth, staples, checks Gatekeeper and writes a receipt', () => {
    const f = notaryFixture();
    const receipt = f.notarize();
    expect(f.steps()).toEqual(['osascript', 'notarytool history', 'ditto', 'notarytool submit', 'notarytool log', 'stapler staple', 'stapler validate', 'codesign', 'spctl']);
    expect(f.calls[1]!.args).toEqual(['notarytool', 'history', ...auth, '--output-format', 'json']);
    expect(f.calls[2]!.args).toEqual(['-c', '-k', '--sequesterRsrc', '--keepParent', f.appPath, join(f.dir, 'AgentsToZ Control.zip')]);
    expect(f.calls[3]!.args).toEqual(['notarytool', 'submit', join(f.dir, 'AgentsToZ Control.zip'), ...auth, '--wait', '--timeout', '60m', '--output-format', 'json']);
    expect(f.calls[4]!.args).toEqual(['notarytool', 'log', SUBMISSION, ...auth, f.paths.log]);
    expect(f.calls[7]!.args).toEqual(['--verify', '--strict', '-R', `=${CONTROL_HELPER_REQUIREMENT}`, f.appPath]);
    expect(f.calls[8]!.args).toEqual(['--assess', '--type', 'execute', '-vv', f.appPath]);
    expect(receipt).toMatchObject({schemaVersion: 1, app: f.appPath, bundleId: CONTROL_BUNDLE_ID, cdHash: CD_HASH, stapled: true, installed: false,
      notary: {storage: 'data-protection-keychain', submissionId: SUBMISSION, status: 'Accepted', issues: [], log: f.paths.log}});
    expect(receipt.gatekeeper).toContain('source=Notarized Developer ID');
    expect(JSON.parse(readFileSync(f.paths.receipt, 'utf8'))).toEqual(JSON.parse(JSON.stringify(receipt)));
    expect(statSync(f.paths.receipt).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(f.calls)).not.toContain('store-credentials');
  });

  test.each([
    [{screenLocked: true, history: {status: 69, stdout: '', stderr: 'Error: No Keychain password item found for profile: agentstoz-release'}},
      'session-locked-profile-unavailable', 'recheck-existing-profile-after-unlock', 'does not show that the profile was deleted'],
    [{screenLocked: false, history: {status: 69, stdout: '', stderr: 'Error: No Keychain password item found for profile: agentstoz-release'}},
      'profile-unavailable', 'check-original-storage-and-login-session', 'does not show that it was deleted'],
    [{history: {status: 1, stdout: '', stderr: 'HTTP status code: 401. Invalid credentials.'}}, 'apple-auth-rejected', 'review-apple-credential', 'HTTP 401'],
  ] as const)('a failed preflight stops before upload and keeps the preflight distinctions (%#)', (overrides, status, nextStep, advice) => {
    const f = notaryFixture(overrides);
    let message = '';
    try {f.notarize();} catch (error) {message = (error as Error).message;}
    expect(message).toContain(status);
    expect(message).toContain(nextStep);
    expect(message).toContain(advice);
    expect(message).toContain('Nothing was submitted');
    expect(f.steps()).toEqual(['osascript', 'notarytool history']);
    expect(existsSync(f.paths.receipt)).toBe(false);
    expect(JSON.stringify(f.calls)).not.toContain('store-credentials');
  });

  test('an unconfirmed submission is never resubmitted and its raw output is not echoed', () => {
    const f = notaryFixture({submit: {status: 1, stdout: '', stderr: 'upload failed near secret-value-should-not-appear'}});
    let message = '';
    try {f.notarize();} catch (error) {message = (error as Error).message;}
    expect(message).toContain('did not confirm a result (exit 1)');
    expect(message).toContain('notarytool history');
    expect(message).toContain('The profile itself is still readable.');
    expect(message).toContain('uploads again');
    expect(message).not.toMatch(/run the build again|changed nothing/iu);
    expect(message).not.toContain('secret-value-should-not-appear');
    expect(f.steps().filter(step => step === 'notarytool submit')).toHaveLength(1);
    // Only a read-only recheck follows the unknown outcome.
    expect(f.steps().slice(4)).toEqual(['osascript', 'notarytool history']);
    expect(existsSync(join(f.dir, 'AgentsToZ Control.zip'))).toBe(false);
    expect(existsSync(f.paths.receipt)).toBe(false);
  });

  // Regression: after an unconfirmed upload the recheck appended the before-upload advice ("run the build again",
  // "this build changed nothing"). The script always builds and uploads, so that advice meant a second upload while
  // the first one's outcome was still unknown.
  const noKeychainItem = {status: 69, stdout: '', stderr: 'Error: No Keychain password item found for profile: agentstoz-release'};
  test.each([
    [{recheck: {status: 1, stdout: '', stderr: 'Error: The Internet connection appears to be offline.'}}, 'lookup-failed', 'inspect-tool-or-network'],
    [{recheck: {status: null, stdout: '', stderr: '', timedOut: true}}, 'lookup-timeout', 'inspect-tool-or-network'],
    [{recheck: {status: 0, stdout: 'not json', stderr: ''}}, 'invalid-response', 'inspect-tool-or-network'],
    [{recheck: noKeychainItem, recheckLocked: true}, 'session-locked-profile-unavailable', 'recheck-existing-profile-after-unlock'],
    [{recheck: noKeychainItem, recheckLocked: false}, 'profile-unavailable', 'check-original-storage-and-login-session'],
    [{recheck: {status: 1, stdout: '', stderr: 'HTTP status code: 401. Invalid credentials.'}}, 'apple-auth-rejected', 'review-apple-credential'],
    [{recheck: {status: 1, stdout: '', stderr: 'User interaction is not allowed.'}}, 'keychain-interaction-required', 'resolve-keychain-interaction'],
  ] as const)('a failed recheck after an unconfirmed upload never advises building (uploading) again (%#)', (overrides, status, nextStep) => {
    const f = notaryFixture({submit: {status: 1, stdout: '', stderr: 'Error: The network connection was lost.'}, ...overrides});
    let message = '';
    try {f.notarize();} catch (error) {message = (error as Error).message;}
    expect(message).toContain('did not confirm a result (exit 1)');
    expect(message).toContain(status);
    expect(message).toContain(nextStep);
    expect(message).toContain('xcrun notarytool history');
    expect(message).toContain('uploads again');
    expect(message).toContain(f.appPath);
    expect(message).not.toMatch(/run the build again|changed nothing|Nothing was submitted/iu);
    expect(f.steps().filter(step => step === 'notarytool submit')).toHaveLength(1);
    expect(f.steps().slice(4)).toEqual(['osascript', 'notarytool history']);
    expect(existsSync(f.paths.receipt)).toBe(false);
  });

  test('a rejected submission reports Apple’s log, does not staple and writes no receipt', () => {
    const log = JSON.stringify({jobId: SUBMISSION, status: 'Invalid', issues: [{severity: 'error', path: 'AgentsToZ Control.app', message: 'The signature does not include a secure timestamp.'}]});
    const f = notaryFixture({submit: {stdout: JSON.stringify({id: SUBMISSION, status: 'Invalid', message: 'Processing complete'})}, log: {writeLog: log}});
    expect(() => f.notarize()).toThrow(/Notarization Invalid[\s\S]*secure timestamp[\s\S]*never submits again/u);
    expect(f.steps()).not.toContain('stapler staple');
    expect(existsSync(f.paths.receipt)).toBe(false);
  });

  test('Gatekeeper must report notarized Developer ID code before a receipt exists', () => {
    const f = notaryFixture({spctl: {stderr: 'AgentsToZ Control.app: accepted\nsource=Developer ID'}});
    expect(() => f.notarize()).toThrow(`Notarization was accepted (${SUBMISSION}); do not submit it again, but Gatekeeper did not accept`);
    expect(existsSync(f.paths.receipt)).toBe(false);
  });

  test('an existing receipt next to the output is never replaced', () => {
    const f = notaryFixture();
    writeFileSync(f.paths.receipt, '{}');
    expect(() => f.notarize()).toThrow('choose a new output directory');
    expect(f.calls).toHaveLength(0);
    expect(readFileSync(f.paths.receipt, 'utf8')).toBe('{}');
  });
});
