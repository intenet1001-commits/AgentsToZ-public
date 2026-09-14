import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { projectMemoryBackupState } from "../project-memory-server";
import { projectMemoryBackupFailure } from "../src/projectMemoryBackupResult";

describe("project memory multi-component backup truthfulness", () => {
  test("a saved revision plus journal failure is not a complete backup", () => {
    expect(projectMemoryBackupState({
      contentBackedUp: true,
      journalError: "journal insert denied",
    })).toEqual({
      contentBackedUp: true,
      journalBackedUp: false,
      feedbackSynced: true,
      backupComplete: false,
    });
  });

  test("already-synced content plus feedback failure is not a complete backup", () => {
    expect(projectMemoryBackupState({
      contentBackedUp: true,
      feedbackError: "feedback unavailable",
    })).toEqual({
      contentBackedUp: true,
      journalBackedUp: true,
      feedbackSynced: false,
      backupComplete: false,
    });
  });

  test("all three planes must succeed", () => {
    expect(projectMemoryBackupState({ contentBackedUp: true })).toEqual({
      contentBackedUp: true,
      journalBackedUp: true,
      feedbackSynced: true,
      backupComplete: true,
    });
    expect(projectMemoryBackupState({ contentBackedUp: false }).backupComplete).toBe(false);
  });

  test("direct Push and session-end partial results produce error guidance", () => {
    expect(projectMemoryBackupFailure({
      backupComplete: false,
      contentBackedUp: true,
      journalBackedUp: false,
      journalError: "journal insert denied",
    })).toContain("journal insert denied");
    expect(projectMemoryBackupFailure({
      localSaved: true,
      remoteBackedUp: false,
      backupError: "feedback unavailable",
    })).toContain("feedback unavailable");
    expect(projectMemoryBackupFailure({ backupComplete: true })).toBeNull();
    expect(projectMemoryBackupFailure({ localSaved: true, remoteBackedUp: false, backupSkipped: true })).toBeNull();
  });

  test("session-end and UI use backupComplete rather than generic success", () => {
    const server = readFileSync(join(import.meta.dir, "..", "project-memory-server.ts"), "utf8");
    const panel = readFileSync(join(import.meta.dir, "..", "src", "ProjectMemoryPanel.tsx"), "utf8");
    const sessionEnd = server.slice(server.indexOf("export async function sessionEndProjectMemory"));
    expect(sessionEnd).toContain("const remoteComplete = remote.backupComplete === true");
    expect(sessionEnd).toContain("remoteBackedUp: remoteComplete");
    expect(panel).toContain("const backupFailure = projectMemoryBackupFailure(result)");
    expect(panel).toContain("const surfacedFailure = backupFailure ?? promptCaptureFailure");
    expect(panel).toContain("notify(surfacedFailure ?? success(result), surfacedFailure ? 'error' : 'success')");
  });
});

test('V2 no-op and pending backups cannot report session completion or remote success',()=>{
  expect(projectMemoryBackupFailure({automaticMemory:{state:'idle'},localSaved:false})).toContain('새로 저장한 대화가 없습니다');
  expect(projectMemoryBackupFailure({automaticMemory:{state:'saved'},localSaved:true,backupPending:true,remoteBackedUp:false})).toContain('백업은 대기 중');
});
