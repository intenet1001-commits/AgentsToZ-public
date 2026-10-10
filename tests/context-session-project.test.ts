import { describe, expect, test } from 'bun:test';
import { resolveContextSessionProjectBinding } from '../src/contextSessionProject';

const candidates = [
  { projectId: 'shadowloop', projectName: 'ShadowLoop', path: '/Users/gwanli/product_2026/ShadowLoop', priority: 1 },
  {
    projectId: 'shadowloop',
    projectName: 'ShadowLoop',
    worktreeName: 'fix-voice',
    path: '/Users/gwanli/product_2026/ShadowLoop/.worktrees/fix-voice',
    priority: 3,
  },
];

describe('context session project binding', () => {
  test('keeps project and worktree identity distinct', () => {
    expect(resolveContextSessionProjectBinding(candidates, '/Users/gwanli/product_2026/ShadowLoop/src'))
      .toMatchObject({ relation: 'project', projectId: 'shadowloop', projectName: 'ShadowLoop' });
    expect(resolveContextSessionProjectBinding(candidates, '/Users/gwanli/product_2026/ShadowLoop/.worktrees/fix-voice/src'))
      .toMatchObject({ relation: 'worktree', projectId: 'shadowloop', projectName: 'ShadowLoop', worktreeName: 'fix-voice' });
  });

  test('never presents a per-chat Codex scratch folder as a project', () => {
    expect(resolveContextSessionProjectBinding(
      candidates,
      '/Users/gwanli/Documents/Codex/2026-08-08/realtime-voice-chat-6',
    )).toMatchObject({ relation: 'ephemeral', projectName: null, projectId: null });
  });
});
