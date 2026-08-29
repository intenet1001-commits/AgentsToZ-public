import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  buildProjectFolderRenamePrompt,
  projectFolderNameProblem,
  renamedProjectFolderPath,
} from '../src/projectFolderRenamePrompt';

describe('project folder rename prompt', () => {
  test('macOS 프로젝트의 이전/새 경로와 충돌 방지 절차를 담는다', () => {
    const prompt = buildProjectFolderRenamePrompt({
      projectId: 'project-1',
      projectName: '프로젝트관리',
      currentFolderPath: '/Users/me/product_2026/portmanagement',
      newFolderName: 'AgentsToZ_byCS',
      commandPath: '/Users/me/product_2026/portmanagement/실행.command',
    });

    expect(prompt).toContain('"currentFolderPath": "/Users/me/product_2026/portmanagement"');
    expect(prompt).toContain('"targetFolderPath": "/Users/me/product_2026/AgentsToZ_byCS"');
    expect(prompt).toContain('git worktree repair');
    expect(prompt).toContain('ports.json');
    expect(prompt).toContain('workspace-roots.json');
    expect(prompt).toContain('orca-floating-terminals.json');
    expect(prompt).toContain('atomic rename');
    expect(prompt).toContain('git reset --hard');
    expect(prompt).toContain('옛 절대경로와 그 하위 경로인 값만');
    expect(prompt).toContain('cargo clean');
    expect(prompt).toContain('CARGO_TARGET_DIR');
  });

  test('Windows 경로도 부모를 유지하고 leaf 이름만 바꾼다', () => {
    expect(renamedProjectFolderPath('C:\\Users\\me\\portmanagement', 'AgentsToZ_byCS'))
      .toBe('C:\\Users\\me\\AgentsToZ_byCS');
  });

  test('같은 이름이나 경로 구분자가 든 입력은 거부한다', () => {
    expect(projectFolderNameProblem('/projects/current', 'current')).toBeTruthy();
    expect(projectFolderNameProblem('/projects/current', '../next')).toBeTruthy();
    expect(projectFolderNameProblem('/projects/current', '')).toBeTruthy();
  });

  test('상단에는 기본 프로젝트 바로가기만 두고 폴더명 변경은 상세 영역에 둔다', () => {
    const source = readFileSync(resolve(import.meta.dir, '../src/App.tsx'), 'utf8');
    expect(source).toContain('data-testid="primary-project-shortcut"');
    expect(source).toContain('data-testid="detail-folder-rename-prompt"');
    expect(source).not.toContain('data-testid="meta-copy-folder-rename-prompt"');
    expect(source).toContain('data-testid="meta-open-folder"');
    expect(source).toContain('data-testid="folder-rename-prompt-modal"');
    expect(source).not.toContain('data-testid="toolbar-project-rename-prompt"');
    expect(source).not.toContain('toolbarRenameProject');
    expect(source).not.toContain('data-testid="primary-project-rename-prompt"');
    expect(source).not.toContain('window.prompt(');
  });
});
