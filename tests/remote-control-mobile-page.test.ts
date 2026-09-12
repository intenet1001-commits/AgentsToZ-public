import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { REGISTERED_PROJECT_ACTIONS } from '../src/remoteControlCore';
import {
  REMOTE_CONTROL_MOBILE_HTML,
  REMOTE_CONTROL_MOBILE_JS,
  REMOTE_CONTROL_MOBILE_MANIFEST,
  remoteControlMobileAsset,
  remoteControlSecurityHeaders,
} from '../src/remoteControlMobilePage';

describe('QR remote-control mobile shell', () => {
  /**
   * The page's JS is a TEMPLATE LITERAL, so TypeScript consumes one level of
   * backslash before the browser ever sees the file: a `\n` written inside a
   * JS string literal in that template becomes a REAL newline and terminates
   * the string, killing the whole script with a SyntaxError.
   *
   * That is exactly what 85aef4b (2026-08-31) shipped — `confirm(... + "\n‘" ...)`
   * in sendAction — and nothing caught it: tsc only checks the TypeScript, and
   * source-substring assertions still matched. The same-Wi-Fi remote page was
   * dead on load (no project list, no actions, no search) with no error anywhere
   * on the host. Parse the emitted asset, not the source that produces it.
   */
  test('emits JavaScript the browser can actually parse', () => {
    expect(() => new Bun.Transpiler({ loader: 'js' }).transformSync(REMOTE_CONTROL_MOBILE_JS)).not.toThrow();
    // A newline that survived into the emitted asset means an escape was eaten.
    for (const line of REMOTE_CONTROL_MOBILE_JS.split('\n')) {
      const quotes = line.split('"').length - 1;
      expect({ line, quotes }).toEqual({ line, quotes: quotes - (quotes % 2) });
    }
  });

  test('removes the one-time fragment before DOM access or network activity', () => {
    const capture = REMOTE_CONTROL_MOBILE_JS.indexOf('let initialPairFragment = location.hash.slice(1)');
    const clear = REMOTE_CONTROL_MOBILE_JS.indexOf('history.replaceState');
    const dom = REMOTE_CONTROL_MOBILE_JS.indexOf('document.querySelector');
    const network = REMOTE_CONTROL_MOBILE_JS.indexOf('new WebSocket');
    expect(capture).toBe(0);
    expect(clear).toBeGreaterThan(capture);
    expect(clear).toBeLessThan(dom);
    expect(clear).toBeLessThan(network);
  });

  test('persists only resumable sessions and bounded opaque UI choices for fixed actions', () => {
    expect(REMOTE_CONTROL_MOBILE_JS).toContain('sessionToken');
    expect(REMOTE_CONTROL_MOBILE_JS).toContain('project.controlId');
    expect(REMOTE_CONTROL_MOBILE_JS).toContain('start: "실행"');
    expect(REMOTE_CONTROL_MOBILE_JS).toContain('stop: "중지"');
    expect(REMOTE_CONTROL_MOBILE_JS).toContain('restart: "재실행"');
    expect(REMOTE_CONTROL_MOBILE_JS).toContain('"folder.open": "Finder"');
    // Web storage holds the session token so a dropped socket does not cost a trip back to the
    // Mac. This used to forbid localStorage outright, on the grounds that per-tab storage is
    // erased when the tab closes — but that also erased the phone's half of a session the host
    // keeps for 30 days, so "paired tonight, works in the morning" could not happen at all: iOS
    // discards backgrounded tabs on its own. The boundary is narrowed rather than dropped — the
    // credential and bounded tab/opaque terminal choices may persist; never paths,
    // commands, drafts or output. The Mac still owns expiry and revocation.
    for (const match of REMOTE_CONTROL_MOBILE_JS.matchAll(/(?:local|session)Storage\.(\w+)\(([^),]*)/g)) {
      expect(['getItem', 'setItem', 'removeItem']).toContain(match[1]!);
      expect(['SESSION_STORAGE_KEY','WORKSPACE_TAB_STORAGE_KEY','TERMINAL_SELECTION_STORAGE_KEY']).toContain(match[2]!.trim());
    }
    expect(REMOTE_CONTROL_MOBILE_JS).toContain('localStorage.getItem(SESSION_STORAGE_KEY)');
    expect(REMOTE_CONTROL_MOBILE_JS).toContain('sessionStorage');
    expect(REMOTE_CONTROL_MOBILE_JS).not.toContain('crypto.randomUUID');
    expect(REMOTE_CONTROL_MOBILE_JS).not.toContain('serviceWorker');
    expect(REMOTE_CONTROL_MOBILE_JS).not.toContain('projectId');
    expect(REMOTE_CONTROL_MOBILE_JS).not.toContain('/api/');
    expect(REMOTE_CONTROL_MOBILE_JS.toLowerCase()).not.toContain('what-i-said');
    expect(REMOTE_CONTROL_MOBILE_JS).not.toContain('commandPath');
    expect(REMOTE_CONTROL_MOBILE_JS).not.toContain('folderPath');
  });

  test('serves only self-contained /remote/ assets and no inline or third-party script', () => {
    expect(REMOTE_CONTROL_MOBILE_HTML).toContain('src="/remote/app.js"');
    expect(REMOTE_CONTROL_MOBILE_HTML).toContain('href="/remote/styles.css"');
    expect(REMOTE_CONTROL_MOBILE_HTML).not.toContain('https://');
    expect(REMOTE_CONTROL_MOBILE_HTML).not.toContain('<script>');
    expect(remoteControlMobileAsset('/remote/')).not.toBeNull();
    expect(remoteControlMobileAsset('/remote/app.js')?.contentType).toContain('javascript');
    expect(remoteControlMobileAsset('/')).toBeNull();
    expect(remoteControlMobileAsset('/api/ports')).toBeNull();
    expect(JSON.parse(REMOTE_CONTROL_MOBILE_MANIFEST)).toMatchObject({
      start_url: '/remote/',
      scope: '/remote/',
      display: 'standalone',
    });
  });

  test('applies no-store, no-referrer, frame denial, exact self CSP, and no CORS grant', () => {
    const headers = remoteControlSecurityHeaders('http://192.168.10.20:43123');
    expect(headers.get('cache-control')).toContain('no-store');
    expect(headers.get('referrer-policy')).toBe('no-referrer');
    expect(headers.get('x-frame-options')).toBe('DENY');
    expect(headers.get('x-content-type-options')).toBe('nosniff');
    expect(headers.get('cross-origin-resource-policy')).toBe('same-origin');
    expect(headers.get('permissions-policy')).toContain('camera=()');
    const csp = headers.get('content-security-policy') ?? '';
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain('ws://192.168.10.20:43123');
    expect(headers.has('access-control-allow-origin')).toBe(false);
  });
  test('renders every project action the host can offer — the LAN page must not silently drop a feature', () => {
    // The Git and worktree actions were added to the host and to the Internet
    // controller card, but not to this page's ACTION_LABELS map, so on the
    // same-Wi-Fi QR surface Merge/Commit/Pull/Push and both worktree buttons
    // simply never rendered: the host offered them and nothing drew a button.
    // Nothing recorded that gap, which is why it survived several releases.
    const missing = [...REGISTERED_PROJECT_ACTIONS]
      .filter(action => !REMOTE_CONTROL_MOBILE_JS.includes(`"${action}":`)
        && !REMOTE_CONTROL_MOBILE_JS.includes(`${action}: "`));
    expect(missing).toEqual([]);
  });

  test('separates new, recent, Orca, and the two non-duplicate worktree choices', () => {
    expect(REMOTE_CONTROL_MOBILE_JS).toContain('heading: "새 대화"');
    expect(REMOTE_CONTROL_MOBILE_JS).toContain('actions: ["codex.thread.start"]');
    expect(REMOTE_CONTROL_MOBILE_JS).not.toContain('actions: ["claude.thread.start", "codex.thread.start"]');
    expect(REMOTE_CONTROL_MOBILE_JS).toContain('heading: "최근 대화 다시 열기"');
    expect(REMOTE_CONTROL_MOBILE_JS).toContain('heading: "Orca에서 열기"');
    expect(REMOTE_CONTROL_MOBILE_JS).toContain('"app.codex": "최근 Codex 대화 다시 열기"');
    expect(REMOTE_CONTROL_MOBILE_JS).toContain('"app.hermes": "최근 Hermes 대화 열기 요청"');
    expect(REMOTE_CONTROL_MOBILE_JS).toContain('Hermes는 Desktop 실행과 딥링크 전달까지만 확인');
    expect(REMOTE_CONTROL_MOBILE_JS).toContain('실제 대화 선택은 Mac의 앱에서 확인');
    expect(REMOTE_CONTROL_MOBILE_JS).toContain('lastActionCode === "app.hermes"');
    expect(REMOTE_CONTROL_MOBILE_JS).toContain('최근 Hermes 대화 열기 요청을 Mac에 전달했습니다.');
    expect(REMOTE_CONTROL_MOBILE_JS).toContain('"worktree.add": "+ 표준 Git 워크트리"');
    expect(REMOTE_CONTROL_MOBILE_JS).toContain('"worktree.add.orca": "+ Orca 등록 워크트리"');
    expect(REMOTE_CONTROL_MOBILE_JS).toContain('Orca 등록만 사이드바 카드도 추가');
    expect(REMOTE_CONTROL_MOBILE_JS).toContain('최초 로그인·약관 동의·폴더 신뢰 확인은 Mac의 Orca 화면');
  });

  test('collects the one-line input the host requires, and rejects an over-length value before the round trip', () => {
    for (const action of ['git.commit', 'worktree.add', 'worktree.add.orca']) {
      expect(REMOTE_CONTROL_MOBILE_JS).toContain(`"${action}": "`);
    }
    expect(REMOTE_CONTROL_MOBILE_JS).toContain('ACTION_PROMPTS[action]');
    expect(REMOTE_CONTROL_MOBILE_JS).toContain('input.length > 120');
    expect(REMOTE_CONTROL_MOBILE_JS).toContain('message.input = input');
  });

  test('renders the branch too — a field on only one phone surface is the Merge-button defect', () => {
    expect(REMOTE_CONTROL_MOBILE_JS).toContain('project.branch');
    expect(REMOTE_CONTROL_MOBILE_JS).toContain('branch.className = "branch"');
    // The \u escapes in the source resolve inside the template literal, so the
    // emitted page carries the real Korean.
    expect(REMOTE_CONTROL_MOBILE_JS).toContain('워크트리 브랜치');
    expect(REMOTE_CONTROL_MOBILE_JS).toContain('메인트리 브랜치');
  });

  test('searches every loaded page by name, alias, or branch and filters by path-free workspace-root labels', () => {
    expect(REMOTE_CONTROL_MOBILE_HTML).toContain('id="workspace-root-filter"');
    expect(REMOTE_CONTROL_MOBILE_JS).toContain('normalize("NFKC")');
    expect(REMOTE_CONTROL_MOBILE_JS).toContain('searchKey(project.name).includes(projectQuery)');
    expect(REMOTE_CONTROL_MOBILE_JS).toContain('searchKey(project.alias).includes(projectQuery)');
    expect(REMOTE_CONTROL_MOBILE_JS).toContain('searchKey(project.branch).includes(projectQuery)');
    expect(REMOTE_CONTROL_MOBILE_JS).toContain('project.workspaceRoot === selectedWorkspaceRoot.slice(WORKSPACE_ROOT_FILTER_PREFIX.length)');
    expect(REMOTE_CONTROL_MOBILE_JS).toContain('sendAction("projects.list", "", false, nextProjectPage)');
    expect(REMOTE_CONTROL_MOBILE_JS).toContain('sendAction("workspace-roots.list", "", false)');
    expect(REMOTE_CONTROL_MOBILE_JS).toContain('totalProjectCount');
    expect(REMOTE_CONTROL_MOBILE_JS).not.toContain('workspaceRoot.path');
  });

  test('states the session expiry with a date, not a bare clock time', () => {
    // Sessions last 30 days; toLocaleTimeString() alone made that read as
    // "expires today".
    expect(REMOTE_CONTROL_MOBILE_JS).not.toContain('toLocaleTimeString()');
    expect(REMOTE_CONTROL_MOBILE_JS).toContain('year: "numeric", month: "short", day: "numeric"');
  });
});

describe('Internet remote controller page CSP', () => {
  test('the inline bootstrap hash matches the script, in the page and in every vercel route', () => {
    // The hash is hand-copied into three files and generated by nothing. If the
    // inline script changes without them, the internet remote page's bootstrap
    // is blocked with no visible error and no test failure — a total outage for
    // the remote-control feature.
    // Resolve from this file, not the cwd: `bun run verify` runs
    // `bun test --cwd tests`, so a repo-root-relative path does not exist.
    const html = readFileSync(new URL('../remote/index.html', import.meta.url), 'utf8');
    const inline = html.match(/<script>([\s\S]*?)<\/script>/);
    expect(inline).not.toBeNull();
    const digest = `sha256-${createHash('sha256').update(inline![1]!, 'utf8').digest('base64')}`;
    expect(html).toContain(digest);
    const vercel = readFileSync(new URL('../vercel.json', import.meta.url), 'utf8');
    const declared = [...vercel.matchAll(/'(sha256-[A-Za-z0-9+/=]+)'/g)].map(match => match[1]);
    expect(declared.length).toBeGreaterThan(0);
    for (const value of declared) expect(value).toBe(digest);
  });
});

test('a request the Mac never answers releases the phone instead of disabling it forever', () => {
  // The page is shipped as a string, so this is a presence check rather than a behavioural one.
  // It exists because the failure it guards is invisible: the pill keeps reading 연결됨 while
  // every button stays disabled, which reads as "the app is broken", not "no reply came".
  expect(REMOTE_CONTROL_MOBILE_JS).toContain('ACTION_RESPONSE_TIMEOUT_MS');
  expect(REMOTE_CONTROL_MOBILE_JS).toContain('ACTION_NO_RESPONSE');
  // setBusy owns the timer on both edges: arming on true, clearing on false. Losing the clear
  // would fire a stale timeout over a later, healthy request.
  expect(REMOTE_CONTROL_MOBILE_JS).toContain('if (inFlightTimer) { clearTimeout(inFlightTimer); inFlightTimer = null; }');
});

test('a rate refusal is wired to the resume path and reads as waiting, not as a dead end', () => {
  // The scheduler's behaviour is executed in tests/remote-control-mobile-retry.test.ts. What is
  // left here is the wiring the harness cannot reach: that the failure branch actually calls it,
  // and that the user is told a retry is coming rather than being left with a short list.
  expect(REMOTE_CONTROL_MOBILE_JS).toContain('scheduleEnumerationRetry(lastActionCode, lastRequestedPage, RATE_LIMIT_RETRY_MS)');
  expect(REMOTE_CONTROL_MOBILE_JS).toContain('RATE_LIMITED: "잠시 뒤 자동으로 다시 시도합니다.');
  // The retried page has to be the one that was asked for, which means recording it on send.
  expect(REMOTE_CONTROL_MOBILE_JS).toContain('lastRequestedPage = action === "projects.list" && Number.isInteger(page) ? page : null;');
});
