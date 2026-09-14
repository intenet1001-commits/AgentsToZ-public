import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const api = readFileSync(new URL("../api-server.ts", import.meta.url), "utf8");
const rust = readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");

function between(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  expect(from).toBeGreaterThanOrEqual(0);
  const to = source.indexOf(end, from + start.length);
  expect(to).toBeGreaterThan(from);
  return source.slice(from, to);
}

describe("process control parity", () => {
  test("normal execution and force restart both run dependency self-healing before spawn", () => {
    const apiExecute = between(api, 'if (url.pathname === "/api/execute-command"', 'if (url.pathname === "/api/stop-command"');
    const apiRestart = between(api, 'if (url.pathname === "/api/force-restart-command"', 'if (url.pathname === "/api/check-port-status"');
    expect(api).toContain("async function ensureDependenciesForLaunch(");
    expect(apiExecute).toContain("await ensureDependenciesForLaunch(isFilePath, folderPath)");
    expect(apiRestart).toContain("await ensureDependenciesForLaunch(isFilePath, folderPath)");

    const rustExecute = between(rust, "fn execute_command(", "fn stop_targets(");
    const rustRestart = between(rust, "fn force_restart_command(", "fn check_port_status(");
    expect(rustExecute).toContain("ensure_dependencies_sync(fp)");
    expect(rustRestart).toContain("ensure_dependencies_sync(fp)");
  });

  test("web, frontend, and native restart share optional-port semantics", () => {
    const apiExecute = between(api, 'if (url.pathname === "/api/execute-command"', 'if (url.pathname === "/api/stop-command"');
    const apiRestart = between(api, 'if (url.pathname === "/api/force-restart-command"', 'if (url.pathname === "/api/check-port-status"');
    expect(api).toContain('from "./src/processPortEnvironment"');
    expect(apiExecute).toContain("...processPortEnvironment(launchPort)");
    expect(apiRestart).toContain("...processPortEnvironment(launchPort)");
    expect(apiRestart).not.toContain("!port || !commandPath");

    expect(app).toContain("forceRestartCommand(portId: string, port: number | undefined");
    expect(app).toContain("API.forceRestartCommand(item.id, item.port, runTarget, item.folderPath)");
    expect(app).not.toContain("API.forceRestartCommand(item.id, item.port ?? 0");

    expect(rust).toContain('include_str!("../../tests/fixtures/spawn-port-env-golden.json")');
    const rustRestart = between(rust, "fn force_restart_command(", "fn check_port_status(");
    expect(rustRestart).toContain("port: Option<u16>");
    expect(rustRestart).toContain("port: normalized_spawn_port(port)");
  });

  test("native stop and force restart terminate descendant process trees", () => {
    const rustStop = between(rust, "fn stop_command(", "fn force_restart_command(");
    const rustRestart = between(rust, "fn force_restart_command(", "fn check_port_status(");
    expect(rust).toContain("fn collect_descendant_pids_with");
    expect(rust).toContain("if libc::setsid() == -1");
    expect(rustStop).toContain("terminate_managed_process_group(*pid)");
    expect(rustStop).toContain("terminate_process_tree(*pid)");
    expect(rustRestart).toContain("force_kill_managed_process_group(pid)");
    expect(rustRestart).toContain("force_kill_process_tree(pid)");
  });

  test("web Windows stop checks taskkill tree termination and propagates failures", () => {
    const helper = between(api, "async function killWindowsProcessTree(", "async function killPid(");
    expect(helper).toContain("['taskkill', '/F', '/T', '/PID', pid]");
    expect(helper).toContain("await proc.exited");
    expect(helper).toContain("if (proc.exitCode !== 0)");
    expect(helper).toContain("throw new Error");

    const apiStop = between(api, 'if (url.pathname === "/api/stop-command"', 'if (url.pathname === "/api/force-restart-command"');
    const apiRestart = between(api, 'if (url.pathname === "/api/force-restart-command"', 'if (url.pathname === "/api/check-port-status"');
    const apiExecute = between(api, 'if (url.pathname === "/api/execute-command"', 'if (url.pathname === "/api/stop-command"');
    expect(apiExecute).toContain("console.error(`[Execute] Error killing process:`, e);\n            throw e;");
    expect(apiStop).toContain("throw e;");
    expect(apiRestart).toContain("throw e;");
  });
});
