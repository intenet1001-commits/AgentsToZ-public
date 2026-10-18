/** Read-only proof of desktop registration, separate from OS URL delivery. */
const record = (value: unknown): Record<string, unknown> | null => value !== null
  && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

export function normalizeCodexWorkspacePath(value: string | null | undefined): string | null {
  if (!value) return null;
  const path = value.normalize('NFC').replace(/\\/g, '/').replace(/\/+$/, '') || '/';
  return /^[a-z]:\//i.test(path) ? path.toLowerCase() : path;
}

export function sameCodexWorkspacePath(left: string | null | undefined, right: string | null | undefined): boolean {
  const path = normalizeCodexWorkspacePath(left);
  return path !== null && path === normalizeCodexWorkspacePath(right);
}

export type CodexDesktopProject = { projectId: string; hostId: string; folderPath: string; backendProjectId?: string };
export type CodexDesktopRegistration =
  | { state: 'found'; project: CodexDesktopProject }
  | { state: 'none' | 'ambiguous' | 'unavailable' };

export function resolveCodexDesktopRegistration(state: unknown, folderPath: string, hostId = 'local', preferredProjectId?: string): CodexDesktopRegistration {
  const projects = record(record(state)?.['local-projects']);
  if (!projects) return { state: 'unavailable' };
  const matches: CodexDesktopProject[] = [];
  for (const [projectId, value] of Object.entries(projects)) {
    const project = record(value);
    // Legacy local-project records omit hostId; an explicit remote host is never local.
    const projectHost = project?.hostId === undefined ? 'local' : project.hostId;
    if (projectHost !== hostId || !Array.isArray(project?.rootPaths)
      || (project.id !== undefined && project.id !== projectId)) continue;
    if (project.rootPaths.some(path => typeof path === 'string' && sameCodexWorkspacePath(path, folderPath))) {
      matches.push({ projectId, hostId, folderPath });
    }
  }
  if (matches.length > 1) {
    // macOS can retain NFC/NFD aliases for the same plain local folder. Use an
    // explicit assignment/selection only for that verified encoding difference;
    // identical duplicate roots, different labels, backing or extra roots remain ambiguous.
    const entries = matches.map(p => record(projects[p.projectId])!);
    const allowed = new Set(['id', 'name', 'rootPaths', 'createdAt', 'updatedAt', 'hostId']);
    const names = entries.map(p => typeof p.name === 'string' ? p.name.normalize('NFC') : null);
    const rawPaths = entries.map(p => (p.rootPaths as string[])[0]);
    const encodingAliases = names[0] !== null && names.every(name => name === names[0])
      && entries.every(p => (p.rootPaths as unknown[]).length === 1 && Object.keys(p).every(key => allowed.has(key)))
      && new Set(rawPaths).size > 1 && rawPaths.every(path => typeof path === 'string' && path.normalize('NFC') === folderPath.normalize('NFC'));
    if (encodingAliases) {
      const selected = record(record(state)?.['selected-project']);
      const selectedId = selected?.type === 'local' && (selected.hostId === undefined ? 'local' : selected.hostId) === hostId
        ? selected.projectId : null;
      const chosen = matches.find(p => p.projectId === preferredProjectId)
        ?? matches.find(p => p.projectId === selectedId);
      if (chosen) return { state: 'found', project: chosen };
    }
  }
  return matches.length === 1 ? { state: 'found', project: matches[0]! }
    : { state: matches.length ? 'ambiguous' : 'none' };
}

export function isCodexDesktopProjectSelected(state: unknown, project: CodexDesktopProject): boolean {
  const selected = record(record(state)?.['selected-project']);
  const registration = resolveCodexDesktopRegistration(state, project.folderPath, project.hostId);
  return registration.state === 'found' && registration.project.projectId === project.projectId
    && selected?.type === 'local' && selected.projectId === project.projectId
    && (selected.hostId === undefined ? 'local' : selected.hostId) === project.hostId;
}

/** Both sidebar membership and applied runtime cwd must agree with a unique registration. */
export function verifyCodexDesktopThreadBinding(input: {
  state: unknown; folderPath: string; threadId: string; executionCwd?: string | null; hostId?: string;
}): boolean {
  const hostId = input.hostId ?? 'local';
  const root = record(input.state);
  const assignment = record(record(root?.['thread-project-assignments'])?.[input.threadId]);
  const registration = resolveCodexDesktopRegistration(input.state, input.folderPath, hostId,
    typeof assignment?.projectId === 'string' ? assignment.projectId : undefined);
  if (registration.state !== 'found') return false;
  if (assignment?.projectKind !== 'local' || assignment.projectId !== registration.project.projectId
    || (assignment.hostId === undefined ? 'local' : assignment.hostId) !== hostId
    || assignment.pendingCoreUpdate === true) return false;
  for (const path of [assignment.cwd, assignment.path]) {
    if (path !== undefined && (typeof path !== 'string' || !sameCodexWorkspacePath(path, input.folderPath))) return false;
  }
  const workspace = record(record(root?.['electron-persisted-atom-state'])?.[`thread-workspace-state-v1:${input.threadId}`]);
  if (record(workspace?.pending)) return false;
  const workspaceProject = record(workspace?.project);
  if (workspaceProject && (workspaceProject.projectKind !== 'local'
    || workspaceProject.projectId !== registration.project.projectId
    || (workspaceProject.hostId === undefined ? 'local' : workspaceProject.hostId) !== hostId)) return false;
  const applied = record(workspace?.applied);
  if (applied && (typeof applied.cwd !== 'string' || !sameCodexWorkspacePath(applied.cwd, input.folderPath)
    || (applied.hostId === undefined ? 'local' : applied.hostId) !== hostId)) return false;
  // If the runtime record exists, also reject a conflicting latest rollout cwd.
  if (input.executionCwd && !sameCodexWorkspacePath(input.executionCwd, input.folderPath)) return false;
  return !!applied || !!input.executionCwd;
}

export class CodexDesktopRegistrationError extends Error {
  constructor(readonly code: string, message: string, readonly details?: {
    backendRegistered: true; backendProjectId: string; desktopProjectVisible: false;
  }) { super(message); }
}

/** Shared desktop/MCP wording must not turn a selected unsent draft into a bound chat. */
export function codexDesktopLaunchNotice(result: { projectApplied?: unknown; projectNote?: unknown }): {
  message: string; severity: 'success' | 'warning';
} {
  return result.projectApplied === true
    ? { message: '확인된 Codex 프로젝트 대화를 Mac 앱에 여는 요청을 보냈습니다', severity: 'success' }
    : { message: typeof result.projectNote === 'string' ? result.projectNote
      : 'Codex 앱 열기를 요청했지만 채팅의 프로젝트 소속과 작업 폴더는 확인되지 않았습니다', severity: 'warning' };
}

/** Opening an existing directory must never initialize Git or install a missing app. */
export function codexDesktopFolderOpenCommand(folderPath: string, platform: string): string[] {
  if (platform !== 'darwin') throw new CodexDesktopRegistrationError('CODEX_PROJECT_REGISTRATION_UNSUPPORTED',
    '이 운영체제에서는 Codex 프로젝트 자동 등록을 확인할 수 없습니다. Codex 앱에 기존 폴더를 추가한 뒤 다시 시도하세요.');
  return ['/usr/bin/open', '-b', 'com.openai.codex', folderPath];
}

/** Reuse first; wait for a real registration after the supported folder-open request. */
export async function ensureCodexDesktopRegistration(input: {
  read: () => unknown; folderPath: string; openFolder: () => Promise<void>;
  registerBackend?: () => Promise<{ backendRegistered: true; backendProjectId: string }>;
  now: () => number; sleep: (ms: number) => Promise<unknown>; timeoutMs?: number;
}): Promise<CodexDesktopProject> {
  const checked = () => {
    const result = resolveCodexDesktopRegistration(input.read(), input.folderPath);
    if (result.state === 'ambiguous' || (result.state === 'unavailable' && !input.registerBackend)) {
      throw new CodexDesktopRegistrationError('CODEX_PROJECT_REGISTRATION_UNVERIFIED',
        'Codex의 기존 프로젝트 등록을 정확히 확인하지 못해 새 대화를 만들지 않았습니다. Codex 앱의 프로젝트 목록을 확인하세요.');
    }
    return result;
  };
  const existing = checked();
  if (existing.state === 'found') return existing.project;
  let backend: Awaited<ReturnType<NonNullable<typeof input.registerBackend>>> | undefined;
  if (input.registerBackend) {
    try { backend = await input.registerBackend(); }
    catch {
      throw new CodexDesktopRegistrationError('CODEX_PROJECT_API_UNAVAILABLE',
        'Codex 프로젝트 API의 기존 등록과 생성 결과를 확인하지 못했습니다. 별도 독립 채팅을 만들지 않았습니다.');
    }
  }
  try { await input.openFolder(); }
  catch (error) {
    if (!backend) throw error;
    throw new CodexDesktopRegistrationError(
      error instanceof CodexDesktopRegistrationError ? error.code : 'CODEX_DESKTOP_OPEN_FAILED',
      error instanceof CodexDesktopRegistrationError ? error.message : 'Codex 프로젝트 API 등록은 완료했지만 데스크톱 폴더 열기를 전달하지 못했습니다.',
      { backendRegistered: true, backendProjectId: backend.backendProjectId, desktopProjectVisible: false });
  }
  const deadline = input.now() + (input.timeoutMs ?? 20_000);
  do {
    const result = checked();
    if (result.state === 'found') return { ...result.project, ...(backend ? { backendProjectId: backend.backendProjectId } : {}) };
    const remaining = deadline - input.now();
    if (remaining <= 0) break;
    await input.sleep(Math.min(200, remaining));
  } while (input.now() <= deadline);
  if (backend) throw new CodexDesktopRegistrationError('CODEX_DESKTOP_PROJECT_CATALOG_PENDING',
    'Codex 프로젝트 API 등록은 완료했지만 데스크톱 프로젝트 목록 반영은 아직 확인되지 않았습니다. 같은 프로젝트를 재사용하며 별도 독립 채팅을 만들지 않았습니다.',
    { backendRegistered: true, backendProjectId: backend.backendProjectId, desktopProjectVisible: false });
  throw new CodexDesktopRegistrationError('CODEX_PROJECT_REGISTRATION_UNVERIFIED',
    'Codex 앱에 폴더 열기를 요청했지만 프로젝트 등록은 확인되지 않았습니다. Codex 앱에서 기존 폴더를 프로젝트로 추가한 뒤 다시 시도하세요.');
}
