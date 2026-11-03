// Screen-control security core checks (native/screen-control). Compiles the sources with the checks as one
// module (swiftc -D CORE_CHECKS), so it runs without Xcode's XCTest, like mobile/ios/scripts/check-native.ts.
// `bun scripts/check-screen-control.ts [packageDir]` — the optional directory lets a mutated copy be checked.
// Then the status file the main app's work-mode panel reads (ScreenHost/ScreenStatusFile.swift): written by the Swift
// type, it must equal Tests/StatusContract/status.json, the sample src-tauri/src/screen_helper.rs is tested against.
// On a Mac, also the host's XCTest suites and the floating session bar (`checkSessionBar`: offscreen render + panel
// contract); its PNGs go to tests/results/screen-session-bar/ (SCREEN_SESSION_BAR_EVIDENCE overrides).
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
  const run = Bun.spawnSync([binary], {stdout: 'pipe', stderr: 'pipe', timeout: 120_000});
  console.log(run.stdout.toString().trim());
  if (run.exitCode !== 0) throw Error('Screen-control checks failed ' + run.stderr.toString());

  // SR-36 (docs/design/mac-to-mac-2026-11-01 7.2): a phone offers session protocol 4 whatever this build's newest is.
  // Its only handshake is DeviceHandshake's public initializer with the default peer class, which maps to the phone's
  // policy; the Mac's `VersionPolicy.current` appears nowhere but the Mac's half, and no iOS source names a controller.
  const handshakeSource = readFileSync(join(sourceDir, 'Handshake.swift'), 'utf8');
  const deviceStart = handshakeSource.indexOf('public actor DeviceHandshake'), macStart = handshakeSource.indexOf('// MARK: - Mac side');
  if (deviceStart < 0 || macStart < deviceStart) throw Error('SR-36: DeviceHandshake not found where expected');
  const deviceHalf = handshakeSource.slice(deviceStart, macStart);
  if (/\.current\b/.test(deviceHalf)) throw Error('SR-36: DeviceHandshake uses VersionPolicy.current');
  if (!deviceHalf.includes('public init(mac: PinnedMac, devicePublicKey: P256.Signing.PublicKey, peerClass: ScreenPeerClass = .phone)')
      || !/case \.phone:\s*\n\s*self\.init\(mac: mac, devicePublicKey: devicePublicKey, versions: \.phone\)/.test(deviceHalf)) {
    throw Error('SR-36: the default DeviceHandshake no longer offers the phone policy');
  }
  if (!/static let phone = VersionPolicy\.upTo\(ScreenControlProtocol\.phoneVersion\)/.test(handshakeSource)
      || !/public static let phoneVersion: UInt16 = 4\b/.test(readFileSync(join(sourceDir, 'Encoding.swift'), 'utf8'))) {
    throw Error('SR-36: the phone policy is not version 4');
  }
  const currentUses = (text: string) => text.match(/VersionPolicy\.current\b|versions: \.current\b/g)?.length ?? 0;
  for (const file of swiftFiles(sourceDir)) {
    if (!file.endsWith('/Handshake.swift') && currentUses(readFileSync(file, 'utf8')) > 0) throw Error(`SR-36: ${file} uses VersionPolicy.current`);
  }
  if (currentUses(handshakeSource.slice(0, deviceStart)) !== 0) throw Error('SR-36: VersionPolicy.current used before the Mac half');
  const viewerSource = readFileSync(join(sourceDir, 'Viewer.swift'), 'utf8');
  if ((viewerSource.match(/public static func connect\([^)]*peerClass: ScreenPeerClass = \.phone\)/g)?.length ?? 0) !== 2
      || /DeviceHandshake\(mac: mac, devicePublicKey: signer\.publicKey\)/.test(viewerSource)) {
    throw Error('SR-36: ScreenViewer.connect must default to the phone class and pass it to DeviceHandshake');
  }
  // The iOS app's own sources: tracked files and new ones not yet added, never the gitignored build copies
  // (mobile/ios/build/**: DerivedData, ui-evidence app copies), whose stale text would fail this check for nothing.
  const repoRoot = join(import.meta.dir, '..');
  const listed = Bun.spawnSync(['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', 'mobile/ios'],
    {cwd: repoRoot, stdout: 'pipe', stderr: 'pipe'});
  if (listed.exitCode !== 0) throw Error('SR-36: could not list the iOS sources:\n' + listed.stderr.toString());
  const iosSources = [...new Set(listed.stdout.toString().split('\0').filter(path => path.endsWith('.swift')))]
    .map(path => join(repoRoot, path)).filter(path => existsSync(path));
  if (!iosSources.some(path => path.endsWith('/ScreenViewerView.swift'))) throw Error('SR-36: the iOS viewer sources were not found');
  for (const file of iosSources) {
    const text = readFileSync(file, 'utf8');
    if (/peerClass:\s*\.controller|ScreenPeerClass\.controller|VersionPolicy|versions:\s*\./.test(text)) {
      throw Error(`SR-36: ${file} must keep the phone's default handshake`);
    }
  }
  console.log('SR-36: phones offer version 4 through the default handshake; no phone path uses the Mac\'s policy');

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
  // ControllerSessionTests, ScreenPowerTests, ControllerLogTests, ControllerStoreTests, PairingHostTests: the Mac-to-Mac
  // host packages (docs/design/mac-to-mac-2026-11-01 15절), named here ahead so each package only adds its tests.
  // ControllerSectionTests: the menu and status window's 「다른 Mac에서 이 Mac 보기」 model, its raising gate and wiring.
  // ScreenSessionBarTests: the floating session bar's words and buttons per state, the hand-back click rule and its hold on
  // the session's input receiver, in memory; never a window, the keychain, capture, an input event or the screen port.
  // ViewerCommunityChecks and ViewerUITests: strict hint files and explicitly started, bounded enrollment discovery;
  // fake streams and offscreen views only, no Bonjour, Secure Enclave, keychain or desktop input.
  if (process.platform === 'darwin') {
    const host = Bun.spawnSync(['swift', 'test', '--package-path', packagePath, '--filter',
      'CommunityOwnerRecoveryChecks|CommunityOwnerRecoveryHostTests|ViewerOwnerWorkflowChecks|CommunityDesktopTrustChecks|DesktopTrustHostTests|ScreenPersistentInputHoldTests|ViewerDesktopTrustChecks|ViewerFirstFrameDeadlineTests|CommunityScreenSafetyChecks|ScreenCommunitySafetyPollerTests|CommunityManagementChecks|CommunityRegistrationRecoveryChecks|CommunityAccessChecks|CommunityAccessRecoveryChecks|CommunityEnrollmentConfirmationTests|CommunityUseIdleDeadlineTests|CommunityMobileControlTests|CommunityMobileControlChoicesTests|CommunityMobileControlClientTests|CommunityMobileControlJournalTests|CommunityMobileControlSocketTests|CommunityScreenHandshakeChecks|CommunityRelayTransportChecks|CommunityRelaySocketChecks|CommunityScreenRelaySocketChecks|ViewerNoticeOverflowTests|LocalInputMonitorTests|ScreenControllerTests|WeeklyUsageOutboxTests|ControllerSessionTests|ScreenPowerTests|ControllerLogTests|ControllerStoreTests|PairingHostTests|ControllerSectionTests|ScreenSessionBarTests|ScreenCommunityRouteChecks|ScreenCommunityClientChecks|ScreenCommunityChecks|ViewerCommunityChecks|ViewerUITests'],
      {stdout: 'pipe', stderr: 'pipe', timeout: 180_000});
    if (host.exitCode !== 0) throw Error('Native local-input ledger checks failed:\n' + host.stdout.toString() + host.stderr.toString());
    console.log(host.stdout.toString().trim());
    checkSessionBar();
  }

} finally {
  rmSync(temporary, {recursive: true, force: true});
}

/** The floating session bar (docs/design/mac-to-mac-2026-11-01/DESIGN.md 「부록 A」). First its view, drawn offscreen for
 * every state with the model it draws from, compiled as one module the way the Control bar's view can be: it fails on a
 * fixed line cut off, a wrong pill or any window, and leaves PNGs under the ignored tests/results/ as evidence. Then the
 * panel's source, which no unit check reaches (an app-target NSPanel): the Control bar's level order and Spaces
 * behaviour, staying in the captured picture, and 「다시 넘기기」 going through the click rule and nowhere else. */
function checkSessionBar() {
  const evidence = resolve(process.env.SCREEN_SESSION_BAR_EVIDENCE ?? join(import.meta.dir, '..', 'tests', 'results', 'screen-session-bar'));
  const render = join(temporary, 'session-bar-render');
  const compile = Bun.spawnSync(['swiftc', '-swift-version', '6', join(packagePath, 'Tests', 'SessionBarRender', 'main.swift'),
    join(packagePath, 'Sources', 'AgentsToZScreen', 'ScreenSessionBarView.swift'),
    join(packagePath, 'Sources', 'ScreenHost', 'ScreenSessionBarModel.swift'),
    join(packagePath, 'Sources', 'ScreenControlCore', 'ScreenInputOrigin.swift'), '-o', render], {stderr: 'pipe'});
  if (compile.exitCode !== 0) throw Error('Session bar render compilation failed:\n' + compile.stderr.toString());
  const run = Bun.spawnSync([render, evidence], {stdout: 'pipe', stderr: 'pipe', timeout: 60_000});
  if (run.exitCode !== 0) throw Error('Session bar render check failed:\n' + run.stderr.toString());
  console.log(run.stdout.toString().trim());

  const source = (...path: string[]) => readFileSync(join(packagePath, 'Sources', ...path), 'utf8');
  const bar = source('AgentsToZScreen', 'ScreenSessionBar.swift');
  const view = source('AgentsToZScreen', 'ScreenSessionBarView.swift');
  const service = source('ScreenHost', 'ScreenService.swift');
  const expect = (ok: boolean, what: string) => { if (!ok) throw Error('Session bar contract: ' + what); };
  const make = bar.slice(bar.indexOf('private func make()'), bar.indexOf('private func appear('));
  expect(bar.includes('override var canBecomeKey: Bool { false }') && bar.includes('override var canBecomeMain: Bool { false }'),
    'the panel never becomes key or main');
  expect(make.includes('[.borderless, .nonactivatingPanel]'), 'a non-activating borderless panel');
  const floating = make.indexOf('panel.isFloatingPanel = true');
  expect(floating >= 0 && floating < make.indexOf('panel.level = .statusBar'), 'the status-bar level is set after isFloatingPanel, which resets it');
  expect(make.includes('[.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]'), 'every Space, full screen, out of the cycle');
  expect(make.includes('isMovableByWindowBackground = true') && bar.includes('func windowDidMove(') && bar.includes('ScreenSessionBarPlacement.origin('),
    'draggable, and opens where it was left');
  const update = bar.slice(bar.indexOf('func update()'), bar.indexOf('private func hide()'));
  expect(update.includes('if panel.level != .statusBar { panel.level = .statusBar }') && update.includes('panel.orderFrontRegardless()'),
    'the level and the front are put right every tick');
  expect(!/sharingType\s*=/.test(bar + view), 'the bar stays in the picture the other side sees');
  const handBackAt = bar.indexOf('case .handBack:');
  const handBack = bar.slice(handBackAt, bar.indexOf('update()', handBackAt));
  expect(handBackAt >= 0 && handBack.includes('handBackRefusal(NSApp.currentEvent, bar: panel, pill: sender)') && /await service\.resumeRemoteInput\(refusal:\s*refusal\)/.test(handBack),
    '다시 넘기기 reads the click that ran it and passes the verdict to the service');
  expect(bar.split('resumeRemoteInput(').length === 2 && !bar.includes('.resume()'), 'no other way to hand input back from the bar');
  const resumeAt = service.indexOf('public func resumeRemoteInput(');
  const resume = service.slice(resumeAt, service.indexOf('public func lowerSessionToView()', resumeAt));
  expect(resumeAt >= 0 && /async -> Bool/.test(resume) && resume.includes('guard refusal == nil') &&
    resume.includes('if persistentInputHold == nil { return macHold.resume(original.hold) }'),
    'never-opted-in legacy hand-back still requires an accepted hardware click and adds no authentication');
  expect(resume.includes('if usesTrustedInputOwnerConfirmation') && resume.includes('guard refusal != .screenInjected') &&
    resume.includes('return await confirmTrustedInputOwner()'),
    'trusted hand-back goes to owner confirmation and cannot accept our own injected event');
  expect(service.includes('hold.apply(probe())') && service.includes('hold.attach(streamer.input)'),
    'the hold sits between the local input monitor and the session receiver');
  expect(source('AgentsToZScreen', 'ScreenApp.swift').includes('ScreenSessionBar.shared.start()'), 'the app starts the bar');

  // Review F2 (SR-29: the hardware mouse-up must be inside the control that ran; an accessibility action is refused).
  // The pill knows it tracked its own mouse-down, refuses an accessibility press on 「다시 넘기기」, and the bar passes
  // that, the mouse-up's place in the pill and its click count to the click rule.
  expect(/override func mouseDown\(with event: NSEvent\) \{\s*tracksOwnMouseDown = true\s*defer \{ tracksOwnMouseDown = false \}\s*super\.mouseDown\(with: event\)\s*\}/.test(view),
    'a pill marks the mouse-down it tracks itself, only while it tracks it');
  expect(/override func accessibilityPerformPress\(\) -> Bool \{\s*guard barAction\?\.needsPersonAtMac != true else \{\s*refusedAccessibilityPress\?\(\)\s*return false\s*\}/.test(view),
    'an accessibility press never runs 다시 넘기기');
  const refusalAt = bar.indexOf('static func handBackRefusal(');
  const refusal = bar.slice(refusalAt, bar.indexOf('static func poster(', refusalAt));
  expect(refusalAt >= 0 && refusal.includes('pill.tracksOwnMouseDown') && refusal.includes('pill.bounds.contains(pill.convert(event.locationInWindow, from: nil))') &&
    refusal.includes('inControl: inControl') && refusal.includes('clickCount: mouseUp ? event.clickCount : 0'),
    'the bar gives the click rule the pill that tracked the click, where the mouse-up landed and its click count');
  const model = source('ScreenHost', 'ScreenSessionBarModel.swift');
  expect(model.includes('guard isMouseUp, inBar, inControl else { return .notABarClick }') && model.includes('ScreenInputOrigin.humanClick(') &&
    model.includes('return clickCount == 1 ? nil : .repeatedClick'), 'the click rule refuses outside the control, posted events and repeated clicks');

  // Review F1: 「직접 하기」 and 「보기만」 outlast their session. Every session's hold comes from the one ScreenMacHold, the
  // bar's presses go through it. Legacy ON and common ON preserve their existing gates. Explicit desktop-trust ON
  // never clears either hold; owner confirmation and durable generation CAS have separate behavioral checks above.
  expect(!service.includes('ScreenSessionInputHold('), 'no session hold is made outside ScreenMacHold');
  const acceptAt = service.indexOf('func accept(');
  const accept = service.slice(acceptAt, service.indexOf('private static func refuse(', acceptAt));
  expect(acceptAt >= 0 && accept.includes('let hold = macHold.begin()'), 'a new session takes its hold from ScreenMacHold, paused while this Mac holds its input');
  expect(service.includes('macHold.pause(active.hold)') && service.includes('macHold.lowerToView(active.hold)') &&
    resume.includes('return macHold.resume(original.hold)') &&
    !/\.hold\.(pause|resume|lowerToView)\(/.test(resume),
    '직접 하기, 보기만 and 다시 넘기기 go through ScreenMacHold');
  const turnOnAt = service.indexOf('public func turnOn()');
  const commonOnAt = service.indexOf('public func turnOnFromCommunity(');
  const trustedOnAt = service.indexOf('public func turnOnFromTrustedCommunity()');
  const turnOn = service.slice(turnOnAt, commonOnAt);
  const communityOn = service.slice(commonOnAt, trustedOnAt);
  const trustedOn = service.slice(trustedOnAt, service.indexOf('public func refreshPresentNetwork()', trustedOnAt));
  const authenticated = turnOn.indexOf('guard try await authenticate(');
  const consent = communityOn.indexOf('try await broker.consentForTurningOn()');
  expect(authenticated >= 0 && turnOn.indexOf('macHold.reset()') > authenticated &&
    turnOn.includes('clearAfterOwnerConfirmation(expectedGeneration:protectedGeneration)'),
    'legacy authenticated turn-on retains recovery, with durable generation checks for a prior trusted hold');
  expect(commonOnAt >= 0 && communityOn.includes('guard click == nil') &&
    communityOn.includes('guard unifiedReceivingRegistered, let broker = communityBroker') && consent >= 0 &&
    communityOn.indexOf('guard epoch == powerEpoch, case .off = power else { return }', consent) > consent &&
    communityOn.includes('if persistentInputHold == nil { macHold.reset() }'),
    'legacy common turn-on retains hardware, receiver consent and epoch checks without clearing a persistent trusted hold');
  expect(trustedOnAt >= 0 && trustedOn.includes('trustedConsentForTurningOn()') &&
    trustedOn.includes('consent.isCurrent()') && trustedOn.includes('epoch==powerEpoch') &&
    trustedOn.includes('!unifiedReceivingHeld') && trustedOn.includes('preparePersistentInputHold()') &&
    !/macHold\.(reset|resume)\(|broker\.hold\(false\)|authenticate\(/.test(trustedOn),
    'explicit trusted turn-on checks fresh receive authority and epoch, preserving receive and input holds without repeat authentication');

  // Review F4: the bar's hardware rule is a second copy until ScreenInputOrigin.humanClick (wp-input-origin) replaces it.
  // Its constants are held to the Control bar's and, once ScreenInputOrigin.swift is in the package, to its constants.
  const one = (text: string, pattern: RegExp, what: string) => {
    const found = [...text.matchAll(new RegExp(pattern.source, 'g'))];
    if (found.length !== 1) throw Error(`Session bar click rule: ${what}: expected one match, found ${found.length}`);
    return found[0]![1]!;
  };
  const quoted = (text: string) => [...text.matchAll(/"([^"]+)"/g)].map(m => m[1]!).sort();
  const rules = (text: string, hardwarePid: RegExp) => ({
    hardwareSourcePid: Number(one(text, hardwarePid, 'hardware pid')),
    freshSeconds: Number(one(text, /static let freshSeconds = ([0-9.]+)\b/, 'freshSeconds')),
    appleRemoteDesktop: quoted(one(text, /static let appleRemoteDesktop: Set<String> = \[([^\]]*)\]/, 'Apple remote desktop')),
    teamRemoteDesktop: Object.fromEntries([...one(text, /static let teamRemoteDesktop: \[String: Set<String>\] = \[((?:[^[\]]|\[[^\]]*\])*)\]/, 'team remote desktop')
      .matchAll(/"([^"]+)"\s*:\s*\[([^\]]*)\]/g)].map(m => [m[1]!, quoted(m[2]!)])),
  });
  const sessionBarRules = rules(source('ScreenControlCore', 'ScreenInputOrigin.swift'), /static let hardwareSourcePid: Int64 = (\d+)/);
  const controlBarRules = rules(readFileSync(join(import.meta.dir, '..', 'native', 'computer-use', 'Sources', 'ComputerUseControlCore', 'ControlBarRules.swift'), 'utf8'),
    /if sourcePid == (\d+) \{ return nil \}/);
  deepStrictEqual(sessionBarRules, controlBarRules, 'the session bar click rule drifted from the Control bar rule');
  const originPath = join(packagePath, 'Sources', 'ScreenControlCore', 'ScreenInputOrigin.swift');
  if (existsSync(originPath)) {
    deepStrictEqual(sessionBarRules, rules(readFileSync(originPath, 'utf8'), /static let hardwareSourcePid: Int64 = (\d+)/),
      'the session bar click rule drifted from ScreenInputOrigin');
    expect(model.includes('ScreenInputOrigin.humanClick('), 'the session bar uses the shared hardware rule');
  }
  console.log('session bar: panel contract holds (level order, Spaces, captured, legacy tracked-hardware hand-back, ' +
    'trusted owner-confirmation recovery, accessibility press refused, persistent holds preserved, click rule equal to the Control bar\'s)');
}
