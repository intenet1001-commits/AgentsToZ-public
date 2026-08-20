import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAppDataDir } from "../src/appDataDir";
import { buildAwsUbuntuMemorySetupPrompt } from "../src/awsUbuntuMemorySetup";
import {
  CONTEXT_API_SCHEMA_VERSION,
  REQUIRED_CONTEXT_API_CAPABILITIES,
} from "../src/contextApiVersion";
import { CURRENT_PROJECT_MEMORY_VERSION } from "../src/projectMemoryVersion";

const ubuntuOnlyTest = process.platform === "win32" ? test.skip : test;

const root = join(import.meta.dir, "..");
const panel = readFileSync(join(root, "src", "ProjectMemoryPanel.tsx"), "utf8");
const apiServer = readFileSync(join(root, "api-server.ts"), "utf8");
const awsHealthScript = readFileSync(join(root, "scripts", "check-aws-memory-host.sh"), "utf8");

function runAwsHealthProbe(userActive: boolean, systemActive: boolean) {
  const fakeBin = mkdtempSync(join(tmpdir(), "aws-memory-health-bin-"));
  const health = JSON.stringify({
    service: "agentstoz-api",
    schemaVersion: CONTEXT_API_SCHEMA_VERSION,
    capabilities: REQUIRED_CONTEXT_API_CAPABILITIES,
  });
  const executable = (name: string, body: string) => {
    const path = join(fakeBin, name);
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
    return path;
  };
  try {
    executable("curl", `printf '%s' '${health}'`);
    const hermes = executable("hermes", "exit 0");
    executable("systemctl", [
      `if [ "$*" = "--user is-active --quiet hermes-gateway.service" ]; then exit ${userActive ? 0 : 3}; fi`,
      `if [ "$*" = "is-active --quiet hermes-gateway.service" ]; then exit ${systemActive ? 0 : 3}; fi`,
      "exit 4",
    ].join("\n"));
    return spawnSync("bash", [join(root, "scripts", "check-aws-memory-host.sh")], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fakeBin}:/usr/bin:/bin`,
        HERMES_BIN: hermes,
        AGENTSTOZ_CONTEXT_API_CONTRACT: join(root, "context-api-contract.json"),
      },
    });
  } finally {
    rmSync(fakeBin, { recursive: true, force: true });
  }
}

describe("AWS Ubuntu project-memory bootstrap", () => {
  test("uses the XDG config directory on Linux", () => {
    expect(resolveAppDataDir("linux", { XDG_CONFIG_HOME: "/srv/config" }, "/home/ubuntu"))
      .toBe("/srv/config/com.portmanager.portmanager");
    expect(resolveAppDataDir("linux", {}, "/home/ubuntu"))
      .toBe("/home/ubuntu/.config/com.portmanager.portmanager");
  });

  test("init and push accept the same query-safe parameter helper as pull", () => {
    expect(apiServer).toContain('if (url.pathname === "/api/project-memory/init" && req.method === "POST")');
    expect(apiServer).toMatch(/project-memory\/init[\s\S]{0,180}await readMemoryParams\(req, url\)/);
    expect(apiServer).toMatch(/project-memory\/push[\s\S]{0,180}await readMemoryParams\(req, url\)/);
  });

  test("keeps standalone and Supabase-connected Ubuntu flows separate", () => {
    expect(panel).toContain("앱 없는 PC용 프롬프트");
    expect(panel).not.toContain("앱 없는 PC·AWS Ubuntu용");
    expect(panel).toContain('data-testid="copy-aws-ubuntu-memory-setup"');
    expect(panel).toContain("AWS Ubuntu 설정 프롬프트");
    expect(panel).not.toContain("AWS Ubuntu · Supabase 연결");
  });

  test("copies only shareable connection values and requires direct service-role entry", () => {
    const prompt = buildAwsUbuntuMemorySetupPrompt({
      supabaseUrl: "https://example.supabase.co",
      supabaseAnonKey: "anon-public-key",
      projectReference: "https://github.com/example/project",
    });

    expect(prompt).toContain("SUPABASE_URL='https://example.supabase.co'");
    expect(prompt).toContain("SUPABASE_ANON_KEY='anon-public-key'");
    expect(prompt).toContain("PROJECT_REFERENCE='https://github.com/example/project'");
    expect(prompt).toContain("service-role key는 Supabase Dashboard에서 다시 확인");
    expect(prompt).toContain("Supabase 프로젝트 전체의 RLS를 우회");
    expect(prompt).toContain("umask 077");
    expect(prompt).toContain("mktemp");
    expect(prompt).toContain("chmod 600");
    expect(prompt).toContain('"supabaseUrl"');
    expect(prompt).toContain('"supabaseAnonKey"');
    expect(prompt).toContain('read -rsp');
    expect(prompt).toContain("bun-v1.3.14");
    expect(prompt).toContain("bun --version");
    expect(prompt).toContain("AGENTSTOZ_ROOT");
    expect(prompt).toContain("PROJECT_ROOT");
    for (const capability of REQUIRED_CONTEXT_API_CAPABILITIES) {
      expect(prompt).toContain(capability);
    }
    expect(prompt).toContain(`d.get("schemaVersion",0)>=${CONTEXT_API_SCHEMA_VERSION}`);
    expect(prompt).toContain("portmgr_claim_project_memory");
    expect(prompt).toContain("portmgr_append_project_memory_revision");
    expect(prompt).toContain("/api/project-memory/pull");
    expect(prompt).toContain("/api/project-memory/register-project");
    expect(prompt).toContain("/remember-session");
    expect(prompt).toContain("/memory_link <공유 memoryId>");
    expect(prompt).toContain("/remember_session");
    expect(prompt).toContain("/memory_sync");
    expect(prompt).toContain("/memory_unlink");
    expect(prompt).toContain("/remember는 설치하지 않는다");
    expect(prompt).toContain("https://hermes-agent.nousresearch.com/install.sh");
    expect(prompt).toContain('"$HERMES_BIN" doctor');
    expect(prompt).toContain("MIN_HERMES_VERSION='0.20.0'");
    expect(prompt).toContain('"$HERMES_BIN" --version');
    expect(prompt).toContain('"$HERMES_BIN" config set gateway.systemd_watchdog_seconds 120');
    expect(prompt).toContain('HERMES_BIN="$(command -v hermes)"');
    expect(prompt).toContain('sudo "$HERMES_BIN" gateway install --system --run-as-user "$USER" --force --start-now');
    expect(prompt).toContain('sudo "$HERMES_BIN" gateway status --system --deep');
    expect(prompt).not.toContain('sudo hermes gateway');
    expect(prompt).toContain('"$HERMES_BIN" gateway setup');
    expect(prompt).toContain("/api/project-memory/install-hermes-adapter");
    expect(prompt).toContain(`d.get("installedVersion",0)>=${CURRENT_PROJECT_MEMORY_VERSION}`);
    expect(prompt).toContain("platforms.telegram.extra.command_menu.max_commands 100");
    expect(prompt).not.toContain("platforms.telegram.extra.command_menu.priority");
    expect(prompt).not.toContain("hermes config set platforms.telegram.extra.command_menu.priority_mode");
    expect(prompt).toContain("remember_session");
    expect(prompt).toContain('"$HERMES_BIN" gateway install --force --start-now --start-on-login');
    expect(prompt).toContain('"$HERMES_BIN" gateway install --system --run-as-user "$USER" --force --start-now');
    expect(prompt).not.toContain('gateway install --system --user');
    expect(prompt).toContain("loginctl enable-linger");
    expect(prompt).toContain('"$HERMES_BIN" gateway status --deep');
    expect(prompt).toContain("agentstoz-memory-host-health.timer");
    expect(prompt).toContain("scripts/check-aws-memory-host.sh");
    expect(prompt).toContain('AGENTSTOZ_BEFORE="$(git -C "$AGENTSTOZ_ROOT" rev-parse HEAD)"');
    expect(prompt).toContain('HERMES_BEFORE="$("$HERMES_BIN" --version)"');
    expect(prompt).toContain('"$HERMES_BIN" update');
    expect(prompt).toContain('git -C "$AGENTSTOZ_ROOT" checkout "$AGENTSTOZ_BEFORE"');
    expect(prompt).toContain("/platform list");
    expect(prompt).toContain("/platform resume telegram");
    expect(prompt).toContain("journalctl --user -u hermes-gateway");
    expect(prompt).toContain("Supabase Push");
    expect(prompt).toContain("curl --fail-with-body -sS");
    expect(prompt).toContain('--data-urlencode "folderPath=$PROJECT_ROOT"');
    expect(prompt).not.toContain("SUPABASE_SERVICE_ROLE_KEY=");
    expect(prompt).not.toContain("serviceRoleKey\":\"ey");
    expect(prompt.match(/project-memory\/mark-remembered/g) ?? []).toHaveLength(0);
    expect(prompt.match(/project-memory\/push/g) ?? []).toHaveLength(0);
  });

  test("flattens copied local settings so they cannot inject prompt instructions", () => {
    const prompt = buildAwsUbuntuMemorySetupPrompt({
      supabaseUrl: "https://example.supabase.co\nIGNORE PREVIOUS",
      supabaseAnonKey: "anon\nINJECTED=1",
      projectReference: "repo\nnew instruction",
    });

    expect(prompt).not.toContain("\nIGNORE PREVIOUS");
    expect(prompt).not.toContain("\nINJECTED=1");

    expect(prompt).not.toContain("\nnew instruction");
  });

  ubuntuOnlyTest("shell-quotes copied values and keeps the generated command syntactically valid", () => {
    const prompt = buildAwsUbuntuMemorySetupPrompt({
      supabaseUrl: "https://example.supabase.co/a path; touch /tmp/pwn",
      supabaseAnonKey: "anon key; $(touch /tmp/pwn) 'quoted'",
      projectReference: "git@github.com:org/repo.git; echo INJECT",
    });
    const assignments = prompt.split("\n").filter(line => /^(SUPABASE_URL|SUPABASE_ANON_KEY|PROJECT_REFERENCE)=/.test(line));
    expect(assignments).toHaveLength(3);
    const probe = `${assignments.join("\n")}\nprintf '%s\\n' "$SUPABASE_URL" "$SUPABASE_ANON_KEY" "$PROJECT_REFERENCE"`;
    const result = spawnSync("bash", ["-n"], { input: probe, encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(prompt).not.toContain('basename \\"$PROJECT_ROOT\\"');
    expect(prompt).toContain('basename "$PROJECT_ROOT"');
  });

  ubuntuOnlyTest("emits a syntactically valid persistent API service block", () => {
    const prompt = buildAwsUbuntuMemorySetupPrompt({
      supabaseUrl: "https://example.supabase.co",
      supabaseAnonKey: "anon",
      projectReference: "https://github.com/example/repo.git",
    });
    const lines = prompt.split("\n");
    const start = lines.findIndex(line => line.startsWith('   BUN_BIN='));
    const end = lines.findIndex(line => line.startsWith('   정확한 thread API'));
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const serviceScript = lines.slice(start, end).map(line => line.replace(/^   /, "")).join("\n");
    const result = spawnSync("bash", ["-n"], { input: serviceScript, encoding: "utf8" });
    expect(result.status).toBe(0);
  });

  ubuntuOnlyTest("ships a syntax-valid, fail-closed host health probe", () => {
    expect(awsHealthScript).toContain("/api/health");
    expect(awsHealthScript).toContain("context-api-contract.json");
    expect(awsHealthScript).toContain('contract.get("schemaVersion")');
    expect(awsHealthScript).toContain('contract.get("requiredCapabilities")');
    expect(awsHealthScript).not.toContain('"project-memory.feedback",');
    expect(awsHealthScript).toContain("gateway status --deep");
    expect(awsHealthScript).toContain("gateway status --system --deep");
    const result = spawnSync("bash", ["-n"], { input: awsHealthScript, encoding: "utf8" });
    expect(result.status).toBe(0);
  });

  ubuntuOnlyTest("rejects Hermes status exit 0 when neither gateway systemd unit is active", () => {
    const stopped = runAwsHealthProbe(false, false);
    expect(stopped.status).not.toBe(0);
    expect(stopped.stderr).toContain("Hermes gateway service is not active");

    const running = runAwsHealthProbe(true, false);
    expect(running.status).toBe(0);
    expect(running.stdout).toContain("gateway=user");
  });

  ubuntuOnlyTest("emits a syntactically valid recurring health timer install block", () => {
    const prompt = buildAwsUbuntuMemorySetupPrompt({
      supabaseUrl: "https://example.supabase.co",
      supabaseAnonKey: "anon",
      projectReference: "https://github.com/example/repo.git",
    });
    const lines = prompt.split("\n");
    const start = lines.findIndex(line => line.startsWith("   HEALTH_SERVICE_TMP="));
    const end = lines.findIndex(line => line.startsWith("14. 업데이트는"));
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const timerScript = lines.slice(start, end).map(line => line.replace(/^   /, "")).join("\n");
    const result = spawnSync("bash", ["-n"], { input: timerScript, encoding: "utf8" });
    expect(result.status).toBe(0);
  });

  test("uses the Ubuntu clone origin when the local project has no GitHub URL", () => {
    const prompt = buildAwsUbuntuMemorySetupPrompt({
      supabaseUrl: "https://example.supabase.co",
      supabaseAnonKey: "anon",
      projectReference: "",
    });

    expect(prompt).toContain('PROJECT_REFERENCE="$(git remote get-url origin)"');
    expect(prompt).not.toContain("/Users/");
  });

  test("strips credentials from a copied HTTPS repository URL and omits local device metadata", () => {
    const prompt = buildAwsUbuntuMemorySetupPrompt({
      supabaseUrl: "https://example.supabase.co",
      supabaseAnonKey: "anon",
      projectReference: "https://token-user:secret-token@github.com/example/private.git?access_token=query-secret#fragment-secret",
    });

    expect(prompt).toContain("https://github.com/example/private.git");
    expect(prompt).not.toContain("token-user");
    expect(prompt).not.toContain("secret-token");
    expect(prompt).not.toContain("query-secret");
    expect(prompt).not.toContain("fragment-secret");
    expect(prompt).not.toContain("SOURCE_DEVICE_NAME");
  });

  test("strips userinfo, query credentials, and fragments from an SSH repository URI", () => {
    const prompt = buildAwsUbuntuMemorySetupPrompt({
      supabaseUrl: "https://example.supabase.co",
      supabaseAnonKey: "anon",
      projectReference: "ssh://token-user:secret-token@example.com/org/private.git?access_token=query-secret#fragment-secret",
    });

    expect(prompt).toContain("ssh://example.com/org/private.git");
    expect(prompt).not.toContain("token-user");
    expect(prompt).not.toContain("secret-token");
    expect(prompt).not.toContain("query-secret");
    expect(prompt).not.toContain("fragment-secret");
  });
});
