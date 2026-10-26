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
    const callback = home.slice(home.indexOf('QRScannerSheet { value in'), home.indexOf('.alert("이 QR로는 연결할 수 없습니다"'));
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
    expect(home).toContain('rejectedScan == nil, let resumed = LANWorkroomSession.resumeSaved()');
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
    expect(section).toContain('QRScannerSheet(accepts: { (try? RegistrationInvite(text: $0)) != nil },');
    expect(section).toContain('rejectedHint:');
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
  test('the home scanner, which has no filter, still takes the first QR', () => {
    expect(scanner).toContain('var accepts: ((String) -> Bool)? = nil');
    expect(readFileSync(join(app, 'RemoteHomeView.swift'), 'utf8')).toContain('QRScannerSheet { value in');
  });
});
