import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { InternetQrRemoteControlDialog } from '../src/InternetQrRemoteControlDialog';
import { isInternetRemotePairingClaimed } from '../src/internetRemoteControlPairingState';

const source = readFileSync(new URL('../src/InternetQrRemoteControlDialog.tsx', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');

describe('external internet QR remote-control desktop dialog', () => {
  test('is a separate beta menu and dialog, not a rename of trusted-Wi-Fi LAN control', () => {
    expect(renderToStaticMarkup(createElement(InternetQrRemoteControlDialog, {
      open: false,
      onClose() {},
    }))).toBe('');
    const html = renderToStaticMarkup(createElement(InternetQrRemoteControlDialog, {
      open: true,
      onClose() {},
    }));
    expect(html).toContain('data-testid="internet-qr-remote-control-dialog"');
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('외부 인터넷 QR 원격제어 · 베타');
    expect(html).toContain('같은 Wi‑Fi가 아니어도');
    expect(appSource).toContain('showQrRemoteControl');
    expect(appSource).toContain('showInternetQrRemoteControl');
    expect(appSource).toContain('QR 원격제어 · 이 Mac');
    expect(appSource).toContain('외부 인터넷 QR 원격제어 · 베타');
    expect(appSource).toContain('data-testid="open-internet-qr-remote-control"');
  });

  test('the one field that blocks setup says where its value comes from', () => {
    // The address exists nowhere in the app, so a blank field used to be a dead
    // end: the user had to already know where their own portal was deployed.
    expect(source).toContain('data-testid="internet-remote-origin-hint"');
    expect(source).toContain('한 번 연결하면 다음부터는 이 칸이 자동으로 채워집니다.');
    expect(source).toContain('suggestedControllerOrigin');
    // An English field label on the first screen of a Korean UI.
    expect(source).not.toContain('HTTPS controller origin\n');
    expect(source).toContain('휴대폰에서 열 주소');
  });

  test('states the hosting, login, expiry, approval, and least-authority contract before enable', () => {
    for (const phrase of [
      '현재 구성은 Vercel에서 검증합니다.',
      '정적 /remote 파일·Supabase 환경값·보안 헤더',
      'ChatGPT Sites는 배포·보안 헤더 호환성을 확인한 뒤 대체 후보',
      'Google 로그인',
      '30일·1회용',
      '유효기간이 길어도',
      '6자리 코드가 정확히 같을 때만 승인되며, 승인된 연결도 최대 30일 유지됩니다',
      '승인된 연결은 최대 30일',
      '등록 프로젝트·워크트리 제어, 프로젝트·AgentsToZ/Orca 워크트리 생성',
      '안전한 Codex 첫 대화 생성',
      '확인된 Git Commit·안전 Pull·Push·기본 브랜치 Merge와 허용된 앱 열기만 제공합니다.',
      '임의 파일 읽기·쓰기, 임의 명령, 워크트리 삭제',
      'Git 작업은 등록 프로젝트에서 휴대폰 확인 후 정해진 안전 동작만 실행하며',
      '이 Mac은 외부에 로컬 포트를 열지 않고',
      '경로, query, fragment, ID·토큰·키를 넣을 수 없습니다.',
      '허용된 프로젝트 열기·프로세스 제어 요청을 만들 수 있으므로',
      '이 주소의 /remote 코드 자체가',
      '본인이 배포하고 신뢰하는 HTTPS 주소만 입력하세요.',
      '신뢰하는 개인 배포 주소·30일 1회용 QR',
      '최대 30일 연결',
    ]) expect(source).toContain(phrase);
    expect(source).not.toContain('파일 내용·Git 변경');
    expect(source).toContain('riskAcknowledged');
    expect(source).toContain('외부 인터넷 원격제어 켜고 QR 발급');
  });

  test('prefills only the previously verified personal Vercel origin', () => {
    expect(appSource).toContain("import { normalizeVercelPortalDeployUrl } from './portalDeployUrl';");
    expect(appSource).toContain('defaultControllerOrigin={normalizeVercelPortalDeployUrl(');
    expect(appSource).toContain('portalConfigRef.current?.portalDeployUrl');
    expect(source).toContain('defaultControllerOrigin?: string | null');
    expect(source).toContain('normalizeInternetRemoteControllerOrigin(defaultControllerOrigin)');
  });

  test('requires an exact user-entered SAS before calling approval', () => {
    expect(source).toContain("entered !== session.sasCode");
    expect(source).toContain('휴대폰과 Mac에 보이는 6자리 코드');
    expect(source).toContain('휴대폰과 일치한 6자리 코드를 직접 입력');
    expect(source).toContain('pattern="[0-9]{6}"');
    expect(source).toContain('maxLength={6}');
    expect(source).toContain('data-testid="approve-internet-remote-session"');
    expect(source).toContain('grantConversationScope,');
    expect(source).toContain('data-testid="grant-internet-remote-task-scope"');
    expect(source).toContain('data-testid="grant-internet-remote-conversation-scope"');
    expect(source).toContain('AGENT_RUNTIME_MANAGED_EXECUTION_ENABLED');
    expect(source).toContain('안전 격리가 준비되지 않아 새 Codex 작업 권한을 켤 수 없습니다');
    expect(source).toContain('disabled={busy !== null || !AGENT_RUNTIME_MANAGED_EXECUTION_ENABLED}');
    expect(source).toContain('과거 승인 권한 · 현재 실행 불가 · 해제만 가능');
    expect(source).toContain('위험 권한 우회 실행은 원격에서 허용되지 않습니다');
    expect(source).toContain("typeof error === 'string' && error.trim()");
  });

  test('renders QR locally but never copies, logs, or persists its fragment-bearing URL', () => {
    expect(source).toContain("import { QRCodeSVG } from 'qrcode.react';");
    expect(source).toContain('<QRCodeSVG');
    expect(source).toContain('title="30일 일회용 외부 인터넷 원격제어 QR"');
    expect(source).toContain('setPairing(null)');
    expect(source).not.toContain('navigator.clipboard');
    expect(source).not.toContain('localStorage');
    expect(source).not.toContain('sessionStorage');
    expect(source).not.toContain('console.log');
    expect(source).not.toContain('chart.googleapis.com');
    expect(source).not.toContain('api.qrserver.com');
    expect(source).toContain('QR 링크 자체는 브라우저 저장소·클립보드에 기록하지 않습니다.');
    expect(source).toContain('QR 연결 식별자·비밀값과 호스트 키');
    expect(source).toContain('이 계정 전용 파일(권한 0600)에 저장합니다.');
    expect(source).not.toContain('링크 원문은 저장·복사·재조회하지 않습니다.');
  });

  test('polls sanitized status without racing mutations and exposes revoke/disable controls', () => {
    expect(source).toContain('document.hidden');
    expect(source).toContain('pollInFlight');
    expect(source).toContain('managementRevisionRef.current');
    expect(source).toContain('3_000');
    expect(source).toContain("document.addEventListener('visibilitychange', handleVisibilityChange)");
    expect(source).toContain('api.revokeSession(session.sessionId)');
    expect(source).toContain('api.updateSessionScopes(');
    expect(source).toContain('data-testid="update-internet-remote-task-scope"');
    expect(source).toContain('data-testid="update-internet-remote-conversation-scope"');
    expect(source).toContain('data-testid="save-internet-remote-session-scopes"');
    expect(source).toContain('QR 재연결 없이 바로 적용됩니다');
    expect(source).toContain('api.disable()');
    expect(source).toContain('외부 인터넷 원격제어 전체 끄기');
  });

  test('remains keyboard-contained and scrollable at saved high zoom', () => {
    expect(source).toContain("event.key === 'Escape'");
    expect(source).toContain("event.key !== 'Tab'");
    expect(source).toContain('previousFocusRef.current?.focus()');
    expect(source).toContain("maxHeight: 'calc(var(--ui-viewport-height, 100dvh) - max(24px, 10dvh))'");
    expect(source).toContain('w-full max-w-4xl min-w-0');
    expect(source).toContain('min-h-0 flex-1 overflow-y-auto');
    expect(source).toContain('grid-cols-1');
    expect(source).toContain('md:grid-cols-[minmax(0,1fr)_280px]');
    expect((source.match(/min-h-11/g) ?? []).length).toBeGreaterThanOrEqual(7);
  });
});

describe('adding a second device over the internet path', () => {
  const source = readFileSync(new URL('../src/InternetQrRemoteControlDialog.tsx', import.meta.url), 'utf8');
  const apiServerSource = readFileSync(new URL('../api-server.ts', import.meta.url), 'utf8');

  test('offers a new QR without disabling the host, and no longer says to turn it off', () => {
    // The relay binds one pairing row to one controller key, so a second phone
    // needs its own QR. The only documented route used to be disable→enable,
    // which revoked every connected device (VOC 2026-08-31 23:42).
    expect(source).toContain('data-testid="issue-internet-qr-remote-control-pairing"');
    expect(source).toContain('다른 기기 추가 (새 QR)');
    expect(source).toContain('handleIssuePairing');
    expect(source).toContain('api.issuePairing()');
    expect(source).not.toContain('새 QR이 꼭 필요하면 외부 인터넷 원격제어를 끈 뒤 다시 켜세요');
    expect(source).toContain('연결된 기기는 그대로 유지됩니다');
    expect(source).toContain('REMOTE_CONTROL_MAX_SESSIONS');
    expect(source).toContain('초과 발급 시 가장 오래된 미사용 QR이 자동 폐기됩니다');
  });

  test('the freshly minted QR survives unrelated sessions and clears only on its exact claim', () => {
    // Adding a device happens precisely when sessions already exist, and that
    // is the condition the poll uses to drop the QR from memory.
    expect(source).toContain('visiblePairingIdRef');
    expect(source).toContain('isInternetRemotePairingClaimed(');
    const current = '11111111-1111-4111-8111-111111111111';
    const other = '22222222-2222-4222-8222-222222222222';
    expect(isInternetRemotePairingClaimed(current, [{ pairingId: other, approvalState: 'approved' }])).toBe(false);
    // Revocation cannot un-spend a one-use QR; leaving it visible invites a
    // rescan that the relay must reject.
    expect(isInternetRemotePairingClaimed(current, [{ pairingId: current, approvalState: 'revoked' }])).toBe(true);
    expect(isInternetRemotePairingClaimed(current, [{ pairingId: current, approvalState: 'pending' }])).toBe(true);
    expect(isInternetRemotePairingClaimed(current, [{ pairingId: current, approvalState: 'approved' }])).toBe(true);
  });

  test('an older database at the unused-QR limit gives an actionable upgrade path', () => {
    const issueRoute = apiServerSource.slice(
      apiServerSource.indexOf("pathname === '/api/remote-control/internet/pairing/issue'"),
      apiServerSource.indexOf("pathname === '/api/remote-control/internet/sessions/approve'"),
    );
    expect(issueRoute).toContain("error.code === 'REMOTE_CONTROL_PAIRING_LIMIT'");
    expect(issueRoute).toContain("'INTERNET_REMOTE_MIGRATION_REQUIRED'");
    expect(issueRoute).toContain('가장 오래된 미사용 QR을 안전하게 정리');
  });
});

describe('published QR lifetime and restart contract', () => {
  const agents = readFileSync(new URL('../AGENTS.md', import.meta.url), 'utf8');
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const guide = readFileSync(new URL('../docs/user-guide/GUIDE.md', import.meta.url), 'utf8');

  test('documents 30-day one-use QR, 24-hour pending approval, and distinct restart behavior', () => {
    for (const source of [agents, readme, guide]) {
      expect(source).toContain('30일');
      expect(source).toContain('24시간');
      expect(source).toContain('0600');
    }
    expect(agents).toContain('LAN·외부 모두 30일·일회용');
    expect(readme).toContain('LAN 세션은 해당 WebSocket과 함께 끝나므로');
    expect(readme).toContain('재시작 뒤 복원을 시도');
    expect(guide).toContain('내부 호스트 행만 최대 62일 유지');
    expect(readme).not.toContain('내부 릴레이 준비 행만 최대 32일');
  });
});
