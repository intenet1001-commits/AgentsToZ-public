import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, isAbsolute } from "node:path";

export class ProjectWorkerLockRegistry {
  private readonly locks = new Map<string, string>();

  private key(canonicalPath: string, memoryId: string): string {
    return `${canonicalPath}\u0000${memoryId}`;
  }

  acquire(canonicalPath: string, memoryId: string, requestId: string): { ok: true } | { ok: false; requestId: string } {
    const key = this.key(canonicalPath, memoryId);
    const current = this.locks.get(key);
    if (current && current !== requestId) return { ok: false, requestId: current };
    this.locks.set(key, requestId);
    return { ok: true };
  }

  release(canonicalPath: string, memoryId: string, requestId: string): boolean {
    const key = this.key(canonicalPath, memoryId);
    if (this.locks.get(key) !== requestId) return false;
    this.locks.delete(key);
    return true;
  }
}
export type AgentsToZProjectWorkerEvidence =
  | { ok: true; canonicalPath: string; memoryId: string; memoryConfigHash: string; gitHead: string; gitDirty: boolean }
  | { ok: false; code: "PATH_INVALID" | "MEMORY_UNREADABLE" | "GIT_READBACK_FAILED"; error: string };

export function readAgentsToZProjectWorkerEvidence(canonicalPath: string): AgentsToZProjectWorkerEvidence {
  if (!canonicalPath || !isAbsolute(canonicalPath) || !existsSync(canonicalPath)) {
    return { ok: false, code: "PATH_INVALID", error: "canonical project path가 유효하지 않습니다." };
  }
  try {
    const configPath = join(canonicalPath, ".agent-memory", "config.json");
    const configBytes = readFileSync(configPath);
    const config = JSON.parse(configBytes.toString("utf8"));
    const memoryId = typeof config?.memoryId === "string" ? config.memoryId.trim() : "";
    if (!memoryId) return { ok: false, code: "MEMORY_UNREADABLE", error: "project memory_id를 읽을 수 없습니다." };
    const gitHead = execFileSync("git", ["-C", canonicalPath, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const porcelain = execFileSync("git", ["-C", canonicalPath, "status", "--porcelain"], { encoding: "utf8" });
    if (!/^[0-9a-f]{40}$/.test(gitHead)) throw new Error("invalid HEAD");
    return {
      ok: true,
      canonicalPath,
      memoryId,
      memoryConfigHash: createHash("sha256").update(configBytes).digest("hex"),
      gitHead,
      gitDirty: porcelain.length > 0,
    };
  } catch {
    return { ok: false, code: "GIT_READBACK_FAILED", error: "worker 종료 후 memory/Git readback에 실패했습니다." };
  }
}
export type AgentsToZProjectBinding =
  | { ok: true; canonicalPath: string; memoryId: string; gitRemote: string | null }
  | { ok: false; code: "PATH_INVALID" | "MEMORY_ID_MISMATCH" | "GIT_ROOT_MISMATCH" | "GIT_REMOTE_MISMATCH"; error: string };

export function verifyAgentsToZProjectBinding(input: {
  canonicalPath?: unknown;
  memoryId?: unknown;
  gitRemote?: unknown;
}): AgentsToZProjectBinding {
  const path = typeof input.canonicalPath === "string" ? input.canonicalPath.trim() : "";
  const expectedMemoryId = typeof input.memoryId === "string" ? input.memoryId.trim() : "";
  if (!path || !isAbsolute(path) || !existsSync(path)) {
    return { ok: false, code: "PATH_INVALID", error: "canonical project path가 유효하지 않습니다." };
  }
  let canonicalPath: string;
  try {
    const resolvedPath = realpathSync(path);
    const normalizedResolvedPath = process.platform === "darwin" && resolvedPath.startsWith("/private/")
      ? resolvedPath.slice("/private".length)
      : resolvedPath;
    if (!statSync(path).isDirectory() || normalizedResolvedPath !== path) {
      return { ok: false, code: "PATH_INVALID", error: "canonical project path가 realpath와 일치하지 않습니다." };
    }
    canonicalPath = path;
  } catch {
    return { ok: false, code: "PATH_INVALID", error: "canonical project path를 확인할 수 없습니다." };
  }
  let memoryId = "";
  try {
    const config = JSON.parse(readFileSync(join(canonicalPath, ".agent-memory", "config.json"), "utf8"));
    memoryId = typeof config?.memoryId === "string" ? config.memoryId.trim() : "";
  } catch {
    // handled as an identity mismatch below
  }
  if (!expectedMemoryId || memoryId !== expectedMemoryId) {
    return { ok: false, code: "MEMORY_ID_MISMATCH", error: "project memory identity가 일치하지 않습니다." };
  }
  try {
    const gitRootRaw = execFileSync("git", ["-C", canonicalPath, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
    const gitRoot = process.platform === "darwin" && gitRootRaw.startsWith("/private/")
      ? gitRootRaw.slice("/private".length)
      : gitRootRaw;
    if (gitRoot !== canonicalPath) {
      return { ok: false, code: "GIT_ROOT_MISMATCH", error: "Git root가 canonical project path와 일치하지 않습니다." };
    }
  } catch {
    return { ok: false, code: "GIT_ROOT_MISMATCH", error: "canonical project의 Git root를 확인할 수 없습니다." };
  }
  let gitRemote: string | null = null;
  try {
    gitRemote = execFileSync("git", ["-C", canonicalPath, "remote", "get-url", "origin"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim() || null;
  } catch {
    gitRemote = null;
  }
  const expectedRemote = typeof input.gitRemote === "string" ? input.gitRemote.trim() : "";
  if (expectedRemote && gitRemote !== expectedRemote) {
    return { ok: false, code: "GIT_REMOTE_MISMATCH", error: "Git remote identity가 일치하지 않습니다." };
  }
  return { ok: true, canonicalPath, memoryId, gitRemote };
}
export type AgentsToZProjectCommitResult =
  | { ok: true; commitSha: string; stagedPaths: string[] }
  | { ok: false; code: "APPROVAL_REQUIRED" | "PATH_INVALID" | "COMMIT_PATH_INVALID" | "COMMIT_FAILED"; error?: string };

export function commitApprovedAgentsToZProject(input: {
  canonicalPath?: unknown;
  approved?: unknown;
  message?: unknown;
  paths?: unknown;
}): AgentsToZProjectCommitResult {
  if (input.approved !== true) return { ok: false, code: "APPROVAL_REQUIRED" };
  const path = typeof input.canonicalPath === "string" ? input.canonicalPath.trim() : "";
  const message = typeof input.message === "string" ? input.message.trim() : "";
  const paths = Array.isArray(input.paths) ? input.paths.filter((item): item is string => typeof item === "string") : [];
  if (!path || !isAbsolute(path) || !existsSync(path)) return { ok: false, code: "PATH_INVALID" };
  if (!message || message.length > 200 || !paths.length || paths.some((item) => !item || isAbsolute(item) || item === "." || item === ".." || item.startsWith("../") || item.includes("/../"))) {
    return { ok: false, code: "COMMIT_PATH_INVALID" };
  }
  try {
    const resolved = realpathSync(path);
    const normalized = process.platform === "darwin" && resolved.startsWith("/private/") ? resolved.slice("/private".length) : resolved;
    if (!statSync(path).isDirectory() || normalized !== path) return { ok: false, code: "PATH_INVALID" };
    const gitRootRaw = execFileSync("git", ["-C", path, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
    const gitRoot = process.platform === "darwin" && gitRootRaw.startsWith("/private/") ? gitRootRaw.slice("/private".length) : gitRootRaw;
    if (gitRoot !== path) return { ok: false, code: "PATH_INVALID" };
    execFileSync("git", ["-C", path, "diff", "--check", "--", ...paths], { stdio: "pipe" });
    execFileSync("git", ["-C", path, "add", "--", ...paths], { stdio: "pipe" });
    execFileSync("git", ["-C", path, "commit", "-m", message], { stdio: "pipe" });
    const commitSha = execFileSync("git", ["-C", path, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    if (!/^[0-9a-f]{40}$/.test(commitSha)) return { ok: false, code: "COMMIT_FAILED", error: "commit SHA readback이 유효하지 않습니다." };
    return { ok: true, commitSha, stagedPaths: paths };
  } catch (error: any) {
    return { ok: false, code: "COMMIT_FAILED", error: error?.message ?? String(error) };
  }
}
export type AgentsToZProjectWorkerPlan =
  | {
      ok: true;
      requestId: string;
      project: string;
      memoryId: string;
      workerProfile: string;
      canonicalPath: string;
      command: string[];
      cwd: string;
    }
  | {
      ok: false;
      code:
        | "REQUEST_ID_REQUIRED"
        | "PROJECT_REQUIRED"
        | "MEMORY_ID_REQUIRED"
        | "CANONICAL_PATH_REQUIRED"
        | "CANONICAL_PATH_NOT_ABSOLUTE"
        | "TASK_REQUIRED";
      error: string;
    };

export function planAgentsToZProjectWorker(input: {
  requestId?: unknown;
  project?: unknown;
  memoryId?: unknown;
  canonicalPath?: unknown;
  task?: unknown;
  hermesCli?: string;
  workerProfile?: string;
}): AgentsToZProjectWorkerPlan {
  const requestId = typeof input.requestId === "string" ? input.requestId.trim() : "";
  if (!requestId) return { ok: false, code: "REQUEST_ID_REQUIRED", error: "requestId가 필요합니다." };
  const project = typeof input.project === "string" ? input.project.trim() : "";
  if (!project) return { ok: false, code: "PROJECT_REQUIRED", error: "resolved project가 필요합니다." };
  const memoryId = typeof input.memoryId === "string" ? input.memoryId.trim() : "";
  if (!memoryId) return { ok: false, code: "MEMORY_ID_REQUIRED", error: "project memory_id가 필요합니다." };
  const canonicalPath = typeof input.canonicalPath === "string" ? input.canonicalPath.trim() : "";
  if (!canonicalPath) return { ok: false, code: "CANONICAL_PATH_REQUIRED", error: "canonicalPath가 필요합니다." };
  if (!isAbsolute(canonicalPath)) {
    return { ok: false, code: "CANONICAL_PATH_NOT_ABSOLUTE", error: "canonicalPath는 절대경로여야 합니다." };
  }
  const task = typeof input.task === "string" ? input.task.trim() : "";
  if (!task) return { ok: false, code: "TASK_REQUIRED", error: "작업 내용이 필요합니다." };

  const hermesCli = typeof input.hermesCli === "string" && input.hermesCli.trim()
    ? input.hermesCli.trim()
    : "hermes";
  const workerProfile = typeof input.workerProfile === "string" && input.workerProfile.trim()
    ? input.workerProfile.trim()
    : "cs-ceo";
  const prompt = [
    `AgentsToZ project worker request_id=${requestId}`,
    `project=${project}`,
    `memory_id=${memoryId}`,
    `canonical_path=${canonicalPath}`,
    "Work only inside canonical_path. Do not fallback to another project.",
    "Read the project-local memory under canonical_path before working.",
    "Record durable decisions and verified results in that same project-local memory before finishing.",
    "Do not write to global or another project memory.",
    "Report the resolved project, memory_id, canonical_path, and Git result in the final response.",
    task,
  ].join("\n");
  return {
    ok: true,
    requestId,
    project,
    memoryId,
    workerProfile,
    canonicalPath,
    command: [hermesCli, "-p", workerProfile, "chat", "-q", prompt],
    cwd: canonicalPath,
  };
}
