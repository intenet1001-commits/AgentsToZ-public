import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  claudeProjectSlugCandidates,
  codexRolloutCwd,
  codexTranscriptMessage,
  extractCodexExcerpts,
  extractOwnedClaudeSessionExcerpts,
  parseWorktreePaths,
  type SessionExcerpt,
} from "./sessionTranscript";
import {
  advanceWhatISaidScan,
  beginWhatISaidCollection,
  finishWhatISaidCollection,
  captureWhatISaidPrompt,
  captureWhatISaidWithheldTranscriptRecord,
  commitWhatISaidTranscriptClassifications,
  commitWhatISaidDiscoveryCursor,
  commitWhatISaidTranscriptCursor,
  deriveWhatISaidTranscriptSourceId,
  readWhatISaidDiscoveryCursor,
  readWhatISaidTranscriptCursor,
  readWhatISaidStatus,
  readWhatISaidTranscriptClassifications,
  verifyWhatISaidTranscriptCursorAnchor,
  type WhatISaidCryptoLocation,
  type WhatISaidPromptOrigin,
  type WhatISaidTranscriptCursor,
} from "./whatISaidStore";
import {
  CODEX_DELIVERY_LOOKBACK_BYTES,
  previousCodexDeliveryRecord,
  WhatISaidCodexDeliveryTracker,
  type WhatISaidPromptDelivery,
} from './whatISaidCodexDelivery';

/**
 * Transcript discovery for opted-in What-I-said projects.
 *
 * Ownership comes only from the exact roots reported by `git worktree list`.
 * Directory-name prefix guessing is intentionally absent: it can sweep a
 * sibling repository into this high-sensitivity store.
 */

export interface WhatISaidTranscriptCollectorInput extends WhatISaidCryptoLocation {
  now?: string;
  /** Primary root overrides for isolated tests; additional account roots below come from the host registry. */
  claudeProjectsDir?: string;
  codexSessionsDir?: string;
  /** Host-resolved account roots; all roots share the existing scan budget and project consent. */
  additionalClaudeProjectsDirs?: readonly string[];
  additionalCodexSessionsDirs?: readonly string[];
  worktreeRoots?: readonly string[];
  gitWorktreeList?: (projectRoot: string) => string;
  gitTopLevel?: (projectRoot: string) => string | null;
  scanByteBudget?: number;
  /** Cooperative only: checked between records and files, never interrupts I/O. */
  scanDeadlineAt?: number;
  /** Injectable stop check for deterministic tests. */
  scanShouldStop?: () => boolean;
  /**
   * Explicit user-initiated backfill: scan from the beginning of the available
   * transcripts instead of from the consent instant, and let the store keep
   * entries recorded before capture was enabled. Automatic capture never sets
   * this — turning the policy on must not silently ingest past conversations.
   */
  backfill?: boolean;
  /**
   * A later pass of the same explicit backfill request. Only then may a Codex
   * verification page left by the previous pass be resumed; a new request
   * re-verifies every file against the saved baseline from the first one.
   */
  backfillContinuation?: boolean;
  /**
   * 이 프롬프트를 수집한 기기. 행에 함께 박아 두면 나중에 아카이브·복원·원격
   * 적재로 여러 기기의 기록이 합쳐져도 출처를 되찾을 수 있다.
   */
  deviceId?: string | null;
  deviceName?: string | null;
  /** Content-free clipboard evidence supplied by the local sidecar. */
  promptOrigin?: (text: string, recordedAt: string, delivery: WhatISaidPromptDelivery) => WhatISaidPromptOrigin;
}

export interface WhatISaidTranscriptCollectionResult {
  enabled: boolean;
  enabledAt: string | null;
  scannedFrom: string | null;
  scannedThrough: string | null;
  scanAdvanced: boolean;
  worktreeRoots: number;
  claudeFiles: number;
  codexFiles: number;
  userEvents: number;
  stored: number;
  duplicates: number;
  skippedBeforeEnabled: number;
  skippedExpired: number;
  unreadable: number;
  withheld: number;
  ownershipRejected: number;
  bytesRead: number;
  pendingFiles: number;
  budgetExhausted: boolean;
  hasMore: boolean;
  /** The observed transcript snapshot changed during a historical scan. */
  snapshotChanged?: boolean;
  /** A complete header, anchor, or record cannot fit in one scan budget. */
  minimumBudgetInsufficient?: boolean;
  /**
   * A multi-page validation cannot certify that earlier files stayed unchanged.
   * The collector no longer reports it: verification resumes within one
   * request and restarts (without a new baseline) on the next request. The
   * runner and the routes still stop on it for any other producer.
   */
  verificationUncertain?: boolean;
}

function emptyResult(enabled: boolean, enabledAt: string | null): WhatISaidTranscriptCollectionResult {
  return {
    enabled,
    enabledAt,
    scannedFrom: null,
    scannedThrough: null,
    scanAdvanced: false,
    worktreeRoots: 0,
    claudeFiles: 0,
    codexFiles: 0,
    userEvents: 0,
    stored: 0,
    duplicates: 0,
    skippedBeforeEnabled: 0,
    skippedExpired: 0,
    unreadable: 0,
    withheld: 0,
    ownershipRejected: 0,
    bytesRead: 0,
    pendingFiles: 0,
    budgetExhausted: false,
    hasMore: false,
  };
}

function productionWorktreeList(projectRoot: string): string {
  const result = spawnSync("git", ["-C", projectRoot, "worktree", "list", "--porcelain"], {
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return result.status === 0 && typeof result.stdout === "string" ? result.stdout : "";
}

function productionGitTopLevel(projectRoot: string): string | null {
  const result = spawnSync("git", ["-C", projectRoot, "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0 || typeof result.stdout !== "string") return null;
  return result.stdout.trim() || null;
}

function canonicalDirectory(path: string): string | null {
  const requested = resolve(path);
  if (!existsSync(requested)) return null;
  const info = lstatSync(requested);
  if (info.isSymbolicLink() || !info.isDirectory()) return null;
  // Keep git's exact lexical root for Claude's on-disk slug. Resolving an
  // intermediate macOS /var -> /private/var alias changes that slug and drops
  // every otherwise-valid transcript. Final-path symlinks are still rejected.
  return requested;
}

function comparableDirectory(path: string): string | null {
  const lexical = canonicalDirectory(path);
  if (!lexical) return null;
  try {
    return realpathSync(lexical);
  } catch {
    return null;
  }
}

function comparablePath(path: string): string | null {
  let existing = resolve(path);
  const suffix: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) return null;
    suffix.unshift(basename(existing));
    existing = parent;
  }
  try {
    if (!lstatSync(existing).isDirectory()) return null;
    return resolve(realpathSync(existing), ...suffix);
  } catch {
    return null;
  }
}

function pathBelongsToRoot(path: string, root: string): boolean {
  const comparableCandidate = comparablePath(path);
  const comparableRoot = comparableDirectory(root);
  if (!comparableCandidate || !comparableRoot) return false;
  const child = relative(comparableRoot, comparableCandidate);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

export function exactWhatISaidWorktreeRoots(input: {
  projectRoot: string;
  worktreeRoots?: readonly string[];
  gitWorktreeList?: (projectRoot: string) => string;
  gitTopLevel?: (projectRoot: string) => string | null;
}): string[] {
  const projectRoot = canonicalDirectory(input.projectRoot);
  if (!projectRoot) return [];
  const candidates = input.worktreeRoots === undefined
    ? parseWorktreePaths((input.gitWorktreeList ?? productionWorktreeList)(projectRoot))
    : [...input.worktreeRoots];
  const exactCandidates = candidates
    .map(canonicalDirectory)
    .filter((value): value is string => value !== null);
  const reportedTopLevelValue = (input.gitTopLevel ?? productionGitTopLevel)(projectRoot);
  const reportedTopLevel = reportedTopLevelValue
    ? canonicalDirectory(reportedTopLevelValue)
    : null;
  // A memory can belong to a monorepo subdirectory rather than the whole Git
  // checkout. Map that relative subpath onto every exact porcelain worktree;
  // otherwise a nested memory could absorb prompts from unrelated packages.
  const inferredTopLevel = exactCandidates
    .filter(candidate => pathBelongsToRoot(projectRoot, candidate))
    .sort((left, right) => (comparableDirectory(left)?.length ?? left.length)
      - (comparableDirectory(right)?.length ?? right.length))[0] ?? null;
  const topLevel = reportedTopLevel
    && pathBelongsToRoot(projectRoot, reportedTopLevel)
    ? reportedTopLevel
    : inferredTopLevel;
  const comparableTopLevel = topLevel ? comparableDirectory(topLevel) : null;
  const comparableProjectRoot = comparableDirectory(projectRoot);
  const projectSubpath = comparableTopLevel && comparableProjectRoot
    ? relative(comparableTopLevel, comparableProjectRoot)
    : "";

  // The selected project root is always in scope. Additional roots come only
  // from exact Git output and, for nested projects, their matching subpath.
  const roots = new Map<string, string>();
  const projectRootIdentity = comparableProjectRoot ?? projectRoot;
  roots.set(projectRootIdentity, projectRoot);
  for (const candidate of exactCandidates) {
    const mapped = canonicalDirectory(projectSubpath ? join(candidate, projectSubpath) : candidate);
    if (!mapped) continue;
    roots.set(comparableDirectory(mapped) ?? mapped, mapped);
  }
  // Preserve the caller's lexical path for its Claude transcript slug when a
  // Git-reported real path refers to the same directory.
  roots.set(projectRootIdentity, projectRoot);
  return [...roots.values()];
}

function regularJsonlFiles(directory: string, recursive: boolean): string[] {
  const root = canonicalDirectory(directory);
  if (!root) return [];
  const found: string[] = [];
  const pending = [root];
  while (pending.length) {
    const current = pending.pop()!;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (recursive) pending.push(path);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".jsonl")) found.push(path);
    }
  }
  return found.sort();
}

const READ_CHUNK_BYTES = 64 * 1024;
const MAX_JSONL_RECORD_BYTES = 4 * 1024 * 1024;
const DEFAULT_SCAN_BYTE_BUDGET = 8 * 1024 * 1024;
const DISCOVERY_BATCH_SIZE = 256;

interface ScanBudget {
  remaining: number;
}

function scanStopped(input: WhatISaidTranscriptCollectorInput): boolean {
  return input.scanShouldStop?.() === true
    || (input.scanDeadlineAt !== undefined && Date.now() >= input.scanDeadlineAt);
}

function discoverySnapshot(candidates: readonly { file: string; sourceId: string }[]): string {
  return createHash('sha256').update(JSON.stringify(candidates.map(candidate => {
    const info = lstatSync(candidate.file);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error('Transcript changed during discovery');
    return [candidate.sourceId, String(info.dev), String(info.ino), info.size, info.mtimeMs, info.birthtimeMs];
  }))).digest('hex');
}

class SnapshotBudgetExhausted extends Error {}

/** Full metadata of one candidate; any write that moves size or mtime changes it. */
function codexCandidateMetadata(candidate: { sourceId: string }, info: { dev: number | bigint; ino: number | bigint; size: number; mtimeMs: number; birthtimeMs: number }): string {
  return createHash('sha256').update(JSON.stringify([candidate.sourceId, String(info.dev), String(info.ino),
    info.size, info.mtimeMs, info.birthtimeMs])).digest('hex');
}

/**
 * Metadata chain of the first `count` candidates, read with lstat only (no
 * scan budget). Equal to the chain saved while they were checked means none
 * of them was written since; null when one can no longer be read.
 */
function codexPrefixMetadata(candidates: readonly { file: string; sourceId: string }[], count: number): string | null {
  let chain = EMPTY_SNAPSHOT_HASH;
  try {
    for (const candidate of candidates.slice(0, count)) {
      const info = lstatSync(candidate.file);
      if (info.isSymbolicLink() || !info.isFile()) return null;
      chain = snapshotChain(chain, codexCandidateMetadata(candidate, info));
    }
  } catch {
    return null;
  }
  return chain;
}

/**
 * Foreign append-only bodies are irrelevant, but a changed ownership header is not.
 * `metadata` comes from the lstat taken before the header read, so a write
 * racing with the read always makes a later metadata comparison differ.
 */
function codexCandidateSnapshot(candidate: { file: string; sourceId: string },
  roots: readonly string[], budget: ScanBudget, result: WhatISaidTranscriptCollectionResult,
  shouldStop: () => boolean): { evidence: string; metadata: string } {
  let metadata = '';
  const evidence = (() => {
    const info = lstatSync(candidate.file);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error('Transcript changed during discovery');
    metadata = codexCandidateMetadata(candidate, info);
    const handle = openSync(candidate.file, 'r');
    let header: string | null = null;
    try {
      const chunks: Buffer[] = [];
      let position = 0;
      while (position < 262_144 && position < info.size) {
        if (budget.remaining <= 0 || shouldStop()) throw new SnapshotBudgetExhausted();
        const bytes = readWithinBudget(handle, position, Math.min(position === 0 ? 128 : Math.min(position, 4096), 262_144 - position), budget, result);
        if (!bytes.length) break;
        const newline = bytes.indexOf(0x0a);
        if (newline >= 0) { chunks.push(bytes.subarray(0, newline)); header = Buffer.concat(chunks).toString('utf8'); break; }
        chunks.push(bytes);
        position += bytes.length;
      }
    } finally { closeSync(handle); }
    const cwd = header ? codexRolloutCwd(header) : null;
    if (cwd && !cwdBelongsToExactRoot(cwd, roots)) {
      return [candidate.sourceId, String(info.dev), String(info.ino), info.birthtimeMs, header];
    }
    // Unknown, incomplete or owned headers retain the conservative full
    // metadata check. Ownership changes therefore invalidate completion.
    return [candidate.sourceId, String(info.dev), String(info.ino), info.size, info.mtimeMs, info.birthtimeMs];
  })();
  return { evidence: createHash('sha256').update(JSON.stringify(evidence)).digest('hex'), metadata };
}

const EMPTY_SNAPSHOT_HASH = '0'.repeat(64);
type CodexSnapshotPhase = 'b' | 'r' | 'v' | 'd';
function snapshotChain(previous: string, value: string): string {
  return createHash('sha256').update(previous).update(value).digest('hex');
}
/** `meta` is the metadata chain of the files a verification has checked so far (absent in older states). */
function codexSnapshotParts(identity: string | undefined): { membership: string; phase: CodexSnapshotPhase; target: number; baseline: string; running: string; meta: string } | null {
  if (!identity) return null;
  const match = /^([a-f0-9]{64}):([brvd]):([0-9]{1,8}):([a-f0-9]{64}):([a-f0-9]{64})(?::([a-f0-9]{64}))?$/.exec(identity);
  return match ? { membership: match[1]!, phase: match[2] as CodexSnapshotPhase, target: Number(match[3]), baseline: match[4]!, running: match[5]!, meta: match[6] ?? EMPTY_SNAPSHOT_HASH } : null;
}

function discoveryParts(identity: string | undefined): { membership: string; snapshot: string; after: string } | null {
  if (!identity) return null;
  const match = /^([a-f0-9]{64}):([a-f0-9]{64}):(wisc_[a-f0-9]{64}|)$/.exec(identity);
  return match ? { membership: match[1]!, snapshot: match[2]!, after: match[3]! } : null;
}

function readWithinBudget(
  handle: number,
  position: number,
  requested: number,
  budget: ScanBudget,
  result: WhatISaidTranscriptCollectionResult,
): Buffer {
  const length = Math.min(requested, budget.remaining);
  if (length <= 0) return Buffer.alloc(0);
  const buffer = Buffer.allocUnsafe(length);
  const read = readSync(handle, buffer, 0, length, position);
  budget.remaining -= read;
  result.bytesRead += read;
  return buffer.subarray(0, read);
}

function firstLineWithinBudget(
  path: string,
  budget: ScanBudget,
  result: WhatISaidTranscriptCollectionResult,
  maxBytes = 262_144,
): string | null {
  const handle = openSync(path, "r");
  try {
    const chunks: Buffer[] = [];
    let offset = 0;
    while (offset < maxBytes && budget.remaining > 0) {
      const bytes = readWithinBudget(handle, offset, Math.min(offset === 0 ? 128 : Math.min(offset, 4096), maxBytes - offset), budget, result);
      if (!bytes.length) break;
      const newline = bytes.indexOf(0x0a);
      if (newline !== -1) {
        chunks.push(bytes.subarray(0, newline));
        return Buffer.concat(chunks).toString('utf8');
      }
      chunks.push(bytes);
      offset += bytes.length;
    }
    // Never classify an incomplete header as a foreign session.
    return null;
  } finally {
    closeSync(handle);
  }
}

function transcriptFileSnapshot(path: string): {
  fileIdentity: string;
  size: number;
  mtimeMs: number;
} {
  const handle = openSync(path, "r");
  try {
    const info = fstatSync(handle);
    if (!info.isFile()) throw new Error("not a regular transcript");
    return {
      fileIdentity: `${String(info.dev)}:${String(info.ino)}:${Math.trunc(info.birthtimeMs)}`,
      size: info.size,
      mtimeMs: info.mtimeMs,
    };
  } finally {
    closeSync(handle);
  }
}

function cwdBelongsToExactRoot(cwd: string, roots: readonly string[]): boolean {
  return roots.some(root => pathBelongsToRoot(cwd, root));
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function hasMalformedOwnedUserSchema(
  record: Record<string, unknown>,
  sourceAgent: "claude" | "codex",
): boolean {
  if (sourceAgent === "claude") {
    if (record.type !== "user") return false;
    const message = isJsonRecord(record.message) ? record.message : null;
    if (typeof record.timestamp !== "string" || !Number.isFinite(Date.parse(record.timestamp))) return true;
    if (isClaudeHostUserRow(record, message?.content)) return false;
    return typeof message?.content !== "string"
      || message.content.trim().length === 0
      || message.content.includes("\0");
  }
  const message = codexTranscriptMessage(record);
  if (message?.role !== 'user') return false;
  return typeof record.timestamp !== "string"
    || !Number.isFinite(Date.parse(record.timestamp))
    || message.text.length === 0
    || message.text.includes("\0");
}

// Claude Code also writes tool results, and harness-injected context such as a
// skill body, as `type: "user"` rows with array content. They are not the
// person's words, so they are neither prompts nor malformed prompts: a receipt
// for each would mark every scan of an active Claude session partial. A
// non-meta array that carries text (a prompt with a pasted image) stays a
// receipt, because it may be the person's request.
function isClaudeHostUserRow(record: Record<string, unknown>, content: unknown): boolean {
  if (!Array.isArray(content) || content.length === 0 || !content.every(isJsonRecord)) return false;
  if (content.every(block => block.type === "tool_result")) return true;
  return record.isMeta === true && content.every(block => block.type === "text");
}

const CLAUDE_COMMAND_TAG = /<(command-message|command-name|command-args)>([\s\S]*?)<\/\1>/g;

// A slash command the person typed (`/skill some words`) reaches the transcript
// only as command-* wrapper tags, which the shared excerpt reader skips as host
// markup. Its arguments are the person's own request, so keep `/name args`.
// A command without arguments (`/clear`) and a model-invoked skill (isMeta)
// carry no words of the person and stay skipped, as before.
function claudeTypedCommandExcerpt(record: Record<string, unknown>, captureSince: string): SessionExcerpt | null {
  if (record.type !== "user" || record.isMeta === true || record.isSidechain === true) return null;
  const content = isJsonRecord(record.message) ? record.message.content : null;
  if (typeof content !== "string" || typeof record.timestamp !== "string") return null;
  const recordedMs = Date.parse(record.timestamp);
  const sinceMs = Date.parse(captureSince);
  if (!Number.isFinite(recordedMs) || Number.isFinite(sinceMs) && recordedMs < sinceMs) return null;
  const tags = new Map<string, string>();
  let repeated = false;
  const rest = content.replace(CLAUDE_COMMAND_TAG, (_, tag: string, value: string) => {
    if (tags.has(tag)) repeated = true;
    tags.set(tag, value);
    return "";
  });
  if (repeated || rest.trim()) return null;
  const name = tags.get("command-name")?.trim() ?? "";
  const args = tags.get("command-args")?.trim() ?? "";
  if (!/^\/?[^\s<>/][^\s<>]*$/.test(name) || !args || args.includes("\0")) return null;
  return { role: "user", recordedAt: record.timestamp, text: `${name.startsWith("/") ? name : `/${name}`} ${args}` };
}

function receiptMalformedUserLine(input: WhatISaidTranscriptCollectorInput & {
  sourceAgent: "claude" | "codex";
  recordBytes: number;
  lineNumber: number;
  eventSourceIdentity: string;
  result: WhatISaidTranscriptCollectionResult;
}): boolean {
  try {
    const receipt = captureWhatISaidWithheldTranscriptRecord({
      ...input,
      agent: input.sourceAgent,
      sourceIdentity: input.eventSourceIdentity,
      sourceEventIdentity: String(input.lineNumber),
      recordBytes: input.recordBytes,
      reason: "record-malformed",
      now: input.now,
    });
    if (!receipt.stored) return false;
    input.result.withheld += 1;
    return true;
  } catch {
    // A durable-store/key/IO failure is retryable. Do not advance the cursor.
    input.result.unreadable += 1;
    return false;
  }
}

function storeUserLine(input: WhatISaidTranscriptCollectorInput & {
  sourceAgent: "claude" | "codex";
  exactRoots: readonly string[];
  line: string;
  recordBytes: number;
  lineNumber: number;
  captureSince: string;
  eventSourceIdentity: string;
  replaySourceIdentity: string;
  result: WhatISaidTranscriptCollectionResult;
  codexDelivery: WhatISaidCodexDeliveryTracker;
}): boolean {
  let record: unknown;
  try {
    record = JSON.parse(input.line);
  } catch {
    input.codexDelivery.read(null);
    return receiptMalformedUserLine(input);
  }
  if (!isJsonRecord(record)) {
    input.codexDelivery.read(null);
    return receiptMalformedUserLine(input);
  }
  const delivery: WhatISaidPromptDelivery = input.sourceAgent === 'codex'
    ? input.codexDelivery.read(record)
    : record.isMeta === true || record.isSidechain === true ? 'unknown' : 'user-message';

  let excerpts;
  if (input.sourceAgent === "claude") {
    const owned = extractOwnedClaudeSessionExcerpts([input.line], input.captureSince, input.exactRoots);
    if (owned.unreadable > 0) {
      input.result.unreadable += owned.unreadable;
      return false;
    }
    input.result.ownershipRejected += owned.ownershipRejected;
    // A lossy Claude directory slug cannot prove ownership. Do not create even
    // a content-free receipt for a row whose exact cwd belongs elsewhere.
    if (owned.ownershipRejected > 0) return true;
    if (hasMalformedOwnedUserSchema(record, input.sourceAgent)) {
      return receiptMalformedUserLine(input);
    }
    const command = owned.excerpts.length === 0 ? claudeTypedCommandExcerpt(record, input.captureSince) : null;
    excerpts = command ? [command] : owned.excerpts;
  } else {
    if (hasMalformedOwnedUserSchema(record, input.sourceAgent)) {
      return receiptMalformedUserLine(input);
    }
    excerpts = extractCodexExcerpts([input.line], input.captureSince);
  }
  for (const excerpt of excerpts) {
    if (excerpt.role !== "user") continue;
    input.result.userEvents += 1;
    if (!excerpt.recordedAt || !Number.isFinite(Date.parse(excerpt.recordedAt))) {
      input.result.withheld += 1;
      continue;
    }
    try {
      const captured = captureWhatISaidPrompt({
        appDataDir: input.appDataDir,
        projectRoot: input.projectRoot,
        memoryId: input.memoryId,
        key: input.key,
        agent: input.sourceAgent,
        sourceIdentity: input.eventSourceIdentity,
        sourceEventIdentity: String(input.lineNumber),
        replayIdentity: `${input.replaySourceIdentity}:${input.lineNumber}`,
        recordedAt: excerpt.recordedAt,
        text: excerpt.text,
        deviceId: input.deviceId,
        deviceName: input.deviceName,
        promptOrigin: (() => {
          const origin = input.promptOrigin?.(excerpt.text, excerpt.recordedAt, delivery) ?? 'unknown';
          return delivery === 'automated' || delivery === 'unknown' && origin === 'human' ? 'unknown' : origin;
        })(),
        ...(input.backfill === true ? { allowBeforeEnabled: true } : {}),
        now: input.now,
      });
      if (captured.stored) {
        if (captured.duplicate) input.result.duplicates += 1;
        else input.result.stored += 1;
      } else if (captured.reason === "before-enabled") {
        input.result.skippedBeforeEnabled += 1;
      } else if (captured.reason === "expired") {
        input.result.skippedExpired += 1;
      } else if (captured.reason === "prompt-too-large") {
        input.result.withheld += 1;
      }
    } catch {
      input.result.unreadable += 1;
      return false;
    }
  }
  return true;
}

function collectFileIncrementally(input: WhatISaidTranscriptCollectorInput & {
  sourceAgent: "claude" | "codex";
  file: string;
  scannedFrom: string;
  captureSince: string;
  backfillRetention: string | number;
  codexHeaderEvidence?: { bytes: Buffer; fileIdentity: string; size: number; mtimeMs: number };
  candidateStartingBudget?: number;
  exactRoots: readonly string[];
  budget: ScanBudget;
  result: WhatISaidTranscriptCollectionResult;
}): void {
  let handle: number | null = null;
  let pendingCounted = false;
  const markPending = (budgetExhausted = false) => {
    if (!pendingCounted) input.result.pendingFiles += 1;
    pendingCounted = true;
    input.result.hasMore = true;
    if (budgetExhausted) input.result.budgetExhausted = true;
  };
  try {
    const pathInfo = lstatSync(input.file);
    if (pathInfo.isSymbolicLink() || !pathInfo.isFile()) return;
    const canonicalFile = realpathSync(input.file);
    handle = openSync(canonicalFile, "r");
    const info = fstatSync(handle);
    if (!info.isFile()) return;
    const currentHandle = handle;
    // Transcripts are append-only. Once the filesystem says the whole file
    // predates the overlap baseline, reading hundreds of MB cannot discover a
    // candidate event and only turns every capture into an O(history) sweep.
    if (input.backfill !== true && info.mtimeMs < Date.parse(input.scannedFrom)) return;
    const snapshotSize = info.size;
    const fileIdentity = `${String(info.dev)}:${String(info.ino)}:${Math.trunc(info.birthtimeMs)}`;
    const headerEvidence = input.codexHeaderEvidence && input.codexHeaderEvidence.fileIdentity === fileIdentity
      && input.codexHeaderEvidence.size === info.size && input.codexHeaderEvidence.mtimeMs === info.mtimeMs
      ? input.codexHeaderEvidence.bytes : null;
    const readAnchor = (cursor: WhatISaidTranscriptCursor): Buffer | null => {
      const start = cursor.byteOffset - cursor.anchorLength;
      const prefixEnd = headerEvidence ? Math.min(cursor.byteOffset, headerEvidence.byteLength) : start;
      const prefix = headerEvidence && prefixEnd > start ? headerEvidence.subarray(start, prefixEnd) : Buffer.alloc(0);
      const remaining = cursor.anchorLength - prefix.byteLength;
      if (input.budget.remaining < remaining) return null;
      const suffix = remaining ? readWithinBudget(currentHandle, start + prefix.byteLength, remaining, input.budget, input.result) : Buffer.alloc(0);
      return Buffer.concat([prefix, suffix]);
    };
    const cursorSourceIdentity = canonicalFile;
    const sourceId = deriveWhatISaidTranscriptSourceId({
      ...input,
      agent: input.sourceAgent,
      sourceIdentity: cursorSourceIdentity,
    });
    // The regular cursor owns the file generation used in event IDs. Validate
    // it even for an explicit backfill so replacement cannot reuse old IDs.
    let expected = readWhatISaidTranscriptCursor({
      ...input,
      agent: input.sourceAgent,
      sourceIdentity: cursorSourceIdentity,
    });
    let generation = expected?.generation ?? 0;
    let byteOffset = expected?.byteOffset ?? 0;
    let lineNumber = expected?.lineNumber ?? 0;
    let discardUntilNewline = expected?.discardUntilNewline ?? false;
    let anchor: Buffer<ArrayBufferLike> = Buffer.alloc(0);

    let reset = !!expected && (expected.fileIdentity !== fileIdentity || snapshotSize < expected.byteOffset);
    if (expected && !reset && expected.anchorLength > 0) {
      const read = readAnchor(expected);
      if (!read) {
        if (input.backfill === true && input.candidateStartingBudget === (input.scanByteBudget ?? DEFAULT_SCAN_BYTE_BUDGET)) input.result.minimumBudgetInsufficient = true;
        markPending(true);
        return;
      }
      anchor = read;
      reset = anchor.byteLength !== expected.anchorLength
        || !verifyWhatISaidTranscriptCursorAnchor({ ...input, cursor: expected, anchor });
    }
    if (reset && expected) {
      const committed = commitWhatISaidTranscriptCursor({
        ...input,
        agent: input.sourceAgent,
        sourceIdentity: cursorSourceIdentity,
        expected,
        next: {
          generation: expected.generation + 1,
          fileIdentity,
          byteOffset: 0,
          lineNumber: 0,
          anchor: Buffer.alloc(0),
          discardUntilNewline: false,
        },
        now: input.now,
      });
      if (!committed.committed) {
        markPending();
        return;
      }
      expected = committed.cursor;
      generation = committed.cursor.generation;
      byteOffset = 0;
      lineNumber = 0;
      anchor = Buffer.alloc(0);
      discardUntilNewline = false;
    }

    if (input.backfill === true && !expected) {
      // Establish the shared file generation without advancing ordinary capture.
      const committed = commitWhatISaidTranscriptCursor({
        ...input,
        agent: input.sourceAgent,
        sourceIdentity: cursorSourceIdentity,
        expected: null,
        next: { generation: 0, fileIdentity, byteOffset: 0, lineNumber: 0, anchor: Buffer.alloc(0) },
        now: input.now,
      });
      if (!committed.committed) {
        markPending();
        return;
      }
      expected = committed.cursor;
    }
    let eventGeneration = generation;
    const regularCursor = expected;
    let progressSourceIdentity = cursorSourceIdentity;
    let progressFileIdentity = fileIdentity;
    if (input.backfill === true) {
      // Backfill progress is durable but is never resumed by ordinary capture.
      // A fresh explicit request is still required to read before consent.
      progressSourceIdentity = `backfill:${sourceId}`;
      progressFileIdentity = `${fileIdentity}:event-generation:${eventGeneration}:retention:${input.backfillRetention}`;
      expected = readWhatISaidTranscriptCursor({
        ...input,
        agent: input.sourceAgent,
        sourceIdentity: progressSourceIdentity,
      });
      generation = expected?.generation ?? 0;
      byteOffset = expected?.byteOffset ?? 0;
      lineNumber = expected?.lineNumber ?? 0;
      discardUntilNewline = expected?.discardUntilNewline ?? false;
      anchor = Buffer.alloc(0);
      let backfillReset = !!expected && (expected.fileIdentity !== progressFileIdentity || snapshotSize < expected.byteOffset);
      if (expected && !backfillReset && expected.anchorLength > 0) {
        const read = readAnchor(expected);
        if (!read) {
          if (input.backfill === true && input.candidateStartingBudget === (input.scanByteBudget ?? DEFAULT_SCAN_BYTE_BUDGET)) input.result.minimumBudgetInsufficient = true;
          markPending(true);
          return;
        }
        anchor = read;
        backfillReset = anchor.byteLength !== expected.anchorLength
          || !verifyWhatISaidTranscriptCursorAnchor({ ...input, cursor: expected, anchor });
      }
      if (backfillReset && expected?.fileIdentity === progressFileIdentity && regularCursor) {
        // The ordinary cursor may still be at byte zero, or its own anchor may
        // precede a rewrite. An invalid backfill anchor is also evidence of a
        // new file generation and must invalidate the shared event identity.
        const committed = commitWhatISaidTranscriptCursor({
          ...input,
          agent: input.sourceAgent,
          sourceIdentity: cursorSourceIdentity,
          expected: regularCursor,
          next: { generation: regularCursor.generation + 1, fileIdentity, byteOffset: 0, lineNumber: 0, anchor: Buffer.alloc(0) },
          now: input.now,
        });
        if (!committed.committed) {
          markPending();
          return;
        }
        eventGeneration = committed.cursor.generation;
        progressFileIdentity = `${fileIdentity}:event-generation:${eventGeneration}:retention:${input.backfillRetention}`;
      }
      if (backfillReset && expected) {
        const committed = commitWhatISaidTranscriptCursor({
          ...input,
          agent: input.sourceAgent,
          sourceIdentity: progressSourceIdentity,
          expected,
          next: { generation: expected.generation + 1, fileIdentity: progressFileIdentity, byteOffset: 0, lineNumber: 0, anchor: Buffer.alloc(0) },
          now: input.now,
        });
        if (!committed.committed) {
          markPending();
          return;
        }
        expected = committed.cursor;
        generation = committed.cursor.generation;
        byteOffset = 0;
        lineNumber = 0;
        anchor = Buffer.alloc(0);
        discardUntilNewline = false;
      }
    }

    const codexDelivery = new WhatISaidCodexDeliveryTracker();
    if (input.sourceAgent === 'codex' && byteOffset > 0 && byteOffset < snapshotSize && !discardUntilNewline) {
      // Restore only the preceding complete record. Count lookback against the
      // existing budget and reserve most of a small budget for forward work.
      // Missing/oversized evidence degrades to unknown, never guessed human.
      const fromHeader = headerEvidence && byteOffset <= headerEvidence.byteLength;
      const length = Math.min(CODEX_DELIVERY_LOOKBACK_BYTES, byteOffset, fromHeader ? byteOffset : Math.floor(input.budget.remaining / 4));
      const bytes = fromHeader ? headerEvidence!.subarray(byteOffset - length, byteOffset)
        : readWithinBudget(handle, byteOffset - length, length, input.budget, input.result);
      codexDelivery.read(previousCodexDeliveryRecord(bytes, byteOffset === length));
    }
    let readPosition = byteOffset;
    const initialByteOffset = byteOffset;
    let pending = Buffer.alloc(0);
    let blocked = false;
    while (readPosition < snapshotSize && !blocked) {
      if (input.budget.remaining <= 0 || scanStopped(input)) {
        markPending(true);
        break;
      }
      const chunk = readWithinBudget(
        handle,
        readPosition,
        Math.min(READ_CHUNK_BYTES, snapshotSize - readPosition),
        input.budget,
        input.result,
      );
      if (!chunk.byteLength) {
        input.result.unreadable += 1;
        blocked = true;
        markPending();
        break;
      }
      readPosition += chunk.byteLength;
      pending = Buffer.concat([pending, chunk]);
      let progressed = false;
      if (discardUntilNewline) {
        const newline = pending.indexOf(0x0a);
        const consumed = newline === -1 ? pending : pending.subarray(0, newline + 1);
        byteOffset += consumed.byteLength;
        anchor = Buffer.concat([anchor, consumed]).subarray(-Math.min(256, byteOffset));
        pending = newline === -1 ? Buffer.alloc(0) : pending.subarray(newline + 1);
        if (newline !== -1) {
          lineNumber += 1;
          discardUntilNewline = false;
        }
        progressed = consumed.byteLength > 0;
      }
      while (pending.byteLength > 0) {
        if (scanStopped(input)) {
          blocked = true;
          markPending(true);
          break;
        }
        const newline = pending.indexOf(0x0a);
        if (newline === -1) {
          if (pending.byteLength <= MAX_JSONL_RECORD_BYTES) break;
          codexDelivery.read(null);
          const nextLineNumber = lineNumber + 1;
          const eventSourceIdentity = eventGeneration === 0
            ? `${input.sourceAgent}:${canonicalFile}`
            : `what-i-said-transcript:${sourceId}:g${eventGeneration}`;
          const receipt = captureWhatISaidWithheldTranscriptRecord({
            ...input,
            agent: input.sourceAgent,
            sourceIdentity: eventSourceIdentity,
            sourceEventIdentity: String(nextLineNumber),
            recordBytes: pending.byteLength,
            reason: "record-too-large",
            now: input.now,
          });
          if (!receipt.stored) {
            blocked = true;
            markPending();
            break;
          }
          input.result.withheld += 1;
          byteOffset += pending.byteLength;
          anchor = Buffer.concat([anchor, pending]).subarray(-Math.min(256, byteOffset));
          pending = Buffer.alloc(0);
          discardUntilNewline = true;
          progressed = true;
          break;
        }
        const rawRecord = pending.subarray(0, newline + 1);
        if (rawRecord.byteLength > MAX_JSONL_RECORD_BYTES) {
          codexDelivery.read(null);
          const nextLineNumber = lineNumber + 1;
          const eventSourceIdentity = eventGeneration === 0
            ? `${input.sourceAgent}:${canonicalFile}`
            : `what-i-said-transcript:${sourceId}:g${eventGeneration}`;
          const receipt = captureWhatISaidWithheldTranscriptRecord({
            ...input,
            agent: input.sourceAgent,
            sourceIdentity: eventSourceIdentity,
            sourceEventIdentity: String(nextLineNumber),
            recordBytes: rawRecord.byteLength,
            reason: "record-too-large",
            now: input.now,
          });
          if (!receipt.stored) {
            blocked = true;
            markPending();
            break;
          }
          input.result.withheld += 1;
          byteOffset += rawRecord.byteLength;
          lineNumber = nextLineNumber;
          anchor = Buffer.concat([anchor, rawRecord]).subarray(-Math.min(256, byteOffset));
          pending = pending.subarray(rawRecord.byteLength);
          progressed = true;
          continue;
        }
        let lineBytes = rawRecord.subarray(0, rawRecord.byteLength - 1);
        if (lineBytes.at(-1) === 0x0d) lineBytes = lineBytes.subarray(0, lineBytes.byteLength - 1);
        const nextLineNumber = lineNumber + 1;
        const eventSourceIdentity = eventGeneration === 0
          ? `${input.sourceAgent}:${canonicalFile}`
          : `what-i-said-transcript:${sourceId}:g${eventGeneration}`;
        if (lineBytes.byteLength > 0 && !storeUserLine({
          ...input,
          line: lineBytes.toString("utf8"),
          recordBytes: rawRecord.byteLength,
          lineNumber: nextLineNumber,
          eventSourceIdentity,
          replaySourceIdentity: sourceId,
          codexDelivery,
        })) {
          blocked = true;
          markPending();
          break;
        }
        byteOffset += rawRecord.byteLength;
        lineNumber = nextLineNumber;
        anchor = Buffer.concat([anchor, rawRecord]).subarray(-Math.min(256, byteOffset));
        pending = pending.subarray(rawRecord.byteLength);
        progressed = true;
      }
      if (progressed) {
        const committed = commitWhatISaidTranscriptCursor({
          ...input,
          agent: input.sourceAgent,
          sourceIdentity: progressSourceIdentity,
          expected,
          next: { generation, fileIdentity: progressFileIdentity, byteOffset, lineNumber, anchor, discardUntilNewline },
          now: input.now,
        });
        if (!committed.committed) {
          blocked = true;
          markPending();
          break;
        }
        expected = committed.cursor;
      }
    }
    if (!blocked && byteOffset < snapshotSize) {
      markPending(input.budget.remaining <= 0 && readPosition < snapshotSize);
    }
    if (input.backfill === true && input.candidateStartingBudget === (input.scanByteBudget ?? DEFAULT_SCAN_BYTE_BUDGET)
      && input.budget.remaining === 0 && byteOffset === initialByteOffset && pending.byteLength > 0
      && pending.indexOf(0x0a) < 0 && readPosition < snapshotSize) {
      input.result.minimumBudgetInsufficient = true;
    }
  } catch {
    input.result.unreadable += 1;
    markPending();
  } finally {
    if (handle !== null) closeSync(handle);
  }
}

export function collectWhatISaidTranscripts(
  input: WhatISaidTranscriptCollectorInput,
): WhatISaidTranscriptCollectionResult {
  const ticket = beginWhatISaidCollection(input);
  if (!ticket) return collectWhatISaidTranscriptsInner(input);
  // A throw leaves the attempt unknown. Publish only after all final cursor CAS operations.
  const scope = whatISaidCollectionScope(input);
  const result = collectWhatISaidTranscriptsInner(input);
  finishWhatISaidCollection({ ...input, ticket, scope, result: {
    complete: result.enabled && result.worktreeRoots > 0 && result.scanAdvanced && result.unreadable === 0
      && result.withheld === 0 && !result.hasMore && !result.budgetExhausted && result.pendingFiles === 0
      && !result.snapshotChanged && !result.minimumBudgetInsufficient && !result.verificationUncertain,
    unreadable: result.unreadable, withheld: result.withheld, scannedFrom: result.scannedFrom, scannedThrough: result.scannedThrough,
  } });
  return result;
}

/** Content-free binding to exact project/worktree and registered provider source roots. */
export function whatISaidCollectionScope(input: Pick<WhatISaidTranscriptCollectorInput,
  'projectRoot' | 'worktreeRoots' | 'gitWorktreeList' | 'gitTopLevel' | 'claudeProjectsDir' | 'codexSessionsDir' | 'additionalClaudeProjectsDirs' | 'additionalCodexSessionsDirs'>): string {
  const paths = (values: readonly string[]) => [...new Set(values.map(value => canonicalDirectory(value) ?? resolve(value)))].sort();
  return createHash('sha256').update(JSON.stringify({
    roots: exactWhatISaidWorktreeRoots(input).sort(),
    claude: paths([input.claudeProjectsDir ?? join(homedir(), '.claude', 'projects'), ...(input.additionalClaudeProjectsDirs ?? [])]),
    codex: paths([input.codexSessionsDir ?? join(homedir(), '.codex', 'sessions'), ...(input.additionalCodexSessionsDirs ?? [])]),
  })).digest('hex');
}

function collectWhatISaidTranscriptsInner(
  input: WhatISaidTranscriptCollectorInput,
): WhatISaidTranscriptCollectionResult {
  const requestedScanThrough = input.now ?? new Date().toISOString();
  const status = readWhatISaidStatus({
    appDataDir: input.appDataDir,
    projectRoot: input.projectRoot,
    memoryId: input.memoryId,
    now: requestedScanThrough,
  });
  // readWhatISaidStatus validates the timestamp through the store's fixed,
  // prompt-free public error before this canonicalization can throw.
  const scannedThrough = new Date(Date.parse(requestedScanThrough)).toISOString();
  const result = emptyResult(status.enabled, status.enabledAt);
  if (!status.enabled || !status.enabledAt) return result;

  const lastScanAt = status.lastScanAt ?? status.enabledAt;
  const scannedFrom = input.backfill === true
    ? new Date(0).toISOString()
    : new Date(Math.max(
        Date.parse(status.enabledAt),
        Date.parse(lastScanAt) - 5 * 60 * 1000,
      )).toISOString();
  result.scannedFrom = scannedFrom;
  result.scannedThrough = scannedThrough;
  const requestedBudget = input.scanByteBudget ?? DEFAULT_SCAN_BYTE_BUDGET;
  if (!Number.isSafeInteger(requestedBudget) || requestedBudget < 1 || requestedBudget > 64 * 1024 * 1024) {
    throw new Error("What-I-said scan byte budget is invalid.");
  }
  const budget: ScanBudget = { remaining: requestedBudget };

  const roots = exactWhatISaidWorktreeRoots(input);
  result.worktreeRoots = roots.length;
  if (!roots.length) return result;
  if (scanStopped(input)) {
    result.budgetExhausted = true;
    result.hasMore = true;
    result.pendingFiles += 1;
    return result;
  }

  const claudeProjectsDir = input.claudeProjectsDir ?? join(homedir(), ".claude", "projects");
  const exactClaudeSlugs = new Set(roots.flatMap(claudeProjectSlugCandidates));
  if((input.additionalClaudeProjectsDirs?.length??0)>24||(input.additionalCodexSessionsDirs?.length??0)>24)throw new Error('Too many account transcript roots.');
  const claudeBases = [...new Set([claudeProjectsDir,...(input.additionalClaudeProjectsDirs??[])].map(canonicalDirectory).filter((v):v is string=>!!v))];
  let backfillClaudeDiscovery: WhatISaidTranscriptCursor | null = null;
  let backfillClaudeIdentity: string | null = null;
  let backfillClaudeFingerprint: string | null = null;
  let backfillClaudeSnapshot: string | null = null;
  const claudeCandidateFiles = () => [...new Set(claudeBases.flatMap(base => [...exactClaudeSlugs].sort()
    .flatMap(slug => regularJsonlFiles(join(base, slug), false))))];
  if (input.backfill === true) {
    // Rotate independently of the ordinary collector. Saving only keyed source
    // IDs prevents an early collection of files from starving later files when
    // every explicit request hits a time or byte budget.
    const candidates = claudeCandidateFiles().flatMap(file => {
      try {
        const canonicalFile = realpathSync(file);
        return [{ file, sourceId: deriveWhatISaidTranscriptSourceId({ ...input, agent: 'claude', sourceIdentity: canonicalFile }) }];
      } catch {
        result.unreadable += 1;
        return [];
      }
    }).sort((left, right) => left.sourceId.localeCompare(right.sourceId));
    const discoveryIdentity = 'what-i-said-backfill-claude-discovery-v1';
    let discovery = readWhatISaidTranscriptCursor({ ...input, agent: 'claude', sourceIdentity: discoveryIdentity });
    // File content can change continuously while a scan is in progress. Only
    // membership and retention define a cycle; per-file cursors verify each
    // snapshot independently when it is visited.
    const fingerprint = createHash('sha256').update(JSON.stringify([status.retention, candidates.map(candidate => candidate.sourceId)])).digest('hex');
    let currentSnapshot: string;
    try { currentSnapshot = discoverySnapshot(candidates); } catch { result.unreadable += 1; result.hasMore = true; return result; }
    let parts = discoveryParts(discovery?.fileIdentity);
    if (discovery && (!parts || parts.membership !== fingerprint)) {
      const previousAfter = parts?.after ?? discovery.fileIdentity.split(':').at(-1) ?? '';
      const reset = commitWhatISaidTranscriptCursor({
        ...input, agent: 'claude', sourceIdentity: discoveryIdentity, expected: discovery,
        next: { generation: discovery.generation + 1, fileIdentity: `${fingerprint}:${currentSnapshot}:${previousAfter}`, byteOffset: 0, lineNumber: 0, anchor: Buffer.alloc(0) },
        now: scannedThrough,
      });
      if (!reset.committed) {
        result.hasMore = true;
        result.pendingFiles += 1;
        return result;
      }
      discovery = reset.cursor;
      parts = discoveryParts(discovery.fileIdentity);
    }
    let cycleSnapshot = parts?.snapshot ?? currentSnapshot;
    let visited = discovery?.lineNumber ?? 0;
    const after = parts?.after;
    const nextIndex = after ? candidates.findIndex(candidate => candidate.sourceId > after) : 0;
    const start = nextIndex < 0 ? 0 : nextIndex;
    for (let offset = 0; offset < candidates.length && visited < candidates.length; offset++) {
      if (budget.remaining <= 0 || scanStopped(input)) {
        result.budgetExhausted = true;
        result.hasMore = true;
        result.pendingFiles += 1;
        break;
      }
      const candidate = candidates[(start + offset) % candidates.length]!;
      result.claudeFiles += 1;
      const pendingBefore = result.pendingFiles;
      const unreadableBefore = result.unreadable;
      // Like Codex: a record or anchor that cannot fit even a full budget is
      // reported as too small instead of an endless "continue".
      const candidateStartingBudget = budget.remaining;
      collectFileIncrementally({
        ...input, now: scannedThrough, sourceAgent: 'claude', file: candidate.file, scannedFrom,
        captureSince: new Date(0).toISOString(), backfillRetention: status.retention,
        candidateStartingBudget, exactRoots: roots, budget, result,
      });
      const complete = result.pendingFiles === pendingBefore && result.unreadable === unreadableBefore;
      if (!complete && offset > 0) break;
      visited = complete ? visited + 1 : 0;
      if (!complete) cycleSnapshot = currentSnapshot;
      const advanced = commitWhatISaidTranscriptCursor({
        ...input, agent: 'claude', sourceIdentity: discoveryIdentity, expected: discovery,
        next: { generation: (discovery?.generation ?? 0) + (discovery && !complete ? 1 : 0),
          fileIdentity: `${fingerprint}:${cycleSnapshot}:${candidate.sourceId}`, byteOffset: 0, lineNumber: visited, anchor: Buffer.alloc(0) },
        now: scannedThrough,
      });
      if (!advanced.committed) {
        result.hasMore = true;
        result.pendingFiles += 1;
        break;
      }
      discovery = advanced.cursor;
    }
    backfillClaudeDiscovery = discovery;
    backfillClaudeIdentity = discoveryIdentity;
    backfillClaudeFingerprint = fingerprint;
    backfillClaudeSnapshot = cycleSnapshot;
  } else for(const claudeBase of claudeBases) {
    for (const slug of [...exactClaudeSlugs].sort()) {
      const transcriptDir = join(claudeBase, slug);
      for (const file of regularJsonlFiles(transcriptDir, false)) {
        if (budget.remaining <= 0 || scanStopped(input)) {
          result.budgetExhausted = true;
          result.hasMore = true;
          result.pendingFiles += 1;
          break;
        }
        result.claudeFiles += 1;
        collectFileIncrementally({
          ...input,
          now: scannedThrough,
          sourceAgent: "claude",
          file,
          scannedFrom,
          captureSince: status.enabledAt,
          backfillRetention: status.retention,
          exactRoots: roots,
          budget,
          result,
        });
      }
      if (budget.remaining <= 0 || scanStopped(input)) break;
    }
  }
  if (scanStopped(input)) {
    result.budgetExhausted = true;
    result.hasMore = true;
    result.pendingFiles += 1;
    return result;
  }
  const codexSessionsDir = input.codexSessionsDir ?? join(homedir(), ".codex", "sessions");
  const codexCandidateFiles = () => [...new Set([codexSessionsDir,...(input.additionalCodexSessionsDirs??[])].flatMap(root=>regularJsonlFiles(root,true)))];
  const codexCandidates = codexCandidateFiles().flatMap(file => {
    try {
      const canonicalFile = realpathSync(file);
      return [{
        file,
        sourceId: deriveWhatISaidTranscriptSourceId({
          ...input,
          agent: "codex",
          sourceIdentity: canonicalFile,
        }),
      }];
    } catch {
      result.unreadable += 1;
      return [];
    }
  }).sort((left, right) => left.sourceId.localeCompare(right.sourceId));
  let discoveryCursor = readWhatISaidDiscoveryCursor({ ...input, scope: "codex" });
  let backfillCodexDiscovery: WhatISaidTranscriptCursor | null = null;
  const backfillCodexIdentity = 'what-i-said-backfill-codex-discovery-v1';
  let backfillCodexFingerprint: string | null = null;
  let backfillCodexSnapshot: string | null = null;
  let codexCurrentSnapshot: string | null = null;
  let codexVisited = 0;
  const codexSnapshotIdentity = 'what-i-said-backfill-codex-snapshot-v1';
  let snapshotCursor: WhatISaidTranscriptCursor | null = null;
  let snapshotState: ReturnType<typeof codexSnapshotParts> = null;
  const saveSnapshotState = (phase: CodexSnapshotPhase, baseline: string, running: string, count: number, restart = false, meta = EMPTY_SNAPSHOT_HASH) => {
    const previous = snapshotCursor;
    const nextGeneration = previous && count < previous.lineNumber ? previous.generation + 1 : (previous?.generation ?? 0);
    const updated = commitWhatISaidTranscriptCursor({
      ...input, agent: 'codex', sourceIdentity: codexSnapshotIdentity, expected: previous,
      next: { generation: nextGeneration, fileIdentity: `${restart ? backfillCodexFingerprint : (snapshotState?.membership ?? backfillCodexFingerprint)}:${phase}:${restart ? codexCandidates.length : (snapshotState?.target ?? codexCandidates.length)}:${baseline}:${running}:${meta}`,
        byteOffset: 0, lineNumber: count, anchor: Buffer.alloc(0) }, now: scannedThrough,
    });
    if (!updated.committed) throw new Error('Snapshot cursor changed concurrently');
    snapshotCursor = updated.cursor;
    snapshotState = codexSnapshotParts(snapshotCursor.fileIdentity);
  };
  const runSnapshotPage = () => {
    if (!snapshotState || !snapshotCursor || (snapshotState.phase !== 'b' && snapshotState.phase !== 'v')) return true;
    const phase = snapshotState.phase;
    let running = snapshotState.running;
    let meta = snapshotState.meta;
    const baseline = snapshotState.baseline;
    const target = Math.min(snapshotState.target, codexCandidates.length);
    for (let index = snapshotCursor.lineNumber; index < target; index++) {
      // A page that runs out keeps its saved position. The next pass of the
      // same request resumes it with a full budget; a new request resumes a
      // verification only if the checked files are unchanged (see below).
      if (budget.remaining <= 0 || scanStopped(input)) {
        result.budgetExhausted = true; result.hasMore = true; result.pendingFiles += 1; return false;
      }
      const startingBudget = budget.remaining;
      try {
        const snapshot = codexCandidateSnapshot(codexCandidates[index]!, roots, budget, result, () => scanStopped(input));
        running = snapshotChain(running, snapshot.evidence);
        meta = snapshotChain(meta, snapshot.metadata);
      }
      catch (error) {
        if (error instanceof SnapshotBudgetExhausted) {
          result.budgetExhausted = true;
          if (budget.remaining === 0 && startingBudget === requestedBudget) result.minimumBudgetInsufficient = true;
        }
        else result.unreadable += 1;
        result.hasMore = true; result.pendingFiles += 1; return false;
      }
      saveSnapshotState(phase, baseline, running, index + 1, false, meta);
    }
    if (phase === 'b') saveSnapshotState('r', running, EMPTY_SNAPSHOT_HASH, 0);
    else if (running === baseline) saveSnapshotState('d', baseline, EMPTY_SNAPSHOT_HASH, 0, false, meta);
    else {
      saveSnapshotState('b', EMPTY_SNAPSHOT_HASH, EMPTY_SNAPSHOT_HASH, 0, true);
      result.snapshotChanged = true; result.hasMore = true; result.pendingFiles += 1; return false;
    }
    return true;
  };
  if (input.backfill === true) {
    backfillCodexFingerprint = createHash('sha256').update(JSON.stringify([status.retention, codexCandidates.map(candidate => candidate.sourceId)])).digest('hex');
    snapshotCursor = readWhatISaidTranscriptCursor({ ...input, agent: 'codex', sourceIdentity: codexSnapshotIdentity });
    snapshotState = codexSnapshotParts(snapshotCursor?.fileIdentity);
    if (!snapshotState || (snapshotState.membership !== backfillCodexFingerprint && snapshotState.phase === 'b' && snapshotCursor?.lineNumber === 0)) {
      saveSnapshotState('b', EMPTY_SNAPSHOT_HASH, EMPTY_SNAPSHOT_HASH, 0, true);
    } else if (snapshotState.membership !== backfillCodexFingerprint && (snapshotState.phase === 'v' || snapshotState.phase === 'd')) {
      saveSnapshotState('b', EMPTY_SNAPSHOT_HASH, EMPTY_SNAPSHOT_HASH, 0, true);
      result.snapshotChanged = true; result.hasMore = true; result.pendingFiles += 1; return result;
    } else if (input.backfillContinuation !== true
      && (snapshotState.phase === 'd' || (snapshotState.phase === 'v' && (snapshotCursor?.lineNumber ?? 0) > 0))) {
      // Files checked by an earlier request may have changed while it was
      // suspended, and a finished check may predate the other source. Resume
      // only when none of them was written since (lstat only, no budget);
      // otherwise re-verify every file against the same baseline from the
      // first one, now and with this pass's full budget. Reading is already
      // done, so the baseline is kept: restarting it made each request repeat
      // the whole cycle and never reach completion.
      const checked = snapshotState.phase === 'd' ? Math.min(snapshotState.target, codexCandidates.length) : snapshotCursor!.lineNumber;
      if (codexPrefixMetadata(codexCandidates, checked) !== snapshotState.meta) {
        saveSnapshotState('v', snapshotState.baseline, EMPTY_SNAPSHOT_HASH, 0);
      }
    }
    if (!runSnapshotPage()) return result;
    codexCurrentSnapshot = snapshotState?.baseline ?? null;
    backfillCodexDiscovery = readWhatISaidTranscriptCursor({ ...input, agent: 'codex', sourceIdentity: backfillCodexIdentity });
    let parts = discoveryParts(backfillCodexDiscovery?.fileIdentity);
    if (backfillCodexDiscovery && (!parts || parts.membership !== backfillCodexFingerprint || parts.snapshot !== codexCurrentSnapshot)) {
      const previousAfter = parts?.after ?? backfillCodexDiscovery.fileIdentity.split(':').at(-1) ?? '';
      const reset = commitWhatISaidTranscriptCursor({
        ...input, agent: 'codex', sourceIdentity: backfillCodexIdentity, expected: backfillCodexDiscovery,
        next: { generation: backfillCodexDiscovery.generation + 1, fileIdentity: `${backfillCodexFingerprint}:${codexCurrentSnapshot}:${previousAfter}`, byteOffset: 0, lineNumber: 0, anchor: Buffer.alloc(0) }, now: scannedThrough,
      });
      if (!reset.committed) { result.hasMore = true; result.pendingFiles += 1; return result; }
      backfillCodexDiscovery = reset.cursor;
      parts = discoveryParts(backfillCodexDiscovery.fileIdentity);
    }
    backfillCodexSnapshot = parts?.snapshot ?? codexCurrentSnapshot;
    codexVisited = backfillCodexDiscovery?.lineNumber ?? 0;
  }
  const resumeAfter = input.backfill === true
    ? discoveryParts(backfillCodexDiscovery?.fileIdentity)?.after || null
    : discoveryCursor;
  const startIndex = resumeAfter === null
    ? 0
    : Math.max(0, codexCandidates.findIndex(candidate => candidate.sourceId > resumeAfter));
  // Bound both cached classifications and pending writes. Committing every
  // file made even a warm scan perform thousands of synchronous SQLite writes;
  // one unbounded final batch also exceeded the store's 10,000-item guard.
  for (let offset = 0; offset < codexCandidates.length && (input.backfill !== true || codexVisited < codexCandidates.length); offset += DISCOVERY_BATCH_SIZE) {
    if (budget.remaining <= 0 || scanStopped(input)) {
      result.budgetExhausted = true;
      result.hasMore = true;
      result.pendingFiles += 1;
      break;
    }
    const batch = Array.from(
      { length: Math.min(DISCOVERY_BATCH_SIZE, codexCandidates.length - offset) },
      (_, index) => codexCandidates[(startIndex + offset + index) % codexCandidates.length]!,
    );
    const classifications = readWhatISaidTranscriptClassifications({
      ...input, sourceIds: batch.map(candidate => candidate.sourceId),
    });
    const newClassifications: Array<{
      sourceId: string;
      fileIdentity: string;
      classifiedSize: number;
      owned: boolean;
    }> = [];
    let lastProcessedSourceId: string | null = null;
    for (const [batchIndex, candidate] of batch.entries()) {
      if (input.backfill === true && codexVisited >= codexCandidates.length) break;
      // Do not start a new candidate with only the residue of a previous one:
      // a classification-only attempt would rotate past it forever on small
      // budgets without leaving enough space to read any of its records.
      if (budget.remaining <= 0 || (input.backfill === true && budget.remaining < Math.min(1024, requestedBudget)) || scanStopped(input)) {
        result.budgetExhausted = true;
        result.hasMore = true;
        result.pendingFiles += 1;
        break;
      }
      const { file, sourceId } = candidate;
      const candidateStartingBudget = budget.remaining;
      const pendingBefore = result.pendingFiles;
      const unreadableBefore = result.unreadable;
      let owned = false;
      let modifiedWithinScanWindow = false;
      let codexHeaderEvidence: { bytes: Buffer; fileIdentity: string; size: number; mtimeMs: number } | undefined;
      try {
        const snapshot = transcriptFileSnapshot(file);
        modifiedWithinScanWindow = snapshot.mtimeMs >= Date.parse(scannedFrom);
        const cached = classifications[sourceId];
        const cacheValid = cached
          && cached.fileIdentity === snapshot.fileIdentity
          && snapshot.size >= cached.classifiedSize
          // A same-inode truncate+regrow can preserve both fileIdentity and size
          // while replacing session_meta.cwd. Fresh files must re-prove ownership
          // from their first complete header in both directions (owned/foreign).
          && !modifiedWithinScanWindow;
        if (cacheValid) {
          owned = cached.owned;
        } else {
          const header = firstLineWithinBudget(file, budget, result);
          if (header === null) {
            if (budget.remaining <= 0) {
              if (input.backfill === true && candidateStartingBudget === requestedBudget) result.minimumBudgetInsufficient = true;
              result.budgetExhausted = true;
              result.hasMore = true;
              result.pendingFiles += 1;
            } else {
              result.unreadable += 1;
            }
          } else {
            const cwd = codexRolloutCwd(header);
            owned = !!cwd && cwdBelongsToExactRoot(cwd, roots);
            codexHeaderEvidence = { bytes: Buffer.from(`${header}\n`, 'utf8'), fileIdentity: snapshot.fileIdentity,
              size: snapshot.size, mtimeMs: snapshot.mtimeMs };
            const classification = {
              sourceId,
              fileIdentity: snapshot.fileIdentity,
              classifiedSize: snapshot.size,
              owned,
            };
            classifications[sourceId] = classification;
            newClassifications.push(classification);
          }
        }
      } catch {
        result.unreadable += 1;
      }
      if (owned && modifiedWithinScanWindow) {
        result.codexFiles += 1;
        collectFileIncrementally({
          ...input,
          now: scannedThrough,
          sourceAgent: "codex",
          file,
          scannedFrom,
          captureSince: input.backfill === true ? new Date(0).toISOString() : status.enabledAt,
          backfillRetention: status.retention,
          codexHeaderEvidence,
          candidateStartingBudget,
          exactRoots: roots,
          budget,
          result,
        });
      }
      lastProcessedSourceId = sourceId;
      if (input.backfill === true && backfillCodexFingerprint) {
        const complete = result.pendingFiles === pendingBefore && result.unreadable === unreadableBefore;
        if (!complete && offset + batchIndex > 0) break;
        codexVisited = complete ? codexVisited + 1 : 0;
        if (!complete) backfillCodexSnapshot = codexCurrentSnapshot;
        if (newClassifications.length) {
          commitWhatISaidTranscriptClassifications({ ...input, items: newClassifications, now: scannedThrough });
          newClassifications.length = 0;
        }
        const advanced = commitWhatISaidTranscriptCursor({
          ...input, agent: 'codex', sourceIdentity: backfillCodexIdentity, expected: backfillCodexDiscovery,
          next: { generation: (backfillCodexDiscovery?.generation ?? 0) + (backfillCodexDiscovery && !complete ? 1 : 0),
            fileIdentity: `${backfillCodexFingerprint}:${backfillCodexSnapshot}:${sourceId}`, byteOffset: 0, lineNumber: codexVisited, anchor: Buffer.alloc(0) }, now: scannedThrough,
        });
        if (!advanced.committed) { result.hasMore = true; result.pendingFiles += 1; break; }
        backfillCodexDiscovery = advanced.cursor;
      }
    }
    // Persist classifications before advancing discovery. A crash in between
    // safely replays this batch; transcript receipts already make it idempotent.
    commitWhatISaidTranscriptClassifications({
      ...input,
      items: newClassifications,
      now: scannedThrough,
    });
    if (lastProcessedSourceId === null) break;
    if (input.backfill === true) {
      if (result.pendingFiles > 0) break;
      continue;
    }
    const advancedDiscovery = commitWhatISaidDiscoveryCursor({
      ...input,
      scope: "codex",
      expected: discoveryCursor,
      next: lastProcessedSourceId,
      now: scannedThrough,
    });
    if (!advancedDiscovery.committed) {
      result.hasMore = true;
      result.pendingFiles += 1;
      break;
    }
    discoveryCursor = advancedDiscovery.cursor;
  }

  // A partial scan must replay from the previous checkpoint. Source-event HMAC
  // receipts make that overlap idempotent without risking a skipped prompt.
  if (scanStopped(input) && !result.hasMore) {
    result.budgetExhausted = true;
    result.hasMore = true;
    result.pendingFiles += 1;
  }
  if (input.backfill === true && result.unreadable === 0 && result.pendingFiles === 0 && !result.budgetExhausted) {
    // Before reporting completion, compare the discovered membership and
    // file metadata with the start of each completed cycle. A concurrent
    // append to an already visited file restarts that cycle fairly, without
    // resetting it on every pass while it is still in progress.
    const verifyCycle = (agent: 'claude' | 'codex', files: string[], expected: WhatISaidTranscriptCursor | null,
      identity: string, membership: string | null, snapshot: string | null) => {
      const candidates = files.map(file => ({ file, sourceId: deriveWhatISaidTranscriptSourceId({
        ...input, agent, sourceIdentity: realpathSync(file),
      }) })).sort((left, right) => left.sourceId.localeCompare(right.sourceId));
      const currentMembership = createHash('sha256').update(JSON.stringify([status.retention, candidates.map(candidate => candidate.sourceId)])).digest('hex');
      const currentSnapshot = discoverySnapshot(candidates);
      if (currentMembership === membership && currentSnapshot === snapshot) return false;
      const after = discoveryParts(expected?.fileIdentity)?.after ?? '';
      const reset = commitWhatISaidTranscriptCursor({
        ...input, agent, sourceIdentity: identity, expected,
        next: { generation: expected ? expected.generation + 1 : 0,
          fileIdentity: `${currentMembership}:${currentSnapshot}:${after}`, byteOffset: 0, lineNumber: 0, anchor: Buffer.alloc(0) },
        now: scannedThrough,
      });
      if (!reset.committed) throw new Error('Discovery cursor changed concurrently');
      return true;
    };
    try {
      const claudeChanged = verifyCycle('claude', claudeCandidateFiles(), backfillClaudeDiscovery,
        'what-i-said-backfill-claude-discovery-v1', backfillClaudeFingerprint, backfillClaudeSnapshot);
      if (claudeChanged) {
        result.snapshotChanged = true;
        result.hasMore = true;
        result.pendingFiles += 1;
      }
    } catch (error) {
      if (error instanceof SnapshotBudgetExhausted) result.budgetExhausted = true;
      else result.unreadable += 1;
      result.hasMore = true;
      result.pendingFiles += 1;
    }
  }
  if (input.backfill === true && result.unreadable === 0 && result.pendingFiles === 0 && !result.budgetExhausted) {
    try {
      const freshMembership = createHash('sha256').update(JSON.stringify([status.retention,
        codexCandidateFiles().map(file => deriveWhatISaidTranscriptSourceId({ ...input, agent: 'codex', sourceIdentity: realpathSync(file) })).sort()])).digest('hex');
      if (freshMembership !== backfillCodexFingerprint || snapshotState?.membership !== freshMembership) {
        saveSnapshotState('b', EMPTY_SNAPSHOT_HASH, EMPTY_SNAPSHOT_HASH, 0, true);
        result.snapshotChanged = true; result.hasMore = true; result.pendingFiles += 1;
      } else {
        if (snapshotState?.phase === 'r') saveSnapshotState('v', snapshotState.baseline, EMPTY_SNAPSHOT_HASH, 0);
        runSnapshotPage();
      }
    } catch {
      result.unreadable += 1; result.hasMore = true; result.pendingFiles += 1;
    }
  }
  if (result.unreadable === 0 && result.pendingFiles === 0 && !result.budgetExhausted) {
    const advanced = advanceWhatISaidScan({
      appDataDir: input.appDataDir,
      projectRoot: input.projectRoot,
      memoryId: input.memoryId,
      scannedThrough,
    });
    result.scanAdvanced = advanced.lastScanAt === scannedThrough;
    if (result.scanAdvanced && backfillClaudeDiscovery && backfillClaudeIdentity && backfillClaudeFingerprint) {
      const reset = commitWhatISaidTranscriptCursor({
        ...input, agent: 'claude', sourceIdentity: backfillClaudeIdentity, expected: backfillClaudeDiscovery,
        next: { generation: backfillClaudeDiscovery.generation + 1,
          fileIdentity: `${backfillClaudeFingerprint}:${backfillClaudeSnapshot}:`, byteOffset: 0, lineNumber: 0, anchor: Buffer.alloc(0) },
        now: scannedThrough,
      });
      if (!reset.committed) {
        result.scanAdvanced = false;
        result.hasMore = true;
        result.pendingFiles += 1;
      }
    }
    if (result.scanAdvanced && backfillCodexDiscovery && backfillCodexFingerprint) {
      const reset = commitWhatISaidTranscriptCursor({
        ...input, agent: 'codex', sourceIdentity: backfillCodexIdentity, expected: backfillCodexDiscovery,
        next: { generation: backfillCodexDiscovery.generation + 1, fileIdentity: `${backfillCodexFingerprint}:${backfillCodexSnapshot}:`, byteOffset: 0, lineNumber: 0, anchor: Buffer.alloc(0) }, now: scannedThrough,
      });
      if (!reset.committed) { result.scanAdvanced = false; result.hasMore = true; result.pendingFiles += 1; }
    }
    if (result.scanAdvanced && snapshotState && snapshotCursor) {
      saveSnapshotState('b', EMPTY_SNAPSHOT_HASH, EMPTY_SNAPSHOT_HASH, 0, true);
    }
  }

  return result;
}
