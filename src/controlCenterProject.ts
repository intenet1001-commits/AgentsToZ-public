import { OPS_FOLDER_NAME, OPS_RULE_FILE, isOpsFolderName, opsFolderLeaf } from "./opsFolderName";

/** New control centers are created as AgentsToZ-OPS; AgentsToZ-Control stays recognized (`isOpsFolderName`). */
export const CONTROL_CENTER_PROJECT_NAME = OPS_FOLDER_NAME;

type ControlCenterCandidate = {
  role?: unknown;
  worktreeParentId?: string;
  worktreePath?: string;
  name?: string;
  aiName?: string;
  folderPath?: string;
};

export function resolveControlCenterProject<T extends ControlCenterCandidate>(projects: readonly T[]): T | null {
  const roots = projects.filter(project => !project.worktreeParentId && !project.worktreePath);
  return roots.find(project => project.role === 'ops') ?? roots.find(project => {
    if (project.role !== undefined) return false;
    return isOpsFolderName(opsFolderLeaf(project.folderPath)) || isOpsFolderName(project.name) || isOpsFolderName(project.aiName);
  }) ?? null;
}

type ExistingOpsCandidate = { projectId: string; projectName: string; role?: unknown; scope?: unknown };

/**
 * One OPS per user. Both create paths (first-run UI and the MCP tool) return this project
 * instead of creating a second OPS folder: the project bound to the operating profile wins,
 * then a registered ops role, then either folder name. A linked worktree is never an OPS.
 */
export function findExistingOpsProject<T extends ExistingOpsCandidate>(
  projects: readonly T[],
  boundProjectId?: string | null,
): T | null {
  const main = projects.filter(project => project.scope !== "worktree");
  return (boundProjectId ? main.find(project => project.projectId === boundProjectId) : undefined)
    ?? main.find(project => project.role === "ops")
    ?? main.find(project => isOpsFolderName(project.projectName))
    ?? null;
}

export type ControlCenterTemplateFile = {
  relativePath: string;
  content: string;
};

/** A `portmgr_ports` row as it comes back from Supabase. */
type RemotePortRow = {
  id?: unknown;
  name?: unknown;
  device_id?: unknown;
  device_name?: unknown;
  folder_path?: unknown;
  memory_id?: unknown;
};

export type ControlCenterRemoteCandidate = {
  id: string;
  name: string;
  deviceId: string;
  deviceName: string;
  folderPath: string;
  memoryId: string | null;
};

const text = (value: unknown): string =>
  typeof value === "string" && value.trim() ? value.trim() : "";

// Another Mac may register the same OPS under either name, so both are offered.
const isControlCenterName = (name: string, folderPath: string): boolean =>
  isOpsFolderName(opsFolderLeaf(folderPath)) || isOpsFolderName(name);

/** Lineage lookup key: every OPS name is one project, so a revision written as AgentsToZ-Control fills an AgentsToZ-OPS row. */
const lineageNameKey = (name: string): string => isOpsFolderName(name) ? "\0ops" : name.toLocaleLowerCase();

/** A `portmgr_project_memory_revisions` row — used to recover a missing lineage. */
type RemoteLineageRow = {
  memory_id?: unknown;
  project_name?: unknown;
};

/**
 * Control centers registered on OTHER devices.
 *
 * `resolveControlCenterProject` only sees this device's rows, so an operator who
 * already created the OPS folder (`AgentsToZ-OPS`, or `AgentsToZ-Control` before the
 * rename) on another Mac gets `AgentsToZ OPS · 0`
 * here and is offered nothing but "create a new one" — which would fork the
 * memory lineage into a second memoryId.
 *
 * This returns candidates to OFFER, never to apply. Per-device isolation is a
 * rule of this schema: adopting another device's row silently would break the
 * `device_id` boundary and make the same folder path look owned twice. Rows
 * without a provable owner are skipped rather than guessed.
 *
 * `lineages` recovers a missing `memory_id`. Measured 2026-09-23: the remote
 * Control rows carried no `memory_id`, so "restore" had nothing to join and
 * initialized a fresh lineage instead — exactly the fork this is meant to
 * prevent. When the registration is silent, the memory revisions still name the
 * project, so we look there. An ambiguous name resolves to nothing: joining the
 * WRONG lineage is worse than forking, because it writes into someone's memory.
 */
export function controlCenterRemoteCandidates(
  rows: readonly RemotePortRow[],
  ownDeviceId: string,
  lineages: readonly RemoteLineageRow[] = [],
): ControlCenterRemoteCandidate[] {
  const own = text(ownDeviceId);
  const byName = new Map<string, string | null>();
  for (const row of lineages) {
    const memoryId = text(row.memory_id);
    const projectName = text(row.project_name);
    if (!memoryId || !projectName) continue;
    const name = lineageNameKey(projectName);
    const seen = byName.get(name);
    if (seen === undefined) byName.set(name, memoryId);
    else if (seen !== memoryId) byName.set(name, null); // 여러 계보 — 고르지 않는다
  }
  const seen = new Set<string>();
  const found: ControlCenterRemoteCandidate[] = [];
  for (const row of rows) {
    const id = text(row.id);
    const deviceId = text(row.device_id);
    if (!id || !deviceId || deviceId === own) continue;
    const name = text(row.name);
    const folderPath = text(row.folder_path);
    if (!isControlCenterName(name, folderPath)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    const leaf = opsFolderLeaf(folderPath);
    const fallback = (name ? byName.get(lineageNameKey(name)) : undefined)
      ?? byName.get(lineageNameKey(leaf))
      ?? null;
    found.push({
      id,
      name: name || CONTROL_CENTER_PROJECT_NAME,
      deviceId,
      deviceName: text(row.device_name) || deviceId,
      folderPath,
      memoryId: text(row.memory_id) || fallback,
    });
  }
  return found;
}

export function controlCenterTemplateFiles(projectName = CONTROL_CENTER_PROJECT_NAME): ControlCenterTemplateFile[] {
  const name = projectName.trim() || CONTROL_CENTER_PROJECT_NAME;
  return [
    {
      relativePath: "README.md",
      content: `# ${name}\n\nAgentsToZ 관제센터 프로젝트입니다. 여러 프로젝트가 함께 수행하는 업무의 목표, 역할, 공통 결정과 인수인계를 이 폴더에서 관리합니다.\n\n## 다른 Mac에서 이어서 사용하기\n\n1. 이 프로젝트를 Private GitHub 저장소에 push합니다.\n2. 다른 Mac의 AgentsToZ에서 **새 프로젝트 → GitHub 주소**에 같은 저장소 주소를 넣어 clone합니다.\n3. **처음부터 프로젝트 장기기억 사용**과 **Supabase 백업**을 켭니다.\n4. clone이 끝나면 AgentsToZ가 저장소 계보와 \`.agent-memory/config.json\`의 동일한 \`memoryId\`를 확인하고 원격 기억을 먼저 Pull합니다.\n\nGit은 이 폴더의 문서와 변경 이력을 동기화합니다. Supabase는 같은 \`memoryId\`의 장기기억 리비전을 동기화합니다. 새 Mac에서 장기기억을 다시 초기화하거나 새 ID로 바꾸지 마세요.\n`,
    },
    {
      relativePath: "CONTROL.md",
      content: `# Control Center\n\n## 역할\n\n- 새 프로젝트를 열기 전 목표와 담당 프로젝트를 정합니다.\n- 여러 프로젝트가 함께 일할 때 공통 결정과 완료 조건을 기록합니다.\n- 각 프로젝트의 구현 세부사항은 해당 프로젝트 장기기억에 남깁니다.\n- 실행 중 상태와 터미널 이벤트는 AgentsToZ 미션·워크룸 런타임에서 관리합니다.\n\n## 기억 경계\n\n- 관제센터 기억: 프로젝트 별칭, 관계, 반복되는 오케스트레이션 방식, 공통 결정\n- 프로젝트 기억: 해당 프로젝트의 설계, 변경, 검증 결과\n- 미션 저장소: 현재 진행 상태, 세션, 이벤트, 재개 지점\n\n## 운영 원칙\n\n1. 작업 전 AgentsToZ의 등록 프로젝트 목록에서 정확한 프로젝트 ID를 조회합니다.\n2. 경로와 ID를 추측하지 않습니다.\n3. 실제 변경·결정·검증 결과만 해당 프로젝트 기억 후보로 전달합니다.\n4. 완료는 도구가 반환한 성공 결과와 검증 근거로 판단합니다.\n`,
    },
    {
      relativePath: "PROJECTS.md",
      content: "# Projects\n\nAgentsToZ에서 조회한 등록 프로젝트의 표시 이름, 역할, 관계를 기록합니다. 로컬 절대경로, 토큰, 비밀번호는 기록하지 않습니다.\n\n| 프로젝트 | 역할 | 관계/메모 |\n|---|---|---|\n| | | |\n",
    },
    {
      relativePath: OPS_RULE_FILE,
      content: `# AgentsToZ control-center rule\n\nWhen the user addresses AgentsToZ, use the installed AgentsToZ MCP tools to resolve registered project and workspace-root IDs. Use this control-center memory for cross-project intent and stable relationships. Keep project-specific implementation decisions in each target project's memory, and keep live mission state in the AgentsToZ mission store. Never guess local paths or identifiers.\n`,
    },
  ];
}
