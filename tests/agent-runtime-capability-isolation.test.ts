import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
  utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import contract from '../context-api-contract.json';
import { resolveAppDataDir } from '../src/appDataDir';
import { acquireWorkspaceLease } from '../src/workspaceLease';
import { startTestApiServer } from './startTestApiServer';

const roots: string[] = [];
const children: Bun.Subprocess[] = [];
const WHAT_I_SAID_CAPABILITY = 'a'.repeat(64);
const REMOTE_CONTROL_CAPABILITY = 'b'.repeat(64);
const AGENT_RUNTIME_CAPABILITY = 'c'.repeat(64);
const TAURI_ORIGIN = 'http://tauri.localhost';

afterEach(async () => {
  for (const child of children.splice(0)) {
    try { child.kill(); } catch {}
    await child.exited.catch(() => undefined);
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function bundledEnvironment(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    APPDATA: join(home, 'AppData', 'Roaming'),
    XDG_CONFIG_HOME: join(home, '.config'),
    NODE_ENV: 'test',
    PORT: '9000',
    PORTMGR_ALLOWED_ORIGINS: '',
    PORTMGR_BUNDLED_SIDECAR: '1',
    PORTMGR_PARENT_PID: String(process.pid),
    PORTMGR_WHAT_I_SAID_CAPABILITY: WHAT_I_SAID_CAPABILITY,
    PORTMGR_REMOTE_CONTROL_CAPABILITY: REMOTE_CONTROL_CAPABILITY,
    PORTMGR_AGENT_RUNTIME_CAPABILITY: AGENT_RUNTIME_CAPABILITY,
    AGENTSTOZ_SKIP_HERMES_SYNC: '1',
  };
  env.APP_DATA_DIR = resolveAppDataDir(process.platform, env, home);
  return env;
}

async function runtimeRequest(input: {
  baseUrl: string;
  path: string;
  method?: string;
  capability?: string | null;
  origin?: string | null;
  body?: unknown;
  headers?: Record<string, string>;
}): Promise<{ response: Response; body: Record<string, unknown> }> {
  const method = input.method ?? 'GET';
  const headers: Record<string, string> = { ...input.headers };
  if (input.origin !== null) headers.Origin = input.origin ?? TAURI_ORIGIN;
  if (input.capability !== null) {
    headers['X-AgentsToZ-Agent-Runtime-Capability'] = input.capability ?? AGENT_RUNTIME_CAPABILITY;
  }
  if (input.body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${input.baseUrl}${input.path}`, {
    method,
    headers,
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
  });
  const text = await response.text();
  let parsed: Record<string, unknown> = {};
  if (text) parsed = JSON.parse(text) as Record<string, unknown>;
  return { response, body: parsed };
}

function runGit(cwd: string, args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
  return new TextDecoder().decode(result.stdout).trim();
}

describe('Agent Runtime bundled-sidecar capability isolation', () => {
  test('Workroom input survives Git directory churn but rejects a replaced checkout', async () => {
    if (process.platform === 'win32') return;
    const home = mkdtempSync(join(tmpdir(), 'agentstoz-pty-git-churn-'));
    roots.push(home);
    const repository = join(home, 'project'), worktree = join(home, 'linked');
    mkdirSync(repository);
    runGit(repository, ['init', '-q']);
    runGit(repository, ['config', 'user.email', 'test@example.invalid']);
    runGit(repository, ['config', 'user.name', 'Test']);
    writeFileSync(join(repository, 'README.md'), 'fixture\n');
    runGit(repository, ['add', '.']);
    runGit(repository, ['commit', '-qm', 'fixture']);
    runGit(repository, ['worktree', 'add', '-q', '-b', 'codex/churn', worktree]);
    const bin = join(home, '.local', 'bin');
    mkdirSync(bin, {recursive:true});
    writeFileSync(join(bin, 'claude'), '#!/bin/sh\nstty -echo\nprintf "READY\\n"\nwhile IFS= read -r line; do printf "GOT:%s\\n" "$line"; done\n', {mode:0o755});
    const env = bundledEnvironment(home);
    env.PATH = `${bin}:${process.env.PATH}`;
    mkdirSync(env.APP_DATA_DIR!, {recursive:true});
    writeFileSync(join(env.APP_DATA_DIR!, 'ports.json'), JSON.stringify([
      {id:'project_churn_12345678',name:'Churn fixture',folderPath:repository},
    ]));
    const {baseUrl,child} = await startTestApiServer({cwd:join(import.meta.dir,'..'),env});
    children.push(child);
    const inventory = await runtimeRequest({baseUrl,path:'/api/agent-runtime/targets'});
    const target = (inventory.body.targets as Array<Record<string,unknown>>).find(t=>t.scope==='worktree')!;
    expect(target).toBeDefined();
    const terminal = (body:Record<string,unknown>) => runtimeRequest({baseUrl,path:'/api/agent-runtime/terminals',method:'POST',body:{requestId:crypto.randomUUID(),...body}});
    const started = await terminal({operation:'start',targetId:target.targetId,agent:'claude',cols:80,rows:24});
    expect(started.response.status).toBe(200);
    const sessionId = (started.body.session as {id:string}).id;
    let output = '', after = 0;
    const waitOutput = async (text:string) => {
      for(let n=0;n<100;n++) {
        const result = await terminal({operation:'read',sessionId,after});
        for(const chunk of (result.body.chunks ?? []) as Array<{seq:number;text:string}>) {output+=chunk.text;after=chunk.seq;}
        if(output.includes(text)) return;
        await Bun.sleep(20);
      }
      throw new Error(`Missing fixture output: ${text}`);
    };
    await waitOutput('READY');
    const gitDir = runGit(worktree,['rev-parse','--absolute-git-dir']);
    // A normal Git status can refresh the index; concurrent status polling
    // also changes these directory timestamps while the resolver runs Git.
    runGit(worktree,['status','--porcelain']);
    const config = join(repository,'.git','config');
    writeFileSync(config, readFileSync(config,'utf8')+'\n# force a full proof refresh\n');
    let pulse = Date.now();
    const churn = setInterval(()=>{
      const timestamp = new Date(pulse+=10);
      utimesSync(gitDir,timestamp,timestamp);
      utimesSync(join(repository,'.git'),timestamp,timestamp);
    },2);
    try {
      const input = await terminal({operation:'input',sessionId,data:'STILL_BOUND\r'});
      expect(input.response.status).toBe(200);
      await waitOutput('GOT:STILL_BOUND');
    } finally {clearInterval(churn);}
    renameSync(worktree,worktree+'-original');
    mkdirSync(worktree);
    const rejected = await terminal({operation:'input',sessionId,data:'WRONG_CHECKOUT\r'});
    expect(rejected.response.status).toBe(400);
    expect(output).not.toContain('GOT:WRONG_CHECKOUT');
    expect((await terminal({operation:'close',sessionId})).response.status).toBe(200);
  },30_000);

  test('projects registered folders and live linked worktrees as path-free runtime targets', async () => {
    const home = mkdtempSync(join(tmpdir(), 'agentstoz-agent-runtime-targets-'));
    roots.push(home);
    const repository = join(home, 'registered-project');
    const plainFolder = join(home, 'registered-folder');
    const linkedWorktree = join(home, 'linked-runtime-worktree');
    mkdirSync(repository, { recursive: true });
    mkdirSync(plainFolder, { recursive: true });
    runGit(repository, ['init', '-q']);
    runGit(repository, ['config', 'user.email', 'runtime-test@example.invalid']);
    runGit(repository, ['config', 'user.name', 'Runtime Test']);
    writeFileSync(join(repository, 'README.md'), '# runtime target\n');
    runGit(repository, ['add', 'README.md']);
    runGit(repository, ['commit', '-q', '-m', 'initial']);
    runGit(repository, ['worktree', 'add', '-q', '-b', 'codex/runtime-target', linkedWorktree]);

    const env = bundledEnvironment(home);
    mkdirSync(env.APP_DATA_DIR!, { recursive: true });
    writeFileSync(join(env.APP_DATA_DIR!, 'ports.json'), JSON.stringify([
      { id: 'project_12345678', name: '등록 프로젝트', folderPath: repository },
      { id: 'folder_12345678', name: '등록 폴더', folderPath: plainFolder },
    ]));
    const { baseUrl, child } = await startTestApiServer({
      cwd: join(import.meta.dir, '..'),
      env,
    });
    children.push(child);

    const result = await runtimeRequest({ baseUrl, path: '/api/agent-runtime/targets' });
    expect(result.response.status).toBe(200);
    expect(result.body.complete).toBe(true);
    const targets = result.body.targets as Array<Record<string, unknown>>;
    expect(targets).toHaveLength(3);
    expect(targets).toEqual(expect.arrayContaining([
      expect.objectContaining({
        targetId: 'project_12345678', projectTargetId: 'project_12345678',
        scope: 'main', worktreeCapable: true,
      }),
      expect.objectContaining({
        targetId: 'folder_12345678', projectTargetId: 'folder_12345678',
        scope: 'main', worktreeCapable: false,
      }),
      expect.objectContaining({
        projectTargetId: 'project_12345678', scope: 'worktree',
        branch: 'codex/runtime-target', worktreeCapable: true,
      }),
    ]));
    const discovered = targets.find(target => target.scope === 'worktree');
    expect(discovered?.targetId).toMatch(/^rwt_[0-9a-f]{48}$/);
    const serialized = JSON.stringify(result.body);
    expect(serialized).not.toContain(home);
    expect(serialized).not.toContain(repository);
    expect(serialized).not.toContain(linkedWorktree);
    expect(serialized).not.toContain('folderPath');
    expect(serialized).not.toContain('worktreePath');
    expect(serialized).not.toContain('cwd');

    if (process.platform !== 'win32') {
      chmodSync(linkedWorktree, 0o000);
      try {
        const unreadableRefresh = await runtimeRequest({ baseUrl, path: '/api/agent-runtime/targets' });
        expect(unreadableRefresh.response.status).toBe(200);
        expect(unreadableRefresh.body.complete).toBe(false);
        expect((unreadableRefresh.body.targets as Array<Record<string, unknown>>)
          .some(target => target.targetId === discovered!.targetId)).toBe(false);
      } finally {
        chmodSync(linkedWorktree, 0o700);
      }
      const restoredRefresh = await runtimeRequest({ baseUrl, path: '/api/agent-runtime/targets' });
      expect(restoredRefresh.body.complete).toBe(true);
    }

    // Target projection remains available for inspection, but production task
    // start is held before target/lease/probe authority until strong descendant
    // containment exists. A separately held lease must remain untouched.
    const lease = await acquireWorkspaceLease({
      workspacePath: linkedWorktree,
      appDataDir: env.APP_DATA_DIR!,
      gitExecutable: 'git',
      attempts: 1,
      retryMs: 1,
      staleAfterMs: 60_000,
      deadOwnerGraceMs: 1_000,
    });
    try {
      const liveStart = await runtimeRequest({
        baseUrl,
        path: '/api/agent-runtime/tasks/start',
        method: 'POST',
        body: {
          protocolVersion: 'agentstoz-tasks-v2',
          requestId: 'request_live_worktree_12345678',
          targetId: discovered!.targetId,
          adapterId: 'codex',
          modelId: 'gpt-5.5',
          executionMode: 'workspace-write',
          prompt: 'This task must stop at the held workspace lease.',
        },
      });
      expect(liveStart.response.status).toBe(409);
      expect(liveStart.body.code).toBe('AGENT_RUNTIME_CONTAINMENT_UNAVAILABLE');
    } finally {
      expect(lease.release()).toBe(true);
    }

    // Even a cached target cannot bypass the production containment hold.
    rmSync(linkedWorktree, { recursive: true, force: true });
    mkdirSync(linkedWorktree, { recursive: true });
    const staleStart = await runtimeRequest({
      baseUrl,
      path: '/api/agent-runtime/tasks/start',
      method: 'POST',
      body: {
        protocolVersion: 'agentstoz-tasks-v2',
        requestId: 'request_stale_worktree_12345678',
        targetId: discovered!.targetId,
        adapterId: 'codex',
        modelId: 'gpt-5.5',
        executionMode: 'workspace-write',
        prompt: 'This task must not start.',
      },
    });
    expect(staleStart.response.status).toBe(409);
    expect(staleStart.body.code).toBe('AGENT_RUNTIME_CONTAINMENT_UNAVAILABLE');
  }, 15_000);

  test('deletion ledgers remove runtime targets after atomic replacement while starts remain safety-held', async () => {
    const home = mkdtempSync(join(tmpdir(), 'agentstoz-agent-runtime-deletion-authority-'));
    roots.push(home);
    const env = bundledEnvironment(home);
    const appDataDir = env.APP_DATA_DIR!;
    const rows = [
      { id: 'visible_target_12345678', name: 'Visible' },
      { id: 'local_hidden_12345678', name: 'Local hidden' },
      { id: 'remote_deleted_12345678', name: 'Remote deleted' },
      { id: 'legacy_generated_12345678', name: 'Legacy generated' },
    ].map(row => {
      const folderPath = join(home, row.id);
      mkdirSync(folderPath, { recursive: true });
      return { ...row, folderPath };
    });
    mkdirSync(appDataDir, { recursive: true });
    writeFileSync(join(appDataDir, 'ports.json'), JSON.stringify(rows));
    // The dedicated WAL is authoritative even while the legacy portal copy is
    // stale. This is the crash window in which ports.json can still hold rows
    // that the user has already hidden or permanently deleted.
    writeFileSync(join(appDataDir, 'portal.json'), JSON.stringify({
      localOnlyDeletedPortIds: [],
      remoteDeletedPortIds: [],
      verifiedLegacyGeneratedWorktreeIds: [],
    }));
    const metadataFile = join(appDataDir, 'portal-local-metadata.json');
    const metadata = {
      localOnlyDeletedPortIds: ['local_hidden_12345678'],
      remoteDeletedPortIds: ['remote_deleted_12345678'],
      verifiedLegacyGeneratedWorktreeIds: ['legacy_generated_12345678'],
    };
    writeFileSync(metadataFile, JSON.stringify(metadata));

    const { baseUrl, child } = await startTestApiServer({
      cwd: join(import.meta.dir, '..'),
      env,
    });
    children.push(child);

    const listed = await runtimeRequest({ baseUrl, path: '/api/agent-runtime/targets' });
    expect(listed.response.status).toBe(200);
    expect(listed.body.complete).toBe(true);
    expect((listed.body.targets as Array<Record<string, unknown>>).map(target => target.targetId))
      .toEqual(['visible_target_12345678']);

    // Simulate the app's atomic metadata writer after a client has cached the
    // visible target. Listing must use the new authority snapshot; production
    // starts remain stopped independently by the containment gate.
    const replacement = `${metadataFile}.replacement`;
    writeFileSync(replacement, JSON.stringify({
      ...metadata,
      localOnlyDeletedPortIds: [
        ...metadata.localOnlyDeletedPortIds,
        'visible_target_12345678',
      ],
    }));
    renameSync(replacement, metadataFile);

    for (const [index, row] of rows.entries()) {
      const rejected = await runtimeRequest({
        baseUrl,
        path: '/api/agent-runtime/tasks/start',
        method: 'POST',
        body: {
          protocolVersion: 'agentstoz-tasks-v2',
          requestId: `request_suppressed_${index}_12345678`,
          targetId: row.id,
          adapterId: 'codex',
          modelId: 'gpt-5.5',
          executionMode: 'workspace-write',
          prompt: 'This task must not be accepted.',
        },
      });
      expect(rejected.response.status).toBe(409);
      expect(rejected.body.code).toBe('AGENT_RUNTIME_CONTAINMENT_UNAVAILABLE');
    }

    const tasks = await runtimeRequest({ baseUrl, path: '/api/agent-runtime/tasks' });
    expect(tasks.response.status).toBe(200);
    expect(tasks.body.tasks).toEqual([]);
  }, 15_000);

  test('fails closed when the authoritative runtime deletion metadata is corrupt', async () => {
    const home = mkdtempSync(join(tmpdir(), 'agentstoz-agent-runtime-corrupt-deletion-authority-'));
    roots.push(home);
    const env = bundledEnvironment(home);
    const appDataDir = env.APP_DATA_DIR!;
    const project = join(home, 'registered-project');
    mkdirSync(project, { recursive: true });
    mkdirSync(appDataDir, { recursive: true });
    writeFileSync(join(appDataDir, 'ports.json'), JSON.stringify([{
      id: 'project_corrupt_safety_12345678',
      name: 'Must remain unavailable',
      folderPath: project,
    }]));
    writeFileSync(join(appDataDir, 'portal.json'), '{}');
    writeFileSync(join(appDataDir, 'portal-local-metadata.json'), '{corrupt');

    const { baseUrl, child } = await startTestApiServer({
      cwd: join(import.meta.dir, '..'),
      env,
    });
    children.push(child);

    const listed = await runtimeRequest({ baseUrl, path: '/api/agent-runtime/targets' });
    expect(listed.response.status).toBe(503);
    expect(listed.body.code).toBe('AGENT_RUNTIME_TARGET_STATUS_UNKNOWN');
    expect(JSON.stringify(listed.body)).not.toContain(project);

    const rejected = await runtimeRequest({
      baseUrl,
      path: '/api/agent-runtime/tasks/start',
      method: 'POST',
      body: {
        protocolVersion: 'agentstoz-tasks-v2',
        requestId: 'request_corrupt_safety_12345678',
        targetId: 'project_corrupt_safety_12345678',
        adapterId: 'codex',
        modelId: 'gpt-5.5',
        executionMode: 'workspace-write',
        prompt: 'This task must not be accepted.',
      },
    });
    expect(rejected.response.status).toBe(409);
    expect(rejected.body.code).toBe('AGENT_RUNTIME_CONTAINMENT_UNAVAILABLE');

    const tasks = await runtimeRequest({ baseUrl, path: '/api/agent-runtime/tasks' });
    expect(tasks.body.tasks).toEqual([]);
  }, 15_000);

  test('reports a present but unreadable/corrupt Git family as incomplete instead of non-Git', async () => {
    const home = mkdtempSync(join(tmpdir(), 'agentstoz-agent-runtime-unknown-git-'));
    roots.push(home);
    const corruptRepository = join(home, 'corrupt-repository');
    mkdirSync(corruptRepository, { recursive: true });
    writeFileSync(join(corruptRepository, '.git'), 'gitdir: /definitely/missing/git-directory\n');

    const env = bundledEnvironment(home);
    mkdirSync(env.APP_DATA_DIR!, { recursive: true });
    writeFileSync(join(env.APP_DATA_DIR!, 'ports.json'), JSON.stringify([{
      id: 'project_corrupt_12345678',
      name: '손상된 Git 프로젝트',
      folderPath: corruptRepository,
    }]));
    const { baseUrl, child } = await startTestApiServer({
      cwd: join(import.meta.dir, '..'),
      env,
    });
    children.push(child);

    const result = await runtimeRequest({ baseUrl, path: '/api/agent-runtime/targets' });
    expect(result.response.status).toBe(200);
    expect(result.body.complete).toBe(false);
    expect(result.body.targets).toEqual([
      expect.objectContaining({
        targetId: 'project_corrupt_12345678',
        scope: 'main',
        worktreeCapable: false,
      }),
    ]);
  }, 15_000);

  test('does not erase an unresolved explicit worktree parent or derive a label from its path', async () => {
    const home = mkdtempSync(join(tmpdir(), 'agentstoz-agent-runtime-parent-claim-'));
    roots.push(home);
    const repository = join(home, 'registered-project');
    const linkedWorktree = join(home, 'linked-runtime-worktree');
    const secretNamedFolder = join(home, 'private-client-folder-name');
    mkdirSync(repository, { recursive: true });
    mkdirSync(secretNamedFolder, { recursive: true });
    runGit(repository, ['init', '-q']);
    runGit(repository, ['config', 'user.email', 'runtime-test@example.invalid']);
    runGit(repository, ['config', 'user.name', 'Runtime Test']);
    writeFileSync(join(repository, 'README.md'), '# parent claim\n');
    runGit(repository, ['add', 'README.md']);
    runGit(repository, ['commit', '-q', '-m', 'initial']);
    runGit(repository, ['worktree', 'add', '-q', '-b', 'codex/parent-claim', linkedWorktree]);

    const env = bundledEnvironment(home);
    mkdirSync(env.APP_DATA_DIR!, { recursive: true });
    writeFileSync(join(env.APP_DATA_DIR!, 'ports.json'), JSON.stringify([
      { id: 'project_parent_12345678', name: 'Parent', folderPath: repository },
      {
        id: 'persisted_worktree_12345678',
        name: 'Bad parent claim',
        folderPath: linkedWorktree,
        worktreePath: linkedWorktree,
        worktreeParentId: 'missing_parent_12345678',
      },
      { id: 'folder_unnamed_12345678', folderPath: secretNamedFolder },
    ]));
    const { baseUrl, child } = await startTestApiServer({
      cwd: join(import.meta.dir, '..'),
      env,
    });
    children.push(child);

    const result = await runtimeRequest({ baseUrl, path: '/api/agent-runtime/targets' });
    expect(result.response.status).toBe(200);
    expect(result.body.complete).toBe(false);
    const targets = result.body.targets as Array<Record<string, unknown>>;
    expect(targets.some(target => target.targetId === 'persisted_worktree_12345678')).toBe(false);
    expect(targets.some(target => target.scope === 'worktree'
      && target.projectTargetId === 'project_parent_12345678')).toBe(true);
    expect(targets.find(target => target.targetId === 'folder_unnamed_12345678')?.label)
      .toBe('등록 프로젝트');
    expect(JSON.stringify(result.body)).not.toContain('private-client-folder-name');
  }, 15_000);

  test('reports an unreadable registered directory as unknown instead of missing', async () => {
    if (process.platform === 'win32') return;
    const home = mkdtempSync(join(tmpdir(), 'agentstoz-agent-runtime-unknown-directory-'));
    roots.push(home);
    const sealed = join(home, 'sealed');
    const project = join(sealed, 'project');
    mkdirSync(project, { recursive: true });

    const env = bundledEnvironment(home);
    mkdirSync(env.APP_DATA_DIR!, { recursive: true });
    writeFileSync(join(env.APP_DATA_DIR!, 'ports.json'), JSON.stringify([{
      id: 'project_unreadable_12345678',
      name: '읽을 수 없는 프로젝트',
      folderPath: project,
    }]));

    chmodSync(sealed, 0o000);
    try {
      // Some privileged test runners can still traverse mode 000. In that
      // environment this fixture cannot produce the condition under test.
      try {
        realpathSync(project);
        return;
      } catch {
        // Expected: the sidecar will see the same filesystem authority.
      }
      const { baseUrl, child } = await startTestApiServer({
        cwd: join(import.meta.dir, '..'),
        env,
      });
      children.push(child);

      const result = await runtimeRequest({ baseUrl, path: '/api/agent-runtime/targets' });
      expect(result.response.status).toBe(200);
      expect(result.body.complete).toBe(false);
      expect(result.body.targets).toEqual([]);
    } finally {
      chmodSync(sealed, 0o700);
    }
  }, 15_000);

  test('accepts only its own authority, exact routes, and exact Tauri preflight', async () => {
    const home = mkdtempSync(join(tmpdir(), 'agentstoz-agent-runtime-capability-'));
    roots.push(home);
    const env = bundledEnvironment(home);
    mkdirSync(env.APP_DATA_DIR!, { recursive: true });
    writeFileSync(join(env.APP_DATA_DIR!, 'ports.json'), '[]');
    const { baseUrl, child } = await startTestApiServer({
      cwd: join(import.meta.dir, '..'),
      env,
    });
    children.push(child);

    const accepted = await runtimeRequest({
      baseUrl,
      path: '/api/agent-runtime/capabilities',
    });
    expect(accepted.response.status).toBe(200);
    expect(accepted.body.protocolVersion).toBe('agentstoz-tasks-v2');
    expect(accepted.response.headers.get('cache-control')).toContain('no-store');

    for(const path of ['/api/agent-runtime/terminals','/api/agent-runtime/terminals/access','/api/agent-runtime/quick-labels']) {
      const body=path.endsWith('/terminals')?{operation:'list',requestId:crypto.randomUUID()}:{};
      const own=await runtimeRequest({baseUrl,path,method:'POST',body});
      expect(own.response.status).toBe(path.endsWith('quick-labels')?400:200);
      for(const capability of [null,WHAT_I_SAID_CAPABILITY,REMOTE_CONTROL_CAPABILITY]) {
        expect((await runtimeRequest({baseUrl,path,method:'POST',body,capability})).response.status).toBe(403);
      }
      expect((await runtimeRequest({baseUrl,path:path+'?x=1',method:'POST',body})).response.status).toBe(403);
      expect((await runtimeRequest({baseUrl,path,method:'GET'})).response.status).toBe(403);
    }

    const readiness = await runtimeRequest({
      baseUrl,
      path: '/api/agent-runtime/readiness',
    });
    expect(readiness.response.status).toBe(200);
    expect(readiness.body).toMatchObject({
      kind: 'agent-runtime-readiness-diagnostic',
      authoritative: false,
      reusable: false,
      ready: false,
    });

    const targets = await runtimeRequest({
      baseUrl,
      path: '/api/agent-runtime/targets',
    });
    expect(targets.response.status).toBe(200);
    expect(targets.body).toMatchObject({ targets: [], complete: true });

    const conversations = await runtimeRequest({
      baseUrl,
      path: '/api/agent-runtime/conversations',
    });
    expect(conversations.response.status).toBe(200);
    expect(conversations.body).toMatchObject({
      protocolVersion: 'agentstoz-conversations-v1',
      conversations: [],
    });

    const conversationCapabilities = await runtimeRequest({
      baseUrl,
      path: '/api/agent-runtime/conversations/capabilities',
    });
    expect(conversationCapabilities.response.status).toBe(200);
    expect(conversationCapabilities.body.protocolVersion).toBe('agentstoz-tasks-v2');
    expect(conversationCapabilities.body.adapters).toBeArray();

    for (const capability of [null, WHAT_I_SAID_CAPABILITY, REMOTE_CONTROL_CAPABILITY]) {
      const rejected = await runtimeRequest({
        baseUrl,
        path: '/api/agent-runtime/capabilities',
        capability,
      });
      expect(rejected.response.status).toBe(403);
      expect(rejected.body.code).toBe('AGENT_RUNTIME_MANAGEMENT_ORIGIN_DENIED');
    }

    const wrongHeader = await runtimeRequest({
      baseUrl,
      path: '/api/agent-runtime/capabilities',
      capability: null,
      headers: { 'X-AgentsToZ-Remote-Control-Capability': AGENT_RUNTIME_CAPABILITY },
    });
    expect(wrongHeader.response.status).toBe(403);

    for (const candidate of [
      { method: 'POST', path: '/api/agent-runtime/capabilities', body: {} },
      { method: 'POST', path: '/api/agent-runtime/readiness', body: {} },
      { method: 'GET', path: '/api/agent-runtime/readiness?detail=1' },
      { method: 'GET', path: '/api/agent-runtime/targets?cwd=/private/project' },
      { method: 'GET', path: '/api/agent-runtime/tasks/start' },
      { method: 'GET', path: '/api/agent-runtime/tasks/task_12345678/events' },
      { method: 'GET', path: '/api/agent-runtime/tasks/task_12345678/events?after=00' },
      { method: 'POST', path: '/api/agent-runtime/tasks/task_12345678/cancel?after=0', body: {} },
      { method: 'POST', path: '/api/agent-runtime/conversations', body: {} },
      { method: 'GET', path: '/api/agent-runtime/conversations/start' },
      { method: 'GET', path: '/api/agent-runtime/conversations/conversation_12345678/history' },
      { method: 'GET', path: '/api/agent-runtime/conversations/conversation_12345678/events' },
      { method: 'GET', path: '/api/agent-runtime/conversations/conversation_12345678/events?after=00' },
      { method: 'POST', path: '/api/agent-runtime/conversations/conversation_12345678/continue?cwd=/tmp', body: {} },
      { method: 'POST', path: '/api/agent-runtime/conversations/conversation_12345678/shell', body: {} },
      { method: 'POST', path: '/api/agent-runtime/arbitrary', body: {} },
    ]) {
      const rejected = await runtimeRequest({ baseUrl, ...candidate });
      expect(rejected.response.status).toBe(403);
    }

    const noOrigin = await runtimeRequest({
      baseUrl,
      path: '/api/agent-runtime/capabilities',
      origin: null,
    });
    expect(noOrigin.response.status).toBe(403);

    const forgedDevBrowserRequest = await runtimeRequest({
      baseUrl,
      path: '/api/agent-runtime/capabilities',
      origin: null,
      headers: {
        Referer: 'http://127.0.0.1:9000/',
        'Sec-Fetch-Site': 'same-origin',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Dest': 'empty',
      },
    });
    expect(forgedDevBrowserRequest.response.status).toBe(403);

    const wrongPreflight = await runtimeRequest({
      baseUrl,
      path: '/api/agent-runtime/tasks/start',
      method: 'OPTIONS',
      capability: null,
      headers: {
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type,x-agentstoz-remote-control-capability',
      },
    });
    expect(wrongPreflight.response.status).toBe(403);

    const validPreflight = await runtimeRequest({
      baseUrl,
      path: '/api/agent-runtime/tasks/start',
      method: 'OPTIONS',
      capability: null,
      headers: {
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type,x-agentstoz-agent-runtime-capability',
      },
    });
    expect(validPreflight.response.status).toBe(200);

    const validConversationPreflight = await runtimeRequest({
      baseUrl,
      path: '/api/agent-runtime/conversations/start',
      method: 'OPTIONS',
      capability: null,
      headers: {
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type,x-agentstoz-agent-runtime-capability',
      },
    });
    expect(validConversationPreflight.response.status).toBe(200);
  }, 15_000);

  test('accepts only fetch-metadata-proven same-origin browser requests in local web mode', async () => {
    const home = mkdtempSync(join(tmpdir(), 'agentstoz-agent-runtime-local-web-'));
    roots.push(home);
    const env = bundledEnvironment(home);
    delete env.PORTMGR_BUNDLED_SIDECAR;
    delete env.PORTMGR_AGENT_RUNTIME_CAPABILITY;
    mkdirSync(env.APP_DATA_DIR!, { recursive: true });
    writeFileSync(join(env.APP_DATA_DIR!, 'ports.json'), '[]');
    const { baseUrl, child } = await startTestApiServer({
      cwd: join(import.meta.dir, '..'),
      env,
    });
    children.push(child);

    const browserHeaders = {
      'Sec-Fetch-Site': 'same-origin',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Dest': 'empty',
    };
    const accepted = await runtimeRequest({
      baseUrl,
      path: '/api/agent-runtime/capabilities',
      origin: null,
      capability: null,
      headers: browserHeaders,
    });
    expect(accepted.response.status).toBe(200);
    expect(accepted.body.protocolVersion).toBe('agentstoz-tasks-v2');

    const rejectedHeaderSets: Array<Record<string, string>> = [
      { ...browserHeaders, 'Sec-Fetch-Site': 'cross-site' },
      { ...browserHeaders, 'Sec-Fetch-Mode': 'navigate' },
      { ...browserHeaders, 'Sec-Fetch-Dest': 'document' },
      { Referer: 'http://127.0.0.1:9000/' },
    ];
    for (const headers of rejectedHeaderSets) {
      const rejected = await runtimeRequest({
        baseUrl,
        path: '/api/agent-runtime/capabilities',
        origin: null,
        capability: null,
        headers,
      });
      expect(rejected.response.status).toBe(403);
    }
  }, 15_000);

  test('publishes a domain-separated proof and strips the secret before project spawn', async () => {
    const home = mkdtempSync(join(tmpdir(), 'agentstoz-agent-runtime-proof-'));
    roots.push(home);
    const env = bundledEnvironment(home);
    const appDataDir = env.APP_DATA_DIR!;
    const projectPath = join(home, 'project');
    const commandPath = join(projectPath, 'check-runtime-authority.sh');
    const resultPath = join(home, 'runtime-authority-result.txt');
    mkdirSync(appDataDir, { recursive: true });
    mkdirSync(projectPath, { recursive: true });
    const quotedResult = resultPath.replace(/'/g, `'"'"'`);
    writeFileSync(commandPath, [
      '#!/bin/bash',
      'if [ -n "${PORTMGR_AGENT_RUNTIME_CAPABILITY:-}" ]; then',
      `  printf leaked > '${quotedResult}'`,
      'else',
      `  printf absent > '${quotedResult}'`,
      'fi',
      '',
    ].join('\n'));
    writeFileSync(join(appDataDir, 'ports.json'), JSON.stringify([{
      id: 'runtime-capability-check',
      name: 'Runtime capability check',
      folderPath: projectPath,
      commandPath,
    }]));
    const { baseUrl, child } = await startTestApiServer({
      cwd: join(import.meta.dir, '..'),
      env,
    });
    children.push(child);

    const nonce = '11'.repeat(contract.agentRuntimeHealthProof.nonceBytes);
    const health = await fetch(`${baseUrl}/api/health?nonce=${nonce}`);
    const healthBody = await health.json() as Record<string, unknown>;
    const expected = createHmac('sha256', Buffer.from(AGENT_RUNTIME_CAPABILITY, 'hex'))
      .update(contract.agentRuntimeHealthProof.domain, 'utf8')
      .update(Buffer.from(nonce, 'hex'))
      .digest('hex');
    expect(healthBody[contract.agentRuntimeHealthProof.responseField]).toBe(expected);
    expect(contract.agentRuntimeHealthProof.responseField)
      .not.toBe(contract.sidecarHealthProof.responseField);
    expect(contract.agentRuntimeHealthProof.responseField)
      .not.toBe(contract.remoteControlHealthProof.responseField);
    expect(contract.agentRuntimeHealthProof.domain).not.toBe(contract.sidecarHealthProof.domain);

    const execute = await fetch(`${baseUrl}/api/execute-command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        portId: 'runtime-capability-check',
        commandPath,
        folderPath: projectPath,
      }),
    });
    expect(execute.status).toBe(200);
    for (let attempt = 0; attempt < 100 && !existsSync(resultPath); attempt += 1) {
      await Bun.sleep(20);
    }
    expect(readFileSync(resultPath, 'utf8')).toBe('absent');

    const source = readFileSync(new URL('../api-server.ts', import.meta.url), 'utf8');
    const capture = source.indexOf('const AGENT_RUNTIME_MANAGEMENT_CAPABILITY');
    const removal = source.indexOf('delete process.env.PORTMGR_AGENT_RUNTIME_CAPABILITY', capture);
    const firstRegisteredSpawn = source.indexOf('env: {\n            ...process.env', removal);
    expect(capture).toBeGreaterThan(-1);
    expect(removal).toBeGreaterThan(capture);
    expect(firstRegisteredSpawn).toBeGreaterThan(removal);
  }, 15_000);
});
