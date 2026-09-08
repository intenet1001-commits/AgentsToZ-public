import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AGENT_RUNTIME_CODEX_IDENTITY_ENV,
  createAgentRuntimeGuardLaunchers,
  resolveAgentRuntimeGuardCommand,
} from '../src/agentRuntimeGuardLauncher';
import {
  AGENT_RUNTIME_GUARD_RESERVATION_ENV,
  encodeAgentRuntimeGuardReservation,
  prepareAgentRuntimeGuardRegistry,
} from '../src/agentRuntimeGuardRegistry';
import { ClaudeRemoteConversationManager } from '../src/claudeRemoteConversation';
import {
  CODEX_RUNTIME_MACOS_IDENTIFIER,
  CODEX_RUNTIME_MACOS_TEAM_ID,
  codexRuntimeExecutableRevision,
  type CodexRuntimeExecutableIdentity,
} from '../src/codexRuntimeExecutable';

const roots: string[] = [];
const cleanupPids: number[] = [];
let cachedExecutableIdentity: CodexRuntimeExecutableIdentity | null = null;

function localExecutableIdentity(
  overrides: Partial<Pick<CodexRuntimeExecutableIdentity, 'sha256'>> = {},
): CodexRuntimeExecutableIdentity {
  if (!cachedExecutableIdentity) {
    const path = realpathSync(process.execPath);
    const info = statSync(path, { bigint: true });
    const base: Omit<CodexRuntimeExecutableIdentity, 'revision'> = {
      path,
      source: 'standalone-native',
      version: '1.0.0',
      sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
      stat: {
        dev: info.dev.toString(),
        ino: info.ino.toString(),
        size: info.size.toString(),
        mode: Number(info.mode),
        mtimeNs: info.mtimeNs.toString(),
        ctimeNs: info.ctimeNs.toString(),
      },
      signing: process.platform === 'darwin' ? {
        platform: 'darwin',
        teamId: CODEX_RUNTIME_MACOS_TEAM_ID,
        identifier: CODEX_RUNTIME_MACOS_IDENTIFIER,
      } : null,
    };
    cachedExecutableIdentity = {
      ...base,
      revision: codexRuntimeExecutableRevision(base),
    };
  }
  const base = {
    ...cachedExecutableIdentity,
    ...overrides,
  };
  const { revision: _revision, ...withoutRevision } = base;
  return {
    ...withoutRevision,
    revision: codexRuntimeExecutableRevision(withoutRevision),
  };
}

function launchersFor(root: string) {
  return createAgentRuntimeGuardLaunchers(
    prepareAgentRuntimeGuardRegistry(join(root, 'app-data')),
  );
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error?.code === 'EPERM';
  }
}

async function eventually(predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(20);
  }
  throw new Error('guard condition was not reached');
}

afterEach(() => {
  for (const pid of cleanupPids.splice(0)) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Agent Runtime process guard', () => {
  test.skipIf(process.platform === 'win32')(
    'reaps its provider after the owning sidecar is SIGKILLed',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'agentstoz-runtime-guard-'));
      roots.push(root);
      const pidFile = join(root, 'provider.pid');
      const guardSource = new URL('../agent-runtime-process-guard.ts', import.meta.url).pathname;
      const childSource = new URL('./fixtures/agent-runtime-guard-child.ts', import.meta.url).pathname;
      const grandchildSource = new URL('./fixtures/agent-runtime-guard-grandchild.ts', import.meta.url).pathname;
      const parentSource = new URL('./fixtures/agent-runtime-guard-parent.ts', import.meta.url).pathname;
      const parent = Bun.spawn([
        process.execPath,
        parentSource,
        guardSource,
        childSource,
        grandchildSource,
        pidFile,
      ], { stdin: 'ignore', stdout: 'ignore', stderr: 'pipe' });

      await eventually(() => existsSync(pidFile));
      const ids = JSON.parse(readFileSync(pidFile, 'utf8')) as {
        providerPid: number;
        grandchildPid: number;
      };
      const { providerPid, grandchildPid } = ids;
      expect(Number.isSafeInteger(providerPid) && providerPid > 1).toBe(true);
      expect(Number.isSafeInteger(grandchildPid) && grandchildPid > 1).toBe(true);
      cleanupPids.push(providerPid, grandchildPid);
      expect(alive(providerPid)).toBe(true);
      expect(alive(grandchildPid)).toBe(true);

      parent.kill('SIGKILL');
      await parent.exited;
      await eventually(() => !alive(providerPid) && !alive(grandchildPid));
      cleanupPids.splice(cleanupPids.indexOf(providerPid), 1);
      cleanupPids.splice(cleanupPids.indexOf(grandchildPid), 1);
      expect(alive(providerPid)).toBe(false);
      expect(alive(grandchildPid)).toBe(false);
    },
  );

  test.skipIf(process.platform === 'win32')(
    'does not launch a provider after its owning sidecar exits during guard startup',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'agentstoz-runtime-guard-orphan-'));
      roots.push(root);
      const pidFile = join(root, 'provider.pid');
      const guardPidFile = join(root, 'guard.pid');
      const guardSource = new URL('../agent-runtime-process-guard.ts', import.meta.url).pathname;
      const childSource = new URL('./fixtures/agent-runtime-guard-child.ts', import.meta.url).pathname;
      const grandchildSource = new URL('./fixtures/agent-runtime-guard-grandchild.ts', import.meta.url).pathname;
      const parentSource = new URL('./fixtures/agent-runtime-guard-parent.ts', import.meta.url).pathname;
      const parent = Bun.spawn([
        process.execPath,
        parentSource,
        guardSource,
        childSource,
        grandchildSource,
        pidFile,
        'exit-after-guard-spawn',
        guardPidFile,
      ], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' });

      expect(await parent.exited).toBe(0);
      await eventually(() => existsSync(guardPidFile));
      const guardPid = Number(readFileSync(guardPidFile, 'utf8'));
      expect(Number.isSafeInteger(guardPid) && guardPid > 1).toBe(true);
      cleanupPids.push(guardPid);
      await eventually(() => !alive(guardPid));
      cleanupPids.splice(cleanupPids.indexOf(guardPid), 1);
      // Wait past the replacement supervisor's dead-owner grace. A guard that
      // only noticed EOF after a long synchronous hash would create this file.
      await Bun.sleep(1_100);
      expect(existsSync(pidFile)).toBe(false);
    },
  );

  test.skipIf(process.platform === 'win32')(
    'rejects a missing workspace before reserving, now that cwd no longer does',
    async () => {
      // Spawning the guard from '/' means Bun no longer raises ENOENT for a
      // workspace deleted or renamed while the app was running. Without an
      // explicit check the launch would appear to start, the durable
      // reservation would already be committed to 'active', and the real
      // failure would surface inside the guard as a posix_spawn error naming
      // /usr/bin/env rather than the missing project.
      const root = mkdtempSync(join(tmpdir(), 'agentstoz-runtime-guard-missing-'));
      roots.push(root);
      const missing = join(root, 'was-renamed-away');
      const executableIdentity = localExecutableIdentity();
      const launchers = launchersFor(root);

      expect(() => launchers.spawnCodex(
        [executableIdentity.path, '--version'],
        {
          cwd: missing,
          env: { HOME: root, PATH: process.env.PATH ?? '/usr/bin:/bin' },
          stdin: 'pipe',
          stdout: 'pipe',
          stderr: 'pipe',
          detached: true,
        },
        executableIdentity,
      )).toThrow(/workspace directory is unavailable/);

      expect(() => launchers.spawnClaudeRemote(
        [executableIdentity.path, '--version'],
        {
          cwd: missing,
          env: { HOME: root, PATH: process.env.PATH ?? '/usr/bin:/bin' },
          stdin: 'pipe',
          stdout: 'pipe',
          stderr: 'pipe',
        },
      )).toThrow(/workspace directory is unavailable/);

      // A file is not a workspace either.
      const filePath = join(root, 'not-a-directory');
      writeFileSync(filePath, 'x', { mode: 0o600 });
      expect(() => launchers.spawnClaudeRemote(
        [executableIdentity.path, '--version'],
        {
          cwd: filePath,
          env: { HOME: root, PATH: process.env.PATH ?? '/usr/bin:/bin' },
          stdin: 'pipe',
          stdout: 'pipe',
          stderr: 'pipe',
        },
      )).toThrow(/not a directory/);
    },
  );

  test.skipIf(process.platform === 'win32')(
    'launches the guard from a neutral cwd and carries the workspace in argv',
    async () => {
      // Defence in depth means neither layer is observable on its own from the
      // outside: with both the `--env-file` flag and the neutral cwd in place, a
      // regression in either one still yields a clean provider env. This test
      // pins the cwd contract directly so it cannot rot behind the other layer.
      const root = mkdtempSync(join(tmpdir(), 'agentstoz-runtime-guard-contract-'));
      roots.push(root);
      const executableIdentity = localExecutableIdentity();
      const calls: { argv: readonly string[]; cwd: unknown }[] = [];
      const realSpawn = Bun.spawn;
      (Bun as { spawn: unknown }).spawn = ((argv: readonly string[], options: { cwd?: unknown }) => {
        calls.push({ argv, cwd: options?.cwd });
        // Swap in a trivially exiting process so nothing real is launched.
        return realSpawn(['/usr/bin/true'], {
          stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
        });
      }) as unknown;
      const spawned: { exited: Promise<unknown> }[] = [];
      try {
        spawned.push(launchersFor(root).spawnCodex(
          [executableIdentity.path, '--version'],
          {
            cwd: root,
            env: { HOME: root, PATH: process.env.PATH ?? '/usr/bin:/bin' },
            stdin: 'pipe',
            stdout: 'pipe',
            stderr: 'pipe',
            detached: true,
          },
          executableIdentity,
        ));
        spawned.push(launchersFor(root).spawnClaudeRemote(
          [executableIdentity.path, '--version'],
          {
            cwd: root,
            env: { HOME: root, PATH: process.env.PATH ?? '/usr/bin:/bin' },
            stdin: 'pipe',
            stdout: 'pipe',
            stderr: 'pipe',
          },
        ));
      } finally {
        (Bun as { spawn: unknown }).spawn = realSpawn;
      }
      // The stand-in processes exit almost immediately and their release path
      // reopens the registry under `root`. Settle them here, or afterEach
      // removes that directory first and the failure lands on the next test.
      await Promise.allSettled(spawned.map(entry => entry.exited));

      expect(calls).toHaveLength(2);
      // BOTH spawn paths must hold the line. The claude-remote branch forwards
      // the guard's entire environment to the provider, so it is the one where
      // a workspace cwd leaks worst -- and a behavioural test cannot catch a
      // regression there, because the launcher also passes --env-file=/dev/null
      // and either defence alone keeps the provider env clean. Only this
      // contract assertion fails when one of the two is removed.
      for (const [index, protocol] of [
        [0, 'agentstoz-provider-argv-v4'],
        [1, 'agentstoz-claude-remote-argv-v3'],
      ] as const) {
        const call = calls[index]!;
        // The guard must never run inside the untrusted workspace.
        expect(call.cwd).toBe('/');
        expect(call.cwd).not.toBe(root);
        // The workspace has to reach the guard some other way, or the provider
        // would silently start in the wrong directory.
        const protocolIndex = call.argv.indexOf(protocol);
        expect(protocolIndex).toBeGreaterThanOrEqual(0);
        expect(call.argv[protocolIndex + 1]).toBe(root);
      }
    },
  );

  test.skipIf(process.platform === 'win32')(
    'keeps a hostile project .env out of the guard even with dotenv autoload live',
    async () => {
      // The packaged guard is a compiled binary: it receives no `bun` CLI flags,
      // and no build flag disables Bun's cwd dotenv autoload (verified against
      // bun 1.3.1 -- `--no-compile-autoload-dotenv` does not suppress it). The
      // only thing standing between a project's `.env` and the provider is that
      // the guard never runs with the workspace as its cwd. This test launches
      // the guard the way a compiled one behaves -- autoload fully live -- so a
      // regression in that cwd contract fails here even if the flag survives.
      const root = mkdtempSync(join(tmpdir(), 'agentstoz-runtime-guard-nocwd-'));
      roots.push(root);
      writeFileSync(join(root, '.env'), [
        'AGENTSTOZ_AUDIT_SECRET=must-not-cross',
        'CODEX_HOME=/hostile/project-controlled-codex-home',
      ].join('\n'), { mode: 0o600 });

      const guardCommand = resolveAgentRuntimeGuardCommand();
      expect(guardCommand).not.toBeNull();
      const guardSource = guardCommand![guardCommand!.length - 1]!;
      const safeConfig = guardCommand!.find(value => value.startsWith('--config='))!;
      const envChild = new URL('./fixtures/agent-runtime-guard-env-cwd-child.ts', import.meta.url).pathname;
      const executableIdentity = localExecutableIdentity();
      const reservation = prepareAgentRuntimeGuardRegistry(join(root, 'app-data'))
        .reserve({ kind: 'codex', cwd: root });

      const guard = Bun.spawn([
        // Deliberately no `--env-file` here: this models the compiled guard.
        process.execPath,
        guardSource,
        'agentstoz-provider-argv-v4',
        root,
        executableIdentity.path,
        '--env-file=/dev/null',
        '--no-install',
        safeConfig,
        envChild,
      ], {
        cwd: '/',
        env: {
          HOME: root,
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          [AGENT_RUNTIME_CODEX_IDENTITY_ENV]: Buffer.from(
            JSON.stringify(executableIdentity),
            'utf8',
          ).toString('base64url'),
          [AGENT_RUNTIME_GUARD_RESERVATION_ENV]:
            encodeAgentRuntimeGuardReservation(reservation),
        },
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
        detached: true,
      });
      cleanupPids.push(guard.pid);
      const output = await new Response(guard.stdout).text();
      await guard.exited;
      cleanupPids.splice(cleanupPids.indexOf(guard.pid), 1);

      const reported = JSON.parse(output) as {
        env: Record<string, string>;
        cwd: string;
      };
      // The provider still ran in the workspace -- the guard moved its own cwd
      // out, not the provider's.
      expect(realpathSync(reported.cwd)).toBe(realpathSync(root));
      expect(reported.env.HOME).toBe(root);
      // ...and nothing from the workspace `.env` reached it.
      expect(reported.env.AGENTSTOZ_AUDIT_SECRET).toBeUndefined();
      expect(reported.env.CODEX_HOME).toBeUndefined();
    },
  );

  test.skipIf(process.platform === 'win32')(
    'keeps a hostile project .env out of the source guard and provider env',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'agentstoz-runtime-guard-env-'));
      roots.push(root);
      writeFileSync(join(root, '.env'), [
        'AGENTSTOZ_AUDIT_SECRET=must-not-cross',
        'PORTMGR_AGENT_RUNTIME_CAPABILITY=must-not-cross-either',
        // CODEX_HOME is normally allowed, so this proves a missing parent
        // value cannot be synthesized by the hostile working directory.
        'CODEX_HOME=/hostile/project-controlled-codex-home',
      ].join('\n'), { mode: 0o600 });
      const preloadMarker = join(root, 'hostile-preload-ran');
      writeFileSync(join(root, 'hostile-preload.ts'), [
        "import { writeFileSync } from 'node:fs';",
        `writeFileSync(${JSON.stringify(preloadMarker)}, 'loaded');`,
      ].join('\n'), { mode: 0o600 });
      writeFileSync(join(root, 'bunfig.toml'), 'preload = ["./hostile-preload.ts"]\n', { mode: 0o600 });
      const guardCommand = resolveAgentRuntimeGuardCommand();
      expect(guardCommand).not.toBeNull();
      expect(guardCommand?.slice(1, 2)).toEqual(['--env-file=/dev/null']);
      expect(guardCommand).toContain('--no-install');
      expect(guardCommand?.some(value => value.endsWith('/agent-runtime-guard.bunfig.toml'))).toBe(true);
      const safeConfig = guardCommand!.find(value => value.startsWith('--config='));
      expect(safeConfig).toBeTruthy();
      const envChild = new URL('./fixtures/agent-runtime-guard-env-child.ts', import.meta.url).pathname;
      const executableIdentity = localExecutableIdentity();
      const guarded = launchersFor(root).spawnCodex([
        executableIdentity.path,
        '--env-file=/dev/null',
        '--no-install',
        safeConfig!,
        envChild,
      ], {
        cwd: root,
        env: {
          HOME: root,
          PATH: process.env.PATH ?? '/usr/bin:/bin',
        },
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
        detached: true,
      }, executableIdentity);
      const output = await new Response(guarded.stdout).text();
      await guarded.exited;
      expect(await guarded.releaseGuardRecordAfterTermination?.()).toBe(true);
      const providerEnv = JSON.parse(output) as Record<string, string>;
      expect(providerEnv.HOME).toBe(root);
      expect(providerEnv.PATH).toBeTruthy();
      expect(providerEnv.AGENTSTOZ_AUDIT_SECRET).toBeUndefined();
      expect(providerEnv.PORTMGR_AGENT_RUNTIME_CAPABILITY).toBeUndefined();
      expect(providerEnv.CODEX_HOME).toBeUndefined();
      expect(providerEnv[AGENT_RUNTIME_CODEX_IDENTITY_ENV]).toBeUndefined();
      expect(providerEnv[AGENT_RUNTIME_GUARD_RESERVATION_ENV]).toBeUndefined();
      expect(existsSync(preloadMarker)).toBe(false);
    },
  );

  test.skipIf(process.platform === 'win32')(
    'launcher carries the current identity into guard v3 without exposing it to Codex',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'agentstoz-runtime-launcher-identity-'));
      roots.push(root);
      const envChild = new URL('./fixtures/agent-runtime-guard-env-child.ts', import.meta.url).pathname;
      const executableIdentity = localExecutableIdentity();
      const guarded = launchersFor(root).spawnCodex([
        executableIdentity.path,
        '--env-file=/dev/null',
        envChild,
      ], {
        cwd: root,
        env: { HOME: root, PATH: process.env.PATH ?? '/usr/bin:/bin' },
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
        detached: true,
      }, executableIdentity);

      const output = await new Response(guarded.stdout).text();
      await guarded.exited;
      expect(await guarded.releaseGuardRecordAfterTermination?.()).toBe(true);
      const providerEnv = JSON.parse(output) as Record<string, string>;
      expect(providerEnv.HOME).toBe(root);
      expect(providerEnv[AGENT_RUNTIME_CODEX_IDENTITY_ENV]).toBeUndefined();
    },
  );

  test.skipIf(process.platform === 'win32')(
    'rejects a changed Codex identity inside the guard before provider spawn',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'agentstoz-runtime-guard-identity-'));
      roots.push(root);
      const pidFile = join(root, 'provider.pid');
      const childSource = new URL('./fixtures/agent-runtime-guard-child.ts', import.meta.url).pathname;
      const grandchildSource = new URL('./fixtures/agent-runtime-guard-grandchild.ts', import.meta.url).pathname;
      const changedIdentity = localExecutableIdentity({ sha256: '0'.repeat(64) });
      const guard = launchersFor(root).spawnCodex([
        changedIdentity.path,
        '--env-file=/dev/null',
        childSource,
        pidFile,
        grandchildSource,
      ], {
        cwd: root,
        env: {
          HOME: root,
          PATH: process.env.PATH ?? '/usr/bin:/bin',
        },
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
        detached: true,
      }, changedIdentity);
      const stderr = await new Response(guard.stderr).text();
      const exitCode = await guard.exited;
      expect(await guard.releaseGuardRecordAfterTermination?.()).toBe(true);

      expect(exitCode).not.toBe(0);
      expect(stderr).toContain('Codex executable changed before provider launch');
      expect(existsSync(pidFile)).toBe(false);
    },
  );

  test.skipIf(process.platform === 'win32')(
    'rejects the legacy Codex guard protocol instead of launching without identity proof',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'agentstoz-runtime-guard-v1-'));
      roots.push(root);
      const pidFile = join(root, 'provider.pid');
      const guardCommand = resolveAgentRuntimeGuardCommand();
      expect(guardCommand).not.toBeNull();
      const childSource = new URL('./fixtures/agent-runtime-guard-child.ts', import.meta.url).pathname;
      const grandchildSource = new URL('./fixtures/agent-runtime-guard-grandchild.ts', import.meta.url).pathname;
      const guard = Bun.spawn([
        ...guardCommand!,
        'agentstoz-provider-argv-v1',
        process.execPath,
        '--env-file=/dev/null',
        childSource,
        pidFile,
        grandchildSource,
      ], {
        cwd: root,
        env: { HOME: root, PATH: process.env.PATH ?? '/usr/bin:/bin' },
        stdin: 'pipe',
        stdout: 'ignore',
        stderr: 'ignore',
        detached: true,
      });

      expect(await guard.exited).not.toBe(0);
      expect(existsSync(pidFile)).toBe(false);
    },
  );

  test.skipIf(process.platform === 'win32')(
    'keeps a hostile project .env out of Claude Remote Control, which forwards the whole env',
    async () => {
      // The claude-remote branch deliberately hands the provider the user's
      // entire environment (agent-runtime-process-guard.ts), so unlike the
      // codex branch there is no allowlist to blunt a leak: whatever the guard
      // absorbed crosses verbatim. That makes this the branch where the cwd
      // contract actually matters, and until now it was the only one with no
      // dotenv test at all -- so reintroducing cwd: options.cwd in
      // spawnClaudeRemote would have left the suite fully green.
      const root = mkdtempSync(join(tmpdir(), 'agentstoz-claude-guard-env-'));
      roots.push(root);
      writeFileSync(join(root, '.env'), [
        'AGENTSTOZ_AUDIT_SECRET=must-not-cross',
        'ANTHROPIC_BASE_URL=https://hostile.example',
      ].join('\n'), { mode: 0o600 });
      const envChild = new URL('./fixtures/agent-runtime-guard-env-cwd-child.ts', import.meta.url).pathname;
      const guarded = launchersFor(root).spawnClaudeRemote([
        process.execPath,
        '--env-file=/dev/null',
        envChild,
      ], {
        cwd: root,
        env: { HOME: root, PATH: process.env.PATH ?? '/usr/bin:/bin' },
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const output = await new Response(guarded.stdout).text();
      await guarded.exited;

      const reported = JSON.parse(output) as {
        env: Record<string, string>;
        cwd: string;
      };
      expect(realpathSync(reported.cwd)).toBe(realpathSync(root));
      expect(reported.env.HOME).toBe(root);
      // No allowlist protects these -- only the guard's neutral cwd does.
      expect(reported.env.AGENTSTOZ_AUDIT_SECRET).toBeUndefined();
      expect(reported.env.ANTHROPIC_BASE_URL).toBeUndefined();
    },
  );

  test.skipIf(process.platform === 'win32')(
    'kills the full Claude Remote Control process group from a synchronous exit hook',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'agentstoz-claude-guard-'));
      roots.push(root);
      const pidFile = join(root, 'provider.pid');
      const childSource = new URL('./fixtures/agent-runtime-guard-child.ts', import.meta.url).pathname;
      const grandchildSource = new URL('./fixtures/agent-runtime-guard-grandchild.ts', import.meta.url).pathname;
      const guarded = launchersFor(root).spawnClaudeRemote([
        process.execPath,
        '--env-file=/dev/null',
        childSource,
        pidFile,
        grandchildSource,
      ], {
        cwd: root,
        env: { HOME: root, PATH: process.env.PATH ?? '/usr/bin:/bin' },
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      });

      await eventually(() => existsSync(pidFile));
      const ids = JSON.parse(readFileSync(pidFile, 'utf8')) as {
        providerPid: number;
        grandchildPid: number;
      };
      cleanupPids.push(ids.providerPid, ids.grandchildPid);
      expect(alive(ids.providerPid)).toBe(true);
      expect(alive(ids.grandchildPid)).toBe(true);

      guarded.kill('SIGKILL');
      await guarded.exited;
      await eventually(() => !alive(ids.providerPid) && !alive(ids.grandchildPid));
      for (const pid of [ids.providerPid, ids.grandchildPid]) {
        const index = cleanupPids.indexOf(pid);
        if (index >= 0) cleanupPids.splice(index, 1);
      }
    },
  );

  test.skipIf(process.platform === 'win32')(
    'manager shutdown confirms a TERM-ignoring Claude descendant group is gone',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'agentstoz-claude-manager-guard-'));
      roots.push(root);
      const pidFile = join(root, 'provider.pid');
      const childSource = new URL('./fixtures/agent-runtime-guard-child.ts', import.meta.url).pathname;
      const grandchildSource = new URL('./fixtures/agent-runtime-guard-grandchild.ts', import.meta.url).pathname;
      const sessionId = 'session_01KgGmCfnbmXvyy8y3Am5hPr';
      const manager = new ClaudeRemoteConversationManager({ terminationGraceMs: 1_000 });
      await manager.startAndOpen({
        projectKey: root,
        folderPath: root,
        projectName: 'guard test',
        deviceName: 'test device',
        claudePath: '/unused/by-test-spawn',
        spawn: (_command, options) => launchersFor(root).spawnClaudeRemote([
          process.execPath,
          '--env-file=/dev/null',
          childSource,
          pidFile,
          grandchildSource,
          `https://claude.ai/code/${sessionId}`,
        ], options),
        openSession() {},
      });
      const ids = JSON.parse(readFileSync(pidFile, 'utf8')) as {
        providerPid: number;
        grandchildPid: number;
      };
      cleanupPids.push(ids.providerPid, ids.grandchildPid);
      // Let the grandchild install its SIGTERM-ignore handler before shutdown.
      await Bun.sleep(100);

      await manager.shutdown();
      await eventually(() => !alive(ids.providerPid) && !alive(ids.grandchildPid));
      for (const pid of [ids.providerPid, ids.grandchildPid]) {
        const index = cleanupPids.indexOf(pid);
        if (index >= 0) cleanupPids.splice(index, 1);
      }
    },
  );
});
