import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendProjectMemoryJournal,
  buildProjectMemoryJournalEntry,
  initializeProjectMemory,
  projectMemoryPrivateGitHubArchiveSnapshot,
} from "../project-memory-server";

const apiSource = readFileSync(new URL("../api-server.ts", import.meta.url), "utf8");
const panelSource = readFileSync(new URL("../src/ProjectMemoryPanel.tsx", import.meta.url), "utf8");
const appSource = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Private GitHub archive integration", () => {
  test("builds an allowlisted snapshot from initialized memory and verified journals", () => {
    const root = mkdtempSync(join(tmpdir(), "agentstoz-private-archive-integration-"));
    roots.push(root);
    mkdirSync(join(root, "project"));
    const project = join(root, "project");
    const initialized = initializeProjectMemory({
      folderPath: project,
      projectName: "Archive Integration",
      agent: "codex",
      autoBackup: true,
    });
    appendProjectMemoryJournal(project, buildProjectMemoryJournalEntry({
      recordedAt: "2026-08-28T00:00:00.000Z",
      narrative: "Private cold archive keeps only verified session evidence.",
    }));

    const snapshot = projectMemoryPrivateGitHubArchiveSnapshot({ folderPath: project });
    expect(snapshot.projectRoot).toBe(initialized.projectRoot);
    expect(snapshot.memoryId).toBe(initialized.config!.memoryId);
    expect(snapshot.core).toContain("Archive Integration");
    expect(snapshot.verifiedJournalEntries.length).toBeGreaterThanOrEqual(2);
    expect(snapshot.verifiedJournalEntries.every(entry => /^[0-9a-f]{16}$/.test(entry.entryHash))).toBe(true);
    expect(snapshot.verifiedJournalEntries.some(entry => entry.summary.includes("Private cold archive"))).toBe(true);
  });

  test("exposes explicit status, enable, run, and non-destructive disable routes", () => {
    for (const route of ["status", "enable", "run", "disable"]) {
      expect(apiSource).toContain(`/api/project-memory/private-github-archive/${route}`);
    }
    expect(apiSource).toContain("remoteDeleted: false");
    expect(apiSource).toContain("result.success === true) queueEnabledProjectMemoryPrivateGitHubArchive");
    expect(apiSource).toContain("result.localSaved === true) queueEnabledProjectMemoryPrivateGitHubArchive");
  });

  test("keeps automatic archive detached and records its latest result", () => {
    const helper = apiSource.slice(
      apiSource.indexOf("function queueEnabledProjectMemoryPrivateGitHubArchive"),
      apiSource.indexOf("const CONTEXT_SESSION_ID_RE"),
    );
    expect(helper).toContain("projectMemoryPrivateArchiveQueue");
    expect(helper).toContain("const key = record.repositoryUrl");
    expect(helper).toContain("expectedRepositoryId: currentRecord.repositoryId");
    expect(helper).toContain(".catch(() => undefined)");
    expect(helper).toContain("recordProjectMemoryPrivateGitHubArchiveResult");
    expect(helper).not.toContain("await queueEnabledProjectMemoryPrivateGitHubArchive");
  });

  test("places the opt-in next to memory sync and explains Private repository boundaries", () => {
    expect(panelSource).toContain('data-testid="project-memory-private-github-archive"');
    expect(panelSource).toContain('data-testid="project-memory-private-github-archive-enable"');
    expect(panelSource).toContain('data-testid="project-memory-private-github-archive-run"');
    expect(panelSource).toContain('data-testid="project-memory-private-github-archive-disable"');
    expect(panelSource).toContain("Supabase가 일상 동기화 정본");
    expect(panelSource).toContain("협업자·계정 접근자는 볼 수 있습니다");
    expect(panelSource).toContain("원격 branch를 삭제하지 않습니다");
    expect(appSource).toContain('data-testid="github-private-memory-archive-option"');
    expect(appSource).toContain("Private 협업자·계정 접근자는 열람 가능");
    expect(appSource).toContain("enablePrivateGitHubArchive");
    expect(appSource).toContain("저장소는 만들었지만 장기기억 보관은 켜지지 않았습니다");
  });
});
