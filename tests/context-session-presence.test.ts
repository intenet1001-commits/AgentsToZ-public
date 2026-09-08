import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  hasAtLeastOrcaTerminalCount,
  hasCmuxSurfaceInWorkspace,
  inspectOrcaContextSessionPresence,
  inspectCmuxSurfaceInWorkspace,
  isRecognizedCmuxTree,
  isDefinitivelyClosedCmuxRuntimeError,
  isDefinitivelyMissingCmuxTargetError,
  unboundOrcaContextSurfacePresence,
} from '../src/contextSessionPresence';

const sessionId = 'b885e836-3aec-4186-89a6-34f1dcbbe81d';
const paneKey = 'tab-a:pane-a';
const tabId = 'tab-a';
const floatingWorktreeId = 'global-floating-terminal';

const floatingTarget = {
  sessionId,
  launchContext: { orcaWorktreeId: floatingWorktreeId, orcaPaneKey: paneKey },
};

const persistedState = {
  sessions: [{
    paneKey,
    tabId,
    worktreeId: floatingWorktreeId,
    providerSession: { id: sessionId },
  }],
};

describe('Orca context-session presence', () => {
  test('does not treat a recent floating snapshot as live when Orca stopped', () => {
    expect(inspectOrcaContextSessionPresence([floatingTarget], { kind: 'stopped' }).get(sessionId)).toBe('gone');
  });

  test('requires the exact persisted session and a connected runtime terminal for floating too', () => {
    const live = inspectOrcaContextSessionPresence([floatingTarget], {
      kind: 'running',
      sessionState: persistedState,
      terminals: { terminals: [{ handle: 'term-a', tabId, worktreeId: floatingWorktreeId, connected: true }] },
    });
    expect(live.get(sessionId)).toBe('live');

    const gone = inspectOrcaContextSessionPresence([floatingTarget], {
      kind: 'running',
      sessionState: persistedState,
      terminals: { terminals: [] },
    });
    expect(gone.get(sessionId)).toBe('gone');
  });

  test('keeps an unavailable runtime distinct from a proved-closed terminal', () => {
    expect(inspectOrcaContextSessionPresence([floatingTarget], { kind: 'unverified' }).get(sessionId)).toBe('unverified');
    expect(inspectOrcaContextSessionPresence([{
      sessionId,
      launchContext: { orcaWorktreeId: floatingWorktreeId },
    }], {
      kind: 'running', sessionState: persistedState, terminals: { terminals: [] },
    }).get(sessionId)).toBe('unverified');
  });

  test('does not call an ambiguous or truncated Orca terminal list closed', () => {
    const ambiguous = inspectOrcaContextSessionPresence([floatingTarget], {
      kind: 'running',
      sessionState: persistedState,
      terminals: {
        terminals: [
          { handle: 'term-a', tabId, worktreeId: floatingWorktreeId, connected: true },
          { handle: 'term-b', tabId, worktreeId: floatingWorktreeId, connected: true },
        ],
      },
    });
    expect(ambiguous.get(sessionId)).toBe('unverified');

    const truncated = inspectOrcaContextSessionPresence([floatingTarget], {
      kind: 'running',
      sessionState: persistedState,
      terminals: { terminals: [] },
      terminalListMayBeTruncated: true,
    });
    expect(truncated.get(sessionId)).toBe('unverified');
  });

  test('detects a terminal-list cap before using absence as proof of closure', () => {
    expect(hasAtLeastOrcaTerminalCount({ terminals: [{ handle: 'one' }, { handle: 'two' }] }, 2)).toBe(true);
    expect(hasAtLeastOrcaTerminalCount({ terminals: [{ handle: 'one' }] }, 2)).toBe(false);
  });

  test('removes an unbound Codex Orca record when the whole Orca runtime stopped', () => {
    expect(unboundOrcaContextSurfacePresence('stopped')).toBe('gone');
    expect(unboundOrcaContextSurfacePresence('running')).toBe('unverified');
  });
});

describe('cmux context-session presence', () => {
  const workspaceA = 'workspace-a';
  const workspaceB = 'workspace-b';
  const surfaceA = 'surface-a';
  const surfaceB = 'surface-b';
  const tree = {
    windows: [{
      workspaces: [
        { id: workspaceA, panes: [{ surfaces: [{ id: surfaceA }] }] },
        { id: workspaceB, panes: [{ surfaces: [{ id: surfaceB }] }] },
      ],
    }],
  };

  test('requires the surface to belong to the requested workspace branch', () => {
    expect(hasCmuxSurfaceInWorkspace(tree, workspaceA, surfaceA)).toBe(true);
    expect(hasCmuxSurfaceInWorkspace(tree, workspaceA, surfaceB)).toBe(false);
    expect(inspectCmuxSurfaceInWorkspace(tree, workspaceA, surfaceB)).toBe('gone');
    expect(inspectCmuxSurfaceInWorkspace({ metadata: { id: workspaceA } }, workspaceA, surfaceA)).toBe('unverified');
  });

  test('recognizes a real tree but keeps an unknown JSON envelope unverified upstream', () => {
    expect(isRecognizedCmuxTree(tree)).toBe(true);
    expect(isRecognizedCmuxTree([])).toBe(true);
    expect(isRecognizedCmuxTree({ ok: true, result: [] })).toBe(true);
    expect(isRecognizedCmuxTree({ ok: true, result: {} })).toBe(false);
  });

  test('distinguishes a closed socket from a permission failure', () => {
    expect(isDefinitivelyClosedCmuxRuntimeError('Failed to connect to socket: Connection refused')).toBe(true);
    expect(isDefinitivelyClosedCmuxRuntimeError('Failed to connect to socket: Operation not permitted')).toBe(false);
    expect(isDefinitivelyMissingCmuxTargetError('workspace not found for requested surface')).toBe(true);
    expect(isDefinitivelyMissingCmuxTargetError('Operation not permitted')).toBe(false);
  });
});

describe('context usage runtime-probe contract', () => {
  const apiSource = readFileSync(new URL('../api-server.ts', import.meta.url), 'utf8');

  test('also applies a stopped-Orca result to an Orca-classified Codex rollout', () => {
    expect(apiSource).toContain('const hasCodexOrcaSurface = codexSessions.some');
    expect(apiSource).toContain("session.surfaceKind === 'orca-floating'");
    expect(apiSource).toContain('unboundOrcaContextSurfacePresence(');
    expect(apiSource).toContain('claudeSurfaceInspection.orcaRuntimeState');
  });
});
