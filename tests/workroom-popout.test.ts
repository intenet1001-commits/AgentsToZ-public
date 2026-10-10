import {describe, expect, test} from 'bun:test';
import {readFileSync, readdirSync} from 'node:fs';
import {
  WORKROOM_POPOUT_LABEL_GLOB, buildWorkroomPopoutQuery, buildWorkroomPopoutUrl, isWorkroomPopoutLabel,
  parseWorkroomPopout, workroomPopoutAvailability, workroomPopoutTitle,
} from '../src/workroomPopout';
import {isUsableRootPath, workroomProjectsFromPorts} from '../src/workroomProjects';

const golden = JSON.parse(readFileSync(new URL('./fixtures/workroom-popout-golden.json', import.meta.url), 'utf8')) as {
  queries: {query: string; valid: boolean}[]; labels: {label: string; valid: boolean}[];
};
const route = {sessionId: 'fixture-session-alpha', targetId: 'fixture-project-alpha', agent: 'codex' as const, bypassPermissions: true};

describe('Workroom pop-out route (shared golden with Rust)', () => {
  test('every golden query parses exactly as the Rust validator decides', () => {
    for (const {query, valid} of golden.queries) {
      expect({query, valid: parseWorkroomPopout('?' + query) !== null}).toEqual({query, valid});
    }
  });
  test('the builder produces a golden-valid query and round-trips', () => {
    const query = buildWorkroomPopoutQuery(route);
    expect(query).toBe(golden.queries[0]!.query);
    expect(parseWorkroomPopout('?' + query)).toEqual(route);
    expect(parseWorkroomPopout('?' + buildWorkroomPopoutQuery({...route, agent: 'claude', bypassPermissions: false})))
      .toEqual({...route, agent: 'claude', bypassPermissions: false});
  });
  test('the builder refuses anything that is not an opaque id', () => {
    expect(() => buildWorkroomPopoutQuery({...route, targetId: '/Users/me/project'})).toThrow();
    expect(() => buildWorkroomPopoutQuery({...route, sessionId: 'x'})).toThrow();
    expect(() => buildWorkroomPopoutQuery({...route, agent: 'bash' as never})).toThrow();
  });
  test('the web URL is the app entry on the current origin with only the pop-out query', () => {
    const url = new URL(buildWorkroomPopoutUrl('http://127.0.0.1:9000/some/page?tab=terminal#x', route));
    expect(url.origin).toBe('http://127.0.0.1:9000');
    expect(url.pathname).toBe('/');
    expect(url.hash).toBe('');
    expect(parseWorkroomPopout(url.search)).toEqual(route);
  });
  test('window labels match the capability glob and nothing else', () => {
    for (const {label, valid} of golden.labels) expect({label, valid: isWorkroomPopoutLabel(label)}).toEqual({label, valid});
    expect(WORKROOM_POPOUT_LABEL_GLOB).toBe('workroom-*');
  });
  test('title names the project and agent, strips control characters and stays short', () => {
    expect(workroomPopoutTitle('입력 검증 A', 'codex')).toBe('입력 검증 A · Codex CLI — 워크룸');
    expect(workroomPopoutTitle('a\u0000b\nc', 'claude')).toBe('a b c · Claude Code — 워크룸');
    expect(workroomPopoutTitle('', 'agy')).toBe('프로젝트 · Antigravity — 워크룸');
    expect(workroomPopoutTitle('x'.repeat(500), 'hermes').length).toBeLessThanOrEqual(120);
  });
  test('remote transports cannot be shared across windows, so the button explains instead of opening', () => {
    const remote = workroomPopoutAvailability({remote: true, tauri: false});
    expect(remote.available).toBe(false);
    expect(remote.reason).toContain('휴대폰');
    expect(workroomPopoutAvailability({remote: false, tauri: true}).available).toBe(true);
    expect(workroomPopoutAvailability({remote: false, tauri: false}).available).toBe(true);
  });
});

describe('Workroom pop-out Tauri capability scoping', () => {
  const dir = new URL('../src-tauri/capabilities/', import.meta.url);
  const read = (name: string) => JSON.parse(readFileSync(new URL(name, dir), 'utf8'));
  test('the main window capability is unchanged and still main-only', () => {
    const main = read('default.json');
    expect(main.windows).toEqual(['main']);
    expect(main.permissions).toEqual([
      'core:default', 'core:webview:allow-set-webview-zoom', 'dialog:default', 'dialog:allow-open', 'dialog:allow-save',
      'fs:default', 'fs:allow-read-text-file', 'fs:allow-read-file', 'fs:allow-exists', 'fs:allow-stat', 'fs:allow-write-text-file',
      'global-shortcut:default', 'global-shortcut:allow-register', 'global-shortcut:allow-unregister', 'global-shortcut:allow-is-registered',
    ]);
  });
  test('pop-out windows get only their own title, and no capability can create windows from JS', () => {
    const popout = read('workroom-popout.json');
    expect(popout.windows).toEqual([WORKROOM_POPOUT_LABEL_GLOB]);
    expect(popout.permissions).toEqual(['core:window:allow-set-title']);
    expect(popout.remote).toBeUndefined();
    for (const file of readdirSync(dir).filter(name => name.endsWith('.json'))) {
      const text = readFileSync(new URL(file, dir), 'utf8');
      expect({file, creates: /create-webview|allow-create/.test(text)}).toEqual({file, creates: false});
    }
  });
});

describe('Workroom project list shared by the main window and pop-outs', () => {
  test('registered rows become opaque targets; paths never leave', () => {
    const projects = workroomProjectsFromPorts([
      {id: 'project-main-1', name: '메인', folderPath: '/Users/me/a'},
      {id: 'project-tree-1', name: '트리\u0007', worktreePath: '/Users/me/a/worktrees/x', worktreeParentId: 'project-main-1'},
      {id: 'project-main-1', name: '중복', folderPath: '/Users/me/b'},
      {id: 'no/slash-ok?', name: '나쁜 id', folderPath: '/Users/me/c'},
      {id: 'project-nopath', name: '경로 없음'},
      {id: 'project-noname', name: '  ', folderPath: '/Users/me/d'},
    ]);
    expect(projects).toEqual([
      {targetId: 'project-main-1', projectTargetId: 'project-main-1', label: '메인', scope: 'main', worktreeCapable: false},
      {targetId: 'project-tree-1', projectTargetId: 'project-main-1', label: '트리', scope: 'worktree', worktreeCapable: true},
    ]);
    expect(JSON.stringify(projects)).not.toContain('/Users/');
  });
  test('only absolute paths for this platform count', () => {
    expect(isUsableRootPath('/Users/me')).toBe(true);
    expect(isUsableRootPath('relative/path')).toBe(false);
    expect(isUsableRootPath('')).toBe(false);
  });
});
