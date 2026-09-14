import { afterEach, describe, expect, test } from 'bun:test';
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  APPLE_CONTAINER_RUNNER_MAX_ENV_VALUE_BYTES,
  APPLE_CONTAINER_RUNNER_MAX_TIMEOUT_MS,
  AppleContainerCommandRunnerError,
  createAppleContainerCommandRunner,
  type AppleContainerCommandRunner,
  type AppleContainerCommandRunnerErrorCode,
  type AppleContainerCommandRunnerOptions,
} from '../src/appleContainerCommandRunner';
import {
  APPLE_CONTAINER_EXECUTABLE,
  planAppleContainerCleanup,
  planAppleContainerCreate,
  planAppleContainerInspect,
  planAppleContainerListAll,
  planAppleContainerStart,
  type AppleContainerCommandPlan,
} from '../src/appleContainerCommandPlan';

const TASK = Object.freeze({
  taskId: 'task_runner_12345678',
  nonce: 'a1'.repeat(32),
});
const CREATE_INPUT = Object.freeze({
  ...TASK,
  privateStagingRoot: '/private/var/agentstoz/tasks',
  stagingPath: '/private/var/agentstoz/tasks/task-one/staging',
  image: `ghcr.io/agentstoz/codex-runtime@sha256:${'b2'.repeat(32)}`,
});
const SAFE_ENVIRONMENT = Object.freeze({
  PATH: '/attacker/bin',
  LANG: 'attacker_LOCALE',
  LC_ALL: 'attacker_LOCALE',
  HOME: '/private/test-user',
  USER: 'test-user',
  LOGNAME: 'test-user',
  TMPDIR: '/private/test-tmp',
  SSH_AUTH_SOCK: '/private/secret-agent.sock',
  HTTP_PROXY: 'http://proxy.invalid',
  AWS_SECRET_ACCESS_KEY: 'must-not-be-inherited',
  NODE_OPTIONS: '--require=/private/evil.js',
});

const temporaryDirectories: string[] = [];
const potentiallyLiveProcessGroups = new Set<number>();

afterEach(() => {
  for (const pid of potentiallyLiveProcessGroups) {
    try { process.kill(-pid, 'SIGKILL'); } catch { /* already absent */ }
    try { process.kill(pid, 'SIGKILL'); } catch { /* already absent */ }
  }
  potentiallyLiveProcessGroups.clear();
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw cause;
  }
}

function options(
  timeoutMs = 5_000,
  maxOutputBytes = 256 * 1024,
  env: Readonly<Record<string, string>> = SAFE_ENVIRONMENT,
): AppleContainerCommandRunnerOptions {
  return { timeoutMs, maxOutputBytes, env };
}

interface SpawnCapture {
  readonly requestedExecutable: string;
  readonly requestedArgv: readonly string[];
  readonly options: SpawnOptions;
  readonly fixturePid: number | undefined;
}

function fixtureRunner(
  source: string,
  captures: SpawnCapture[] = [],
): AppleContainerCommandRunner {
  return createAppleContainerCommandRunner({
    platform: 'darwin',
    spawn(requestedExecutable, requestedArgv, spawnOptions): ChildProcess {
      const child = nodeSpawn(
        process.execPath,
        ['--no-env-file', '-e', source],
        spawnOptions,
      );
      captures.push({
        requestedExecutable,
        requestedArgv: Object.freeze([...requestedArgv]),
        options: spawnOptions,
        fixturePid: child.pid,
      });
      if (child.pid !== undefined) potentiallyLiveProcessGroups.add(child.pid);
      return child;
    },
  });
}

async function runPlan(
  runner: AppleContainerCommandRunner,
  plan: Readonly<AppleContainerCommandPlan> = planAppleContainerListAll(),
  runnerOptions: AppleContainerCommandRunnerOptions = options(),
) {
  return runner(plan.executable, plan.argv, runnerOptions);
}

async function expectRunnerError(
  operation: Promise<unknown>,
  code: AppleContainerCommandRunnerErrorCode,
  privateValues: readonly string[] = [],
): Promise<void> {
  try {
    await operation;
    throw new Error(`expected ${code}`);
  } catch (cause) {
    expect(cause).toBeInstanceOf(AppleContainerCommandRunnerError);
    expect((cause as AppleContainerCommandRunnerError).code).toBe(code);
    expect(String(cause)).toBe(`AppleContainerCommandRunnerError: ${code}`);
    for (const privateValue of privateValues) expect(String(cause)).not.toContain(privateValue);
  }
}

describe('Apple Container bounded command runner', () => {
  test('uses argv-only execution, drains both pipes, and rebuilds a minimal environment', async () => {
    const stdoutPayload = `${'O'.repeat(48 * 1024)}|stdout`;
    const stderrPayload = `${'E'.repeat(48 * 1024)}|stderr`;
    const source = `
      const write = (stream, value) => new Promise((resolve, reject) => {
        stream.write(value, error => error ? reject(error) : resolve());
      });
      Promise.all([
        write(process.stdout, ${JSON.stringify(stdoutPayload)}),
        write(process.stderr, ${JSON.stringify(stderrPayload)}),
      ]).then(() => { process.exitCode = 23; });
    `;
    const captures: SpawnCapture[] = [];
    const result = await runPlan(fixtureRunner(source, captures));

    expect(result).toEqual({
      exitCode: 23,
      stdout: stdoutPayload,
      stderr: stderrPayload,
      timedOut: false,
      outputTruncated: false,
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(captures).toHaveLength(1);
    const capture = captures[0]!;
    expect(capture.requestedExecutable).toBe(APPLE_CONTAINER_EXECUTABLE);
    expect(capture.requestedArgv).toEqual(['list', '--all', '--format', 'json']);
    expect(capture.options.cwd).toBe('/');
    expect(capture.options.detached).toBe(true);
    expect(capture.options.shell).toBe(false);
    expect(capture.options.stdio).toEqual(['ignore', 'pipe', 'pipe']);
    expect(capture.options.env).toEqual({
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin',
      LANG: 'C',
      LC_ALL: 'C',
      HOME: '/private/test-user',
      USER: 'test-user',
      LOGNAME: 'test-user',
      TMPDIR: '/private/test-tmp',
    });
    expect((capture.options.env as NodeJS.ProcessEnv).SSH_AUTH_SOCK).toBeUndefined();
    expect((capture.options.env as NodeJS.ProcessEnv).HTTP_PROXY).toBeUndefined();
    expect((capture.options.env as NodeJS.ProcessEnv).AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect((capture.options.env as NodeJS.ProcessEnv).NODE_OPTIONS).toBeUndefined();
    expect(capture.fixturePid).toBeNumber();
    expect(pidIsAlive(capture.fixturePid!)).toBe(false);
  });

  test.skipIf(process.platform === 'win32')(
    'times out, TERM-escalates, and confirms both leader and descendant are gone',
    async () => {
      const directory = mkdtempSync(join(tmpdir(), 'agentstoz-container-runner-timeout-'));
      temporaryDirectories.push(directory);
      const statePath = join(directory, 'pids.json');
      const termPath = join(directory, 'term.log');
      const grandchildSource = `
        const fs = require('node:fs');
        process.on('SIGTERM', () => fs.appendFileSync(${JSON.stringify(termPath)}, 'grandchild\\n'));
        setInterval(() => undefined, 1000);
      `;
      const leaderSource = `
        const fs = require('node:fs');
        const { spawn } = require('node:child_process');
        process.on('SIGTERM', () => fs.appendFileSync(${JSON.stringify(termPath)}, 'leader\\n'));
        const grandchild = spawn(process.execPath, ['--no-env-file', '-e', ${JSON.stringify(grandchildSource)}], {
          stdio: 'ignore',
        });
        fs.writeFileSync(${JSON.stringify(statePath)}, JSON.stringify({
          leader: process.pid,
          grandchild: grandchild.pid,
        }));
        setInterval(() => undefined, 1000);
      `;
      const startedAt = Date.now();
      const result = await runPlan(fixtureRunner(leaderSource), undefined, options(300, 8 * 1024));

      expect(result.exitCode).toBeNull();
      expect(result.timedOut).toBe(true);
      expect(result.outputTruncated).toBe(false);
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(700);
      expect(existsSync(statePath)).toBe(true);
      const pids = JSON.parse(readFileSync(statePath, 'utf8')) as {
        leader: number;
        grandchild: number;
      };
      expect(readFileSync(termPath, 'utf8')).toContain('leader');
      expect(readFileSync(termPath, 'utf8')).toContain('grandchild');
      expect(pidIsAlive(pids.leader)).toBe(false);
      expect(pidIsAlive(pids.grandchild)).toBe(false);
    },
  );

  test.skipIf(process.platform === 'win32')(
    'reaps a descendant left by a normally exited leader while preserving the leader exit code',
    async () => {
      const directory = mkdtempSync(join(tmpdir(), 'agentstoz-container-runner-normal-tree-'));
      temporaryDirectories.push(directory);
      const statePath = join(directory, 'pids.json');
      const readyPath = join(directory, 'grandchild.ready');
      const termPath = join(directory, 'term.log');
      const grandchildSource = `
        const fs = require('node:fs');
        process.on('SIGTERM', () => fs.appendFileSync(${JSON.stringify(termPath)}, 'grandchild\\n'));
        fs.writeFileSync(${JSON.stringify(readyPath)}, String(process.pid));
        setInterval(() => undefined, 1000);
      `;
      const leaderSource = `
        const fs = require('node:fs');
        const { spawn } = require('node:child_process');
        const grandchild = spawn(process.execPath, ['--no-env-file', '-e', ${JSON.stringify(grandchildSource)}], {
          stdio: 'ignore',
        });
        const wait = setInterval(() => {
          if (!fs.existsSync(${JSON.stringify(readyPath)})) return;
          clearInterval(wait);
          fs.writeFileSync(${JSON.stringify(statePath)}, JSON.stringify({
            leader: process.pid,
            grandchild: grandchild.pid,
          }));
          process.stdout.write('leader-finished', () => process.exit(17));
        }, 10);
      `;
      const result = await runPlan(fixtureRunner(leaderSource));
      const pids = JSON.parse(readFileSync(statePath, 'utf8')) as {
        leader: number;
        grandchild: number;
      };

      expect(result).toEqual({
        exitCode: 17,
        stdout: 'leader-finished',
        stderr: '',
        timedOut: false,
        outputTruncated: false,
      });
      expect(readFileSync(termPath, 'utf8')).toContain('grandchild');
      expect(pidIsAlive(pids.leader)).toBe(false);
      expect(pidIsAlive(pids.grandchild)).toBe(false);
    },
  );

  test.skipIf(process.platform === 'win32')(
    'cuts off combined output, terminates the producer, and reports an explicit truncated result',
    async () => {
      const captures: SpawnCapture[] = [];
      const source = `
        process.on('SIGTERM', () => undefined);
        process.stdout.write('O'.repeat(128 * 1024));
        process.stderr.write('E'.repeat(128 * 1024));
        setInterval(() => undefined, 1000);
      `;
      const result = await runPlan(
        fixtureRunner(source, captures),
        undefined,
        options(5_000, 1_024),
      );

      expect(result.exitCode).toBeNull();
      expect(result.timedOut).toBe(false);
      expect(result.outputTruncated).toBe(true);
      expect(Buffer.byteLength(result.stdout, 'utf8')).toBeLessThanOrEqual(1_024);
      expect(Buffer.byteLength(result.stderr, 'utf8')).toBeLessThanOrEqual(1_024);
      expect(Buffer.byteLength(result.stdout, 'utf8') + Buffer.byteLength(result.stderr, 'utf8'))
        .toBeLessThanOrEqual(1_024);
      expect(pidIsAlive(captures[0]!.fixturePid!)).toBe(false);
    },
  );

  test('fails closed on invalid UTF-8 without returning replacement characters', async () => {
    const result = await runPlan(fixtureRunner(`
      process.stdout.write(Buffer.from([0x76, 0x61, 0x6c, 0x69, 0x64, 0xff]));
    `));

    expect(result.exitCode).toBeNull();
    expect(result.timedOut).toBe(false);
    expect(result.outputTruncated).toBe(true);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
    expect(JSON.stringify(result)).not.toContain('\ufffd');
  });

  test('turns an asynchronous spawn failure into a stable empty result', async () => {
    const runner = createAppleContainerCommandRunner({
      platform: 'darwin',
      spawn(_requestedExecutable, _requestedArgv, spawnOptions) {
        return nodeSpawn('/definitely/not/an/agentstoz/executable', [], spawnOptions);
      },
    });

    const result = await runPlan(runner);
    expect(result).toEqual({
      exitCode: null,
      stdout: '',
      stderr: '',
      timedOut: false,
      outputTruncated: false,
    });
    expect(JSON.stringify(result)).not.toContain('/definitely');
  });

  test('accepts every current planner command shape without invoking Apple Container in tests', async () => {
    const captures: SpawnCapture[] = [];
    const runner = fixtureRunner('process.exitCode = 0;', captures);
    const plans = [
      planAppleContainerCreate(CREATE_INPUT),
      planAppleContainerStart(TASK),
      planAppleContainerInspect(TASK),
      ...planAppleContainerCleanup({ ...TASK, stopTimeoutSeconds: 7 }),
      planAppleContainerListAll(),
    ];

    for (const plan of plans) {
      expect(await runPlan(runner, plan, options(plan.timeoutMs, plan.maxOutputBytes))).toEqual({
        exitCode: 0,
        stdout: '',
        stderr: '',
        timedOut: false,
        outputTruncated: false,
      });
    }
    expect(captures).toHaveLength(plans.length);
    expect(captures.every(call => call.requestedExecutable === APPLE_CONTAINER_EXECUTABLE)).toBe(true);
    expect(captures.every(call => call.fixturePid !== undefined && !pidIsAlive(call.fixturePid))).toBe(true);
  });

  test('rejects non-planner commands, unsafe bounds, hostile optional env, and non-macOS use', async () => {
    const runner = fixtureRunner('process.exitCode = 0;');
    const plan = planAppleContainerListAll();
    const forbiddenRunArgv = [
      'run',
      '--detach',
      ...planAppleContainerCreate(CREATE_INPUT).argv.slice(1),
    ];
    const secretPath = '/private/very-secret-command';
    const hostileHome = `${secretPath}\nINJECTED=1`;
    const cases: Array<{ operation: Promise<unknown>; privateValues?: readonly string[] }> = [
      {
        operation: runner(
          secretPath as typeof APPLE_CONTAINER_EXECUTABLE,
          plan.argv,
          options(),
        ),
        privateValues: [secretPath],
      },
      {
        operation: runner(
          APPLE_CONTAINER_EXECUTABLE,
          ['system', 'reset'],
          options(),
        ),
        privateValues: ['system', 'reset'],
      },
      {
        operation: runner(
          APPLE_CONTAINER_EXECUTABLE,
          forbiddenRunArgv,
          options(),
        ),
      },
      {
        operation: runner(
          plan.executable,
          plan.argv,
          options(APPLE_CONTAINER_RUNNER_MAX_TIMEOUT_MS + 1),
        ),
      },
      {
        operation: runner(
          plan.executable,
          plan.argv,
          options(5_000, 0),
        ),
      },
      {
        operation: runner(
          plan.executable,
          plan.argv,
          options(5_000, 1024, { HOME: hostileHome }),
        ),
        privateValues: [secretPath, hostileHome],
      },
      {
        operation: runner(
          plan.executable,
          plan.argv,
          options(5_000, 1024, { HOME: 'x'.repeat(APPLE_CONTAINER_RUNNER_MAX_ENV_VALUE_BYTES + 1) }),
        ),
      },
      {
        operation: createAppleContainerCommandRunner({ platform: 'linux' })(
          plan.executable,
          plan.argv,
          options(),
        ),
      },
    ];

    for (const item of cases) {
      await expectRunnerError(
        item.operation,
        'APPLE_CONTAINER_RUNNER_INVALID_INPUT',
        item.privateValues,
      );
    }
  });
});
