import {metaMemoryCreationId} from './metaCommonMemoryIdentity';
import { createHash } from 'node:crypto';
import { MetaCommonMemoryStore } from './metaCommonMemoryStore';
import { MetaMemoryError, isMemberAssignment, metaMemoryApplies, parseMetaMemoryRequest, validateMetaMemorySnapshot, type MetaMemoryPortAssignment, type MetaMemoryProject, type MetaMemoryRequest } from './metaCommonMemoryContract';

/** The long-term-memory forms ({memoryId} members, projectMemoryId recall, sourceMemoryId) are verified in the cloud; this local store cannot. */
const cloudRequired = () => new MetaMemoryError('META_MEMORY_CLOUD_REQUIRED', '장기기억 ID로 연결·조회하는 공통기억은 클라우드 연결에서 사용하세요.', 409);

export interface MetaMemoryServiceDependencies {
  projects(fresh?: boolean): Promise<MetaMemoryProject[]>;
  prepareProject(portId: string): Promise<void>;
  assertActive?(): void;
  cloud?(request:MetaMemoryRequest):Promise<{handled:boolean;result?:any}>;
}
/** The phone's local-common view. A group with a cloud handoff is managed in the 공통기억 (cloud) tab: the phone neither
 *  lists nor opens its local copy. While the cloud actually answers, a new group belongs there, not in this Mac's store. */
export interface MetaMemoryRemotePolicy {
  /** True only after a real cloud read succeeded; false when the cloud is absent or unmigrated (local creation stays allowed). */
  cloudAvailable(): Promise<boolean>;
}
export const META_MEMORY_CLOUD_TAB_MESSAGE = '이 기억은 공통기억(클라우드) 탭에서 관리합니다.';
const cloudAuthority = () => new MetaMemoryError('META_MEMORY_CLOUD_AUTHORITY', META_MEMORY_CLOUD_TAB_MESSAGE, 409);
/** App and MCP share this dispatcher. Registry resolution happens on every mutation. */
export class MetaCommonMemoryService {
  constructor(readonly store: MetaCommonMemoryStore, private deps: MetaMemoryServiceDependencies, private options: { remote?: MetaMemoryRemotePolicy } = {}) {}
  /** Remote (phone) rules; the desktop passes no policy and keeps every behaviour unchanged. Nothing here writes. */
  private async remoteGate(r: MetaMemoryRequest, remote: MetaMemoryRemotePolicy): Promise<{ handled: true; result: any } | null> {
    if (r.operation === 'list') return { handled: true, result: this.store.list(r.query, r.offset, { unfencedOnly: true }) };
    if ((r.operation === 'read' || r.operation === 'history' || r.operation === 'export') && this.store.fencedIds().has(r.memoryId)) throw cloudAuthority();
    const creates = (r.operation === 'save' && !r.memoryId) || (r.operation === 'import' && r.expectedRevision === 0 && !this.store.has(r.snapshot.id));
    if (creates && await remote.cloudAvailable()) throw new MetaMemoryError('META_MEMORY_CLOUD_REQUIRED', '클라우드 공통기억이 연결되어 있습니다. 새 공통기억은 「공통기억」 탭에서 만드세요.', 409);
    return null;
  }
  private mutate(...args: Parameters<MetaCommonMemoryStore['mutate']>) { this.deps.assertActive?.(); return this.store.mutate(...args); }
  async execute(raw: unknown): Promise<any> {
    this.deps.assertActive?.();
    if (Buffer.byteLength(JSON.stringify(raw) ?? '') > 600 * 1024) throw new MetaMemoryError('META_MEMORY_INPUT_TOO_LARGE', '공통 기억 요청은 600 KiB까지입니다. 주제를 나눠 저장하세요.');
    const r = parseMetaMemoryRequest(raw);
    // A committed local receipt stays replayable even if its group has since moved to cloud.
    if('requestId' in r){const id=r.operation==='import'?r.snapshot.id:r.operation==='save'?r.memoryId??metaMemoryCreationId(r.requestId):'memoryId' in r?r.memoryId:null;if(id){const replay=this.store.replay(id,r.requestId,r);if(replay)return {memory:replay,...(r.operation==='import'?{imported:true}:{}),...(['save-entry','propose-entry'].includes(r.operation)?{saved:r.operation==='save-entry',candidate:r.operation==='propose-entry'}:{})};}}
    if(this.options.remote){const gated=await this.remoteGate(r,this.options.remote);if(gated)return gated.result;}
    if(this.deps.cloud){const response=await this.deps.cloud(r);if(response.handled)return response.result;}
    if (r.operation === 'list') return this.store.list(r.query, r.offset);
    if (r.operation === 'projects') return { projects: await this.deps.projects() };
    if (r.operation === 'prepare-project') { await this.deps.prepareProject(r.portId); return { prepared: true, projects: await this.deps.projects() }; }
    if (r.operation === 'history') return { history: this.store.history(r.memoryId) };
    if (r.operation === 'read') {
      const memory = this.store.read(r.memoryId);
      const projects = await this.deps.projects();
      return { memory, projects, appliedProjectIds: projects.filter(p => p.memoryId && metaMemoryApplies(memory, p.memoryId, p.category)).map(p => p.id) };
    }
    if (r.operation === 'export') {
      const snapshot = this.store.read(r.memoryId);
      return { format: 'agentstoz-meta-common-memory', schemaVersion: 1, snapshot, checksum: createHash('sha256').update(JSON.stringify(snapshot)).digest('hex'), automaticRemoteSync: false };
    }
    if (r.operation === 'recall') {
      if (!('portId' in r)) throw cloudRequired();
      const project = (await this.deps.projects(true)).find(p => p.id === r.portId);
      if (!project?.memoryId || project.state !== 'ready') throw new MetaMemoryError('META_MEMORY_PROJECT_UNAVAILABLE', '등록 프로젝트의 전용 기억을 먼저 준비하세요.', 409);
      return this.store.recall(project.memoryId, r.query, project.category);
    }
    if ((r.operation === 'save' && r.assignments.some(isMemberAssignment)) || ((r.operation === 'save-entry' || r.operation === 'propose-entry') && r.sourceMemoryId)) throw cloudRequired();
    const id = r.operation === 'save' ? r.memoryId ?? metaMemoryCreationId(r.requestId) : r.operation === 'import' ? r.snapshot.id : r.memoryId;
    // Confirm a committed outcome before revalidating a registration that may have changed
    // after the response was lost. Replay never reconnects or writes the changed project.
    const replay = this.store.replay(id, r.requestId, r);
    if (replay) return { memory: replay, ...(r.operation === 'import' ? { imported: true } : {}), ...(['save-entry', 'propose-entry'].includes(r.operation) ? { saved: r.operation === 'save-entry', candidate: r.operation === 'propose-entry' } : {}) };
    const mutation = { id, expectedRevision: r.expectedRevision, requestId: r.requestId, operation: r.operation, request: r, create: (r.operation === 'save' && !r.memoryId) || (r.operation === 'import' && r.expectedRevision === 0) };
    if (r.operation === 'save') {
      const projects = r.assignments.length ? await this.deps.projects(true) : [];
      const assignments = (r.assignments as MetaMemoryPortAssignment[]).map(a => {
        const p = projects.find(p => p.id === a.portId);
        if (!p?.memoryId || p.state !== 'ready' || p.memoryId !== a.expectedMemoryId) throw new MetaMemoryError('META_MEMORY_PROJECT_UNAVAILABLE', '선택한 프로젝트의 전용 기억과 등록 상태를 확인하세요.', 409);
        return { memoryId: p.memoryId, name: p.name, mode: a.mode };
      });
      // Main/worktree cards can resolve to one memory. Contradictory checkboxes must not win by order.
      for (const a of assignments) if (assignments.some(b => b.memoryId === a.memoryId && b.mode !== a.mode)) throw new MetaMemoryError('META_MEMORY_ASSIGNMENT_CONFLICT', '같은 기억을 사용하는 프로젝트·워크트리의 선택이 서로 다릅니다.', 409);
      return { memory: this.mutate(mutation, g => {
        g.name = r.name; g.description = r.description; g.tags = r.tags; g.categories = r.categories;
        for (const a of assignments) { g.members = g.members.filter(m => m.memoryId !== a.memoryId); if (a.mode !== 'inherit') g.members.push({ ...a, mode: a.mode }); }
        return g;
      }) };
    }
    if (r.operation === 'archive') return { memory: this.mutate(mutation, g => ({ ...g, archived: r.archived })) };
    if (r.operation === 'import') {
      // Portable connections are dormant until the same memoryId is registered on this device.
      return { memory: this.mutate(mutation, g => ({ ...validateMetaMemorySnapshot(r.snapshot), createdAt: g.createdAt })), imported: true };
    }
    if (r.operation === 'review-entry') return { memory: this.mutate(mutation, g => {
      const entry = g.entries.find(e => e.id === r.entryId);
      if (!entry) throw new MetaMemoryError('META_MEMORY_ENTRY_NOT_FOUND', '기억 항목을 찾지 못했습니다.', 404);
      entry.state = r.state; entry.updatedAt = new Date().toISOString(); return g;
    }) };
    if (r.operation === 'propose-source-entry' || r.operation === 'review-entries') throw new MetaMemoryError('META_MEMORY_CLOUD_REQUIRED', '원본 근거 후보와 일괄 검토는 클라우드 공통기억에서 사용하세요.', 409);
    let sourceMemoryId: string | null = null;
    if (r.portId) {
      const p = (await this.deps.projects(true)).find(p => p.id === r.portId);
      if (!p?.memoryId || p.state !== 'ready' || !metaMemoryApplies(this.store.read(id), p.memoryId, p.category)) throw new MetaMemoryError('META_MEMORY_PROJECT_NOT_LINKED', '이 프로젝트에 연결된 공통 기억을 선택하세요.', 403);
      sourceMemoryId = p.memoryId;
    }
    const entryId = r.entryId ?? createHash('sha256').update(r.requestId).digest('hex').slice(0, 24);
    return { memory: this.mutate(mutation, g => {
      if (g.archived) throw new MetaMemoryError('META_MEMORY_ARCHIVED', '보관된 기억을 다시 사용한 뒤 항목을 저장하세요.', 409);
      const existing = g.entries.find(e => e.id === entryId);
      if (r.operation === 'propose-entry' && existing) throw new MetaMemoryError('META_MEMORY_PROPOSAL_INVALID', '공통화 후보는 기존 확정 항목을 바꾸지 않습니다.', 409);
      const entry = { id: entryId, title: r.title, body: r.body, sourceMemoryId: sourceMemoryId ?? existing?.sourceMemoryId ?? null, state: r.operation === 'propose-entry' ? 'candidate' as const : 'active' as const, updatedAt: new Date().toISOString() };
      g.entries = [...g.entries.filter(e => e.id !== entryId), entry]; return g;
    }), saved: r.operation === 'save-entry', candidate: r.operation === 'propose-entry' };
  }
}
