import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  addLocalOnlyDeletedPortIds,
  normalizeLocalOnlyDeletedPortIds,
  removeLocalOnlyDeletedPortIds,
  withoutLocallyDeletedRemotePorts,
} from "../src/portLocalDeletion";

describe("local-only port deletion tombstones", () => {
  test("keeps local-only deletion across Pull without deleting the remote row", () => {
    const tombstones = addLocalOnlyDeletedPortIds([], ["project", "project_wt_feature"]);
    const remote = [
      { id: "project", name: "Project" },
      { id: "project_wt_feature", name: "Feature" },
      { id: "other", name: "Other" },
    ];
    expect(withoutLocallyDeletedRemotePorts(remote, tombstones)).toEqual([{ id: "other", name: "Other" }]);
    // Filtering is non-destructive: the caller's remote snapshot stays intact.
    expect(remote).toHaveLength(3);
  });

  test("normalizes untrusted portal data and can explicitly restore an ID", () => {
    expect(normalizeLocalOnlyDeletedPortIds(["a", "a", "", 1, "b\0c", "b"]))
      .toEqual(["a", "b"]);
    expect(removeLocalOnlyDeletedPortIds(["a", "b"], ["a"])).toEqual(["b"]);
  });

  test("never evicts an older deletion merely because many tombstones accumulate", () => {
    const ids = Array.from({ length: 2_100 }, (_, index) => `deleted-${index}`);
    const normalized = normalizeLocalOnlyDeletedPortIds(ids);
    expect(normalized).toHaveLength(ids.length);
    expect(normalized[0]).toBe('deleted-0');
    expect(addLocalOnlyDeletedPortIds(normalized, ['deleted-2100'])).toEqual([
      ...ids,
      'deleted-2100',
    ]);
  });

  test("the app persists before local removal and filters both startup and manual Pull", () => {
    const source = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
    const cleanup = source.slice(source.indexOf("const cleanupProject = async"), source.indexOf("const handleSaveMemo"));
    expect(cleanup.indexOf("await persistDeletionMarker(deletion.localDeletionIds, 'add')"))
      .toBeLessThan(cleanup.indexOf("await removeProjectFamilyLocally(item.id)"));
    expect(source.match(/withoutLocallyDeletedRemotePorts\(/g)?.length).toBeGreaterThanOrEqual(2);
    expect(source).toContain("const snapshot = await loadPortsWithFreshLocalMetadataSnapshot()");
    expect(source).toContain("const data = await API.loadPorts();\n    const portalData = await loadAuthoritativePortalConfig();");
    expect(source).toContain("portalData?.verifiedLegacyGeneratedWorktreeIds");
    expect(source).toContain("metadata?.localOnlyDeletedPortIds");
    expect(source).toContain("metadata?.remoteDeletedPortIds");
    expect(source).toContain("const applied = await withPortalSafetyLease(portalData, async lease => {");
    expect(source).toContain("if (lease.fingerprint !== expectedLocalMetadataFingerprint) return false;");
    expect(source).toContain("if (lease.fingerprint !== candidate.localMetadataFingerprint) return null;");
    expect(source).toContain("if (localMetadataAttempt < 1)");
    expect(source).toContain("for (let localMetadataAttempt = 0; localMetadataAttempt < 2; localMetadataAttempt++)");
    expect(source).toContain("autopushReady.current = false");
    expect(source).toContain("const cfg = await loadAuthoritativePortalConfig();");
    expect(source).toContain("const visiblePorts = withoutPortalDeletedPorts(");
    const startupLease = source.slice(
      source.indexOf("const applied = await withPortalSafetyLease(portalData"),
      source.indexOf("if (!applied)", source.indexOf("const applied = await withPortalSafetyLease(portalData")),
    );
    expect(startupLease).not.toContain("loadAuthoritativePortalConfig");
    expect(startupLease.indexOf("await API.savePorts([...updatedData, ...otherPlatformData])"))
      .toBeLessThan(startupLease.indexOf("setPorts(updatedData)"));
    expect(startupLease.indexOf("skipNextSave.current = true"))
      .toBeLessThan(startupLease.indexOf("setPorts(updatedData)"));
    const refreshLease = source.slice(
      source.indexOf("stableRows = await withPortalSafetyLease(candidate.portalData"),
      source.indexOf("if (!stableRows) continue", source.indexOf("stableRows = await withPortalSafetyLease(candidate.portalData")),
    );
    expect(refreshLease).not.toContain("loadAuthoritativePortalConfig");
    expect(refreshLease.indexOf("await API.savePorts(rows)"))
      .toBeLessThan(refreshLease.indexOf("setPorts(rows)"));
    const apiOnlineApply = source.slice(
      source.indexOf("// API 서버가 온라인으로 전환될 때"),
      source.indexOf("// 앱 로그 캡처"),
    );
    expect(apiOnlineApply).toContain("withPortalSafetyLease(portalConfigRef.current, async lease =>");
    expect(apiOnlineApply).not.toContain("if (visibleData.length === 0) return");
    expect(cleanup.indexOf("await persistLocalOnlyDeletedPortIds(deletion.localDeletionIds, 'add')"))
      .toBeLessThan(cleanup.indexOf("await removeProjectFamilyLocally(item.id)"));
    const regularDelete = source.slice(source.indexOf("const handleConfirmDelete = async"), source.indexOf("/**\n   * 프로젝트 정리"));
    expect(regularDelete.indexOf("await persistLocalOnlyDeletedPortIds(deletion.localDeletionIds, 'add')"))
      .toBeLessThan(regularDelete.indexOf("await removeProjectFamilyLocally(id)"));
    const worktreeDelete = source.slice(source.indexOf("const executeWorktreeDelete = useCallback"), source.indexOf("const handleWorktreeMerge"));
    expect(worktreeDelete.indexOf("await persistLocalOnlyDeletedPortIds(markerIds, 'add')"))
      .toBeLessThan(worktreeDelete.indexOf("await API.gitWorktreeRemove"));
    expect(worktreeDelete.indexOf("await API.savePorts"))
      .toBeGreaterThan(worktreeDelete.indexOf("await API.gitWorktreeRemove"));
    expect(worktreeDelete).toContain("const currentWorktrees = await API.listGitWorktrees");
    expect(worktreeDelete).toContain("if (stillRegistered && stillExists)");
    expect(worktreeDelete).toContain("const provenWebPreMutation = new Set([");
    expect(worktreeDelete).toContain(": stillRegistered && provenWebPreMutation");
    expect(worktreeDelete.indexOf("if (stillRegistered && stillExists)"))
      .toBeLessThan(worktreeDelete.lastIndexOf("persistLocalOnlyDeletedPortIds(markerIds, 'remove')"));
    const ensureWorktree = source.slice(source.indexOf("const ensureWtPortEntry = async"), source.indexOf("// 명령 실행 API는 보안상", source.indexOf("const ensureWtPortEntry = async")));
    expect(ensureWorktree).toContain("await persistLocalOnlyDeletedPortIds([wtPortEntry.id], 'remove')");
    expect(ensureWorktree).toContain("durableRemoteDeletedIds.has(wtPortEntry.id)");
    expect(ensureWorktree).toContain("durableRemoteDeletedIds.has(deterministicId)");
    expect(source).toContain("await persistLocalOnlyDeletedPortIds([newEntry.id], 'remove')");
    expect(source).not.toContain("const staleIds = (remoteRows ?? [])");
    expect(source).toContain('data-testid="local-only-deletion-restore"');
  });

  test("manual port mutations share the lease and snapshot extras get a durable fence", () => {
    const source = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
    const snapshotRestore = source.slice(
      source.indexOf("async function restorePortsSnapshot"),
      source.indexOf("const handlePushToSupabase"),
    );
    const firstLease = snapshotRestore.indexOf("withPortalSafetyLease(cfg");
    const markerWrite = snapshotRestore.indexOf("persistRemoteDeletedPortIds(plannedDeleteIds, 'add')");
    const secondLease = snapshotRestore.indexOf("withPortalSafetyLease(cfg", firstLease + 1);
    expect(firstLease).toBeGreaterThan(-1);
    expect(firstLease).toBeLessThan(markerWrite);
    expect(markerWrite).toBeLessThan(secondLease);
    expect(snapshotRestore).toContain("plannedDeleteIds.some(id => !remoteDeleted.has(id))");
    expect(snapshotRestore).toContain("restorePortsSnapshotWithDurableFence(");
    expect(snapshotRestore).toContain("retryPortFenceMutationAfterCommitUnknown(async () =>");
    expect(snapshotRestore).toContain("snapshotOperationIds,");
    expect(snapshotRestore.indexOf("persistRemoteDeletedPortIds(plannedDeleteIds, 'add')"))
      .toBeLessThan(snapshotRestore.indexOf("restorePortsSnapshotWithDurableFence("));
    expect(snapshotRestore).not.toContain("await upsertPortsWithDurableFence(");
    expect(snapshotRestore).not.toContain("await deletePortsWithDurableFence(");
    expect(snapshotRestore).not.toContain(".from('portmgr_ports')\n            .delete()");

    const manualRestore = source.slice(
      source.indexOf("const handleRestoreFromSupabase"),
      source.indexOf("const saveRemappedProjectPaths"),
    );
    expect(manualRestore).toContain("const currentPorts = withoutPortalDeletedPorts(");
    expect(manualRestore).toContain("merged = mergePortsForUpload(currentPorts, mergeRemoteRows, data.map(portUploadMetadataFromRemote))");
    expect(manualRestore.indexOf("lockedPortalData,"))
      .toBeLessThan(manualRestore.indexOf("merged = mergePortsForUpload(currentPorts, mergeRemoteRows, data.map(portUploadMetadataFromRemote))"));

    const manualPush = source.slice(
      source.indexOf("const handlePushToSupabase"),
      source.indexOf("// 동시 실행 수 제한 풀"),
    );
    const pushLease = manualPush.indexOf("withPortalSafetyLease(portalData");
    const portsUpsert = manualPush.indexOf("upsertPortsWithDurableFence(");
    const deviceUpsert = manualPush.indexOf("supabase.from('portmgr_devices').upsert");
    expect(pushLease).toBeGreaterThan(-1);
    expect(pushLease).toBeLessThan(portsUpsert);
    expect(portsUpsert).toBeLessThan(deviceUpsert);
    expect(manualPush.slice(pushLease, deviceUpsert)).toContain("return { ownedPorts }");
    expect(manualPush).not.toContain("supabase.from('portmgr_ports').upsert");
  });
});
