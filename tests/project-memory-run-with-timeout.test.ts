import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWithTimeout } from "../project-memory-server";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause: any) {
    if (cause?.code === "ESRCH") return false;
    throw cause;
  }
}

describe("project-memory bounded subprocess", () => {
  test('pre-cancelled execution never spawns; active cancellation reaps before releasing the save slot', async () => {
    const cancelled = new AbortController(); cancelled.abort(); let spawned = false;
    await expect(runWithTimeout(['unused'], process.cwd(), 5000, undefined, {
      signal: cancelled.signal, spawn: () => { spawned = true; throw new Error('must not spawn'); },
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(spawned).toBe(false);
    const directory = mkdtempSync(join(tmpdir(), 'memory-cancel-'));
    temporaryDirectories.push(directory);
    const pidPath = join(directory, 'pid'); const controller = new AbortController();
    const running = runWithTimeout([process.execPath, '--no-env-file', '-e',
      'await Bun.write(process.argv[1], String(process.pid)); process.on("SIGTERM",()=>{}); setInterval(()=>{},1000);', pidPath],
    directory, 10000, undefined, { signal: controller.signal }).catch(error => error);
    try {
      for (let i = 0; i < 200 && !existsSync(pidPath); i++) await Bun.sleep(10);
      expect(existsSync(pidPath)).toBe(true);
    } finally { controller.abort(); }
    expect(await running).toMatchObject({ name: 'AbortError' });
    expect(pidIsAlive(Number(readFileSync(pidPath, 'utf8')))).toBe(false);
  });

  test("output overflow stops and reaps the producer before rejecting", async () => {
    const directory = mkdtempSync(join(tmpdir(), "memory-output-limit-"));
    temporaryDirectories.push(directory);
    const pidPath = join(directory, "pid");
    const source = `await Bun.write(process.argv[1], String(process.pid)); process.stdout.write('x'.repeat(8192)); setInterval(() => {}, 1000);`;
    const start = Date.now();
    await expect(runWithTimeout([process.execPath,"--no-env-file","-e",source,pidPath],directory,10000,undefined,{maxOutputBytes:4096})).rejects.toThrow("크기 제한");
    expect(Date.now()-start).toBeLessThan(5000);
    expect(pidIsAlive(Number(readFileSync(pidPath,"utf8")))).toBe(false);
  });

  test(
    "drains both output pipes and preserves stdin and a normal nonzero exit",
    async () => {
      const payload = "memory-input";
      const source = `
        const input = await Bun.stdin.text();
        const write = (stream, value) => new Promise((resolve, reject) => {
          stream.write(value, error => error ? reject(error) : resolve());
        });
        await write(process.stdout, "O".repeat(256 * 1024) + "|" + input);
        await write(process.stderr, "E".repeat(256 * 1024));
        process.exitCode = 23;
      `;
      const result = await runWithTimeout(
        [process.execPath, "--no-env-file", "-e", source],
        process.cwd(),
        5_000,
        payload,
      );

      expect(result.exitCode).toBe(23);
      expect(result.stdout.length).toBe((256 * 1024) + 1 + payload.length);
      expect(result.stdout.endsWith(`|${payload}`)).toBe(true);
      expect(result.stderr).toBe("E".repeat(256 * 1024));
    },
  );

  test.skipIf(process.platform === "win32")(
    "reaps a helper left behind by a normally exited leader without losing its exit code",
    async () => {
      const directory = mkdtempSync(join(tmpdir(), "agentstoz-memory-normal-tree-"));
      temporaryDirectories.push(directory);
      const statePath = join(directory, "pids.json");
      const termPath = join(directory, "term.log");
      const fixture = join(import.meta.dir, "fixtures", "project-memory-timeout-tree.ts");

      const result = await runWithTimeout(
        [process.execPath, "--no-env-file", fixture, "--leader-exits", statePath, termPath],
        process.cwd(),
        5_000,
      );
      const pids = JSON.parse(readFileSync(statePath, "utf8")) as {
        leader: number;
        grandchild: number;
      };

      expect(result).toEqual({ exitCode: 17, stdout: "leader-finished", stderr: "" });
      expect(pidIsAlive(pids.leader)).toBe(false);
      expect(pidIsAlive(pids.grandchild)).toBe(false);
    },
  );

  test.skipIf(process.platform === "win32")(
    "TERM-escalates to KILL and waits until the entire process group is gone",
    async () => {
      const directory = mkdtempSync(join(tmpdir(), "agentstoz-memory-timeout-"));
      temporaryDirectories.push(directory);
      const statePath = join(directory, "pids.json");
      const termPath = join(directory, "term.log");
      const fixture = join(import.meta.dir, "fixtures", "project-memory-timeout-tree.ts");

      const startedAt = Date.now();
      await expect(runWithTimeout(
        [process.execPath, "--no-env-file", fixture, "--leader", statePath, termPath],
        process.cwd(),
        150,
      )).rejects.toThrow("AI 기억 업데이트가");
      const elapsedMs = Date.now() - startedAt;

      expect(existsSync(statePath)).toBe(true);
      const pids = JSON.parse(readFileSync(statePath, "utf8")) as {
        leader: number;
        grandchild: number;
      };
      expect(readFileSync(termPath, "utf8")).toContain(`leader:${pids.leader}`);
      expect(readFileSync(termPath, "utf8")).toContain(`grandchild:${pids.grandchild}`);
      expect(elapsedMs).toBeGreaterThanOrEqual(700);
      expect(pidIsAlive(pids.leader)).toBe(false);
      expect(pidIsAlive(pids.grandchild)).toBe(false);
    },
  );

  test.skipIf(process.platform === "win32")(
    "contains and reaps the child before propagating an exited-waiter rejection",
    async () => {
      const expected = new Error("synthetic exited waiter failure");
      let realProcess: ReturnType<typeof Bun.spawn> | null = null;
      let caught: unknown;
      try {
        await runWithTimeout(
          [process.execPath, "--no-env-file", "-e", "setInterval(() => undefined, 1000)"],
          process.cwd(),
          5_000,
          undefined,
          {
            spawn(command, options) {
              const real = Bun.spawn(command, options);
              realProcess = real;
              return {
                pid: real.pid,
                get exitCode() { return real.exitCode; },
                get signalCode() { return real.signalCode; },
                exited: Promise.reject(expected),
                stdin: real.stdin,
                stdout: real.stdout,
                stderr: real.stderr,
                kill: real.kill.bind(real),
              } as any;
            },
          },
        );
      } catch (cause) {
        caught = cause;
      }

      expect(caught).toBe(expected);
      expect(realProcess).not.toBeNull();
      expect(pidIsAlive(realProcess!.pid)).toBe(false);
    },
  );

  test("preserves Windows execution and waits for direct-child exit before timeout rejection", async () => {
    let exitCode: number | null = null;
    let signalCode: NodeJS.Signals | null = null;
    let resolveExit!: (code: number) => void;
    const exited = new Promise<number>(resolve => { resolveExit = resolve; });
    const signals: Array<number | NodeJS.Signals | undefined> = [];
    const startedAt = Date.now();

    await expect(runWithTimeout(
      ["synthetic-memory-command"],
      process.cwd(),
      0,
      undefined,
      {
        platform: "win32",
        spawn: () => ({
          pid: 4_242,
          get exitCode() { return exitCode; },
          get signalCode() { return signalCode; },
          exited,
          stdout: new Response("partial stdout").body!,
          stderr: new Response("partial stderr").body!,
          kill(signal) {
            signals.push(signal);
            setTimeout(() => {
              signalCode = "SIGKILL";
              resolveExit(137);
            }, 25);
          },
        }),
      },
    )).rejects.toThrow("AI 기억 업데이트가");

    expect(signals).toEqual(["SIGKILL"]);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(20);
    expect(exitCode).toBeNull();
  });
});
