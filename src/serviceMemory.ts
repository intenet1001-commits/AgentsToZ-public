import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

const SERVICE_MEMORY_VERSION = 1 as const;
const SERVICE_MEMORY_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SERVICE_KEY_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
// Private UUID namespace for AgentsToZ USE memories. A deterministic v5 UUID
// keeps the same DEV-memory/service persona identity across local devices even
// while the current CORE.md contents remain local-only.
const SERVICE_MEMORY_NAMESPACE = "3b44757f-690a-5b89-b933-63d36844e21d";

export type ServiceMemoryErrorCode =
  | "SERVICE_MEMORY_INPUT_INVALID"
  | "SERVICE_MEMORY_IDENTITY_MISMATCH"
  | "SERVICE_MEMORY_REGISTRY_CORRUPT"
  | "SERVICE_MEMORY_FILES_INVALID"
  | "SERVICE_MEMORY_BUSY";

export class ServiceMemoryError extends Error {
  constructor(
    message: string,
    readonly code: ServiceMemoryErrorCode,
  ) {
    super(message);
    this.name = "ServiceMemoryError";
  }
}

type StoredServiceMemoryRecord = {
  version: 1;
  role: "use";
  serviceMemoryId: string;
  serviceKey: string;
  displayName: string;
  linkedProjectId: string;
  linkedProjectName: string;
  linkedProjectMemoryId: string;
  linkedCanonicalPath: string;
  createdAt: string;
  updatedAt: string;
};

export type ServiceMemoryRecord = StoredServiceMemoryRecord & {
  sourcePath: string;
  configPath: string;
};

type ServiceMemoryRegistry = {
  version: 1;
  memories: Record<string, StoredServiceMemoryRecord>;
};

type ServiceMemoryConfig = StoredServiceMemoryRecord & {
  sourcePath: "CORE.md";
  authority: "local-app-data";
  surfacePolicy: "shared-across-buzz-hermes-telegram";
};

export type ServiceMemoryInspection =
  | { exists: false; ready: false; record: null; problem: null }
  | { exists: true; ready: boolean; record: ServiceMemoryRecord; problem: string | null };

export type ServiceMemoryIdentity = {
  projectId: unknown;
  projectMemoryId?: unknown;
  serviceKey?: unknown;
};

export type EnsureServiceMemoryInput = {
  projectId: unknown;
  projectName: unknown;
  projectMemoryId: unknown;
  canonicalPath: unknown;
  serviceKey?: unknown;
  displayName: unknown;
};

function requiredLine(value: unknown, label: string, maxLength = 512): string {
  const normalized = typeof value === "string"
    ? value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim()
    : "";
  if (!normalized || Array.from(normalized).length > maxLength) {
    throw new ServiceMemoryError(`${label} 값이 올바르지 않습니다.`, "SERVICE_MEMORY_INPUT_INVALID");
  }
  return normalized;
}

function requiredIdentity(value: unknown, label: string, maxLength = 4096): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || /[\u0000-\u001f\u007f]/.test(normalized) || Array.from(normalized).length > maxLength) {
    throw new ServiceMemoryError(`${label} 값이 올바르지 않습니다.`, "SERVICE_MEMORY_INPUT_INVALID");
  }
  return normalized;
}

function normalizeServiceKey(value: unknown): string {
  const normalized = typeof value === "string" && value.trim()
    ? value.trim().toLowerCase()
    : "default";
  if (!SERVICE_KEY_RE.test(normalized)) {
    throw new ServiceMemoryError(
      "서비스 키는 영문 소문자·숫자로 시작하고 영문 소문자·숫자·밑줄·하이픈만 사용할 수 있습니다.",
      "SERVICE_MEMORY_INPUT_INVALID",
    );
  }
  return normalized;
}

function registryPath(appDataDir: string): string {
  return join(appDataDir, "service-memories", "registry.json");
}

function registryKey(projectMemoryId: string, serviceKey: string): string {
  return `${projectMemoryId}\u0000${serviceKey}`;
}

function namespaceBytes(uuid: string): Uint8Array {
  return Uint8Array.from(Buffer.from(uuid.replace(/-/g, ""), "hex"));
}

function deterministicServiceMemoryId(projectMemoryId: string, serviceKey: string): string {
  const digest = createHash("sha1")
    .update(namespaceBytes(SERVICE_MEMORY_NAMESPACE))
    .update(`${projectMemoryId}\u0000${serviceKey}`, "utf8")
    .digest()
    .subarray(0, 16);
  digest[6] = (digest[6]! & 0x0f) | 0x50;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = digest.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function emptyRegistry(): ServiceMemoryRegistry {
  return { version: SERVICE_MEMORY_VERSION, memories: {} };
}

function isStoredRecord(value: unknown): value is StoredServiceMemoryRecord {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return row.version === SERVICE_MEMORY_VERSION
    && row.role === "use"
    && typeof row.serviceMemoryId === "string"
    && SERVICE_MEMORY_ID_RE.test(row.serviceMemoryId)
    && typeof row.serviceKey === "string"
    && SERVICE_KEY_RE.test(row.serviceKey)
    && [
      "displayName",
      "linkedProjectId",
      "linkedProjectName",
      "linkedProjectMemoryId",
      "linkedCanonicalPath",
      "createdAt",
      "updatedAt",
    ].every(field => typeof row[field] === "string" && !!String(row[field]).trim());
}

function readRegistry(file: string): ServiceMemoryRegistry {
  if (!existsSync(file)) return emptyRegistry();
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    if (parsed.version !== SERVICE_MEMORY_VERSION || !parsed.memories || typeof parsed.memories !== "object") {
      throw new Error("unsupported registry schema");
    }
    const memories: Record<string, StoredServiceMemoryRecord> = {};
    for (const [key, candidate] of Object.entries(parsed.memories as Record<string, unknown>)) {
      if (!isStoredRecord(candidate) || registryKey(candidate.linkedProjectMemoryId, candidate.serviceKey) !== key) {
        throw new Error(`invalid service memory record: ${key}`);
      }
      memories[key] = candidate;
    }
    return { version: SERVICE_MEMORY_VERSION, memories };
  } catch (error) {
    if (error instanceof ServiceMemoryError) throw error;
    throw new ServiceMemoryError(
      `USE 운영기억 등록 파일이 손상되었습니다: ${error instanceof Error ? error.message : String(error)}`,
      "SERVICE_MEMORY_REGISTRY_CORRUPT",
    );
  }
}

function withRegistryLock<T>(file: string, operation: () => T): T {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const lock = `${file}.lock`;
  let descriptor: number | null = null;
  for (let attempt = 0; attempt < 2 && descriptor === null; attempt += 1) {
    try {
      descriptor = openSync(lock, "wx", 0o600);
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
      // A killed sidecar must not leave USE memory permanently locked. The
      // operation is synchronous and normally lasts milliseconds, so only a
      // clearly stale lock is recoverable; a fresh lock still fails closed.
      try {
        if (attempt === 0 && Date.now() - lstatSync(lock).mtimeMs > 30_000) {
          rmSync(lock, { force: true });
          continue;
        }
      } catch (lockError: any) {
        if (attempt === 0 && lockError?.code === "ENOENT") continue;
      }
      throw new ServiceMemoryError(
        "다른 요청이 USE 운영기억을 갱신하고 있습니다. 잠시 후 다시 시도하세요.",
        "SERVICE_MEMORY_BUSY",
      );
    }
  }
  if (descriptor === null) throw new ServiceMemoryError("USE 운영기억 잠금을 만들지 못했습니다.", "SERVICE_MEMORY_BUSY");
  try {
    return operation();
  } finally {
    closeSync(descriptor);
    rmSync(lock, { force: true });
  }
}

function atomicWrite(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, file);
    chmodSync(file, 0o600);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function expandRecord(appDataDir: string, record: StoredServiceMemoryRecord): ServiceMemoryRecord {
  const directory = join(appDataDir, "service-memories", record.serviceMemoryId);
  return {
    ...record,
    sourcePath: join(directory, "CORE.md"),
    configPath: join(directory, "config.json"),
  };
}

function configFor(record: StoredServiceMemoryRecord): ServiceMemoryConfig {
  return {
    ...record,
    sourcePath: "CORE.md",
    authority: "local-app-data",
    surfacePolicy: "shared-across-buzz-hermes-telegram",
  };
}

function serviceMemoryTemplate(record: StoredServiceMemoryRecord): string {
  return [
    `# ${record.displayName} · USE service memory`,
    "",
    "Role: USE",
    `Service memory ID: ${record.serviceMemoryId}`,
    `Service key: ${record.serviceKey}`,
    `Linked DEV project: ${record.linkedProjectName}`,
    `Linked DEV project memory ID: ${record.linkedProjectMemoryId}`,
    `Linked DEV project path (read-only): ${record.linkedCanonicalPath}`,
    "",
    "## Durable operating knowledge",
    "",
    "Keep validated user-facing behavior, safe operating procedures, stable preferences, and reusable answers here.",
    "Do not store raw transcripts, authentication secrets, private keys, or unnecessary personal data.",
    "Do not edit source files, Git state, deployment configuration, or the linked DEV project memory from USE mode.",
    "",
    "## DEV handoff queue",
    "",
    "When product work is needed, add a compact DEV_HANDOFF with summary, reproduction, expected behavior, actual behavior, impact, evidence, and acceptance criteria.",
    "Do not copy a full conversation when a minimal structured handoff is sufficient.",
    "",
  ].join("\n");
}

function validateFiles(appDataDir: string, stored: StoredServiceMemoryRecord): ServiceMemoryInspection {
  const record = expandRecord(appDataDir, stored);
  let regularFiles = false;
  try {
    const configStat = lstatSync(record.configPath);
    const sourceStat = lstatSync(record.sourcePath);
    regularFiles = configStat.isFile() && !configStat.isSymbolicLink()
      && sourceStat.isFile() && !sourceStat.isSymbolicLink();
  } catch {
    regularFiles = false;
  }
  if (!regularFiles) {
    return {
      exists: true,
      ready: false,
      record,
      problem: "USE 운영기억 파일이 일부 누락되었습니다. 자동 재생성하지 않고 복구가 필요합니다.",
    };
  }
  try {
    const config = JSON.parse(readFileSync(record.configPath, "utf8")) as Record<string, unknown>;
    const matches = config.version === SERVICE_MEMORY_VERSION
      && config.role === "use"
      && config.serviceMemoryId === stored.serviceMemoryId
      && config.serviceKey === stored.serviceKey
      && config.linkedProjectId === stored.linkedProjectId
      && config.linkedProjectMemoryId === stored.linkedProjectMemoryId
      && config.linkedCanonicalPath === stored.linkedCanonicalPath
      && config.sourcePath === "CORE.md";
    if (!matches) throw new Error("config identity mismatch");
    return { exists: true, ready: true, record, problem: null };
  } catch (error) {
    return {
      exists: true,
      ready: false,
      record,
      problem: `USE 운영기억 설정을 검증하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export function inspectServiceMemory(
  appDataDir: string,
  identity: ServiceMemoryIdentity,
): ServiceMemoryInspection {
  const projectId = requiredIdentity(identity.projectId, "프로젝트 ID");
  const projectMemoryId = identity.projectMemoryId === undefined
    ? null
    : requiredIdentity(identity.projectMemoryId, "DEV 프로젝트 기억 ID", 128);
  const serviceKey = normalizeServiceKey(identity.serviceKey);
  const registry = readRegistry(registryPath(appDataDir));
  const stored = projectMemoryId
    ? registry.memories[registryKey(projectMemoryId, serviceKey)]
    : Object.values(registry.memories).find(candidate => (
      candidate.linkedProjectId === projectId && candidate.serviceKey === serviceKey
    ));
  return stored
    ? validateFiles(appDataDir, stored)
    : { exists: false, ready: false, record: null, problem: null };
}

export function ensureServiceMemory(
  appDataDir: string,
  input: EnsureServiceMemoryInput,
): { created: boolean; record: ServiceMemoryRecord } {
  const projectId = requiredIdentity(input.projectId, "프로젝트 ID");
  const projectName = requiredLine(input.projectName, "프로젝트 이름", 256);
  const projectMemoryId = requiredIdentity(input.projectMemoryId, "DEV 프로젝트 기억 ID", 128);
  const canonicalPath = requiredIdentity(input.canonicalPath, "DEV 프로젝트 경로", 4096);
  const serviceKey = normalizeServiceKey(input.serviceKey);
  const displayName = requiredLine(input.displayName, "서비스 이름", 64);
  const file = registryPath(appDataDir);

  return withRegistryLock(file, () => {
    const registry = readRegistry(file);
    const key = registryKey(projectMemoryId, serviceKey);
    const previous = registry.memories[key];
    const localProjectConflict = Object.values(registry.memories).find(candidate => (
      candidate.linkedProjectId === projectId
      && candidate.serviceKey === serviceKey
      && candidate.linkedProjectMemoryId !== projectMemoryId
    ));
    if (localProjectConflict) {
      throw new ServiceMemoryError(
        "같은 로컬 프로젝트와 서비스 키가 다른 DEV 프로젝트 기억을 가리킵니다. 기존 계보를 자동 변경하지 않습니다.",
        "SERVICE_MEMORY_IDENTITY_MISMATCH",
      );
    }

    if (previous) {
      if (previous.linkedProjectMemoryId !== projectMemoryId
        || previous.linkedCanonicalPath !== canonicalPath) {
        throw new ServiceMemoryError(
          "같은 서비스 키가 다른 DEV 프로젝트 기억 또는 경로를 가리킵니다. 기존 계보를 자동 변경하지 않습니다.",
          "SERVICE_MEMORY_IDENTITY_MISMATCH",
        );
      }
      const inspection = validateFiles(appDataDir, previous);
      if (!inspection.ready) {
        throw new ServiceMemoryError(
          inspection.problem ?? "USE 운영기억 파일을 검증하지 못했습니다.",
          "SERVICE_MEMORY_FILES_INVALID",
        );
      }
      const updated: StoredServiceMemoryRecord = {
        ...previous,
        displayName,
        linkedProjectId: projectId,
        linkedProjectName: projectName,
        updatedAt: new Date().toISOString(),
      };
      atomicWrite(inspection.record.configPath, `${JSON.stringify(configFor(updated), null, 2)}\n`);
      registry.memories[key] = updated;
      atomicWrite(file, `${JSON.stringify(registry, null, 2)}\n`);
      return { created: false, record: expandRecord(appDataDir, updated) };
    }

    const now = new Date().toISOString();
    const created: StoredServiceMemoryRecord = {
      version: SERVICE_MEMORY_VERSION,
      role: "use",
      serviceMemoryId: deterministicServiceMemoryId(projectMemoryId, serviceKey),
      serviceKey,
      displayName,
      linkedProjectId: projectId,
      linkedProjectName: projectName,
      linkedProjectMemoryId: projectMemoryId,
      linkedCanonicalPath: canonicalPath,
      createdAt: now,
      updatedAt: now,
    };
    const expanded = expandRecord(appDataDir, created);
    const memoryDirectory = dirname(expanded.sourcePath);
    if (existsSync(memoryDirectory)) {
      throw new ServiceMemoryError(
        "등록되지 않은 USE 운영기억 폴더가 이미 있습니다. 기존 내용을 자동 덮어쓰거나 삭제하지 않고 복구가 필요합니다.",
        "SERVICE_MEMORY_FILES_INVALID",
      );
    }
    let createdDirectory = false;
    try {
      mkdirSync(memoryDirectory, { mode: 0o700 });
      createdDirectory = true;
      atomicWrite(expanded.sourcePath, serviceMemoryTemplate(created));
      atomicWrite(expanded.configPath, `${JSON.stringify(configFor(created), null, 2)}\n`);
      registry.memories[key] = created;
      atomicWrite(file, `${JSON.stringify(registry, null, 2)}\n`);
      return { created: true, record: expanded };
    } catch (error) {
      if (createdDirectory) rmSync(memoryDirectory, { recursive: true, force: true });
      throw error;
    }
  });
}
