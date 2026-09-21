import { describe, expect, test } from 'bun:test';
import {
  ClaudeRemoteConversationManager,
  type ClaudeRemoteControlProcess,
  type SpawnClaudeRemoteControl,
} from '../src/claudeRemoteConversation';

function controlledProcess(options: {
  pid?: number;
  exitOnKill?: readonly NodeJS.Signals[];
} = {}) {
  const stdout = new TransformStream<Uint8Array, Uint8Array>();
  const stderr = new TransformStream<Uint8Array, Uint8Array>();
  const stdoutWriter = stdout.writable.getWriter();
  const stderrWriter = stderr.writable.getWriter();
  let resolveExit!: (code: number) => void;
  let rejectExit!: (cause: unknown) => void;
  const exited = new Promise<number>((resolve, reject) => {
    resolveExit = resolve;
    rejectExit = reject;
  });
  const kills: Array<number | NodeJS.Signals | undefined> = [];
  const process: ClaudeRemoteControlProcess = {
    ...(options.pid ? { pid: options.pid } : {}),
    stdin: { write() {}, end() {} },
    stdout: stdout.readable,
    stderr: stderr.readable,
    exited,
    kill(signal) {
      kills.push(signal);
      const exitOnKill = options.exitOnKill ?? ['SIGTERM', 'SIGKILL'];
      if (typeof signal === 'string' && exitOnKill.includes(signal)) {
        resolveExit(signal === 'SIGKILL' ? 137 : 143);
      }
    },
  };
  return { process, stdoutWriter, stderrWriter, resolveExit, rejectExit, kills };
}

const SESSION_ONE = 'session_01KgGmCfnbmXvyy8y3Am5hPr';

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

describe('Claude Code first remote conversation', () => {
  test('starts a bounded single-session server and opens the exact returned Claude session', async () => {
    const manager = new ClaudeRemoteConversationManager();
    const child = controlledProcess();
    const calls: Array<{ command: string[]; cwd: string }> = [];
    const opened: string[] = [];
    const spawn: SpawnClaudeRemoteControl = (command, options) => {
      calls.push({ command, cwd: options.cwd });
      return child.process;
    };

    const pending = manager.startAndOpen(launchInput({
      spawn,
      openSession: sessionId => opened.push(sessionId),
    }));
    await child.stdoutWriter.write(new TextEncoder().encode(
      `Continue coding in the Claude mobile app or https://claude.ai/code/${SESSION_ONE}\n`,
    ));

    await expect(pending).resolves.toEqual({
      sessionId: SESSION_ONE,
      sessionUrl: `https://claude.ai/code/${SESSION_ONE}`,
      reusedActiveSession: false,
    });
    expect(opened).toEqual([SESSION_ONE]);
    expect(calls).toEqual([{
      cwd: '/repo',
      command: [
        '/usr/local/bin/claude',
        'remote-control',
        '--spawn=session',
        '--name',
        'AgentsToZ · 개발 Mac · 프로젝트',
        '--permission-mode',
        'default',
      ],
    }]);
    await manager.shutdown();
  });

  test('coalesces concurrent presses and reopens one active session without spawning duplicates', async () => {
    const manager = new ClaudeRemoteConversationManager();
    const child = controlledProcess();
    let spawnCount = 0;
    const opened: string[] = [];
    const spawn: SpawnClaudeRemoteControl = () => {
      spawnCount += 1;
      return child.process;
    };
    const input = launchInput({ spawn, openSession: sessionId => opened.push(sessionId) });
    const first = manager.startAndOpen(input);
    const second = manager.startAndOpen(input);
    expect(second).toBe(first);
    await child.stderrWriter.write(new TextEncoder().encode(`\u001b[1Ahttps://claude.ai/code/${SESSION_ONE}\r\n`));
    await Promise.all([first, second]);

    await expect(manager.startAndOpen(input)).resolves.toMatchObject({
      sessionId: SESSION_ONE,
      reusedActiveSession: true,
    });
    expect(spawnCount).toBe(1);
    expect(opened).toEqual([SESSION_ONE, SESSION_ONE]);
    await manager.shutdown();
  });

  test('surfaces app-open failure and retries the same live session', async () => {
    const manager = new ClaudeRemoteConversationManager();
    const child = controlledProcess();
    let spawnCount = 0;
    let failOpen = true;
    const input = launchInput({
      spawn: () => { spawnCount += 1; return child.process; },
      openSession: () => {
        if (failOpen) throw new Error('Claude URL handler unavailable');
      },
    });
    const first = manager.startAndOpen(input);
    await child.stdoutWriter.write(new TextEncoder().encode(`https://claude.ai/code/${SESSION_ONE}\n`));
    await expect(first).rejects.toMatchObject({
      code: 'CLAUDE_REMOTE_SESSION_CREATED_OPEN_FAILED',
      message: expect.stringContaining('새 대화 없이 방금 대화를 다시 엽니다'),
    });

    failOpen = false;
    await expect(manager.startAndOpen(input)).resolves.toMatchObject({
      sessionId: SESSION_ONE,
      reusedActiveSession: true,
    });
    expect(spawnCount).toBe(1);
    await manager.shutdown();
  });

  test('fails closed on timeout and terminates the unfinished Claude process', async () => {
    const manager = new ClaudeRemoteConversationManager();
    const child = controlledProcess();
    await expect(manager.startAndOpen(launchInput({
      spawn: () => child.process,
      timeoutMs: 5,
    }))).rejects.toMatchObject({ code: 'CLAUDE_REMOTE_SESSION_TIMEOUT' });
    expect(child.kills).toEqual(['SIGTERM']);
  });

  test('never truncates an overlong session id into an accepted 128-byte prefix', async () => {
    const manager = new ClaudeRemoteConversationManager();
    const child = controlledProcess();
    const opened: string[] = [];
    const pending = manager.startAndOpen(launchInput({
      spawn: () => child.process,
      timeoutMs: 15,
      openSession: sessionId => opened.push(sessionId),
    }));
    const wouldBeAcceptedPrefix = `session_${'A'.repeat(128)}`;
    await child.stdoutWriter.write(new TextEncoder().encode(
      `https://claude.ai/code/${wouldBeAcceptedPrefix}`,
    ));
    await Bun.sleep(1);
    expect(opened).toEqual([]);
    await child.stdoutWriter.write(new TextEncoder().encode('A\n'));

    await expect(pending).rejects.toMatchObject({ code: 'CLAUDE_REMOTE_SESSION_TIMEOUT' });
    expect(opened).toEqual([]);
    expect(child.kills).toEqual(['SIGTERM']);
  });

  test('never assembles a session URL across stdout and stderr', async () => {
    const manager = new ClaudeRemoteConversationManager({ terminationGraceMs: 2 });
    const child = controlledProcess();
    const opened: string[] = [];
    const pending = manager.startAndOpen(launchInput({
      spawn: () => child.process,
      timeoutMs: 5,
      openSession: sessionId => opened.push(sessionId),
    }));
    const splitAt = SESSION_ONE.indexOf('Xvyy');
    await child.stdoutWriter.write(new TextEncoder().encode(
      `https://claude.ai/code/${SESSION_ONE.slice(0, splitAt)}`,
    ));
    await child.stderrWriter.write(new TextEncoder().encode(`${SESSION_ONE.slice(splitAt)}\n`));

    await expect(pending).rejects.toMatchObject({ code: 'CLAUDE_REMOTE_SESSION_TIMEOUT' });
    expect(opened).toEqual([]);
  });

  test('uses a fixed public error and releases ownership on nonzero exit before any URL', async () => {
    const manager = new ClaudeRemoteConversationManager();
    const child = controlledProcess();
    const privateDiagnostic = '/Users/private/project token=do-not-leak';
    const pending = manager.startAndOpen(launchInput({ spawn: () => child.process }));
    await child.stderrWriter.write(new TextEncoder().encode(`${privateDiagnostic}\n`));
    child.resolveExit(17);

    let failure: unknown;
    try {
      await pending;
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      code: 'CLAUDE_REMOTE_SESSION_START_FAILED',
      publicMessage: 'Claude Code 원격 대화를 시작하지 못했습니다. Claude Code 로그인과 프로젝트 신뢰 상태를 확인하세요.',
    });
    expect(String(failure)).not.toContain(privateDiagnostic);
    expect(String((failure as Error & { cause?: unknown }).cause)).toContain(privateDiagnostic);
    await manager.shutdown();
    expect(child.kills).toEqual([]);
  });

  test('escalates a TERM-ignoring process to SIGKILL after a bounded wait', async () => {
    const manager = new ClaudeRemoteConversationManager({ terminationGraceMs: 2 });
    const child = controlledProcess({ exitOnKill: ['SIGKILL'] });
    await expect(manager.startAndOpen(launchInput({
      spawn: () => child.process,
      timeoutMs: 2,
    }))).rejects.toMatchObject({ code: 'CLAUDE_REMOTE_SESSION_TIMEOUT' });
    expect(child.kills).toEqual(['SIGTERM', 'SIGKILL']);
  });

  test('does not release ownership when exit observation rejects', async () => {
    const manager = new ClaudeRemoteConversationManager({ terminationGraceMs: 2 });
    const child = controlledProcess({ pid: 43_210, exitOnKill: [] });
    const pending = manager.startAndOpen(launchInput({ spawn: () => child.process }));
    child.rejectExit(new Error('exit observation failed'));

    await expect(pending).rejects.toMatchObject({
      code: 'CLAUDE_REMOTE_SESSION_START_FAILED',
      publicMessage: 'Claude Code 원격 대화 프로세스 상태를 확인하지 못했습니다.',
    });
    expect(child.kills).toEqual(['SIGTERM', 'SIGKILL']);
    await expect(manager.startAndOpen(launchInput({
      projectKey: '/must-not-replace-unconfirmed-writer',
      spawn: () => controlledProcess().process,
    }))).rejects.toMatchObject({
      code: 'CLAUDE_REMOTE_SESSION_START_FAILED',
      publicMessage: 'Claude Code 원격 대화를 시작하지 못했습니다. AgentsToZ 앱이 종료 중입니다.',
    });
    await expect(manager.shutdown()).rejects.toThrow('shutdown was not confirmed');
    const beforeForce = child.kills.length;
    manager.forceKillNow();
    expect(child.kills.slice(beforeForce)).toEqual(['SIGKILL']);
  });

  test('fences later starts when timeout cleanup cannot prove process exit', async () => {
    const manager = new ClaudeRemoteConversationManager({ terminationGraceMs: 2 });
    const child = controlledProcess({ pid: 43_210, exitOnKill: [] });
    await expect(manager.startAndOpen(launchInput({
      spawn: () => child.process,
      timeoutMs: 2,
    }))).rejects.toMatchObject({ code: 'CLAUDE_REMOTE_SESSION_TIMEOUT' });
    expect(child.kills).toEqual(['SIGTERM', 'SIGKILL']);
    await expect(manager.startAndOpen(launchInput({
      projectKey: '/must-not-overlap-timeout-writer',
      spawn: () => controlledProcess().process,
    }))).rejects.toMatchObject({
      publicMessage: 'Claude Code 원격 대화를 시작하지 못했습니다. AgentsToZ 앱이 종료 중입니다.',
    });
    manager.forceKillNow();
  });

  test('uses the supplied process-tree terminator for an owned Claude session', async () => {
    const terminatedPids: number[] = [];
    const child = controlledProcess({ pid: 43_210, exitOnKill: [] });
    const manager = new ClaudeRemoteConversationManager({
      terminationGraceMs: 2,
      terminateProcessTree: async pid => {
        terminatedPids.push(pid);
        child.resolveExit(143);
      },
    });
    const pending = manager.startAndOpen(launchInput({ spawn: () => child.process }));
    await child.stdoutWriter.write(new TextEncoder().encode(`https://claude.ai/code/${SESSION_ONE}\n`));
    await pending;

    await manager.shutdown();
    expect(terminatedPids).toEqual([43_210]);
    expect(child.kills).toEqual([]);
  });

  test('rejects a concurrent new start as soon as shutdown takes its owned-process snapshot', async () => {
    const manager = new ClaudeRemoteConversationManager({ terminationGraceMs: 5 });
    const child = controlledProcess({ exitOnKill: ['SIGKILL'] });
    let spawnCount = 0;
    const active = manager.startAndOpen(launchInput({
      spawn: () => {
        spawnCount += 1;
        return child.process;
      },
    }));
    await child.stdoutWriter.write(new TextEncoder().encode(`https://claude.ai/code/${SESSION_ONE}\n`));
    await active;

    const shutdown = manager.shutdown();
    await expect(manager.startAndOpen(launchInput({
      projectKey: '/must-not-spawn',
      spawn: () => {
        spawnCount += 1;
        return controlledProcess().process;
      },
    }))).rejects.toMatchObject({
      code: 'CLAUDE_REMOTE_SESSION_START_FAILED',
      publicMessage: 'Claude Code 원격 대화를 시작하지 못했습니다. AgentsToZ 앱이 종료 중입니다.',
    });
    await shutdown;
    expect(spawnCount).toBe(1);
    expect(child.kills).toEqual(['SIGTERM', 'SIGKILL']);
  });

  test('does not open a late session URL emitted while shutdown is terminating the inflight child', async () => {
    const manager = new ClaudeRemoteConversationManager({ terminationGraceMs: 5 });
    const child = controlledProcess({ exitOnKill: ['SIGKILL'] });
    const opened: string[] = [];
    const pending = manager.startAndOpen(launchInput({
      spawn: () => child.process,
      openSession: sessionId => opened.push(sessionId),
    }));

    const shutdown = manager.shutdown();
    expect(child.kills).toEqual(['SIGTERM']);
    await child.stdoutWriter.write(new TextEncoder().encode(`https://claude.ai/code/${SESSION_ONE}\n`));

    await expect(pending).rejects.toMatchObject({
      code: 'CLAUDE_REMOTE_SESSION_START_FAILED',
      publicMessage: 'Claude Code 원격 대화를 시작하지 못했습니다. AgentsToZ 앱이 종료 중입니다.',
    });
    await shutdown;
    expect(opened).toEqual([]);
    expect(child.kills).toEqual(['SIGTERM', 'SIGKILL']);
  });

  test('terminates every owned live session when the local API shuts down', async () => {
    const manager = new ClaudeRemoteConversationManager();
    const first = controlledProcess();
    const second = controlledProcess();
    const firstPending = manager.startAndOpen(launchInput({
      projectKey: '/repo-one',
      folderPath: '/repo-one',
      spawn: () => first.process,
    }));
    const secondPending = manager.startAndOpen(launchInput({
      projectKey: '/repo-two',
      folderPath: '/repo-two',
      spawn: () => second.process,
    }));
    await first.stdoutWriter.write(new TextEncoder().encode(`https://claude.ai/code/${SESSION_ONE}\n`));
    const sessionTwo = 'session_01KgGmCfnbmXvyy8y3Am5hPs';
    await second.stdoutWriter.write(new TextEncoder().encode(`https://claude.ai/code/${sessionTwo}\n`));
    await Promise.all([firstPending, secondPending]);

    await manager.shutdown();
    expect(first.kills).toEqual(['SIGTERM']);
    expect(second.kills).toEqual(['SIGTERM']);
  });

  test('holds one workspace lease across inflight and active-session reuse until confirmed shutdown', async () => {
    const child = controlledProcess();
    const events: string[] = [];
    let acquisitions = 0;
    const manager = new ClaudeRemoteConversationManager({
      acquireWorkspaceLease: input => {
        acquisitions += 1;
        events.push(`acquire:${input.projectKey}:${input.folderPath}`);
        return {
          release() {
            events.push('release');
            return true;
          },
        };
      },
    });
    const input = launchInput({
      spawn: () => {
        events.push('spawn');
        return child.process;
      },
    });

    const first = manager.startAndOpen(input);
    const coalesced = manager.startAndOpen(input);
    expect(coalesced).toBe(first);
    await Bun.sleep(0);
    await child.stdoutWriter.write(new TextEncoder().encode(`https://claude.ai/code/${SESSION_ONE}\n`));
    await Promise.all([first, coalesced]);
    await expect(manager.startAndOpen(input)).resolves.toMatchObject({
      reusedActiveSession: true,
    });

    expect(acquisitions).toBe(1);
    expect(events).toEqual(['acquire:/repo:/repo', 'spawn']);
    await manager.shutdown();
    expect(events).toEqual(['acquire:/repo:/repo', 'spawn', 'release']);
  });

  test('returns a typed busy error without spawning when the workspace lease is occupied', async () => {
    let spawnCount = 0;
    const manager = new ClaudeRemoteConversationManager({
      acquireWorkspaceLease: () => null,
    });

    await expect(manager.startAndOpen(launchInput({
      spawn: () => {
        spawnCount += 1;
        return controlledProcess().process;
      },
    }))).rejects.toMatchObject({
      code: 'CLAUDE_REMOTE_SESSION_WORKSPACE_BUSY',
      publicMessage: '이 프로젝트에서는 이미 다른 에이전트 작업이 실행 중입니다.',
    });
    expect(spawnCount).toBe(0);
    await manager.shutdown();
  });

  test('hides private coordinator failures behind a fixed public workspace error', async () => {
    const privateDiagnostic = '/Users/private/repository lease-token=do-not-leak';
    const manager = new ClaudeRemoteConversationManager({
      acquireWorkspaceLease: () => {
        throw new Error(privateDiagnostic);
      },
    });

    let failure: unknown;
    try {
      await manager.startAndOpen(launchInput());
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      code: 'CLAUDE_REMOTE_SESSION_WORKSPACE_UNKNOWN',
      publicMessage: '프로젝트 작업 잠금 상태를 안전하게 확인하지 못했습니다.',
    });
    expect(String(failure)).not.toContain(privateDiagnostic);
    expect(String((failure as Error & { cause?: unknown }).cause)).toContain(privateDiagnostic);
    await manager.shutdown();
  });

  test('releases a newly acquired lease when spawning Claude fails', async () => {
    let releases = 0;
    const manager = new ClaudeRemoteConversationManager({
      acquireWorkspaceLease: () => ({
        release() {
          releases += 1;
          return true;
        },
      }),
    });

    await expect(manager.startAndOpen(launchInput({
      spawn: () => {
        throw new Error('spawn unavailable');
      },
    }))).rejects.toMatchObject({ code: 'CLAUDE_REMOTE_SESSION_START_FAILED' });
    expect(releases).toBe(1);
    await manager.shutdown();
  });

  test('releases the workspace lease after startup timeout confirms process termination', async () => {
    const child = controlledProcess();
    let releases = 0;
    const manager = new ClaudeRemoteConversationManager({
      acquireWorkspaceLease: () => ({
        release() {
          releases += 1;
          return true;
        },
      }),
    });

    await expect(manager.startAndOpen(launchInput({
      spawn: () => child.process,
      timeoutMs: 5,
    }))).rejects.toMatchObject({ code: 'CLAUDE_REMOTE_SESSION_TIMEOUT' });
    expect(child.kills).toEqual(['SIGTERM']);
    expect(releases).toBe(1);
    await manager.shutdown();
  });

  test('waits for exact lease release after an early observed process exit', async () => {
    let resolveRelease!: (released: boolean) => void;
    const releaseResult = new Promise<boolean>(resolve => { resolveRelease = resolve; });
    let releaseCalls = 0;
    const child = controlledProcess();
    const manager = new ClaudeRemoteConversationManager({
      acquireWorkspaceLease: () => ({
        release() {
          releaseCalls += 1;
          return releaseResult;
        },
      }),
    });
    let startSettled = false;
    const pending = manager.startAndOpen(launchInput({ spawn: () => child.process }));
    void pending.finally(() => { startSettled = true; }).catch(() => undefined);
    await Bun.sleep(0);
    child.resolveExit(17);
    await Bun.sleep(0);

    expect(releaseCalls).toBe(1);
    expect(startSettled).toBe(false);
    resolveRelease(true);
    await expect(pending).rejects.toMatchObject({ code: 'CLAUDE_REMOTE_SESSION_START_FAILED' });
    expect(startSettled).toBe(true);
    await manager.shutdown();
  });

  test('cleans up a lease that arrives after acquisition timeout without ever spawning', async () => {
    let resolveAcquisition!: (lease: { release(): boolean }) => void;
    const acquisition = new Promise<{ release(): boolean }>(resolve => {
      resolveAcquisition = resolve;
    });
    let releases = 0;
    let spawnCount = 0;
    const manager = new ClaudeRemoteConversationManager({
      acquireWorkspaceLease: () => acquisition,
      leaseOperationTimeoutMs: 50,
    });

    await expect(manager.startAndOpen(launchInput({
      timeoutMs: 2,
      spawn: () => {
        spawnCount += 1;
        return controlledProcess().process;
      },
    }))).rejects.toMatchObject({ code: 'CLAUDE_REMOTE_SESSION_TIMEOUT' });
    const shutdown = manager.shutdown();
    resolveAcquisition({
      release() {
        releases += 1;
        return true;
      },
    });

    await shutdown;
    expect(spawnCount).toBe(0);
    expect(releases).toBe(1);
  });

  for (const releaseBehavior of ['false', 'throw'] as const) {
    test(`fails closed when workspace lease release returns ${releaseBehavior}`, async () => {
      const child = controlledProcess();
      let acquisitions = 0;
      let releases = 0;
      const manager = new ClaudeRemoteConversationManager({
        acquireWorkspaceLease: () => {
          acquisitions += 1;
          return {
            release() {
              releases += 1;
              if (releaseBehavior === 'throw') throw new Error('private release failure');
              return false;
            },
          };
        },
      });
      const pending = manager.startAndOpen(launchInput({ spawn: () => child.process }));
      await Bun.sleep(0);
      await child.stdoutWriter.write(new TextEncoder().encode(`https://claude.ai/code/${SESSION_ONE}\n`));
      await pending;

      await expect(manager.shutdown()).rejects.toThrow('shutdown was not confirmed');
      await expect(manager.startAndOpen(launchInput({
        projectKey: '/must-not-start-after-release-failure',
        spawn: () => controlledProcess().process,
      }))).rejects.toMatchObject({
        code: 'CLAUDE_REMOTE_SESSION_START_FAILED',
        publicMessage: 'Claude Code 원격 대화를 시작하지 못했습니다. AgentsToZ 앱이 종료 중입니다.',
      });
      expect(acquisitions).toBe(1);
      expect(releases).toBe(1);
    });
  }
});
