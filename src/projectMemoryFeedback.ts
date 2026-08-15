import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ProjectMemoryFeedbackSummary } from "./projectMemoryRecall";

/**
 * Positive feedback promotion is fail-closed until v2 evidence carries stable
 * entry/content identity plus independent task/session outcome receipts. v1
 * events remain readable and syncable for audit, but cannot influence Recall.
 */
export const PROJECT_MEMORY_FEEDBACK_PROMOTION_ENABLED = false;

export type ProjectMemoryFeedbackKind = "applied" | "confirmed" | "corrected" | "contradicted";

export interface ProjectMemoryFeedbackEvent {
  id: string;
  memoryId: string;
  /** Stable logical entry identity. */
  entryKey: string;
  /**
   * Exact durable body version this evidence evaluated. Legacy v1 events have
   * no value and remain audit history only; Recall never applies them to a
   * current body implicitly.
   */
  contentVersionHash?: string | null;
  kind: ProjectMemoryFeedbackKind;
  recordedAt: string;
  evidence?: string | null;
  deviceId?: string | null;
}

const FEEDBACK_REL = ".agent-memory/feedback/events.jsonl";
const KINDS = new Set<ProjectMemoryFeedbackKind>(["applied", "confirmed", "corrected", "contradicted"]);
const ENTRY_KEY_PATTERN = /^[0-9a-f]{24}$/;
const CONTENT_VERSION_PATTERN = /^[0-9a-f]{32}$/;

/** Version-scoped applicability key used by Recall and by remote storage. */
export function projectMemoryFeedbackScopeKey(entryKey: string, contentVersionHash: string): string {
  if (!ENTRY_KEY_PATTERN.test(entryKey) || !CONTENT_VERSION_PATTERN.test(contentVersionHash)) {
    throw new Error("유효한 기억 항목·본문 버전 키가 필요합니다.");
  }
  return `${entryKey}:${contentVersionHash}`;
}

/**
 * Old remote rows contain only a 24-hex entry ID. New rows encode the body
 * version in the existing text column so upgrades remain append-only and do
 * not require rewriting historical evidence.
 */
export function parseProjectMemoryFeedbackStorageKey(value: unknown): {
  entryKey: string;
  contentVersionHash: string | null;
} | null {
  if (typeof value !== "string") return null;
  if (ENTRY_KEY_PATTERN.test(value)) return { entryKey: value, contentVersionHash: null };
  const match = value.match(/^([0-9a-f]{24}):([0-9a-f]{32})$/);
  return match ? { entryKey: match[1]!, contentVersionHash: match[2]! } : null;
}

export function projectMemoryFeedbackStorageKey(event: Pick<ProjectMemoryFeedbackEvent, "entryKey" | "contentVersionHash">): string {
  return event.contentVersionHash
    ? projectMemoryFeedbackScopeKey(event.entryKey, event.contentVersionHash)
    : event.entryKey;
}

function cleanEvidence(value?: string | null): string | null {
  const text = value?.replace(/\s+/g, " ").trim() ?? "";
  return text ? text.slice(0, 500) : null;
}

function validEvent(value: unknown): value is ProjectMemoryFeedbackEvent {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<ProjectMemoryFeedbackEvent>;
  return typeof item.id === "string" && item.id.length > 0
    && typeof item.memoryId === "string" && item.memoryId.length > 0
    && typeof item.entryKey === "string" && ENTRY_KEY_PATTERN.test(item.entryKey)
    && (item.contentVersionHash == null
      || (typeof item.contentVersionHash === "string" && CONTENT_VERSION_PATTERN.test(item.contentVersionHash)))
    && typeof item.kind === "string" && KINDS.has(item.kind as ProjectMemoryFeedbackKind)
    && typeof item.recordedAt === "string" && !Number.isNaN(Date.parse(item.recordedAt));
}

export function feedbackFile(root: string): string {
  return safeFeedbackPath(root, FEEDBACK_REL);
}

/** Feedback is repository-adjacent input consumed by Recall and uploaded under
 * the current lineage. Never let a committed symlink make it read or append a
 * different project's ledger. */
function safeFeedbackPath(root: string, relativePath: string): string {
  const requestedRoot = resolve(root);
  if (lstatSync(requestedRoot).isSymbolicLink()) {
    throw new Error(`프로젝트 기억 피드백 루트에는 심볼릭 링크를 사용할 수 없습니다: ${requestedRoot}`);
  }
  const canonicalRoot = realpathSync(requestedRoot);
  const candidate = resolve(canonicalRoot, relativePath);
  const rel = relative(canonicalRoot, candidate);
  if (!rel || rel === ".") return candidate;
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new Error(`프로젝트 밖 피드백 경로는 사용할 수 없습니다: ${relativePath}`);
  }
  let current = canonicalRoot;
  for (const part of rel.split(sep)) {
    current = join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink()) {
        throw new Error(`프로젝트 기억 피드백 경로에 심볼릭 링크가 있습니다: ${current}`);
      }
    } catch (error: any) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
  }
  return candidate;
}

export function readProjectMemoryFeedback(root: string): ProjectMemoryFeedbackEvent[] {
  const path = feedbackFile(root);
  if (!existsSync(path)) return [];
  const result: ProjectMemoryFeedbackEvent[] = [];
  const seen = new Set<string>();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as unknown;
      if (!validEvent(event) || seen.has(event.id)) continue;
      seen.add(event.id);
      result.push(event);
    } catch {
      // One interrupted/corrupt line must not hide earlier durable feedback.
    }
  }
  return result.sort((a, b) => a.recordedAt.localeCompare(b.recordedAt) || a.id.localeCompare(b.id));
}

export function appendProjectMemoryFeedback(root: string, input: {
  memoryId: string;
  entryKey: string;
  contentVersionHash?: string | null;
  kind: ProjectMemoryFeedbackKind;
  evidence?: string | null;
  deviceId?: string | null;
  id?: string;
  recordedAt?: string;
}): { event: ProjectMemoryFeedbackEvent; appended: boolean; path: string } {
  if (!input.memoryId.trim()) throw new Error("memoryId가 필요합니다.");
  if (!ENTRY_KEY_PATTERN.test(input.entryKey)) throw new Error("유효한 기억 항목 키가 필요합니다.");
  if (input.contentVersionHash != null && !CONTENT_VERSION_PATTERN.test(input.contentVersionHash)) {
    throw new Error("유효한 기억 본문 버전 키가 필요합니다.");
  }
  if (!KINDS.has(input.kind)) throw new Error("알 수 없는 기억 피드백 종류입니다.");
  const recordedAt = input.recordedAt ?? new Date().toISOString();
  if (Number.isNaN(Date.parse(recordedAt))) throw new Error("유효한 피드백 시각이 필요합니다.");
  const evidence = cleanEvidence(input.evidence);
  const id = input.id ?? createHash("sha256").update([
    input.memoryId, input.entryKey, input.contentVersionHash ?? "legacy", input.kind, evidence ?? "", input.deviceId ?? "", recordedAt,
    randomUUID(),
  ].join("\n")).digest("hex").slice(0, 32);
  const event: ProjectMemoryFeedbackEvent = {
    id,
    memoryId: input.memoryId,
    entryKey: input.entryKey,
    contentVersionHash: input.contentVersionHash ?? null,
    kind: input.kind,
    recordedAt,
    evidence,
    deviceId: input.deviceId ?? null,
  };
  const path = feedbackFile(root);
  if (readProjectMemoryFeedback(root).some(existing => existing.id === id)) {
    return { event, appended: false, path };
  }
  mkdirSync(dirname(path), { recursive: true });
  // Re-check after mkdir to narrow the window in which a repository-controlled
  // path could be swapped before the append.
  const checkedPath = feedbackFile(root);
  const ignore = safeFeedbackPath(root, ".agent-memory/feedback/.gitignore");
  if (!existsSync(ignore)) writeFileSync(ignore, "*\n!.gitignore\n", "utf8");
  appendFileSync(checkedPath, `${JSON.stringify(event)}\n`, "utf8");
  return { event, appended: true, path: checkedPath };
}

export function summarizeProjectMemoryFeedback(
  events: ProjectMemoryFeedbackEvent[],
): Record<string, ProjectMemoryFeedbackSummary> {
  const result: Record<string, ProjectMemoryFeedbackSummary> = {};
  const seen = new Set<string>();
  for (const event of events) {
    if (!validEvent(event) || seen.has(event.id)) continue;
    seen.add(event.id);
    const scope = projectMemoryFeedbackStorageKey(event);
    const summary = result[scope] ?? { applied: 0, confirmed: 0, corrected: 0, contradicted: 0 };
    summary[event.kind] += 1;
    result[scope] = summary;
  }
  return result;
}

export function projectMemoryPromotionState(summary: ProjectMemoryFeedbackSummary):
  | "candidate" | "active" | "contested" | "superseded" {
  if (summary.contradicted > 0 && summary.corrected > 0) return "superseded";
  if (summary.contradicted > 0 || summary.corrected > summary.confirmed) return "contested";
  if (summary.confirmed >= 2 && summary.applied >= 2) return "active";
  return "candidate";
}
