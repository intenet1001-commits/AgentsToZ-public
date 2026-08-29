import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CURRENT_MEMORY_AGENT_VERSION } from "../project-memory-server";
import { CURRENT_PROJECT_MEMORY_VERSION } from "../src/projectMemoryVersion";

const source = readFileSync(join(import.meta.dir, "..", "project-memory-server.ts"), "utf8");
const panel = readFileSync(join(import.meta.dir, "..", "src", "ProjectMemoryPanel.tsx"), "utf8");

function bodyOf(name: string, endMarker: string): string {
  const start = source.indexOf(name);
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf(endMarker, start);
  return source.slice(start, end > start ? end : undefined);
}

describe("remember-needed signal", () => {
  const status = bodyOf("function memoryActivityStatus", "\n/**");

  // Before: needsRemember was `reasons.length > 0` — an OR of two latches that
  // each turned on without any work being done. 20 of 26 real projects were lit.
  test("requires both a session signal and a durable project change", () => {
    expect(status).toContain("needsRemember: projectChanged && sessionSignal");
    expect(status).not.toContain("needsRemember: reasons.length > 0");
  });

  test("the session gate runs before any git work and returns early", () => {
    const gate = status.indexOf("if (!sessionSignal)");
    const snapshot = status.indexOf("currentActivitySnapshot(root)");
    expect(gate).toBeGreaterThan(-1);
    expect(snapshot).toBeGreaterThan(gate);
    expect(status).toContain("fingerprintEvaluated: false");
  });

  test("the session gate uses a bounded activity marker instead of a growing prompt counter", () => {
    expect(status).toContain("const sessionSignal = markerTime > rememberedTime");
    expect(source).not.toContain("ACTIVITY_MIN_PROMPTS");
    expect(source).not.toContain("ACTIVITY_COOL_OFF_MS");
  });

  test("a moved fingerprint alone is not enough — churn must clear the bar", () => {
    expect(status).toContain("snapshot.churn >= ACTIVITY_CHURN_THRESHOLD");
    // Churn measures the working tree only. Zero churn with a moved fingerprint
    // means the work was committed, or the folder is not a git repo — both are
    // real work, so zero must pass rather than suppress the badge.
    expect(status).toContain("snapshot.churn === 0");
  });

  test("a missing hook is exposed as degraded without suppressing marker-based recovery", () => {
    expect(status).toContain("hooks.claude || hooks.codex");
    expect(status).toContain("markerTime > rememberedTime");
    expect(status).toContain("degraded: !hooksInstalled");
  });

  test("an older fingerprint version re-baselines silently", () => {
    expect(status).toContain("=== ACTIVITY_FINGERPRINT_VERSION");
    expect(source).toContain("const ACTIVITY_FINGERPRINT_VERSION = 2");
  });
});

describe("remember reset", () => {
  const mark = bodyOf("export function markProjectMemoryRemembered", "\nexport function initializeProjectMemory");

  test("stores a fingerprint baseline and makes unchanged retries a no-op", () => {
    expect(mark).toContain("config.lastRememberedActivityFingerprint = snapshot.fingerprint");
    expect(mark).toContain("config.activityFingerprintVersion = ACTIVITY_FINGERPRINT_VERSION");
    expect(mark).toContain("if (baselineMatches && !narrative)");
    expect(mark).toContain("config.lastRememberedPromptCount = null");
  });
});

describe("Hermes remember-session command", () => {
  // The copy button lives in the always-visible local-terminal row; the Hermes box
  // explains the argument form without repeating the button. See the duplication
  // test in project-memory-app-command-separation.test.ts.
  test("copies the registered absolute path with the argument form", () => {
    expect(panel).toContain('data-testid="copy-hermes-remember-session-local"');
    expect(panel).toContain('`/remember_session ${folderPath.trim()}`');
    expect(panel).toContain("copyChatCommand('hermes-local', hermesRememberSessionPathCommand, 'Hermes /remember_session <경로>')");
  });

  test("warns that the copied path belongs to this PC, not the pasted host", () => {
    expect(panel).toContain('그 경로는 이 PC 기준이라 다른 호스트의 Hermes에서는 그 호스트의 경로로 바꿔야 합니다');
  });
});

describe("generated Claude/Codex remember-session safety", () => {
  const skill = bodyOf("function rememberSessionSkillTemplate", "\nfunction activityHookTemplate");

  test("pulls before editing and obeys autoBackup for Pull and Push", () => {
    expect(skill).toContain("Pull before editing");
    expect(skill).toContain("/api/project-memory/pull");
    expect(skill).toContain("config.autoBackup");
    expect(skill).toContain("skip Push");
  });

  test("preserves durable entry ids through title and section changes", () => {
    expect(skill).toContain("memory-entry-id");
    expect(skill).toContain("Never remove or regenerate an existing entry ID");
    expect(panel).toContain("memory-entry-id:<24자리 소문자 16진수>");
  });

  test("v11 identity migration tells the user that the local revision still needs Push", () => {
    expect(panel).toContain('entryIdsStabilized: boolean');
    expect(panel).toContain('result.entryIdsStabilized');
    expect(panel).toContain('Supabase Push가 필요합니다');
  });

  test("standalone upgrade backs up and validates all entries before advancing v11", () => {
    expect(panel).toContain('버전이 같아도 ID 완전성 검증');
    expect(panel).toContain('standalone-v<이전버전>-<UTC시각>');
    expect(panel).toContain('config.json, CORE.md, notes/ 전체, manifest.json, 기존 remember-session 스킬을 바이트 그대로 백업');
    expect(panel).toContain('모든 실제 ### 항목 수와 유효하고 고유한 memory-entry-id 수가 같은지 검증');
    expect(panel).toContain('같은 디렉터리의 임시 파일에 먼저 쓴다');
    expect(panel).toContain('원자적 rename으로 교체');
    expect(panel).toContain('config.json과 스킬 버전 마커 파일은 마지막에 교체');
    expect(panel).toContain('검증이 모두 성공한 마지막 단계에서만 memoryVersion');
    expect(panel).toContain('실패하면 백업에서 원상 복구하고 버전 마커를 올리지 않는다');
    expect(panel).not.toContain('이미 최신이다. 아무것도 고치지 말고 그 사실만 보고한다.');
  });
});

describe("bounded activity marker", () => {
  test("new hooks never append an unbounded prompt counter and upgrades remove the legacy file", () => {
    expect(source).not.toContain(`printf 'x' >> "$hook_dir/activity-count"`);
    expect(source).not.toContain("Add-Content -LiteralPath (Join-Path $dir 'activity-count')");
    expect(source).toContain('unlinkSync(safeProjectPath(root, ".agent-memory/activity-count"))');
    // 버전은 src/projectMemoryVersion.ts 한 곳에서 온다. 리터럴을 grep 하면 정본이 옮겨간 뒤에도
    // 통과하거나(옛 문자열이 주석에 남는 경우) 정본을 옮긴 것만으로 실패한다.
    expect(CURRENT_MEMORY_AGENT_VERSION).toBe(CURRENT_PROJECT_MEMORY_VERSION);
    expect(CURRENT_MEMORY_AGENT_VERSION).toBeGreaterThanOrEqual(8);
  });

  test("regenerating an unchanged memory document does not rewrite its files", () => {
    expect(source).toContain("function atomicWriteIfChanged");
    const writer = bodyOf("export function writeMemoryDocument", "\nfunction backupMemory");
    expect(writer).toContain("atomicWriteIfChanged(safeMemoryNotePath(root, file.file), file.text)");
    expect(writer).toContain("atomicWriteIfChanged(safeMemoryPath, renderMemoryIndex(manifest, header))");
  });
});

describe("git status parsing", () => {
  // `git status --short` puts the staged/unstaged state in two leading columns,
  // either of which may be a space. Trimming the whole output shifted the first
  // line by one character, so its path lost a leading character and no ignore
  // rule could ever match it.
  test("status output keeps its leading columns", () => {
    const snapshot = source.slice(source.indexOf("function gitActivitySnapshot"));
    expect(snapshot).toContain('runGitRaw(worktree.path, ["status", "--short"');
    const raw = bodyOf("function runGitRaw", "\nfunction linkedWorktreeContext");
    expect(raw).toContain('replace(/\\r?\\n$/, "")');
    expect(raw).not.toContain("stdout.toString().trim()");
  });
});

describe("git path quoting", () => {
  // Default core.quotePath emits octal escapes for non-ASCII names, which the
  // path normalizer mangled into a bogus path that then failed statSync and
  // entered the fingerprint as "<path>\tmissing".
  test("every git invocation disables path quoting at the source", () => {
    const runGit = bodyOf("function runGit", "\nfunction linkedWorktreeContext");
    expect(runGit).toContain('"-c", "core.quotePath=false"');
  });
});
