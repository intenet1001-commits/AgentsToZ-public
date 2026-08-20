import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  extractProjectMemorySection,
  replaceProjectMemorySection,
  selectProjectMemoryUpdateSection,
} from "../project-memory-server";
import { splitMemoryDocument } from "../src/projectMemoryDocument";

const document = `# Project Core Memory

**Last Updated**: 2026-08-18

## Key Decisions

### Keep data
<!-- memory-entry-id:111111111111111111111111 -->

Decision body.

## Recurring Issues

### Slow full rewrite
<!-- memory-entry-id:222222222222222222222222 -->

Issue body.
`;

describe("targeted project-memory updates", () => {
  test("session evidence selects the relevant note before an unrelated overweight note", () => {
    const title = selectProjectMemoryUpdateSection(
      splitMemoryDocument(document),
      "세션 기억이 오래 걸리다가 타임아웃으로 실패한 원인을 확인했다",
      "Key Decisions",
    );

    expect(title).toBe("Recurring Issues");
  });

  test("an overweight note is selected when there is no routing evidence", () => {
    expect(selectProjectMemoryUpdateSection(
      splitMemoryDocument(document),
      "",
      "Key Decisions",
    )).toBe("Key Decisions");
  });

  test("accepts exactly one requested section and rejects a whole-document rewrite", () => {
    const section = extractProjectMemorySection(
      "SESSION: 느린 전체 재생성을 노트 단위 갱신으로 바꿨다.\n\n## Recurring Issues\n\nUpdated.\n",
      "Recurring Issues",
    );
    expect(section).toBe("## Recurring Issues\n\nUpdated.\n\n");

    expect(() => extractProjectMemorySection(
      "## Recurring Issues\n\nUpdated.\n\n## Key Decisions\n\nUnexpected.\n",
      "Recurring Issues",
    )).toThrow(/섹션 하나만/);
  });

  test("replaces only the selected note and updates the generated preamble date", () => {
    const next = replaceProjectMemorySection(
      document,
      "Recurring Issues",
      "## Recurring Issues\n\n### Fast local update\n<!-- memory-entry-id:222222222222222222222222 -->\n\nUpdated.\n",
      "2026-08-19",
    );

    expect(next).toContain("**Last Updated**: 2026-08-19");
    expect(next).toContain("### Keep data\n<!-- memory-entry-id:111111111111111111111111 -->\n\nDecision body.");
    expect(next).toContain("### Fast local update");
    expect(next).not.toContain("Issue body.");
  });

  test("large-memory path sends one section and Claude receives the prompt on stdin", () => {
    const source = readFileSync(join(import.meta.dir, "..", "project-memory-server.ts"), "utf8");
    const runner = source.slice(source.indexOf("async function runProjectMemoryAgent"), source.indexOf("export function extractSessionNarrative"));
    const updater = source.slice(source.indexOf("export async function updateProjectMemory"), source.indexOf("\nfunction loadPortalConfig"));

    expect(runner).toContain('[resolveAgentBin("claude"), "--safe-mode", "-p", "--no-session-persistence"]');
    expect(runner).toContain("300_000,\n      prompt,");
    expect(updater).toContain("return ONLY the complete updated section");
    expect(updater).toContain("projectUpdateContext(root)");
    expect(updater).toContain("replaceProjectMemorySection(");
  });

  test("the UI makes a long-running save observable against its timeout", () => {
    const panel = readFileSync(join(import.meta.dir, "..", "src", "ProjectMemoryPanel.tsx"), "utf8");

    expect(panel).toContain("busyElapsedSeconds");
    expect(panel).toContain("세션 기억 중… ${busyElapsedLabel} / 최대 05:00");
  });
});
