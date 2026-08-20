import { test, expect } from "bun:test";
import {
  claudeProjectSlug,
  isProjectTranscriptDir,
  parseWorktreePaths,
  projectTranscriptSlugs,
  extractSessionExcerpts,
  extractCodexExcerpts,
  codexRolloutCwd,
  isPathInsideProject,
  renderSessionContext,
} from "../src/sessionTranscript";
import { readFirstLine } from "../project-memory-server";
import { writeFileSync, unlinkSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const line = (o: unknown) => JSON.stringify(o);

test("a rollout header longer than a few KB is still read whole", () => {
  // Measured across 318 rollouts: the first line runs 250 to 47,671 bytes, median
  // 44,055, because session_meta carries the model instructions. An 8KB read
  // truncated 311 of them mid-JSON, and a truncated header parses as "not a
  // rollout" — so every Codex session was silently skipped and the sweep reported
  // a clean zero (0 matches for this project, which actually has 117).
  const root = "/Users/gwanli/product_2026/portmanagement";
  const header = JSON.stringify({
    timestamp: "2026-08-09T10:00:00Z",
    type: "session_meta",
    payload: { cwd: root, instructions: "x".repeat(40_000) },
  });
  const path = join(tmpdir(), `rollout-test-${process.pid}.jsonl`);
  writeFileSync(path, `${header}\n${line({ type: "event_msg", payload: { type: "user_message", message: "hi" } })}\n`);
  try {
    expect(header.length).toBeGreaterThan(8_192);
    expect(codexRolloutCwd(readFirstLine(path))).toBe(root);
    expect(codexRolloutCwd(readFirstLine(path, 8_192))).toBeNull();
  } finally {
    unlinkSync(path);
  }
});

test("a working directory maps to Claude Code's on-disk slug", () => {
  expect(claudeProjectSlug("/Users/gwanli/product_2026/portmanagement"))
    .toBe("-Users-gwanli-product-2026-portmanagement");
  expect(claudeProjectSlug("/Users/gwanli/product_2026/portmanagement/.claude/worktrees/memory-decompose"))
    .toBe("-Users-gwanli-product-2026-portmanagement--claude-worktrees-memory-decompose");
});

test("worktree transcripts count as the project's, unrelated neighbours do not", () => {
  const slug = "-Users-gwanli-product-2026-portmanagement";
  expect(isProjectTranscriptDir(slug, slug)).toBe(true);
  expect(isProjectTranscriptDir(`${slug}--claude-worktrees-memory-decompose`, slug)).toBe(true);
  // The layout this app creates today (WORKTREE_DIR = "worktrees") slugs to a
  // single dash, so the old `${slug}--` prefix test dropped it. Measured: real
  // transcripts under `${slug}-worktrees-test1` were never swept, and a day of
  // worktree work went into no memory at all.
  expect(isProjectTranscriptDir(`${slug}-worktrees-feature-x`, slug)).toBe(true);
  // Measured: the last remember left no trace under the project's own slug because
  // every session that day ran in a worktree, which is filed separately.
  expect(isProjectTranscriptDir("-Users-gwanli-product-2026-other", slug)).toBe(false);
  // A real sibling repository, /Users/gwanli/product_2026/portmanagement-extra,
  // produces exactly this slug — which is why relaxing the prefix to one dash is
  // not the fix.
  expect(isProjectTranscriptDir("-Users-gwanli-product-2026-portmanagement-extra", slug)).toBe(false);
});

test("git's worktree list decides ownership, and a missing git falls back", () => {
  const root = "/Users/gwanli/product_2026/portmanagement";
  const slug = claudeProjectSlug(root);
  const porcelain = [
    `worktree ${root}`,
    "HEAD abc",
    "branch refs/heads/main",
    "",
    `worktree ${root}/worktrees/orca surface`,
    "HEAD def",
    "",
    // A worktree of a different repository shares the sessions directory but not
    // this project.
    "worktree /Users/gwanli/product_2026/portmanagement-extra/worktrees/x",
    "HEAD ghi",
    "",
  ].join("\n");
  const paths = parseWorktreePaths(porcelain);
  // Porcelain keeps the path whole, spaces included.
  expect(paths).toContain(`${root}/worktrees/orca surface`);
  const linked = projectTranscriptSlugs(root, paths);
  expect(linked.has(slug)).toBe(true);
  expect(linked.has(claudeProjectSlug(`${root}/worktrees/orca surface`))).toBe(true);
  expect(linked.has(claudeProjectSlug("/Users/gwanli/product_2026/portmanagement-extra/worktrees/x"))).toBe(false);
  expect(isProjectTranscriptDir(claudeProjectSlug(`${root}/worktrees/orca surface`), slug, linked)).toBe(true);

  // git absent or not a repository: runGit returns "", and the sweep must still
  // find the app's own worktree layouts rather than fail the save.
  const empty = projectTranscriptSlugs(root, parseWorktreePaths(""));
  expect(empty.size).toBe(1);
  expect(isProjectTranscriptDir(`${slug}-worktrees-feature-x`, slug, empty)).toBe(true);
  expect(isProjectTranscriptDir(`${slug}--claude-worktrees-panel-e2e`, slug, empty)).toBe(true);
  expect(isProjectTranscriptDir(`${slug}-extra`, slug, empty)).toBe(false);
});

test("the Claude sweep counts what it looked at, not only what it kept", () => {
  // Same reason as the Codex counters: the dropped-worktree bug above looked
  // exactly like "this project has no sessions" because nothing counted the
  // directories that were considered and rejected.
  const source = readFileSync(join(import.meta.dir, "..", "project-memory-server.ts"), "utf8");
  const sweep = source.slice(
    source.indexOf("function claudeSessionExcerpts"),
    source.indexOf("export function readFirstLine"),
  );
  expect(sweep).toContain("stats.claudeConsidered += 1");
  expect(sweep).toContain("stats.claudeMatched += 1");
  expect(sweep).toContain("stats.claudeUnreadable += 1");
  // Declared on the shared stats shape, so it reaches sessionContextStats.
  const declaration = source.slice(
    source.indexOf("export interface SessionSweepStats"),
    source.indexOf("function sessionContext("),
  );
  for (const key of ["claudeConsidered", "claudeMatched", "claudeUnreadable"]) {
    expect(declaration).toContain(`${key}: number`);
  }
});

test("prompts and prose are kept; tool traffic and reminders are not", () => {
  const lines = [
    line({ type: "user", timestamp: "2026-08-09T10:00:00Z", message: { content: "분해부터 진행해" } }),
    line({ type: "user", timestamp: "2026-08-09T10:00:01Z", message: { content: "<system-reminder>noise</system-reminder>" } }),
    line({ type: "user", timestamp: "2026-08-09T10:00:02Z", message: { content: "[Request interrupted by user]" } }),
    line({ type: "user", timestamp: "2026-08-09T10:00:03Z", message: { content: [{ type: "tool_result", content: "x" }] } }),
    line({ type: "assistant", timestamp: "2026-08-09T10:00:04Z", message: { content: [
      { type: "text", text: "왕복이 바이트 단위로 일치합니다" },
      { type: "tool_use", name: "Bash", input: {} },
    ] } }),
    line({ type: "file-history-snapshot", timestamp: "2026-08-09T10:00:05Z" }),
    "not json",
    "",
  ];
  const excerpts = extractSessionExcerpts(lines, null);
  expect(excerpts.map(e => e.role)).toEqual(["user", "assistant"]);
  expect(excerpts[0]!.text).toBe("분해부터 진행해");
  expect(excerpts[1]!.text).toBe("왕복이 바이트 단위로 일치합니다");
});

test("entries older than the last remember are excluded", () => {
  const lines = [
    line({ type: "user", timestamp: "2026-08-09T09:00:00Z", message: { content: "이전 세션" } }),
    line({ type: "user", timestamp: "2026-08-09T11:00:00Z", message: { content: "이번 세션" } }),
  ];
  const excerpts = extractSessionExcerpts(lines, "2026-08-09T10:00:00Z");
  expect(excerpts.map(e => e.text)).toEqual(["이번 세션"]);
  expect(extractSessionExcerpts(lines, null)).toHaveLength(2);
});

test("the sweep counts unreadable rollout headers instead of silently skipping them", () => {
  // The 8KB bug produced 0 matches with no error for a project that has 117
  // rollouts. A skip counter makes "no Codex work here" and "the reader is
  // truncating records" distinguishable at a glance.
  const source = readFileSync(join(import.meta.dir, "..", "project-memory-server.ts"), "utf8");
  const sweep = source.slice(
    source.indexOf("function codexSessionExcerpts"),
    source.indexOf("export interface SessionSweepStats"),
  );
  expect(sweep).toContain("stats.codexConsidered += 1");
  expect(sweep).toContain("stats.codexUnreadable += 1");
  expect(sweep).toContain("stats.codexMatched += 1");
  // The count has to reach the caller, or it is not a signal.
  expect(source).toContain("sessionContextStats: sessionStats");
});

test("a Codex rollout is matched by the working directory in its header", () => {
  const header = line({
    timestamp: "2026-08-07T14:24:38.196Z",
    type: "session_meta",
    payload: { session_id: "019fdc9c", cwd: "/Users/gwanli/product_2026/portmanagement", source: "vscode" },
  });
  expect(codexRolloutCwd(header)).toBe("/Users/gwanli/product_2026/portmanagement");
  expect(codexRolloutCwd(line({ type: "event_msg", payload: { type: "user_message" } }))).toBeNull();
  expect(codexRolloutCwd("not json")).toBeNull();
});

test("a worktree counts as inside the project, a sibling directory does not", () => {
  const root = "/Users/gwanli/product_2026/portmanagement";
  expect(isPathInsideProject(root, root)).toBe(true);
  expect(isPathInsideProject(`${root}/.claude/worktrees/x`, root)).toBe(true);
  expect(isPathInsideProject("/Users/gwanli/product_2026/portmanagement-other", root)).toBe(false);
  expect(isPathInsideProject("/Users/gwanli/product_2026", root)).toBe(false);
});

test("Codex messages are kept; reasoning, tool calls and token counts are not", () => {
  // Measured on a real rollout: 900 lines carried 4 user and 30 agent messages;
  // everything else was machinery.
  const lines = [
    line({ timestamp: "2026-08-09T10:00:00Z", type: "event_msg", payload: { type: "user_message", message: "새창열린거지?\n" } }),
    line({ timestamp: "2026-08-09T10:00:01Z", type: "event_msg", payload: { type: "agent_message", message: "네, 새 작업 창에서 열려 있어요." } }),
    line({ timestamp: "2026-08-09T10:00:02Z", type: "event_msg", payload: { type: "agent_reasoning", text: "생각 중" } }),
    line({ timestamp: "2026-08-09T10:00:03Z", type: "event_msg", payload: { type: "token_count", info: {} } }),
    line({ timestamp: "2026-08-09T10:00:04Z", type: "response_item", payload: { type: "custom_tool_call" } }),
    line({ timestamp: "2026-08-09T10:00:05Z", type: "session_meta", payload: { cwd: "/x" } }),
  ];
  const excerpts = extractCodexExcerpts(lines, null);
  expect(excerpts.map(e => e.role)).toEqual(["user", "assistant"]);
  expect(excerpts[0]!.text).toBe("새창열린거지?");
  expect(excerpts[1]!.text).toBe("네, 새 작업 창에서 열려 있어요.");
});

test("Codex excerpts respect the remember baseline", () => {
  const lines = [
    line({ timestamp: "2026-08-09T09:00:00Z", type: "event_msg", payload: { type: "user_message", message: "이전" } }),
    line({ timestamp: "2026-08-09T11:00:00Z", type: "event_msg", payload: { type: "user_message", message: "이번" } }),
  ];
  expect(extractCodexExcerpts(lines, "2026-08-09T10:00:00Z").map(e => e.text)).toEqual(["이번"]);
});

test("the budget drops the oldest exchange, never the conclusion", () => {
  const excerpts = [
    { role: "user" as const, recordedAt: "2026-08-09T10:00:00Z", text: "아주 오래된 " + "x".repeat(500) },
    { role: "user" as const, recordedAt: "2026-08-09T11:00:00Z", text: "최근 결론" },
  ];
  const rendered = renderSessionContext(excerpts, 200);
  expect(rendered).toContain("최근 결론");
  expect(rendered).not.toContain("아주 오래된");
});

test("kept excerpts stay in chronological order", () => {
  const excerpts = [
    { role: "user" as const, recordedAt: "2026-08-09T10:00:00Z", text: "먼저" },
    { role: "assistant" as const, recordedAt: "2026-08-09T10:00:01Z", text: "나중" },
  ];
  const rendered = renderSessionContext(excerpts, 10_000);
  expect(rendered.indexOf("먼저")).toBeLessThan(rendered.indexOf("나중"));
  expect(rendered).toContain("[사용자 2026-08-09T10:00:00Z]");
  expect(rendered).toContain("[에이전트 2026-08-09T10:00:01Z]");
});

test("one long answer cannot evict the rest of the session", () => {
  const excerpts = [
    { role: "user" as const, recordedAt: "2026-08-09T10:00:00Z", text: "질문" },
    { role: "assistant" as const, recordedAt: "2026-08-09T10:00:01Z", text: "y".repeat(20_000) },
  ];
  const rendered = renderSessionContext(excerpts, 8_000);
  expect(rendered).toContain("질문");
  expect(rendered).toContain("…(생략)");
});
