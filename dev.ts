#!/usr/bin/env bun

import { partitionDevListeners } from "./src/devListenerOwnership";

const POSIX_API_GROUP_TERM_GRACE_MS = 250;
const POSIX_API_GROUP_CONFIRM_MS = 2_000;
const API_GRACEFUL_SHUTDOWN_MS = 27_000;

function posixProcessGroupAlive(processGroupId: number): boolean {
  if (!Number.isSafeInteger(processGroupId) || processGroupId <= 1) {
    throw new Error("DEV_API_PROCESS_GROUP_ID_UNSAFE");
  }
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error: any) {
    if (error?.code === "ESRCH") return false;
    // EPERM proves that the group still exists. Any other probe failure is not
    // authority to start a replacement writer either, so fail closed.
    if (error?.code === "EPERM") return true;
    throw new Error("DEV_API_PROCESS_GROUP_PROBE_FAILED", { cause: error });
  }
}

async function waitForPosixProcessGroupExit(
  processGroupId: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    if (!posixProcessGroupAlive(processGroupId)) return true;
    if (Date.now() >= deadline) return false;
    await Bun.sleep(Math.min(25, Math.max(1, deadline - Date.now())));
  }
}

/**
 * Reap every ordinary descendant of one source API sidecar. The API is
 * launched as this process-group leader below. A replacement sidecar is never
 * spawned until the negative PGID probe returns ESRCH.
 */
export async function terminatePosixApiProcessGroup(
  processGroupId: number,
  options: { termGraceMs?: number; confirmMs?: number } = {},
): Promise<void> {
  if (process.platform === "win32") {
    throw new Error("DEV_API_PROCESS_GROUP_UNAVAILABLE_ON_WINDOWS");
  }
  if (!posixProcessGroupAlive(processGroupId)) return;
  try {
    process.kill(-processGroupId, "SIGTERM");
  } catch (error: any) {
    if (error?.code !== "ESRCH") {
      throw new Error("DEV_API_PROCESS_GROUP_TERM_FAILED", { cause: error });
    }
    return;
  }
  if (await waitForPosixProcessGroupExit(
    processGroupId,
    options.termGraceMs ?? POSIX_API_GROUP_TERM_GRACE_MS,
  )) return;

  try {
    process.kill(-processGroupId, "SIGKILL");
  } catch (error: any) {
    if (error?.code !== "ESRCH") {
      throw new Error("DEV_API_PROCESS_GROUP_KILL_FAILED", { cause: error });
    }
    return;
  }
  if (!await waitForPosixProcessGroupExit(
    processGroupId,
    options.confirmMs ?? POSIX_API_GROUP_CONFIRM_MS,
  )) {
    throw new Error("DEV_API_PROCESS_GROUP_TERMINATION_UNCONFIRMED");
  }
}

/**
 * 개발 서버 러너 — api-server(3001) + vite(9000)를 자식 프로세스로 함께 실행.
 *
 * 기존 `bun api-server.ts & vite` 방식은 종료 시 api-server가 고아 프로세스로
 * 남아 포트 3001이 누수되는 문제가 있었음. 이 러너는:
 * 1. 시작 전 포트 3001의 기존 리스너를 정리 (darwin: lsof)
 * 2. 두 서버를 자식으로 spawn (stdio inherit)
 * 3. 종료/SIGINT/SIGTERM 시 두 자식을 모두 kill
 * 4. vite의 exit code로 종료
 */

async function runDev(): Promise<void> {
const API_PORT = Number(process.env.API_PORT) || 3001;
const VITE_PORT = Number(process.env.PORT) || 9000;

interface DevListenerIdentity {
  pid: number;
  port: number;
  command: string;
  cwd: string | null;
}

function inspectDevListener(pid: number, port: number): DevListenerIdentity {
  const command = Bun.spawnSync(["/bin/ps", "-p", String(pid), "-o", "command="])
    .stdout.toString().trim();
  const cwdOutput = Bun.spawnSync(["/usr/sbin/lsof", "-a", "-p", String(pid), "-d", "cwd", "-Fn"])
    .stdout.toString();
  const cwd = cwdOutput.split(/\r?\n/).find((line) => line.startsWith("n"))?.slice(1) || null;
  return { pid, port, command, cwd };
}

function cleanupOwnedDevListeners(ports: number[]): void {
  if (process.platform !== "darwin") return;
  const byPid = new Map<number, DevListenerIdentity>();
  for (const port of ports) {
    // LISTEN is mandatory: connected browsers/renderers are never cleanup targets.
    const lsof = Bun.spawnSync(["/usr/sbin/lsof", "-ti:" + port, "-sTCP:LISTEN"]);
    for (const value of lsof.stdout.toString().trim().split(/\r?\n/).filter(Boolean)) {
      const pid = Number(value);
      if (Number.isInteger(pid) && pid > 1 && !byPid.has(pid)) {
        byPid.set(pid, inspectDevListener(pid, port));
      }
    }
  }

  const identities = [...byPid.values()];
  const classified = partitionDevListeners(identities, import.meta.dir);
  if (classified.protected.length > 0) {
    const occupied = classified.protected
      .map((item) => `:${item.port} pid=${item.pid} cwd=${item.cwd ?? "unknown"}`)
      .join(", ");
    throw new Error(
      `DEV_PORT_OCCUPIED_BY_PROTECTED_PROCESS ${occupied}. `
      + "설치 앱/다른 프로젝트는 종료하지 않았습니다. API_PORT와 PORT를 다른 값으로 지정하세요.",
    );
  }
  for (const item of classified.owned) {
    process.kill(item.pid, "SIGKILL");
    console.log(`[dev] killed owned stale listener on :${item.port} (pid ${item.pid})`);
  }
}

try {
  cleanupOwnedDevListeners([API_PORT, VITE_PORT]);
} catch (error) {
  console.error(`[dev] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}

// Reuse the exact Bun executable that launched this runner. GUI/Tauri shells often
// do not include ~/.bun/bin in PATH, so a bare `bun` can fail even when this file is running.
let apiGroupConfirmedGone = process.platform === "win32";

function spawnApiServer() {
  const child = Bun.spawn([process.execPath, "api-server.ts"], {
    cwd: import.meta.dir,
    stdio: ["inherit", "inherit", "inherit"],
    // This opt-in is accepted only by the non-bundled source server. A
    // packaged sidecar rejects it even if an inherited environment is forged.
    env: {
      ...process.env,
      AGENTSTOZ_LOCAL_RUNTIME_TEST_MODE: "1",
    },
    // POSIX descendants inherit this isolated group unless they deliberately
    // create another one. Agent Runtime does so intentionally and owns its own
    // parent-pipe guard; request-scoped Git/memory children stay in this group.
    detached: process.platform !== "win32",
  });
  if (process.platform !== "win32" && !posixProcessGroupAlive(child.pid)) {
    try { child.kill("SIGKILL"); } catch { /* failed launch is already fatal */ }
    throw new Error("DEV_API_PROCESS_GROUP_NOT_ESTABLISHED");
  }
  if (process.platform !== "win32") apiGroupConfirmedGone = false;
  console.log(`[dev] api-server started pid=${child.pid}${process.platform === "win32" ? "" : ` pgid=${child.pid}`}`);
  return child;
}

let apiServer = spawnApiServer();

const vite = Bun.spawn(["./node_modules/.bin/vite"], {
  cwd: import.meta.dir,
  stdio: ["inherit", "inherit", "inherit"],
});

let shuttingDown = false;
let shutdownTask: Promise<void> | null = null;

function shutdown(code = 0, apiAlreadyReaped = false): Promise<void> {
  if (shutdownTask) return shutdownTask;
  shuttingDown = true;
  if (process.platform !== "win32" && apiAlreadyReaped) {
    apiGroupConfirmedGone = true;
  }
  shutdownTask = (async () => {
    try { vite.kill(); } catch { /* already stopped */ }

    if (!apiAlreadyReaped) {
      if (process.platform === "win32") {
        try { apiServer.kill(); } catch { /* already stopped */ }
        await apiServer.exited.catch(() => undefined);
      } else {
        // Signal only the leader first so its bounded SIGTERM handler can close
        // journals and its separately guarded Agent Runtime. The group becomes
        // the hard backstop after that grace window.
        try { apiServer.kill("SIGTERM"); } catch { /* already stopped */ }
        await Promise.race([
          apiServer.exited.catch(() => undefined),
          Bun.sleep(API_GRACEFUL_SHUTDOWN_MS),
        ]);
        await terminatePosixApiProcessGroup(apiServer.pid);
        apiGroupConfirmedGone = true;
        await apiServer.exited.catch(() => undefined);
      }
    }
    process.exit(code);
  })().catch(async error => {
    // Never fall through to a replacement after uncertain cleanup. Re-try the
    // hard fence; if the OS still cannot prove ESRCH, this runner stays failed
    // rather than creating a second writer authority.
    console.error(`[dev] API process-group cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
    if (process.platform !== "win32") {
      while (true) {
        try {
          await terminatePosixApiProcessGroup(apiServer.pid);
          apiGroupConfirmedGone = true;
          break;
        } catch (retryError) {
          console.error(`[dev] API process group remains quarantined: ${retryError instanceof Error ? retryError.message : String(retryError)}`);
          await Bun.sleep(1_000);
        }
      }
    }
    process.exit(70);
  });
  return shutdownTask;
}

process.on("SIGINT", () => { void shutdown(130); });
process.on("SIGTERM", () => { void shutdown(143); });
process.on("exit", () => {
  // Synchronous last resort for process.exit/fatal exceptions. Normal paths
  // above await the ESRCH proof before reaching this hook.
  try {
    if (process.platform === "win32") apiServer.kill("SIGKILL");
    else if (!apiGroupConfirmedGone) process.kill(-apiServer.pid, "SIGKILL");
  } catch { /* already gone */ }
  try { vite.kill(); } catch { /* already gone */ }
});

/**
 * api-server 감시 — 죽으면 **혼자만** 다시 띄운다.
 *
 * 예전에는 둘 중 하나만 죽어도 나머지를 함께 내렸다. 그런데 실측상 죽는 쪽은 거의 항상
 * api-server(bun 런타임 세그폴트, exit 133)였고, 그때마다 화면(vite)까지 같이 꺼져
 * 작업이 통째로 멈췄다. vite는 멀쩡했는데도 말이다.
 * 프록시는 요청할 때마다 새로 연결하므로, api-server만 살아 돌아오면 화면은 그대로 복구된다.
 *
 * 무한 재기동을 막기 위해 창(60초) 안에서 횟수를 제한한다 — 설정 오류처럼 즉시 반복
 * 실패하는 상황에서는 조용히 되살리지 말고 멈춰서 사람이 보게 해야 한다.
 */
const RESTART_WINDOW_MS = 60_000;
const MAX_RESTARTS_PER_WINDOW = 5;
const CRASH_LOG = `${import.meta.dir}/logs/dev-crashes.log`;

async function recordCrash(code: number | null, attempt: number) {
  const line = `${new Date().toISOString()}\tapi-server exit=${code}\trestart=${attempt}\n`;
  try {
    await Bun.$`mkdir -p ${import.meta.dir}/logs`.quiet();
    const prev = await Bun.file(CRASH_LOG).text().catch(() => "");
    await Bun.write(CRASH_LOG, prev + line);
  } catch {}
}

async function superviseApiServer() {
  let restarts = 0;
  let windowStart = Date.now();
  while (!shuttingDown) {
    const code = await apiServer.exited;
    if (shuttingDown) return;

    if (process.platform !== "win32") {
      try {
        // The leader is already reaped, but a Git/memory child may still own
        // files. Prove that the old PGID is gone before any restart decision.
        await terminatePosixApiProcessGroup(apiServer.pid);
        apiGroupConfirmedGone = true;
      } catch (error) {
        console.error(`[dev] old API process group was not reaped: ${error instanceof Error ? error.message : String(error)}`);
        await shutdown(70);
        return;
      }
    }

    // 정상 종료(0)는 의도된 종료로 보고 러너도 함께 끝낸다.
    if (code === 0) {
      console.log("[dev] api-server exited normally (code 0) — shutting down");
      await shutdown(0, true);
      return;
    }

    const now = Date.now();
    if (now - windowStart > RESTART_WINDOW_MS) { windowStart = now; restarts = 0; }
    restarts += 1;
    void recordCrash(code, restarts);

    if (restarts > MAX_RESTARTS_PER_WINDOW) {
      console.error(
        `[dev] api-server가 ${RESTART_WINDOW_MS / 1000}초 안에 ${MAX_RESTARTS_PER_WINDOW}회 넘게 죽었습니다.\n` +
        `[dev] 자동 재기동을 멈춥니다 — ${CRASH_LOG} 를 확인하세요.`,
      );
      await shutdown(code ?? 1, true);
      return;
    }

    console.error(`[dev] api-server exited (code ${code}) — 재기동 ${restarts}/${MAX_RESTARTS_PER_WINDOW} (vite는 그대로 둡니다)`);
    // 죽으면서 listener가 남았더라도 같은 repo의 API만 정리한다. 그 사이
    // sidecar/다른 프로젝트가 포트를 차지했다면 강제로 빼앗지 않고 중단한다.
    try {
      cleanupOwnedDevListeners([API_PORT]);
    } catch (error) {
      console.error(`[dev] ${error instanceof Error ? error.message : String(error)}`);
      await shutdown(1, true);
      return;
    }
    await Bun.sleep(300 * restarts); // 연속 실패일수록 조금씩 물러선다
    if (shuttingDown) return;
    apiServer = spawnApiServer();
    console.log("[dev] api-server 재기동됨");
  }
}

// vite가 끝나면(사용자 종료 등) 러너 전체를 정리한다 — 화면 없이 API만 남길 이유는 없다.
void vite.exited.then((code) => {
  if (shuttingDown) return;
  console.log(`[dev] vite exited (code ${code}) — shutting down`);
  void shutdown(code);
});

await superviseApiServer();
if (shutdownTask) await shutdownTask;
}

if (import.meta.main) await runDev();
