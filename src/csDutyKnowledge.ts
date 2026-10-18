import { Database } from 'bun:sqlite';
import { chmodSync, existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { DutySources, DutyKnowledgeFailure, DUTY_TOTAL_BYTES, sourceHash } from './csDutySources';
import { EMPTY_DUTY_KNOWLEDGE, type DutySourceSelection, type DutySourceBody, type DutyKnowledgeStatus, type DutyKnowledgeJob, type DutyKnowledgeCandidate, type DutyEvidence } from './csDutyKnowledgeTypes';

const fail = (s: string): never => { throw new DutyKnowledgeFailure(s); };
const hashPattern = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9-]{36}$/;
const yieldTurn = () => new Promise<void>(resolve => setTimeout(resolve, 0));
/** Word + Hangul bigram terms support Korean spacing variants without a remote embedding call. */
export function dutySearchTerms(text: string): string[] {
    const words = text.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
    const terms = new Set<string>();
    for (const word of words) {
        if (word.length > 1) terms.add(word.slice(0, 80));
        if (/^[가-힣]+$/.test(word)) for (let i = 0; i + 1 < word.length; i++) terms.add(word.slice(i, i + 2));
    }
    return [...terms];
}
function splitBody(body: string): string[] {
    const result: string[] = []; let chunk = '';
    for (const paragraph of body.split(/\n\s*\n/)) {
        for (const line of paragraph.match(/[\s\S]{1,900}/gu) ?? []) {
            if (chunk.length + line.length > 1200 && chunk) { result.push(chunk); chunk = ''; }
            chunk += (chunk ? '\n\n' : '') + line;
        }
    }
    if (chunk.trim()) result.push(chunk);
    return result;
}
type Grant = { revision: number; snapshot: string | null; identity: string; chat: string; expires: number; revoked: number };
type Header = { id: string; target: string; identity: string; chat: string; revision: number; hash: string; created: number; metadata: string; bytes: number };
type Job = { view: DutyKnowledgeJob; abort: AbortController; promise: Promise<void> };

/** Grants and the active snapshot pointer commit together. Index data never grants access. */
export class DutyKnowledge {
    private db: Database;
    private jobs = new Map<string, Job>();
    private closed = false;
    private building = 0;
    private reading = false;
    private generation = new Map<string, number>();
    constructor(root: string, private sources: DutySources, private identity: (target: string) => Promise<string>, private now = Date.now) {
        const dir = join(realpathSync(root), 'cs-duty');
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        if (realpathSync(dir) !== dir || lstatSync(dir).mode & 0o077) fail('자료 저장소 권한을 확인하세요.');
        const file = join(dir, 'knowledge.sqlite');
        for (const p of [file, file + '-wal', file + '-shm', file + '-journal'])
            if (existsSync(p) && (!lstatSync(p).isFile() || lstatSync(p).isSymbolicLink() || lstatSync(p).mode & 0o077)) fail('자료 저장소 파일을 확인하세요.');
        this.db = new Database(file, { create: true });
        chmodSync(file, 0o600);
        this.db.exec('PRAGMA journal_mode=DELETE; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON; PRAGMA max_page_count=131072;');
        const version = (this.db.query('PRAGMA user_version').get() as { user_version: number }).user_version;
        if (version !== 0 && version !== 1) { this.db.close(); fail('검색 자료 저장소를 읽으려면 앱을 업데이트하세요.'); }
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS grants(target TEXT PRIMARY KEY, revision INTEGER NOT NULL, snapshot TEXT, identity TEXT NOT NULL, chat TEXT NOT NULL, expires INTEGER NOT NULL, revoked INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS snapshots(id TEXT PRIMARY KEY, target TEXT NOT NULL, identity TEXT NOT NULL, chat TEXT NOT NULL, revision INTEGER NOT NULL, hash TEXT NOT NULL, created INTEGER NOT NULL, metadata TEXT NOT NULL, bytes INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS sources(snapshot TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE, id TEXT NOT NULL, hash TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(snapshot,id));
            CREATE TABLE IF NOT EXISTS chunks(id TEXT NOT NULL, snapshot TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE, source TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(snapshot,id));
            CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(snapshot UNINDEXED, id UNINDEXED, terms);
            PRAGMA user_version=1;
        `);
        // Rebuild the disposable index only from approved/staged chunk rows, never from live files.
        const counts = this.db.query('SELECT (SELECT count(*) FROM chunks) AS chunks,(SELECT count(*) FROM search) AS indexed').get() as { chunks: number; indexed: number };
        if (counts.chunks !== counts.indexed) {
            if (counts.chunks > 640_000) { this.db.close(); fail('검색 자료 복구 예산을 초과했습니다.'); }
            this.db.transaction(() => {
                this.db.exec('DELETE FROM search');
                for (const row of this.db.query('SELECT snapshot,id,title,body FROM chunks').iterate() as Iterable<{snapshot:string;id:string;title:string;body:string}>)
                    this.db.query('INSERT INTO search VALUES(?,?,?)').run(row.snapshot,row.id,dutySearchTerms(row.title+'\n'+row.body).join(' '));
            })();
        }
        // Unapproved interrupted builds have no authority. Reclaim only these derived candidates.
        this.db.transaction(() => {
            this.db.exec('DELETE FROM search WHERE snapshot NOT IN (SELECT snapshot FROM grants WHERE snapshot IS NOT NULL); DELETE FROM snapshots WHERE id NOT IN (SELECT snapshot FROM grants WHERE snapshot IS NOT NULL);');
        })();
    }
    private async collect(...args: Parameters<DutySources['collect']>) {
        this.ensure();
        if (this.reading) return fail('다른 자료를 확인 중입니다. 잠시 후 다시 시도하세요.');
        this.reading = true;
        try { return await this.sources.collect(...args); }
        catch (e) { if (e instanceof DutyKnowledgeFailure) throw e; return fail('자료를 읽지 못했습니다. 원본 파일과 접근 권한을 확인하세요.'); }
        finally { this.reading = false; }
    }
    private ensure() { if (this.closed) fail('자료 작업이 종료되었습니다.'); }
    private grant(target: string): Grant | null { this.ensure(); return this.db.query('SELECT revision,snapshot,identity,chat,expires,revoked FROM grants WHERE target=?').get(target) as Grant | null; }
    private header(id: string): Header { const h = this.db.query('SELECT * FROM snapshots WHERE id=?').get(id) as Header | null; if (!h) return fail('검색 자료 버전을 찾지 못했습니다.'); return h; }
    status(target: string): DutyKnowledgeStatus {
        const g = this.grant(target);
        if (!g) return structuredClone(EMPTY_DUTY_KNOWLEDGE);
        const h = g.snapshot ? this.header(g.snapshot) : null;
        return { revision: g.revision, snapshotId: g.snapshot, createdAt: h?.created ?? null, expiresAt: g.expires || null,
            sources: h ? JSON.parse(h.metadata) : [], sourceCount: h ? JSON.parse(h.metadata).length : 0,
            state: g.revoked ? 'revoked' : this.now() >= g.expires ? 'expired' : h ? 'ready' : 'empty' };
    }
    async catalog(target: string, includeMemory: boolean, signal: AbortSignal) {
        this.ensure(); const before = await this.identity(target);
        const result = await this.collect(target, includeMemory, signal);
        if (before !== await this.identity(target)) return fail('프로젝트가 변경되었습니다.');
        return result.catalog;
    }
    async sourcePreview(target: string, selection: DutySourceSelection, includeMemory: boolean, signal: AbortSignal) {
        if (!hashPattern.test(selection?.id) || !hashPattern.test(selection?.hash)) return fail('선택한 자료를 확인하세요.');
        const before = await this.identity(target);
        const result = await this.collect(target, includeMemory, signal, new Set([selection.id]));
        const body = result.bodies.get(selection.id);
        if (!body || body.hash !== selection.hash || before !== await this.identity(target)) return fail('자료가 바뀌었습니다. 목록을 다시 확인하세요.');
        return body;
    }
    prepare(target: string, selections: DutySourceSelection[], includeMemory: boolean, revision: number, chat: string): DutyKnowledgeJob {
        this.ensure();
        if (!Array.isArray(selections) || !selections.length || selections.length > 200 || selections.some(s => !s || !hashPattern.test(s.id) || !hashPattern.test(s.hash)) || new Set(selections.map(s => s.id)).size !== selections.length)
            return fail('서로 다른 자료를 1~200개 선택하세요.');
        if (this.status(target).revision !== revision) return fail('다른 화면에서 자료가 바뀌었습니다. 다시 확인하세요.');
        if (this.building >= 1) return fail('다른 검색 자료를 만드는 중입니다. 완료 후 다시 시도하세요.');
        if (!this.jobs.has(target) && this.jobs.size >= 64) return fail('자료 작업은 최대 64개 프로젝트까지 지원합니다.');
        const abort = new AbortController(), id = crypto.randomUUID();
        const job: Job = { view: { id, state: 'building' }, abort, promise: Promise.resolve() };
        const gen = this.generation.get(target) ?? 0;
        this.jobs.set(target, job); this.building++;
        job.promise = this.build(target, structuredClone(selections), includeMemory, revision, chat, gen, job)
            .catch(e => { job.view = { id, state: abort.signal.aborted ? 'cancelled' : 'failed', error: e instanceof DutyKnowledgeFailure ? e.message : '자료를 만들지 못했습니다. 원본과 저장 공간을 확인하세요.' }; })
            .finally(() => { this.building--; });
        return structuredClone(job.view);
    }
    private async build(target: string, selections: DutySourceSelection[], includeMemory: boolean, revision: number, chat: string, generation: number, job: Job) {
        const signal = AbortSignal.any([job.abort.signal, AbortSignal.timeout(60_000)]);
        const identity = await this.identity(target);
        const result = await this.collect(target, includeMemory, signal, new Set(selections.map(s => s.id)));
        const bodies = selections.map(s => {
            const found = result.bodies.get(s.id);
            if (!found || found.hash !== s.hash) return fail('선택 이후 자료가 바뀌었습니다. 목록을 다시 확인하세요.');
            return found;
        });
        const bytes = bodies.reduce((n, s) => n + s.bytes, 0);
        const used = (this.db.query('SELECT coalesce(sum(bytes),0) AS n FROM snapshots').get() as { n: number }).n;
        if (bytes > DUTY_TOTAL_BYTES || used + bytes > 100 * 1024 * 1024) return fail('자료 저장 예산에 도달했습니다. 선택을 줄이거나 불필요한 공유를 해제하세요.');
        const old = this.status(target), oldSources = new Map(old.sources.map(s => [s.id, s.hash]));
        const metadata = bodies.map(({ body, ...s }) => s);
        const manifestHash = sourceHash(JSON.stringify([identity, chat, metadata]));
        const snapshot = job.view.id;
        const check = () => {
            signal.throwIfAborted();
            if (this.closed || (this.generation.get(target) ?? 0) !== generation || this.status(target).revision !== revision) fail('자료 작업 중 설정이 바뀌었습니다. 다시 시작하세요.');
        };
        check();
        this.db.transaction(() => {
            const stale = this.db.query('SELECT id FROM snapshots WHERE target=? AND id NOT IN (SELECT snapshot FROM grants WHERE snapshot IS NOT NULL)').all(target) as { id: string }[];
            for (const s of stale) this.removeSnapshot(s.id);
            this.db.query('INSERT INTO snapshots VALUES(?,?,?,?,?,?,?,?,?)').run(snapshot, target, identity, chat, revision, manifestHash, this.now(), JSON.stringify(metadata), bytes);
        })();
        let count = 0, reused = 0;
        try {
            for (const source of bodies) {
                check();
                this.db.query('INSERT INTO sources VALUES(?,?,?,?)').run(snapshot, source.id, source.hash, source.body);
                if (old.snapshotId && oldSources.get(source.id) === source.hash) {
                    this.db.transaction(() => {
                        this.db.query('INSERT INTO chunks SELECT id,?,source,title,body FROM chunks WHERE snapshot=? AND source=?').run(snapshot, old.snapshotId!, source.id);
                        this.db.query('INSERT INTO search SELECT ?,search.id,search.terms FROM search JOIN chunks ON search.snapshot=chunks.snapshot AND search.id=chunks.id WHERE chunks.snapshot=? AND chunks.source=?').run(snapshot, old.snapshotId!, source.id);
                    })();
                    reused++;
                } else {
                    const chunks = splitBody(source.body);
                    for (let i = 0; i < chunks.length; i++) {
                        check();
                        if (++count > 20_000) fail('검색 구간 상한을 초과했습니다. 자료를 줄여 주세요.');
                        const body = chunks[i]!, id = sourceHash(source.id + '\n' + i + '\n' + body);
                        this.db.transaction(() => {
                            this.db.query('INSERT INTO chunks VALUES(?,?,?,?,?)').run(id, snapshot, source.id, source.title, body);
                            this.db.query('INSERT INTO search VALUES(?,?,?)').run(snapshot, id, dutySearchTerms(source.title + '\n' + body).join(' '));
                        })();
                        if (i % 16 === 0) await yieldTurn();
                    }
                }
                await yieldTurn();
            }
            check();
            const totalChunks = (this.db.query('SELECT count(*) AS n FROM chunks WHERE snapshot=?').get(snapshot) as {n:number}).n;
            if (totalChunks > 20_000) fail('검색 구간 상한을 초과했습니다.');
            if (identity !== await this.identity(target)) fail('프로젝트가 변경되었습니다.');
            check();
            const candidate: DutyKnowledgeCandidate = { id: snapshot, manifestHash, sources: metadata, bytes, reused, changed: bodies.length - reused, removed: old.sources.filter(s => !bodies.some(b => b.id === s.id)).length };
            job.view = { id: snapshot, state: 'ready', candidate };
        } catch (e) { this.removeSnapshot(snapshot); throw e; }
    }
    private removeSnapshot(id: string) { this.db.query('DELETE FROM search WHERE snapshot=?').run(id); this.db.query('DELETE FROM snapshots WHERE id=?').run(id); }
    job(target: string): DutyKnowledgeJob | null { this.ensure(); return structuredClone(this.jobs.get(target)?.view ?? null); }
    cancel(target: string) { this.jobs.get(target)?.abort.abort(); }
    candidatePreview(target: string, candidateId: string, sourceId: string): DutySourceBody {
        const j = this.job(target);
        if (j?.state !== 'ready' || j.candidate?.id !== candidateId) return fail('검토할 후보를 다시 만들어 주세요.');
        const source = j.candidate.sources.find(s => s.id === sourceId);
        const row = this.db.query('SELECT body FROM sources WHERE snapshot=? AND id=?').get(candidateId, sourceId) as { body: string } | null;
        if (!source || !row) return fail('선택한 자료를 찾지 못했습니다.');
        return { ...source, body: row.body };
    }
    async apply(target: string, id: string, hash: string, revision: number, chat: string) {
        this.ensure();
        const identity = await this.identity(target);
        const j = this.job(target);
        if (!UUID.test(id) || !hashPattern.test(hash) || j?.state !== 'ready' || j.candidate?.id !== id) return fail('검토한 자료 후보를 선택하세요.');
        const h = this.header(id);
        if (h.target !== target || h.identity !== identity || h.chat !== chat || h.hash !== hash || h.revision !== revision || this.status(target).revision !== revision)
            return fail('자료·채팅방 또는 프로젝트가 바뀌었습니다. 다시 검토하세요.');
        this.db.transaction(() => {
            const old = this.grant(target);
            this.db.query('INSERT OR REPLACE INTO grants VALUES(?,?,?,?,?,?,0)').run(target, revision + 1, id, identity, chat, this.now() + 90 * 86400000);
            if (old?.snapshot && old.snapshot !== id) this.removeSnapshot(old.snapshot);
        })();
        this.generation.set(target, (this.generation.get(target) ?? 0) + 1);
        this.jobs.delete(target);
        return this.status(target);
    }
    revoke(target: string) {
        if (!this.grant(target) && !this.jobs.has(target)) return this.status(target);
        this.cancel(target);
        this.generation.set(target, (this.generation.get(target) ?? 0) + 1);
        const old = this.grant(target);
        this.db.transaction(() => {
            this.db.query('INSERT OR REPLACE INTO grants VALUES(?,?,?,?,?,?,1)').run(target, (old?.revision ?? 0) + 1, null, old?.identity ?? '', old?.chat ?? '', 0);
            const rows = this.db.query('SELECT id FROM snapshots WHERE target=?').all(target) as { id: string }[];
            for (const r of rows) this.removeSnapshot(r.id);
        })();
        return this.status(target);
    }
    /** Synchronous guard can run immediately before spawning a send, with no await gap. */
    assert(target: string, chat: string, snapshot: string | null) {
        const g = this.grant(target);
        if (snapshot === null) { if (g?.snapshot) fail('공유 자료가 변경되었습니다. 다시 켜세요.'); return; }
        if (!g || g.revoked || this.now() >= g.expires || g.chat !== chat || g.snapshot !== snapshot) fail('공유 자료가 변경·해제되었거나 만료되었습니다. 다시 확인하세요.');
    }
    async validate(target: string, chat: string, snapshot: string | null) {
        this.assert(target, chat, snapshot);
        const g = this.grant(target);
        if (g?.snapshot && g.identity !== await this.identity(target)) fail('공유 자료의 프로젝트가 변경되었습니다. 다시 만드세요.');
        this.assert(target, chat, snapshot);
    }
    search(target: string, chat: string, snapshot: string | null, question: string): DutyEvidence[] {
        this.assert(target, chat, snapshot);
        if (!snapshot) return [];
        const terms = dutySearchTerms(question).slice(0, 32);
        if (!terms.length) return [];
        const query = terms.map(t => '"' + t.replace(/"/g, '""') + '"').join(' OR ');
        const rows = this.db.query(`SELECT chunks.id, chunks.title, chunks.body, bm25(search) AS score FROM search JOIN chunks ON search.snapshot=chunks.snapshot AND search.id=chunks.id WHERE search MATCH ? AND search.snapshot=? ORDER BY score LIMIT 24`).all(query, snapshot) as DutyEvidence[];
        let bytes = 0;
        return rows.filter(r => { if (bytes + Buffer.byteLength(r.body) > 16 * 1024) return false; bytes += Buffer.byteLength(r.body); return true; }).slice(0, 6);
    }
    async updates(target: string, signal: AbortSignal) {
        const status = this.status(target);
        const identity = await this.identity(target);
        const { catalog } = await this.collect(target, status.sources.some(s => s.kind === 'memory'), signal, new Set(status.sources.map(s => s.id)));
        if (identity !== await this.identity(target)) fail('프로젝트가 변경되었습니다.');
        const current = new Map(catalog.sources.map(s => [s.id, s]));
        return { changed: status.sources.filter(s => current.has(s.id) && current.get(s.id)!.hash !== s.hash).map(s => s.title), removed: status.sources.filter(s => !current.has(s.id)).map(s => s.title), checkedAt: this.now() };
    }
    async shutdown() {
        if (this.closed) return;
        this.closed = true;
        for (const j of this.jobs.values()) j.abort.abort();
        await Promise.allSettled([...this.jobs.values()].map(j => j.promise));
        this.jobs.clear(); this.db.close();
    }
}
