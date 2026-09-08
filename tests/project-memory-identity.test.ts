import { describe, expect, test } from "bun:test";
import {
  canonicalProjectRepositoryKey,
  proposedMemoryIdForRepository,
} from "../src/projectMemoryIdentity";

describe("project memory repository identity", () => {
  test("SSH and HTTPS clones of the same GitHub repository share one key", () => {
    expect(canonicalProjectRepositoryKey("git@github.com:Acme/SameRepo.git"))
      .toBe("https://github.com/acme/samerepo");
    expect(canonicalProjectRepositoryKey("https://github.com/acme/samerepo.git/"))
      .toBe("https://github.com/acme/samerepo");
  });

  test("a fork remains a different project", () => {
    expect(canonicalProjectRepositoryKey("git@github.com:alice/app.git"))
      .not.toBe(canonicalProjectRepositoryKey("git@github.com:bob/app.git"));
  });

  test("the same repository always proposes the same valid UUID", () => {
    const key = canonicalProjectRepositoryKey("git@github.com:Acme/SameRepo.git")!;
    const a = proposedMemoryIdForRepository(key);
    const b = proposedMemoryIdForRepository(key);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  test("different repositories propose different IDs", () => {
    const a = proposedMemoryIdForRepository("https://github.com/acme/a");
    const b = proposedMemoryIdForRepository("https://github.com/acme/b");
    expect(a).not.toBe(b);
  });

  test("unsupported local path-like remotes do not invent a shared identity", () => {
    expect(canonicalProjectRepositoryKey("../local-repository")).toBeNull();
    expect(canonicalProjectRepositoryKey(null)).toBeNull();
  });
});
