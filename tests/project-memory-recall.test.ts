import { describe, expect, test } from "bun:test";
import {
  inspectProjectMemoryQuality,
  parseProjectMemoryEntries,
  recallProjectMemoryEntries,
  stabilizeProjectMemoryEntryIds,
  type ProjectMemoryFeedbackSummary,
} from "../src/projectMemoryRecall";
import { projectMemoryFeedbackScopeKey } from "../src/projectMemoryFeedback";

const memory = `# Project Core Memory

## Key Decisions

### Supabase 동기화는 content hash를 기준으로 한다
타임스탬프는 Push 시각 때문에 방향을 거꾸로 판단할 수 있다.

### UI 색상
기본 강조색은 teal이다.

## Active Constraints

### 원격 최신본 확인 없이 덮어쓰지 않는다
공유 프로젝트는 작업 전 Pull하고 양쪽이 바뀌면 conflict로 중단한다.

## Recurring Issues

### Supabase 동기화 충돌
여러 clone에서 동시에 Push하면 sibling revision이 생길 수 있다.

## Contested Entries

### 자동 병합 가능 여부
자동 병합은 아직 검증되지 않았으며 사용자 검토가 필요하다.
`;

describe("project-memory bounded recall", () => {
  test("parses durable entries and ignores headings inside fenced examples", () => {
    const entries = parseProjectMemoryEntries(`${memory}\n\n## Validated Workflows\n\n### 배포\n\`\`\`md\n### 가짜 제목\n\`\`\`\n실제 본문\n`);
    expect(entries.map(entry => entry.title)).toContain("배포");
    expect(entries.map(entry => entry.title)).not.toContain("가짜 제목");
    expect(entries.find(entry => entry.title === "배포")?.body).toContain("가짜 제목");
  });

  test("a shorter same-character fence cannot close a longer outer fence", () => {
    const markdown = [
      "## Key Decisions",
      "",
      "### Real entry",
      "Before example.",
      "````md",
      "```md",
      "### Example only",
      "```",
      "Still inside the four-backtick fence.",
      "````",
      "After example.",
      "",
    ].join("\n");

    const entries = parseProjectMemoryEntries(markdown);
    expect(entries.map(entry => entry.title)).toEqual(["Real entry"]);
    expect(entries[0]?.body).toContain("### Example only");
    const stabilized = stabilizeProjectMemoryEntryIds(markdown);
    expect(stabilized.match(/<!-- memory-entry-id:/g)).toHaveLength(1);
    expect(stabilized).not.toMatch(/### Example only\n<!-- memory-entry-id:/);
  });

  test("keeps an explicit logical entry id across rename and section moves while versioning body content", () => {
    const id = "a".repeat(24);
    const original = parseProjectMemoryEntries(`## Key Decisions\n\n### Original title\n<!-- memory-entry-id:${id} -->\nSame durable meaning.\n`)[0]!;
    const moved = parseProjectMemoryEntries(`## Active Constraints\n\n### Renamed title\n<!-- memory-entry-id:${id} -->\nSame durable meaning.\n`)[0]!;
    const changed = parseProjectMemoryEntries(`## Active Constraints\n\n### Renamed title\n<!-- memory-entry-id:${id} -->\nOpposite durable meaning.\n`)[0]!;
    const caseChanged = parseProjectMemoryEntries(`## Key Decisions\n\n### Original title\n<!-- memory-entry-id:${id} -->\nSame Durable Meaning.\n`)[0]!;
    const hardBreakChanged = parseProjectMemoryEntries(`## Key Decisions\n\n### Original title\n<!-- memory-entry-id:${id} -->\nSame durable  \nmeaning.\n`)[0]!;
    const noHardBreak = parseProjectMemoryEntries(`## Key Decisions\n\n### Original title\n<!-- memory-entry-id:${id} -->\nSame durable\nmeaning.\n`)[0]!;


    expect((original as any).entryId).toBe(id);
    expect((moved as any).entryId).toBe(id);
    expect(original.entryKey).toBe(id);
    expect(moved.entryKey).toBe(id);
    expect((moved as any).contentVersionHash).toBe((original as any).contentVersionHash);
    expect((changed as any).contentVersionHash).not.toBe((original as any).contentVersionHash);
    expect((caseChanged as any).contentVersionHash).not.toBe((original as any).contentVersionHash);
    expect((hardBreakChanged as any).contentVersionHash).not.toBe((noHardBreak as any).contentVersionHash);

    expect(original.body).not.toContain("memory-entry-id");
  });

  test("content version hashing preserves boundary indentation and trailing spaces", () => {
    const entryId = "d".repeat(24);
    const version = (body: string) => parseProjectMemoryEntries(
      `## Key Decisions\n\n### Exact bytes\n<!-- memory-entry-id:${entryId} -->\n${body}\n`,
    )[0]!.contentVersionHash;

    expect(version("code")).not.toBe(version("    code"));
    expect(version("line")).not.toBe(version("line  "));
    expect(version("first\r\nsecond")).toBe(version("first\nsecond"));
  });

  test("gives duplicate legacy titles distinct deterministic identities", () => {
    const markdown = `## Key Decisions\n\n### Duplicate\nFirst meaning.\n\n### Duplicate\nSecond meaning.\n`;
    const first = parseProjectMemoryEntries(markdown);
    const second = parseProjectMemoryEntries(markdown);

    expect(first).toHaveLength(2);
    expect(first[0]?.entryKey).not.toBe(first[1]?.entryKey);
    expect(first.map(entry => entry.entryKey)).toEqual(second.map(entry => entry.entryKey));
  });

  test("stabilizes legacy markup once without touching fenced headings or existing ids", () => {
    const existingId = "f".repeat(24);
    const legacy = `## Key Decisions\n\n### Duplicate\nFirst.\n\n### Duplicate\nSecond.\n\n### Existing\n<!-- memory-entry-id:${existingId} -->\nKeep this id.\n\n\`\`\`md\n### Example only\n\`\`\`\n`;
    const stabilized = stabilizeProjectMemoryEntryIds(legacy);
    const ids = [...stabilized.matchAll(/<!-- memory-entry-id:([0-9a-f]{24}) -->/g)].map(match => match[1]);

    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
    expect(ids).toContain(existingId);
    expect(stabilized).not.toMatch(/### Example only\n<!-- memory-entry-id:/);
    expect(stabilizeProjectMemoryEntryIds(stabilized)).toBe(stabilized);
    expect(parseProjectMemoryEntries(stabilized).every(entry => entry.identitySource === "explicit")).toBe(true);
  });

  test("repairs copied duplicate IDs without changing the first logical entry", () => {
    const duplicate = [
      "# Project Core Memory",
      "",
      "## Key Decisions",
      "",
      "### First",
      "<!-- memory-entry-id:ABCDEF0123456789ABCDEF01 -->",
      "First body.",
      "",
      "### Copied",
      "<!-- memory-entry-id:abcdef0123456789abcdef01 -->",
      "Copied body.",
      "",
    ].join("\n");

    const stabilized = stabilizeProjectMemoryEntryIds(duplicate);
    const entries = parseProjectMemoryEntries(stabilized);
    expect(entries[0]?.entryId).toBe("abcdef0123456789abcdef01");
    expect(entries[1]?.entryId).not.toBe(entries[0]?.entryId);
    expect(new Set(entries.map(entry => entry.entryId)).size).toBe(2);
    expect(stabilizeProjectMemoryEntryIds(stabilized)).toBe(stabilized);
  });

  test("recovers a dropped ID from the previous document instead of severing identity", () => {
    const id = "b".repeat(24);
    const previous = `## Key Decisions\n\n### Stable title\n<!-- memory-entry-id:${id} -->\nOld body.\n`;
    const edited = `## Key Decisions\n\n### Stable title\nNew body.\n`;
    const moved = `## Active Constraints\n\n### Renamed title\nOld body.\n`;

    const editedEntry = parseProjectMemoryEntries(stabilizeProjectMemoryEntryIds(edited, previous))[0]!;
    const movedEntry = parseProjectMemoryEntries(stabilizeProjectMemoryEntryIds(moved, previous))[0]!;
    expect(editedEntry.entryId).toBe(id);
    expect(movedEntry.entryId).toBe(id);
    expect(editedEntry.contentVersionHash).not.toBe(movedEntry.contentVersionHash);
  });

  test("never lets an inferred recovery steal an explicit ID later in the document", () => {
    const id = "c".repeat(24);
    const previous = `## Key Decisions\n\n### Stable title\n<!-- memory-entry-id:${id} -->\nOld body.\n`;
    const next = `## Key Decisions\n\n### Stable title\nEdited body.\n\n### Explicit owner\n<!-- memory-entry-id:${id} -->\nDifferent body.\n`;

    const entries = parseProjectMemoryEntries(stabilizeProjectMemoryEntryIds(next, previous));
    expect(entries[1]?.entryId).toBe(id);
    expect(entries[0]?.entryId).not.toBe(id);
  });

  test("ranks exact title and active constraints ahead of incidental body matches", () => {
    const hits = recallProjectMemoryEntries(memory, "Supabase 동기화 충돌", { limit: 3 });
    expect(hits).toHaveLength(3);
    expect(hits[0]?.title).toBe("Supabase 동기화 충돌");
    expect(hits.some(hit => hit.title === "원격 최신본 확인 없이 덮어쓰지 않는다")).toBe(true);
    expect(hits.every(hit => hit.matchedTerms.length > 0)).toBe(true);
  });

  test("marks contested or contradicted experience as caution, never silent truth", () => {
    const entry = parseProjectMemoryEntries(memory).find(item => item.title === "자동 병합 가능 여부")!;
    const feedback: Record<string, ProjectMemoryFeedbackSummary> = {
      [projectMemoryFeedbackScopeKey(entry.entryKey, entry.contentVersionHash)]: { applied: 2, confirmed: 0, corrected: 0, contradicted: 1 },
    };
    const [hit] = recallProjectMemoryEntries(memory, "자동 병합", { feedback });
    expect(hit?.caution).toBe(true);
    expect(hit?.feedback.contradicted).toBe(1);
    expect(hit?.promotionState).toBe("contested");
  });

  test("confirmed experience gets a bounded boost instead of dominating forever", () => {
    const entries = parseProjectMemoryEntries(memory);
    const constraint = entries.find(item => item.title === "원격 최신본 확인 없이 덮어쓰지 않는다")!;
    const feedback: Record<string, ProjectMemoryFeedbackSummary> = {
      [projectMemoryFeedbackScopeKey(constraint.entryKey, constraint.contentVersionHash)]: { applied: 500, confirmed: 500, corrected: 0, contradicted: 0 },
    };
    const hits = recallProjectMemoryEntries(memory, "원격", { feedback, limit: 5 });
    expect(hits[0]?.title).toBe(constraint.title);
    expect(hits[0]!.feedbackBoost).toBeLessThanOrEqual(24);
    expect(hits[0]!.promotionState).toBe("active");
  });

  test("does not transfer confirmation or promotion to a rewritten content version", () => {
    const entryId = "e".repeat(24);
    const originalMarkdown = `## Key Decisions\n\n### Stable rule\n<!-- memory-entry-id:${entryId} -->\nAlways require review.\n`;
    const rewrittenMarkdown = `## Key Decisions\n\n### Stable rule\n<!-- memory-entry-id:${entryId} -->\nNever require review.\n`;
    const original = parseProjectMemoryEntries(originalMarkdown)[0]!;
    const rewritten = parseProjectMemoryEntries(rewrittenMarkdown)[0]!;
    const feedback: Record<string, ProjectMemoryFeedbackSummary> = {
      [projectMemoryFeedbackScopeKey(original.entryId, original.contentVersionHash)]: {
        applied: 3,
        confirmed: 3,
        corrected: 0,
        contradicted: 0,
      },
    };

    const [originalHit] = recallProjectMemoryEntries(originalMarkdown, "require review", { feedback });
    const [rewrittenHit] = recallProjectMemoryEntries(rewrittenMarkdown, "require review", { feedback });
    expect(originalHit?.promotionState).toBe("active");
    expect(rewritten.contentVersionHash).not.toBe(original.contentVersionHash);
    expect(rewrittenHit?.feedback).toEqual({ applied: 0, confirmed: 0, corrected: 0, contradicted: 0 });
    expect(rewrittenHit?.feedbackBoost).toBe(0);
    expect(rewrittenHit?.promotionState).toBe("candidate");
  });

  test("empty or generic-only queries do not dump the whole memory", () => {
    expect(recallProjectMemoryEntries(memory, "")).toEqual([]);
    expect(recallProjectMemoryEntries(memory, "프로젝트 기억 작업")).toEqual([]);
  });
});

describe("project-memory quality report", () => {
  test("finds duplicate titles, empty entries, and oversized prose", () => {
    const report = inspectProjectMemoryQuality(`${memory}\n\n## Validated Workflows\n\n### UI 색상\n\n### 빈 항목\n\n### 너무 긴 항목\n${"x".repeat(4100)}\n`);
    expect(report.duplicateTitles).toEqual(["UI 색상"]);
    expect(report.emptyEntries).toContain("빈 항목");
    expect(report.oversizedEntries.some(item => item.title === "너무 긴 항목")).toBe(true);
    expect(report.score).toBeLessThan(100);
  });
});
