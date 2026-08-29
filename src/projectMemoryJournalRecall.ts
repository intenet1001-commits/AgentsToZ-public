import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  unlinkSync,
} from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";

/**
 * This module indexes entries only after the journal's authoritative parser has
 * validated them. The SQLite file is a disposable local acceleration layer: it
 * never replaces, rewrites, or uploads the append-only journal.
 */

export type ProjectMemoryJournalAgent = "claude" | "codex" | null;

export interface ProjectMemoryJournalRecallEntry {
  entryHash: string;
  recordedAt: string;
  agent: ProjectMemoryJournalAgent;
  headCommit: string | null;
  summary: string;
  body: string;
  /** Old v1 entries without a verifiable payload remain searchable but explicit. */
  integrity?: "verified" | "legacy-unverified";
}

export interface ProjectMemoryJournalRecallHit {
  source: "journal";
  authority: "historical-evidence";
  entryHash: string;
  recordedAt: string;
  agent: ProjectMemoryJournalAgent;
  headCommit: string | null;
  summary: string;
  excerpt: string;
  matchedTerms: string[];
  score: number;
  integrity: "verified" | "legacy-unverified";
  caution: true;
}

export interface ProjectMemoryJournalIndexInput {
  cachePath: string;
  /** Include the canonical project root and memory lineage in this value. */
  identity: string;
  entries: readonly ProjectMemoryJournalRecallEntry[];
}

export interface ProjectMemoryJournalIndexStatus {
  indexedEntries: number;
  addedEntries: number;
  rebuilt: boolean;
  recovered: boolean;
}

export interface ProjectMemoryJournalRecallResult {
  hits: ProjectMemoryJournalRecallHit[];
  mode: "fts" | "scan-fallback" | "empty";
  /** False when a broad FTS query exceeded the bounded candidate window. */
  complete: boolean;
  truncated?: boolean;
  indexedEntries: number;
  indexRebuilt: boolean;
  indexRecovered: boolean;
  indexWarning?: "CACHE_UNAVAILABLE";
}

export const MAX_PROJECT_MEMORY_JOURNAL_RECALL_LIMIT = 8;
export const MAX_PROJECT_MEMORY_JOURNAL_EXCERPT_CHARS = 700;

const INDEX_SCHEMA_VERSION = "2";
const MAX_QUERY_CHARS = 2_000;
const MAX_QUERY_TERMS = 24;
const MAX_QUERY_TERM_CHARS = 128;
const MAX_SUMMARY_CHARS = 300;
const MAX_FTS_CANDIDATES = 192;
const MIN_FTS_CANDIDATES = 48;

const GENERIC_TERMS = new Set([
  "project", "memory", "work", "task", "session", "remember",
  "프로젝트", "기억", "작업", "세션", "내용", "관련", "장기기억",
]);

const TERM_ALIASES: Record<string, string[]> = {
  "충돌": ["conflict"],
  conflict: ["충돌"],
  "동기화": ["sync"],
  sync: ["동기화"],
  "백업": ["backup"],
  backup: ["백업"],
  "복원": ["restore"],
  restore: ["복원"],
  "제약": ["constraint"],
  constraint: ["제약"],
};

function normalize(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/\0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function codePoints(value: string): string[] {
  return Array.from(value);
}

function boundedCodePoints(value: string, limit: number): string {
  const points = codePoints(value);
  return points.length <= limit ? value : points.slice(0, limit).join("");
}

function queryTerms(query: string): string[] {
  const bounded = codePoints(query).slice(0, MAX_QUERY_CHARS).join("");
  const terms = normalize(bounded)
    .split(/[\s,.;:!?()[\]{}"'`/\\|+=*&^%$#@~<>]+/)
    .map(term => boundedCodePoints(term.trim(), MAX_QUERY_TERM_CHARS))
    .filter(term => codePoints(term).length >= 2 && !GENERIC_TERMS.has(term));
  return Array.from(new Set(terms)).slice(0, MAX_QUERY_TERMS);
}

function termVariants(term: string): string[] {
  return Array.from(new Set([term, ...(TERM_ALIASES[term] ?? [])]));
}

function containsTerm(text: string, term: string): boolean {
  return termVariants(term).some(variant => text.includes(variant));
}

function identityHash(identity: string): string {
  if (!identity.trim()) throw new Error("journal recall index identity is required");
  return createHash("sha256").update(identity, "utf8").digest("hex");
}

function isIndexableEntry(entry: ProjectMemoryJournalRecallEntry): boolean {
  return /^[0-9a-f]{8,64}$/.test(entry.entryHash)
    && typeof entry.recordedAt === "string"
    && !Number.isNaN(Date.parse(entry.recordedAt))
    && (entry.agent === null || entry.agent === "claude" || entry.agent === "codex")
    && (entry.headCommit === null || typeof entry.headCommit === "string")
    && typeof entry.summary === "string"
    && typeof entry.body === "string";
}

function uniqueEntries(entries: readonly ProjectMemoryJournalRecallEntry[]): ProjectMemoryJournalRecallEntry[] {
  const unique = new Map<string, ProjectMemoryJournalRecallEntry>();
  for (const entry of entries) {
    if (isIndexableEntry(entry) && !unique.has(entry.entryHash)) unique.set(entry.entryHash, entry);
  }
  return [...unique.values()];
}

function rejectCacheSymlink(cachePath: string): void {
  if (existsSync(cachePath) && lstatSync(cachePath).isSymbolicLink()) {
    throw new Error("journal recall cache must not be a symbolic link");
  }
}

function applyPrivatePermissions(cachePath: string): void {
  if (process.platform === "win32") return;
  chmodSync(cachePath, 0o600);
}

function openIndex(cachePath: string): Database {
  mkdirSync(dirname(cachePath), { recursive: true });
  rejectCacheSymlink(cachePath);
  const db = new Database(cachePath, { create: true });
  try {
    db.exec("PRAGMA journal_mode = DELETE; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 2000;");
    applyPrivatePermissions(cachePath);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function dropIndexTables(db: Database): void {
  db.exec(`
    DROP TABLE IF EXISTS journal_recall_fts;
    DROP TABLE IF EXISTS journal_recall_entries;
    DROP TABLE IF EXISTS journal_recall_meta;
  `);
}

function createIndexTables(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS journal_recall_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS journal_recall_entries (
      rowid INTEGER PRIMARY KEY,
      entry_hash TEXT NOT NULL UNIQUE,
      recorded_at TEXT NOT NULL,
      summary_hash TEXT NOT NULL
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS journal_recall_fts USING fts5(
      summary,
      body,
      content='',
      tokenize='trigram'
    );
  `);
}

function readMeta(db: Database, key: string): string | null {
  const row = db.query("SELECT value FROM journal_recall_meta WHERE key = ?").get(key) as { value?: unknown } | null;
  return typeof row?.value === "string" ? row.value : null;
}

function writeMeta(db: Database, key: string, value: string): void {
  db.query(`
    INSERT INTO journal_recall_meta(key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}

function populateIndex(db: Database, entries: readonly ProjectMemoryJournalRecallEntry[], startingRowId = 1): void {
  const insertEntry = db.query(`
    INSERT INTO journal_recall_entries(rowid, entry_hash, recorded_at, summary_hash)
    VALUES (?, ?, ?, ?)
  `);
  const insertFts = db.query("INSERT INTO journal_recall_fts(rowid, summary, body) VALUES (?, ?, ?)");
  let rowid = startingRowId;
  for (const entry of entries) {
    const normalizedSummary = normalize(entry.summary);
    insertEntry.run(
      rowid,
      entry.entryHash,
      entry.recordedAt,
      createHash("sha256").update(normalizedSummary, "utf8").digest("hex"),
    );
    insertFts.run(rowid, normalizedSummary, normalize(entry.body));
    rowid += 1;
  }
}

function rebuildIndex(
  db: Database,
  identity: string,
  entries: readonly ProjectMemoryJournalRecallEntry[],
): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    dropIndexTables(db);
    createIndexTables(db);
    writeMeta(db, "schemaVersion", INDEX_SCHEMA_VERSION);
    writeMeta(db, "identityHash", identityHash(identity));
    populateIndex(db, entries);
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* The original failure is more useful. */ }
    throw error;
  }
}

function deleteDisposableIndex(cachePath: string): void {
  rejectCacheSymlink(cachePath);
  for (const path of [cachePath, `${cachePath}-wal`, `${cachePath}-shm`]) {
    if (!existsSync(path)) continue;
    const info = lstatSync(path);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error("journal recall cache is not a regular file");
    unlinkSync(path);
  }
}

function isIndexCorruption(error: unknown): boolean {
  const item = error as { message?: unknown; code?: unknown } | null;
  const message = `${typeof item?.code === "string" ? item.code : ""} ${
    typeof item?.message === "string" ? item.message : String(error)
  }`;
  return /SQLITE_(?:CORRUPT|NOTADB)|database disk image is malformed|file is not a database|unsupported file format/i.test(message);
}

function synchronizeIndexOnce(
  input: ProjectMemoryJournalIndexInput,
  recovered: boolean,
  forceRebuild = false,
): ProjectMemoryJournalIndexStatus {
  const entries = uniqueEntries(input.entries);
  const expectedIdentity = identityHash(input.identity);
  const db = openIndex(input.cachePath);
  try {
    createIndexTables(db);
    const schemaMatches = readMeta(db, "schemaVersion") === INDEX_SCHEMA_VERSION;
    const identityMatches = readMeta(db, "identityHash") === expectedIdentity;
    const ftsCount = Number((db.query("SELECT count(*) AS count FROM journal_recall_fts").get() as any)?.count ?? -1);
    const existingRows = db.query("SELECT entry_hash FROM journal_recall_entries ORDER BY rowid").all() as Array<{ entry_hash: string }>;
    const expectedHashes = new Set(entries.map(entry => entry.entryHash));
    const stale = existingRows.some(row => !expectedHashes.has(row.entry_hash));
    const inconsistent = ftsCount !== existingRows.length;
    const rebuild = forceRebuild || !schemaMatches || !identityMatches || stale || inconsistent;

    if (rebuild) {
      rebuildIndex(db, input.identity, entries);
      return {
        indexedEntries: entries.length,
        addedEntries: entries.length,
        rebuilt: true,
        recovered,
      };
    }

    const known = new Set(existingRows.map(row => row.entry_hash));
    const missing = entries.filter(entry => !known.has(entry.entryHash));
    if (missing.length) {
      const maxRow = Number((db.query("SELECT coalesce(max(rowid), 0) AS value FROM journal_recall_entries").get() as any)?.value ?? 0);
      db.exec("BEGIN IMMEDIATE");
      try {
        populateIndex(db, missing, maxRow + 1);
        db.exec("COMMIT");
      } catch (error) {
        try { db.exec("ROLLBACK"); } catch { /* Keep the insertion error. */ }
        throw error;
      }
    }
    return {
      indexedEntries: entries.length,
      addedEntries: missing.length,
      rebuilt: false,
      recovered,
    };
  } finally {
    db.close();
  }
}

export function synchronizeProjectMemoryJournalRecallIndex(
  input: ProjectMemoryJournalIndexInput,
): ProjectMemoryJournalIndexStatus {
  // A caller contract error is not cache corruption and must never trigger
  // deletion of an otherwise healthy derived index.
  identityHash(input.identity);
  try {
    return synchronizeIndexOnce(input, false);
  } catch (firstError) {
    // Busy, permission, and filesystem errors are transient or caller-owned.
    // Deleting on those conditions could unlink a healthy cache used by another
    // local process. Only an explicitly corrupt SQLite file is disposable here.
    if (!isIndexCorruption(firstError)) throw firstError;
    try {
      deleteDisposableIndex(input.cachePath);
      return synchronizeIndexOnce(input, true, true);
    } catch {
      throw firstError;
    }
  }
}

function boundedText(value: string, limit: number): string {
  const clean = value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return boundedCodePoints(clean, limit);
}

function excerptFor(entry: ProjectMemoryJournalRecallEntry, terms: readonly string[]): string {
  const body = boundedText(entry.body || entry.summary, Number.MAX_SAFE_INTEGER);
  if (codePoints(body).length <= MAX_PROJECT_MEMORY_JOURNAL_EXCERPT_CHARS) return body;
  const normalizedBody = normalize(body);
  let matchAt = -1;
  for (const term of terms) {
    for (const variant of termVariants(term)) {
      const at = normalizedBody.indexOf(variant);
      if (at >= 0 && (matchAt < 0 || at < matchAt)) matchAt = at;
    }
  }
  const points = codePoints(body);
  // NFKC can move an index slightly; the surrounding context intentionally
  // leaves ample room and the final bound is enforced on the original text.
  const start = Math.max(0, matchAt - 160);
  const prefix = start > 0 ? "…" : "";
  let available = MAX_PROJECT_MEMORY_JOURNAL_EXCERPT_CHARS - codePoints(prefix).length;
  const needsSuffix = start + available < points.length;
  if (needsSuffix) available -= 1;
  const excerpt = points.slice(start, start + available).join("");
  return `${prefix}${excerpt}${needsSuffix ? "…" : ""}`;
}

function scoreEntry(
  entry: ProjectMemoryJournalRecallEntry,
  query: string,
  terms: readonly string[],
): ProjectMemoryJournalRecallHit | null {
  const summary = normalize(entry.summary);
  const body = normalize(entry.body);
  const normalizedQuery = normalize(query);
  const matchedTerms = terms.filter(term => containsTerm(summary, term) || containsTerm(body, term));
  if (!matchedTerms.length) return null;

  let score = 0;
  if (summary === normalizedQuery) score += 60;
  else if (summary.includes(normalizedQuery) || normalizedQuery.includes(summary)) score += 35;
  for (const term of matchedTerms) {
    if (containsTerm(summary, term)) score += 14;
    if (containsTerm(body, term)) score += 3;
  }
  return {
    source: "journal",
    authority: "historical-evidence",
    entryHash: entry.entryHash,
    recordedAt: entry.recordedAt,
    agent: entry.agent,
    headCommit: entry.headCommit,
    summary: boundedText(entry.summary, MAX_SUMMARY_CHARS),
    excerpt: excerptFor(entry, matchedTerms),
    matchedTerms,
    score,
    integrity: entry.integrity ?? "verified",
    caution: true,
  };
}

function compareHits(a: ProjectMemoryJournalRecallHit, b: ProjectMemoryJournalRecallHit): number {
  return b.score - a.score
    || b.recordedAt.localeCompare(a.recordedAt)
    || a.entryHash.localeCompare(b.entryHash);
}

function scanEntries(
  entries: readonly ProjectMemoryJournalRecallEntry[],
  query: string,
  terms: readonly string[],
  limit: number,
): ProjectMemoryJournalRecallHit[] {
  const hits: ProjectMemoryJournalRecallHit[] = [];
  for (const entry of uniqueEntries(entries)) {
    const hit = scoreEntry(entry, query, terms);
    if (!hit) continue;
    let at = hits.findIndex(existing => compareHits(hit, existing) < 0);
    if (at < 0) at = hits.length;
    hits.splice(at, 0, hit);
    if (hits.length > limit) hits.pop();
  }
  return hits;
}

function ftsExpression(terms: readonly string[]): string {
  return Array.from(new Set(terms.flatMap(term => termVariants(term))))
    .filter(term => codePoints(term).length >= 3)
    .map(term => `"${term.replace(/"/g, "\"\"")}"`)
    .join(" OR ");
}

function searchIndex(
  cachePath: string,
  entries: readonly ProjectMemoryJournalRecallEntry[],
  query: string,
  terms: readonly string[],
  limit: number,
): { hits: ProjectMemoryJournalRecallHit[]; truncated: boolean } {
  const expression = ftsExpression(terms);
  if (!expression) return { hits: [], truncated: false };
  const candidateLimit = Math.min(MAX_FTS_CANDIDATES, Math.max(MIN_FTS_CANDIDATES, limit * 12));
  const db = openIndex(cachePath);
  try {
    const rows = db.query(`
      SELECT entries.entry_hash AS entry_hash
      FROM journal_recall_fts
      JOIN journal_recall_entries AS entries ON entries.rowid = journal_recall_fts.rowid
      WHERE journal_recall_fts MATCH ?
      ORDER BY bm25(journal_recall_fts, 8.0, 1.0), entries.recorded_at DESC, entries.rowid
      LIMIT ?
    `).all(expression, candidateLimit + 1) as Array<{ entry_hash: string }>;
    const truncated = rows.length > candidateLimit;
    const boundedRows = rows.slice(0, candidateLimit);
    // BM25 ranks token relevance, not exact full-summary equality. Preserve the
    // strongest contract even when a common term has more candidates than the
    // bounded FTS window, without storing the plaintext summary in SQLite.
    const exactSummaryHash = createHash("sha256")
      .update(normalize(query), "utf8")
      .digest("hex");
    const exactRows = db.query(`
      SELECT entry_hash
      FROM journal_recall_entries
      WHERE summary_hash = ?
      ORDER BY recorded_at DESC, rowid
      LIMIT ?
    `).all(exactSummaryHash, limit) as Array<{ entry_hash: string }>;
    const candidateHashes = Array.from(new Set([...exactRows, ...boundedRows].map(row => row.entry_hash)));
    const byHash = new Map(uniqueEntries(entries).map(entry => [entry.entryHash, entry]));
    const hits = candidateHashes
      .map(entryHash => byHash.get(entryHash))
      .filter((entry): entry is ProjectMemoryJournalRecallEntry => !!entry)
      .map(entry => scoreEntry(entry, query, terms))
      .filter((hit): hit is ProjectMemoryJournalRecallHit => !!hit)
      .sort(compareHits)
      .slice(0, limit);
    return { hits, truncated };
  } finally {
    db.close();
  }
}

function boundedLimit(value?: number): number {
  if (!Number.isFinite(value)) return 5;
  return Math.max(1, Math.min(MAX_PROJECT_MEMORY_JOURNAL_RECALL_LIMIT, Math.floor(value!)));
}

export function recallProjectMemoryJournal(input: ProjectMemoryJournalIndexInput & {
  query: string;
  limit?: number;
}): ProjectMemoryJournalRecallResult {
  const terms = queryTerms(input.query);
  if (!terms.length) {
    return {
      hits: [],
      mode: "empty",
      complete: true,
      indexedEntries: 0,
      indexRebuilt: false,
      indexRecovered: false,
    };
  }

  const limit = boundedLimit(input.limit);
  let status: ProjectMemoryJournalIndexStatus | null = null;
  try {
    status = synchronizeProjectMemoryJournalRecallIndex(input);
    // FTS5's trigram tokenizer intentionally has no two-codepoint token. A full
    // scan preserves Korean terms such as 충돌/백업/복원 without a large custom
    // bigram posting list. The scan is also the correctness fallback if FTS
    // returns no usable candidate.
    const hasShortVariant = terms.some(term => (
      termVariants(term).some(variant => codePoints(variant).length < 3)
    ));
    if (!hasShortVariant) {
      let search: { hits: ProjectMemoryJournalRecallHit[]; truncated: boolean };
      try {
        search = searchIndex(input.cachePath, input.entries, input.query, terms, limit);
      } catch (searchError) {
        // Some corruption is visible only when FTS reads a damaged posting
        // page. Recreate the disposable cache once, then fall back to the full
        // verified input if even the fresh index cannot answer.
        if (!isIndexCorruption(searchError)) throw searchError;
        deleteDisposableIndex(input.cachePath);
        status = synchronizeIndexOnce(input, true, true);
        search = searchIndex(input.cachePath, input.entries, input.query, terms, limit);
      }
      if (search.hits.length) {
        return {
          hits: search.hits,
          mode: "fts",
          complete: !search.truncated,
          ...(search.truncated ? { truncated: true } : {}),
          indexedEntries: status.indexedEntries,
          indexRebuilt: status.rebuilt,
          indexRecovered: status.recovered,
        };
      }
    }
  } catch {
    // A disposable acceleration layer must never make authoritative history
    // unavailable. The complete verified input remains sufficient for recall.
  }

  return {
    hits: scanEntries(input.entries, input.query, terms, limit),
    mode: "scan-fallback",
    complete: true,
    indexedEntries: status?.indexedEntries ?? 0,
    indexRebuilt: status?.rebuilt ?? false,
    indexRecovered: status?.recovered ?? false,
    ...(!status ? { indexWarning: "CACHE_UNAVAILABLE" as const } : {}),
  };
}
