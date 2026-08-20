import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const apiServer = readFileSync(join(root, "api-server.ts"), "utf8");
const rust = readFileSync(join(root, "src-tauri", "src", "lib.rs"), "utf8");

function sliceFrom(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  expect(from).toBeGreaterThan(-1);
  const to = source.indexOf(end, from + start.length);
  return source.slice(from, to > from ? to : undefined);
}

// `lsof -ti :<port>` lists every process holding a socket on that port, not just
// the server. Measured on this machine, `lsof -ti :3001` returned the API server
// AND the app's own WebKit renderer. The stop/force-restart callers SIGKILL each
// returned PID together with its descendants, so the app was killing its own UI
// and API server — the in-flight request then failed as
// "TypeError: Failed to fetch". dev.ts already carried this guard; the kill paths
// did not.
describe("port kill paths target listeners only", () => {
  test("getPidsByPort asks lsof for listeners", () => {
    const fn = sliceFrom(apiServer, "async function getPidsByPort", "\n/**");
    expect(fn).toContain("'-sTCP:LISTEN'");
    // The bare form must not survive anywhere in that function.
    expect(fn).not.toMatch(/'-ti',\s*`:\$\{p\}`\s*\]/);
  });

  test("the Windows branch keeps the same listener meaning without an English locale dependency", () => {
    const fn = sliceFrom(apiServer, "async function getPidsByPort", "\n/**");
    expect(fn).toContain("windowsListenerPidsForPort(out, p)");
    expect(apiServer).toContain('from "./src/windowsNetstat"');
  });

  test("every macOS lsof port lookup in Rust carries the listener filter", () => {
    const lookups = [...rust.matchAll(/Command::new\("lsof"\)([\s\S]{0,400}?)\.output\(\)/g)];
    expect(lookups.length).toBeGreaterThanOrEqual(3);
    for (const [, body] of lookups) {
      // Either a per-port lookup with the filter, or the batch listener query
      // that already scopes itself with -sTCP:LISTEN.
      expect(body).toContain("-sTCP:LISTEN");
    }
  });

  test("stop and force-restart both go through a listener-scoped lookup", () => {
    const stop = sliceFrom(rust, "fn stop_command", "fn ");
    const force = sliceFrom(rust, "fn force_restart_command", "fn ");
    // stop_command은 이제 lsof 호출을 인라인으로 갖지 않고 listen_pids_by_port()에
    // 위임한다(대상 선정을 stop_targets 한 곳으로 모으면서 분리됨). 리터럴을 함수
    // 본문에서 찾는 단언은 그 리팩터링을 잡아낸 것이지 필터가 사라진 게 아니다 —
    // 계약은 "포트 조회가 리스너로 한정된다"이므로 위임 대상까지 따라가서 확인한다.
    expect(stop).toContain("normalized_port.map(listen_pids_by_port)");
    const helper = sliceFrom(rust, "fn listen_pids_by_port", "\n}\n");
    expect(helper).toContain("-sTCP:LISTEN");
    expect(force).toContain("normalized_spawn_port(port).map(listen_pids_by_port)");
  });
});
