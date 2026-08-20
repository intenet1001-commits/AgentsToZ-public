import type { ContextSurfacePresence } from './contextSessionPresence';
import type { ClaudeSessionRuntimeFacts } from './sessionOrigin';

/**
 * `claude agents --json --all` is the only authoritative record of Claude Code
 * background agents. A background agent runs under the Claude daemon, so its
 * status-line snapshot carries no terminal environment at all — without this
 * inventory such a session is indistinguishable from a terminal session whose
 * host we failed to identify, which is how it used to end up labelled
 * "실행 위치 미확인 · 이동 미지원".
 *
 * The listing contains background sessions only, so it is used to make
 * positive claims and nothing else: a session that is absent from it is not
 * thereby proven closed, merely not a background agent we know about.
 */
export type ClaudeAgentState = 'working' | 'blocked' | 'done' | 'failed' | 'unknown';

/**
 * The listing carries running terminal sessions alongside background agents.
 * They are different things — only a background agent is opened through Agent
 * View — but both are evidence that a session is alive, so both belong here.
 */
export type ClaudeAgentKind = 'background' | 'interactive';

export interface ClaudeAgentInventoryEntry {
  sessionId: string;
  kind: ClaudeAgentKind;
  state: ClaudeAgentState;
  /** Present only while the agent process is actually running. */
  pid: number | null;
}

export type ClaudeAgentInventory =
  | { kind: 'unavailable' }
  | { kind: 'listed'; entries: Map<string, ClaudeAgentInventoryEntry> };

export const UNAVAILABLE_CLAUDE_AGENT_INVENTORY: ClaudeAgentInventory = { kind: 'unavailable' };

const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function normalizeState(value: unknown): ClaudeAgentState {
  switch (value) {
    case 'working':
    case 'blocked':
    case 'done':
    case 'failed':
      return value;
    default:
      // Forward compatibility: an unrecognized state must not be read as
      // either alive or finished.
      return 'unknown';
  }
}

/** An agent still reachable from Agent View. `blocked` counts: it is waiting
 * for the user, which is exactly when they want to jump to it. */
export function isLiveClaudeAgentState(state: ClaudeAgentState): boolean {
  return state === 'working' || state === 'blocked';
}

/** Completed background agents are listed with a finished state; a finished
 * terminal session simply leaves the listing. So an interactive entry is by
 * itself proof that the session is still running. */
export function isLiveClaudeAgentEntry(entry: ClaudeAgentInventoryEntry): boolean {
  return entry.kind === 'interactive' || isLiveClaudeAgentState(entry.state);
}

export function isFinishedClaudeAgentState(state: ClaudeAgentState): boolean {
  return state === 'done' || state === 'failed';
}

export function parseClaudeAgentInventory(raw: unknown): ClaudeAgentInventory {
  if (!Array.isArray(raw)) return UNAVAILABLE_CLAUDE_AGENT_INVENTORY;
  const entries = new Map<string, ClaudeAgentInventoryEntry>();
  for (const value of raw) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    // Dropping interactive rows made every running terminal session look absent
    // from the listing, which is the same shape as a session that has ended.
    if (record.kind !== 'background' && record.kind !== 'interactive') continue;
    const sessionId = record.sessionId;
    if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) continue;
    const pid = typeof record.pid === 'number' && Number.isInteger(record.pid) && record.pid > 0
      ? record.pid
      : null;
    const entry: ClaudeAgentInventoryEntry = {
      sessionId,
      kind: record.kind === 'interactive' ? 'interactive' : 'background',
      state: normalizeState(record.state),
      pid,
    };
    const previous = entries.get(sessionId);
    // A live record always wins over a stale duplicate of the same session.
    if (!previous || (!isLiveClaudeAgentEntry(previous) && isLiveClaudeAgentEntry(entry))) {
      entries.set(sessionId, entry);
    }
  }
  return { kind: 'listed', entries };
}

export function findClaudeAgentEntry(
  inventory: ClaudeAgentInventory,
  sessionId: string,
): ClaudeAgentInventoryEntry | null {
  return inventory.kind === 'listed' ? inventory.entries.get(sessionId) ?? null : null;
}

/** Only a live background agent is described as one. A finished agent keeps no
 * surface, and describing it as a background agent would imply it can still be
 * opened in Agent View. */
export function claudeAgentRuntimeFacts(
  inventory: ClaudeAgentInventory,
  sessionId: string,
): ClaudeSessionRuntimeFacts {
  const entry = findClaudeAgentEntry(inventory, sessionId);
  // A running terminal session is live but is not a background agent: calling it
  // one would send the user to Agent View for a window that already exists.
  return {
    backgroundAgent: !!entry && entry.kind === 'background' && isLiveClaudeAgentState(entry.state),
  };
}

/**
 * Presence for a background agent. `not-applicable` means "this probe has
 * nothing to say" — the session is not a known background agent, so the Orca
 * and cmux probes remain responsible for it.
 *
 * An unreadable listing must also say nothing. `unverified` would be a claim
 * about a surface we never identified, and the panel hides unverified rows —
 * so a missing or failing `claude` CLI would erase every plain-terminal Claude
 * session from the list instead of leaving it the recent record it is.
 */
export interface RememberedClaudeAgentInventory {
  at: number;
  inventory: ClaudeAgentInventory;
}

/**
 * Keep answering from the last successful listing for a short while when a call
 * fails. Without this, one failed `claude agents` invocation drops every
 * background-agent row back to an unidentified one — a finished agent flickers
 * back into the list for a poll or two and then disappears again, which reads as
 * the panel refreshing wrongly.
 *
 * The grace period is deliberately short: a remembered listing may hide a
 * finished agent, but it must never keep claiming one is live for long.
 */
export function resolveClaudeAgentInventory(
  fresh: ClaudeAgentInventory,
  remembered: RememberedClaudeAgentInventory | null | undefined,
  now: number,
  graceMs: number,
): ClaudeAgentInventory {
  if (fresh.kind === 'listed') return fresh;
  if (remembered && remembered.inventory.kind === 'listed' && now - remembered.at < graceMs) {
    return remembered.inventory;
  }
  return UNAVAILABLE_CLAUDE_AGENT_INVENTORY;
}

export interface ClaudeAgentPresenceInput {
  /**
   * Whether the snapshot carries any terminal identity at all — an Orca or cmux
   * id, or a TERM_PROGRAM. Every terminal that can host Claude sets one, so a
   * snapshot with none of them was written by a background agent.
   *
   * The caller passes `true` when unsure: that only ever keeps a row visible.
   */
  hasTerminalEvidence: boolean;
}

export function claudeAgentSurfacePresence(
  inventory: ClaudeAgentInventory,
  sessionId: string,
  input: ClaudeAgentPresenceInput = { hasTerminalEvidence: true },
): ContextSurfacePresence {
  if (inventory.kind !== 'listed') return 'not-applicable';
  const entry = inventory.entries.get(sessionId);
  if (entry) {
    if (isLiveClaudeAgentEntry(entry)) return 'live';
    if (isFinishedClaudeAgentState(entry.state)) return 'gone';
    // A listed agent in an unrecognized state is a surface we did identify but
    // could not resolve, which is what `unverified` is for.
    return 'unverified';
  }
  // No terminal wrote this snapshot and the readable listing has no such agent:
  // it was a background agent that no longer exists — most often one cleared
  // from Agent View, which would otherwise come back as an unidentifiable row.
  return input.hasTerminalEvidence ? 'not-applicable' : 'gone';
}

/** The launch fields that prove a terminal, kept next to the rule that reads them. */
export function hasTerminalLaunchEvidence(launchContext: {
  orcaWorktreeId?: unknown;
  cmuxWorkspaceId?: unknown;
  cmuxSurfaceId?: unknown;
  termProgram?: unknown;
} | null | undefined): boolean {
  const ctx = launchContext ?? {};
  return !!(ctx.orcaWorktreeId || ctx.cmuxWorkspaceId || ctx.cmuxSurfaceId || ctx.termProgram);
}
