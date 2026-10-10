import { describe, expect, test } from 'bun:test';
import { classifyAgentWorkspacePath, isCodexThreadWorkspace } from '../src/agentWorkspacePath';
import { sessionMemoryAction } from '../src/components/aiUsageMemoryState';
import type { ProjectMemoryStatus } from '../src/ProjectMemoryPanel';

const noMemory = (projectRoot: string) => ({
  kind: 'ready' as const,
  status: {
    exists: false,
    projectRoot,
    memoryPath: null,
    sourcePath: null,
    kind: 'none',
    size: 0,
    modifiedAt: null,
    contentHash: null,
    config: null,
    activity: { needsRemember: false, reasons: [], currentFingerprint: null },
  } as unknown as ProjectMemoryStatus,
  checkedAt: 0,
  remote: { kind: 'not-required' as const },
});

describe('per-conversation agent workspaces', () => {
  test('recognizes the folder the ChatGPT app makes for one Codex thread', () => {
    // Verbatim cwd from the reported session.
    expect(isCodexThreadWorkspace('/Users/gwanli/Documents/Codex/2026-08-08/realtime-voice-chat-6')).toBe(true);
    expect(isCodexThreadWorkspace('/Users/gwanli/Documents/Codex/2026-08-08/realtime-voice-chat-6/')).toBe(true);
  });

  test('a real project is never mistaken for scratch space', () => {
    for (const path of [
      '/Users/gwanli/product_2026/ShadowLoop',
      '/Users/gwanli/Documents/Codex',
      '/Users/gwanli/Documents/Codex/2026-08-08',
      // A project that merely lives deeper inside such a folder keeps its identity.
      '/Users/gwanli/Documents/Codex/2026-08-08/realtime-voice-chat-6/frontend',
      '/Users/gwanli/Documents/CodexNotes/2026-08-08/thing',
      '',
      null,
    ]) {
      expect(classifyAgentWorkspacePath(path)).toBe('project');
    }
  });

  test('does not offer to start long-term memory in a thread folder', () => {
    // Initializing there writes .agent-memory where nobody will look again.
    expect(sessionMemoryAction(
      '/Users/gwanli/Documents/Codex/2026-08-08/realtime-voice-chat-6',
      noMemory('/Users/gwanli/Documents/Codex/2026-08-08/realtime-voice-chat-6'),
    )).toBe('ephemeral');
  });

  test('a real project without memory still gets the offer', () => {
    expect(sessionMemoryAction(
      '/Users/gwanli/product_2026/ShadowLoop',
      noMemory('/Users/gwanli/product_2026/ShadowLoop'),
    )).toBe('start');
  });
});
