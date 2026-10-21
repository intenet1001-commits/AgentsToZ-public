import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { githubRepositoryFromRemote } from "./publicRepositoryRemote";
import {
  projectMemoryPrivateGitHubNamespace,
  type ProjectMemoryPrivateGitHubArchiveResult,
} from "./projectMemoryPrivateGitHubArchive";

const SETTINGS_VERSION = 1;
const SETTINGS_DIRECTORY = "project-memory-private-github";
const SETTINGS_FILE = "settings.json";

export interface ProjectMemoryPrivateGitHubArchiveRecord {
  projectKey: string;
  projectRoot: string;
  memoryId: string;
  repositoryUrl: string;
  /** Immutable GitHub GraphQL node ID; owner/name alone can be deleted and reused. */
  repositoryId: string;
  enabled: boolean;
  enabledAt: string;
  updatedAt: string;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastCommit: string | null;
  lastManifestHash: string | null;
  lastErrorCode: string | null;
  lastError: string | null;
}

interface ArchiveSettingsFile {
  version: typeof SETTINGS_VERSION;
  records: Record<string, ProjectMemoryPrivateGitHubArchiveRecord>;
}

export interface ProjectMemoryPrivateGitHubArchiveStatus {
  enabled: boolean;
  repositoryUrl: string | null;
  branch: "agentstoz-memory-v1";
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastCommit: string | null;
  lastManifestHash: string | null;
  lastErrorCode: string | null;
  lastError: string | null;
}

export class ProjectMemoryPrivateGitHubArchiveSettingsError extends Error {
  constructor(message: string, readonly code: "SETTINGS_UNSAFE" | "SETTINGS_INVALID" | "REPOSITORY_URL_INVALID") {
    super(message);
    this.name = "ProjectMemoryPrivateGitHubArchiveSettingsError";
  }
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalProjectRoot(projectRoot: string): string {
  const requested = resolve(projectRoot);
  if (!existsSync(requested) || lstatSync(requested).isSymbolicLink()) {
    throw new ProjectMemoryPrivateGitHubArchiveSettingsError(
      "Private GitHub 보관 프로젝트 루트는 실제 로컬 폴더여야 합니다.",
      "SETTINGS_UNSAFE",
    );
  }
  return realpathSync(requested);
}

function ensureSettingsDirectory(appDataDir: string): string {
  const root = resolve(appDataDir);
  if (existsSync(root) && (lstatSync(root).isSymbolicLink() || !lstatSync(root).isDirectory())) {
    throw new ProjectMemoryPrivateGitHubArchiveSettingsError(
      "앱 데이터 경로가 안전한 실제 폴더가 아닙니다.",
      "SETTINGS_UNSAFE",
    );
  }
  mkdirSync(root, { recursive: true });
  const directory = join(realpathSync(root), SETTINGS_DIRECTORY);
  if (existsSync(directory)) {
    const info = lstatSync(directory);
    if (info.isSymbolicLink() || !info.isDirectory() || realpathSync(directory) !== directory) {
      throw new ProjectMemoryPrivateGitHubArchiveSettingsError(
        "Private GitHub 보관 설정 경로가 안전한 실제 폴더가 아닙니다.",
        "SETTINGS_UNSAFE",
      );
    }
  } else {
    mkdirSync(directory, { mode: 0o700 });
  }
  if (process.platform !== "win32") chmodSync(directory, 0o700);
  return directory;
}

function settingsPath(appDataDir: string): string {
  return join(ensureSettingsDirectory(appDataDir), SETTINGS_FILE);
}

function emptySettings(): ArchiveSettingsFile {
  return { version: SETTINGS_VERSION, records: {} };
}

function readSettings(appDataDir: string): ArchiveSettingsFile {
  const path = settingsPath(appDataDir);
  if (!existsSync(path)) return emptySettings();
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new ProjectMemoryPrivateGitHubArchiveSettingsError(
      "Private GitHub 보관 설정 파일이 안전하지 않습니다.",
      "SETTINGS_UNSAFE",
    );
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<ArchiveSettingsFile>;
    if (parsed.version !== SETTINGS_VERSION || !parsed.records || Array.isArray(parsed.records)) throw new Error();
    return parsed as ArchiveSettingsFile;
  } catch {
    // Opt-in state is authorization to export memory. Never silently replace a
    // corrupt file with defaults and accidentally change that authorization.
    throw new ProjectMemoryPrivateGitHubArchiveSettingsError(
      "Private GitHub 보관 설정 파일을 해석하지 못했습니다.",
      "SETTINGS_INVALID",
    );
  }
}

function writeSettings(appDataDir: string, settings: ArchiveSettingsFile): void {
  const path = settingsPath(appDataDir);
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  if (existsSync(temporary)) {
    if (lstatSync(temporary).isSymbolicLink()) {
      throw new ProjectMemoryPrivateGitHubArchiveSettingsError(
        "Private GitHub 보관 임시 설정 파일이 안전하지 않습니다.",
        "SETTINGS_UNSAFE",
      );
    }
    unlinkSync(temporary);
  }
  writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  if (process.platform !== "win32") chmodSync(temporary, 0o600);
  renameSync(temporary, path);
  if (process.platform !== "win32") chmodSync(path, 0o600);
}

function projectIdentity(projectRoot: string): { projectRoot: string; projectKey: string } {
  const canonical = canonicalProjectRoot(projectRoot);
  return { projectRoot: canonical, projectKey: hash(canonical) };
}

function canonicalRepositoryUrl(repositoryUrl: string): string {
  const value = repositoryUrl.trim();
  const slug = githubRepositoryFromRemote(value);
  if (!slug || /[\r\n\0]/.test(value)) {
    throw new ProjectMemoryPrivateGitHubArchiveSettingsError(
      "credential 없는 GitHub 저장소 URL이 필요합니다.",
      "REPOSITORY_URL_INVALID",
    );
  }
  if (!/^git@github\.com:/i.test(value)) {
    try {
      const parsed = new URL(value);
      if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error();
    } catch {
      throw new ProjectMemoryPrivateGitHubArchiveSettingsError(
        "credential 없는 GitHub 저장소 URL이 필요합니다.",
        "REPOSITORY_URL_INVALID",
      );
    }
  }
  return `https://github.com/${slug}.git`;
}

function validRepositoryId(value: unknown): value is string {
  return typeof value === "string"
    && value.trim().length > 0
    && value.length <= 256
    && !/[\r\n\0]/.test(value);
}

function publicStatus(record: ProjectMemoryPrivateGitHubArchiveRecord | null): ProjectMemoryPrivateGitHubArchiveStatus {
  return {
    enabled: record?.enabled === true,
    repositoryUrl: record?.repositoryUrl ?? null,
    branch: "agentstoz-memory-v1",
    lastAttemptAt: record?.lastAttemptAt ?? null,
    lastSuccessAt: record?.lastSuccessAt ?? null,
    lastCommit: record?.lastCommit ?? null,
    lastManifestHash: record?.lastManifestHash ?? null,
    lastErrorCode: record?.lastErrorCode ?? null,
    lastError: record?.lastError ?? null,
  };
}

export function readProjectMemoryPrivateGitHubArchiveRecord(input: {
  appDataDir: string;
  projectRoot: string;
  memoryId: string;
}): ProjectMemoryPrivateGitHubArchiveRecord | null {
  const identity = projectIdentity(input.projectRoot);
  const record = readSettings(input.appDataDir).records[identity.projectKey] ?? null;
  // A moved/reinitialized folder must not inherit authorization from a previous
  // memory that happened to use the same path.
  return record?.memoryId === input.memoryId
    && record.projectRoot === identity.projectRoot
    && validRepositoryId(record.repositoryId)
    ? record
    : null;
}

export function projectMemoryPrivateGitHubArchiveStatus(input: {
  appDataDir: string;
  projectRoot: string;
  memoryId: string;
}): ProjectMemoryPrivateGitHubArchiveStatus {
  return publicStatus(readProjectMemoryPrivateGitHubArchiveRecord(input));
}

export function enableProjectMemoryPrivateGitHubArchive(input: {
  appDataDir: string;
  projectRoot: string;
  memoryId: string;
  repositoryUrl: string;
  archiveResult: ProjectMemoryPrivateGitHubArchiveResult;
  now?: string;
}): ProjectMemoryPrivateGitHubArchiveStatus {
  if (!input.archiveResult.success
    || input.archiveResult.status !== "pushed"
    || !input.archiveResult.attemptedPush
    || !input.archiveResult.commit
    || !input.archiveResult.manifestHash
    || !validRepositoryId(input.archiveResult.repositoryId)) {
    throw new ProjectMemoryPrivateGitHubArchiveSettingsError(
      "첫 Private GitHub 보관 Push가 성공한 뒤에만 자동 보관을 켤 수 있습니다.",
      "SETTINGS_INVALID",
    );
  }
  const identity = projectIdentity(input.projectRoot);
  const repositoryUrl = canonicalRepositoryUrl(input.repositoryUrl);
  const repository = githubRepositoryFromRemote(repositoryUrl);
  if (input.archiveResult.repository !== repository
    || input.archiveResult.memoryNamespace !== projectMemoryPrivateGitHubNamespace(input.memoryId)
    || input.archiveResult.branch !== "agentstoz-memory-v1") {
    throw new ProjectMemoryPrivateGitHubArchiveSettingsError(
      "첫 보관 결과가 요청한 프로젝트 기억·저장소와 일치하지 않습니다.",
      "SETTINGS_INVALID",
    );
  }
  const settings = readSettings(input.appDataDir);
  const now = input.now ?? new Date().toISOString();
  const record: ProjectMemoryPrivateGitHubArchiveRecord = {
    projectKey: identity.projectKey,
    projectRoot: identity.projectRoot,
    memoryId: input.memoryId,
    repositoryUrl,
    repositoryId: input.archiveResult.repositoryId,
    enabled: true,
    enabledAt: now,
    updatedAt: now,
    lastAttemptAt: now,
    lastSuccessAt: now,
    lastCommit: input.archiveResult.commit,
    lastManifestHash: input.archiveResult.manifestHash,
    lastErrorCode: null,
    lastError: null,
  };
  settings.records[identity.projectKey] = record;
  writeSettings(input.appDataDir, settings);
  return publicStatus(record);
}

export function disableProjectMemoryPrivateGitHubArchive(input: {
  appDataDir: string;
  projectRoot: string;
  memoryId: string;
  now?: string;
}): ProjectMemoryPrivateGitHubArchiveStatus {
  const identity = projectIdentity(input.projectRoot);
  const settings = readSettings(input.appDataDir);
  const existing = settings.records[identity.projectKey];
  if (!existing || existing.memoryId !== input.memoryId) return publicStatus(null);
  settings.records[identity.projectKey] = {
    ...existing,
    enabled: false,
    updatedAt: input.now ?? new Date().toISOString(),
  };
  writeSettings(input.appDataDir, settings);
  return publicStatus(settings.records[identity.projectKey]!);
}

export function recordProjectMemoryPrivateGitHubArchiveResult(input: {
  appDataDir: string;
  projectRoot: string;
  memoryId: string;
  result: ProjectMemoryPrivateGitHubArchiveResult;
  now?: string;
}): ProjectMemoryPrivateGitHubArchiveStatus {
  const identity = projectIdentity(input.projectRoot);
  const settings = readSettings(input.appDataDir);
  const existing = settings.records[identity.projectKey];
  if (!existing || existing.memoryId !== input.memoryId || !existing.enabled) return publicStatus(null);
  const expectedRepository = githubRepositoryFromRemote(existing.repositoryUrl);
  if (!validRepositoryId(existing.repositoryId)) return publicStatus(null);
  if (input.result.repository && input.result.repository !== expectedRepository) {
    throw new ProjectMemoryPrivateGitHubArchiveSettingsError(
      "보관 결과의 GitHub 저장소가 활성 설정과 일치하지 않습니다.",
      "SETTINGS_INVALID",
    );
  }
  if (input.result.success
    && (input.result.repository !== expectedRepository
      || input.result.repositoryId !== existing.repositoryId
      || input.result.memoryNamespace !== projectMemoryPrivateGitHubNamespace(input.memoryId)
      || input.result.branch !== "agentstoz-memory-v1"
      || !input.result.commit
      || !input.result.manifestHash)) {
    throw new ProjectMemoryPrivateGitHubArchiveSettingsError(
      "성공으로 보고된 보관 결과가 활성 프로젝트 기억·저장소와 일치하지 않습니다.",
      "SETTINGS_INVALID",
    );
  }
  const now = input.now ?? new Date().toISOString();
  settings.records[identity.projectKey] = {
    ...existing,
    updatedAt: now,
    lastAttemptAt: now,
    lastSuccessAt: input.result.success ? now : existing.lastSuccessAt,
    lastCommit: input.result.success ? input.result.commit : existing.lastCommit,
    lastManifestHash: input.result.success ? input.result.manifestHash : existing.lastManifestHash,
    lastErrorCode: input.result.success ? null : input.result.errorCode ?? "ARCHIVE_FAILED",
    lastError: input.result.success ? null : (input.result.error ?? "Private GitHub 보관에 실패했습니다.").slice(0, 600),
  };
  writeSettings(input.appDataDir, settings);
  return publicStatus(settings.records[identity.projectKey]!);
}
