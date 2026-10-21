import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { githubRepositoryFromRemote } from "./publicRepositoryRemote";

export const PROJECT_MEMORY_ARCHIVE_BRANCH = "agentstoz-memory-v1";
export const PROJECT_MEMORY_ARCHIVE_LOCAL_REF = `refs/heads/${PROJECT_MEMORY_ARCHIVE_BRANCH}`;
export const PROJECT_MEMORY_ARCHIVE_REMOTE_REF = `refs/remotes/origin/${PROJECT_MEMORY_ARCHIVE_BRANCH}`;
export const PROJECT_MEMORY_ARCHIVE_PUSH_REFSPEC = `${PROJECT_MEMORY_ARCHIVE_LOCAL_REF}:${PROJECT_MEMORY_ARCHIVE_LOCAL_REF}`;

const ARCHIVE_SCHEMA_VERSION = 2;
const MAX_COMMAND_OUTPUT = 8_000;
const MAX_ARCHIVE_FILE_BYTES = 1_000_000;
const STAGING_LOCK_STALE_MS = 10 * 60_000;
const ALLOWED_PERMISSIONS = new Set(["WRITE", "MAINTAIN", "ADMIN"]);
const SAFE_NOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*\.md$/;
const MEMORY_NAMESPACE = /^mem-[0-9a-f]{24}$/;

export interface PrivateGitHubArchiveCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface PrivateGitHubArchiveCommandRunner {
  run(
    command: string,
    args: readonly string[],
    options: { cwd: string; timeoutMs: number },
  ): Promise<PrivateGitHubArchiveCommandResult>;
}

export interface VerifiedPrivateArchiveJournalEntry {
  entryHash: string;
  recordedAt: string;
  agent: "claude" | "codex" | null;
  headCommit: string | null;
  summary: string;
  body: string;
}

export interface PrivateArchiveMemoryNote {
  fileName: string;
  content: string;
}

export interface ProjectMemoryPrivateGitHubArchiveInput {
  /** Used only to prove that the app-data staging path cannot touch this worktree. */
  projectRoot: string;
  appDataDir: string;
  memoryId: string;
  repositoryUrl: string;
  /** Persist the first successful result's repositoryId and require it thereafter. */
  expectedRepositoryId?: string | null;
  core: string;
  notes?: readonly PrivateArchiveMemoryNote[];
  notesManifest?: string | null;
  verifiedJournalEntries?: readonly VerifiedPrivateArchiveJournalEntry[];
  runner?: PrivateGitHubArchiveCommandRunner;
  gitCommand?: string;
  ghCommand?: string;
}

export type ProjectMemoryPrivateGitHubArchiveErrorCode =
  | "INPUT_INVALID"
  | "REPOSITORY_URL_INVALID"
  | "STAGING_OVERLAPS_PROJECT"
  | "STAGING_UNSAFE"
  | "STAGING_BUSY"
  | "SNAPSHOT_INVALID"
  | "SECRET_DETECTED"
  | "JOURNAL_NOT_VERIFIED"
  | "GIT_INIT_FAILED"
  | "REMOTE_INSPECTION_FAILED"
  | "REMOTE_FETCH_FAILED"
  | "STAGING_DIVERGED"
  | "STAGING_TREE_UNSAFE"
  | "COMMIT_FAILED"
  | "GH_VERIFICATION_FAILED"
  | "REPOSITORY_IDENTITY_MISMATCH"
  | "REPOSITORY_NOT_PRIVATE"
  | "REPOSITORY_PERMISSION_DENIED"
  | "PUSH_FAILED";

export interface ProjectMemoryPrivateGitHubArchiveResult {
  success: boolean;
  status: "pushed" | "failed";
  repository: string | null;
  repositoryId: string | null;
  memoryNamespace: string | null;
  branch: typeof PROJECT_MEMORY_ARCHIVE_BRANCH;
  stagingPath: string | null;
  commit: string | null;
  manifestHash: string | null;
  attemptedPush: boolean;
  /** This module has no write path back into either authoritative store. */
  localMemoryChanged: false;
  supabaseChanged: false;
  errorCode?: ProjectMemoryPrivateGitHubArchiveErrorCode;
  error?: string;
}

interface ArchiveSnapshot {
  files: Map<string, string>;
  manifestHash: string;
  memoryNamespace: string;
}

interface ArchiveManifestFile {
  path: string;
  bytes: number;
  sha256: string;
}

class ArchiveFailure extends Error {
  constructor(
    readonly code: ProjectMemoryPrivateGitHubArchiveErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ArchiveFailure";
  }
}

function hash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function archiveManifestFile(path: string, content: string): ArchiveManifestFile {
  return { path, bytes: Buffer.byteLength(content, "utf8"), sha256: hash(content) };
}

function isJournalArchivePath(path: string): boolean {
  return allowedArchiveTreePath(path)?.kind === "journal";
}

function journalSetDigest(files: ReadonlyMap<string, string>): { count: number; sha256: string } {
  const lines = [...files.entries()]
    .filter(([path]) => isJournalArchivePath(path))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, content]) => `${path}\0${hash(content)}`);
  return { count: lines.length, sha256: hash(lines.join("\n")) };
}

function boundedOutput(value: unknown): string {
  return String(value ?? "").slice(0, MAX_COMMAND_OUTPUT);
}

function isolatedArchiveCommandEnvironment(): Record<string, string | undefined> {
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) {
    if (name.startsWith("GIT_")) delete environment[name];
    if (name.startsWith("GH_") && !["GH_TOKEN", "GH_CONFIG_DIR"].includes(name)) delete environment[name];
  }
  // Do not fall back to ~/.gitconfig or the system config: either can carry
  // url.*.insteadOf, pushInsteadOf, proxy, helper, or include directives that
  // change the transport after the canonical URL check. Authentication is
  // restored explicitly through the resolved gh credential helper below.
  environment.GIT_CONFIG_NOSYSTEM = "1";
  environment.GIT_CONFIG_GLOBAL = process.platform === "win32" ? "NUL" : "/dev/null";
  environment.GIT_ATTR_NOSYSTEM = "1";
  environment.GIT_TERMINAL_PROMPT = "0";
  environment.GCM_INTERACTIVE = "Never";
  environment.GH_HOST = "github.com";
  environment.GH_PROMPT_DISABLED = "1";
  return environment;
}

export const bunPrivateGitHubArchiveCommandRunner: PrivateGitHubArchiveCommandRunner = {
  async run(command, args, options) {
    try {
      const child = Bun.spawn([command, ...args], {
        cwd: options.cwd,
        env: isolatedArchiveCommandEnvironment(),
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const completed = Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      let didTimeout = false;
      let forceKillId: ReturnType<typeof setTimeout> | null = null;
      const timeoutId = setTimeout(() => {
        didTimeout = true;
        try { child.kill(); } catch {}
        // Do not release the staging lease while a timed-out Git process may
        // still be running. Escalate asynchronously, then await `child.exited`.
        forceKillId = setTimeout(() => {
          try { child.kill(9); } catch {}
        }, 1_000);
      }, options.timeoutMs);
      try {
        const [exitCode, stdout, stderr] = await completed;
        return {
          exitCode: didTimeout ? 124 : exitCode,
          // `git ls-files -z` and `git ls-tree -z` legitimately grow beyond a
          // diagnostic-sized buffer as journals accumulate. Their complete
          // output is required for the exact-tree safety check.
          stdout: didTimeout ? "" : stdout,
          stderr: didTimeout ? "command timed out" : boundedOutput(stderr),
        };
      } finally {
        clearTimeout(timeoutId);
        if (forceKillId) clearTimeout(forceKillId);
      }
    } catch (error: any) {
      return { exitCode: 127, stdout: "", stderr: boundedOutput(error?.message ?? error) };
    }
  },
};

function pathInside(root: string, target: string): boolean {
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return target === root || target.startsWith(prefix);
}

/** Resolve symlinks in the existing prefix without creating the requested path. */
function projectedCanonicalPath(inputPath: string): string {
  const requested = resolve(inputPath);
  const missing: string[] = [];
  let cursor = requested;
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) break;
    missing.unshift(basename(cursor));
    cursor = parent;
  }
  const existing = existsSync(cursor) ? realpathSync(cursor) : cursor;
  return resolve(existing, ...missing);
}

function safeStagingPath(root: string, relativePath: string): string {
  if (!relativePath || isAbsolute(relativePath) || relativePath.includes("\\")) {
    throw new ArchiveFailure("STAGING_UNSAFE", "보관 staging 상대경로가 안전하지 않습니다.");
  }
  const segments = relativePath.split("/");
  if (segments.some(segment => !segment || segment === "." || segment === "..")) {
    throw new ArchiveFailure("STAGING_UNSAFE", "보관 staging 상대경로가 안전하지 않습니다.");
  }
  const canonicalRoot = realpathSync(root);
  const target = resolve(canonicalRoot, ...segments);
  if (!pathInside(canonicalRoot, target)) {
    throw new ArchiveFailure("STAGING_UNSAFE", "보관 staging 경로가 전용 폴더 밖을 가리킵니다.");
  }
  let cursor = canonicalRoot;
  for (const segment of segments) {
    cursor = join(cursor, segment);
    if (!existsSync(cursor)) continue;
    if (lstatSync(cursor).isSymbolicLink()) {
      throw new ArchiveFailure("STAGING_UNSAFE", "보관 staging 경로에는 심볼릭 링크를 사용할 수 없습니다.");
    }
    if (!pathInside(canonicalRoot, realpathSync(cursor))) {
      throw new ArchiveFailure("STAGING_UNSAFE", "보관 staging 실제 경로가 전용 폴더를 벗어났습니다.");
    }
  }
  return target;
}

function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true });
  if (process.platform !== "win32") chmodSync(path, 0o700);
}

function writePrivateFile(root: string, relativePath: string, content: string): void {
  const target = safeStagingPath(root, relativePath);
  ensurePrivateDirectory(dirname(target));
  if (existsSync(target) && (lstatSync(target).isSymbolicLink() || !statSync(target).isFile())) {
    throw new ArchiveFailure("STAGING_UNSAFE", "보관 staging 파일 위치가 안전하지 않습니다.");
  }
  const temporary = `${target}.tmp-${process.pid}`;
  if (existsSync(temporary) && lstatSync(temporary).isSymbolicLink()) {
    throw new ArchiveFailure("STAGING_UNSAFE", "보관 staging 임시파일 위치가 안전하지 않습니다.");
  }
  writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, target);
  if (process.platform !== "win32") chmodSync(target, 0o600);
}

function removeTrackedStageFile(root: string, relativePath: string): void {
  const target = safeStagingPath(root, relativePath);
  if (!existsSync(target)) return;
  const info = lstatSync(target);
  if (info.isDirectory()) {
    throw new ArchiveFailure("STAGING_TREE_UNSAFE", "tracked staging 경로가 파일이 아닙니다.");
  }
  // unlink removes a symlink itself rather than following it. safeStagingPath
  // has already rejected symlinks in every parent component.
  unlinkSync(target);
}

function parseRepository(repositoryUrl: string): { slug: string; canonicalUrl: string } | null {
  const value = repositoryUrl.trim();
  if (!value || /[\r\n\0]/.test(value)) return null;
  const slug = githubRepositoryFromRemote(value);
  if (!slug) return null;

  // githubRepositoryFromRemote already rejects HTTPS userinfo/passwords and
  // non-git SSH usernames. Keep this explicit check so a future broadening of
  // that general helper cannot silently allow a credential-bearing archive URL.
  if (!/^git@github\.com:/i.test(value)) {
    try {
      const parsed = new URL(value);
      if (parsed.username || parsed.password || parsed.search || parsed.hash) return null;
    } catch {
      return null;
    }
  }
  return { slug, canonicalUrl: `https://github.com/${slug}.git` };
}

function resolveProductionExecutable(
  command: string,
  code: ProjectMemoryPrivateGitHubArchiveErrorCode,
  label: string,
): string {
  if (!command.trim() || /[\r\n\0]/.test(command)) {
    throw new ArchiveFailure(code, `${label} 실행경로가 안전하지 않습니다.`);
  }
  const candidate = isAbsolute(command) ? command : Bun.which(command);
  if (!candidate) throw new ArchiveFailure(code, `${label} 실행파일을 찾을 수 없습니다.`);
  try {
    const canonical = realpathSync(candidate);
    if (!statSync(canonical).isFile()) throw new Error("not a file");
    return canonical;
  } catch {
    throw new ArchiveFailure(code, `${label} 실행파일을 안전하게 해석할 수 없습니다.`);
  }
}

function shellQuoteForGitHelper(path: string): string {
  const shellPath = process.platform === "win32" ? path.replace(/\\/g, "/") : path;
  return `'${shellPath.replace(/'/g, `'\\''`)}'`;
}

function ghCredentialHelper(ghExecutable: string): string {
  return `!${shellQuoteForGitHelper(ghExecutable)} auth git-credential`;
}

function freshPrivateArchiveGitConfig(): string {
  return [
    "[core]",
    "\trepositoryformatversion = 0",
    "\tfilemode = true",
    "\tbare = false",
    "\tlogallrefupdates = true",
    "",
  ].join("\n");
}

function journalEntryHash(entry: VerifiedPrivateArchiveJournalEntry): string {
  return hash([entry.headCommit ?? "", entry.summary, entry.body].join("\n")).slice(0, 16);
}

function renderVerifiedJournals(
  entries: readonly VerifiedPrivateArchiveJournalEntry[],
  memoryNamespace: string,
): Map<string, string> {
  const unique = new Map<string, VerifiedPrivateArchiveJournalEntry>();
  for (const entry of entries) {
    if (!/^[0-9a-f]{16}$/.test(entry.entryHash)
      || journalEntryHash(entry) !== entry.entryHash
      || !/^\d{4}-(?:0[1-9]|1[0-2])-\d{2}T/.test(entry.recordedAt)
      || Number.isNaN(Date.parse(entry.recordedAt))
      || (entry.agent !== null && entry.agent !== "claude" && entry.agent !== "codex")
      || (entry.headCommit !== null && typeof entry.headCommit !== "string")
      || typeof entry.summary !== "string"
      || typeof entry.body !== "string") {
      throw new ArchiveFailure("JOURNAL_NOT_VERIFIED", "검증되지 않은 journal 항목은 GitHub 보관본에 넣을 수 없습니다.");
    }
    const previous = unique.get(entry.entryHash);
    if (previous && JSON.stringify(previous) !== JSON.stringify(entry)) {
      throw new ArchiveFailure("JOURNAL_NOT_VERIFIED", "같은 hash를 가진 journal 항목의 내용이 서로 다릅니다.");
    }
    if (!previous) unique.set(entry.entryHash, entry);
  }

  const rendered = new Map<string, string>();
  for (const entry of [...unique.values()].sort((a, b) => (
    a.recordedAt.localeCompare(b.recordedAt) || a.entryHash.localeCompare(b.entryHash)
  ))) {
    const [year, month] = entry.recordedAt.slice(0, 7).split("-");
    if (!/^\d{4}$/.test(year ?? "") || !/^\d{2}$/.test(month ?? "")) {
      throw new ArchiveFailure("JOURNAL_NOT_VERIFIED", "journal 기록 월을 확인할 수 없습니다.");
    }
    // One immutable content-addressed file per verified entry avoids rewriting
    // a growing monthly blob on every session (and therefore avoids quadratic
    // Git history over a long-lived month).
    const content = `${JSON.stringify({
      version: 2,
      entryHash: entry.entryHash,
      recordedAt: entry.recordedAt,
      agent: entry.agent,
      headCommit: entry.headCommit,
      summary: entry.summary,
      body: entry.body,
    }, null, 2)}\n`;
    rendered.set(`memories/${memoryNamespace}/journal/${year}/${month}/${entry.entryHash}.json`, content);
  }
  return rendered;
}

function validateNotes(
  notes: readonly PrivateArchiveMemoryNote[],
  manifestContent: string | null | undefined,
  memoryNamespace: string,
): Map<string, string> {
  if (notes.length === 0 && !manifestContent) return new Map();
  if (!manifestContent) {
    throw new ArchiveFailure("SNAPSHOT_INVALID", "분해된 장기기억 notes에는 manifest.json이 필요합니다.");
  }
  const byName = new Map<string, string>();
  for (const note of notes) {
    if (note.fileName !== basename(note.fileName)
      || !SAFE_NOTE_NAME.test(note.fileName)
      || note.fileName.toLowerCase() === "manifest.md") {
      throw new ArchiveFailure("SNAPSHOT_INVALID", "장기기억 note 파일명이 안전하지 않습니다.");
    }
    const key = note.fileName.toLowerCase();
    if (byName.has(key)) throw new ArchiveFailure("SNAPSHOT_INVALID", "중복된 장기기억 note 파일명이 있습니다.");
    byName.set(key, note.content);
  }

  let parsed: any;
  try {
    parsed = JSON.parse(manifestContent);
  } catch {
    throw new ArchiveFailure("SNAPSHOT_INVALID", "장기기억 notes manifest를 해석할 수 없습니다.");
  }
  if (parsed?.version !== 1) {
    throw new ArchiveFailure("SNAPSHOT_INVALID", "지원하지 않는 장기기억 notes manifest 버전입니다.");
  }
  const manifestNames = Array.isArray(parsed?.parts)
    ? parsed.parts.map((part: any) => part?.file)
    : [];
  if (manifestNames.some((name: unknown) => typeof name !== "string" || !SAFE_NOTE_NAME.test(name))) {
    throw new ArchiveFailure("SNAPSHOT_INVALID", "장기기억 notes manifest 경로가 안전하지 않습니다.");
  }
  const normalizedManifestNames = manifestNames.map((name: string) => name.toLowerCase());
  if (new Set(normalizedManifestNames).size !== normalizedManifestNames.length
    || normalizedManifestNames.length !== byName.size
    || normalizedManifestNames.some((name: string) => !byName.has(name))) {
    throw new ArchiveFailure("SNAPSHOT_INVALID", "notes manifest와 실제 note 파일이 일치하지 않습니다.");
  }

  const files = new Map<string, string>();
  for (const [lowerName, content] of byName) {
    const originalName = notes.find(note => note.fileName.toLowerCase() === lowerName)!.fileName;
    files.set(`memories/${memoryNamespace}/notes/${originalName}`, content);
  }
  files.set(`memories/${memoryNamespace}/notes/manifest.json`, manifestContent);
  return files;
}

function containsHighConfidenceSecret(content: string): boolean {
  return /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(content)
    || /\bgh[pousr]_[A-Za-z0-9]{20,}\b/.test(content)
    || /\bgithub_pat_[A-Za-z0-9_]{20,}\b/.test(content)
    || /\bAKIA[0-9A-Z]{16}\b/.test(content)
    || /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/.test(content)
    || /\bsk-ant-[A-Za-z0-9_-]{20,}\b/.test(content)
    || /\bxox[a-z]-[A-Za-z0-9-]{10,}\b/i.test(content)
    || /\bAIza[0-9A-Za-z_-]{20,}\b/.test(content)
    || /\b(?:SUPABASE_SERVICE_ROLE_KEY|GITHUB_TOKEN|ANTHROPIC_API_KEY|OPENAI_API_KEY)\s*[:=]\s*["']?[^\s"']{8,}/i.test(content);
}

function containsHighConfidenceRawTranscript(content: string): boolean {
  if (/"messages"\s*:\s*\[[\s\S]{0,500}"role"\s*:\s*"(?:user|assistant|system)"/i.test(content)) {
    return true;
  }
  const roleLines = content.match(/^\s*(?:user|assistant|system)\s*:/gim) ?? [];
  return roleLines.length >= 4
    && /^\s*user\s*:/im.test(content)
    && /^\s*assistant\s*:/im.test(content);
}

type AllowedArchiveTreeKind = "core" | "note" | "notes-manifest" | "journal" | "archive-manifest" | "checksums";

interface AllowedArchiveTreePath {
  namespace: string;
  kind: AllowedArchiveTreeKind;
  journalYear?: string;
  journalMonth?: string;
  journalHash?: string;
}

function allowedArchiveTreePath(relativePath: string): AllowedArchiveTreePath | null {
  const root = /^memories\/(mem-[0-9a-f]{24})\/(.+)$/.exec(relativePath);
  if (!root || !MEMORY_NAMESPACE.test(root[1]!)) return null;
  const namespace = root[1]!;
  const remainder = root[2]!;
  if (remainder === "CORE.md") return { namespace, kind: "core" };
  if (remainder === "notes/manifest.json") return { namespace, kind: "notes-manifest" };
  if (remainder === "archive-manifest.json") return { namespace, kind: "archive-manifest" };
  if (remainder === "SHA256SUMS") return { namespace, kind: "checksums" };
  const note = /^notes\/([^/]+)$/.exec(remainder);
  if (note && SAFE_NOTE_NAME.test(note[1]!) && note[1]!.toLowerCase() !== "manifest.md") {
    return { namespace, kind: "note" };
  }
  const journal = /^journal\/(\d{4})\/(0[1-9]|1[0-2])\/([0-9a-f]{16})\.json$/.exec(remainder);
  if (journal) {
    return {
      namespace,
      kind: "journal",
      journalYear: journal[1],
      journalMonth: journal[2],
      journalHash: journal[3],
    };
  }
  return null;
}

function assertVerifiedArchivedJournal(content: string, path: AllowedArchiveTreePath): void {
  let parsed: any;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new ArchiveFailure("STAGING_TREE_UNSAFE", "기존 보관 journal 파일을 검증할 수 없습니다.");
  }
  const candidate: VerifiedPrivateArchiveJournalEntry = {
    entryHash: parsed?.entryHash,
    recordedAt: parsed?.recordedAt,
    agent: parsed?.agent,
    headCommit: parsed?.headCommit,
    summary: parsed?.summary,
    body: parsed?.body,
  };
  const valid = parsed?.version === 2
    && typeof candidate.entryHash === "string"
    && candidate.entryHash === path.journalHash
    && /^[0-9a-f]{16}$/.test(candidate.entryHash)
    && typeof candidate.recordedAt === "string"
    && candidate.recordedAt.slice(0, 4) === path.journalYear
    && candidate.recordedAt.slice(5, 7) === path.journalMonth
    && !Number.isNaN(Date.parse(candidate.recordedAt))
    && (candidate.agent === null || candidate.agent === "claude" || candidate.agent === "codex")
    && (candidate.headCommit === null || typeof candidate.headCommit === "string")
    && typeof candidate.summary === "string"
    && typeof candidate.body === "string"
    && journalEntryHash(candidate) === candidate.entryHash;
  if (!valid) {
    throw new ArchiveFailure("STAGING_TREE_UNSAFE", "기존 보관 journal 파일의 hash 또는 경로가 올바르지 않습니다.");
  }
}

function assertArchiveNamespaceIntegrity(
  namespace: string,
  repository: string,
  files: ReadonlyMap<string, string>,
): void {
  const prefix = `memories/${namespace}`;
  const corePath = `${prefix}/CORE.md`;
  const manifestPath = `${prefix}/archive-manifest.json`;
  const checksumsPath = `${prefix}/SHA256SUMS`;
  if (!files.has(corePath) || !files.has(manifestPath) || !files.has(checksumsPath)) {
    throw new ArchiveFailure("STAGING_TREE_UNSAFE", "보관 memory namespace의 필수 manifest/checksum 파일이 없습니다.");
  }
  let manifest: any;
  try {
    manifest = JSON.parse(files.get(manifestPath)!);
  } catch {
    throw new ArchiveFailure("STAGING_TREE_UNSAFE", "보관 memory namespace manifest를 해석할 수 없습니다.");
  }
  let manifestNamespace: string;
  try {
    manifestNamespace = projectMemoryPrivateGitHubNamespace(manifest?.memoryId);
  } catch {
    throw new ArchiveFailure("STAGING_TREE_UNSAFE", "보관 memory namespace identity가 올바르지 않습니다.");
  }
  const sourceEntries = [...files.entries()]
    .filter(([path]) => path !== manifestPath && path !== checksumsPath && !isJournalArchivePath(path))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, content]) => archiveManifestFile(path, content));
  const journal = journalSetDigest(files);
  const validManifest = manifest?.schemaVersion === ARCHIVE_SCHEMA_VERSION
    && manifest?.memoryNamespace === namespace
    && manifestNamespace === namespace
    && manifest?.repository === repository
    && manifest?.branch === PROJECT_MEMORY_ARCHIVE_BRANCH
    && JSON.stringify(manifest?.files) === JSON.stringify(sourceEntries)
    && manifest?.journal?.layout === "verified-entry-v2"
    && manifest?.journal?.count === journal.count
    && manifest?.journal?.setSha256 === journal.sha256;
  if (!validManifest) {
    throw new ArchiveFailure("STAGING_TREE_UNSAFE", "보관 memory namespace manifest와 실제 파일이 일치하지 않습니다.");
  }
  const expectedChecksums = [...files.entries()]
    .filter(([path]) => path !== checksumsPath && !isJournalArchivePath(path))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, content]) => `${hash(content)}  ${path}`)
    .concat(`${journal.sha256}  JOURNAL_SET`)
    .join("\n");
  if (files.get(checksumsPath) !== `${expectedChecksums}\n`) {
    throw new ArchiveFailure("STAGING_TREE_UNSAFE", "보관 memory namespace checksum과 실제 파일이 일치하지 않습니다.");
  }
}

function assertSafeCommittedTreeFiles(root: string, paths: readonly string[], repository: string): void {
  const namespaceFiles = new Map<string, Map<string, string>>();
  for (const relativePath of paths) {
    const allowed = allowedArchiveTreePath(relativePath);
    if (!allowed) {
      throw new ArchiveFailure("STAGING_TREE_UNSAFE", "보관 staging tree에 allowlist 밖 파일이 있습니다.");
    }
    const target = safeStagingPath(root, relativePath);
    if (!existsSync(target) || lstatSync(target).isSymbolicLink() || !statSync(target).isFile()) {
      throw new ArchiveFailure("STAGING_TREE_UNSAFE", "보관 staging tree의 tracked 경로가 일반 파일이 아닙니다.");
    }
    const bytes = readFileSync(target);
    if (bytes.byteLength > MAX_ARCHIVE_FILE_BYTES) {
      throw new ArchiveFailure("STAGING_TREE_UNSAFE", "보관 staging 파일이 허용 크기를 초과했습니다.");
    }
    const content = bytes.toString("utf8");
    if (!Buffer.from(content, "utf8").equals(bytes)) {
      throw new ArchiveFailure("STAGING_TREE_UNSAFE", "보관 staging 파일이 UTF-8 텍스트가 아닙니다.");
    }
    if (containsHighConfidenceSecret(content) || containsHighConfidenceRawTranscript(content)) {
      throw new ArchiveFailure("SECRET_DETECTED", "보관 staging tree에서 credential 또는 raw transcript로 보이는 값을 발견했습니다.");
    }
    if (allowed.kind === "journal") assertVerifiedArchivedJournal(content, allowed);
    const files = namespaceFiles.get(allowed.namespace) ?? new Map<string, string>();
    files.set(relativePath, content);
    namespaceFiles.set(allowed.namespace, files);
  }
  for (const [namespace, files] of namespaceFiles) {
    assertArchiveNamespaceIntegrity(namespace, repository, files);
  }
}

export function projectMemoryPrivateGitHubNamespace(memoryId: string): string {
  if (!memoryId.trim() || memoryId.length > 200) {
    throw new ArchiveFailure("INPUT_INVALID", "memory ID가 필요합니다.");
  }
  return `mem-${hash(memoryId).slice(0, 24)}`;
}

function finalizeArchiveSnapshot(input: {
  memoryId: string;
  memoryNamespace: string;
  repository: string;
  sourceFiles: ReadonlyMap<string, string>;
}): ArchiveSnapshot {
  const files = new Map(input.sourceFiles);
  const namespacePrefix = `memories/${input.memoryNamespace}/`;
  files.delete(`${namespacePrefix}archive-manifest.json`);
  files.delete(`${namespacePrefix}SHA256SUMS`);
  if (!files.has(`${namespacePrefix}CORE.md`)) {
    throw new ArchiveFailure("SNAPSHOT_INVALID", "장기기억 CORE/index 본문이 필요합니다.");
  }
  for (const path of files.keys()) {
    const allowed = allowedArchiveTreePath(path);
    if (!allowed
      || allowed.namespace !== input.memoryNamespace
      || allowed.kind === "archive-manifest"
      || allowed.kind === "checksums") {
      throw new ArchiveFailure("SNAPSHOT_INVALID", "장기기억 보관 source 경로가 allowlist 밖입니다.");
    }
  }
  for (const content of files.values()) {
    if (Buffer.byteLength(content, "utf8") > MAX_ARCHIVE_FILE_BYTES) {
      throw new ArchiveFailure("SNAPSHOT_INVALID", "장기기억 보관 파일이 허용 크기를 초과했습니다.");
    }
    if (containsHighConfidenceSecret(content)) {
      throw new ArchiveFailure("SECRET_DETECTED", "장기기억 보관 대상에서 credential로 보이는 값을 발견했습니다.");
    }
    if (containsHighConfidenceRawTranscript(content)) {
      throw new ArchiveFailure("SNAPSHOT_INVALID", "raw transcript로 보이는 내용은 장기기억 보관본에 넣을 수 없습니다.");
    }
  }

  const manifestEntries = [...files.entries()]
    .filter(([path]) => !isJournalArchivePath(path))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, content]) => archiveManifestFile(path, content));
  const journal = journalSetDigest(files);
  const manifest = `${JSON.stringify({
    schemaVersion: ARCHIVE_SCHEMA_VERSION,
    memoryId: input.memoryId,
    memoryNamespace: input.memoryNamespace,
    repository: input.repository,
    branch: PROJECT_MEMORY_ARCHIVE_BRANCH,
    files: manifestEntries,
    journal: {
      layout: "verified-entry-v2",
      count: journal.count,
      setSha256: journal.sha256,
    },
  }, null, 2)}\n`;
  files.set(`${namespacePrefix}archive-manifest.json`, manifest);
  const checksums = [...files.entries()]
    .filter(([path]) => !isJournalArchivePath(path))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, content]) => `${hash(content)}  ${path}`)
    .concat(`${journal.sha256}  JOURNAL_SET`)
    .join("\n");
  files.set(`${namespacePrefix}SHA256SUMS`, `${checksums}\n`);
  return { files, manifestHash: hash(manifest), memoryNamespace: input.memoryNamespace };
}

function buildArchiveSnapshot(input: ProjectMemoryPrivateGitHubArchiveInput, repository: string): ArchiveSnapshot {
  if (!input.memoryId.trim() || input.memoryId.length > 200 || typeof input.core !== "string") {
    throw new ArchiveFailure("INPUT_INVALID", "memory ID와 CORE/index 본문이 필요합니다.");
  }
  const memoryNamespace = projectMemoryPrivateGitHubNamespace(input.memoryId);
  const sourceFiles = new Map<string, string>();
  sourceFiles.set(`memories/${memoryNamespace}/CORE.md`, input.core);
  for (const [path, content] of validateNotes(input.notes ?? [], input.notesManifest, memoryNamespace)) sourceFiles.set(path, content);
  for (const [path, content] of renderVerifiedJournals(input.verifiedJournalEntries ?? [], memoryNamespace)) sourceFiles.set(path, content);
  return finalizeArchiveSnapshot({ memoryId: input.memoryId, memoryNamespace, repository, sourceFiles });
}

export function projectMemoryPrivateGitHubStagingPath(input: {
  appDataDir: string;
  projectRoot: string;
  repository: string;
}): string {
  const project = realpathSync(resolve(input.projectRoot));
  const projectedAppData = projectedCanonicalPath(input.appDataDir);
  // One staging repository per GitHub repository allows several independent
  // memory namespaces to coexist without separate clones overwriting each other.
  const key = hash(input.repository.toLowerCase()).slice(0, 32);
  const projectedStage = resolve(projectedAppData, "project-memory-private-github", key);
  if (pathInside(project, projectedStage) || pathInside(projectedStage, project)) {
    throw new ArchiveFailure("STAGING_OVERLAPS_PROJECT", "Private GitHub staging은 프로젝트 worktree 밖에 있어야 합니다.");
  }
  return projectedStage;
}

function prepareStaging(input: {
  appDataDir: string;
  projectRoot: string;
  repository: string;
}): string {
  const stage = projectMemoryPrivateGitHubStagingPath(input);
  const appDataRoot = projectedCanonicalPath(input.appDataDir);
  const archiveRoot = dirname(stage);
  for (const candidate of [appDataRoot, archiveRoot, stage]) {
    if (!existsSync(candidate)) {
      ensurePrivateDirectory(candidate);
      continue;
    }
    const info = lstatSync(candidate);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new ArchiveFailure("STAGING_UNSAFE", "Private GitHub staging 경로에는 심볼릭 링크를 사용할 수 없습니다.");
    }
    if (candidate !== appDataRoot && process.platform !== "win32") chmodSync(candidate, 0o700);
  }
  const canonicalStage = realpathSync(stage);
  const canonicalAppDataRoot = realpathSync(appDataRoot);
  const canonicalProject = realpathSync(resolve(input.projectRoot));
  if (!pathInside(canonicalAppDataRoot, canonicalStage)) {
    throw new ArchiveFailure("STAGING_UNSAFE", "Private GitHub staging이 app-data 전용 폴더를 벗어났습니다.");
  }
  if (pathInside(canonicalProject, canonicalStage) || pathInside(canonicalStage, canonicalProject)) {
    throw new ArchiveFailure("STAGING_OVERLAPS_PROJECT", "Private GitHub staging은 프로젝트 worktree 밖에 있어야 합니다.");
  }
  const dotGit = join(canonicalStage, ".git");
  if (existsSync(dotGit)) {
    const info = lstatSync(dotGit);
    if (info.isSymbolicLink() || !info.isDirectory() || !pathInside(canonicalStage, realpathSync(dotGit))) {
      throw new ArchiveFailure("STAGING_UNSAFE", "보관 staging의 .git 경로가 안전하지 않습니다.");
    }
    const configPath = join(dotGit, "config");
    const worktreeConfigPath = join(dotGit, "config.worktree");
    if (existsSync(worktreeConfigPath)) {
      throw new ArchiveFailure("STAGING_UNSAFE", "보관 staging에 별도 worktree Git config가 남아 있습니다.");
    }
    if (existsSync(configPath)) {
      const configInfo = lstatSync(configPath);
      if (configInfo.isSymbolicLink() || !configInfo.isFile() || configInfo.size > MAX_ARCHIVE_FILE_BYTES) {
        throw new ArchiveFailure("STAGING_UNSAFE", "보관 staging Git config가 안전하지 않습니다.");
      }
      const config = readFileSync(configPath, "utf8");
      if (/^\s*worktree\s*=/im.test(config)
        || /^\s*bare\s*=\s*(?:true|yes|on|1)\s*$/im.test(config)
        || /^\s*worktreeConfig\s*=\s*(?:true|yes|on|1)\s*$/im.test(config)
        || /^\s*\[include(?:If\b[^\]]*)?\]\s*$/im.test(config)
        || /^\s*(?:insteadOf|pushInsteadOf|pushurl)\s*=/im.test(config)) {
        throw new ArchiveFailure("STAGING_UNSAFE", "보관 staging Git config가 외부 worktree 또는 다른 transport를 가리킬 수 있습니다.");
      }
    }
  }
  return canonicalStage;
}

interface StagingLease {
  release(): void;
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error?.code === "EPERM";
  }
}

function removeStaleStagingLock(lockPath: string): boolean {
  try {
    const info = lstatSync(lockPath);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new ArchiveFailure("STAGING_UNSAFE", "보관 staging lock 경로가 안전하지 않습니다.");
    }
    let owner: any = null;
    try { owner = JSON.parse(readFileSync(lockPath, "utf8")); } catch {}
    const age = Date.now() - info.mtimeMs;
    if (age <= STAGING_LOCK_STALE_MS || processIsAlive(Number(owner?.pid))) return false;
    unlinkSync(lockPath);
    return true;
  } catch (error: any) {
    if (error instanceof ArchiveFailure) throw error;
    if (error?.code === "ENOENT") return true;
    throw new ArchiveFailure("STAGING_UNSAFE", "보관 staging lock을 확인하지 못했습니다.");
  }
}

function acquireStagingLease(stagingPath: string): StagingLease {
  const lockPath = safeStagingPath(stagingPath, ".agentstoz-archive.lock");
  const token = randomUUID();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let descriptor: number | null = null;
    let created = false;
    try {
      descriptor = openSync(lockPath, "wx", 0o600);
      created = true;
      writeFileSync(descriptor, `${JSON.stringify({ pid: process.pid, token, acquiredAt: new Date().toISOString() })}\n`, "utf8");
      closeSync(descriptor);
      descriptor = null;
      if (process.platform !== "win32") chmodSync(lockPath, 0o600);
      return {
        release() {
          try {
            const current = JSON.parse(readFileSync(lockPath, "utf8"));
            if (current?.token === token) unlinkSync(lockPath);
          } catch {
            // A failed archive must still return its primary result. A missing
            // or replaced lock is never deleted blindly.
          }
        },
      };
    } catch (error: any) {
      if (descriptor !== null) {
        try { closeSync(descriptor); } catch {}
      }
      if (created) {
        try {
          if (existsSync(lockPath) && lstatSync(lockPath).isFile() && !lstatSync(lockPath).isSymbolicLink()) {
            unlinkSync(lockPath);
          }
        } catch {}
      }
      if (error?.code === "EEXIST" && attempt === 0 && removeStaleStagingLock(lockPath)) continue;
      if (error?.code === "EEXIST") {
        throw new ArchiveFailure("STAGING_BUSY", "같은 Private GitHub 보관 staging을 다른 작업이 사용 중입니다.");
      }
      if (error instanceof ArchiveFailure) throw error;
      throw new ArchiveFailure("STAGING_UNSAFE", "보관 staging lock을 만들지 못했습니다.");
    }
  }
  throw new ArchiveFailure("STAGING_BUSY", "같은 Private GitHub 보관 staging을 다른 작업이 사용 중입니다.");
}

function parseNulPaths(output: string): string[] {
  const paths = output.split("\0").filter(Boolean);
  for (const path of paths) {
    if (isAbsolute(path) || path.includes("\\") || path.split("/").some(part => !part || part === "." || part === "..")) {
      throw new ArchiveFailure("STAGING_TREE_UNSAFE", "staging Git tree에 안전하지 않은 경로가 있습니다.");
    }
  }
  return paths;
}

function exactSamePaths(actual: readonly string[], expected: ReadonlySet<string>): boolean {
  return actual.length === expected.size && actual.every(path => expected.has(path));
}

function assertSafePushArgs(args: readonly string[]): void {
  const forbidden = args.some(arg => (
    arg === "--mirror"
    || arg === "--all"
    || arg === "--force"
    || arg === "-f"
    || arg.startsWith("--force=")
    || arg.startsWith("--force-with-lease")
    || arg.startsWith("+")
  ));
  if (forbidden
    || args.length !== 3
    || args[0] !== "push"
    || args[1] !== "origin"
    || args[2] !== PROJECT_MEMORY_ARCHIVE_PUSH_REFSPEC) {
    throw new ArchiveFailure("PUSH_FAILED", "허용되지 않은 Git push 형식입니다.");
  }
}

function failureResult(input: {
  repository: string | null;
  repositoryId: string | null;
  memoryNamespace: string | null;
  stagingPath: string | null;
  manifestHash: string | null;
  attemptedPush: boolean;
  error: unknown;
}): ProjectMemoryPrivateGitHubArchiveResult {
  const failure = input.error instanceof ArchiveFailure
    ? input.error
    : new ArchiveFailure("STAGING_UNSAFE", "Private GitHub 보관 staging 처리에 실패했습니다.");
  return {
    success: false,
    status: "failed",
    repository: input.repository,
    repositoryId: input.repositoryId,
    memoryNamespace: input.memoryNamespace,
    branch: PROJECT_MEMORY_ARCHIVE_BRANCH,
    stagingPath: input.stagingPath,
    commit: null,
    manifestHash: input.manifestHash,
    attemptedPush: input.attemptedPush,
    localMemoryChanged: false,
    supabaseChanged: false,
    errorCode: failure.code,
    error: failure.message,
  };
}

export async function archiveProjectMemoryToPrivateGitHub(
  input: ProjectMemoryPrivateGitHubArchiveInput,
): Promise<ProjectMemoryPrivateGitHubArchiveResult> {
  let repository: string | null = null;
  let repositoryId: string | null = null;
  let memoryNamespace: string | null = null;
  let stagingPath: string | null = null;
  let manifestHash: string | null = null;
  let attemptedPush = false;
  let lease: StagingLease | null = null;
  try {
    const target = parseRepository(input.repositoryUrl);
    if (!target) throw new ArchiveFailure("REPOSITORY_URL_INVALID", "credential 없는 GitHub 저장소 URL이 필요합니다.");
    if (input.expectedRepositoryId !== undefined
      && input.expectedRepositoryId !== null
      && !input.expectedRepositoryId.trim()) {
      throw new ArchiveFailure("INPUT_INVALID", "expectedRepositoryId는 비어 있지 않은 GitHub node ID여야 합니다.");
    }
    repository = target.slug;
    let snapshot = buildArchiveSnapshot(input, target.slug);
    memoryNamespace = snapshot.memoryNamespace;
    manifestHash = snapshot.manifestHash;
    stagingPath = prepareStaging({
      appDataDir: input.appDataDir,
      projectRoot: input.projectRoot,
      repository: target.slug,
    });
    lease = acquireStagingLease(stagingPath);
    const stage = stagingPath;

    const usesProductionRunner = input.runner === undefined;
    const runner = input.runner ?? bunPrivateGitHubArchiveCommandRunner;
    const requestedGit = input.gitCommand?.trim() || "git";
    const requestedGh = input.ghCommand?.trim() || "gh";
    const git = usesProductionRunner
      ? resolveProductionExecutable(requestedGit, "GIT_INIT_FAILED", "Git")
      : requestedGit;
    const gh = usesProductionRunner
      ? resolveProductionExecutable(requestedGh, "GH_VERIFICATION_FAILED", "gh CLI")
      : requestedGh;
    const credentialHelper = ghCredentialHelper(gh);
    const run = (command: string, args: readonly string[], timeoutMs = 30_000) => (
      runner.run(command, args, { cwd: stagingPath!, timeoutMs })
    );
    const requireGit = async (
      args: readonly string[],
      code: ProjectMemoryPrivateGitHubArchiveErrorCode,
      message: string,
      allowedExitCodes: readonly number[] = [0],
    ) => {
      const result = await run(git, args);
      if (!allowedExitCodes.includes(result.exitCode)) throw new ArchiveFailure(code, message);
      return result;
    };

    await requireGit(["init", "--initial-branch", PROJECT_MEMORY_ARCHIVE_BRANCH], "GIT_INIT_FAILED", "보관 staging Git 초기화에 실패했습니다.");
    const dotGit = join(stagingPath, ".git");
    if (!existsSync(dotGit)
      || lstatSync(dotGit).isSymbolicLink()
      || !lstatSync(dotGit).isDirectory()
      || !pathInside(stagingPath, realpathSync(dotGit))) {
      throw new ArchiveFailure("STAGING_UNSAFE", "보관 staging이 독립 Git 저장소로 초기화되지 않았습니다.");
    }
    if (existsSync(join(dotGit, "config.worktree"))) {
      throw new ArchiveFailure("STAGING_UNSAFE", "보관 staging에 별도 worktree Git config가 있습니다.");
    }
    const configuredWorktree = await requireGit(
      ["config", "--local", "--get", "core.worktree"],
      "STAGING_UNSAFE",
      "보관 staging core.worktree 설정을 확인하지 못했습니다.",
      [0, 1],
    );
    if (configuredWorktree.exitCode === 0) {
      throw new ArchiveFailure("STAGING_UNSAFE", "보관 staging core.worktree 설정은 허용되지 않습니다.");
    }
    const worktreeConfig = await requireGit(
      ["config", "--local", "--get", "extensions.worktreeConfig"],
      "STAGING_UNSAFE",
      "보관 staging worktreeConfig 설정을 확인하지 못했습니다.",
      [0, 1],
    );
    if (worktreeConfig.exitCode === 0) {
      throw new ArchiveFailure("STAGING_UNSAFE", "보관 staging extensions.worktreeConfig 설정은 허용되지 않습니다.");
    }
    const bare = await requireGit(
      ["rev-parse", "--is-bare-repository"],
      "STAGING_UNSAFE",
      "보관 staging bare 상태를 확인하지 못했습니다.",
    );
    if (bare.stdout.trim().toLowerCase() !== "false") {
      throw new ArchiveFailure("STAGING_UNSAFE", "bare Git repository는 보관 staging으로 사용할 수 없습니다.");
    }
    const topLevel = await requireGit(
      ["rev-parse", "--show-toplevel"],
      "STAGING_UNSAFE",
      "보관 staging worktree root를 확인하지 못했습니다.",
    );
    let canonicalTopLevel: string;
    try { canonicalTopLevel = realpathSync(topLevel.stdout.trim()); } catch {
      throw new ArchiveFailure("STAGING_UNSAFE", "보관 staging worktree root를 해석하지 못했습니다.");
    }
    if (canonicalTopLevel !== stagingPath) {
      throw new ArchiveFailure("STAGING_UNSAFE", "보관 staging Git worktree가 app-data 전용 폴더와 일치하지 않습니다.");
    }
    // From this point onward, no inherited or previously staged local config
    // participates in transport resolution. Rebuild the disposable repo config
    // before the first remote/checkout operation.
    writePrivateFile(stage, ".git/config", freshPrivateArchiveGitConfig());
    const disabledHooks = join(dotGit, "agentstoz-empty-hooks");
    ensurePrivateDirectory(disabledHooks);
    await requireGit(["config", "core.hooksPath", disabledHooks], "GIT_INIT_FAILED", "보관 staging hook 격리에 실패했습니다.");
    await requireGit(["config", "user.name", "AgentsToZ Memory Archive"], "GIT_INIT_FAILED", "보관 staging Git 작성자 설정에 실패했습니다.");
    await requireGit(["config", "user.email", "memory-archive@agentstoz.invalid"], "GIT_INIT_FAILED", "보관 staging Git 작성자 설정에 실패했습니다.");
    await requireGit(
      ["config", "--local", "--add", "credential.https://github.com.helper", ""],
      "GIT_INIT_FAILED",
      "보관 staging credential helper 초기화에 실패했습니다.",
    );
    await requireGit(
      ["config", "--local", "--add", "credential.https://github.com.helper", credentialHelper],
      "GIT_INIT_FAILED",
      "보관 staging gh credential helper 설정에 실패했습니다.",
    );

    const remotes = await requireGit(["remote"], "GIT_INIT_FAILED", "보관 staging remote 확인에 실패했습니다.");
    const hasOrigin = remotes.stdout.split(/\r?\n/).some(value => value.trim() === "origin");
    await requireGit(
      hasOrigin ? ["remote", "set-url", "origin", target.canonicalUrl] : ["remote", "add", "origin", target.canonicalUrl],
      "GIT_INIT_FAILED",
      "보관 staging remote 설정에 실패했습니다.",
    );
    const dangerousLocalTransport = await requireGit(
      [
        "config",
        "--local",
        "--get-regexp",
        "^(remote\\.origin\\.pushurl|url\\..*\\.(insteadof|pushinsteadof)|include(if)?\\..*path)$",
      ],
      "STAGING_UNSAFE",
      "보관 staging transport config를 확인하지 못했습니다.",
      [0, 1],
    );
    if (dangerousLocalTransport.exitCode === 0) {
      throw new ArchiveFailure("STAGING_UNSAFE", "보관 staging에 별도 push URL, URL rewrite 또는 include 설정이 있습니다.");
    }
    const fetchUrl = await requireGit(
      ["remote", "get-url", "origin"],
      "STAGING_UNSAFE",
      "보관 staging fetch URL을 확인하지 못했습니다.",
    );
    const pushUrl = await requireGit(
      ["remote", "get-url", "--push", "origin"],
      "STAGING_UNSAFE",
      "보관 staging push URL을 확인하지 못했습니다.",
    );
    if (fetchUrl.stdout.trim() !== target.canonicalUrl || pushUrl.stdout.trim() !== target.canonicalUrl) {
      throw new ArchiveFailure("STAGING_UNSAFE", "보관 staging fetch/push transport가 canonical GitHub URL과 다릅니다.");
    }

    const remoteProbe = await requireGit(
      ["ls-remote", "--exit-code", "--heads", "origin", PROJECT_MEMORY_ARCHIVE_LOCAL_REF],
      "REMOTE_INSPECTION_FAILED",
      "Private GitHub 보관 branch 확인에 실패했습니다.",
      [0, 2],
    );
    const remoteExists = remoteProbe.exitCode === 0;
    const localProbe = await requireGit(
      ["rev-parse", "--verify", PROJECT_MEMORY_ARCHIVE_LOCAL_REF],
      "GIT_INIT_FAILED",
      "보관 staging branch 확인에 실패했습니다.",
      [0, 1, 128],
    );
    const localExists = localProbe.exitCode === 0;

    if (remoteExists) {
      await requireGit(
        ["fetch", "--no-tags", "origin", `${PROJECT_MEMORY_ARCHIVE_LOCAL_REF}:${PROJECT_MEMORY_ARCHIVE_REMOTE_REF}`],
        "REMOTE_FETCH_FAILED",
        "Private GitHub 보관 branch를 안전하게 가져오지 못했습니다.",
      );
      if (localExists) {
        await requireGit(
          ["checkout", "--detach", PROJECT_MEMORY_ARCHIVE_REMOTE_REF],
          "STAGING_DIVERGED",
          "원격 보관 branch를 기준으로 disposable staging을 재구성하지 못했습니다.",
        );
        await requireGit(
          ["branch", "-f", PROJECT_MEMORY_ARCHIVE_BRANCH, PROJECT_MEMORY_ARCHIVE_REMOTE_REF],
          "STAGING_DIVERGED",
          "원격 보관 branch 기준으로 로컬 derived branch를 갱신하지 못했습니다.",
        );
        await requireGit(
          ["checkout", PROJECT_MEMORY_ARCHIVE_BRANCH],
          "STAGING_DIVERGED",
          "재구성한 보관 staging branch를 열지 못했습니다.",
        );
      } else {
        await requireGit(
          ["checkout", "-b", PROJECT_MEMORY_ARCHIVE_BRANCH, PROJECT_MEMORY_ARCHIVE_REMOTE_REF],
          "REMOTE_FETCH_FAILED",
          "원격 보관 branch에서 staging을 시작하지 못했습니다.",
        );
      }
    } else if (localExists) {
      await requireGit(["checkout", PROJECT_MEMORY_ARCHIVE_BRANCH], "STAGING_DIVERGED", "보관 staging branch를 열지 못했습니다.");
    } else {
      await requireGit(
        ["symbolic-ref", "HEAD", PROJECT_MEMORY_ARCHIVE_LOCAL_REF],
        "GIT_INIT_FAILED",
        "고정 보관 branch를 만들지 못했습니다.",
      );
    }

    const prepareCommitAndPush = async (): Promise<{ commit: string; pushed: boolean }> => {
    const trackedBefore = parseNulPaths((await requireGit(
      ["ls-files", "-z"],
      "STAGING_TREE_UNSAFE",
      "보관 staging tracked 파일을 확인하지 못했습니다.",
    )).stdout);
    const existingAllowedPaths = trackedBefore.filter(path => allowedArchiveTreePath(path) !== null);
    if (existingAllowedPaths.length > 0) {
      assertSafeCommittedTreeFiles(stage, existingAllowedPaths, target.slug);
    }

    // The caller may provide only newly validated journal entries. Preserve
    // every already-committed, independently verified entry in this namespace
    // and regenerate the bounded manifest/digest from the union.
    const namespacePrefix = `memories/${snapshot.memoryNamespace}/`;
    const mergedSourceFiles = new Map(snapshot.files);
    mergedSourceFiles.delete(`${namespacePrefix}archive-manifest.json`);
    mergedSourceFiles.delete(`${namespacePrefix}SHA256SUMS`);
    for (const tracked of trackedBefore) {
      const allowed = allowedArchiveTreePath(tracked);
      if (allowed?.namespace !== snapshot.memoryNamespace || allowed.kind !== "journal") continue;
      const existingContent = readFileSync(safeStagingPath(stage, tracked), "utf8");
      const suppliedContent = mergedSourceFiles.get(tracked);
      if (suppliedContent !== undefined && suppliedContent !== existingContent) {
        throw new ArchiveFailure("STAGING_DIVERGED", "같은 hash의 기존 journal과 새 입력 내용이 다릅니다.");
      }
      if (suppliedContent === undefined) mergedSourceFiles.set(tracked, existingContent);
    }
    snapshot = finalizeArchiveSnapshot({
      memoryId: input.memoryId,
      memoryNamespace: snapshot.memoryNamespace,
      repository: target.slug,
      sourceFiles: mergedSourceFiles,
    });
    manifestHash = snapshot.manifestHash;
    const desiredPaths = new Set(snapshot.files.keys());
    const preservedOtherMemoryPaths = new Set<string>();
    for (const tracked of trackedBefore) {
      const allowed = allowedArchiveTreePath(tracked);
      if (allowed && allowed.namespace !== snapshot.memoryNamespace) {
        preservedOtherMemoryPaths.add(tracked);
        continue;
      }
      if (!desiredPaths.has(tracked)) removeTrackedStageFile(stage, tracked);
    }
    for (const [path, content] of snapshot.files) writePrivateFile(stage, path, content);

    const expectedPaths = new Set([...desiredPaths, ...preservedOtherMemoryPaths]);
    const pathsToStage = Array.from(new Set([...trackedBefore, ...desiredPaths])).sort();
    for (let index = 0; index < pathsToStage.length; index += 100) {
      await requireGit(
        ["add", "--", ...pathsToStage.slice(index, index + 100)],
        "STAGING_TREE_UNSAFE",
        "보관 allowlist 파일 staging에 실패했습니다.",
      );
    }
    const trackedAfter = parseNulPaths((await requireGit(
      ["ls-files", "-z"],
      "STAGING_TREE_UNSAFE",
      "보관 staging tree 검증에 실패했습니다.",
    )).stdout);
    if (!exactSamePaths(trackedAfter, expectedPaths)) {
      throw new ArchiveFailure("STAGING_TREE_UNSAFE", "보관 staging tree에 allowlist 밖 파일이 있습니다.");
    }
    assertSafeCommittedTreeFiles(stage, trackedAfter, target.slug);

    const diff = await requireGit(
      ["diff", "--cached", "--quiet", "--exit-code"],
      "COMMIT_FAILED",
      "보관 staging 변경 여부 확인에 실패했습니다.",
      [0, 1],
    );
    if (diff.exitCode === 1) {
      await requireGit(
        ["-c", "commit.gpgsign=false", "commit", "-m", `chore(memory): archive ${manifestHash.slice(0, 12)}`],
        "COMMIT_FAILED",
        "Private GitHub 보관 commit 생성에 실패했습니다.",
      );
    }
    const commitResult = await requireGit(
      ["rev-parse", "--verify", "HEAD"],
      "COMMIT_FAILED",
      "Push할 보관 commit을 확인할 수 없습니다.",
    );
    const commit = commitResult.stdout.trim();
    if (!/^[0-9a-f]{7,64}$/i.test(commit)) {
      throw new ArchiveFailure("COMMIT_FAILED", "Push할 보관 commit 형식이 올바르지 않습니다.");
    }
    const committedPaths = parseNulPaths((await requireGit(
      ["ls-tree", "-r", "--name-only", "-z", "HEAD"],
      "STAGING_TREE_UNSAFE",
      "보관 commit tree를 검증하지 못했습니다.",
    )).stdout);
    if (!exactSamePaths(committedPaths, expectedPaths)) {
      throw new ArchiveFailure("STAGING_TREE_UNSAFE", "보관 commit에 allowlist 밖 파일이 있습니다.");
    }

    const prePushTransport = await requireGit(
      [
        "config",
        "--local",
        "--get-regexp",
        "^(remote\\.origin\\.pushurl|url\\..*\\.(insteadof|pushinsteadof)|include(if)?\\..*path)$",
      ],
      "STAGING_UNSAFE",
      "Push 직전 staging transport config를 확인하지 못했습니다.",
      [0, 1],
    );
    const prePushUrl = await requireGit(
      ["remote", "get-url", "--push", "origin"],
      "STAGING_UNSAFE",
      "Push 직전 staging URL을 확인하지 못했습니다.",
    );
    if (prePushTransport.exitCode === 0 || prePushUrl.stdout.trim() !== target.canonicalUrl) {
      throw new ArchiveFailure("STAGING_UNSAFE", "Push 직전 Git transport가 canonical GitHub URL과 다릅니다.");
    }

    // This check is intentionally adjacent to the push. A previous successful
    // check is not authorization for a later push after visibility or membership
    // changed.
    const targetCheck = await run(gh, [
      "repo",
      "view",
      target.slug,
      "--json",
      "id,nameWithOwner,visibility,viewerPermission",
    ]);
    if (targetCheck.exitCode !== 0) {
      throw new ArchiveFailure("GH_VERIFICATION_FAILED", "gh CLI로 Private GitHub 권한을 확인하지 못했습니다.");
    }
    let targetState: any;
    try {
      targetState = JSON.parse(targetCheck.stdout);
    } catch {
      throw new ArchiveFailure("GH_VERIFICATION_FAILED", "gh CLI 저장소 확인 결과를 해석할 수 없습니다.");
    }
    if (typeof targetState?.id !== "string" || !targetState.id.trim()
      || typeof targetState?.nameWithOwner !== "string"
      || targetState.nameWithOwner.toLowerCase() !== target.slug.toLowerCase()) {
      throw new ArchiveFailure("REPOSITORY_IDENTITY_MISMATCH", "gh CLI가 확인한 저장소 identity가 요청 대상과 다릅니다.");
    }
    const expectedRepositoryId = input.expectedRepositoryId?.trim() || repositoryId;
    if (expectedRepositoryId && targetState.id !== expectedRepositoryId) {
      throw new ArchiveFailure("REPOSITORY_IDENTITY_MISMATCH", "GitHub 저장소 node ID가 최초 연결한 Private 저장소와 다릅니다.");
    }
    repositoryId = targetState.id;
    if (targetState?.visibility !== "PRIVATE") {
      throw new ArchiveFailure("REPOSITORY_NOT_PRIVATE", "대상 GitHub 저장소가 PRIVATE이 아니어서 Push하지 않았습니다.");
    }
    if (!ALLOWED_PERMISSIONS.has(targetState?.viewerPermission)) {
      throw new ArchiveFailure("REPOSITORY_PERMISSION_DENIED", "대상 Private 저장소에 WRITE 이상의 권한이 없습니다.");
    }

    const pushArgs = ["push", "origin", PROJECT_MEMORY_ARCHIVE_PUSH_REFSPEC] as const;
    assertSafePushArgs(pushArgs);
    attemptedPush = true;
    const pushed = await run(git, pushArgs, 120_000);
    return { commit, pushed: pushed.exitCode === 0 };
    };

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const outcome = await prepareCommitAndPush();
      if (outcome.pushed) {
        return {
          success: true,
          status: "pushed",
          repository: target.slug,
          repositoryId,
          memoryNamespace: snapshot.memoryNamespace,
          branch: PROJECT_MEMORY_ARCHIVE_BRANCH,
          stagingPath,
          commit: outcome.commit,
          manifestHash,
          attemptedPush: true,
          localMemoryChanged: false,
          supabaseChanged: false,
        };
      }
      if (attempt === 1) break;

      const retryProbe = await requireGit(
        ["ls-remote", "--exit-code", "--heads", "origin", PROJECT_MEMORY_ARCHIVE_LOCAL_REF],
        "REMOTE_INSPECTION_FAILED",
        "Push 재시도 전 원격 보관 branch 확인에 실패했습니다.",
        [0, 2],
      );
      if (retryProbe.exitCode !== 0) break;
      await requireGit(
        ["fetch", "--no-tags", "origin", `${PROJECT_MEMORY_ARCHIVE_LOCAL_REF}:${PROJECT_MEMORY_ARCHIVE_REMOTE_REF}`],
        "REMOTE_FETCH_FAILED",
        "동시 Push 이후 최신 원격 보관 branch를 가져오지 못했습니다.",
      );
      await requireGit(
        ["checkout", "--detach", PROJECT_MEMORY_ARCHIVE_REMOTE_REF],
        "STAGING_DIVERGED",
        "동시 Push 이후 원격 기준 staging을 재구성하지 못했습니다.",
      );
      await requireGit(
        ["branch", "-f", PROJECT_MEMORY_ARCHIVE_BRANCH, PROJECT_MEMORY_ARCHIVE_REMOTE_REF],
        "STAGING_DIVERGED",
        "동시 Push 이후 derived branch를 원격 기준으로 갱신하지 못했습니다.",
      );
      await requireGit(
        ["checkout", PROJECT_MEMORY_ARCHIVE_BRANCH],
        "STAGING_DIVERGED",
        "동시 Push 이후 재구성한 staging branch를 열지 못했습니다.",
      );
    }
    throw new ArchiveFailure("PUSH_FAILED", "Private GitHub 보관 Push에 실패했습니다. 로컬·Supabase 기억은 그대로 유지됩니다.");
  } catch (error) {
    return failureResult({ repository, repositoryId, memoryNamespace, stagingPath, manifestHash, attemptedPush, error });
  } finally {
    lease?.release();
  }
}
