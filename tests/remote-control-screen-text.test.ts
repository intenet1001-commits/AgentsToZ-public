import { describe, expect, test } from 'bun:test';
import { REMOTE_CONTROL_MOBILE_JS } from '../src/remoteControlMobilePage';
import { REGISTERED_PROJECT_ACTIONS } from '../src/remoteControlCore';
import { phoneDateTime } from '../src/phoneTime';
import { opsStatusText, remoteActionErrorHint, remoteControlActionConfirm, remoteControlActionDone, remoteControlActionLabel, remoteProjectStatusLabel, workroomSessionStateLabel } from '../src/remoteControlScreenText';

// The internet portal and the same-Wi-Fi QR page drew these separately and drifted (2026-10-07 audit).
describe('one set of words for both phone surfaces', () => {
  test('the QR page embeds the exact functions the portal uses', () => {
    for (const [name, fn] of [['actionLabel', remoteControlActionLabel], ['statusLabel', remoteProjectStatusLabel],
      ['errorNextStep', remoteActionErrorHint], ['sessionStateLabel', workroomSessionStateLabel], ['opsStatusLine', opsStatusText],
      ['actionConfirm', remoteControlActionConfirm]] as const) {
      expect(REMOTE_CONTROL_MOBILE_JS).toContain(`const ${name}=${fn.toString()}`);
    }
    expect(REMOTE_CONTROL_MOBILE_JS).not.toContain('ACTION_LABELS');
    expect(REMOTE_CONTROL_MOBILE_JS).not.toContain('ERROR_NEXT_STEPS');
  });

  test('the embedded functions run on their own — no module scope', () => {
    for (const fn of [remoteControlActionLabel, remoteProjectStatusLabel, remoteActionErrorHint, workroomSessionStateLabel, opsStatusText,
      remoteControlActionConfirm, remoteControlActionDone]) {
      const isolated = new Function(`return (${fn.toString()})`)();
      expect(typeof isolated).toBe('function');
    }
    const label = new Function(`return (${remoteControlActionLabel.toString()})`)();
    expect(label('orca.open')).toBe('Orca localhost');
    expect(label('git.merge')).toBe('기본 브랜치에 Merge');
  });

  test('the portal lists the files a dirty-tree refusal names, like the QR page', () => {
    const portal = require('node:fs').readFileSync(new URL('../src/remote-control-portal-main.tsx', import.meta.url), 'utf8') as string;
    expect(portal).toContain('value instanceof RemoteControlRelayRequestError ? value.changedPaths.slice(0, 12) : []');
    expect(portal).toContain('data-testid="remote-alert-paths"');
  });

  test('what used to differ now reads the same everywhere', () => {
    expect(remoteProjectStatusLabel({ status: 'unknown', port: 5173 })).toBe('포트 5173 · 상태 확인 필요');
    expect(remoteProjectStatusLabel({ kind: 'worktree' })).toBe('워크트리 · 포트 없음');
    expect(workroomSessionStateLabel({ state: 'running' })).toBe('실행 중');
    expect(workroomSessionStateLabel({ state: 'exited', exitCode: 0 })).toBe('종료 0');
    expect(workroomSessionStateLabel({ state: 'exited' })).toBe('종료');
    expect(opsStatusText({ state: 'mystery', pendingCount: 2 })).toBe('상태 확인 필요 · 저장 후보 2개');
    expect(remoteActionErrorHint('GIT_WORKTREE_DIRTY')).toContain('Commit');
    expect(remoteActionErrorHint('SOMETHING_ELSE')).toBeNull();
    expect(remoteControlActionLabel('unknown.action')).toBe('unknown.action');
  });
});

// Production audit 2026-10-16: confirms and notices were built by appending words to the button label —
// 「Finder 기능을 실행할까요?」, 「Pull 요청을 완료했습니다.」 (a GitHub pull request?), 「+ 표준 Git 워크트리 기능을 실행할까요?」,
// and on an English-region iPhone the OPS line read 「마지막 저장 10/16/2026, 2:04:05 PM」 inside a Korean sentence.
describe('a sentence per action, one date format', () => {
  test('every action a project card can offer has its own question and outcome', () => {
    for (const action of [...REGISTERED_PROJECT_ACTIONS, 'ops.status', 'ops.memory.pending', 'ops.open']) {
      const question = remoteControlActionConfirm(action);
      const done = remoteControlActionDone(action);
      expect(question).not.toContain('기능을 실행');
      expect(question).not.toContain(action);
      expect(question.endsWith('?')).toBe(true);
      expect(done).not.toContain('요청을 완료');
      expect(done).not.toContain(action);
      expect(question).not.toMatch(/^\+/);
    }
    expect(remoteControlActionConfirm('folder.open')).toContain('Finder에서');
    expect(remoteControlActionConfirm('git.pull')).toContain('(git pull)');
    expect(remoteControlActionDone('git.pull')).toContain('(git pull)');
    expect(remoteControlActionDone('folder.open')).toBe('Mac의 Finder에서 폴더를 열었습니다.');
    // An app the Mac only asks to open is not said to have opened.
    expect(remoteControlActionDone('app.codex')).toContain('요청했습니다');
    expect(remoteControlActionDone('app.hermes')).toContain('요청했습니다');
    // Unknown actions still say something true.
    expect(remoteControlActionConfirm('mystery.action')).toBe('「mystery.action」 동작을 실행할까요?');
    expect(remoteControlActionLabel('ops.open')).not.toContain('AgentsToZ OPS');
  });

  test('the QR page asks the same question, and names OPS the way the glossary does', () => {
    expect(REMOTE_CONTROL_MOBILE_JS).toContain('actionConfirm(action)');
    expect(REMOTE_CONTROL_MOBILE_JS).not.toContain('" \uae30\ub2a5\uc744 \uc2e4\ud589\ud560\uae4c\uc694?"');
    expect(REMOTE_CONTROL_MOBILE_JS).not.toContain(' 기능을 실행할까요?');
    expect(REMOTE_CONTROL_MOBILE_JS).not.toContain('"AgentsToZ OPS"');
  });

  test('the OPS line uses the phone date format, whatever the device region', () => {
    const iso = '2026-10-16T05:04:05.000Z';
    const line = opsStatusText({ state: 'ready', pendingCount: 2, lastSavedAt: iso });
    expect(line.endsWith(`마지막 저장 ${phoneDateTime(iso)}`)).toBe(true);
    expect(line).not.toMatch(/AM|PM|오전|오후|:05$/);
    // The embedded copy gives the same line.
    const isolated = new Function(`return (${opsStatusText.toString()})`)();
    expect(isolated({ state: 'ready', pendingCount: 2, lastSavedAt: iso })).toBe(line);
    expect(opsStatusText({ state: 'ready', pendingCount: 0, lastSavedAt: 'not a date' })).toBe('운영기억 연결됨 · 저장 후보 0개');
  });

  // UX audit 2026-10-25: a local-only Mac read 「운영기억 연결됨」 like a shared one. The DTO already carried backend
  // and syncState; only this line ignored them. No DTO key is added.
  test('the OPS line says whether the memory is this Mac only or shared', () => {
    expect(opsStatusText({ state: 'ready', backend: 'app-data', syncState: 'not-configured', pendingCount: 1 })).toBe('운영기억 준비됨 · 이 Mac 전용 · 저장 후보 1개');
    expect(opsStatusText({ state: 'ready', backend: 'control-folder', syncState: 'current', pendingCount: 0 })).toBe('운영기억 연결됨 · 다른 Mac과 공유 · 저장 후보 0개');
    expect(opsStatusText({ state: 'ready', backend: 'control-folder', syncState: 'needs-attention', pendingCount: 0 })).toBe('운영기억 연결됨 · 동기화 확인 필요 · 저장 후보 0개');
    expect(opsStatusText({ state: 'ready', backend: 'control-folder', syncState: null, pendingCount: 0 })).toBe('운영기억 연결됨 · 저장 후보 0개');
    // Scope is only claimed for a ready memory.
    expect(opsStatusText({ state: 'needs-attention', backend: 'app-data', syncState: 'current', pendingCount: 0 })).toBe('연결 확인 필요 · 저장 후보 0개');
    expect(opsStatusText({ state: 'unconfigured', backend: null, syncState: null, pendingCount: 0 })).toBe('아젠투지 준비 필요 · 저장 후보 0개');
    const isolated = new Function(`return (${opsStatusText.toString()})`)();
    expect(isolated({ state: 'ready', backend: 'app-data', pendingCount: 1 })).toBe('운영기억 준비됨 · 이 Mac 전용 · 저장 후보 1개');
  });
});

// Review of the 2026-10-16 copy fixes: the same-Wi‑Fi QR page still built its outcome by appending 「 완료」 to the
// button label (「Pull 완료」, 「Mac의 Codex 앱에서 열기 완료」 for an app it only asked to open), and its session
// expiry and error-log times followed the device region (「최대 Oct 16, 2026, 02:04 PM까지」 inside Korean text).
// handleActionResult and recordError are lifted out of the shipped page and run against stubs.
describe('the QR page says what happened the way the portal does', () => {
  const lift = (from: string, to: string) => {
    const start = REMOTE_CONTROL_MOBILE_JS.indexOf(from);
    const end = REMOTE_CONTROL_MOBILE_JS.indexOf(to, start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    return REMOTE_CONTROL_MOBILE_JS.slice(start, end);
  };
  // The embedded copies are checked to be these exact functions (above and below), so the source is used directly.

  function actionResult(action: string, message: Record<string, unknown>) {
    const notices: string[] = [];
    const run = new Function('notices', 'action', 'message', `
      const actionLabel = ${remoteControlActionLabel.toString()}, opsStatusLine = ${opsStatusText.toString()};
      // What the page has under this name — nothing before the fix, so the lifted code shows what it really does.
      const actionDone = ${REMOTE_CONTROL_MOBILE_JS.includes('const actionDone=') ? remoteControlActionDone.toString() : 'undefined'};
      let lastActionName = actionLabel(action) || action, lastActionCode = action, lastRequestedPage = null;
      let projects = [], nextProjectPage = null, totalProjectCount = 0, workspaceRootsRequested = true, currentProjectCreateIntent = null;
      const opsStatus = { textContent: '' }, RATE_LIMIT_RETRY_MS = 11000;
      const element = () => ({ replaceChildren() {}, append() {}, add() {}, value: '', hidden: false, textContent: '' });
      const document = { querySelector: element, createElement: element };
      function setBusy() {} function renderProjects() {} function updateProject() {} function recordError() {}
      function terminalReady() {} function showWorkspaceTab() {} function scheduleEnumerationRetry() {}
      function projectIntentStore() { return { complete() {} }; } function setTimeout() {} function sendAction() {}
      function notify(text) { notices.push(text); }
      ${lift('function handleActionResult(message) {', '/**\n * Resume an enumeration')}
      handleActionResult(message);
    `);
    run(notices, action, { type: 'action.result', ok: true, ...message });
    return notices;
  }

  test('the QR page embeds the portal\'s outcome sentence', () => {
    expect(REMOTE_CONTROL_MOBILE_JS).toContain(`const actionDone=${remoteControlActionDone.toString()}`);
  });

  test('a project action, an OPS check and the list each say a sentence, not 「<label> 완료」', () => {
    const project = { controlId: 'C'.repeat(43), name: 'p', kind: 'main', status: 'stopped', actions: [] };
    for (const action of ['git.pull', 'folder.open', 'start', 'app.codex', 'codex.thread.start']) {
      const [notice] = actionResult(action, { project });
      expect(notice).toBe(remoteControlActionDone(action));
      expect(notice).not.toMatch(/ 완료$/);
    }
    // An app the Mac only asks to open is not said to have opened.
    expect(actionResult('app.codex', { project })[0]).toContain('요청했습니다');
    expect(actionResult('codex.thread.start', { project })[0]).toContain('요청했습니다');
    expect(actionResult('ops.status', { ops: { state: 'ready', pendingCount: 0, lastSavedAt: null } })[0]).toBe('운영기억 상태를 확인했습니다.');
    expect(actionResult('ops.memory.pending', { opsCandidates: { candidates: [] } })[0]).toBe('운영기억 저장 후보를 확인했습니다.');
    const listed = actionResult('projects.list', { projects: [project], page: 0, nextPage: null, projectCount: 1 });
    expect(listed[0]).not.toContain('projects.list');
    expect(listed[0]).not.toMatch(/ 완료$/);
  });

  test('the QR page\'s dates are the phone format, not the device region\'s', () => {
    const items: { textContent: string }[][] = [];
    const run = new Function('items', `
      const phoneDate = ${REMOTE_CONTROL_MOBILE_JS.includes('const phoneDate=') ? phoneDateTime.toString() : 'undefined'}, errorNextStep = () => null;
      const element = () => { const node = { children: [], textContent: '', className: '', append(...c) { node.children.push(...c); }, hidden: true }; return node; };
      const errorLog = element(), errorItems = { prepend(item) { items.push(item.children); }, children: [] };
      const document = { createElement: element };
      const MAX_ERROR_ENTRIES = 20;
      ${lift('function recordError(context, error) {', '\n}\n') + '\n}'}
      recordError('Pull', { code: 'X', message: 'm' });
    `);
    run(items);
    const head = items[0]?.[0]?.textContent ?? '';
    expect(head).toBe(`${phoneDateTime(Date.now())} · Pull`);
    // The session expiry (「최대 … 까지」) uses it too: nothing on the page follows the device region any more.
    expect(REMOTE_CONTROL_MOBILE_JS).toContain(`const phoneDate=${phoneDateTime.toString()}`);
    expect(REMOTE_CONTROL_MOBILE_JS).not.toMatch(/toLocale(?:Time|Date)?String\(undefined/);
  });
});
