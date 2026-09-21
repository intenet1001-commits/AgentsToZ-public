import {realpathSync} from 'node:fs';
import {ControlProfileError} from './controlProfileContract';

type Binding = {profileId: string; memoryId: string; projectId: string | null; root: string; backend: string};
type Project = {projectId: string; projectName: string; canonicalPath: string; memoryId: string};

/** Resolve the existing registered execution target, never a display-name/role heuristic.
 * readBinding must use store.read(), which also verifies the live memory snapshot. */
export async function resolveOpsSurfaceProject(input: {
  readBinding(): Binding;
  resolveProject(id: string): Promise<Project>;
  registered(): Promise<Array<{id?: unknown; folderPath?: unknown; worktreePath?: unknown; worktreeParentId?: unknown}>>;
}): Promise<Project> {
  const before = input.readBinding();
  if (before.backend !== 'control-folder' || !before.projectId) {
    throw new ControlProfileError('CONTROL_PROFILE_SURFACE_UNAVAILABLE',
      '이 로컬 전용 OPS는 운영 패널과 기억 호출을 지원합니다. 앱·Workroom·Orca 열기는 기존 등록 OPS 운영 폴더 연결이 필요합니다. 새 폴더나 기억을 만들지 않았습니다.');
  }
  const project = await input.resolveProject(before.projectId);
  const rows = (await input.registered()).filter(row => row.id === before.projectId);
  const after = input.readBinding();
  let valid = false;
  try {
    const row = rows.length === 1 ? rows[0] : undefined;
    const cwd = row?.worktreePath || row?.folderPath;
    valid = before.profileId === after.profileId && before.memoryId === after.memoryId
      && before.projectId === after.projectId && before.backend === after.backend
      && realpathSync(before.root) === realpathSync(after.root)
      && project.memoryId === after.memoryId && project.projectId === after.projectId
      && realpathSync(project.canonicalPath) === realpathSync(after.root)
      && !!row && !row.worktreeParentId && typeof cwd === 'string'
      && realpathSync(cwd) === realpathSync(after.root);
  } catch { /* Unavailable/stale filesystem evidence is not execution authority. */ }
  if (!valid) throw new ControlProfileError('CONTROL_PROFILE_SURFACE_MISMATCH',
    'OPS 기억과 등록 실행 폴더가 일치하지 않습니다. 기존 연결을 확인하세요. 다른 프로젝트를 열지 않았습니다.');
  return {...project, projectName: 'AgentsToZ OPS'};
}
