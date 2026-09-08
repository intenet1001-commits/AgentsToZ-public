import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(join(import.meta.dir, "..", "src", "ProjectMemoryPanel.tsx"), "utf8");

describe("project memory restore-first UX", () => {
  test("checks Supabase before offering local creation", () => {
    expect(source).toContain("const [remoteState, setRemoteState] = useState<ProjectMemoryRemoteState>({ kind: 'checking' })");
    expect(source).toContain("remoteState.kind === 'checking'");
    expect(source).toContain("remoteState.kind === 'error'");
    expect(source).toContain("새 로컬 기억을 만들기 전에 다시 확인해주세요.");
    expect(source).toContain('data-testid="project-memory-check-remote"');
    expect(source).toContain("Supabase에서 확인");
  });

  test("makes the existing remote backup the primary restore action", () => {
    expect(source).toContain('data-testid="project-memory-restore-primary"');
    expect(source).toContain("Supabase에서 기존 기억 복원");
    expect(source).toContain("기존 장기기억 백업을 찾았습니다. 새 PC에서는 이 백업을 먼저 복원하세요.");
  });

  test("keeps divergent local creation advanced, warned, and free of automatic push", () => {
    expect(source).toContain('data-testid="project-memory-advanced-local-create"');
    expect(source).toContain("기존 원격 기억과 별도 흐름으로 분기되어 나중에 충돌할 수 있습니다.");
    expect(source).toContain("const backupAfterInitialize = remote?.exists ? false : autoBackup");
    expect(source).toContain("onClick={() => void initialize(true)}");
  });

  test("offers local creation as primary only after confirming no remote backup", () => {
    expect(source).toContain('data-testid="project-memory-create-primary"');
    expect(source).toContain("Supabase에서 기존 백업을 찾지 못했습니다.");
    expect(source).toContain("로컬 기억 만들기");
  });
});
