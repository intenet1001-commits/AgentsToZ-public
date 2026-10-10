import { describe, expect, test } from 'bun:test';
import React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { PinnedCommandButtons } from '../src/components/PinnedCommandButtons';

const source = readFileSync(new URL('../src/components/PinnedCommandButtons.tsx', import.meta.url), 'utf8');

function render(withWorkroom: boolean) {
  return renderToStaticMarkup(<PinnedCommandButtons projectPath="/projects/AgentsToZ_byCS" notify={() => {}}
    {...(withWorkroom ? { onRunInWorkroom: () => {} } : {})} />);
}

describe('도구 및 설정 — 고정 규격 명령 한 줄 컨트롤', () => {
  test('명령마다 복사 칸과 워크룸 아이콘 칸이 한 그룹으로 붙어 있다', () => {
    const html = render(true);
    const groups = html.match(/<span role="group" data-testid="pinned-command-control"[\s\S]*?<\/span>/g) ?? [];
    expect(groups.length).toBeGreaterThanOrEqual(2); // 기본 규격 명령 두 개
    for (const group of groups) {
      const id = group.match(/data-command-id="([^"]+)"/)![1];
      expect(group).toContain('규격 명령 복사"');
      expect(group).toContain('data-testid="pinned-command-workroom"');
      expect(group).toContain(`data-command-id="${id}"`);
      // 복사 칸이 먼저, 워크룸 아이콘 칸이 뒤에 붙는다.
      expect(group.indexOf('규격 명령 복사"')).toBeLessThan(group.indexOf('pinned-command-workroom'));
    }
  });

  test('기본 명령은 예전 test id와 aria-label을 유지한다', () => {
    const html = render(true);
    expect(html).toContain('data-testid="voc-workflow-prompt-copy"');
    expect(html).toContain('data-testid="git-sync-workflow-prompt-copy"');
    expect(html).toMatch(/aria-label="[^"]+ — 워크룸에서 실행"/);
  });

  test('워크룸 칸은 아이콘만이고, 초안만 채운다는 설명을 툴팁으로 준다', () => {
    const html = render(true);
    expect(html).not.toContain('워크룸에서 실행 · ');
    expect(html).toMatch(/title="워크룸에서 실행 — [^"]*초안으로 채워 엽니다\. 「선택한 AI로 시작」을 눌러야 실행됩니다\."/);
  });

  test('워크룸 콜백이 없으면 복사 칸만 그린다', () => {
    const html = render(false);
    expect(html).not.toContain('pinned-command-workroom');
    expect(html).toContain('data-testid="voc-workflow-prompt-copy"');
  });

  test('관리 버튼은 짧은 꼬리 버튼으로 남고 test id를 유지한다', () => {
    const html = render(true);
    expect(html).toContain('data-testid="pinned-commands-manage"');
    expect(html).toContain('aria-label="규격 명령 관리 — 추가·수정·순서·고정"');
    expect(html.lastIndexOf('pinned-command-control')).toBeLessThan(html.indexOf('pinned-commands-manage'));
  });

  test('색은 의미 토큰만 쓴다 — hex/rgba 리터럴 없음', () => {
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(source).not.toMatch(/rgba?\(\s*\d/);
  });
});
