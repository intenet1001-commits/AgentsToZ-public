import { describe, expect, test } from 'bun:test';

import {
  buildAgentRuntimeTargetInventory,
  deriveAgentRuntimeWorktreeTargetId,
} from '../src/agentRuntimeTargetInventory';

describe('Agent Runtime target inventory', () => {
  test('keeps registered folders and projects, then adds current Git worktrees with opaque IDs', () => {
    const inventory = buildAgentRuntimeTargetInventory({
      registered: [
        {
          targetId: 'project_12345678',
          label: 'AgentsToZ',
          cwd: '/private/projects/agentstoz',
          scopeHint: 'main',
          parentTargetId: null,
        },
        {
          targetId: 'folder_12345678',
          label: '일반 폴더',
          cwd: '/private/projects/folder',
          scopeHint: 'main',
          parentTargetId: null,
        },
      ],
      families: [{
        projectTargetId: 'project_12345678',
        worktrees: [
          { cwd: '/private/projects/agentstoz', branch: 'main', isMain: true, locked: false },
          { cwd: '/private/projects/agentstoz/worktrees/runtime', branch: 'runtime', isMain: false, locked: true },
        ],
      }],
      discoveryComplete: true,
    });

    expect(inventory.complete).toBe(true);
    expect(inventory.targets.map(target => ({
      targetId: target.targetId,
      projectTargetId: target.projectTargetId,
      label: target.label,
      scope: target.scope,
      branch: target.branch,
      locked: target.locked,
      worktreeCapable: target.worktreeCapable,
    }))).toEqual(expect.arrayContaining([
      {
        targetId: 'project_12345678',
        projectTargetId: 'project_12345678',
        label: 'AgentsToZ',
        scope: 'main',
        branch: 'main',
        locked: false,
        worktreeCapable: true,
      },
      {
        targetId: deriveAgentRuntimeWorktreeTargetId(
          'project_12345678',
          '/private/projects/agentstoz/worktrees/runtime',
        ),
        projectTargetId: 'project_12345678',
        label: 'AgentsToZ · runtime',
        scope: 'worktree',
        branch: 'runtime',
        locked: true,
        worktreeCapable: true,
      },
      {
        targetId: 'folder_12345678',
        projectTargetId: 'folder_12345678',
        label: '일반 폴더',
        scope: 'main',
        branch: null,
        locked: false,
        worktreeCapable: false,
      },
    ]));
  });

  test('admits a persisted worktree only after exact non-main Git evidence', () => {
    const registered = [
      {
        targetId: 'project_12345678',
        label: 'Project',
        cwd: '/repo',
        scopeHint: 'main' as const,
        parentTargetId: null,
      },
      {
        targetId: 'worktree_12345678',
        label: 'Saved worktree',
        cwd: '/repo/worktrees/saved',
        scopeHint: 'worktree' as const,
        parentTargetId: 'project_12345678',
      },
    ];
    const stale = buildAgentRuntimeTargetInventory({
      registered,
      families: [{
        projectTargetId: 'project_12345678',
        worktrees: [{ cwd: '/repo', branch: 'main', isMain: true, locked: false }],
      }],
      discoveryComplete: true,
    });
    expect(stale.targets.some(target => target.targetId === 'worktree_12345678')).toBe(false);

    const live = buildAgentRuntimeTargetInventory({
      registered,
      families: [{
        projectTargetId: 'project_12345678',
        worktrees: [
          { cwd: '/repo', branch: 'main', isMain: true, locked: false },
          { cwd: '/repo/worktrees/saved', branch: 'saved', isMain: false, locked: false },
        ],
      }],
      discoveryComplete: true,
    });
    expect(live.targets.find(target => target.targetId === 'worktree_12345678')).toMatchObject({
      projectTargetId: 'project_12345678',
      scope: 'worktree',
      branch: 'saved',
      cwd: '/repo/worktrees/saved',
    });
    expect(live.targets.filter(target => target.cwd === '/repo/worktrees/saved')).toHaveLength(1);
  });

  test('derives deterministic non-path identifiers and reports incomplete discovery honestly', () => {
    const first = deriveAgentRuntimeWorktreeTargetId('project_12345678', '/secret/repo/worktrees/a');
    expect(first).toBe(deriveAgentRuntimeWorktreeTargetId('project_12345678', '/secret/repo/worktrees/a'));
    expect(first).not.toContain('secret');
    expect(first).not.toContain('/');
    expect(first).toMatch(/^rwt_[0-9a-f]{48}$/);

    const inventory = buildAgentRuntimeTargetInventory({
      registered: [{
        targetId: 'project_12345678',
        label: 'Project',
        cwd: '/secret/repo',
        scopeHint: 'main',
        parentTargetId: null,
      }],
      families: [],
      discoveryComplete: false,
    });
    expect(inventory.complete).toBe(false);
    expect(inventory.targets).toHaveLength(1);
  });

  test('omits one canonical checkout claimed by conflicting Git families', () => {
    const inventory = buildAgentRuntimeTargetInventory({
      registered: [
        {
          targetId: 'project_12345678', label: 'One', cwd: '/repo/one',
          scopeHint: 'main', parentTargetId: null,
        },
        {
          targetId: 'project_87654321', label: 'Two', cwd: '/repo/two',
          scopeHint: 'main', parentTargetId: null,
        },
      ],
      families: [
        {
          projectTargetId: 'project_12345678',
          worktrees: [{ cwd: '/repo/shared', branch: 'one', isMain: false, locked: false }],
        },
        {
          projectTargetId: 'project_87654321',
          worktrees: [{ cwd: '/repo/shared', branch: 'two', isMain: false, locked: false }],
        },
      ],
      discoveryComplete: true,
    });
    expect(inventory.complete).toBe(false);
    expect(inventory.targets.some(target => target.cwd === '/repo/shared')).toBe(false);
  });

  test('omits a persisted worktree when its stored parent disagrees with Git', () => {
    const inventory = buildAgentRuntimeTargetInventory({
      registered: [
        {
          targetId: 'project_12345678', label: 'One', cwd: '/repo/one',
          scopeHint: 'main', parentTargetId: null,
        },
        {
          targetId: 'project_87654321', label: 'Two', cwd: '/repo/two',
          scopeHint: 'main', parentTargetId: null,
        },
        {
          targetId: 'worktree_12345678', label: 'Corrupt parent', cwd: '/repo/two-linked',
          scopeHint: 'worktree', parentTargetId: 'project_12345678',
        },
      ],
      families: [{
        projectTargetId: 'project_87654321',
        worktrees: [
          { cwd: '/repo/two', branch: 'main', isMain: true, locked: false },
          { cwd: '/repo/two-linked', branch: 'feature', isMain: false, locked: false },
        ],
      }],
      discoveryComplete: true,
    });

    expect(inventory.complete).toBe(false);
    expect(inventory.targets.some(target => target.targetId === 'worktree_12345678')).toBe(false);
    expect(inventory.targets.filter(target => target.cwd === '/repo/two-linked')).toHaveLength(1);
    expect(inventory.targets.find(target => target.cwd === '/repo/two-linked')).toMatchObject({
      projectTargetId: 'project_87654321',
      scope: 'worktree',
    });
  });
});
