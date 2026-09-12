import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { resolveAppDataDir } from '../src/appDataDir';
import { isPrivateRemoteControlIpv4 } from '../src/remoteControlLanServer';
import { REMOTE_CONTROL_PROTOCOL_VERSION } from '../src/remoteControlCore';
import { startTestApiServer } from './startTestApiServer';

const CAPABILITY = 'd'.repeat(64);
const TAURI_ORIGIN = 'http://tauri.localhost';
const roots: string[] = [];
const children: Bun.Subprocess[] = [];
const fixtureCleanups: Array<() => Promise<void>> = [];

function installHermesPresenceFixture(testHome: string): void {
  const bin = join(testHome, '.local', 'bin');
  mkdirSync(bin, { recursive: true });
  // These cases inspect launch availability, never execute Hermes. Do not
  // depend on a developer having the real CLI installed while Linux CI does not.
  writeFileSync(join(bin, 'hermes'), '#!/bin/sh\nexit 64\n', { mode: 0o700 });
}
const BunWebSocket = WebSocket as unknown as {
  new(url: string, options: { headers: Record<string, string> }): WebSocket;
};

afterEach(async () => {
  for (const cleanup of fixtureCleanups.splice(0).reverse()) {
    await cleanup().catch(() => undefined);
  }
  for (const child of children.splice(0)) {
    try { child.kill(); } catch {}
    await child.exited.catch(() => undefined);
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function hostPrivateIpv4(): string | null {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (!entry.internal && entry.family === 'IPv4' && isPrivateRemoteControlIpv4(entry.address)) {
        return entry.address;
      }
    }
  }
  return null;
}

async function management(baseUrl: string, path: string, body: Record<string, unknown> = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: TAURI_ORIGIN,
      'X-AgentsToZ-Remote-Control-Capability': CAPABILITY,
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(payload)}`);
  return payload as Record<string, any>;
}

function waitForSessionReady(socket: WebSocket, pairToken: string): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('LAN WebSocket pairing timed out')), 5_000);
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({
        type: 'controller.pair',
        protocolVersion: REMOTE_CONTROL_PROTOCOL_VERSION,
        token: pairToken,
      }));
    });
    socket.addEventListener('message', event => {
      let message: Record<string, any>;
      try { message = JSON.parse(String(event.data)); }
      catch { return; }
      if (message.type !== 'session.ready') return;
      clearTimeout(timeout);
      resolve(message);
    });
    socket.addEventListener('error', () => {
      clearTimeout(timeout);
      reject(new Error('LAN WebSocket connection failed'));
    });
  });
}

function waitForJsonMessage(
  socket: WebSocket,
  predicate: (message: Record<string, any>) => boolean,
  label: string,
): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error(`${label} timed out`)), 8_000);
    const onMessage = (event: MessageEvent) => {
      let message: Record<string, any>;
      try { message = JSON.parse(String(event.data)); }
      catch { return; }
      if (!predicate(message)) return;
      finish(null, message);
    };
    const onClose = () => finish(new Error(`${label} socket closed`));
    const onError = () => finish(new Error(`${label} socket failed`));
    const finish = (error: Error | null, message?: Record<string, any>) => {
      clearTimeout(timeout);
      socket.removeEventListener('message', onMessage);
      socket.removeEventListener('close', onClose);
      socket.removeEventListener('error', onError);
      if (error) reject(error);
      else resolve(message!);
    };
    socket.addEventListener('message', onMessage);
    socket.addEventListener('close', onClose);
    socket.addEventListener('error', onError);
  });
}

async function remoteAction(
  socket: WebSocket,
  sessionToken: string,
  controlId: string,
  actionId: string,
  action: 'start' | 'stop' | 'restart' | 'project.status' | 'git.pull',
): Promise<Record<string, any>> {
  const pending = waitForJsonMessage(
    socket,
    message => message.type === 'action.result' && message.actionId === actionId,
    `remote action ${actionId}`,
  );
  socket.send(JSON.stringify({
    type: 'action.request',
    protocolVersion: REMOTE_CONTROL_PROTOCOL_VERSION,
    sessionToken,
    controlId,
    actionId,
    action,
    ...(action === 'project.status' ? {} : { remoteConfirmed: true }),
  }));
  return pending;
}

async function remoteRequest(
  socket: WebSocket,
  request: Record<string, unknown> & { actionId: string },
): Promise<Record<string, any>> {
  const pending = waitForJsonMessage(
    socket,
    message => message.type === 'action.result' && message.actionId === request.actionId,
    `remote request ${request.actionId}`,
  );
  socket.send(JSON.stringify({
    type: 'action.request',
    protocolVersion: REMOTE_CONTROL_PROTOCOL_VERSION,
    ...request,
  }));
  return pending;
}

function mustGit(cwd: string, args: string[]): void {
  const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString() || `git ${args.join(' ')} failed`);
}

function assertPublicActionResult(
  result: Record<string, any>,
  forbidden: readonly string[],
): void {
  expect(Object.keys(result).sort()).toEqual(['actionId', 'ok', 'project', 'type']);
  expect(result.ok).toBe(true);
  expect(Object.keys(result.project).sort()).toEqual(['actions', 'alias', 'branch', 'controlId', 'kind', 'name', 'port', 'status', 'workspaceRoot']);
  const serialized = JSON.stringify(result);
  for (const value of forbidden) expect(serialized).not.toContain(value);
  expect(serialized).not.toMatch(/\"pid\"|\"command\"|\"folderPath\"|\"internalId\"/);
}

function reserveHighLoopbackPort(): { port: number; release: () => void } {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const port = 49_152 + Math.floor(Math.random() * (65_535 - 49_152));
    try {
      const reservation = Bun.serve({
        hostname: '127.0.0.1',
        port,
        fetch: () => new Response('reserved'),
      });
      return { port, release: () => reservation.stop(true) };
    } catch { /* try another high port */ }
  }
  throw new Error('could not reserve a high fixture port');
}

async function readFixturePid(port: number): Promise<number | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/pid`, {
      signal: AbortSignal.timeout(250),
    });
    if (!response.ok) return null;
    const payload = await response.json() as { pid?: unknown };
    return Number.isInteger(payload.pid) && Number(payload.pid) > 1 ? Number(payload.pid) : null;
  } catch {
    return null;
  }
}

async function waitForFixturePid(
  port: number,
  predicate: (pid: number | null) => boolean,
  label: string,
): Promise<number | null> {
  const deadline = Date.now() + 5_000;
  do {
    const pid = await readFixturePid(port);
    if (predicate(pid)) return pid;
    await Bun.sleep(50);
  } while (Date.now() < deadline);
  throw new Error(`${label} timed out`);
}

function killVerifiedFixtureFromPidFile(pidFile: string, marker: string): void {
  if (!existsSync(pidFile)) return;
  const pid = Number(readFileSync(pidFile, 'utf8').trim());
  if (!Number.isInteger(pid) || pid <= 1) return;
  const inspected = Bun.spawnSync(['ps', '-p', String(pid), '-o', 'command=']);
  const command = inspected.exitCode === 0 ? inspected.stdout.toString() : '';
  if (!command.includes(marker)) return;
  try { process.kill(pid, 'SIGKILL'); } catch {}
}

describe('QR remote-control real LAN management integration', () => {
  test('shows every Git worktree creator on desktop/mobile and creates a real registered project through the opaque root', async () => {
    const expectedInterface = hostPrivateIpv4();
    if (!expectedInterface) return;

    const home = mkdtempSync(join(tmpdir(), 'agentstoz-remote-lan-integration-'));
    roots.push(home);
    installHermesPresenceFixture(home);
    const appDataDir = resolveAppDataDir(process.platform, {
      ...process.env,
      HOME: home,
      APPDATA: join(home, 'AppData', 'Roaming'),
      XDG_CONFIG_HOME: join(home, '.config'),
    }, home);
    const projectPath = join(home, 'project');
    const staleWorktreePath = join(home, 'stale-worktree-directory');
    const workspacePath = join(home, 'workspace');
    mkdirSync(appDataDir, { recursive: true });
    mkdirSync(projectPath, { recursive: true });
    mkdirSync(staleWorktreePath, { recursive: true });
    mkdirSync(workspacePath, { recursive: true });
    writeFileSync(join(projectPath, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } }));
    const untrustedOrigin = join(home, 'local-origin.git');
    mustGit(home, ['init', '--bare', untrustedOrigin]);
    mustGit(projectPath, ['init', '--initial-branch=trunk']);
    mustGit(projectPath, ['config', 'user.name', 'Remote LAN Test']);
    mustGit(projectPath, ['config', 'user.email', 'remote-lan@example.test']);
    mustGit(projectPath, ['add', 'package.json']);
    mustGit(projectPath, ['commit', '-m', 'initial']);
    mustGit(projectPath, ['remote', 'add', 'origin', untrustedOrigin]);
    // Creator identity is deliberately represented only by the conventional
    // location. Git's registered family is authoritative: Codex-hidden,
    // Orca-managed-looking and plain external paths must all reach both the
    // local discovery endpoint and the mobile card list.
    const externalWorktrees = [
      { branch: 'codex/external', path: join(home, '.codex', 'worktrees', 'external') },
      { branch: 'orca/external', path: join(home, 'orca', 'workspaces', 'project', 'external') },
      { branch: 'plain/external', path: join(home, 'elsewhere', 'plain-worktree') },
    ];
    for (const external of externalWorktrees) {
      mkdirSync(dirname(external.path), { recursive: true });
      mustGit(projectPath, ['worktree', 'add', '-b', external.branch, external.path]);
    }
    writeFileSync(join(appDataDir, 'portal.json'), JSON.stringify({ deviceId: 'this-test-device' }));
    writeFileSync(join(appDataDir, 'workspace-roots.json'), JSON.stringify([{
      id: 'private-workspace-root',
      name: 'Integration workspace',
      path: workspacePath,
    }]));
    writeFileSync(join(appDataDir, 'ports.json'), JSON.stringify([
      {
        id: 'real-integration-project',
        name: 'LAN integration project',
        port: 54_321,
        folderPath: projectPath,
        sourceDeviceId: 'this-test-device',
      },
      {
        id: 'stale-persisted-worktree',
        name: 'Stale persisted worktree',
        folderPath: projectPath,
        worktreePath: staleWorktreePath,
        worktreeParentId: 'real-integration-project',
        sourceDeviceId: 'this-test-device',
      },
    ]));

    const { baseUrl, child } = await startTestApiServer({
      cwd: join(import.meta.dir, '..'),
      env: {
        ...process.env,
        HOME: home,
        APPDATA: join(home, 'AppData', 'Roaming'),
        XDG_CONFIG_HOME: join(home, '.config'),
        APP_DATA_DIR: appDataDir,
        NODE_ENV: 'test',
        PORT: '9000',
        PORTMGR_BUNDLED_SIDECAR: '1',
        PORTMGR_PARENT_PID: String(process.pid),
        PORTMGR_WHAT_I_SAID_CAPABILITY: 'e'.repeat(64),
        PORTMGR_REMOTE_CONTROL_CAPABILITY: CAPABILITY,
        AGENTSTOZ_SKIP_HERMES_SYNC: '1',
      },
    });
    children.push(child);

    const localDiscoveryResponse = await fetch(`${baseUrl}/api/discover-registered-git-worktrees?cursor=0`);
    const localDiscovery = await localDiscoveryResponse.json() as any;
    expect(localDiscoveryResponse.ok).toBe(true);
    const discoveredFamily = localDiscovery.families.find((family: any) => family.projectId === 'real-integration-project');
    expect(discoveredFamily.worktrees.map((worktree: any) => worktree.branch)).toEqual(expect.arrayContaining([
      'trunk', 'codex/external', 'orca/external', 'plain/external',
    ]));

    const interfaces = await management(baseUrl, '/api/remote-control/interfaces');
    expect(interfaces.interfaces.some((entry: any) => entry.address === expectedInterface)).toBe(true);

    let socket: WebSocket | null = null;
    try {
      const enabled = await management(baseUrl, '/api/remote-control/enable', {
        interfaceAddress: expectedInterface,
      });
      expect(enabled.enabled).toBe(true);
      expect(enabled.listener.host).toBe(expectedInterface);

      const pairing = await management(baseUrl, '/api/remote-control/pairing/rotate');
      const pairingUrl = new URL(pairing.pairingUrl);
      const pairToken = new URLSearchParams(pairingUrl.hash.slice(1)).get('pair');
      expect(pairToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(pairingUrl.hostname).toBe(expectedInterface);
      expect(pairingUrl.pathname).toBe('/remote/');

      const shell = await fetch(pairingUrl.origin + '/remote/');
      expect(shell.status).toBe(200);
      expect(shell.headers.get('content-security-policy')).toContain("default-src 'none'");
      expect(await shell.text()).toContain('AgentsToZ 원격 제어');

      socket = new BunWebSocket(pairingUrl.origin.replace(/^http:/, 'ws:') + '/remote/ws', {
        headers: { Origin: pairingUrl.origin },
      });
      const ready = await waitForSessionReady(socket, pairToken!);
      expect(ready.protocolVersion).toBe(REMOTE_CONTROL_PROTOCOL_VERSION);
      expect(ready.projects).toHaveLength(4);
      const externalCards = ready.projects.filter((project: any) => project.kind === 'worktree');
      expect(externalCards.map((project: any) => project.branch)).toEqual(expect.arrayContaining([
        'codex/external', 'orca/external', 'plain/external',
      ]));
      for (const card of externalCards) {
        expect(card.actions).toEqual(expect.arrayContaining([
          'agent.claude', 'agent.codex', 'agent.agy', 'agent.hermes',
        ]));
      }
      expect(JSON.stringify(ready)).not.toContain('Stale persisted worktree');
      expect(Object.keys(ready.projects[0]).sort()).toEqual(['actions', 'alias', 'branch', 'controlId', 'kind', 'name', 'port', 'status', 'workspaceRoot']);
      expect(JSON.stringify(ready)).not.toContain('real-integration-project');
      expect(JSON.stringify(ready)).not.toContain(projectPath);
      expect(ready.projects[0].actions).toContain('git.pull');
      expect(ready.projects[0].actions).not.toContain('claude.thread.start');
      expect(ready.projects[0].actions).toContain('codex.thread.start');
      expect(ready.projects[0].actions).toContain('worktree.add');
      expect(ready.projects[0].actions).toContain('worktree.add.orca');

      const rootsResult = await remoteRequest(socket, {
        sessionToken: ready.sessionToken,
        actionId: 'workspace-roots',
        action: 'workspace-roots.list',
      });
      expect(rootsResult).toMatchObject({
        ok: true,
        workspaceRoots: [{ name: 'Integration workspace' }],
      });
      expect(JSON.stringify(rootsResult)).not.toContain('private-workspace-root');
      expect(JSON.stringify(rootsResult)).not.toContain(workspacePath);
      const workspaceRootId = rootsResult.workspaceRoots[0].controlId as string;

      const created = await remoteRequest(socket, {
        sessionToken: ready.sessionToken,
        actionId: 'create-project',
        action: 'project.create',
        input: 'remote-created-project',
        workspaceRootId,
        remoteConfirmed: true,
      });
      expect(created).toMatchObject({ ok: true, project: {name: 'remote-created-project'} });
      const createdCard = created.project;
      expect(createdCard).toBeTruthy();
      expect(createdCard.actions).not.toContain('claude.thread.start');
      expect(createdCard.actions).toContain('codex.thread.start');
      expect(createdCard.actions).toContain('worktree.add');
      expect(createdCard.actions).toContain('worktree.add.orca');
      expect(JSON.stringify(created)).not.toContain(workspacePath);
      expect(JSON.stringify(created)).not.toContain('private-workspace-root');
      const createdPath = join(workspacePath, 'remote-created-project');
      expect(existsSync(join(createdPath, '.git'))).toBe(true);
      expect(existsSync(join(createdPath, '.agent-memory', 'config.json'))).toBe(true);
      expect(Bun.spawnSync(['git', 'rev-parse', '--verify', 'HEAD'], {
        cwd: createdPath,
        stdout: 'pipe',
        stderr: 'pipe',
      }).exitCode).toBe(0);
      expect(Bun.spawnSync(['git', 'status', '--porcelain=v1', '--untracked-files=all'], {
        cwd: createdPath,
        stdout: 'pipe',
        stderr: 'pipe',
      }).stdout.toString().trim()).toBe('');
      const storedPorts = JSON.parse(readFileSync(join(appDataDir, 'ports.json'), 'utf8')) as Array<Record<string, unknown>>;
      expect(storedPorts.some(port => (
        port.name === 'remote-created-project'
        && typeof port.folderPath === 'string'
        && realpathSync(port.folderPath) === realpathSync(createdPath)
      ))).toBe(true);
      const creationReceipts = JSON.parse(readFileSync(join(appDataDir, 'remote-control', 'project-launch-receipts.json'), 'utf8'));
      const receipt = Object.values(creationReceipts.entries)[0] as Record<string, unknown>;
      expect(receipt.state).toBe('registered');
      expect(receipt.controllerId).toMatch(/^lan:[a-f0-9]{64}$/);
      expect(storedPorts.find(port => port.id === receipt.projectId)?.name).toBe('remote-created-project');
      expect(JSON.stringify(created)).not.toContain(String(receipt.projectId));
      const retried = await remoteRequest(socket, {
        sessionToken: ready.sessionToken, actionId: 'create-project', action: 'project.create',
        input: 'remote-created-project', workspaceRootId, remoteConfirmed: true,
      });
      expect(retried).toEqual(created);

      const worktreeResult = await remoteRequest(socket, {
        sessionToken: ready.sessionToken,
        actionId: 'create-standard-worktree',
        action: 'worktree.add',
        controlId: createdCard.controlId,
        input: 'codex/remote-standard',
        remoteConfirmed: true,
      });
      expect(worktreeResult).toMatchObject({ ok: true, page: 0, projectCount: 6 });
      const worktreeCard = worktreeResult.projects.find((project: any) => (
        project.kind === 'worktree' && project.name.includes('codex/remote-standard')
      ));
      expect(worktreeCard).toBeTruthy();
      expect(worktreeCard.actions).not.toContain('claude.thread.start');
      expect(worktreeCard.actions).toContain('codex.thread.start');
      expect(worktreeCard.actions).toContain('git.merge');
      const standardWorktreePath = join(createdPath, 'worktrees', 'codex-remote-standard');
      expect(existsSync(standardWorktreePath)).toBe(true);
      expect(Bun.spawnSync(['git', 'worktree', 'list', '--porcelain'], {
        cwd: createdPath,
        stdout: 'pipe',
        stderr: 'pipe',
      }).stdout.toString()).toContain(realpathSync(standardWorktreePath));
      expect(JSON.stringify(worktreeResult)).not.toContain(standardWorktreePath);

      const blockedPull = await remoteAction(
        socket,
        ready.sessionToken,
        ready.projects[0].controlId,
        'git-pull-untrusted-origin',
        'git.pull',
      );
      expect(blockedPull).toMatchObject({
        type: 'action.result',
        actionId: 'git-pull-untrusted-origin',
        ok: false,
        error: { code: 'GITHUB_REMOTE_REQUIRED' },
      });
      expect(JSON.stringify(blockedPull)).not.toContain(projectPath);
      expect(JSON.stringify(blockedPull)).not.toContain(untrustedOrigin);

      const active = await management(baseUrl, '/api/remote-control/status');
      expect(active.sessions).toHaveLength(1);
      expect(active.sessions[0].id).toMatch(/^[A-Za-z0-9_-]{8,128}$/);
    } finally {
      const disabled = await management(baseUrl, '/api/remote-control/disable').catch(() => null);
      expect(disabled?.enabled).toBe(false);
      socket?.close();
    }
  });

  test('runs a registered fixture through real LAN action transport, restart, and stop without leaking authority data', async () => {
    const expectedInterface = hostPrivateIpv4();
    if (!expectedInterface) return;

    const home = mkdtempSync(join(tmpdir(), 'agentstoz-remote-action-integration-'));
    roots.push(home);
    installHermesPresenceFixture(home);
    const appDataDir = resolveAppDataDir(process.platform, {
      ...process.env,
      HOME: home,
      APPDATA: join(home, 'AppData', 'Roaming'),
      XDG_CONFIG_HOME: join(home, '.config'),
    }, home);
    const projectPath = join(home, 'fixture-project');
    const pidFile = join(home, 'fixture.pid');
    const internalId = 'real-action-fixture-project';
    const marker = `agentstoz-remote-fixture-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
    const command = `bun fixture-listener.ts ${marker}`;
    const reservation = reserveHighLoopbackPort();
    const fixturePort = reservation.port;
    mkdirSync(appDataDir, { recursive: true });
    mkdirSync(projectPath, { recursive: true });
    writeFileSync(join(projectPath, 'fixture-listener.ts'), `
const port = Number(process.env.PORT);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid fixture port');
const server = Bun.serve({
  hostname: '127.0.0.1',
  port,
  fetch: () => Response.json({ pid: process.pid }),
});
await Bun.write(${JSON.stringify(pidFile)}, String(process.pid));
const close = () => { server.stop(true); process.exit(0); };
process.on('SIGTERM', close);
process.on('SIGINT', close);
await new Promise(() => {});
`);
    writeFileSync(join(appDataDir, 'portal.json'), JSON.stringify({ deviceId: 'this-test-device' }));
    writeFileSync(join(appDataDir, 'ports.json'), JSON.stringify([{
      id: internalId,
      name: 'Safe action fixture',
      port: fixturePort,
      folderPath: projectPath,
      terminalCommand: command,
      sourceDeviceId: 'this-test-device',
    }]));
    reservation.release();

    const { baseUrl, child } = await startTestApiServer({
      cwd: join(import.meta.dir, '..'),
      env: {
        ...process.env,
        HOME: home,
        APPDATA: join(home, 'AppData', 'Roaming'),
        XDG_CONFIG_HOME: join(home, '.config'),
        APP_DATA_DIR: appDataDir,
        NODE_ENV: 'test',
        PORT: '9000',
        PORTMGR_BUNDLED_SIDECAR: '1',
        PORTMGR_PARENT_PID: String(process.pid),
        PORTMGR_WHAT_I_SAID_CAPABILITY: 'e'.repeat(64),
        PORTMGR_REMOTE_CONTROL_CAPABILITY: CAPABILITY,
        AGENTSTOZ_SKIP_HERMES_SYNC: '1',
      },
    });
    children.push(child);

    const cleanup = async () => {
      await fetch(`${baseUrl}/api/stop-command`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ portId: internalId, port: fixturePort }),
      }).catch(() => undefined);
      await management(baseUrl, '/api/remote-control/disable').catch(() => undefined);
      killVerifiedFixtureFromPidFile(pidFile, marker);
    };
    fixtureCleanups.push(cleanup);

    let socket: WebSocket | null = null;
    try {
      await management(baseUrl, '/api/remote-control/enable', { interfaceAddress: expectedInterface });
      const pairing = await management(baseUrl, '/api/remote-control/pairing/rotate');
      const pairingUrl = new URL(pairing.pairingUrl);
      const pairToken = new URLSearchParams(pairingUrl.hash.slice(1)).get('pair');
      expect(pairToken).toMatch(/^[A-Za-z0-9_-]{43}$/);

      socket = new BunWebSocket(pairingUrl.origin.replace(/^http:/, 'ws:') + '/remote/ws', {
        headers: { Origin: pairingUrl.origin },
      });
      const ready = await waitForSessionReady(socket, pairToken!);
      expect(ready.projects).toHaveLength(1);
      const sessionToken = ready.sessionToken as string;
      const controlId = ready.projects[0].controlId as string;
      const forbidden = [internalId, projectPath, command, marker];
      expect(JSON.stringify(ready)).not.toContain(internalId);
      expect(JSON.stringify(ready)).not.toContain(projectPath);
      expect(ready.projects[0].actions).toEqual([
        'start', 'folder.open',
        'agent.claude', 'agent.codex', 'agent.agy', 'agent.hermes',
        'codex.thread.start',
        'localhost.open', 'orca.open',
      ]);

      const started = await remoteAction(socket, sessionToken, controlId, 'fixture-start', 'start');
      assertPublicActionResult(started, forbidden);
      const firstPid = await waitForFixturePid(fixturePort, pid => pid !== null, 'fixture start');
      expect(firstPid).toBeGreaterThan(1);

      const running = await remoteAction(socket, sessionToken, controlId, 'fixture-running-status', 'project.status');
      assertPublicActionResult(running, forbidden);
      expect(running.project.status).toBe('running');
      expect(running.project.actions).toContain('restart');

      const restarted = await remoteAction(socket, sessionToken, controlId, 'fixture-restart', 'restart');
      assertPublicActionResult(restarted, forbidden);
      const secondPid = await waitForFixturePid(
        fixturePort,
        pid => pid !== null && pid !== firstPid,
        'fixture restart',
      );
      expect(secondPid).toBeGreaterThan(1);
      expect(secondPid).not.toBe(firstPid);

      const restartedStatus = await remoteAction(socket, sessionToken, controlId, 'fixture-restarted-status', 'project.status');
      assertPublicActionResult(restartedStatus, forbidden);
      expect(restartedStatus.project.status).toBe('running');
      expect(restartedStatus.project.actions).toContain('stop');

      const stopped = await remoteAction(socket, sessionToken, controlId, 'fixture-stop', 'stop');
      assertPublicActionResult(stopped, forbidden);
      expect(await waitForFixturePid(fixturePort, pid => pid === null, 'fixture stop')).toBeNull();
    } finally {
      socket?.close();
      await cleanup();
    }
  });
});
