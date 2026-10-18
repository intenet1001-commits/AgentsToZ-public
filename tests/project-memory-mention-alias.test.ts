import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MentionAliasRegistry,
  groupSharedMentionAliases,
  normalizeMentionAlias,
  resolveSharedMentionAlias,
} from "../src/projectMemoryMentionAlias";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function registry(): MentionAliasRegistry {
  const root = mkdtempSync(join(tmpdir(), "agentstoz-mentions-"));
  roots.push(root);
  return new MentionAliasRegistry(join(root, "project-memory-mention-aliases.json"));
}

describe("Hermes project mention aliases", () => {
  test("normalizes a human suggestion to the command-safe alphabet", () => {
    expect(normalizeMentionAlias("  My_Project 42!! ")).toBe("my-project-42");
    expect(normalizeMentionAlias("한글 프로젝트")).toBe("한글-프로젝트");
    expect(normalizeMentionAlias("샵")).toBe("샵");
    // The SQL CHECK intentionally supports ASCII + Hangul only. TS must not
    // advertise a broader alphabet that the save RPC later rejects.
    expect(normalizeMentionAlias("日本語")).toBeNull();
  });

  test("persists one globally unique primary alias per stable memoryId", () => {
    const aliases = registry();
    expect(aliases.save("memory-a", "My Project").primaryAlias).toBe("my-project");
    expect(aliases.list()).toEqual([expect.objectContaining({ memoryId: "memory-a", primaryAlias: "my-project" })]);
    expect(() => aliases.save("memory-b", "my-project")).toThrow(/already reserved/i);
  });

  test("resolves a Korean project name as a hash mention", () => {
    const aliases = registry();
    aliases.save("memory-shop", "샵");
    expect(aliases.resolve("#샵")).toEqual({ memoryId: "memory-shop", alias: "샵", redirected: false });
  });
  test("rename retains the old alias as a permanent redirect and never reassigns it", () => {
    const aliases = registry();
    aliases.save("memory-a", "first-name");
    const renamed = aliases.save("memory-a", "better-name");
    expect(renamed.redirects).toEqual(["first-name"]);
    expect(aliases.resolve("first-name")).toEqual({ memoryId: "memory-a", alias: "better-name", redirected: true });
    expect(aliases.resolve("better-name")).toEqual({ memoryId: "memory-a", alias: "better-name", redirected: false });
    expect(() => aliases.save("memory-b", "first-name")).toThrow(/already reserved/i);
  });

  test("mention lookup is case-insensitive and a rename back never leaves the primary duplicated as a redirect", () => {
    const aliases = registry();
    aliases.save("memory-a", "first-name");
    aliases.save("memory-a", "better-name");
    const renamedBack = aliases.save("memory-a", "first-name");
    expect(renamedBack.redirects).toEqual(["better-name"]);
    expect(aliases.resolve("#FIRST-NAME")).toEqual({ memoryId: "memory-a", alias: "first-name", redirected: false });
  });

  test("shared redirect lookup returns the current primary alias, not the requested old alias", () => {
    const rows = [
      { alias: "old-name", memory_id: "memory-a", status: "redirect", updated_at: "2026-08-25T00:00:00Z" },
      { alias: "current-name", memory_id: "memory-a", status: "primary", updated_at: "2026-08-25T00:01:00Z" },
    ] as const;
    expect(resolveSharedMentionAlias([...rows], "#OLD-NAME"))
      .toEqual({ memoryId: "memory-a", alias: "current-name", redirected: true });
    expect(groupSharedMentionAliases([...rows])).toEqual([{
      memoryId: "memory-a",
      primaryAlias: "current-name",
      redirects: ["old-name"],
      updatedAt: "2026-08-25T00:01:00Z",
    }]);
  });

  test("authoritative shared rows replace a stale offline cache atomically", () => {
    const aliases = registry();
    aliases.save("memory-old", "stale-name");
    aliases.replace([{
      memoryId: "memory-new",
      primaryAlias: "fresh-name",
      redirects: ["old-fresh-name"],
      updatedAt: "2026-08-25T00:00:00Z",
    }]);
    expect(aliases.resolve("stale-name")).toBeNull();
    expect(aliases.resolve("old-fresh-name")).toEqual({ memoryId: "memory-new", alias: "fresh-name", redirected: true });
  });

  test("missing and malformed aliases fail closed", () => {
    const aliases = registry();
    expect(aliases.resolve("unknown")).toBeNull();
    expect(aliases.resolve("Unknown Alias!")).toBeNull();
  });
});
