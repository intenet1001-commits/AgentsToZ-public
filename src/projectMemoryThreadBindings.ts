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
  boundAt: string;
  updatedAt: string;
}

interface ProjectMemoryThreadBindingRegistry {
  version: 1;
  bindings: Record<string, ProjectMemoryThreadBinding>;
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
    && (row.threadId === null || row.threadId === undefined || typeof row.threadId === "string");
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
  input: ProjectMemoryThreadRoute & Pick<ProjectMemoryThreadBinding, "projectId" | "projectName" | "memoryId" | "canonicalPath">,
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
    const binding: ProjectMemoryThreadBinding = {
      ...route,
      projectId,
      projectName,
      memoryId,
      canonicalPath,
      boundAt: previous?.boundAt ?? now,
      updatedAt: now,
    };
    registry.bindings[key] = binding;
    atomicWriteRegistry(file, registry);
    return binding;
  });
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
