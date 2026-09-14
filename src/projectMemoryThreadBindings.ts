import {
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  closeSync,
} from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export interface ProjectMemoryThreadRoute {
  platform: string;
  chatId: string;
  threadId?: string | null;
}

export interface ProjectMemoryThreadBinding extends ProjectMemoryThreadRoute {
  projectId: string;
  projectName: string;
  memoryId: string;
  canonicalPath: string;
  threadName?: string | null;
  verifiedAt?: string | null;
  boundAt: string;
  updatedAt: string;
}

interface ProjectMemoryThreadBindingRegistry {
  version: 1;
  bindings: Record<string, ProjectMemoryThreadBinding>;
}

export class ProjectMemoryThreadBindingConflictError extends Error {
  readonly code = "PROJECT_MEMORY_THREAD_ROUTE_CONFLICT";

  constructor() {
    super("This chat/thread route is already bound to another project memory.");
    this.name = "ProjectMemoryThreadBindingConflictError";
  }
}

function required(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  return value.trim();
}

function normalizedRoute(route: ProjectMemoryThreadRoute): Required<ProjectMemoryThreadRoute> {
  return {
    platform: required(route.platform, "platform").toLocaleLowerCase(),
    chatId: required(route.chatId, "chatId"),
    threadId: typeof route.threadId === "string" && route.threadId.trim() ? route.threadId.trim() : null,
  };
}

export function projectMemoryThreadBindingKey(route: ProjectMemoryThreadRoute): string {
  const normalized = normalizedRoute(route);
  return `${normalized.platform}:${normalized.chatId}:${normalized.threadId ?? "root"}`;
}

function emptyRegistry(): ProjectMemoryThreadBindingRegistry {
  return { version: 1, bindings: {} };
}

function validBinding(value: unknown): value is ProjectMemoryThreadBinding {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return ["platform", "chatId", "projectId", "projectName", "memoryId", "canonicalPath", "boundAt", "updatedAt"]
    .every(field => typeof row[field] === "string" && !!String(row[field]).trim())
    && (row.threadId === null || row.threadId === undefined || typeof row.threadId === "string")
    && (row.threadName === null || row.threadName === undefined || typeof row.threadName === "string")
    && (row.verifiedAt === null || row.verifiedAt === undefined || typeof row.verifiedAt === "string");
}

function readRegistry(file: string): ProjectMemoryThreadBindingRegistry {
  if (!existsSync(file)) return emptyRegistry();
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    if (parsed.version !== 1 || !parsed.bindings || typeof parsed.bindings !== "object") return emptyRegistry();
    const bindings: Record<string, ProjectMemoryThreadBinding> = {};
    for (const [key, value] of Object.entries(parsed.bindings as Record<string, unknown>)) {
      if (!validBinding(value)) continue;
      try {
        if (projectMemoryThreadBindingKey(value) === key) bindings[key] = value;
      } catch {
        // Ignore malformed historical rows without discarding valid bindings.
      }
    }
    return { version: 1, bindings };
  } catch (error: any) {
    throw new Error(`프로젝트 장기기억 스레드 매핑 파일이 손상되었습니다: ${error?.message ?? String(error)}`);
  }
}

async function withRegistryLock<T>(file: string, operation: () => T | Promise<T>): Promise<T> {
  mkdirSync(dirname(file), { recursive: true });
  const lock = `${file}.lock`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const fd = openSync(lock, "wx", 0o600);
      try {
        return await operation();
      } finally {
        closeSync(fd);
        rmSync(lock, { force: true });
      }
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  throw new Error("project-memory thread binding lock timeout");
}

function atomicWriteRegistry(file: string, registry: ProjectMemoryThreadBindingRegistry): void {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(registry, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    if (existsSync(file)) copyFileSync(file, `${file}.bak`);
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export async function getProjectMemoryThreadBinding(
  file: string,
  route: ProjectMemoryThreadRoute,
): Promise<ProjectMemoryThreadBinding | null> {
  return readRegistry(file).bindings[projectMemoryThreadBindingKey(route)] ?? null;
}

export async function bindProjectMemoryThread(
  file: string,
  input: ProjectMemoryThreadRoute
    & Pick<ProjectMemoryThreadBinding, "projectId" | "projectName" | "memoryId" | "canonicalPath">
    & Partial<Pick<ProjectMemoryThreadBinding, "threadName" | "verifiedAt">>,
): Promise<ProjectMemoryThreadBinding> {
  const route = normalizedRoute(input);
  const projectId = required(input.projectId, "projectId");
  const projectName = required(input.projectName, "projectName");
  const memoryId = required(input.memoryId, "memoryId");
  const canonicalPath = required(input.canonicalPath, "canonicalPath");
  const key = projectMemoryThreadBindingKey(route);
  return withRegistryLock(file, () => {
    const registry = readRegistry(file);
    const previous = registry.bindings[key];
    const now = new Date().toISOString();
    const threadName = input.threadName === undefined
      ? previous?.threadName
      : typeof input.threadName === "string" && input.threadName.trim()
        ? input.threadName.trim()
        : null;
    const verifiedAt = input.verifiedAt === undefined
      ? previous?.verifiedAt
      : typeof input.verifiedAt === "string" && input.verifiedAt.trim()
        ? input.verifiedAt.trim()
        : null;
    const binding: ProjectMemoryThreadBinding = {
      ...route,
      projectId,
      projectName,
      memoryId,
      canonicalPath,
      ...(threadName !== undefined ? { threadName } : {}),
      ...(verifiedAt !== undefined ? { verifiedAt } : {}),
      boundAt: previous?.boundAt ?? now,
      updatedAt: now,
    };
    registry.bindings[key] = binding;
    atomicWriteRegistry(file, registry);
    return binding;
  });
}

/**
 * Bind a route while enforcing one active route for one project memory on the
 * selected platform. Route ownership validation, stale-route cleanup, and the
 * new write happen under the same registry lock.
 */
export async function bindExclusiveProjectMemoryThread(
  file: string,
  input: ProjectMemoryThreadRoute
    & Pick<ProjectMemoryThreadBinding, "projectId" | "projectName" | "memoryId" | "canonicalPath">
    & Partial<Pick<ProjectMemoryThreadBinding, "threadName" | "verifiedAt">>,
): Promise<ProjectMemoryThreadBinding> {
  const route = normalizedRoute(input);
  const projectId = required(input.projectId, "projectId");
  const projectName = required(input.projectName, "projectName");
  const memoryId = required(input.memoryId, "memoryId");
  const canonicalPath = required(input.canonicalPath, "canonicalPath");
  const key = projectMemoryThreadBindingKey(route);
  return withRegistryLock(file, () => {
    const registry = readRegistry(file);
    const previous = registry.bindings[key];
    if (previous && (previous.projectId !== projectId
      || previous.memoryId !== memoryId
      || previous.canonicalPath !== canonicalPath)) {
      throw new ProjectMemoryThreadBindingConflictError();
    }

    for (const [candidateKey, candidate] of Object.entries(registry.bindings)) {
      if (candidateKey === key) continue;
      if (candidate.platform.toLocaleLowerCase() === route.platform
        && candidate.memoryId === memoryId
        && candidate.canonicalPath === canonicalPath) {
        delete registry.bindings[candidateKey];
      }
    }

    const now = new Date().toISOString();
    const threadName = input.threadName === undefined
      ? previous?.threadName
      : typeof input.threadName === "string" && input.threadName.trim()
        ? input.threadName.trim()
        : null;
    const verifiedAt = input.verifiedAt === undefined
      ? previous?.verifiedAt
      : typeof input.verifiedAt === "string" && input.verifiedAt.trim()
        ? input.verifiedAt.trim()
        : null;
    const binding: ProjectMemoryThreadBinding = {
      ...route,
      projectId,
      projectName,
      memoryId,
      canonicalPath,
      ...(threadName !== undefined ? { threadName } : {}),
      ...(verifiedAt !== undefined ? { verifiedAt } : {}),
      boundAt: previous?.boundAt ?? now,
      updatedAt: now,
    };
    registry.bindings[key] = binding;
    atomicWriteRegistry(file, registry);
    return binding;
  });
}

export async function findProjectMemoryThreadBindings(
  file: string,
  filter: {
    platform?: string;
    projectId?: string;
    memoryId?: string;
  } = {},
): Promise<ProjectMemoryThreadBinding[]> {
  const platform = typeof filter.platform === "string" && filter.platform.trim()
    ? filter.platform.trim().toLocaleLowerCase()
    : null;
  const projectId = typeof filter.projectId === "string" && filter.projectId.trim()
    ? filter.projectId.trim()
    : null;
  const memoryId = typeof filter.memoryId === "string" && filter.memoryId.trim()
    ? filter.memoryId.trim()
    : null;
  return Object.values(readRegistry(file).bindings)
    .filter(binding => (!platform || binding.platform.toLocaleLowerCase() === platform)
      && (!projectId || binding.projectId === projectId)
      && (!memoryId || binding.memoryId === memoryId))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export async function unbindProjectMemoryThread(
  file: string,
  route: ProjectMemoryThreadRoute,
): Promise<boolean> {
  const key = projectMemoryThreadBindingKey(route);
  return withRegistryLock(file, () => {
    const registry = readRegistry(file);
    if (!registry.bindings[key]) return false;
    delete registry.bindings[key];
    atomicWriteRegistry(file, registry);
    return true;
  });
}

export async function unbindProjectMemoryThreads(
  file: string,
  filter: {
    platform: string;
    projectId: string;
    memoryId: string;
    canonicalPath: string;
  },
): Promise<number> {
  const platform = required(filter.platform, "platform").toLocaleLowerCase();
  const projectId = required(filter.projectId, "projectId");
  const memoryId = required(filter.memoryId, "memoryId");
  const canonicalPath = required(filter.canonicalPath, "canonicalPath");
  return withRegistryLock(file, () => {
    const registry = readRegistry(file);
    let removed = 0;
    for (const [key, binding] of Object.entries(registry.bindings)) {
      if (binding.platform.toLocaleLowerCase() === platform
        && binding.projectId === projectId
        && binding.memoryId === memoryId
        && binding.canonicalPath === canonicalPath) {
        delete registry.bindings[key];
        removed += 1;
      }
    }
    if (removed > 0) atomicWriteRegistry(file, registry);
    return removed;
  });
}
