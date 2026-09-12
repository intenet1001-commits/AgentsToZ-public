import { spawnSync } from "node:child_process";
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
} from "./sessionTranscript";
import {
  advanceWhatISaidScan,
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

/**
 * Transcript discovery for opted-in What-I-said projects.
 *
 * Ownership comes only from the exact roots reported by `git worktree list`.
 * Directory-name prefix guessing is intentionally absent: it can sweep a
 * sibling repository into this high-sensitivity store.
 */

export interface WhatISaidTranscriptCollectorInput extends WhatISaidCryptoLocation {
  now?: string;
  /** Test seams. Production callers leave these unset. */
  claudeProjectsDir?: string;
  codexSessionsDir?: string;
  worktreeRoots?: readonly string[];
  gitWorktreeList?: (projectRoot: string) => string;
  gitTopLevel?: (projectRoot: string) => string | null;
  scanByteBudget?: number;
  /**
   * Explicit user-initiated backfill: scan from the beginning of the available
   * transcripts instead of from the consent instant, and let the store keep
   * entries recorded before capture was enabled. Automatic capture never sets
   * this — turning the policy on must not silently ingest past conversations.
   */
  backfill?: boolean;
  /**
   * 이 프롬프트를 수집한 기기. 행에 함께 박아 두면 나중에 아카이브·복원·원격
   * 적재로 여러 기기의 기록이 합쳐져도 출처를 되찾을 수 있다.
   */
  deviceId?: string | null;
  deviceName?: string | null;
  /** Content-free clipboard evidence supplied by the local sidecar. */
  promptOrigin?: (text: string, recordedAt: string) => WhatISaidPromptOrigin;
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
      const bytes = readWithinBudget(handle, offset, Math.min(4096, maxBytes - offset), budget, result);
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
    return typeof record.timestamp !== "string"
      || !Number.isFinite(Date.parse(record.timestamp))
      || typeof message?.content !== "string"
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
}): boolean {
  let record: unknown;
  try {
    record = JSON.parse(input.line);
  } catch {
    return receiptMalformedUserLine(input);
  }
  if (!isJsonRecord(record)) return receiptMalformedUserLine(input);

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
    excerpts = owned.excerpts;
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
        promptOrigin: input.promptOrigin?.(excerpt.text, excerpt.recordedAt) ?? "unknown",
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
    // Transcripts are append-only. Once the filesystem says the whole file
    // predates the overlap baseline, reading hundreds of MB cannot discover a
    // candidate event and only turns every capture into an O(history) sweep.
    if (input.backfill !== true && info.mtimeMs < Date.parse(input.scannedFrom)) return;
    const snapshotSize = info.size;
    const fileIdentity = `${String(info.dev)}:${String(info.ino)}:${Math.trunc(info.birthtimeMs)}`;
    const cursorSourceIdentity = canonicalFile;
    const sourceId = deriveWhatISaidTranscriptSourceId({
      ...input,
      agent: input.sourceAgent,
      sourceIdentity: cursorSourceIdentity,
    });
    // A backfill must re-read from byte 0. Lowering the timestamp floor alone
    // does nothing once the durable cursor already sits at EOF — the file is
    // simply skipped and the button appears to do nothing. Re-reading is safe:
    // storage is keyed by a stable per-line event id, so everything already
    // captured comes back as a duplicate rather than a second copy.
    let expected = input.backfill === true ? null : readWhatISaidTranscriptCursor({
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
      if (input.budget.remaining < expected.anchorLength) {
        markPending(true);
        return;
      }
      anchor = readWithinBudget(
        handle,
        expected.byteOffset - expected.anchorLength,
        expected.anchorLength,
        input.budget,
        input.result,
      );
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

    let readPosition = byteOffset;
    let pending = Buffer.alloc(0);
    let blocked = false;
    while (readPosition < snapshotSize && !blocked) {
      if (input.budget.remaining <= 0) {
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
        const newline = pending.indexOf(0x0a);
        if (newline === -1) {
          if (pending.byteLength <= MAX_JSONL_RECORD_BYTES) break;
          const nextLineNumber = lineNumber + 1;
          const eventSourceIdentity = generation === 0
            ? `${input.sourceAgent}:${canonicalFile}`
            : `what-i-said-transcript:${sourceId}:g${generation}`;
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
          const nextLineNumber = lineNumber + 1;
          const eventSourceIdentity = generation === 0
            ? `${input.sourceAgent}:${canonicalFile}`
            : `what-i-said-transcript:${sourceId}:g${generation}`;
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
        const eventSourceIdentity = generation === 0
          ? `${input.sourceAgent}:${canonicalFile}`
          : `what-i-said-transcript:${sourceId}:g${generation}`;
        if (lineBytes.byteLength > 0 && !storeUserLine({
          ...input,
          line: lineBytes.toString("utf8"),
          recordBytes: rawRecord.byteLength,
          lineNumber: nextLineNumber,
          eventSourceIdentity,
          replaySourceIdentity: sourceId,
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
          sourceIdentity: cursorSourceIdentity,
          expected,
          next: { generation, fileIdentity, byteOffset, lineNumber, anchor, discardUntilNewline },
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

  const claudeProjectsDir = input.claudeProjectsDir ?? join(homedir(), ".claude", "projects");
  const exactClaudeSlugs = new Set(roots.flatMap(claudeProjectSlugCandidates));
  const claudeBase = canonicalDirectory(claudeProjectsDir);
  if (claudeBase) {
    for (const slug of [...exactClaudeSlugs].sort()) {
      const transcriptDir = join(claudeBase, slug);
      for (const file of regularJsonlFiles(transcriptDir, false)) {
        if (budget.remaining <= 0) {
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
          captureSince: input.backfill === true ? new Date(0).toISOString() : status.enabledAt,
          exactRoots: roots,
          budget,
          result,
        });
      }
      if (budget.remaining <= 0) break;
    }
  }

  const codexSessionsDir = input.codexSessionsDir ?? join(homedir(), ".codex", "sessions");
  const codexCandidates = regularJsonlFiles(codexSessionsDir, true).flatMap(file => {
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
  const startIndex = discoveryCursor === null
    ? 0
    : Math.max(0, codexCandidates.findIndex(candidate => candidate.sourceId > discoveryCursor!));
  // Bound both cached classifications and pending writes. Committing every
  // file made even a warm scan perform thousands of synchronous SQLite writes;
  // one unbounded final batch also exceeded the store's 10,000-item guard.
  for (let offset = 0; offset < codexCandidates.length; offset += DISCOVERY_BATCH_SIZE) {
    if (budget.remaining <= 0) {
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
    for (const candidate of batch) {
      if (budget.remaining <= 0) {
        result.budgetExhausted = true;
        result.hasMore = true;
        result.pendingFiles += 1;
        break;
      }
      const { file, sourceId } = candidate;
      let owned = false;
      let modifiedWithinScanWindow = false;
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
              result.budgetExhausted = true;
              result.hasMore = true;
              result.pendingFiles += 1;
            } else {
              result.unreadable += 1;
            }
          } else {
            const cwd = codexRolloutCwd(header);
            owned = !!cwd && cwdBelongsToExactRoot(cwd, roots);
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
          exactRoots: roots,
          budget,
          result,
        });
      }
      lastProcessedSourceId = sourceId;
    }
    // Persist classifications before advancing discovery. A crash in between
    // safely replays this batch; transcript receipts already make it idempotent.
    commitWhatISaidTranscriptClassifications({
      ...input,
      items: newClassifications,
      now: scannedThrough,
    });
    if (lastProcessedSourceId === null) break;
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
  if (result.unreadable === 0 && result.pendingFiles === 0 && !result.budgetExhausted) {
    const advanced = advanceWhatISaidScan({
      appDataDir: input.appDataDir,
      projectRoot: input.projectRoot,
      memoryId: input.memoryId,
      scannedThrough,
    });
    result.scanAdvanced = advanced.lastScanAt === scannedThrough;
  }

  return result;
}
