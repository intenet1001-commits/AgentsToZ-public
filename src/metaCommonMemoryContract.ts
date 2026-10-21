/** Portable identities and bounded requests; never put paths or credentials in this contract. */
export const META_COMMON_MEMORY_LIMITS = { groups: 1000, entries: 256, members: 2000, page: 50, recallGroups: 32, recallHits: 8, recallBytes: 16_384, bodyBytes: 12_000, diskBytes: 512 * 1024 * 1024 } as const;
export type MetaMemoryEntryState = 'active' | 'candidate' | 'contested' | 'superseded';
export type MetaMemoryMemberMode = 'include' | 'exclude';
export interface MetaMemoryEntry { id: string; title: string; body: string; state: MetaMemoryEntryState; sourceMemoryId: string | null; updatedAt: string }
export interface MetaMemoryMember { memoryId: string; name: string; mode: MetaMemoryMemberMode }
export interface MetaCommonMemory {
  id: string; revision: number; name: string; description: string; tags: string[]; categories: string[];
  archived: boolean; entries: MetaMemoryEntry[]; members: MetaMemoryMember[]; createdAt: string; updatedAt: string;
}
export interface MetaMemoryProject { id: string; name: string; category: string; memoryId: string | null; state: 'ready' | 'uninitialized' | 'unavailable' }
export interface MetaMemorySummary extends Omit<MetaCommonMemory, 'entries' | 'members'> { entryCount: number; candidateCount: number; memberCount: number }
export interface MetaMemoryRecallHit { memoryId: string; memoryName: string; revision: number; entryId: string; title: string; body: string; state: 'active' | 'contested'; score: number }
export interface MetaMemoryRecall { state: 'ready' | 'unavailable'; groups: Array<{ id: string; name: string; revision: number }>; hits: MetaMemoryRecallHit[]; truncated: boolean; error?: string }
export type MetaMemoryAssignmentMode = 'include' | 'exclude' | 'inherit';
/** Legacy form: a registered project card on this Mac plus the memory it must still resolve to. */
export type MetaMemoryPortAssignment = { portId: string; expectedMemoryId: string; mode: MetaMemoryAssignmentMode };
/** Long-term-memory form (cloud only): the member is the memory itself, verified against the cloud before it is stored. */
export type MetaMemoryMemberAssignment = { memoryId: string; mode: MetaMemoryAssignmentMode };
export type MetaMemoryAssignment = MetaMemoryPortAssignment | MetaMemoryMemberAssignment;
export const isMemberAssignment = (a: MetaMemoryAssignment): a is MetaMemoryMemberAssignment => 'memoryId' in a;
/** The memory an assignment will store, whichever form it was sent in. */
export const assignmentMemoryId = (a: MetaMemoryAssignment): string => isMemberAssignment(a) ? a.memoryId : a.expectedMemoryId;
export type MetaMemoryRequest =
  | { operation: 'list'; query: string; offset: number }
  | { operation: 'projects' }
  | { operation: 'prepare-project'; portId: string }
  | { operation: 'read'; memoryId: string; /** `false` (hosts with the `lean-read` capability): leave out the project inventory. */ withProjects?: false }
  | { operation: 'history'; memoryId: string }
  | { operation: 'export'; memoryId: string }
  | { operation: 'save'; memoryId?: string; expectedRevision: number; requestId: string; name: string; description: string; tags: string[]; categories: string[]; assignments: MetaMemoryAssignment[] }
  | { operation: 'archive'; memoryId: string; expectedRevision: number; requestId: string; archived: boolean }
  | { operation: 'save-entry' | 'propose-entry'; memoryId: string; expectedRevision: number; requestId: string; entryId?: string; title: string; body: string; portId?: string; sourceMemoryId?: string }
  | { operation: 'propose-source-entry'; memoryId: string; expectedRevision: number; requestId: string; title: string; body: string; reason: string; category: string; conditions: string[]; evidence: Array<{memoryId: string; revisionId: string; entryId: string; contentHash: string}>; supersedesEntryId?: string }
  | { operation: 'review-entry'; memoryId: string; expectedRevision: number; requestId: string; entryId: string; state: MetaMemoryEntryState }
  | { operation: 'review-entries'; memoryId: string; expectedRevision: number; requestId: string; entryIds: string[]; state: 'active' | 'superseded' }
  | { operation: 'recall'; portId: string; query: string }
  | { operation: 'recall'; projectMemoryId: string; query: string }
  | { operation: 'import'; requestId: string; expectedRevision: number; snapshot: MetaCommonMemory };

export class MetaMemoryError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) { super(message); this.name = 'MetaMemoryError'; }
}
export function metaMemoryId(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new MetaMemoryError('META_MEMORY_ID_INVALID', '전체 공통 기억 ID를 선택하세요.');
  return value.toLowerCase();
}
function requestToken(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || new TextEncoder().encode(value).length > 200 || /[\u0000-\u001f\u007f]/.test(value)) throw new MetaMemoryError('META_MEMORY_REQUEST_ID_INVALID', 'requestId는 앞뒤 공백 없는 1~200 UTF-8 bytes의 재시도 식별자여야 합니다.');
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ? value.toLowerCase() : value;
}
function text(value: unknown, max: number, required = false): string {
  if (typeof value !== 'string' || new TextEncoder().encode(value).length > max || /\u0000/.test(value) || (required && !value.trim())) throw new MetaMemoryError('META_MEMORY_INPUT_INVALID', '입력 내용과 길이를 확인하세요.');
  return value.trim();
}
function list(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 16) throw new MetaMemoryError('META_MEMORY_INPUT_INVALID', '태그와 자동 연결 카테고리는 각각 16개까지입니다.');
  return [...new Set(value.map(v => text(v, 120, true).normalize('NFC')))];
}
function integer(value: unknown, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > max) throw new MetaMemoryError('META_MEMORY_INPUT_INVALID', '리비전과 조회 위치를 확인하세요.');
  return value as number;
}
function entryId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{24}$/.test(value)) throw new MetaMemoryError('META_MEMORY_INPUT_INVALID', '기억 항목 ID를 확인하세요.');
  return value;
}
export function validateMetaMemorySnapshot(value: unknown): MetaCommonMemory {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new MetaMemoryError('META_MEMORY_IMPORT_INVALID', '공통 기억 백업 형식을 확인하세요.');
  const v = value as Record<string, any>;
  if (!Array.isArray(v.entries) || v.entries.length > META_COMMON_MEMORY_LIMITS.entries || !Array.isArray(v.members) || v.members.length > META_COMMON_MEMORY_LIMITS.members || typeof v.archived !== 'boolean') throw new MetaMemoryError('META_MEMORY_IMPORT_INVALID', '공통 기억 백업 범위를 확인하세요.');
  const entries: MetaMemoryEntry[] = v.entries.map((e: any) => {
    if (!e || !['active', 'candidate', 'contested', 'superseded'].includes(e.state)) throw new MetaMemoryError('META_MEMORY_IMPORT_INVALID', '기억 항목 상태를 확인하세요.');
    return { id: entryId(e.id), title: text(e.title, 240, true), body: text(e.body, META_COMMON_MEMORY_LIMITS.bodyBytes, true), state: e.state, sourceMemoryId: e.sourceMemoryId === null ? null : metaMemoryId(e.sourceMemoryId), updatedAt: timestamp(e.updatedAt) };
  });
  const members: MetaMemoryMember[] = v.members.map((m: any) => {
    if (!m || !['include', 'exclude'].includes(m.mode)) throw new MetaMemoryError('META_MEMORY_IMPORT_INVALID', '프로젝트 연결 상태를 확인하세요.');
    return { memoryId: metaMemoryId(m.memoryId), name: text(m.name, 480, true), mode: m.mode };
  });
  if (new Set(entries.map(e => e.id)).size !== entries.length || new Set(members.map(m => m.memoryId)).size !== members.length) throw new MetaMemoryError('META_MEMORY_IMPORT_INVALID', '중복 기억 항목 또는 프로젝트 연결이 있습니다.');
  return { id: metaMemoryId(v.id), revision: integer(v.revision), name: text(v.name, 240, true), description: text(v.description, 2000), tags: list(v.tags), categories: list(v.categories), archived: v.archived, entries, members, createdAt: timestamp(v.createdAt), updatedAt: timestamp(v.updatedAt) };
}
function timestamp(v: unknown): string { const s = text(v, 40, true); if (!Number.isFinite(Date.parse(s))) throw new MetaMemoryError('META_MEMORY_IMPORT_INVALID', '백업 시각을 확인하세요.'); return s; }
/** Exactly {portId, expectedMemoryId, mode} or {memoryId, mode}; a mixed or extra key is rejected rather than guessed. */
function assignment(a: any): MetaMemoryAssignment {
  if (!a || typeof a !== 'object' || Array.isArray(a) || !['include', 'exclude', 'inherit'].includes(a.mode)) throw new MetaMemoryError('META_MEMORY_INPUT_INVALID', '프로젝트 연결 방식을 확인하세요.');
  const keys = Object.keys(a).sort().join(',');
  if (keys === 'memoryId,mode') return { memoryId: metaMemoryId(a.memoryId), mode: a.mode };
  if (keys === 'expectedMemoryId,mode,portId') return { portId: text(a.portId, 200, true), expectedMemoryId: metaMemoryId(a.expectedMemoryId), mode: a.mode };
  throw new MetaMemoryError('META_MEMORY_INPUT_INVALID', '연결 대상은 {portId, expectedMemoryId, mode} 또는 {memoryId, mode} 중 한 형식으로 보내세요.');
}
const GROUP_OPERATIONS = new Set(['read', 'history', 'export', 'save', 'archive', 'save-entry', 'propose-entry', 'propose-source-entry', 'review-entry', 'review-entries']);
/**
 * One name per id. `groupId` names the common-memory group and `memoryId` a project long-term memory, as in recall,
 * project-links, assignments[].memoryId and evidence[].memoryId. The original request forms named the group `memoryId`
 * at the top level; those stay valid when `groupId` is absent, and this translates the new names to them:
 * - with `groupId`, a top-level `memoryId` on save-entry/propose-entry is the source long-term memory (`sourceMemoryId`);
 *   on any other group operation it must name the same group;
 * - recall takes `memoryId` for the long-term memory (`projectMemoryId` is the same thing).
 * Returns the request in the original field names; other keys pass through for the caller's own unknown-key check.
 */
export function normalizeMetaMemoryVocabulary(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const { groupId, ...rest } = raw as Record<string, any>, op = rest.operation;
  if (op === 'recall') {
    if (groupId !== undefined) throw new MetaMemoryError('META_MEMORY_INPUT_INVALID', 'recall은 공통기억 그룹이 아니라 장기기억(memoryId)이나 portId로 요청하세요.');
    if (rest.memoryId === undefined) return rest;
    if (rest.projectMemoryId !== undefined) throw new MetaMemoryError('META_MEMORY_INPUT_INVALID', '장기기억은 memoryId 하나로만 지정하세요.');
    const { memoryId, ...recall } = rest; return { ...recall, projectMemoryId: memoryId };
  }
  if (groupId === undefined) return rest;
  if (!GROUP_OPERATIONS.has(op)) throw new MetaMemoryError('META_MEMORY_INPUT_INVALID', '이 요청에는 groupId를 쓰지 않습니다.');
  const group = metaMemoryId(groupId);
  if (rest.memoryId !== undefined) {
    if (op === 'save-entry' || op === 'propose-entry') {
      if (rest.sourceMemoryId !== undefined) throw new MetaMemoryError('META_MEMORY_INPUT_INVALID', '출처 장기기억은 memoryId 하나로만 지정하세요.');
      rest.sourceMemoryId = rest.memoryId;
    } else if (metaMemoryId(rest.memoryId) !== group) throw new MetaMemoryError('META_MEMORY_INPUT_INVALID', 'groupId와 memoryId가 다른 공통기억을 가리킵니다. 공통기억은 groupId로만 지정하세요.');
  }
  return { ...rest, memoryId: group };
}
export function parseMetaMemoryRequest(raw: unknown): MetaMemoryRequest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new MetaMemoryError('META_MEMORY_INPUT_INVALID', '공통 기억 요청을 확인하세요.');
  const b = normalizeMetaMemoryVocabulary(raw) as Record<string, any>;
  const op = b.operation;
  if (op === 'list') return { operation: op, query: text(b.query ?? '', 500), offset: integer(b.offset ?? 0, 1000) };
  if (op === 'projects') return { operation: op };
  if (op === 'prepare-project') return { operation: op, portId: text(b.portId, 200, true) };
  if (op === 'read') return { operation: op, memoryId: metaMemoryId(b.memoryId), ...(b.withProjects === false ? { withProjects: false as const } : {}) };
  if (op === 'history' || op === 'export') return { operation: op, memoryId: metaMemoryId(b.memoryId) };
  if (op === 'recall') {
    if ((b.portId === undefined) === (b.projectMemoryId === undefined)) throw new MetaMemoryError('META_MEMORY_INPUT_INVALID', '조회할 프로젝트를 portId 또는 projectMemoryId 중 하나로만 지정하세요.');
    const query = text(b.query, 2000, true);
    return b.portId === undefined ? { operation: op, projectMemoryId: metaMemoryId(b.projectMemoryId), query } : { operation: op, portId: text(b.portId, 200, true), query };
  }
  const mutation = { expectedRevision: integer(b.expectedRevision), requestId: requestToken(b.requestId) };
  if (op === 'import') return { operation: op, ...mutation, snapshot: validateMetaMemorySnapshot(b.snapshot) };
  if (op === 'save') {
    if (b.memoryId === undefined && mutation.expectedRevision !== 0) throw new MetaMemoryError('META_MEMORY_INPUT_INVALID', '공통기억 생성은 memoryId를 생략하고 expectedRevision=0을 사용하세요.');
    if (!Array.isArray(b.assignments ?? []) || (b.assignments ?? []).length > META_COMMON_MEMORY_LIMITS.members) throw new MetaMemoryError('META_MEMORY_INPUT_INVALID', '프로젝트 선택 범위를 확인하세요.');
    const assignments: MetaMemoryAssignment[] = (b.assignments ?? []).map(assignment);
    const ports = assignments.filter(a => !isMemberAssignment(a)) as MetaMemoryPortAssignment[], members = assignments.filter(isMemberAssignment);
    if (new Set(ports.map(a => a.portId)).size !== ports.length) throw new MetaMemoryError('META_MEMORY_INPUT_INVALID', '프로젝트가 중복 선택되었습니다.');
    // A memory named directly appears once, and never also through a project card (main/worktree cards may still share one).
    const memberIds = new Set(members.map(a => a.memoryId));
    if (memberIds.size !== members.length || ports.some(a => memberIds.has(a.expectedMemoryId))) throw new MetaMemoryError('META_MEMORY_INPUT_INVALID', '같은 장기기억이 중복 선택되었습니다.');
    return { operation: op, ...mutation, ...(b.memoryId === undefined ? {} : { memoryId: metaMemoryId(b.memoryId) }), name: text(b.name, 240, true), description: text(b.description ?? '', 2000), tags: list(b.tags ?? []), categories: list(b.categories ?? []), assignments };
  }
  const memoryId = metaMemoryId(b.memoryId);
  if (op === 'archive') { if (typeof b.archived !== 'boolean') throw new MetaMemoryError('META_MEMORY_INPUT_INVALID', '보관 상태를 확인하세요.'); return { operation: op, ...mutation, memoryId, archived: b.archived }; }
  if (op === 'save-entry' || op === 'propose-entry') {
    if (b.portId !== undefined && b.sourceMemoryId !== undefined) throw new MetaMemoryError('META_MEMORY_INPUT_INVALID', '출처는 portId 또는 sourceMemoryId 중 하나로만 지정하세요.');
    return { operation: op, ...mutation, memoryId, ...(b.entryId === undefined ? {} : { entryId: entryId(b.entryId) }), title: text(b.title, 240, true), body: text(b.body, META_COMMON_MEMORY_LIMITS.bodyBytes, true), ...(b.portId === undefined ? {} : { portId: text(b.portId, 200, true) }), ...(b.sourceMemoryId === undefined ? {} : { sourceMemoryId: metaMemoryId(b.sourceMemoryId) }) };
  }
  if (op === 'propose-source-entry') {
    if (!Array.isArray(b.evidence) || !b.evidence.length || b.evidence.length > 16 || !Array.isArray(b.conditions ?? []) || (b.conditions ?? []).length > 16) throw new MetaMemoryError('META_MEMORY_INPUT_INVALID', '원본 근거와 적용 조건의 범위를 확인하세요.');
    const evidence = b.evidence.map((e: any) => {
      if (!e || Object.keys(e).some(key => !['memoryId', 'revisionId', 'entryId', 'contentHash'].includes(key)) || !/^(?:[a-f0-9]{32}|[a-f0-9]{64})$/.test(e.contentHash)) throw new MetaMemoryError('META_MEMORY_INPUT_INVALID', '검증된 원본 항목의 리비전과 hash가 필요합니다.');
      return {memoryId: metaMemoryId(e.memoryId), revisionId: metaMemoryId(e.revisionId), entryId: entryId(e.entryId), contentHash: e.contentHash};
    });
    if (new Set(evidence.map((e: any) => `${e.memoryId}:${e.entryId}`)).size !== evidence.length) throw new MetaMemoryError('META_MEMORY_INPUT_INVALID', '원본 근거가 중복 선택되었습니다.');
    return {operation: op, ...mutation, memoryId, title: text(b.title, 240, true), body: text(b.body, META_COMMON_MEMORY_LIMITS.bodyBytes, true), reason: text(b.reason, 2000, true), category: text(b.category ?? '', 120), conditions: (b.conditions ?? []).map((condition: any) => text(condition, 500, true)), evidence, ...(b.supersedesEntryId === undefined ? {} : {supersedesEntryId: entryId(b.supersedesEntryId)})};
  }
  if (op === 'review-entry') { if (!['active', 'candidate', 'contested', 'superseded'].includes(b.state)) throw new MetaMemoryError('META_MEMORY_INPUT_INVALID', '항목 상태를 확인하세요.'); return { operation: op, ...mutation, memoryId, entryId: entryId(b.entryId), state: b.state }; }
  if (op === 'review-entries') {
    if (!['active', 'superseded'].includes(b.state) || !Array.isArray(b.entryIds) || !b.entryIds.length || b.entryIds.length > 16) throw new MetaMemoryError('META_MEMORY_INPUT_INVALID', '검토할 후보를 1~16개 선택하세요.');
    const entryIds = b.entryIds.map(entryId);
    if (new Set(entryIds).size !== entryIds.length) throw new MetaMemoryError('META_MEMORY_INPUT_INVALID', '검토할 후보가 중복 선택되었습니다.');
    return {operation: op, ...mutation, memoryId, entryIds, state: b.state};
  }
  throw new MetaMemoryError('META_MEMORY_OPERATION_INVALID', '지원하지 않는 공통 기억 동작입니다.');
}
export function metaMemoryApplies(group: Pick<MetaCommonMemory, 'archived' | 'members' | 'categories'>, memoryId: string, category = ''): boolean {
  if (group.archived) return false;
  const explicit = group.members.find(m => m.memoryId === memoryId);
  return explicit ? explicit.mode === 'include' : !!category && group.categories.includes(category.normalize('NFC'));
}
