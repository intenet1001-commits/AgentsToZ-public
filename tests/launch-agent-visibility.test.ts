import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  ALL_LAUNCH_AGENTS,
  describeVisibleLaunchAgents,
  HIDDEN_LAUNCH_AGENTS_STORAGE_KEY,
  parseHiddenLaunchAgents,
  serializeHiddenLaunchAgents,
  toggleHiddenLaunchAgent,
  type LaunchAgent,
} from '../src/launchAgentVisibility';

const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');

describe('저장값 해석', () => {
  test('없거나 깨진 값은 "다 보임"으로 떨어진다', () => {
    // 파싱 실패로 버튼이 사라지면 사용자는 설정이 아니라 앱이 고장 났다고 읽는다.
    expect(parseHiddenLaunchAgents(null).size).toBe(0);
    expect(parseHiddenLaunchAgents('').size).toBe(0);
    expect(parseHiddenLaunchAgents('{oops').size).toBe(0);
    expect(parseHiddenLaunchAgents('"hermes"').size).toBe(0);
    expect(parseHiddenLaunchAgents('{"hermes":true}').size).toBe(0);
  });

  test('모르는 이름은 조용히 버린다', () => {
    const hidden = parseHiddenLaunchAgents('["hermes","gemini","agy"]');
    expect([...hidden].sort()).toEqual(['agy', 'hermes']);
  });

  test('직렬화는 순서를 고정해 같은 상태를 같은 문자열로 만든다', () => {
    const a = serializeHiddenLaunchAgents(new Set<LaunchAgent>(['hermes', 'claude']));
    const b = serializeHiddenLaunchAgents(new Set<LaunchAgent>(['claude', 'hermes']));
    expect(a).toBe(b);
    expect(a).toBe('["claude","hermes"]');
  });

  test('왕복하면 그대로다', () => {
    const hidden = new Set<LaunchAgent>(['codex', 'agy']);
    expect(parseHiddenLaunchAgents(serializeHiddenLaunchAgents(hidden))).toEqual(hidden);
  });
});

describe('토글', () => {
  test('원본을 바꾸지 않고 새 집합을 준다', () => {
    const before = new Set<LaunchAgent>(['codex']);
    const after = toggleHiddenLaunchAgent(before, 'hermes');
    expect([...before]).toEqual(['codex']);
    expect([...after].sort()).toEqual(['codex', 'hermes']);
    expect([...toggleHiddenLaunchAgent(after, 'codex')]).toEqual(['hermes']);
  });

  test('넷 다 숨기는 것도 허용한다', () => {
    let hidden = new Set<LaunchAgent>();
    for (const agent of ALL_LAUNCH_AGENTS) hidden = toggleHiddenLaunchAgent(hidden, agent);
    expect(hidden.size).toBe(4);
  });
});

describe('헤더 라벨', () => {
  test('전부 보이면 개수를 말하지 않는다', () => {
    expect(describeVisibleLaunchAgents(new Set())).toBe('AI 표시');
  });

  test('숨긴 것이 있으면 몇 개가 남았는지 말한다', () => {
    expect(describeVisibleLaunchAgents(new Set<LaunchAgent>(['hermes']))).toBe('AI 표시 3/4');
  });
});

describe('App 배선', () => {
  test('기기별 localStorage에 저장한다', () => {
    expect(HIDDEN_LAUNCH_AGENTS_STORAGE_KEY).toBe('portmanager-hidden-agents');
    expect(appSource).toContain('HIDDEN_LAUNCH_AGENTS_STORAGE_KEY');
  });

  test('네 표면의 실행 버튼이 모두 같은 판정을 쓴다', () => {
    for (const testid of [
      'project-claude-agent', 'project-codex-agent', 'project-agy-agent', 'project-hermes-agent',
      'project-claude-code-app', 'project-codex-app', 'project-hermes-app',
      'worktree-claude-agent', 'worktree-codex-agent', 'worktree-agy-agent', 'worktree-hermes-agent',
      'worktree-claude-code-app', 'worktree-codex-app', 'worktree-hermes-app',
      'detail-claude-code-app', 'detail-codex-app', 'detail-hermes-app',
      'header-claude-launch', 'header-codex-launch', 'header-agy-launch', 'header-hermes-launch',
    ]) {
      expect(appSource).toContain(`data-testid="${testid}"`);
    }
    // 각 버튼은 agentShown(...) 뒤에서만 렌더된다.
    for (const agent of ALL_LAUNCH_AGENTS) {
      expect(appSource).toContain(`agentShown('${agent}')`);
    }
  });

  test('헤더에 표시 설정 드롭다운이 있다', () => {
    expect(appSource).toContain('data-testid="agent-visibility-toggle"');
    // 체크박스는 ALL_LAUNCH_AGENTS를 map 하므로 testid가 템플릿으로 생성된다 —
    // 네 줄을 손으로 적지 않는 대신 목록과 렌더 형태를 확인한다.
    expect(appSource).toContain('{ALL_LAUNCH_AGENTS.map(agent => (');
    expect(appSource).toContain('data-testid={`agent-visibility-${agent}`}');
    expect(appSource).toContain('onChange={() => toggleAgentShown(agent)}');
    expect(appSource).toContain('checked={agentShown(agent)}');
  });
});
