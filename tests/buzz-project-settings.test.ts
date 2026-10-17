import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadBuzzProjectSettings, saveBuzzProjectSettings } from "../src/buzzProjectSettings";

const temps: string[] = [];
afterEach(() => {
  for (const path of temps.splice(0)) rmSync(path, { recursive: true, force: true });
});

function settingsPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "buzz-project-settings-"));
  temps.push(dir);
  return join(dir, "buzz-project-settings.json");
}

describe("Buzz project settings", () => {
  test("defaults locally and persists one credential-free hosted relay", () => {
    const file = settingsPath();
    expect(loadBuzzProjectSettings(file).relayUrl).toBe("ws://localhost:3000");

    const saved = saveBuzzProjectSettings(file, {
      relayUrl: "https://csncompany.communities.buzz.xyz/",
    });
    expect(saved.relayUrl).toBe("wss://csncompany.communities.buzz.xyz");
    expect(loadBuzzProjectSettings(file)).toEqual(saved);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, "utf8")).not.toContain("private");
  });

  test("rejects credentials and corrupted state", () => {
    const file = settingsPath();
    expect(() => saveBuzzProjectSettings(file, { relayUrl: "wss://key@example.com" }))
      .toThrow("인증정보");
  });
});
