import { Database, constants } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { META_COMMON_MEMORY_LIMITS as LIMIT, MetaMemoryError, metaMemoryApplies, validateMetaMemorySnapshot, type MetaCommonMemory, type MetaMemoryMember, type MetaMemoryRecall, type MetaMemorySummary } from './metaCommonMemoryContract';
import { recallProjectMemoryEntries } from './projectMemoryRecall';

type GroupRow = { payload: string; revision: number };
export interface MetaMemoryResolvedAssignment extends MetaMemoryMember { mode: 'include' | 'exclude' }
export const META_COMMON_MEMORY_DIRECTORY = 'meta-common-memory-v1';
export type MetaMemoryHandoff={groupId:string;scopeId:string;requestId:string;requestHash:string;sourceFingerprint:string;mode?:'create-cloud'|'follow-cloud';state:'prepared'|'handed-off';cloudVersion:number|null;cloudHash:string|null};
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** One local authority. Group edits, project links, history and retry receipts commit together. */
export class MetaCommonMemoryStore {
  readonly directory: string;
  readonly path: string;
  constructor(appDataDir: string) { this.directory = join(appDataDir, META_COMMON_MEMORY_DIRECTORY); this.path = join(this.directory, 'memories.sqlite'); }
  private safePath(write: boolean): boolean {
    if (!existsSync(this.directory)) { if (!write) return false; mkdirSync(this.directory, { recursive: true, mode: 0o700 }); }
    const dir = lstatSync(this.directory);
    if (!dir.isDirectory() || dir.isSymbolicLink() || (process.platform !== 'win32' && dir.uid !== process.getuid?.())) throw new MetaMemoryError('META_MEMORY_STORAGE_UNSAFE', '공통 기억 저장 위치를 확인하세요.', 503);
    for (const suffix of ['', '-wal', '-shm']) {
      const p = this.path + suffix;
      try {
        const st = lstatSync(p);
        if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || (process.platform !== 'win32' && (st.uid !== process.getuid?.() || (st.mode & 0o077) !== 0))) throw new MetaMemoryError('META_MEMORY_STORAGE_UNSAFE', '공통 기억 저장 파일을 확인하세요.', 503);
      } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
    }
    return existsSync(this.path);
  }
  private db<T>(write: boolean, absent: T, fn: (db: Database) => T): T {
    let db: Database | undefined;
    try {
      const exists = this.safePath(write);
      if (!exists && !write) return absent;
      db = new Database(join(realpathSync(this.directory), 'memories.sqlite'), (write ? constants.SQLITE_OPEN_READWRITE | constants.SQLITE_OPEN_CREATE : constants.SQLITE_OPEN_READONLY) | constants.SQLITE_OPEN_NOFOLLOW);
      if (write && process.platform !== 'win32') chmodSync(this.path, 0o600);
      db.run('PRAGMA busy_timeout=150');
      db.run('PRAGMA foreign_keys=ON');
      db.run('PRAGMA cache_size=-512');
      const version = (db.query('PRAGMA user_version').get() as { user_version: number }).user_version;
      if (version !== 1 && !(version === 0 && !exists && write)) throw new MetaMemoryError('META_MEMORY_VERSION_UNSUPPORTED', '공통 기억 저장소 버전을 확인하세요. 기존 파일은 보존됩니다.', 409);
      if (write) {
        db.run('PRAGMA journal_mode=WAL');
        db.run('PRAGMA synchronous=FULL');
        if (version === 0) db.transaction(() => {
          db!.run(`CREATE TABLE groups (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL, tags TEXT NOT NULL, categories TEXT NOT NULL, archived INTEGER NOT NULL, entry_count INTEGER NOT NULL, candidate_count INTEGER NOT NULL, member_count INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, payload TEXT NOT NULL)`);
          db!.run(`CREATE TABLE members (group_id TEXT NOT NULL REFERENCES groups(id), memory_id TEXT NOT NULL, mode TEXT NOT NULL CHECK(mode IN ('include','exclude')), PRIMARY KEY(group_id,memory_id))`);
          db!.run('CREATE INDEX members_memory ON members(memory_id,mode,group_id)');
          db!.run(`CREATE TABLE revisions (group_id TEXT NOT NULL REFERENCES groups(id), revision INTEGER NOT NULL, request_id TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL, operation TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(group_id,revision))`);
          db!.run('PRAGMA user_version=1');
        }).immediate();
        const pages = db.query('PRAGMA page_count').get() as { page_count: number };
        const size = db.query('PRAGMA page_size').get() as { page_size: number };
        const sideBytes = ['-wal', '-shm'].reduce((bytes, suffix) => { try { return bytes + lstatSync(this.path + suffix).size; } catch (error: any) { if (error.code === 'ENOENT') return bytes; throw error; } }, 0);
        // Leave room for the bounded head/history write; never delete knowledge to meet a budget.
        if (pages.page_count * size.page_size + sideBytes + 4 * 1024 * 1024 >= LIMIT.diskBytes) throw new MetaMemoryError('META_MEMORY_STORAGE_FULL', '공통 기억 저장소가 용량 한도에 도달했습니다. 백업을 내보내고 상태를 확인하세요.', 409);
      }
      return fn(db);
    } catch (e: any) {
      if (e instanceof MetaMemoryError) throw e;
      if(String(e?.message).includes('META_MEMORY_CLOUD_AUTHORITY'))throw new MetaMemoryError('META_MEMORY_CLOUD_AUTHORITY','이 공통기억의 정본은 클라우드입니다. 이관 상태를 확인하세요.',409);
      if (String(e?.code).includes('BUSY') || String(e?.message).includes('locked')) throw new MetaMemoryError('META_MEMORY_BUSY', '다른 공통 기억 저장이 진행 중입니다. 잠시 뒤 다시 시도하세요.', 409);
      const failure = new MetaMemoryError('META_MEMORY_STORAGE_UNAVAILABLE', '공통 기억 저장소를 읽지 못했습니다. 기존 기록을 보존하고 상태를 확인하세요.', 503);
      failure.cause = e; throw failure;
    } finally { db?.close(); }
  }
  private readGroup(db: Database, id: string): MetaCommonMemory {
    const row = db.query('SELECT revision,payload FROM groups WHERE id=?').get(id) as GroupRow | null;
    if (!row) throw new MetaMemoryError('META_MEMORY_NOT_FOUND', '공통 기억을 찾지 못했습니다.', 404);
    const group = validateMetaMemorySnapshot(JSON.parse(row.payload));
    if (group.id !== id || group.revision !== row.revision) throw new MetaMemoryError('META_MEMORY_STORAGE_UNAVAILABLE', '공통 기억의 리비전과 본문이 일치하지 않습니다.', 503);
    return group;
  }
  has(id: string): boolean { return this.db(false, false, db => !!db.query('SELECT 1 FROM groups WHERE id=?').get(id)); }
  read(id: string): MetaCommonMemory { return this.db(false, null as MetaCommonMemory | null, db => this.readGroup(db, id)) ?? (() => { throw new MetaMemoryError('META_MEMORY_NOT_FOUND', '공통 기억을 찾지 못했습니다.', 404); })(); }
  /** unfencedOnly: leave out groups with a cloud handoff receipt (their cloud copy is the authority), with exact paging. */
  list(query = '', offset = 0, options: { unfencedOnly?: boolean } = {}): { memories: MetaMemorySummary[]; nextOffset: number | null; total: number; storage: 'local'; automaticRemoteSync: false } {
    const empty = { memories: [] as MetaMemorySummary[], nextOffset: null as number | null, total: 0, storage: 'local' as const, automaticRemoteSync: false as const };
    return this.db(false, empty, db => {
      const term = query.normalize('NFC').toLowerCase();
      const fenceFilter = options.unfencedOnly && db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='cloud_handoffs'").get() ? ' AND id NOT IN (SELECT group_id FROM cloud_handoffs)' : '';
      const where = "WHERE instr(lower(name || ' ' || description || ' ' || tags),?)>0" + fenceFilter;
      const total = (db.query(`SELECT count(*) AS n FROM groups ${where}`).get(term) as { n: number }).n;
      const rows = db.query(`SELECT id,revision,name,description,tags,categories,archived,entry_count,candidate_count,member_count,created_at,updated_at FROM groups ${where} ORDER BY archived,updated_at DESC,id LIMIT ? OFFSET ?`).all(term, LIMIT.page + 1, offset) as any[];
      return { ...empty, total, nextOffset: rows.length > LIMIT.page ? offset + LIMIT.page : null, memories: rows.slice(0, LIMIT.page).map(r => ({ id: r.id, revision: r.revision, name: r.name, description: r.description, tags: JSON.parse(r.tags), categories: JSON.parse(r.categories), archived: !!r.archived, entryCount: r.entry_count, candidateCount: r.candidate_count, memberCount: r.member_count, createdAt: r.created_at, updatedAt: r.updated_at })) };
    });
  }
  history(id: string) { return this.db(false, [] as Array<{ revision: number; operation: string; createdAt: string }>, db => { this.readGroup(db, id); return (db.query('SELECT revision,operation,created_at FROM revisions WHERE group_id=? ORDER BY revision DESC LIMIT 20').all(id) as any[]).map(r => ({ revision: r.revision, operation: r.operation, createdAt: r.created_at })); }); }
  handoff(id:string):MetaMemoryHandoff|null { return this.db(false,null as MetaMemoryHandoff|null,db=>{
    if(!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='cloud_handoffs'").get())return null;
    const row=db.query('SELECT receipt FROM cloud_handoffs WHERE group_id=?').get(id) as {receipt:string}|null;
    return row?JSON.parse(row.receipt):null;
  }); }
  /** Every local group id split by its cloud fence, across all pages in one read-only open. Before any handoff exists
   *  (no cloud_handoffs table) every group is unfenced; a prepared receipt fences exactly like a completed one. */
  fenceState():{fenced:Set<string>;unfenced:Set<string>}{return this.db(false,{fenced:new Set<string>(),unfenced:new Set<string>()},db=>{
    const fenced=new Set<string>(),unfenced=new Set<string>();
    if(db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='cloud_handoffs'").get())for(const row of db.query('SELECT group_id FROM cloud_handoffs').all() as {group_id:string}[])fenced.add(row.group_id);
    for(const row of db.query('SELECT id FROM groups').all() as {id:string}[])if(!fenced.has(row.id))unfenced.add(row.id);
    return {fenced,unfenced};
  });}
  fencedIds():Set<string>{return this.fenceState().fenced;}
  hasUnfenced():boolean{return this.fenceState().unfenced.size>0;}
  preparedCloudState(id:string):string|null{return this.db(false,null as string|null,db=>{
    if(!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='cloud_handoffs'").get())return null;
    return (db.query('SELECT cloud_state FROM cloud_handoffs WHERE group_id=?').get(id) as {cloud_state:string}|null)?.cloud_state??null;
  });}
  prepareHandoff(input:Omit<MetaMemoryHandoff,'state'|'cloudVersion'|'cloudHash'>,expectedRevision:number,cloudState:string):MetaMemoryHandoff {
    return this.db(true,null as unknown as MetaMemoryHandoff,db=>db.transaction(()=>{
      db.run('CREATE TABLE IF NOT EXISTS cloud_handoffs(group_id TEXT PRIMARY KEY REFERENCES groups(id),receipt TEXT NOT NULL,snapshot TEXT NOT NULL,cloud_state TEXT NOT NULL)');
      // Triggers also stop a writer that checked user_version before waiting for this transaction.
      for(const table of ['groups','members','revisions'])for(const operation of ['INSERT','UPDATE','DELETE']){
        const column=table==='groups'?'id':'group_id',reference=operation==='DELETE'?'OLD':'NEW';
        db.run(`CREATE TRIGGER IF NOT EXISTS cloud_fence_${table}_${operation} BEFORE ${operation} ON ${table} WHEN EXISTS(SELECT 1 FROM cloud_handoffs WHERE group_id=${reference}.${column}) BEGIN SELECT RAISE(ABORT,'META_MEMORY_CLOUD_AUTHORITY'); END`);
      }
      const prior=db.query('SELECT receipt FROM cloud_handoffs WHERE group_id=?').get(input.groupId) as {receipt:string}|null;
      if(prior){const r=JSON.parse(prior.receipt) as MetaMemoryHandoff;if(r.scopeId!==input.scopeId||r.requestId!==input.requestId||r.requestHash!==input.requestHash||r.sourceFingerprint!==input.sourceFingerprint||(r.mode??'create-cloud')!==(input.mode??'create-cloud'))throw new MetaMemoryError('META_MEMORY_HANDOFF_CONFLICT','같은 공통기억의 원래 이관 요청을 확인하세요.',409);return r;}
      const snapshot=this.readGroup(db,input.groupId);
      if(snapshot.revision!==expectedRevision||digest(snapshot)!==input.sourceFingerprint)throw new MetaMemoryError('META_MEMORY_CONFLICT','기존 공통기억이 바뀌었습니다. 이관 계획을 다시 확인하세요.',409);
      const receipt:MetaMemoryHandoff={...input,state:'prepared',cloudVersion:null,cloudHash:null};
      // Original groups, members and every historical revision remain unchanged beside this fence.
      db.query('INSERT INTO cloud_handoffs VALUES(?,?,?,?)').run(input.groupId,JSON.stringify(receipt),JSON.stringify(snapshot),cloudState);return receipt;
    }).immediate());
  }
  completeHandoff(expected:MetaMemoryHandoff,version:number,stateHash:string):MetaMemoryHandoff {
    return this.db(true,null as unknown as MetaMemoryHandoff,db=>db.transaction(()=>{
      const row=db.query('SELECT receipt FROM cloud_handoffs WHERE group_id=?').get(expected.groupId) as {receipt:string}|null;
      if(!row)throw new MetaMemoryError('META_MEMORY_HANDOFF_CONFLICT','이관 준비 영수증을 찾지 못했습니다.',409);
      const current=JSON.parse(row.receipt) as MetaMemoryHandoff;
      if(current.requestId!==expected.requestId||current.requestHash!==expected.requestHash||current.scopeId!==expected.scopeId||!Number.isSafeInteger(version)||version<1||!/^[a-f0-9]{64}$/.test(stateHash))throw new MetaMemoryError('META_MEMORY_HANDOFF_CONFLICT','클라우드 이관 영수증을 다시 확인하세요.',409);
      const receipt:MetaMemoryHandoff={...current,state:'handed-off',cloudVersion:version,cloudHash:stateHash};
      db.query('UPDATE cloud_handoffs SET receipt=? WHERE group_id=?').run(JSON.stringify(receipt),receipt.groupId);return receipt;
    }).immediate());
  }
  replay(id: string, requestId: string, request: unknown): MetaCommonMemory | null {
    return this.db(false, null as MetaCommonMemory | null, db => {
      const row = db.query('SELECT group_id,request_hash,payload FROM revisions WHERE request_id=?').get(requestId) as { group_id: string; request_hash: string; payload: string } | null;
      if (!row) return null;
      if (row.group_id !== id || row.request_hash !== digest(request)) throw new MetaMemoryError('META_MEMORY_REQUEST_REUSED', '같은 요청 ID로 다른 내용을 저장할 수 없습니다.', 409);
      return validateMetaMemorySnapshot(JSON.parse(row.payload));
    });
  }
  mutate(input: { id: string; expectedRevision: number; requestId: string; operation: string; request: unknown; create?: boolean }, edit: (group: MetaCommonMemory) => MetaCommonMemory): MetaCommonMemory {
    return this.db(true, null as unknown as MetaCommonMemory, db => db.transaction(() => {
      const hash = digest(input.request);
      const previous = db.query('SELECT group_id,request_hash,payload FROM revisions WHERE request_id=?').get(input.requestId) as { group_id: string; request_hash: string; payload: string } | null;
      if (previous) {
        if (previous.group_id !== input.id || previous.request_hash !== hash) throw new MetaMemoryError('META_MEMORY_REQUEST_REUSED', '같은 요청 ID로 다른 내용을 저장할 수 없습니다.', 409);
        return validateMetaMemorySnapshot(JSON.parse(previous.payload));
      }
      let group: MetaCommonMemory;
      if (input.create) {
        if (input.expectedRevision !== 0 || db.query('SELECT 1 FROM groups WHERE id=?').get(input.id)) throw new MetaMemoryError('META_MEMORY_CONFLICT', '기존 공통 기억을 다시 조회하세요.', 409);
        if ((db.query('SELECT count(*) AS n FROM groups').get() as { n: number }).n >= LIMIT.groups) throw new MetaMemoryError('META_MEMORY_CAPACITY', '공통 기억 수 한도에 도달했습니다. 기존 기록을 확인하세요.', 409);
        const now = new Date().toISOString();
        group = { id: input.id, revision: 0, name: '공통 기억', description: '', tags: [], categories: [], archived: false, entries: [], members: [], createdAt: now, updatedAt: now };
      } else {
        group = this.readGroup(db, input.id);
        if (group.revision !== input.expectedRevision) throw new MetaMemoryError('META_MEMORY_CONFLICT', '다른 창 또는 AI가 먼저 저장했습니다. 입력을 보존하고 최신 기억을 다시 조회하세요.', 409);
      }
      const next = validateMetaMemorySnapshot({ ...edit(structuredClone(group)), id: group.id, revision: group.revision + 1, updatedAt: new Date().toISOString() });
      const payload = JSON.stringify(next);
      if (Buffer.byteLength(payload) > 512 * 1024) throw new MetaMemoryError('META_MEMORY_CAPACITY', '이 공통 기억은 512 KiB까지입니다. 주제를 나누고 기존 기록은 보존하세요.', 409);
      db.query(`INSERT INTO groups VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,name=excluded.name,description=excluded.description,tags=excluded.tags,categories=excluded.categories,archived=excluded.archived,entry_count=excluded.entry_count,candidate_count=excluded.candidate_count,member_count=excluded.member_count,updated_at=excluded.updated_at,payload=excluded.payload`).run(next.id, next.revision, next.name, next.description, JSON.stringify(next.tags), JSON.stringify(next.categories), Number(next.archived), next.entries.filter(e => e.state === 'active' || e.state === 'contested').length, next.entries.filter(e => e.state === 'candidate').length, next.members.filter(m => m.mode === 'include').length, next.createdAt, next.updatedAt, payload);
      db.query('DELETE FROM members WHERE group_id=?').run(next.id);
      const insert = db.query('INSERT INTO members(group_id,memory_id,mode) VALUES (?,?,?)');
      for (const member of next.members) insert.run(next.id, member.memoryId, member.mode);
      db.query('INSERT INTO revisions VALUES (?,?,?,?,?,?,?)').run(next.id, next.revision, input.requestId, hash, input.operation, payload, next.updatedAt);
      return next;
    }).immediate());
  }
  recall(memoryId: string, query: string, category = ''): MetaMemoryRecall {
    const empty: MetaMemoryRecall = { state: 'ready', groups: [], hits: [], truncated: false };
    return this.db(false, empty, db => {
      // Index explicit links first. Category rules are bounded by the group capacity; never recurse.
      const rows = db.query(`SELECT g.id FROM groups g LEFT JOIN members m ON m.group_id=g.id AND m.memory_id=? WHERE g.archived=0 AND (m.mode='include' OR (m.mode IS NULL AND EXISTS(SELECT 1 FROM json_each(g.categories) WHERE value=?))) ORDER BY g.id LIMIT ?`).all(memoryId, category.normalize('NFC'), LIMIT.recallGroups + 1) as { id: string }[];
      const groups = rows.slice(0, LIMIT.recallGroups).map(r => this.readGroup(db, r.id));
      const hits = groups.flatMap(g => {
        if (!metaMemoryApplies(g, memoryId, category)) return [];
        const entries = g.entries.filter(e => e.state === 'active' || e.state === 'contested');
        return entries.flatMap(e => {
          // A stored body's Markdown headings/ID examples must never manufacture other entries.
          const document = `## Meta Common Memory\n\n### ${e.title.replace(/\s+/g, ' ')}\n<!-- memory-entry-id:${e.id} -->\n${e.body.replace(/^#{1,6}\s/gm, '')}`;
          return recallProjectMemoryEntries(document, query, { limit: 1 }).filter(hit => hit.entryId === e.id).map(hit => ({ memoryId: g.id, memoryName: g.name, revision: g.revision, entryId: e.id, title: e.title, body: e.body, state: e.state as 'active' | 'contested', score: hit.score }));
        });
      }).sort((a, b) => b.score - a.score || a.memoryId.localeCompare(b.memoryId) || a.entryId.localeCompare(b.entryId));
      const provenance = groups.map(g => ({ id: g.id, name: g.name, revision: g.revision }));
      let bytes = Buffer.byteLength(JSON.stringify({ state: 'ready', groups: provenance, hits: [], truncated: false }));
      const selected: typeof hits = [];
      for (const hit of hits) {
        const size = Buffer.byteLength(JSON.stringify(hit)) + (selected.length ? 1 : 0);
        if (selected.length >= LIMIT.recallHits || bytes + size > LIMIT.recallBytes) break;
        selected.push(hit); bytes += size;
      }
      const result: MetaMemoryRecall = { state: 'ready', groups: provenance, hits: selected, truncated: rows.length > groups.length || hits.length > selected.length };
      // Escaped labels can occupy more JSON bytes than their UTF-8 input. The complete
      // response, including provenance, must honor the same budget in every case.
      while (Buffer.byteLength(JSON.stringify(result)) > LIMIT.recallBytes) {
        if (result.hits.length) result.hits.pop(); else result.groups.pop();
        result.truncated = true;
      }
      return result;
    });
  }
}
