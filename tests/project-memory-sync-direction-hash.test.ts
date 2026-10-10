import { describe, expect, test } from "bun:test";
import { resolveProjectMemorySyncDirection } from "../src/projectMemorySyncState";

const BASE = "hash-at-last-sync";
const LOCAL_NEW = "hash-local-changed";
const REMOTE_NEW = "hash-remote-changed";

const ready = (contentHash: string | null, createdAt: string | null, inSync = false) => ({
  kind: 'ready' as const,
  status: { exists: true, createdAt, contentHash, inSync },
});

const resolve = (over: Partial<Parameters<typeof resolveProjectMemorySyncDirection>[0]>) =>
  resolveProjectMemorySyncDirection({
    localExists: true,
    autoBackup: true,
    remote: ready(BASE, "2026-08-08T15:55:39Z"),
    ...over,
  });

describe("project memory sync direction from hashes", () => {
  // Push stamps the remote revision after the local edit that produced it, so a
  // local file whose mtime predates that revision is the normal case, not
  // evidence the remote is newer. Pulling here would discard local memory.
  test("local-only change is a push even when the remote revision is newer in time", () => {
    expect(resolve({
      localUpdatedAt: "2026-08-08T14:19:34Z",
      localContentHash: LOCAL_NEW,
      lastSyncedHash: BASE,
      remote: ready(BASE, "2026-08-08T15:55:39Z"),
    })).toBe("push");
  });

  test("remote-only change is a pull even when the local file was touched later", () => {
    expect(resolve({
      localUpdatedAt: "2026-08-09T09:00:00Z",
      localContentHash: BASE,
      lastSyncedHash: BASE,
      remote: ready(REMOTE_NEW, "2026-08-08T15:55:39Z"),
    })).toBe("pull");
  });

  test("both sides moved off the baseline is a conflict, not a timestamp race", () => {
    expect(resolve({
      localUpdatedAt: "2026-08-09T09:00:00Z",
      localContentHash: LOCAL_NEW,
      lastSyncedHash: BASE,
      remote: ready(REMOTE_NEW, "2026-08-08T15:55:39Z"),
    })).toBe("conflict");
  });

  test("an agreeing remote short-circuits to synced", () => {
    expect(resolve({
      localContentHash: LOCAL_NEW,
      lastSyncedHash: BASE,
      remote: ready(LOCAL_NEW, "2026-08-08T15:55:39Z", true),
    })).toBe("synced");
  });

  // First backup / adopted memory has no agreed baseline to compare against.
  test("without a baseline it falls back to timestamps", () => {
    expect(resolve({
      localUpdatedAt: "2026-08-09T09:00:00Z",
      localContentHash: LOCAL_NEW,
      lastSyncedHash: null,
      remote: ready(REMOTE_NEW, "2026-08-08T15:55:39Z"),
    })).toBe("push");
    expect(resolve({
      localUpdatedAt: "2026-08-07T09:00:00Z",
      localContentHash: LOCAL_NEW,
      lastSyncedHash: null,
      remote: ready(REMOTE_NEW, "2026-08-08T15:55:39Z"),
    })).toBe("pull");
  });

  test("a missing remote hash falls back instead of inventing a direction", () => {
    expect(resolve({
      localUpdatedAt: "2026-08-09T09:00:00Z",
      localContentHash: LOCAL_NEW,
      lastSyncedHash: BASE,
      remote: ready(null, "2026-08-08T15:55:39Z"),
    })).toBe("push");
  });

  test("no remote backup yet is always a push", () => {
    expect(resolveProjectMemorySyncDirection({
      localExists: true,
      autoBackup: true,
      localContentHash: LOCAL_NEW,
      lastSyncedHash: BASE,
      remote: { kind: 'ready', status: { exists: false, createdAt: null, contentHash: null, inSync: false } },
    })).toBe("push");
  });

  test("checking and error states are unchanged", () => {
    expect(resolve({ remote: { kind: 'checking' } })).toBe("checking");
    expect(resolve({ remote: { kind: 'error', message: 'boom' } })).toBe("error");
    expect(resolve({ autoBackup: false })).toBe("not-required");
  });
});
