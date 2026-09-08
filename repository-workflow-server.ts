import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { GIT_VOLATILE_ARTIFACT_PATHSPECS } from "./git-worktree-status";

export const CURRENT_REPOSITORY_WORKFLOW_VERSION = 2;

export interface RepositoryWorkflowConfig {
  schemaVersion: 1;
  workflowVersion: number;
  firstTaskRouting: "ask";
  firstTaskPending: boolean;
}

export interface RepositoryWorkflowStatus {
  isGit: boolean;
  projectRoot: string;
  installedVersion: number;
  currentVersion: number;
  updateAvailable: boolean;
  firstTaskPending: boolean;
  config: RepositoryWorkflowConfig | null;
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

const WORKFLOW_REL = join("agentstoz", "repository-workflow.json");

function assertProjectRoot(folderPath: string): string {
  if (!folderPath || !isAbsolute(folderPath)) throw new Error("프로젝트 절대경로가 필요합니다.");
  const root = resolve(folderPath);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new Error(`프로젝트 폴더가 없습니다: ${folderPath}`);
  }
  return realpathSync(root);
}

function resolveGitDir(root: string): string | null {
  const dotGit = join(root, ".git");
  if (!existsSync(dotGit)) return null;
  const metadata = statSync(dotGit);
  if (metadata.isDirectory()) return dotGit;
  if (!metadata.isFile()) return null;

  const pointer = readFileSync(dotGit, "utf8").trim().match(/^gitdir:\s*(.+)$/i)?.[1]?.trim();
  if (!pointer) return null;
  const gitDir = resolve(root, pointer);
  return existsSync(gitDir) && statSync(gitDir).isDirectory() ? gitDir : null;
}

function configPath(root: string): string | null {
  const gitDir = resolveGitDir(root);
  return gitDir ? join(gitDir, WORKFLOW_REL) : null;
}

function runGit(
  root: string,
  args: string[],
  gitPath = "git",
  options: { preserveLeadingSpace?: boolean } = {},
): string {
  const result = spawnSync(gitPath, args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
  });
  if (result.error) throw new Error(`Git 실행 실패: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "").trim();
    throw new Error(detail || `Git 명령 실패: git ${args.join(" ")}`);
  }
  const stdout = String(result.stdout || "");
  // `status --porcelain`은 앞 2칸이 상태 코드라 " M path"처럼 선행 공백이 의미를 갖는다.
  // 통째로 trim()하면 첫 줄의 선행 공백만 사라져 statusPath()의 slice(3)이 한 칸 밀리고,
  // 결과적으로 **첫 번째 변경 파일의 경로 첫 글자가 잘려** 사용자에게 잘못 표시된다
  // (예: ".agent-memory/activity.json" → "agent-memory/activity.json").
  return options.preserveLeadingSpace ? stdout.replace(/\s+$/, "") : stdout.trim();
}

function statusPath(record: string): string {
  const raw = record.length > 3 ? record.slice(3) : record;
  const renamed = raw.includes(" -> ") ? raw.split(" -> ").at(-1)! : raw;
  return renamed.replace(/^"|"$/g, "");
}

/** Refuse to branch from a snapshot that does not contain the visible main-tree work. */
export function inspectWorktreeSource(folderPath: string, gitPath = "git"): WorktreeSourceStatus {
  const root = assertProjectRoot(folderPath);
  if (!resolveGitDir(root)) throw new Error("먼저 Git 저장소를 만들어주세요.");
  const head = runGit(root, ["rev-parse", "HEAD"], gitPath);
  const files = runGit(root, ["ls-tree", "-r", "--name-only", "HEAD"], gitPath)
    .split(/\r?\n/)
    .filter(Boolean);
  const rawStatus = runGit(root, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
    "--",
    ".",
    ...GIT_VOLATILE_ARTIFACT_PATHSPECS,
  ], gitPath, { preserveLeadingSpace: true });
  const changedPaths = rawStatus
    .split(/\r?\n/)
    .filter(Boolean)
    .map(statusPath)
    // 앱이 만드는 워크트리 폴더는 메인트리의 "커밋 안 된 변경"으로 세지 않는다(현행 + 레거시).
    .filter(path => path && !path.startsWith(".claude/worktrees/") && !path.startsWith("worktrees/"));
  const changeCount = changedPaths.length;
  return {
    ready: changeCount === 0,
    projectRoot: root,
    head,
    headFileCount: files.length,
    changeCount,
    changedPaths: changedPaths.slice(0, 12),
    message: changeCount > 0
      ? `메인트리에 커밋되지 않은 변경 ${changeCount}개가 있습니다. main의 커밋을 완료한 뒤 워크트리를 만드세요.`
      : undefined,
  };
}

function parseWorktreePaths(porcelain: string): string[] {
  return porcelain
    .split(/\r?\n/)
    .filter(line => line.startsWith("worktree "))
    .map(line => realpathSync(resolve(line.slice("worktree ".length).trim())));
}

/** Verify that an AI launch target is a real linked worktree with usable project context. */
export function inspectWorktreeLaunch(
  folderPath: string,
  worktreePath: string,
  gitPath = "git",
): WorktreeLaunchStatus {
  const sourceRoot = assertProjectRoot(folderPath);
  const targetPath = assertProjectRoot(worktreePath);
  const listedPaths = parseWorktreePaths(runGit(sourceRoot, ["worktree", "list", "--porcelain"], gitPath));
  const mainWorktreePath = listedPaths[0] ?? sourceRoot;
  const registered = listedPaths.includes(targetPath);
  const actualTargetRoot = realpathSync(resolve(runGit(targetPath, ["rev-parse", "--show-toplevel"], gitPath)));
  if (actualTargetRoot !== targetPath) {
    throw new Error(`선택한 폴더가 워크트리 루트가 아닙니다: ${targetPath}`);
  }

  const source = inspectWorktreeSource(mainWorktreePath, gitPath);
  const targetHead = runGit(targetPath, ["rev-parse", "HEAD"], gitPath);
  const targetFileCount = runGit(targetPath, ["ls-tree", "-r", "--name-only", "HEAD"], gitPath)
    .split(/\r?\n/)
    .filter(Boolean).length;
  const memoryConfiguredInMain = existsSync(join(mainWorktreePath, ".agent-memory", "config.json"));
  const memoryAvailableInTarget = existsSync(join(targetPath, ".agent-memory", "config.json"));
  const emptyBehindVisibleMain = targetFileCount === 0 && source.changeCount > 0;
  // 장기기억은 메인 워크트리를 단일 소스로 삼는다(project-memory-server의 resolveMemoryRoot,
  // 그리고 동일 규칙을 쓰는 활동 훅). 따라서 워크트리에 .agent-memory/config.json 사본이
  // 없더라도 AI는 메인의 기억을 그대로 읽고 쓴다 — 실행을 막을 이유가 없다.
  // (과거에는 여기서 차단해, 오래된 브랜치로 만든 워크트리가 영구히 실행 불가였다.)
  const ready = registered && !emptyBehindVisibleMain;
  let message: string | undefined;
  if (!registered) {
    message = "선택한 폴더가 현재 Git 저장소의 등록된 워크트리가 아닙니다.";
  } else if (emptyBehindVisibleMain) {
    message = "이 워크트리는 빈 커밋에서 만들어져 메인트리 파일이 없습니다. main을 커밋한 뒤 이 워크트리를 삭제하고 새 브랜치로 다시 만드세요.";
  }

  return {
    ...source,
    ready,
    targetPath,
    mainWorktreePath,
    registered,
    targetHead,
    targetFileCount,
    memoryConfiguredInMain,
    memoryAvailableInTarget,
    message,
  };
}

function readConfig(root: string): RepositoryWorkflowConfig | null {
  const path = configPath(root);
  if (!path || !existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<RepositoryWorkflowConfig>;
    if (!Number.isInteger(raw.workflowVersion) || (raw.workflowVersion ?? 0) < 1) return null;
    return {
      schemaVersion: 1,
      workflowVersion: raw.workflowVersion!,
      firstTaskRouting: "ask",
      firstTaskPending: raw.firstTaskPending === true,
    };
  } catch {
    return null;
  }
}

function writeConfig(root: string, config: RepositoryWorkflowConfig): void {
  const path = configPath(root);
  if (!path) throw new Error("Git 저장소가 아닙니다.");
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  renameSync(temporary, path);
}

export function detectRepositoryWorkflow(folderPath: string): RepositoryWorkflowStatus {
  const root = assertProjectRoot(folderPath);
  const isGit = resolveGitDir(root) !== null;
  const config = isGit ? readConfig(root) : null;
  const installedVersion = config?.workflowVersion ?? 0;
  return {
    isGit,
    projectRoot: root,
    installedVersion,
    currentVersion: CURRENT_REPOSITORY_WORKFLOW_VERSION,
    updateAvailable: isGit && installedVersion < CURRENT_REPOSITORY_WORKFLOW_VERSION,
    firstTaskPending: config?.firstTaskPending === true,
    config,
  };
}

export function upgradeRepositoryWorkflow(folderPath: string): RepositoryWorkflowStatus {
  const root = assertProjectRoot(folderPath);
  if (!resolveGitDir(root)) throw new Error("먼저 Git 저장소를 만들어주세요.");
  const previous = readConfig(root);
  if (previous && previous.workflowVersion > CURRENT_REPOSITORY_WORKFLOW_VERSION) {
    // 더 새로운 앱이 만든 설정을 구버전 앱이 덮어쓰거나 다운그레이드하지 않는다.
    return detectRepositoryWorkflow(root);
  }
  writeConfig(root, {
    schemaVersion: 1,
    workflowVersion: CURRENT_REPOSITORY_WORKFLOW_VERSION,
    firstTaskRouting: "ask",
    // 최초 설치 때만 다음 AI 실행에서 작업 위치를 묻는다. 이후 버전 업그레이드는
    // 이미 처리한 첫 임무를 다시 묻지 않도록 기존 값을 보존한다.
    firstTaskPending: previous ? previous.firstTaskPending : true,
  });
  return detectRepositoryWorkflow(root);
}

export function completeRepositoryFirstTask(folderPath: string): RepositoryWorkflowStatus {
  const root = assertProjectRoot(folderPath);
  const previous = readConfig(root);
  if (!previous) throw new Error("저장소 작업 흐름을 먼저 설치하거나 업데이트해주세요.");
  writeConfig(root, { ...previous, firstTaskPending: false });
  return detectRepositoryWorkflow(root);
}
