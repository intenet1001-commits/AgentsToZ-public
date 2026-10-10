import { describe, expect, test } from 'bun:test';
import {
  ClaudeRemoteConversationManager,
  type ClaudeRemoteControlProcess,
  type SpawnClaudeRemoteControl,
} from '../src/claudeRemoteConversation';

const SESSION = 'session_01KgGmCfnbmXvyy8y3Am5hPr';

function controlledProcess() {
  const stdout = new TransformStream<Uint8Array, Uint8Array>();
  const stderr = new TransformStream<Uint8Array, Uint8Array>();
  let resolveExit!: (code: number) => void;
  const exited = new Promise<number>(resolve => { resolveExit = resolve; });
  const process: ClaudeRemoteControlProcess = {
    stdin: { write() {}, end() {} },
    stdout: stdout.readable,
    stderr: stderr.readable,
    exited,
    kill(signal) {
      if (signal === 'SIGTERM' || signal === 'SIGKILL') resolveExit(signal === 'SIGKILL' ? 137 : 143);
    },
  };
  return { process, stdoutWriter: stdout.writable.getWriter() };
}

function launchInput(overrides: Partial<Parameters<ClaudeRemoteConversationManager['startAndOpen']>[0]> = {}) {
  return {
    projectKey: '/repo',
    folderPath: '/repo',
    projectName: '프로젝트',
    deviceName: '개발 Mac',
    claudePath: '/usr/local/bin/claude',
    openSession() {},
    ...overrides,
  };
}

async function announce(writer: WritableStreamDefaultWriter<Uint8Array>): Promise<void> {
  await writer.write(new TextEncoder().encode(`https://claude.ai/code/${SESSION}\n`));
}

describe('Claude app conversation permission mode', () => {
  test('starts the session in the permission mode the desktop toggle selected', async () => {
    const manager = new ClaudeRemoteConversationManager();
    const child = controlledProcess();
    const commands: string[][] = [];
    const spawn: SpawnClaudeRemoteControl = command => { commands.push(command); return child.process; };

    const pending = manager.startAndOpen(launchInput({ spawn, permissionMode: 'bypassPermissions' }));
    await announce(child.stdoutWriter);
    await pending;

    expect(commands[0]!.slice(-2)).toEqual(['--permission-mode', 'bypassPermissions']);
    await manager.shutdown();
  });

  test('does not silently reuse a live session that runs in a different mode', async () => {
    const manager = new ClaudeRemoteConversationManager();
    const child = controlledProcess();
    let spawnCount = 0;
    const spawn: SpawnClaudeRemoteControl = () => { spawnCount += 1; return child.process; };
    const first = manager.startAndOpen(launchInput({ spawn, permissionMode: 'default' }));
    await announce(child.stdoutWriter);
    await first;

    await expect(manager.startAndOpen(launchInput({ spawn, permissionMode: 'bypassPermissions' })))
      .rejects.toMatchObject({
        code: 'CLAUDE_REMOTE_SESSION_PERMISSION_MODE_MISMATCH',
        publicMessage: expect.stringContaining('권한 우회'),
      });
    expect(spawnCount).toBe(1);
    await manager.shutdown();
  });

  test('refuses to fold a concurrent press for another mode into the pending start', async () => {
    const manager = new ClaudeRemoteConversationManager();
    const child = controlledProcess();
    const spawn: SpawnClaudeRemoteControl = () => child.process;
    const first = manager.startAndOpen(launchInput({ spawn, permissionMode: 'bypassPermissions' }));

    await expect(manager.startAndOpen(launchInput({ spawn, permissionMode: 'default' })))
      .rejects.toMatchObject({ code: 'CLAUDE_REMOTE_SESSION_PERMISSION_MODE_MISMATCH' });
    await announce(child.stdoutWriter);
    await expect(first).resolves.toMatchObject({ reusedActiveSession: false });
    await manager.shutdown();
  });

  test('a caller that names no mode (the phone) reuses whichever session is live', async () => {
    const manager = new ClaudeRemoteConversationManager();
    const child = controlledProcess();
    const spawn: SpawnClaudeRemoteControl = () => child.process;
    const first = manager.startAndOpen(launchInput({ spawn, permissionMode: 'bypassPermissions' }));
    await announce(child.stdoutWriter);
    await first;

    await expect(manager.startAndOpen(launchInput({ spawn }))).resolves.toMatchObject({
      sessionId: SESSION,
      reusedActiveSession: true,
    });
    await manager.shutdown();
  });

  test('a caller that names no mode starts a new session in the safe default mode', async () => {
    const manager = new ClaudeRemoteConversationManager();
    const child = controlledProcess();
    const commands: string[][] = [];
    const pending = manager.startAndOpen(launchInput({ spawn: command => { commands.push(command); return child.process; } }));
    await announce(child.stdoutWriter);
    await pending;

    expect(commands[0]!.slice(-2)).toEqual(['--permission-mode', 'default']);
    await manager.shutdown();
  });
});
