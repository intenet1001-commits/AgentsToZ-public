import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { MEMORY_BUDGET_BYTES, CURRENT_MEMORY_AGENT_VERSION } from "../project-memory-server";

const source = readFileSync(join(import.meta.dir, "..", "project-memory-server.ts"), "utf8");

function updateProjectMemoryBody(): string {
  const start = source.indexOf("export async function updateProjectMemory");
  const end = source.indexOf("\nfunction loadPortalConfig", start);
  return source.slice(start, end);
}

describe("project memory size budget", () => {
  // 실행 시간이 문서 크기에 정비례하므로, 예산이 1MB 하드 한도보다 훨씬 작아야
  // "세션 기억하기"가 느려지는 것을 실제로 막을 수 있다.
  test("budget is far below the 1MB hard limit", () => {
    expect(MEMORY_BUDGET_BYTES).toBeGreaterThan(0);
    expect(MEMORY_BUDGET_BYTES).toBeLessThan(100_000);
  });

  // 파일 전체 예산은 "네 출력 바이트를 세어라"는 지시라 세 번 연속 실패했다
  // (43,290 → 43,799, 예산 42,000). 이름이 붙은 섹션 하나 + 실제 크기 + 목표치는
  // 모델이 확인할 수 있는 지시다.
  test("the prompt names the selected over-budget section, with its size and target", () => {
    const body = updateProjectMemoryBody();
    expect(body).toContain("COMPACTION TARGET");
    expect(body).toContain("${targetedPart.title}");
    expect(body).toContain("${targetedPart.bytes} bytes");
    expect(body).toContain("${MEMORY_NOTE_BUDGET_BYTES}-byte per-section budget");
  });

  test("compaction is scoped to the one selected section", () => {
    const body = updateProjectMemoryBody();
    expect(body).toContain("selectMemoryNoteToCompact");
    expect(body).toContain("targetedPart && targetedPart.bytes > MEMORY_NOTE_BUDGET_BYTES");
    expect(body).toContain("return ONLY the complete updated section");
    expect(body).toContain("do not return any other ## section");
  });

  // 실측 2026-08-09: 분해가 처음 일어나는 실행에는 manifest가 아직 없어서
  // manifest 기반 조회가 "예산 넘는 섹션 없음"을 반환했고, 문서가 가장 큰 바로 그
  // 실행에서 압축 지시가 빠졌다 (Key Decisions 19,896 → 22,233, 예산 12,000).
  test("the over-budget section is measured from the document, not from the stored manifest", () => {
    const body = updateProjectMemoryBody();
    expect(body).toContain("const currentSections = splitMemoryDocument(current)");
    expect(body).toContain("const currentManifest = buildMemoryNoteManifest(currentSections).manifest");
    expect(body).toContain("selectMemoryNoteToCompact(currentManifest)");
    expect(body).not.toContain("selectMemoryNoteToCompact(readMemoryManifest(root)");
  });

  // 버튼 경로에는 세션이 없어서 저널에 커밋 제목만 남았다. 통합 호출은 무엇이
  // 바뀌었는지 이미 알고 있으므로, 한 줄을 함께 받는 데 드는 추가 비용이 없다.
  test("the consolidation call also returns the journal narrative", () => {
    const body = updateProjectMemoryBody();
    expect(body).toContain('FIRST LINE of your reply must be "SESSION: "');
    expect(body).toContain("extractSessionNarrative(raw)");
    expect(body).toContain("markProjectMemoryRemembered({ folderPath: root, narrative })");
  });

  test("the server supplies today's date instead of letting the agent guess it", () => {
    const body = updateProjectMemoryBody();
    expect(body).toContain("replaceProjectMemorySection(");
    expect(body).toContain("today,");
    expect(body).not.toContain("Update the Last Updated date to today.");
  });

  // 예산 초과는 다음 실행이 느려진다는 신호일 뿐이다. 여기서 던지면 이미 디스크에
  // 저장된 기억을 사용자가 에러로만 보게 되고 되돌릴 방법도 없다.
  test("over-budget is reported, never thrown, after the local write", () => {
    const body = updateProjectMemoryBody();
    expect(body).toContain("overBudget: stillOverweight !== null");
    const writeIndex = body.indexOf("writeMemoryDocument(root, memoryPath, next)");
    // 시그니처의 `overBudget: boolean`이 아니라 실제 반환값 계산 지점을 찾는다.
    const reportIndex = body.indexOf("overBudget: stillOverweight");
    expect(writeIndex).toBeGreaterThan(-1);
    expect(reportIndex).toBeGreaterThan(writeIndex);
    expect(body).not.toContain("throw new Error(\"장기기억 문서가 예산");
  });

  test("the generated remember-session skill carries the same budget", () => {
    const start = source.indexOf("function rememberSessionSkillTemplate");
    const end = source.indexOf("\nfunction ", start + 1);
    const template = source.slice(start, end);
    expect(template).toContain("${MEMORY_NOTE_BUDGET_BYTES} bytes");
    expect(template).toContain("${MEMORY_BUDGET_BYTES} bytes");
    expect(template).toContain("never delete a durable decision outright");
    // An agent that edits the generated index loses its work on the next save.
    expect(template).toContain("Write to the notes, never to the");
  });

  // 이미 설치된 프로젝트는 마커 버전으로만 재생성 대상을 판단한다.
  // 스킬 본문을 바꾸고 버전을 안 올리면 기존 프로젝트에는 영영 반영되지 않는다.
  test("skill template change ships with an agent version bump", () => {
    expect(CURRENT_MEMORY_AGENT_VERSION).toBeGreaterThanOrEqual(5);
  });
});
