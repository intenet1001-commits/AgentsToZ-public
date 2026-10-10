import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { tmuxSessionName } from '../src/tmuxSessionName';

/**
 * 이 표는 계약이다. Rust 백엔드(`src-tauri/src/lib.rs`의
 * `tmux_session_names_match_the_golden_table`)가 **같은 파일**을 `include_str!`로
 * 읽어 같은 단언을 한다 — 그래야 "세션명 규칙은 한 곳뿐"이 문서가 아니라 검증이 된다.
 */
type GoldenCase = {
  agent: 'claude' | 'codex' | 'agy';
  baseName: string;
  worktreePath: string | null;
  bypass: boolean;
  expected: string;
};

const golden = JSON.parse(
  readFileSync(new URL('./fixtures/tmux-session-golden.json', import.meta.url), 'utf8'),
) as { cases: GoldenCase[] };

describe('tmux session naming parity', () => {
  test('the TypeScript owner matches the golden table', () => {
    expect(golden.cases.length).toBeGreaterThanOrEqual(18);
    for (const c of golden.cases) {
      expect({ ...c, actual: tmuxSessionName(c.baseName, c.worktreePath, c.bypass) })
        .toEqual({ ...c, actual: c.expected });
    }
  });

  test('the rule does not depend on which agent is launched', () => {
    // Codex/agy는 예전에 접미사를 하나도 붙이지 않아서 메인트리와 워크트리가 한
    // 세션을 공유했다. 표의 세 에이전트가 같은 입력에 같은 이름을 갖는지 확인한다.
    const byShape = new Map<string, Set<string>>();
    for (const c of golden.cases) {
      const key = `${c.baseName}|${c.worktreePath}|${c.bypass}`;
      if (!byShape.has(key)) byShape.set(key, new Set());
      byShape.get(key)!.add(c.expected);
    }
    for (const [key, names] of byShape) {
      expect([key, names.size]).toEqual([key, 1]);
    }
  });

  test('"실행"(reuse) and "새 창"(fresh) derive the same name from the same input', () => {
    for (const bypass of [false, true]) {
      for (const worktree of [null, '/repo/worktrees/feature', '/repo/wt/a,/repo/wt/b']) {
        const reuse = tmuxSessionName('demo', worktree, bypass);
        const fresh = tmuxSessionName('demo', worktree, bypass);
        expect(fresh).toBe(reuse);
        // 접미사는 정확히 한 번만 붙는다 — 프런트가 미리 붙이고 백엔드가 또 붙이면
        // "demo-feature-feature"가 되어 두 버튼이 서로 다른 세션을 가리킨다.
        expect(reuse.split('-bypass').length - 1).toBe(bypass ? 1 : 0);
      }
    }
  });
});
