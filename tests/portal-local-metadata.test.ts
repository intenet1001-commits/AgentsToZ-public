import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  dispatchPortalLocalMetadata,
  mutatePortalLocalMetadata,
  portalLocalMetadataFingerprint,
  preservePortalLocalMetadata,
  runPortalDataWriteExclusive,
} from "../src/portalLocalMetadata";

describe("authoritative portal-local metadata", () => {
  test("normalizes and de-duplicates all three local safety marker lists", () => {
    const incoming = {
      items: [{ id: "bookmark" }],
      localOnlyDeletedPortIds: ["stale-incoming"],
      remoteDeletedPortIds: ["stale-remote"],
      verifiedLegacyGeneratedWorktreeIds: ["stale-legacy"],
    };

    const safe = preservePortalLocalMetadata(incoming, {
      localOnlyDeletedPortIds: ["deleted-a", "deleted-a", "", 7, "bad\0id", "deleted-b"] as any,
      remoteDeletedPortIds: ["remote-a", undefined, "remote-a", "remote-b"] as any,
      verifiedLegacyGeneratedWorktreeIds: ["legacy-a", null, "legacy-a", "legacy-b"] as any,
    });

    expect(safe).toEqual({
      items: [{ id: "bookmark" }],
      localOnlyDeletedPortIds: ["deleted-a", "deleted-b"],
      remoteDeletedPortIds: ["remote-a", "remote-b"],
      verifiedLegacyGeneratedWorktreeIds: ["legacy-a", "legacy-b"],
    });
    expect(incoming.localOnlyDeletedPortIds).toEqual(["stale-incoming"]);
    expect(incoming.remoteDeletedPortIds).toEqual(["stale-remote"]);
    expect(incoming.verifiedLegacyGeneratedWorktreeIds).toEqual(["stale-legacy"]);
  });

  test("a stale full portal import/write preserves the current authoritative markers", () => {
    const staleFullPortalPayload = {
      items: [{ id: "new-bookmark", name: "Imported bookmark" }],
      categories: [{ id: "new-category", name: "Imported" }],
      localOnlyDeletedPortIds: [],
      remoteDeletedPortIds: ["obsolete-remote-marker"],
      verifiedLegacyGeneratedWorktreeIds: ["obsolete-marker"],
    };
    const currentLocalMetadata = {
      localOnlyDeletedPortIds: ["deleted-project", "deleted-worktree"],
      remoteDeletedPortIds: ["supabase-deleted-project", "supabase-deleted-worktree"],
      verifiedLegacyGeneratedWorktreeIds: ["verified-worktree"],
    };

    expect(preservePortalLocalMetadata(staleFullPortalPayload, currentLocalMetadata)).toEqual({
      items: staleFullPortalPayload.items,
      categories: staleFullPortalPayload.categories,
      localOnlyDeletedPortIds: ["deleted-project", "deleted-worktree"],
      remoteDeletedPortIds: ["supabase-deleted-project", "supabase-deleted-worktree"],
      verifiedLegacyGeneratedWorktreeIds: ["verified-worktree"],
    });
  });

  test("an explicitly empty authoritative sidecar blocks stale marker resurrection", () => {
    const staleFullPortalPayload = {
      items: [{ id: "bookmark" }],
      localOnlyDeletedPortIds: ["already-restored-project"],
      remoteDeletedPortIds: ["stale-remote-deletion"],
      verifiedLegacyGeneratedWorktreeIds: ["already-cleared-legacy-row"],
    };

    expect(preservePortalLocalMetadata(staleFullPortalPayload, {
      localOnlyDeletedPortIds: [],
      remoteDeletedPortIds: [],
      verifiedLegacyGeneratedWorktreeIds: [],
    })).toEqual({
      items: [{ id: "bookmark" }],
      localOnlyDeletedPortIds: [],
      remoteDeletedPortIds: [],
      verifiedLegacyGeneratedWorktreeIds: [],
    });
  });

  test("applies add and remove deltas to the latest authoritative value", () => {
    const first = mutatePortalLocalMetadata({
      localOnlyDeletedPortIds: ["existing"],
      remoteDeletedPortIds: ["remote-existing"],
      verifiedLegacyGeneratedWorktreeIds: ["verified"],
    }, {
      field: "localOnlyDeletedPortIds",
      mode: "add",
      ids: ["added", "existing"],
    });
    expect(first).toEqual({
      localOnlyDeletedPortIds: ["added", "existing"],
      remoteDeletedPortIds: ["remote-existing"],
      verifiedLegacyGeneratedWorktreeIds: ["verified"],
    });
    expect(mutatePortalLocalMetadata(first, {
      field: "localOnlyDeletedPortIds",
      mode: "remove",
      ids: ["added"],
    })).toEqual({
      localOnlyDeletedPortIds: ["existing"],
      remoteDeletedPortIds: ["remote-existing"],
      verifiedLegacyGeneratedWorktreeIds: ["verified"],
    });

    const remoteAdded = mutatePortalLocalMetadata(first, {
      field: "remoteDeletedPortIds",
      mode: "add",
      ids: ["remote-added", "remote-existing"],
    });
    expect(remoteAdded).toEqual({
      localOnlyDeletedPortIds: ["added", "existing"],
      remoteDeletedPortIds: ["remote-added", "remote-existing"],
      verifiedLegacyGeneratedWorktreeIds: ["verified"],
    });
    expect(mutatePortalLocalMetadata(remoteAdded, {
      field: "remoteDeletedPortIds",
      mode: "remove",
      ids: ["remote-added"],
    }).remoteDeletedPortIds).toEqual(["remote-existing"]);
  });

  test("fingerprints all deletion and restore generations without treating order as data", () => {
    const original = {
      localOnlyDeletedPortIds: ["deleted-b", "deleted-a"],
      remoteDeletedPortIds: ["remote-b", "remote-a"],
      verifiedLegacyGeneratedWorktreeIds: ["legacy-a"],
    };
    expect(portalLocalMetadataFingerprint(original)).toBe(portalLocalMetadataFingerprint({
      localOnlyDeletedPortIds: ["deleted-a", "deleted-b"],
      remoteDeletedPortIds: ["remote-a", "remote-b"],
      verifiedLegacyGeneratedWorktreeIds: ["legacy-a"],
    }));
    expect(portalLocalMetadataFingerprint(original)).not.toBe(portalLocalMetadataFingerprint({
      localOnlyDeletedPortIds: ["deleted-a", "deleted-b", "deleted-c"],
      remoteDeletedPortIds: ["remote-a", "remote-b"],
      verifiedLegacyGeneratedWorktreeIds: ["legacy-a"],
    }));
    expect(portalLocalMetadataFingerprint(original)).not.toBe(portalLocalMetadataFingerprint({
      localOnlyDeletedPortIds: ["deleted-a"],
      remoteDeletedPortIds: ["remote-a", "remote-b"],
      verifiedLegacyGeneratedWorktreeIds: ["legacy-a"],
    }));
    expect(portalLocalMetadataFingerprint(original)).not.toBe(portalLocalMetadataFingerprint({
      localOnlyDeletedPortIds: ["deleted-a", "deleted-b"],
      remoteDeletedPortIds: ["remote-a", "remote-b", "remote-c"],
      verifiedLegacyGeneratedWorktreeIds: ["legacy-a"],
    }));
  });

  test("dispatches the normalized remote deletion set with the other local metadata", () => {
    const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
    const customEventDescriptor = Object.getOwnPropertyDescriptor(globalThis, "CustomEvent");
    const events: Array<{ type: string; detail: unknown }> = [];
    class TestCustomEvent {
      constructor(public type: string, public init: { detail: unknown }) {}
      get detail() { return this.init.detail; }
    }
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        dispatchEvent: (event: TestCustomEvent) => events.push({
          type: event.type,
          detail: event.detail,
        }),
      },
    });
    Object.defineProperty(globalThis, "CustomEvent", {
      configurable: true,
      value: TestCustomEvent,
    });
    try {
      dispatchPortalLocalMetadata({
        localOnlyDeletedPortIds: ["local", "local"],
        remoteDeletedPortIds: ["remote", "remote", "bad\0id"],
        verifiedLegacyGeneratedWorktreeIds: ["verified"],
      });
      expect(events).toEqual([{
        type: "agentstoz:portal-local-metadata",
        detail: {
          localOnlyDeletedPortIds: ["local"],
          remoteDeletedPortIds: ["remote"],
          verifiedLegacyGeneratedWorktreeIds: ["verified"],
        },
      }]);
    } finally {
      if (windowDescriptor) Object.defineProperty(globalThis, "window", windowDescriptor);
      else delete (globalThis as any).window;
      if (customEventDescriptor) Object.defineProperty(globalThis, "CustomEvent", customEventDescriptor);
      else delete (globalThis as any).CustomEvent;
    }
  });
});

describe("portal data write serialization", () => {
  test("queues read/merge/write operations and continues after a failed writer", async () => {
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = runPortalDataWriteExclusive(async () => {
      events.push("first:start");
      await firstGate;
      events.push("first:end");
      return "first-result";
    });
    const second = runPortalDataWriteExclusive(async () => {
      events.push("second:start");
      events.push("second:end");
      return "second-result";
    });

    await Promise.resolve();
    expect(events).toEqual(["first:start"]);
    releaseFirst();
    expect(await Promise.all([first, second])).toEqual(["first-result", "second-result"]);
    expect(events).toEqual(["first:start", "first:end", "second:start", "second:end"]);

    const failed = runPortalDataWriteExclusive(async () => {
      events.push("failed:start");
      throw new Error("expected writer failure");
    });
    const afterFailure = runPortalDataWriteExclusive(async () => {
      events.push("after-failure:start");
      return "recovered";
    });

    await expect(failed).rejects.toThrow("expected writer failure");
    expect(await afterFailure).toBe("recovered");
    expect(events.slice(-2)).toEqual(["failed:start", "after-failure:start"]);
  });
});

describe("portal-local metadata storage contract", () => {
  const apiSource = readFileSync(new URL("../api-server.ts", import.meta.url), "utf8");
  const appSource = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  const portalManagerSource = readFileSync(new URL("../src/PortalManager.tsx", import.meta.url), "utf8");
  const rustSource = readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");

  test("API full writes preserve the sidecar and explicit empty metadata remains authoritative", () => {
    expect(apiSource).toContain("preservePortalLocalMetadata");
    expect(apiSource).toContain('const PORTAL_LOCAL_METADATA_FILE = join(APP_DATA_DIR, "portal-local-metadata.json")');
    expect(apiSource).toContain("existsSync(PORTAL_LOCAL_METADATA_FILE)\n    ? readPortalJson(PORTAL_LOCAL_METADATA_FILE)\n    : portal");
    expect(apiSource).toContain("const next = preservePortalLocalMetadata(data, authoritativePortalLocalMetadata(current))");
    expect(apiSource).toContain('url.pathname === "/api/portal/local-metadata" && req.method === "PUT"');
    expect(apiSource).toContain("mutatePortalLocalMetadata(authoritativePortalLocalMetadata(current), {");
    expect(apiSource).toContain("writePortalJsonAtomic(PORTAL_LOCAL_METADATA_FILE, next)");
    expect(apiSource).toContain('const PORTAL_LOCK_FILE = join(APP_DATA_DIR, "portal.json.lock")');
    expect(apiSource).toContain("await withPortalFileLock");
  });

  test("Tauri full writes preserve the sidecar and exposes a dedicated metadata command", () => {
    expect(rustSource).toContain('"remoteDeletedPortIds"');
    expect(rustSource).toContain('app_data_dir.join("portal-local-metadata.json")');
    expect(rustSource).toContain("if metadata_file.exists()");
    expect(rustSource).toContain("merge_portal_local_metadata(&mut data, &authoritative)");
    expect(rustSource).toContain("fn save_portal_local_metadata(");
    expect(rustSource).toContain("mutate_portal_local_metadata(&mut metadata, &field, &ids, &mode)");
    expect(rustSource).toContain("save_portal_local_metadata,");
    expect(rustSource).toContain('acquire_portal_file_lock(&app_data_dir)');
  });

  test("renderer local-marker writes use only the dedicated API while full writes serialize and preserve", () => {
    expect(portalManagerSource).toContain("remoteDeletedPortIds?: string[]");
    const localWriter = appSource.slice(
      appSource.indexOf("const persistPortalLocalIdField"),
      appSource.indexOf("const persistLocalOnlyDeletedPortIds"),
    );
    expect(localWriter).toContain("runPortalDataWriteExclusive");
    expect(localWriter).toContain("invoke('save_portal_local_metadata'");
    expect(localWriter).toContain("fetch('/api/portal/local-metadata'");
    expect(localWriter).not.toContain("invoke('save_portal',");

    const fullWriter = portalManagerSource.slice(
      portalManagerSource.indexOf("async save(data: PortalData)"),
      portalManagerSource.indexOf("async save(data: PortalData)") + 2_000,
    );
    expect(fullWriter).toContain("runPortalDataWriteExclusive");
    expect(fullWriter).toContain("preservePortalLocalMetadata(data, authoritative)");
  });
});
