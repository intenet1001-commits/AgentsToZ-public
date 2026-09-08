import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RemoteControlProjectCard } from '../src/RemoteControlProjectCard';

describe('hosted remote-control project card', () => {
  test('keeps first conversation, desktop app open, and both worktree choices visibly distinct', () => {
    const html = renderToStaticMarkup(createElement(RemoteControlProjectCard, {
      project: {
        controlId: 'opaque_project_control',
        name: '새 프로젝트',
        alias: null,
        workspaceRoot: null,
        branch: null,
        port: null,
        kind: 'main' as const,
        status: 'unknown' as const,
        actions: [
          'folder.open' as const,
          'agent.claude' as const,
          'app.codex' as const,
          'app.hermes' as const,
          // A stale/older host may still send this protocol action. Current UI
          // must not bring the removed button back.
          'claude.thread.start' as const,
          'codex.thread.start' as const,
          'git.commit' as const,
          'git.pull' as const,
          'git.push' as const,
          'worktree.add' as const,
          'worktree.add.orca' as const,
        ],
      },
      busy: false,
      onAction() {},
    }));

    expect(html).toContain('data-testid="remote-project-card"');
    expect(html).toContain('새 대화');
    expect(html).not.toContain('data-action="claude.thread.start"');
    expect(html).not.toContain('Claude Code 처음 연결');
    expect(html).toContain('data-action="codex.thread.start"');
    expect(html).toContain('새 Codex 대화 만들기');
    expect(html).toContain('Codex는 누를 때마다 이 프로젝트·워크트리에 연결된 새 대화를 만들고');
    expect(html).toContain('최근 대화 다시 열기');
    expect(html).toContain('data-action="agent.claude"');
    expect(html).toContain('Orca · Claude');
    expect(html).toContain('최초 로그인·약관 동의·폴더 신뢰 확인은 Mac의 Orca 화면에서 사용자가 한 번 직접 완료');
    expect(html).toContain('data-action="app.codex"');
    expect(html).toContain('최근 Codex 대화 다시 열기');
    expect(html).toContain('data-action="app.hermes"');
    expect(html).toContain('최근 Hermes 대화 열기 요청');
    expect(html).toContain('Hermes는 Desktop 실행과 딥링크 전달까지만 확인');
    expect(html).toContain('실제 대화 선택은 Mac의 앱에서 확인');
    expect(html).toContain('data-action="worktree.add"');
    expect(html).toContain('+ 표준 Git 워크트리');
    expect(html).toContain('data-action="worktree.add.orca"');
    expect(html).toContain('+ Orca 등록 워크트리');
    expect(html).toContain('두 버튼은 중복이 아닙니다');
    expect(html).toContain('“Orca 등록”만 Orca 사이드바에 카드도 추가');
    expect(html.indexOf('새 대화')).toBeLessThan(html.indexOf('최근 대화 다시 열기'));
    expect(html.indexOf('최근 대화 다시 열기')).toBeLessThan(html.indexOf('Orca에서 열기'));
    expect(html).not.toContain('worktree.remove');
  });

  test('renders an auto-discovered worktree card without offering nested creation', () => {
    const html = renderToStaticMarkup(createElement(RemoteControlProjectCard, {
      project: {
        controlId: 'opaque_worktree_control',
        name: '새 프로젝트 · codex/feature',
        alias: null,
        workspaceRoot: null,
        branch: null,
        port: null,
        kind: 'worktree' as const,
        status: 'unknown' as const,
        actions: [
          'folder.open' as const,
          'agent.claude' as const,
          'app.codex' as const,
          'claude.thread.start' as const,
          'codex.thread.start' as const,
          'git.commit' as const,
          'git.pull' as const,
          'git.push' as const,
          'git.merge' as const,
        ],
      },
      busy: false,
      onAction() {},
    }));
    expect(html).toContain('WORKTREE');
    expect(html).not.toContain('Claude Code 처음 연결');
    expect(html).not.toContain('data-action="claude.thread.start"');
    expect(html).toContain('새 Codex 대화 만들기');
    expect(html).toContain('기본 브랜치에 Merge');
    expect(html).not.toContain('+ 표준 Git 워크트리');
    expect(html).not.toContain('+ Orca 등록 워크트리');
  });
  test('shows the saved name as the title and the AI alias as a secondary line', () => {
    const html = renderToStaticMarkup(createElement(RemoteControlProjectCard, {
      project: {
        controlId: 'opaque_project_control',
        name: '헤르메스',
        alias: 'Claude Agent Config',
        workspaceRoot: null,
        branch: null,
        port: null,
        kind: 'main' as const,
        status: 'unknown' as const,
        actions: ['folder.open' as const],
      },
      busy: false,
      onAction: () => {},
    }));
    expect(html).toContain('<h2>헤르메스</h2>');
    expect(html).toContain('별명 · Claude Agent Config');
    expect(html.indexOf('헤르메스')).toBeLessThan(html.indexOf('Claude Agent Config'));
  });

  test('omits the alias line when there is none', () => {
    const html = renderToStaticMarkup(createElement(RemoteControlProjectCard, {
      project: {
        controlId: 'opaque_project_control',
        name: 'AgentsToZ_byCS',
        alias: null,
        workspaceRoot: null,
        branch: null,
        port: null,
        kind: 'main' as const,
        status: 'unknown' as const,
        actions: ['folder.open' as const],
      },
      busy: false,
      onAction: () => {},
    }));
    expect(html).not.toContain('별명 ·');
  });

  test('shows only the workspace-root display name and never a local path field', () => {
    const html = renderToStaticMarkup(createElement(RemoteControlProjectCard, {
      project: {
        controlId: 'opaque_project_control',
        name: 'AgentsToZ_byCS',
        alias: null,
        workspaceRoot: '제품 작업',
        branch: null,
        port: null,
        kind: 'main' as const,
        status: 'unknown' as const,
        actions: ['folder.open' as const],
      },
      busy: false,
      onAction: () => {},
    }));
    expect(html).toContain('data-testid="remote-project-root"');
    expect(html).toContain('작업 루트 · 제품 작업');
    expect(html).not.toContain('folderPath');
    expect(html).not.toContain('/Users/');
  });
  test('shows the checked-out branch, labelled for the kind of card', () => {
    // VOC 2026-08-31 23:42: "특정 프로젝트의 메인트리, 브랜치를 보고 관리할 수 있는 기능이 없다."
    for (const [kind, label] of [['main', '메인트리 브랜치'], ['worktree', '워크트리 브랜치']] as const) {
      const html = renderToStaticMarkup(createElement(RemoteControlProjectCard, {
        project: {
          controlId: 'opaque_project_control',
          name: 'AgentsToZ_byCS',
          alias: null,
          workspaceRoot: null,
          branch: 'feature/buzz-purpose',
          port: null,
          kind,
          status: 'unknown' as const,
          actions: ['folder.open' as const],
        },
        busy: false,
        onAction: () => {},
      }));
      expect(html).toContain('data-testid="remote-project-branch"');
      expect(html).toContain(label);
      expect(html).toContain('feature/buzz-purpose');
    }
  });

  test('omits the branch line for a detached or unknown head', () => {
    const html = renderToStaticMarkup(createElement(RemoteControlProjectCard, {
      project: {
        controlId: 'opaque_project_control',
        name: 'AgentsToZ_byCS',
        alias: null,
        workspaceRoot: null,
        branch: null,
        port: null,
        kind: 'main' as const,
        status: 'unknown' as const,
        actions: ['folder.open' as const],
      },
      busy: false,
      onAction: () => {},
    }));
    expect(html).not.toContain('data-testid="remote-project-branch"');
  });
});
