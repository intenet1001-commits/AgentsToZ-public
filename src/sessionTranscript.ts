/**
 * Recovers what a session was about, for the save path that has no session.
 *
 * The app's memory button spawns a fresh agent that was never in the conversation,
 * so it could only ever describe the commits it found — while the same save run
 * from inside a live session knows what was decided and why. The two paths were
 * meant to be equivalent; the gap was never the design, only which context each
 * one could reach. The transcripts are on disk, so the button can reach it too.
 *
 * Prompts and prose only. Tool calls, results and system reminders are most of a
 * transcript's bytes and almost none of its meaning.
 */

export interface SessionExcerpt {
  role: "user" | "assistant";
  recordedAt: string;
  text: string;
}

/** Claude Code's on-disk name for a working directory. */
export function claudeProjectSlug(directory: string): string {
  return directory.replace(/[/_.]/g, "-");
}

/**
 * Absolute worktree paths from `git worktree list --porcelain`.
 *
 * The porcelain form is one `worktree <abspath>` line per entry, so it survives
 * paths with spaces — which the human-readable form does not.
 */
export function parseWorktreePaths(porcelain: string): string[] {
  const paths: string[] = [];
  for (const line of porcelain.split("\n")) {
    if (!line.startsWith("worktree ")) continue;
    const path = line.slice("worktree ".length).trim();
    if (path) paths.push(path);
  }
  return paths;
}

/**
 * The on-disk slugs whose transcripts belong to this project: its own, plus one
 * per linked worktree.
 *
 * Derived from the paths git actually reports rather than from the shape of a
 * directory name. Name-shape guessing was wrong in the direction that loses
 * memory: `<repo>/worktrees/x` — the layout this app creates today — slugs to a
 * *single* dash, so a `${slug}--` prefix test dropped it, while the legacy
 * `<repo>/.claude/worktrees/x` only passed because `.claude` happens to slug to
 * `-claude` and produced a double dash by accident.
 */
export function projectTranscriptSlugs(projectRoot: string, worktreePaths: string[]): Set<string> {
  const slugs = new Set<string>([claudeProjectSlug(projectRoot)]);
  for (const path of worktreePaths) {
    if (isPathInsideProject(path, projectRoot)) slugs.add(claudeProjectSlug(path));
  }
  return slugs;
}

/** Worktree directories this app creates, relative to the repository root. */
const WORKTREE_SEGMENTS = ["worktrees", ".claude/worktrees"];

/**
 * True when a transcript directory belongs to this project — its own, or one of
 * its linked worktrees, which Claude Code files under a separate slug. Sweeping
 * only the project's own slug misses work done in a worktree, which for this
 * repository is where most of it happens.
 *
 * `linkedSlugs` is the authority when git could enumerate the worktrees. Without
 * it — no git, not a repository, a worktree already pruned — we fall back to the
 * two directory layouts this app creates, anchored on a whole path segment so a
 * sibling repository (`…-portmanagement-extra`, a real neighbour here) still
 * fails. A missing git must degrade the sweep, never abort a save.
 */
export function isProjectTranscriptDir(
  name: string,
  projectSlug: string,
  linkedSlugs?: ReadonlySet<string>,
): boolean {
  if (name === projectSlug) return true;
  if (linkedSlugs?.has(name)) return true;
  // Legacy shape: kept because a worktree can be gone from git while its
  // transcripts remain, and those sessions are still this project's.
  if (name.startsWith(`${projectSlug}--`)) return true;
  return WORKTREE_SEGMENTS.some(segment =>
    name.startsWith(`${projectSlug}${claudeProjectSlug(`/${segment}/`)}`),
  );
}

const SKIPPED_USER_PREFIXES = [
  "<", // system reminders, tool results, command wrappers
  "[Request interrupted",
  "Caveat:",
];

function readTextBlocks(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block: any) => block?.type === "text" && typeof block.text === "string")
    .map((block: any) => block.text)
    .join("\n")
    .trim();
}

export function extractSessionExcerpts(lines: string[], sinceIso: string | null): SessionExcerpt[] {
  const since = sinceIso ? Date.parse(sinceIso) : NaN;
  const excerpts: SessionExcerpt[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let record: any;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record?.type !== "user" && record?.type !== "assistant") continue;
    const recordedAt = typeof record.timestamp === "string" ? record.timestamp : "";
    if (!Number.isNaN(since) && recordedAt && Date.parse(recordedAt) < since) continue;

    if (record.type === "user") {
      const text = typeof record.message?.content === "string" ? record.message.content.trim() : "";
      if (!text) continue;
      if (SKIPPED_USER_PREFIXES.some(prefix => text.startsWith(prefix))) continue;
      excerpts.push({ role: "user", recordedAt, text });
    } else {
      const text = readTextBlocks(record.message?.content);
      if (!text) continue;
      excerpts.push({ role: "assistant", recordedAt, text });
    }
  }
  return excerpts;
}

/**
 * Codex records a session as a rollout whose header carries the working directory,
 * so its sessions are matched by path rather than by a slugged directory name.
 * Returns null when the file is not a rollout header at all.
 */
export function codexRolloutCwd(headLine: string): string | null {
  try {
    const record = JSON.parse(headLine);
    if (record?.type !== "session_meta") return null;
    const cwd = record.payload?.cwd;
    return typeof cwd === "string" && cwd ? cwd : null;
  } catch {
    return null;
  }
}

/** True for the project's own directory and for anything inside it, which is where
 * linked worktrees live. */
export function isPathInsideProject(cwd: string, projectRoot: string): boolean {
  return cwd === projectRoot || cwd.startsWith(`${projectRoot}/`);
}

/**
 * The Codex equivalent of {@link extractSessionExcerpts}.
 *
 * Codex writes reasoning, tool calls and token counts into the same stream — in a
 * measured rollout, 900 lines carried 4 user messages and 30 agent messages, and
 * everything else was machinery.
 */
export function extractCodexExcerpts(lines: string[], sinceIso: string | null): SessionExcerpt[] {
  const since = sinceIso ? Date.parse(sinceIso) : NaN;
  const excerpts: SessionExcerpt[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let record: any;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record?.type !== "event_msg") continue;
    const kind = record.payload?.type;
    if (kind !== "user_message" && kind !== "agent_message") continue;
    const text = typeof record.payload?.message === "string" ? record.payload.message.trim() : "";
    if (!text) continue;
    if (kind === "user_message" && SKIPPED_USER_PREFIXES.some(prefix => text.startsWith(prefix))) continue;
    const recordedAt = typeof record.timestamp === "string" ? record.timestamp : "";
    if (!Number.isNaN(since) && recordedAt && Date.parse(recordedAt) < since) continue;
    excerpts.push({ role: kind === "user_message" ? "user" : "assistant", recordedAt, text });
  }
  return excerpts;
}

/**
 * Renders the newest excerpts that fit, in chronological order.
 *
 * Newest-first selection with chronological output: when the budget forces a cut
 * it should drop the oldest exchange, not the conclusion the session reached.
 */
export function renderSessionContext(excerpts: SessionExcerpt[], budgetBytes: number): string {
  const kept: string[] = [];
  let used = 0;
  for (let i = excerpts.length - 1; i >= 0; i -= 1) {
    const excerpt = excerpts[i]!;
    const label = excerpt.role === "user" ? "사용자" : "에이전트";
    // A single long answer must not evict the whole rest of the session.
    const body = excerpt.text.length > 4_000 ? `${excerpt.text.slice(0, 4_000)}\n…(생략)` : excerpt.text;
    const block = `[${label}${excerpt.recordedAt ? ` ${excerpt.recordedAt}` : ""}]\n${body}`;
    const size = Buffer.byteLength(block, "utf8") + 2;
    if (used + size > budgetBytes) break;
    kept.push(block);
    used += size;
  }
  return kept.reverse().join("\n\n");
}
