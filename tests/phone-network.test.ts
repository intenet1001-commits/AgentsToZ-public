import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { REMOTE_CONTROL_MOBILE_JS } from '../src/remoteControlMobilePage';
import {
  phoneIsOnline,
  phoneOfflineHostLine,
  phoneOfflineLabel,
  phoneOfflineLanNotice,
  phoneOfflineNotice,
  phoneOfflineTapNotice,
  phoneOfflineRefusal,
  portalNetworkFailureMessage,
  offlineInputNotice,
  relayUnreachableLabel,
  relayUnreachableNotice,
  relayUnreachableRefusal,
} from '../src/phoneNetwork';

// 2026-10-10, iPhone 13 with Wi‑Fi off: 「연결됨」, a request blamed on the Mac, and migration advice.
describe('one source for the phone\'s own network', () => {
  test('only an explicit onLine === false is offline; no navigator reads as online', () => {
    expect(phoneIsOnline({ onLine: false })).toBe(false);
    expect(phoneIsOnline({ onLine: true })).toBe(true);
    expect(phoneIsOnline({})).toBe(true);
    expect(phoneIsOnline(null)).toBe(true);
    // Bun has a navigator without onLine — the server and the test runner are never "offline".
    expect(phoneIsOnline()).toBe(true);
  });

  test('the words say the phone, never the Mac, migrations or a new QR', () => {
    for (const text of [phoneOfflineLabel(), phoneOfflineNotice(), phoneOfflineHostLine('phone-offline'), phoneOfflineHostLine('relay-unreachable'), phoneOfflineLanNotice(true), phoneOfflineLanNotice(false), relayUnreachableLabel(), phoneOfflineTapNotice('실행')]) {
      expect(text).toMatch(/휴대폰/);
      expect(text).not.toMatch(/마이그레이션|절전|응답 없음|단말/);
    }
    expect(phoneOfflineLabel()).toBe('휴대폰 오프라인');
    expect(phoneOfflineLanNotice(true)).toContain('저장된 연결로');
    // A cold QR has no saved connection: it says the QR on this page is used.
    expect(phoneOfflineLanNotice(false)).toContain('이 QR로');
    expect(phoneOfflineLanNotice(false)).not.toContain('저장된');
    for (const saved of [true, false]) expect(phoneOfflineLanNotice(saved)).toContain('QR을 다시 스캔할 필요는 없습니다');
    expect(relayUnreachableLabel()).not.toBe('연결됨');
    // One sentence per situation: a background poll refused offline says exactly what the banner says.
    expect(phoneOfflineRefusal(true)).toBe(phoneOfflineNotice());
    expect(relayUnreachableRefusal(true)).toBe(relayUnreachableNotice());
    // A tap (or typed input) says it was not sent; a poll nobody pressed does not ask to retry.
    expect(phoneOfflineRefusal(false)).toContain('보내지 않았습니다');
    expect(relayUnreachableRefusal(false)).toContain('보내지 않았습니다');
    for (const text of [phoneOfflineRefusal(true), relayUnreachableRefusal(true), relayUnreachableNotice()]) {
      expect(text).not.toMatch(/보내지 않았습니다|다시 시도하세요/);
    }
    // Typed text kept in the box; also the Mac's remote panel, so 「인터넷」, not 「휴대폰」.
    expect(offlineInputNotice()).toContain('그대로 두었습니다');
    expect(offlineInputNotice()).not.toMatch(/단말|휴대폰/);
    expect(phoneOfflineTapNotice('실행')).toContain('실행 요청은 보내지 않았습니다');
  });

  test('a failed sign-in/membership check: offline promises a re-check, online retries a while then asks for 「다시 확인」 — neither advises migrations', () => {
    for (const subject of ['membership', 'session'] as const) {
      const offline = portalNetworkFailureMessage(subject, false);
      const online = portalNetworkFailureMessage(subject, true);
      expect(offline).toContain('저절로 다시 확인합니다');
      // Online, no 'online' event will come: the page retries on a bounded timer (auth-js holds a failed refresh
      // for 60 s, so an immediate 「다시 확인」 can fail), and the button is the way once that gives up.
      expect(online).toContain('잠시 뒤 저절로 다시 확인합니다');
      expect(online).toContain('계속되면');
      expect(online).not.toContain('Wi‑Fi나 셀룰러 데이터를 켜면');
      expect(online).toContain('「다시 확인」');
      for (const text of [offline, online]) expect(text).not.toMatch(/마이그레이션/);
    }
    expect(portalNetworkFailureMessage('membership', true)).toContain('회원 권한을');
    expect(portalNetworkFailureMessage('session', true)).toContain('로그인 상태를');
  });

  test('the functions the QR page embeds stand alone and are embedded verbatim', () => {
    for (const [name, fn] of [['phoneOnline', phoneIsOnline], ['phoneOfflineStatus', phoneOfflineLabel], ['phoneOfflineIntro', phoneOfflineLanNotice]] as const) {
      expect(REMOTE_CONTROL_MOBILE_JS).toContain(`const ${name}=${fn.toString()}`);
      const isolated = new Function(`return (${fn.toString()})`)();
      expect(typeof isolated).toBe('function');
    }
    const isolatedOnline = new Function(`return (${phoneIsOnline.toString()})`)();
    expect(isolatedOnline({ onLine: false })).toBe(false);
    expect(isolatedOnline()).toBe(true);
    expect(new Function(`return (${phoneOfflineLabel.toString()})`)()()).toBe('휴대폰 오프라인');
  });

  test('the portal reads the network through the shared hook and labels', () => {
    const portal = readFileSync(new URL('../src/remote-control-portal-main.tsx', import.meta.url), 'utf8');
    expect(portal).toContain('const phoneOnline = usePhoneOnline();');
    expect(portal).toContain('connectionStateLabel(status.state, phoneOnline, status.relayUnreachable)');
    // A relay this phone cannot reach while navigator says online: not 「연결됨」.
    expect(portal).toContain('if (relayUnreachable && state === \'online\') return relayUnreachableLabel();');
    // The liveness line drops the green check when the Mac's state is unknown from here.
    expect(portal).toContain('{macReach ? <WifiOff aria-hidden="true" /> : <CheckCircle2 aria-hidden="true" />}');
    const css = readFileSync(new URL('../src/remote-control-portal.css', import.meta.url), 'utf8');
    expect(css).toContain('.remote-toolbar div[data-reach="phone-offline"], .remote-toolbar div[data-reach="relay-unreachable"] { color: var(--warn); }');
    // A network-only membership card has no 「이 기기 로그인 초기화」: it cannot fix a network.
    expect(portal).toContain('{!membershipNetwork && (');
    // The 1 s poll's bare network error does not replace an alert about a request the user made.
    expect(portal).toContain('!pollErrorOutranked(transientErrorRef.current?.kind, refreshError)');
    // An offline tap says this tap was not sent, before any 「요청을 보냈습니다」.
    const run = portal.slice(portal.indexOf('const runAction = async'), portal.indexOf('const runProjectAction ='));
    expect(run.indexOf('noticePhoneOffline(')).toBeGreaterThan(-1);
    expect(run.indexOf('noticePhoneOffline(')).toBeLessThan(run.indexOf('요청을 보냈습니다. Mac이 끝낼'));
    // That notice is present tense: it goes when the network returns (review 2026-10-10).
    expect(portal).toContain('setNotice(current => current === offlineNotice ? \'\' : current);');
    // A closed Mac's tab stays 「종료됨」 while offline, like its title and dot.
    expect(portal).toContain("{!phoneOnline && host.status.state !== 'closed' ? (");
    expect(portal).toContain('data-testid="remote-phone-offline"');
    expect(portal).toContain('{!macReach && hostSilentLong(status.hostLastSeenAt) && (');
    const hook = readFileSync(new URL('../src/usePhoneOnline.ts', import.meta.url), 'utf8');
    expect(hook).toContain("window.addEventListener('online', onChange)");
    expect(hook).toContain("window.addEventListener('offline', onChange)");
  });
});
