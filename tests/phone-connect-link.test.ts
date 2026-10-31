import {describe, expect, test} from 'bun:test';
import golden from './fixtures/phone-connect-link-golden.json';
import {buildPhoneConnectLink, bundledQrSupabaseMismatch, extractPhoneConnectLink, parsePhoneConnectLink, phoneConnectHostLabel, PHONE_CONNECT_LINK_PREFIX} from '../src/phoneConnectLink';
import {pairingSupabaseConfig} from '../src/remoteControlPairingSupabase';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

// The iPhone parser (AgentsToZCore/PhoneConnectLink.swift) reads the same golden table.
describe('phone connect link — golden table shared with Swift', () => {
  for (const row of golden.build) {
    test(`build: ${row.name}`, () => {
      expect(buildPhoneConnectLink(row.input as never) as string).toBe(row.link);
    });
  }
  for (const row of golden.buildRejects) {
    test(`build refuses: ${row.name}`, () => {
      expect(() => buildPhoneConnectLink(row.input as never)).toThrow();
    });
  }
  for (const row of golden.parse) {
    test(`parse: ${row.name}`, () => {
      const link = extractPhoneConnectLink(row.text);
      let value: ReturnType<typeof parsePhoneConnectLink> | null = null;
      try { if (link) value = parsePhoneConnectLink(link); } catch { value = null; }
      if (row.expect.ok) expect(value).toEqual({portalOrigin: row.expect.portalOrigin, supabaseUrl: row.expect.supabaseUrl, anonKey: row.expect.anonKey, hostName: row.expect.hostName} as never);
      else expect(value).toBeNull();
    });
  }
});

describe('phone connect link — guards', () => {
  const anon = golden.build[0]!.input.anonKey;
  const input = {portalOrigin: 'https://portal.example.com', supabaseUrl: 'https://example-ref.supabase.co', anonKey: anon, hostName: 'Mac'};

  test('a key equal to the service_role key is refused even if it looks public', () => {
    expect(() => buildPhoneConnectLink(input, anon)).toThrow(/service_role/);
    expect(buildPhoneConnectLink(input, 'some-other-service-key')).toStartWith(PHONE_CONNECT_LINK_PREFIX);
  });

  test('never carries pairing secrets: exactly the five public fields', () => {
    const link = buildPhoneConnectLink(input);
    const json = JSON.parse(Buffer.from(link.slice(PHONE_CONNECT_LINK_PREFIX.length), 'base64url').toString('utf8'));
    expect(Object.keys(json).sort()).toEqual(['anonKey', 'hostName', 'portal', 'supabaseUrl', 'v']);
  });

  test('works with what pairingSupabaseConfig lets out of the Mac', () => {
    const config = pairingSupabaseConfig({supabaseUrl: 'https://example-ref.supabase.co/', supabaseAnonKey: anon}, null, raw => raw);
    expect(config).not.toBeNull();
    const parsed = parsePhoneConnectLink(buildPhoneConnectLink({portalOrigin: input.portalOrigin, supabaseUrl: config!.url, anonKey: config!.anonKey, hostName: 'Mac'}));
    expect(parsed.supabaseUrl).toBe('https://example-ref.supabase.co');
  });

  test('malformed input is rejected with a readable message', () => {
    for (const bad of [null, 42, '', 'agentstoz://connect#', 'agentstoz://connect#!!', 'https://example.com']) {
      expect(() => parsePhoneConnectLink(bad)).toThrow();
    }
    expect(extractPhoneConnectLink('no link here')).toBeNull();
    expect(extractPhoneConnectLink('x'.repeat(20_000))).toBeNull();
  });

  test('labels are cleaned, shortened and never empty', () => {
    expect(phoneConnectHostLabel('  ')).toBe('Mac');
    expect(phoneConnectHostLabel(undefined)).toBe('Mac');
    expect(phoneConnectHostLabel('A‮B\nC')).toBe('ABC');
    expect(Array.from(phoneConnectHostLabel('가'.repeat(100))).length).toBe(40);
  });
});

describe('bundled portal: a QR for another Supabase project', () => {
  test('matching or absent project is fine; another project is refused with how to switch', () => {
    expect(bundledQrSupabaseMismatch('https://a.supabase.co', 'https://a.supabase.co')).toBeNull();
    expect(bundledQrSupabaseMismatch(undefined, 'https://a.supabase.co')).toBeNull();
    const message = bundledQrSupabaseMismatch('https://b.supabase.co', 'https://a.supabase.co');
    expect(message).toContain('b.supabase.co');
    // The workroom covers the app's first screen and there is no way back to it short of deleting the
    // sign-in (relaunch restores the workroom). Point at the button the app actually offers:
    // the toolbar 「연결 설정」 sheet's non-destructive 「다른 연결 QR 스캔」 (LANWorkroomView.swift).
    expect(message).toContain('오른쪽 위 「연결 설정」의 「다른 연결 QR 스캔」');
    expect(message).not.toContain('앱 첫 화면');
  });
});

// Integration review w4 (4b). After 「다른 연결 QR 스캔」 a scan the app cannot use (a Wi‑Fi or menu QR, a cut link) opened
// nothing and left the phone on the first screen, whose address field a bundled-portal user has no address for, until a
// relaunch. Going back to the workspace covers that screen, so it happens only from an alert that shows the reason.
// Source contract only: the app target is compiled by the unsigned simulator build (verify.yml native-ios), not by bun.
describe('iPhone app: a scan from the workroom that cannot be used', () => {
  const home = readFileSync(join(import.meta.dir, '..', 'mobile', 'ios', 'App', 'RemoteHomeView.swift'), 'utf8');
  test('only a scan opened from the workroom that opened nothing raises the alert, with the reason', () => {
    const callback = home.slice(home.indexOf('.sheet(isPresented: $showScanner'), home.indexOf('.alert("이 QR로는 연결할 수 없습니다"'));
    expect(callback).toContain('let returnable = scanFromWorkroom');
    expect(callback).toContain('if returnable, pairing == nil, browserAddress == nil, connectLink == nil {');
    expect(callback).toContain('rejectedScan = model.notice');
    expect(home).toContain('if scanAfterWorkroom { scanAfterWorkroom = false; scanFromWorkroom = true; showScanner = true }');
  });
  test('the workspace comes back only from the alert, and nothing else covers the alert meanwhile', () => {
    const alert = home.slice(home.indexOf('.alert("이 QR로는 연결할 수 없습니다"'), home.indexOf('} message: { Text(rejectedScan ?? "") }'));
    expect(alert).toContain('Button("작업 공간으로 돌아가기") { rejectedScan = nil; model.notice = nil; resumeIfIdle() }');
    expect(alert).toContain('Button("다시 스캔")');
    const resume = home.slice(home.indexOf('private func resumeIfIdle()'), home.indexOf('private func review('));
    expect(resume).toContain('rejectedScan == nil');
    // Coming back to the app (scenePhase .active) does not reopen the workspace over the alert either.
    expect(home).toContain('rejectedScan == nil, !screenRegistrationPending, let resumed = LANWorkroomSession.resumeSaved()');
  });
});

// Registering a Mac for AgentsToZ Screen took the first QR the camera saw: a neighbouring QR on the Mac's screen ended
// the registration with 「등록 QR이 아닙니다」 and closed the scanner (2026-10-25, iPad mini). The registration scanner
// now tracks every QR in view, skips one it cannot register with a hint, and keeps scanning. Source contract only, as above.
describe('iPhone app: the Screen registration scanner skips a QR it cannot register', () => {
  const app = join(import.meta.dir, '..', 'mobile', 'ios', 'App');
  const scanner = readFileSync(join(app, 'QRScannerSheet.swift'), 'utf8');
  const section = readFileSync(join(app, 'ScreenMacsSection.swift'), 'utf8');
  test('the section filters with the same parser it registers with', () => {
    expect(section).toContain('QRScannerSheet(accepts: { (try? RegistrationInvite(deviceRegistrationText: $0)) != nil },');
    expect(section).toContain('next = try RegistrationInvite(deviceRegistrationText: text)');
    expect(section).toContain('if case RegistrationError.wrongPurpose = error');
    expect(section).toContain('rejectedHint:');
  });
  test('a controller QR is rejected before any device key, attestation or network operation', () => {
    const registration = readFileSync(join(app, 'ScreenRegistrationSheet.swift'), 'utf8');
    const action = registration.slice(registration.indexOf('private func register() async'));
    const guard = action.indexOf('try invite.requireDeviceRegistration()');
    expect(guard).toBeGreaterThan(-1);
    for (const effect of ['FaceIDApprovedSigner.createDeviceKey', 'DCAppAttestService.shared', 'ScreenNearby.open', 'ScreenClient.open']) {
      expect(action.indexOf(effect)).toBeGreaterThan(guard);
    }
  });
  test('a skipped QR neither stops the scan nor reaches the caller', () => {
    expect(scanner).toContain('recognizesMultipleItems: accepts != nil');
    const delegate = scanner.slice(scanner.indexOf('func dataScanner('), scanner.indexOf('if skipped { rejected() }'));
    const skip = delegate.indexOf('guard accepts?(value) ?? true else { skipped = true; continue }');
    expect(skip).toBeGreaterThan(-1);
    expect(delegate.indexOf('scanner.stopScanning(); scanned(value)')).toBeGreaterThan(skip);
  });
  test('both newly added and updated QR items reconsider all tracked payloads through the same filter', () => {
    for (const event of ['didAdd addedItems', 'didUpdate updatedItems']) {
      const start = scanner.indexOf('func dataScanner(_ scanner: DataScannerViewController, ' + event);
      expect(start).toBeGreaterThan(-1);
      const callback = scanner.slice(start, scanner.indexOf('\n        }', start));
      expect(callback).toContain('scan(allItems, using: scanner)');
    }
    const scan = scanner.slice(scanner.indexOf('private func scan('));
    expect(scan).toContain('guard !delivered else { return }');
    expect(scan).toContain('guard accepts?(value) ?? true');
    expect(scan).toContain('value.utf8.count <= 4096');
    expect(scan.indexOf('delivered = true')).toBeLessThan(scan.indexOf('scanner.stopScanning(); scanned(value)'));
  });
  test('the workspace scanner keeps a screen-registration QR out of data onboarding and names the correct path', () => {
    expect(scanner).toContain('var accepts: ((String) -> Bool)? = nil');
    const home = readFileSync(join(app, 'RemoteHomeView.swift'), 'utf8');
    const workspaceScan = home.slice(home.indexOf('.sheet(isPresented: $showScanner'), home.indexOf('.alert("이 QR로는 연결할 수 없습니다"'));
    expect(workspaceScan).toContain('QRScannerSheet(accepts: { !$0.hasPrefix(RegistrationInvite.prefix) }');
    expect(workspaceScan).toContain('Mac 화면 등록용 QR입니다.');
    expect(workspaceScan).toContain('화면 제어 등록은 「Mac 화면」에서 진행합니다.');
    expect(section).toContain('QRScannerSheet(accepts: { (try? RegistrationInvite(deviceRegistrationText: $0)) != nil }');
  });
});

// 2026-11-01: the Mac's 「Mac 화면 기기 등록」 QR scanned with the iPhone Camera said 「사용 가능한 데이터가 없음」. Its text
// (`agentstoz-screen:` + base64url) is a URL in a scheme the app had not registered, and the Mac's one-line instruction,
// cut off with 「…」, never said to use the app's own scanner. The app now registers the scheme and routes the opened URL
// into the same registration; the Mac says both ways. The parsing itself is pinned by the Swift check
// 「registration QR is a URL the app opens」 (native/screen-control). Source contract only, as above.
describe('iPhone app: the Mac screen registration QR opens the app from the Camera', () => {
  const root = join(import.meta.dir, '..');
  const read = (path: string) => readFileSync(join(root, path), 'utf8');
  const plist = read('mobile/ios/App/Info.plist');
  const registration = read('native/screen-control/Sources/ScreenControlCore/Registration.swift');
  const home = read('mobile/ios/App/RemoteHomeView.swift');
  const section = read('mobile/ios/App/ScreenMacsSection.swift');
  const workroom = read('mobile/ios/App/LANWorkroomView.swift');
  const sheet = read('mobile/ios/App/ScreenRegistrationSheet.swift');
  const macPanel = read('native/screen-control/Sources/AgentsToZScreen/ScreenApp.swift');

  test('the app registers exactly the QR prefix as a custom URL scheme, never a web link', () => {
    const scheme = registration.match(/public static let scheme = "([a-z][a-z0-9+.-]*)"/)?.[1];
    expect(scheme).toBe('agentstoz-screen');
    expect(registration).toContain('public static let prefix = scheme + ":"');
    const urlTypes = plist.slice(plist.indexOf('<key>CFBundleURLTypes</key>'), plist.indexOf('<key>LSRequiresIPhoneOS</key>'));
    expect(urlTypes).toContain(`<array><string>${scheme}</string></array>`);
    // The QR holds the one-time code: no https universal link, which would hand it to a server when the app is missing.
    expect(scheme).not.toMatch(/^https?$/);
    expect(read('mobile/ios/App/AgentsToZMobile.entitlements')).not.toContain('associated-domains');
  });

  test('an opened registration URL is routed before the phone connect link, without closing the workspace', () => {
    const handler = home.slice(home.indexOf('.onOpenURL { url in'), home.indexOf('.task(id: scenePhase)'));
    const screen = handler.indexOf('if let invite = RegistrationInvite.text(openedURL: url) { return openScreenRegistration(invite) }');
    expect(screen).toBeGreaterThan(-1);
    expect(screen).toBeLessThan(handler.indexOf('guard url.scheme == PhoneConnectLink.scheme'));
    const route = home.slice(home.indexOf('private func openScreenRegistration('), home.indexOf('private func review('));
    expect(route).toContain('if workroom != nil {\n            workroomScreenInvite = text');
    expect(route).toContain('scanDelivered = true; pendingScreenInvite = text; showScanner = false');
    expect(route).toContain('screenInvite = text');
    // Ending the workroom would destroy its page; the QR goes to the workspace's own 「Mac 화면」 instead.
    expect(route).not.toContain('.end(');
    expect(home).toContain('}, screenInvite: $workroomScreenInvite)');
  });

  test('coming back to the app does not cover a registration with the saved workspace', () => {
    expect(home).toContain('screenInvite != nil || pendingScreenInvite != nil || screenRegistrationOpen');
    const resume = home.slice(home.indexOf('private func resumeIfIdle()'), home.indexOf('/// A Mac-screen registration QR is on its way'));
    expect(resume).toContain('!screenRegistrationPending, let resumed = LANWorkroomSession.resumeSaved()');
    expect(home).toContain('ScreenMacsSection(scannedInvite: $screenInvite, registrationOpen: $screenRegistrationOpen)');
    // The section says so in the same step that opens or closes the sheet, not an update later.
    const present = section.slice(section.indexOf('private func presentRegistration('));
    expect(present).toContain('registering = open');
    expect(present).toContain('registrationOpen.wrappedValue = open');
    expect(section).toContain('invite = nil; registrationBusy = false; registrationOpen.wrappedValue = false');
  });

  test('a handed-over QR reaches the row even when it was off screen, and starts a fresh registration', () => {
    expect(section).toContain('.onChange(of: scannedInvite, initial: true)');
    expect(section).toContain('.id(Self.registerRowID)');
    expect(home).toContain('scroll.scrollTo(ScreenMacsSection.registerRowID, anchor: .center)');
    expect(section).toContain('ScreenRegistrationSheet(invite: invite, busy: $registrationBusy)');
    expect(section).toMatch(/macs = try ScreenMacStore\.register\(saved\)\n\s+\}\n\s+\.id\(invite\.code\.id\)/);
  });

  test('a registration under way is never replaced or closed by another QR', () => {
    const open = section.slice(section.indexOf('private func open('), section.indexOf('static let busyNotice'));
    expect(open).toContain('if current.code.id == next.code.id { return }');
    expect(open).toContain('if registrationBusy {');
    expect(open).toContain('if invite == nil { presentRegistration(false) }');
    expect(sheet).toContain('private var isUnderWay: Bool { phase != .ready && phase != .done && !isFailed }');
    expect(sheet).toContain('.onChange(of: isUnderWay, initial: true) { _, underWay in busy.wrappedValue = underWay }');
    const receive = workroom.slice(workroom.indexOf('private func receiveScreenInvite('));
    expect(receive).toContain('screenInvite.wrappedValue = nil');
    expect(receive).toContain('try RegistrationInvite(deviceRegistrationText: text)');
    expect(receive).toContain('current.code.id == invite.code.id || screenRegistrationBusy { return }');
    expect(receive).toContain('if showingScreens, screenRegistration != nil { return }');
    // Receiving a QR only shows the registration; nothing is sent until 「이 기기 등록」 in ScreenRegistrationSheet.
    for (const effect of ['ScreenNearby.open', 'ScreenClient.open', 'ScreenRelayTransport.open', 'DCAppAttestService', 'createDeviceKey']) {
      expect(workroom).not.toContain(effect);
      expect(home).not.toContain(effect);
      expect(section).not.toContain(effect);
    }
    expect(workroom).toContain('.onChange(of: screenInvite.wrappedValue, initial: true) { _, text in receiveScreenInvite(text) }');
    expect(workroom).toContain('if screensAfterSheet { screensAfterSheet = false; showingScreens = true }');
  });

  test('the Mac names both ways to scan, wrapped instead of cut off', () => {
    const showing = macPanel.slice(macPanel.indexOf('case .showing(let invite, let until):'), macPanel.indexOf('if let image = Self.qrImage(invite.text)'));
    expect(showing).toContain('카메라');
    expect(showing).toContain('사용 가능한 데이터가 없음');
    expect(showing.match(/\.fixedSize\(horizontal: false, vertical: true\)/g)?.length).toBe(2);
    // The button the Mac names is the one the app shows.
    const named = showing.match(/AgentsToZ 앱 홈의 「([^」]+)」/)?.[1];
    expect(named).toBe('Mac 화면 등록 · QR 스캔');
    expect(section).toContain(`Button("${named}", systemImage: "qrcode.viewfinder")`);
  });
});
