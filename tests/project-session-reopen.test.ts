import { describe, expect, test } from 'bun:test';
import {
  hermesSessionDeepLink,
  selectLatestHermesProjectSession,
  type HermesProjectSessionCandidate,
} from '../src/hermesProjectSession';
import { selectLatestProjectCodexThread, type ProjectCodexVoiceCandidate } from '../src/projectCodexVoice';
import type { ContextSessionMetadata } from '../src/contextSessionMetadata';

const projectPath = '/Users/test/Project';
const oldCodexId = '019fe107-3f62-7781-8d28-0f9bcb119c7a';
const recentCodexId = '01a06127-22d8-7da0-ba78-83115652d69c';
const voiceId = '01a06127-22d8-7da0-ba78-83115652d69d';

const codexCandidate = (
  sessionId: string,
  modifiedAtMs: number,
  threadSource: string | null = 'app_server',
): ProjectCodexVoiceCandidate => ({
  sessionId,
  originator: 'Codex Desktop',
  threadSource,
  modifiedAtMs,
});

const binding = (
  path = projectPath,
  moveState: 'applied' | 'pending' = 'applied',
  appliedPath: string | null = path,
): ContextSessionMetadata => ({
  threadTitle: null,
  projectHint: {
    name: 'Project',
    assignedPath: path,
    path,
    source: 'chatgpt-local-project',
    moveState,
    appliedPath,
    pendingPath: moveState === 'pending' ? path : null,
  },
});

describe('project-scoped recent conversation reopening', () => {
  test('uses ChatGPT last-activity time and opens only an applied ordinary Codex task', () => {
    const metadata = new Map<string, ContextSessionMetadata>([
      [oldCodexId, binding()],
      [recentCodexId, binding()],
      [voiceId, binding()],
    ]);
    const selected = selectLatestProjectCodexThread(projectPath, [
      codexCandidate(oldCodexId, 100),
      codexCandidate(recentCodexId, 300),
      codexCandidate(voiceId, 900, 'realtime_voice'),
    ], metadata, new Map([
      [oldCodexId, 800],
      [recentCodexId, 700],
      [voiceId, 1_000],
    ]));
    expect(selected).toBe(oldCodexId);
  });

  test('never guesses a sibling, pending move, conflicting applied path, or CLI task', () => {
    const siblingId = '01a06127-22d8-7da0-ba78-83115652d69e';
    const pendingId = '01a06127-22d8-7da0-ba78-83115652d69f';
    const conflictId = '01a06127-22d8-7da0-ba78-83115652d6a0';
    const cliId = '01a06127-22d8-7da0-ba78-83115652d6a1';
    const metadata = new Map<string, ContextSessionMetadata>([
      [siblingId, binding('/Users/test/Project-2')],
      [pendingId, binding(projectPath, 'pending', '/Users/test/Scratch')],
      [conflictId, binding(projectPath, 'applied', '/Users/test/Other')],
      [cliId, binding()],
    ]);
    const cli = { ...codexCandidate(cliId, 4), originator: 'codex_cli_rs' };
    expect(selectLatestProjectCodexThread(projectPath, [
      codexCandidate(siblingId, 1),
      codexCandidate(pendingId, 2),
      codexCandidate(conflictId, 3),
      cli,
    ], metadata)).toBeNull();
  });

  const hermesCandidate = (
    id: string,
    activity: number,
    overrides: Partial<HermesProjectSessionCandidate> = {},
  ): HermesProjectSessionCandidate => ({
    id,
    source: 'desktop',
    startedAt: activity - 1,
    lastActivityAt: activity,
    cwd: projectPath,
    gitRepoRoot: projectPath,
    profileName: null,
    archived: 0,
    hidden: 0,
    ...overrides,
  });

  test('selects the newest visible default-profile Hermes Desktop session for the exact Git root', () => {
    const old = hermesCandidate('hermes_session_old_001', 10);
    const latest = hermesCandidate('hermes_session_new_002', 20);
    const other = hermesCandidate('hermes_session_other03', 100, { gitRepoRoot: '/Users/test/Other' });
    const archived = hermesCandidate('hermes_session_arch_004', 200, { archived: 1 });
    const alternateProfile = hermesCandidate('hermes_session_prof_005', 300, { profileName: 'research' });
    expect(selectLatestHermesProjectSession(projectPath, [old, other, archived, alternateProfile, latest])).toEqual(latest);
    expect(hermesSessionDeepLink(latest.id)).toBe(`hermes://open/${latest.id}`);
  });

  test('accepts a descendant cwd only when Hermes recorded no Git root', () => {
    const nested = hermesCandidate('hermes_session_nested06', 20, {
      gitRepoRoot: null,
      cwd: `${projectPath}/packages/web`,
    });
    const wrongGitRoot = hermesCandidate('hermes_session_wrong_07', 30, {
      gitRepoRoot: `${projectPath}/packages/web`,
      cwd: `${projectPath}/packages/web`,
    });
    expect(selectLatestHermesProjectSession(projectPath, [nested, wrongGitRoot])).toEqual(nested);
    expect(() => hermesSessionDeepLink('../unsafe')).toThrow();
  });
});
