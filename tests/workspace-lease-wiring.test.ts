import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const api = readFileSync(new URL('../api-server.ts', import.meta.url), 'utf8');
const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const tauri = readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');

function section(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  expect(start, `missing start marker: ${startMarker}`).toBeGreaterThanOrEqual(0);
  const end = source.indexOf(endMarker, start + startMarker.length);
  expect(end, `missing end marker: ${endMarker}`).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('workspace lease production wiring', () => {
  test('desktop Git and worktree mutations have no direct Tauri bypass', () => {
    const appApi = section(app, 'const API = {', 'function App()');
    for (const command of [
      'list_git_worktrees',
      'git_init',
      'git_reinitialize',
      'git_worktree_add',
      'git_worktree_move',
      'git_worktree_remove',
      'git_merge_branch',
      'clone_repository',
      'create_folder',
    ]) {
      expect(appApi).not.toContain(`invoke('${command}'`);
      expect(appApi).not.toContain(`invoke<WorktreeInfo[]>('${command}'`);
    }
    expect(appApi).toContain("fetch(`${baseUrl}/api/list-git-worktrees`");
    expect(appApi).toContain("fetch(`${baseUrl}/api/git-worktree-add`");
    expect(appApi).toContain("fetch(`${baseUrl}/api/git-merge-branch`");

    const handler = section(tauri, '.invoke_handler(tauri::generate_handler![', '])');
    for (const command of [
      'list_git_worktrees,',
      'git_init,',
      'git_reinitialize,',
      'git_worktree_add,',
      'git_worktree_move,',
      'git_worktree_remove,',
      'git_merge_branch,',
      'clone_repository,',
      'create_folder,',
    ]) {
      expect(handler).not.toContain(command);
    }
  });

  test('request-scoped writers acquire before dispatch and release in a finalizer', () => {
    const mapping = section(
      api,
      "const WORKSPACE_MUTATION_PATH_FIELD = new Map",
      'function workspaceLeaseUnavailable()',
    );
    for (const route of [
      '/api/project-memory/update',
      '/api/project-memory/remote-status',
      '/api/repository-workflow/worktree-launch',
      '/api/list-git-worktrees',
      '/api/git-pull',
      '/api/git-push',
      '/api/git-commit',
      '/api/git-worktree-add',
      '/api/git-worktree-remove',
      '/api/git-merge-branch',
    ]) expect(mapping).toContain(route);

    const parser = section(
      api,
      'async function workspaceMutationPathForRequest(',
      'function workspaceLeaseHttpResponse(',
    );
    expect(parser).toContain('if (bodyValue && queryValue && bodyValue !== queryValue)');
    expect(parser).toContain("url.pathname === '/api/list-git-worktrees' && body?.fetchRemote !== true");
    expect(parser).toContain("url.pathname === '/api/git-init' && body?.checkOnly === true");

    const fetchBody = section(api, 'const server = Bun.serve({', '// 시작 배너는 항상 출력');
    const acquire = fetchBody.indexOf('requestWorkspaceLease = await acquireManagedWorkspaceLease(workspacePath);');
    const notFound = fetchBody.lastIndexOf('return new Response(JSON.stringify({ error: "Not found" })');
    const release = fetchBody.lastIndexOf('releaseManagedWorkspaceLease(requestWorkspaceLease');
    expect(acquire).toBeGreaterThanOrEqual(0);
    expect(notFound).toBeGreaterThan(acquire);
    expect(release).toBeGreaterThan(notFound);
    expect(fetchBody.slice(release - 100, release)).toContain('finally');
  });

  test('long-lived managed writers retain one lease through their terminal boundary', () => {
    const runtimeLease = section(
      api,
      'async function acquireAgentRuntimeWorkspaceLeaseForTarget(',
      'const unavailableAgentRuntimeHttpService:',
    );
    expect(runtimeLease).toContain('acquireManagedWorkspaceLease(target.cwd)');
    expect(runtimeLease).toContain('releaseManagedWorkspaceLease(ownedLease');
    expect(runtimeLease).toContain('captureAgentRuntimeLeasedTargetIdentity(target.targetId, target.cwd)');
    expect(runtimeLease).toContain('sameAgentRuntimeLeasedTargetIdentity(leasedIdentity, current)');

    const runtimeBootstrap = section(
      api,
      'agentRuntimeService = createAgentRuntimeService({',
      'const readyAgentRuntimeService = agentRuntimeService;',
    );
    expect(runtimeBootstrap.match(
      /acquireWorkspaceLease: acquireAgentRuntimeWorkspaceLeaseForTarget/g,
    )).toHaveLength(2);
    expect(runtimeBootstrap).toContain('agentRuntimeConversationService = new AgentRuntimeConversationService({');

    const claudeManager = section(
      api,
      'const remoteClaudeConversationManager = new ClaudeRemoteConversationManager({',
      '/** One Claude project-opening contract',
    );
    expect(claudeManager).toContain('acquireWorkspaceLease: async');
    expect(claudeManager).toContain('acquireManagedWorkspaceLease(folderPath)');
    expect(claudeManager).toContain('releaseManagedWorkspaceLease(lease');

    const worker = section(
      api,
      'const lock = projectWorkerLocks.acquire(',
      'if (url.pathname === "/api/project-memory/worker-status"',
    );
    const workerAcquire = worker.indexOf('acquireManagedWorkspaceLease(binding.canonicalPath)');
    const workerExit = worker.indexOf('void worker.exited.then');
    const workerRelease = worker.lastIndexOf('releaseManagedWorkspaceLease(workspaceLease');
    expect(workerAcquire).toBeGreaterThanOrEqual(0);
    expect(workerExit).toBeGreaterThan(workerAcquire);
    expect(workerRelease).toBeGreaterThan(workerExit);
  });

  test('only durably guarded runtime owners may be auto-recovered after a crash', () => {
    const leaseHelpers = section(
      api,
      'function canRecoverWorkspaceDeadOwner(owner: string): boolean {',
      'async function withManagedWorkspaceLease<T>(',
    );
    expect(leaseHelpers).toContain('GUARDED_WORKSPACE_LOCK_OWNER_PATTERN.test(owner)');
    expect(leaseHelpers).toContain("deadOwnerRecoveryClass: WorkspaceLeaseDeadOwnerRecoveryClass = 'manual'");
    expect(leaseHelpers).toContain('deadOwnerRecoveryClass,');
    expect(leaseHelpers).toContain("deadOwnerRecoveryClass: 'manual'");
    expect(leaseHelpers).toContain("deadOwnerRecoveryClass === 'guarded'");
    expect(leaseHelpers).not.toContain('deadOwnerRecoveryClass = \'guarded\'');
    expect(api).toContain('let workspaceLeaseDegraded = false;');
    expect(api).not.toContain(
      'let workspaceLeaseDegraded = agentRuntimeGuardRegistry === null;',
    );

    const directoryLease = section(
      leaseHelpers,
      'async function acquireManagedWorkspaceDirectoryLease(',
      'async function promoteManagedWorkspaceDirectoryLease(',
    );
    const promoteLease = section(
      leaseHelpers,
      'async function promoteManagedWorkspaceDirectoryLease(',
      '/**\n * A committed operation',
    );
    expect(directoryLease).not.toContain('canRecoverDeadOwner:');
    expect(promoteLease).not.toContain('canRecoverDeadOwner:');
  });

  test('remote direct Git actions and detached memory archives reacquire the same authority', () => {
    const remoteAction = section(
      api,
      'async function executeRemoteControlRegisteredProjectAction(',
      "if (action === 'folder.open')",
    );
    expect(remoteAction).toContain('withRemoteControlWorkspaceLease(workingPath, action');
    expect(remoteAction).toContain('executeRemoteControlSafeMerge');
    expect(remoteAction).toContain('executeRemoteControlSafePull');
    expect(remoteAction).toContain('executeRemoteControlSafePush');

    const archiveQueue = section(
      api,
      'function queueEnabledProjectMemoryPrivateGitHubArchive(',
      'const CONTEXT_SESSION_ID_RE',
    );
    expect(archiveQueue).toContain("withManagedWorkspaceLease(local.projectRoot, 'automatic project-memory archive'");

    const worktreeAdd = section(
      api,
      'if (url.pathname === "/api/git-worktree-add"',
      'if (url.pathname === "/api/git-worktree-remove"',
    );
    expect(worktreeAdd).not.toContain("Bun.spawn(['bun', 'install']");
    expect(worktreeAdd).not.toContain('Bun.spawn(["bun", "install"]');
    expect(worktreeAdd).not.toContain("Bun.spawn(['uv', 'sync']");
    expect(worktreeAdd).not.toContain('Bun.spawn(["uv", "sync"]');
  });

  test('new projects hold the parent family and promote the child without a directory gap', () => {
    const useCreate = section(
      api,
      'async function createAgentsToZUseProject(',
      'async function connectAgentsToZUseBuzzChannel(',
    );
    const useParent = useCreate.indexOf("withAgentsToZUseWorkspaceLease(target.rootPath");
    const useChild = useCreate.indexOf('acquireManagedWorkspaceDirectoryLease(target.folderPath)');
    const useInit = useCreate.indexOf('Bun.spawn([GIT_PATH, "init"]');
    const usePromote = useCreate.indexOf('promoteManagedWorkspaceDirectoryLease(createdWorkspaceLease)');
    expect(useParent).toBeGreaterThanOrEqual(0);
    expect(useChild).toBeGreaterThan(useParent);
    expect(useInit).toBeGreaterThan(useChild);
    expect(usePromote).toBeGreaterThan(useInit);

    const threadCreate = section(
      api,
      'if (url.pathname === "/api/project-memory/thread/create-project"',
      'if (url.pathname === "/api/project-memory/mentions"',
    );
    const threadParent = threadCreate.indexOf('withManagedWorkspaceLease(\n          target.rootPath');
    const threadChild = threadCreate.indexOf('acquireManagedWorkspaceDirectoryLease(target.folderPath)');
    const threadInit = threadCreate.indexOf('Bun.spawn([GIT_PATH, "init"]');
    const threadPromote = threadCreate.indexOf('promoteManagedWorkspaceDirectoryLease(childDirectoryLease!)');
    expect(threadParent).toBeGreaterThanOrEqual(0);
    expect(threadChild).toBeGreaterThan(threadParent);
    expect(threadInit).toBeGreaterThan(threadChild);
    expect(threadPromote).toBeGreaterThan(threadInit);
  });
});
