import { isTauri } from "./lib/env";

export interface RepositoryWorkflowStatus {
  isGit: boolean;
  projectRoot: string;
  installedVersion: number;
  currentVersion: number;
  updateAvailable: boolean;
  firstTaskPending: boolean;
}

export interface WorktreeSourceStatus {
  ready: boolean;
  projectRoot: string;
  head: string;
  headFileCount: number;
  changeCount: number;
  changedPaths: string[];
  message?: string;
}

export interface WorktreeLaunchStatus extends WorktreeSourceStatus {
  targetPath: string;
  mainWorktreePath: string;
  registered: boolean;
  targetHead: string;
  targetFileCount: number;
  memoryConfiguredInMain: boolean;
  memoryAvailableInTarget: boolean;
}

const apiBase = () => isTauri() ? "http://127.0.0.1:3001" : "";

async function request(path: string, folderPath: string): Promise<RepositoryWorkflowStatus> {
  const attempts = isTauri() ? 12 : 1;
  let lastError: unknown = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(`${apiBase()}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ folderPath }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || `요청 실패 (${response.status})`);
      return data as RepositoryWorkflowStatus;
    } catch (error) {
      if (error instanceof Error && !/Failed to fetch|Load failed|NetworkError|fetch/i.test(error.message)) throw error;
      lastError = error;
      if (attempt + 1 < attempts) await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("저장소 작업 흐름 서비스에 연결하지 못했습니다.");
}

async function requestJson<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${apiBase()}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `요청 실패 (${response.status})`);
  return data as T;
}

export const repositoryWorkflowApi = {
  status(folderPath: string) {
    return request("/api/repository-workflow/status", folderPath);
  },
  upgrade(folderPath: string) {
    return request("/api/repository-workflow/upgrade", folderPath);
  },
  completeFirstTask(folderPath: string) {
    return request("/api/repository-workflow/complete-first-task", folderPath);
  },
  worktreeSource(folderPath: string) {
    return requestJson<WorktreeSourceStatus>("/api/repository-workflow/worktree-source", { folderPath });
  },
  worktreeLaunch(folderPath: string, worktreePath: string) {
    return requestJson<WorktreeLaunchStatus>("/api/repository-workflow/worktree-launch", { folderPath, worktreePath });
  },
};

export function defaultFirstTaskBranchName(now = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `task-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
}
