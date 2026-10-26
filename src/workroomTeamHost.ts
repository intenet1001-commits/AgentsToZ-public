/**
 * The real machine side of 팀 작전 (src/workroomTeam.ts): Git through execFile with a deadline, member Workrooms
 * through the same terminal service the app uses, and every repository write under the workspace lease that the
 * ordinary worktree endpoints take. Nothing here forces: no `--force` remove, no `-D`, no push.
 */
import {execFile} from 'node:child_process';
import {existsSync, lstatSync, readdirSync, readFileSync, realpathSync, rmSync} from 'node:fs';
import {isAbsolute, join, relative} from 'node:path';
import {randomUUID} from 'node:crypto';
import type {AiTerminalService} from './aiTerminalService';
import {deriveAgentRuntimeWorktreeTargetId} from './agentRuntimeTargetInventory';
import type {TeamExternalRuntime} from './teamLaunchPlan';
import type {TeamGitScope, TeamMemberGit, WorkroomTeamHost} from './workroomTeam';

export interface WorkroomTeamHostDependencies {
  gitPath: string;
  terminal: Pick<AiTerminalService, 'perform' | 'runningSession' | 'retiredSession' | 'sessionActivity' | 'wholeSubmissionSupported' | 'submitHostInstruction'> & {
    /** The session a 「다시 시작」 (`resumeFrom`) of this one started, one step. A terminal without it continues nothing. */
    continuationOf?(sessionId: string): string | null;
  };
  resolveProject: WorkroomTeamHost['resolveProject'];
  /** A registered Workroom target's checkout directory, or null when it no longer resolves. */
  targetCwd(targetId: string): Promise<string | null>;
  /** Adds `/worktrees/` to info/exclude, as the worktree endpoint does. */
  ensureExclude(primaryPath: string): Promise<void>;
  /** Copies gitignored local agent config (.claude, .env*) into a new worktree without overwriting. */
  seedConfig(primaryPath: string, worktreePath: string): void;
  withLease<T>(path: string, label: string, work: () => Promise<T>): Promise<T>;
  /** Orca owns creation/registration and its repository lease. A plain Git checkout cannot join its sidebar. */
  createExternalWorktree?(input: {primaryPath: string; path: string; branch: string; base: string; surface: 'orca-worktree'}): Promise<{path: string; branch: string}>;
  /**
   * The external launch surfaces (Orca, cmux, a terminal, a desktop app), injected as one module —
   * src/teamExternalRuntime.ts, wired where this host is assembled. Absent is honest: a member that asked for such a
   * surface fails saying its runtime is not connected, and no Workroom is started in its place.
   */
  externalRuntime?: TeamExternalRuntime;
}

/** Paths the app keeps inside the primary checkout; they are not changes a member would miss. */
const APP_OWNED = (path: string) => path.startsWith('worktrees/') || path.startsWith('.claude/worktrees/');
/** What `seedConfig` copies into a member worktree (.claude/ and root .env*): untracked there unless the project ignores it. */
const SEEDED = (path: string) => path === '.claude/' || path.startsWith('.claude/') || /^\.env(\.[^/]+)?$/.test(path);
/**
 * Whether a worktree entry is still the seeded copy: every file in it exists in the primary checkout byte for byte.
 * Anything else (a new or edited file, a symlink) is the member's and keeps the worktree.
 */
function sameAsPrimary(entry: string, primary: string): boolean {
  try {
    const stat = lstatSync(entry);
    if (stat.isFile()) return lstatSync(primary).isFile() && readFileSync(entry).equals(readFileSync(primary));
    if (!stat.isDirectory()) return false;
    return readdirSync(entry).every(name => sameAsPrimary(join(entry, name), join(primary, name)));
  } catch { return false; }
}

/** The receipt namespace of briefs typed into an open session that joins a team (never on the wire). */
export const WORKROOM_TEAM_SUBMISSION_OWNER = 'workroom-team';

export function createWorkroomTeamHost(deps: WorkroomTeamHostDependencies): WorkroomTeamHost {
  const git = (cwd: string, args: string[], timeout = 20_000) => new Promise<{ok: boolean; stdout: string; stderr: string}>(resolve => {
    execFile(deps.gitPath, args, {cwd, timeout, maxBuffer: 4 * 1024 * 1024, env: {...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C'}},
      (error, stdout, stderr) => resolve({ok: !error, stdout: String(stdout), stderr: String(stderr).trim()}));
  });
  const must = async (cwd: string, args: string[]) => {
    const result = await git(cwd, args);
    if (!result.ok) throw new Error(result.stderr || `git ${args[0]} 실패`);
    return result.stdout;
  };
  // Trust neither a returned path nor a checkout-shaped directory with a .git file: the repository's own worktree
  // inventory, common Git directory, checkout root, branch and exact base commit must all agree before seeding secrets.
  const verifiedExternalCheckout = async (primaryPath: string, checkout: {path: string; branch: string}, base: string) => {
    const refused = () => new Error('Orca가 반환한 워크트리의 저장소·브랜치·기준 커밋을 확인하지 못했습니다. 작업 폴더는 삭제하지 않습니다.');
    try {
      if (!checkout || typeof checkout.path !== 'string' || !isAbsolute(checkout.path) || /[\u0000-\u001f\u007f]/.test(checkout.path)
        || typeof checkout.branch !== 'string' || !checkout.branch) throw refused();
      const primary = realpathSync(primaryPath), path = realpathSync(checkout.path), branch = checkout.branch;
      if (path === primary) throw refused();
      const [validBranch, list, top, common, primaryCommon, head, expected, currentBranch] = await Promise.all([
        git(primary, ['check-ref-format', '--branch', branch]), git(primary, ['worktree', 'list', '--porcelain', '-z']),
        git(path, ['rev-parse', '--show-toplevel']), git(path, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
        git(primary, ['rev-parse', '--path-format=absolute', '--git-common-dir']), git(path, ['rev-parse', '--verify', 'HEAD']),
        git(primary, ['rev-parse', '--verify', '--end-of-options', `${base}^{commit}`]), git(path, ['symbolic-ref', '--quiet', 'HEAD']),
      ]);
      if (![validBranch, list, top, common, primaryCommon, head, expected, currentBranch].every(result => result.ok)
        || validBranch.stdout.trim() !== branch || realpathSync(top.stdout.trim()) !== path
        || realpathSync(common.stdout.trim()) !== realpathSync(primaryCommon.stdout.trim())
        || head.stdout.trim() !== expected.stdout.trim() || currentBranch.stdout.trim() !== `refs/heads/${branch}`) throw refused();
      const linked = list.stdout.split('\0\0').some(record => {
        const fields = record.split('\0'), listedPath = fields.find(field => field.startsWith('worktree '))?.slice(9);
        try { return !!listedPath && realpathSync(listedPath) === path && fields.includes(`branch refs/heads/${branch}`) && fields.includes(`HEAD ${expected.stdout.trim()}`); }
        catch { return false; } // An unrelated stale/prunable entry does not invalidate this verified checkout.
      });
      if (!linked) throw refused();
      return {path, branch};
    } catch { throw refused(); }
  };
  /**
   * Where a team's merge questions are asked: the leader's own checkout, which is where it merges. The primary is the
   * fallback for a base checkout that is gone (its worktree was removed) or that was never recorded.
   */
  const asked = (scope: TeamGitScope) => {
    try { return scope.baseCheckout && existsSync(join(scope.baseCheckout, '.git')) ? scope.baseCheckout : scope.primaryPath; } catch { return scope.primaryPath; }
  };
  return {
    resolveProject: deps.resolveProject,
    async primary(canonicalPath, leaderTargetId) {
      const primaryOf = async (cwd: string) => /^worktree (.+)$/m.exec((await must(cwd, ['worktree', 'list', '--porcelain'])).split('\n\n')[0] ?? '')?.[1] ?? null;
      const path = await primaryOf(canonicalPath);
      if (!path) throw new Error('Git 주 워크트리를 찾지 못했습니다.');
      // A leader in a linked worktree of this repository: members start from its HEAD, not from the primary's.
      const leaderCwd = leaderTargetId ? await deps.targetCwd(leaderTargetId).catch(() => null) : null;
      const same = (a: string, b: string) => { try { return realpathSync(a) === realpathSync(b); } catch { return false; } };
      const base = leaderCwd && await primaryOf(leaderCwd).then(found => !!found && same(found, path), () => false) ? leaderCwd : path;
      const branch = (await git(base, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).stdout.trim() || null;
      const head = (await must(base, ['rev-parse', 'HEAD'])).trim();
      const status = (await must(base, ['status', '--porcelain=v1', '--untracked-files=normal'])).split('\n').filter(Boolean);
      const changed = status.filter(line => !APP_OWNED(line.slice(3)));
      return {path, base, head, branch, trackedChanges: changed.filter(line => !line.startsWith('??')).map(line => line.slice(3)), untracked: changed.filter(line => line.startsWith('??')).length};
    },
    async addWorktree(primaryPath, path, branch, base, surface) {
      if (surface === 'orca-worktree') {
        if (!deps.createExternalWorktree) throw new Error('Orca 관리 워크트리 생성 연결이 없습니다. Orca 연결을 확인하세요.');
        // The API callback owns creation's lease; acquiring the same lease here would deadlock that callback.
        const created = await deps.createExternalWorktree({primaryPath, path, branch, base, surface});
        return deps.withLease(primaryPath, 'Team member worktree verification', async () => {
          const actual = await verifiedExternalCheckout(primaryPath, created, base);
          deps.seedConfig(primaryPath, actual.path);
          return actual;
        });
      }
      await deps.withLease(primaryPath, 'Team member worktree', async () => {
        await deps.ensureExclude(primaryPath);
        await must(primaryPath, ['worktree', 'add', '-b', branch, path, base]);
      });
      deps.seedConfig(primaryPath, path);
    },
    worktreeTargetId: (projectId, path) => deriveAgentRuntimeWorktreeTargetId(projectId, realpathSync(path)),
    // Passed straight through: this host neither reimplements an external surface nor decides what it may claim.
    ...(deps.externalRuntime ? {external: deps.externalRuntime} : {}),
    async start(input) {
      // The account and the approval mode ride on the request itself, exactly as the app's own start sends them:
      // `accountId` goes through the same registered-profile launch and validation, and `bypassPermissions` is only
      // ever present when the caller asked for it. No authority is passed, so this stays a host-local start.
      const started = await deps.terminal.perform({operation: 'start', requestId: input.requestId, targetId: input.targetId, agent: input.agent, cols: 100, rows: 28, prompt: input.prompt,
        ...(input.accountId ? {accountId: input.accountId} : {}), ...(input.bypassPermissions ? {bypassPermissions: true} : {})},
        undefined, {...(input.model ? {launchModel: input.model} : {}), launchEffort: input.effort});
      if (!started.session) throw new Error('팀원 워크룸이 시작되지 않았습니다.');
      return {sessionId: started.session.id};
    },
    session(sessionId, targetId) {
      if (deps.terminal.runningSession(sessionId)) {
        try { return {state: 'running', lastOutputAt: deps.terminal.sessionActivity(sessionId, targetId).lastOutputAt}; } catch { return {state: 'running', lastOutputAt: null}; }
      }
      return {state: deps.terminal.retiredSession(sessionId) ? 'exited' : 'missing', lastOutputAt: null};
    },
    continuation(sessionId, targetId) {
      // Follows the exact resumeFrom chain to its latest link (a member may restart more than once); bounded, never cyclic.
      let latest: string | null = null;
      for (let current = sessionId, steps = 0; steps < 32; steps++) {
        const next = deps.terminal.continuationOf?.(current) ?? null;
        if (!next || next === sessionId || next === latest) break;
        latest = current = next;
      }
      const summary = latest ? deps.terminal.runningSession(latest) ?? deps.terminal.retiredSession(latest) : null;
      return latest && summary?.targetId === targetId ? {sessionId: latest} : null;
    },
    async sessionForTarget(targetId, checkout) {
      // The same list the app's own Workroom list uses; a host call has no remote authority, so it sees every session.
      const listed = await deps.terminal.perform({operation: 'list', requestId: `team-list-${randomUUID()}`});
      const running = (listed.sessions ?? []).filter(session => session.state === 'running');
      const found = running.find(session => session.targetId === targetId);
      if (found || !checkout) return found ? {sessionId: found.id} : null;
      // A folder has one target at a time, but not always the one this team derived: once the checkout is registered as a
      // project of its own (or one sits in a subfolder of it), a Workroom opened there runs under that project's target.
      // The checkout itself or a folder inside it counts; the primary that contains `worktrees/` does not.
      let root: string;
      try { root = realpathSync(checkout); } catch { return null; }
      for (const session of running) {
        const cwd = await deps.targetCwd(session.targetId).catch(() => null);
        let inside = false;
        try { const path = cwd ? relative(root, realpathSync(cwd)) : null; inside = path !== null && !path.startsWith('..') && !isAbsolute(path); } catch { /* a folder that is gone */ }
        if (inside) return {sessionId: session.id};
      }
      return null;
    },
    async attachable(sessionId, team) {
      const session = deps.terminal.runningSession(sessionId);
      if (!session || session.state !== 'running') return null;
      const registered = await deps.targetCwd(session.targetId).catch(() => null);
      const same = (a: string, b: string) => { try { return realpathSync(a) === realpathSync(b); } catch { return false; } };
      const outside = (cwd: string) => ({agent: session.agent, targetId: session.targetId, cwd, baseCheckout: false, sameRepository: false, linked: false, branch: null, containsBase: false});
      if (!registered) return outside('');
      // The **checkout root**, not the folder the Workroom was registered in: a registered project may sit in a
      // subdirectory of its repository (a fixed relative subpath), and comparing that folder made a session inside the
      // primary look like its own linked worktree — a worker would then commit on the branch the leader merges into.
      const root = (await git(registered, ['rev-parse', '--show-toplevel'])).stdout.trim() || null;
      if (!root) return outside(registered);
      const list = await git(root, ['worktree', 'list', '--porcelain']);
      const primary = list.ok ? /^worktree (.+)$/m.exec(list.stdout.split('\n\n')[0] ?? '')?.[1] ?? null : null;
      if (!primary || !same(primary, team.primaryPath)) return outside(root);
      const branch = (await git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).stdout.trim() || null;
      const containsBase = (await git(root, ['merge-base', '--is-ancestor', team.baseCommit, 'HEAD'])).ok;
      return {agent: session.agent, targetId: session.targetId, cwd: root, baseCheckout: same(root, team.baseCheckout),
        sameRepository: true, linked: !same(root, primary), branch, containsBase};
    },
    async instruct(input) {
      // One whole submission under the team's own receipt namespace; a host without it cannot prove what it typed.
      if (!deps.terminal.wholeSubmissionSupported()) throw new Error('이 앱은 열린 세션에 지시문을 확인 가능하게 보낼 수 없습니다. 앱을 업데이트하세요.');
      const typed = await deps.terminal.submitHostInstruction({id: input.requestId, sessionId: input.sessionId, data: `${input.prompt}\r`, receiptOwner: WORKROOM_TEAM_SUBMISSION_OWNER, skipCorrections: true});
      return typed.state === 'written' ? 'written' : 'unknown';
    },
    async close(sessionId) {
      await deps.terminal.perform({operation: 'close', requestId: `team-close-${randomUUID()}`, sessionId, memoryPolicy: 'skip'});
    },
    async branchGit(scope, base, branch): Promise<TeamMemberGit | null> {
      const cwd = asked(scope);
      const exists = await git(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
      if (!exists.ok) return null;
      // `merged` is asked in the leader's checkout: that HEAD is what the leader merges into.
      const [count, stat, merged] = await Promise.all([git(cwd, ['rev-list', '--count', `${base}..${branch}`]), git(cwd, ['diff', '--shortstat', `${base}...${branch}`]),
        git(cwd, ['merge-base', '--is-ancestor', branch, 'HEAD'])]);
      const number = (pattern: RegExp) => Number(pattern.exec(stat.stdout)?.[1] ?? 0);
      return {commits: Number(count.stdout.trim()) || 0, files: number(/(\d+) files? changed/), insertions: number(/(\d+) insertions?/), deletions: number(/(\d+) deletions?/),
        merged: merged.ok && Number(count.stdout.trim()) > 0};
    },
    async removeWorktree(primaryPath, path) {
      if (!existsSync(path)) { await git(primaryPath, ['worktree', 'prune']); return 'missing'; }
      const status = await git(path, ['status', '--porcelain=v1', '--untracked-files=normal']);
      if (!status.ok) return 'dirty';
      // Only the config the host seeded may stand between a member and a clean worktree; it goes first, then a plain remove.
      const seeded: string[] = [];
      for (const line of status.stdout.split('\n').filter(Boolean)) {
        const entry = line.slice(3);
        if (!line.startsWith('?? ') || !SEEDED(entry) || !sameAsPrimary(join(path, entry), join(primaryPath, entry))) return 'dirty';
        seeded.push(entry);
      }
      await deps.withLease(primaryPath, 'Team member worktree removal', async () => {
        for (const entry of seeded) rmSync(join(path, entry), {recursive: true, force: true});
        await must(primaryPath, ['worktree', 'remove', path]);
      });
      return 'removed';
    },
    async deleteMergedBranch(scope, branch) {
      // `git branch -d` in the leader's checkout: merged there, and never while any worktree still has it checked out.
      const cwd = asked(scope);
      if (!(await git(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])).ok) return 'missing';
      return (await git(cwd, ['branch', '-d', branch])).ok ? 'deleted' : 'unmerged';
    },
  };
}
