import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveRegisteredAgentRuntimeTarget } from '../src/agentRuntimeTargetResolver';

const expectedCanonical = (path: string): string => {
  const canonical = realpathSync(path);
  return process.platform === 'darwin' && canonical.startsWith('/private/')
    ? canonical.slice('/private'.length)
    : canonical;
};

describe('agent runtime registered-target resolver', () => {
  test('resolves an opaque id to the current canonical registered directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-runtime-target-'));
    const project = join(root, 'project');
    mkdirSync(project);
    expect(resolveRegisteredAgentRuntimeTarget('project_12345678', [{
      id: 'project_12345678',
      name: 'Project',
      aiName: 'Runtime Core',
      folderPath: join(project, '.'),
    }])).toEqual({
      ok: true,
      targetId: 'project_12345678',
      projectLabel: 'Runtime Core',
      cwd: expectedCanonical(project),
    });
  });

  test('keeps an explicitly registered worktree as the execution directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-runtime-worktree-'));
    const main = join(root, 'main');
    const worktree = join(root, 'worktree');
    mkdirSync(main);
    mkdirSync(worktree);
    const rows = [{ id: 'project_12345678', name: 'Main', folderPath: main }, {
      id: 'project_12345678_wt_feature',
      name: 'Main (feature)',
      folderPath: worktree,
      worktreePath: worktree,
      worktreeParentId: 'project_12345678',
    }];
    expect(resolveRegisteredAgentRuntimeTarget('project_12345678_wt_feature', rows))
      .toMatchObject({ ok: true, targetId: 'project_12345678_wt_feature', cwd: expectedCanonical(worktree) });
  });

  test('prefers a worktreePath when a compatibility row also retains the main folderPath', () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-runtime-dual-path-'));
    const main = join(root, 'main');
    const worktree = join(root, 'worktree');
    mkdirSync(main);
    mkdirSync(worktree);
    expect(resolveRegisteredAgentRuntimeTarget('project_12345678', [{
      id: 'project_12345678',
      name: 'Feature task',
      folderPath: main,
      worktreePath: worktree,
    }])).toMatchObject({
      ok: true,
      targetId: 'project_12345678',
      cwd: expectedCanonical(worktree),
    });
  });

  test('rejects paths, missing rows, duplicate ids, and rows without a live directory', () => {
    expect(resolveRegisteredAgentRuntimeTarget('/private/project', [])).toMatchObject({ code: 'TARGET_INVALID' });
    expect(resolveRegisteredAgentRuntimeTarget('project_12345678', [])).toMatchObject({ code: 'TARGET_NOT_FOUND' });
    expect(resolveRegisteredAgentRuntimeTarget('project_12345678', [
      { id: 'project_12345678', folderPath: '/missing/a' },
      { id: 'project_12345678', folderPath: '/missing/b' },
    ])).toMatchObject({ code: 'TARGET_AMBIGUOUS' });
    expect(resolveRegisteredAgentRuntimeTarget('project_12345678', [
      { id: 'project_12345678', folderPath: '/missing/a' },
    ])).toMatchObject({ code: 'TARGET_NOT_FOUND' });
  });
});
