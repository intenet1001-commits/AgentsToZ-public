/** Explicit local pilot; never merges project identities or publishes anything. */
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveAppDataDirFromEnvironment } from '../src/appDataDir';
import { acquireWorkspaceLease } from '../src/workspaceLease';
import { MetaCommonMemoryStore } from '../src/metaCommonMemoryStore';
import { MetaCommonMemoryService } from '../src/metaCommonMemoryService';
import { detectProjectMemoryIdentity, initializeProjectMemory, upgradeProjectMemoryAgent } from '../project-memory-server';
import type { MetaMemoryProject } from '../src/metaCommonMemoryContract';

const appData = resolveAppDataDirFromEnvironment();
const registered = JSON.parse(readFileSync(join(appData, 'ports.json'), 'utf8')) as Array<{ id: string; name: string; folderPath?: string; category?: string }>;
const names = ['nhdesign-marketplace', 'nhdesign-usher'];
const selected = names.map(name => {
  const found = registered.filter(p => p.name === name && p.folderPath);
  if (found.length !== 1) throw Error(`정확한 등록 프로젝트 ${name} 후보가 ${found.length}개입니다.`);
  return found[0]!;
});
if (!process.argv.includes('--apply')) {
  console.log(JSON.stringify({ dryRun: true, projects: selected.map(p => ({ id: p.id, name: p.name })), name: 'NHCS 제품·개발 공통 기억' })); process.exit(0);
}
const projects: MetaMemoryProject[] = [];
for (const project of selected) {
  const before = await detectProjectMemoryIdentity(project.folderPath!);
  const lease = await acquireWorkspaceLease({ workspacePath: before.projectRoot, appDataDir: appData, attempts: 1 });
  try {
    const currentRows = JSON.parse(readFileSync(join(appData, 'ports.json'), 'utf8')) as typeof registered;
    const fresh = currentRows.find(p => p.id === project.id);
    if (!fresh?.folderPath || realpathSync(fresh.folderPath) !== realpathSync(project.folderPath!)) throw Error('등록 프로젝트가 변경되었습니다.');
    if (!before.config || !before.exists) initializeProjectMemory({ folderPath: before.projectRoot, projectName: project.name, agent: 'codex', autoBackup: true });
    else upgradeProjectMemoryAgent({ folderPath: before.projectRoot });
    const after = await detectProjectMemoryIdentity(before.projectRoot);
    if (!after.config || (before.config && before.config.memoryId !== after.config.memoryId)) throw Error('전용 기억 정체성을 보존하지 못했습니다.');
    projects.push({ id: project.id, name: project.name, category: project.category ?? '', memoryId: after.config.memoryId, state: 'ready' });
  } finally { lease.release(); }
}
const store = new MetaCommonMemoryStore(appData);
const service = new MetaCommonMemoryService(store, { projects: async () => projects, prepareProject: async () => { throw Error('pilot preparation already completed'); } });
const name = 'NHCS 제품·개발 공통 기억';
const bindingPath = join(store.directory, 'nhcs-pilot-binding.json');
let boundId: string | null = null;
try {
  const binding = JSON.parse(readFileSync(bindingPath, 'utf8'));
  if (binding.schemaVersion !== 1 || typeof binding.memoryId !== 'string') throw Error('기존 첫 적용 연결 기록을 확인하세요.');
  boundId = binding.memoryId;
} catch (error: any) { if (error.code !== 'ENOENT') throw error; }
const matches = store.list(name).memories.filter(g => g.name === name);
if (matches.length > 1) throw Error('같은 이름의 공통 기억이 여러 개입니다. 선택을 확인하세요.');
let memory = boundId ? store.read(boundId) : matches.length ? store.read(matches[0]!.id) : (await service.execute({ operation: 'save', name, description: 'NHCS 스킬과 usher 앱의 제품 역할·연동 계약·검증 원칙을 함께 관리한다.', tags: ['NHCS', '제품', '스킬', '앱', '연동'], expectedRevision: 0, requestId: randomUUID(), assignments: projects.map(p => ({ portId: p.id, expectedMemoryId: p.memoryId, mode: 'include' })) })).memory;
if (projects.some(p => !memory.members.some((m: any) => m.memoryId === p.memoryId && m.mode === 'include'))) memory = (await service.execute({ operation: 'save', memoryId: memory.id, expectedRevision: memory.revision, requestId: randomUUID(), name: memory.name, description: memory.description, tags: memory.tags, categories: memory.categories, assignments: projects.map(p => ({ portId: p.id, expectedMemoryId: p.memoryId, mode: 'include' })) })).memory;
writeFileSync(bindingPath, JSON.stringify({ schemaVersion: 1, memoryId: memory.id }) + '\n', { mode: 0o600 });
const entries = [
  { title: 'NHCS 제품 역할과 개발 저장소', body: 'nhdesign-marketplace는 NHCS 스킬과 디자인 지식의 개발·배포 계약을 관리한다. nhdesign-usher는 스킬·지식 패키지를 사용하는 독립 앱의 개발 저장소다. 두 저장소의 공통 제품 결정과 연동 계약은 이 독립 공통 기억에 기록하고, 구현 세부사항과 개별 결함·검증 교훈은 각 프로젝트의 전용 기억에 기록한다. 기존 usher 제품 결정의 근거는 marketplace의 docs/nhdesign-usher/DESIGN.md와 usher의 HANDOFF.md다.' },
  { title: '메타 공통 기억의 적용 범위와 소유', body: '공통 기억은 원본 프로젝트 없이 독립 ID로 존재하며 여러 프로젝트가 여러 공통 기억에 연결될 수 있다. 이름·설명·메타 태그와 체크박스로 적용 대상을 지정한다. 명시한 카테고리 규칙은 기본 연결을 제공하고 개별 포함·제외가 우선한다. 출처 정보는 수명이나 실행 권한이 아니다. 프로젝트 삭제·이름 변경·연결 해제는 공통 기억을 삭제하지 않는다.' },
  { title: 'NHCS 스킬과 usher 앱의 호환·배포 검증', body: '스킬·앱·디자인 지식 DB·기억 SDK가 만나는 변경은 양쪽의 실제 계약과 사용 경로를 확인한다. 배포된 usher 앱은 AgentsToZ 없이 작동하는 기존 제품 경계를 유지한다. 개발 저장소들의 공통 기억 연결은 사용자용 usher 앱에 AgentsToZ 의존성을 추가하는 동작이 아니다. 테스트가 통과한 개발 소스, 빌드한 패키지, 설치된 런타임과 실제 AI/Figma 흐름의 검증 결과는 각각의 근거로 구분한다.' },
  { title: '공통 교훈 저장과 충돌 처리', body: '일반 세션 저장은 현재 프로젝트의 전용 기억을 갱신하고, 공통 기억은 출처·리비전을 보존한 회상 문맥으로 사용한다. 적용 범위가 불명확하거나 여러 프로젝트에 영향을 줄 교훈은 공통화 후보로 제출해 검토한다. 후보는 확정 전 회상에 적용하지 않는다. 서로 모순되는 결정은 적용 범위와 근거를 검토하며 최신 시각만으로 덮어쓰지 않는다. 첫 버전의 공통 기억은 이 기기 로컬 저장과 JSON 백업이며 자동 원격 동기화 완료를 주장하지 않는다.' },
];
for (const entry of entries) if (!memory.entries.some((e: any) => e.title === entry.title)) memory = (await service.execute({ operation: 'save-entry', memoryId: memory.id, expectedRevision: memory.revision, requestId: randomUUID(), ...entry })).memory;
const backup = await service.execute({ operation: 'export', memoryId: memory.id });
const backupPath = join(store.directory, `pilot-${memory.id}.json`);
writeFileSync(backupPath, JSON.stringify(backup, null, 2) + '\n', { mode: 0o600 });
const recalls = projects.map(p => ({ project: p.name, memoryId: p.memoryId, commonHits: store.recall(p.memoryId!, 'NHCS 연동 기억').hits.length }));
if (recalls.some(r => r.commonHits === 0)) throw Error('한 프로젝트의 공통 기억 회상을 확인하지 못했습니다.');
console.log(JSON.stringify({ applied: true, commonMemory: { id: memory.id, name: memory.name, revision: memory.revision, entries: memory.entries.length }, projects: recalls, backupPath, automaticRemoteSync: false }));
