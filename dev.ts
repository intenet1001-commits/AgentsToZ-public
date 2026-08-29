#!/usr/bin/env bun

import { partitionDevListeners } from "./src/devListenerOwnership";

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
function spawnApiServer() {
  return Bun.spawn([process.execPath, "api-server.ts"], {
    cwd: import.meta.dir,
    stdio: ["inherit", "inherit", "inherit"],
  });
}

let apiServer = spawnApiServer();

const vite = Bun.spawn(["./node_modules/.bin/vite"], {
  cwd: import.meta.dir,
  stdio: ["inherit", "inherit", "inherit"],
});

let shuttingDown = false;
function shutdown(code?: number) {
  if (shuttingDown) return;
  shuttingDown = true;
  try { apiServer.kill(); } catch {}
  try { vite.kill(); } catch {}
  if (code !== undefined) process.exit(code);
}

process.on("SIGINT", () => shutdown(130));
process.on("SIGTERM", () => shutdown(143));
process.on("exit", () => shutdown());

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

    // 정상 종료(0)는 의도된 종료로 보고 러너도 함께 끝낸다.
    if (code === 0) {
      console.log("[dev] api-server exited normally (code 0) — shutting down");
      shutdown(0);
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
      shutdown(code ?? 1);
      return;
    }

    console.error(`[dev] api-server exited (code ${code}) — 재기동 ${restarts}/${MAX_RESTARTS_PER_WINDOW} (vite는 그대로 둡니다)`);
    // 죽으면서 listener가 남았더라도 같은 repo의 API만 정리한다. 그 사이
    // sidecar/다른 프로젝트가 포트를 차지했다면 강제로 빼앗지 않고 중단한다.
    try {
      cleanupOwnedDevListeners([API_PORT]);
    } catch (error) {
      console.error(`[dev] ${error instanceof Error ? error.message : String(error)}`);
      shutdown(1);
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
  shutdown(code);
});

await superviseApiServer();
