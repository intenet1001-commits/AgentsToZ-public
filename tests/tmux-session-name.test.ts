import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  tmuxAgentSessionName,
  tmuxBypassSessionName,
  tmuxSessionName,
  tmuxWorktreeSuffix,
} from '../src/tmuxSessionName';

const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const apiSource = readFileSync(new URL('../api-server.ts', import.meta.url), 'utf8');
const rustSource = readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');

/** 해당 심볼/라우트가 시작하는 지점부터의 본문 조각 — 정확한 끝을 찾기보다
 * 다음 launcher가 시작하기 전까지를 보수적으로 자른다. */
function bodyAfter(source: string, marker: string, until: RegExp): string {
  const start = source.indexOf(marker);
  expect([marker, start >= 0]).toEqual([marker, true]);
  const rest = source.slice(start + marker.length);
  const end = rest.search(until);
  return end === -1 ? rest : rest.slice(0, end);
}

describe('tmux session naming', () => {
  test('a worktree is part of the session identity', () => {
    expect(tmuxAgentSessionName('demo', '/repo/worktrees/feature')).toBe('demo-feature');
    expect(tmuxAgentSessionName('demo', '/repo/worktrees/feature/')).toBe('demo-feature');
    // Only the first path of a comma-joined list names the session.
    expect(tmuxAgentSessionName('demo', '/repo/wt/a,/repo/wt/b')).toBe('demo-a');
    expect(tmuxAgentSessionName('demo', undefined)).toBe('demo');
    expect(tmuxAgentSessionName('demo', '   ')).toBe('demo');
    expect(tmuxWorktreeSuffix(null)).toBe('');
  });

  test('bypass sessions are named apart, once', () => {
    expect(tmuxBypassSessionName('demo', true)).toBe('demo-bypass');
    expect(tmuxBypassSessionName('demo', false)).toBe('demo');
  });

  test('the full rule composes worktree then bypass', () => {
    expect(tmuxSessionName('demo', '/repo/worktrees/feature', true)).toBe('demo-feature-bypass');
    expect(tmuxSessionName('demo', null, false)).toBe('demo');
  });

  // 예전 이 자리에는 정규식 **개수 단언**(`.toBe(2)`)이 있었다. 그것은 계약이 아니라
  // 그때의 소스 스냅샷이라, 다른 파일에 규칙이 복제돼도 초록이었다 — 실제로
  // api-server.ts 1곳 + lib.rs 4곳에 리터럴 복제가 있는 채로 통과하고 있었다.
  // 그래서 "몇 번 나오나"가 아니라 "명령을 만드는 모든 자리가 정본 함수를 부르나"로 바꾼다.
  test('every web tmux route derives its session name from the one owner', () => {
    for (const route of [
      '"/api/open-tmux-claude"',
      '"/api/open-tmux-claude-fresh"',
      '"/api/open-tmux-claude-bypass"',
      '"/api/open-tmux-codex"',
      '"/api/open-tmux-agy"',
    ]) {
      const body = bodyAfter(apiSource, route, /if \(url\.pathname === "\/api\/open-(tmux|cmux|terminal)/);
      expect([route, body.includes('tmuxSessionName(')]).toEqual([route, true]);
      // 접미사 없는 raw 이름으로 tmux를 조작하면 워크트리/bypass가 통째로 사라진다.
      expect([route, body.includes('escapeSq(sessionName)')]).toEqual([route, false]);
    }
  });

  test('every Rust tmux launcher derives its session name from the one owner', () => {
    for (const fn of [
      'fn open_tmux_claude(',
      'fn open_tmux_claude_fresh(',
      'fn open_tmux_claude_bypass(',
      'fn open_tmux_agent(',
    ]) {
      const body = bodyAfter(rustSource, fn, /\n#\[tauri::command/);
      expect([fn, body.includes('tmux_session_name(')]).toEqual([fn, true]);
      expect([fn, body.includes('escape_sq(&session_name)')]).toEqual([fn, false]);
      // `{}-bypass`를 포맷 문자열에 박으면 워크트리 접미사가 낄 자리를 잃는다.
      // (주석은 규칙이 아니므로 제외한다)
      const code = body.replace(/^\s*\/\/.*$/gm, '');
      expect([fn, code.includes('-bypass')]).toEqual([fn, false]);
    }
    // 규칙 자체는 정본 함수 안에만 산다.
    expect(rustSource.match(/format!\("\{\}-bypass"/g)?.length).toBe(1);
  });

  test('the frontend hands backends the bare base name', () => {
    // 프런트가 미리 붙이고 백엔드가 또 붙이면 "demo-feature-feature"가 된다.
    expect(appSource).not.toContain('tmuxAgentSessionName(');
    expect(appSource).not.toContain('const wtSuffix = context.worktreePath');
    for (const call of [
      'API.openTmuxClaude(sessionName',
      'API.openTmuxClaudeBypass(sessionName',
      'API.openTmuxClaudeFresh(sessionName',
      'API.openTmuxCodex(sessionName',
      'API.openTmuxAgy(sessionName',
    ]) {
      expect([call, appSource.includes(call)]).toEqual([call, true]);
    }
  });
});
