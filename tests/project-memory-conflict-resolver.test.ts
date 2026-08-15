import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const panel = readFileSync(join(root, 'src/ProjectMemoryPanel.tsx'), 'utf8');
const server = readFileSync(join(root, 'project-memory-server.ts'), 'utf8');
const api = readFileSync(join(root, 'api-server.ts'), 'utf8');

describe('project-memory conflict resolver contract', () => {
  test('shows both versions and requires a second explicit confirmation', () => {
    expect(panel).toContain('project-memory-conflict-resolver');
    expect(panel).toContain('projectMemoryContentPreview(version.content)');
    expect(panel).toContain('project-memory-conflict-keep-local');
    expect(panel).toContain('project-memory-conflict-use-remote');
    expect(panel).toContain('project-memory-conflict-confirm-apply');
    expect(panel).toContain('AI 병합용 전문 복사');
    expect(panel).toContain('외부 AI 채팅에 붙여넣으면 프로젝트 정보가 외부 서비스로 전송될 수 있습니다.');
    expect(panel).not.toContain('window.confirm(\'원격 기억이 마지막 동기화 이후 변경되었습니다.');
    expect(panel).not.toContain('window.confirm(\'로컬과 원격 기억이 모두 변경되었습니다.');
  });

  test('sends the previewed hashes and revision to a guarded resolver endpoint', () => {
    expect(panel).toContain("/api/project-memory/resolve-conflict");
    expect(panel).toContain('expectedLocalHash: conflict.localContentHash');
    expect(panel).toContain('expectedRemoteRevisionId: conflict.remoteRevisionId');
    expect(api).toContain('"/api/project-memory/resolve-conflict"');
    expect(server).toContain('export async function resolveProjectMemoryConflict');
    expect(server).toContain('input.expectedLocalHash !== localHash');
    expect(server).toContain('input.expectedRemoteRevisionId !== latest.id');
  });

  test('preserves an older remote revision and backs up local before remote restore', () => {
    expect(server).toContain('parent_revision_id: latest.id');
    expect(server).toContain('const backupPath = backupMemory(root, local.memoryPath)');
    expect(server).toContain('const incomingMigration = installIncomingProjectMemoryContent({');
    expect(server).toContain('content: remoteContent');
    expect(server).toContain('...incomingMigration');
    expect(server).toContain('verifiedRemoteMemoryContent');
  });

  test('uses atomic CAS for normal pushes and conflict-resolution appends', () => {
    const directInsert = '.from("portmgr_project_memory_revisions").insert';
    expect(server).not.toContain(directInsert);
    expect(server.match(/appendProjectMemoryRevisionCas\(sb, revision\)/g)?.length).toBe(2);
    expect(server).toContain('concurrentWrite: true');
    expect(server).toContain('portmgr_append_project_memory_revision');
  });

  test('offers a reviewed merge draft and saves it through the same stale-guarded append path', () => {
    expect(panel).toContain('project-memory-conflict-merge');
    expect(panel).toContain('project-memory-conflict-merge-draft');
    expect(panel).toContain('project-memory-conflict-confirm-merge');
    expect(panel).toContain('mergedContent: mergeDraft');
    expect(panel).toContain('병합본 검토·입력');
    expect(server).toContain('strategy: "keep-local" | "use-remote" | "merged"');
    expect(server).toContain('input.strategy === "keep-local" || input.strategy === "merged"');
    expect(server).toContain('const backupPath = needsLocalWrite ? backupMemory(root, local.memoryPath) : null;');
    expect(server).toContain('writeMemoryDocument(root, local.memoryPath, content)');
    expect(server).toContain('const content = stabilizeProjectMemoryEntryIds(requestedContent, previousIdentity)');
    expect(server).toContain('input.strategy === "merged" || entryIdsStabilized');
    expect(server).toContain('entryIdsStabilized,');
    expect(server).toContain('input.expectedLocalHash !== localHash');
    expect(server).toContain('input.expectedRemoteRevisionId !== latest.id');
    expect(api).toContain('body.strategy !== "merged"');
    expect(api).toContain('body.strategy === "merged" && typeof body.mergedContent !== "string"');
    expect(api).toContain('mergedContent: body.strategy === "merged" ? body.mergedContent : undefined');
  });
});
