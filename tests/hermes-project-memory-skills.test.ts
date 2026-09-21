import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const repo = join(import.meta.dir, "..");
const template = (name: string) => readFileSync(join(repo, "templates", "hermes", name, "SKILL.md"), "utf8");

describe("Hermes Telegram project-memory command templates", () => {
  test("ships the preferred AWS command surface", () => {
    const names = ["remember-session", "memory-link", "memory-sync", "memory-status", "memory-unlink"];
    for (const name of names) {
      const body = template(name);
      expect(body).toContain(`name: ${name}`);
      expect(body).toContain("HERMES_SESSION_PLATFORM");
      expect(body).toContain("HERMES_SESSION_CHAT_ID");
      expect(body).toContain("HERMES_SESSION_THREAD_ID");
      expect(body).toContain("127.0.0.1:3001/api/project-memory/");
    }
  });

  test("removes the ambiguous remember alias and keeps only the stop compatibility alias", () => {
    expect(existsSync(join(repo, "templates", "hermes", "remember", "SKILL.md"))).toBe(false);
    expect(template("memory-stop")).toContain("Compatibility alias");
  });

  test("memory-start creates a new standalone topic memory and backs it up", () => {
    const body = template("memory-start");
    expect(body).toContain("/memory_start [기억 이름]");
    expect(body).toContain("/api/project-memory/thread/create");
    expect(body).toContain("supabaseSaved: true");
    expect(body).toContain("state.db");
  });

  test("link requires a stable project selector and binds the current route", () => {
    const body = template("memory-link");
    expect(body).toContain("/memory_link <shared memoryId");
    expect(body).toContain("/api/project-memory/thread/start");
    expect(body).toContain("and `project`");
  });

  test("remember-session accepts a bound topic and keeps explicit one-shot local selection", () => {
    const body = template("remember-session");
    expect(body).toContain("/api/project-memory/thread/status");
    expect(body).toContain("If an argument is present");
    expect(body).toContain("If no argument is present");
    expect(body).toContain("current Hermes conversation");
    expect(body).toContain("automatic backup is enabled");
    expect(body).toContain("memory-entry-id");
    expect(body).toContain("Never remove or regenerate an existing entry ID");
  });

  test("sync is manual regardless of auto-backup, while status and unlink stay scoped", () => {
    expect(template("memory-sync")).toContain("explicit manual sync request");
    expect(template("memory-sync")).toContain("/api/project-memory/thread/sync");
    expect(template("memory-status")).toContain("/api/project-memory/thread/status");
    expect(template("memory-unlink")).toContain("/api/project-memory/thread/stop");
  });

  test("opens the registered project in Hermes Desktop from Telegram without trusting a raw path", () => {
    const body = template("hermes-open");
    expect(body).toContain("/hermes_open <memoryId>");
    expect(body).toContain("/api/project-memory/resolve-project");
    expect(body).toContain("/api/open-code-app");
    expect(body).toContain('agent": "hermes"');
    expect(body).toContain("canonicalPath");
    expect(body).toContain("Never accept a folder path from the Telegram message");
  });
});
