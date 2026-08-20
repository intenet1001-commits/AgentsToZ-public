import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const devRunner = readFileSync(new URL("../dev.ts", import.meta.url), "utf8");

describe("development listener ownership", () => {
  test("only this repository's API/Vite runners are eligible for cleanup", async () => {
    const modulePath = "../src/devListenerOwnership";
    const loaded = await import(modulePath).catch(() => null) as null | {
      isOwnedDevListener: (
        identity: { command: string; cwd?: string | null },
        projectRoot: string,
      ) => boolean;
      partitionDevListeners: <T extends { command: string; cwd?: string | null }>(
        identities: T[],
        projectRoot: string,
      ) => { owned: T[]; protected: T[] };
    };
    expect(loaded).not.toBeNull();
    const owns = loaded!.isOwnedDevListener;
    expect(owns({ command: "/Users/me/.bun/bin/bun api-server.ts", cwd: "/repo" }, "/repo")).toBe(true);
    expect(owns({ command: "node /repo/node_modules/vite/bin/vite.js", cwd: "/repo" }, "/repo")).toBe(true);
    expect(owns({ command: "node C:\\repo\\node_modules\\vite\\bin\\vite.js", cwd: "C:\\repo" }, "C:\\repo")).toBe(true);
    expect(owns({ command: "/Applications/AgentsToZ_byCS.app/Contents/Resources/resources/agentstoz-api-sidecar", cwd: "/" }, "/repo")).toBe(false);
    expect(owns({ command: "/Users/me/.bun/bin/bun api-server.ts", cwd: "/other-repo" }, "/repo")).toBe(false);
    expect(owns({ command: "/Users/me/.bun/bin/bun test", cwd: "/repo" }, "/repo")).toBe(false);
    expect(owns({ command: "", cwd: null }, "/repo")).toBe(false);

    const own = { pid: 10, command: "bun api-server.ts", cwd: "/repo" };
    const sidecar = { pid: 20, command: "/Applications/AgentsToZ_byCS.app/Contents/Resources/resources/agentstoz-api-sidecar", cwd: "/" };
    expect(loaded!.partitionDevListeners([own, sidecar], "/repo")).toEqual({
      owned: [own],
      protected: [sidecar],
    });
  });

  test("the runner classifies all listeners before terminating only owned PIDs", () => {
    expect(devRunner).toContain('from "./src/devListenerOwnership"');
    expect(devRunner).toContain("partitionDevListeners(identities, import.meta.dir)");
    expect(devRunner).toContain("DEV_PORT_OCCUPIED_BY_PROTECTED_PROCESS");
    expect(devRunner).toContain("cleanupOwnedDevListeners([API_PORT, VITE_PORT])");
    expect(devRunner).toContain("cleanupOwnedDevListeners([API_PORT])");
  });
});
