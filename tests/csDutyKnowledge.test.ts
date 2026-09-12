import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from 'bun:sqlite';
import { DutySources } from '../src/csDutySources';
import { DutyKnowledge } from '../src/csDutyKnowledge';
import { CsDuty, type DutyConfig, type DutyHost, type DutyMessage, type DutyState } from '../src/csDuty';
import { validDutyOperation } from '../src/csDutyOperations';
import { createCsDutyHost, dutyGroundedAnswer } from '../src/csDutyHost';
const target = 'project-knowledge', chat = 'chat_fixture', signal = () => AbortSignal.timeout(5000);
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
function setup() {
    const root = mkdtempSync(join(tmpdir(), 'cs-rag-')), app = join(root, 'app'), project = join(root, 'project');
    mkdirSync(app); mkdirSync(project);
    writeFileSync(join(project, 'hours.md'), '# 문의 시간\n\n고객센터는 평일 오전 9시부터 오후 5시까지 운영합니다.');
    writeFileSync(join(project, 'private.md'), '# 비공개\n\n배포 비밀번호 CANARY_UNSELECTED_814');
    let identity = 'project-identity', now = 1_800_000_000_000, reads = 0;
    const sources = new DutySources(async () => { reads++; return project; }, async () => ({ memoryId: 'memory-1', body: '## 운영\n### 지원 연락처\n<!-- memory-entry-id:contact-1 -->\n지원 문의는 support@example.test로 보냅니다.\n\n### 내부 지침\nCANARY_MEMORY_PRIVATE_927' }));
    const create = () => new DutyKnowledge(app, sources, async () => identity, () => now);
    let k = create();
    cleanups.push(async () => { await k.shutdown(); rmSync(root, { recursive: true, force: true }); });
    return { root, app, project, sources, get k() { return k; }, get reads() { return reads; }, set identity(v: string) { identity = v; }, set now(v: number) { now = v; }, async restart() { await k.shutdown(); k = create(); return k; } };
}
async function waitReady(k: DutyKnowledge) {
    for (let i = 0; i < 500 && k.job(target)?.state === 'building'; i++) await Bun.sleep(5);
    const job = k.job(target);
    if (job?.state !== 'ready') throw Error(JSON.stringify(job));
    return job.candidate!;
}
async function prepare(f: ReturnType<typeof setup>, names = ['hours.md'], memory = false) {
    const catalog = await f.k.catalog(target, memory, signal());
    const selected = catalog.sources.filter(s => names.some(n => s.title.includes(n))).map(s => ({ id: s.id, hash: s.hash }));
    f.k.prepare(target, selected, memory, f.k.status(target).revision, chat);
    return waitReady(f.k);
}
async function apply(f: ReturnType<typeof setup>, names?: string[], memory = false) {
    const c = await prepare(f, names, memory);
    return f.k.apply(target, c.id, c.manifestHash, f.k.status(target).revision, chat);
}

describe('approved duty knowledge', () => {
    test('only selected documents and memory enter retrieval; repeated questions do not read sources', async () => {
        const f = setup(), status = await apply(f, ['hours.md', '지원 연락처'], true), reads = f.reads;
        expect(status.sourceCount).toBe(2);
        expect(f.k.search(target, chat, status.snapshotId, '문의 시간').some(x => x.body.includes('오전 9시'))).toBe(true);
        expect(f.k.search(target, chat, status.snapshotId, '지원 연락처').some(x => x.body.includes('support@example.test'))).toBe(true);
        for (let i = 0; i < 40; i++) {
            const answer = f.k.search(target, chat, status.snapshotId, 'CANARY_UNSELECTED_814 CANARY_MEMORY_PRIVATE_927 비공개 내부');
            expect(JSON.stringify(answer)).not.toContain('CANARY_');
        }
        expect(f.reads).toBe(reads);
    });
    test('candidate review uses the frozen body, not a later source edit; applying does not silently share new content', async () => {
        const f = setup(), c = await prepare(f);
        writeFileSync(join(f.project, 'hours.md'), 'CHANGED_AFTER_REVIEW');
        expect(f.k.candidatePreview(target, c.id, c.sources[0]!.id).body).toContain('오전 9시');
        const s = await f.k.apply(target, c.id, c.manifestHash, 0, chat);
        expect(f.k.search(target, chat, s.snapshotId, '문의 시간')[0]?.body).toContain('오전 9시');
        const updates = await f.k.updates(target, signal()); expect(updates.changed).toEqual(['hours.md']);
    });
    test('updates reuse unchanged chunks, retain active version until apply, and do not auto-select new files', async () => {
        const f = setup(), old = await apply(f);
        let c = await prepare(f); expect(c.reused).toBe(1); expect(c.changed).toBe(0);
        writeFileSync(join(f.project, 'hours.md'), '# 문의 시간\n새 운영 시간은 오전 10시입니다.');
        writeFileSync(join(f.project, 'new.md'), 'NEW_CANARY_516');
        c = await prepare(f); expect(c.changed).toBe(1); expect(c.sources.length).toBe(1);
        expect(f.k.search(target, chat, old.snapshotId, '문의 시간')[0]?.body).toContain('오전 9시');
        const next = await f.k.apply(target, c.id, c.manifestHash, old.revision, chat);
        expect(() => f.k.search(target, chat, old.snapshotId, '문의')).toThrow();
        expect(f.k.search(target, chat, next.snapshotId, '문의 시간')[0]?.body).toContain('오전 10시');
        expect(f.k.search(target, chat, next.snapshotId, 'NEW_CANARY_516')).toEqual([]);
    });
    test('revocation, expiry, wrong room and moved project deny access', async () => {
        const f = setup(), s = await apply(f);
        expect(() => f.k.search(target, 'chat_other', s.snapshotId, '문의')).toThrow();
        f.identity = 'moved'; await expect(f.k.validate(target, chat, s.snapshotId)).rejects.toThrow(); f.identity = 'project-identity';
        f.now = s.expiresAt!; expect(f.k.status(target).state).toBe('expired');
        expect(() => f.k.search(target, chat, s.snapshotId, '문의')).toThrow();
        f.k.revoke(target); expect(f.k.status(target).state).toBe('revoked');
        expect(() => f.k.assert(target, chat, s.snapshotId)).toThrow();
    });
    test('restart retains approved sources and never promotes an unapproved candidate', async () => {
        const f = setup(), s = await apply(f); await prepare(f, ['private.md']);
        await f.restart(); expect(f.k.status(target)).toEqual(s);
        expect(f.k.search(target, chat, s.snapshotId, 'CANARY_UNSELECTED_814')).toEqual([]);
        expect(f.k.job(target)).toBeNull();
    });
    test('wrong hash / stale revision / revoked candidate cannot apply', async () => {
        const f = setup(), c = await prepare(f);
        await expect(f.k.apply(target, c.id, 'a'.repeat(64), 0, chat)).rejects.toThrow();
        await expect(f.k.apply(target, c.id, c.manifestHash, 1, chat)).rejects.toThrow();
        f.k.revoke(target); await expect(f.k.apply(target, c.id, c.manifestHash, 0, chat)).rejects.toThrow();
    });
    test('cancelled building never replaces active snapshot', async () => {
        const f = setup(), s = await apply(f);
        const catalog = await f.k.catalog(target, false, signal());
        f.k.prepare(target, catalog.sources.map(({ id, hash }) => ({ id, hash })), false, s.revision, chat);
        f.k.cancel(target);
        for (let i = 0; i < 100 && f.k.job(target)?.state === 'building'; i++) await Bun.sleep(5);
        expect(f.k.job(target)?.state).toBe('cancelled'); expect(f.k.status(target)).toEqual(s);
    });
    test('missing selected source fails without changing the active version', async () => {
        const f = setup(), s = await apply(f), catalog = await f.k.catalog(target, false, signal());
        rmSync(join(f.project, 'hours.md'));
        f.k.prepare(target, catalog.sources.filter(s => s.title === 'hours.md').map(({id,hash}) => ({id,hash})), false, s.revision, chat);
        for (let i = 0; i < 100 && f.k.job(target)?.state === 'building'; i++) await Bun.sleep(5);
        expect(f.k.job(target)?.state).toBe('failed'); expect(f.k.status(target)).toEqual(s);
    });
    test('source reader refuses symlinks and identity JSON as a path; no source file is rewritten', async () => {
        const f = setup(), before = readFileSync(join(f.project, 'hours.md'), 'utf8');
        symlinkSync(join(f.project, 'private.md'), join(f.project, 'alias.md'));
        mkdirSync(join(f.project, '.agent-memory')); writeFileSync(join(f.project, '.agent-memory/CORE.md'), 'RAW_MEMORY_CANARY');
        const c = await f.k.catalog(target, false, signal());
        expect(c.sources.some(s => /alias|CORE/.test(s.title))).toBe(false);
        const bad = new DutySources(async () => JSON.stringify([target, f.project]), async () => null);
        await expect(bad.collect(target, false, signal())).rejects.toThrow();
        await apply(f); expect(readFileSync(join(f.project, 'hours.md'), 'utf8')).toBe(before);
    });
    test('future schema is preserved and rejected', async () => {
        const f = setup(); await f.k.shutdown();
        const path = join(f.app, 'cs-duty/knowledge.sqlite');
        const db = new Database(path); db.exec('PRAGMA user_version=99'); db.close();
        expect(() => new DutyKnowledge(f.app, f.sources, async () => 'identity')).toThrow('업데이트');
        const verify = new Database(path); expect((verify.query('PRAGMA user_version').get() as any).user_version).toBe(99); verify.close();
    });
    test('missing search rows rebuild from the approved snapshot, even after the source changes', async () => {
        const f = setup(), s = await apply(f); await f.k.shutdown();
        const db = new Database(join(f.app, 'cs-duty/knowledge.sqlite')); db.exec('DELETE FROM search'); db.close();
        writeFileSync(join(f.project, 'hours.md'), 'UNAPPROVED_NEW_BODY');
        await f.restart();
        expect(f.k.search(target, chat, s.snapshotId, '문의 시간')[0]?.body).toContain('오전 9시');
        expect(f.k.search(target, chat, s.snapshotId, 'UNAPPROVED_NEW_BODY')).toEqual([]);
    });
    test('40 Korean spacing and wording queries retrieve expected approved evidence', async () => {
        const f = setup();
        const cases = [
            ['배송', '배송 추적은 택배 운송장 번호로 조회합니다.', ['배송 조회', '택배 어디', '운송장 확인', '배송추적']],
            ['환불', '환불 반환 신청은 결제 후 7일 이내 접수합니다.', ['환불 기간', '반환 신청', '환불신청', '결제 취소 환불']],
            ['비밀번호', '비밀번호를 분실하면 로그인 화면의 암호 재설정을 이용하세요.', ['비밀번호 분실', '암호 재설정', '로그인 비밀번호', '비밀번호재설정']],
            ['회원가입', '회원가입에는 이메일 인증과 약관 동의가 필요합니다.', ['회원가입 방법', '이메일 인증', '가입 약관', '회원 가입']],
            ['주차', '방문 고객은 지하 주차장에 2시간 무료 주차할 수 있습니다.', ['주차 요금', '무료 주차', '지하 주차장', '방문 주차']],
            ['예약', '상담 예약 변경은 방문 하루 전까지 가능합니다.', ['예약 변경', '상담 예약', '방문 예약 변경', '예약변경']],
            ['영수증', '현금 영수증 발급은 주문 내역의 증빙 메뉴에서 신청합니다.', ['영수증 발급', '현금 증빙', '주문 영수증', '현금영수증']],
            ['휴무', '정기 휴무일은 매주 월요일이며 공휴일에는 휴무합니다.', ['휴무일', '월요일 영업', '공휴일 휴무', '정기휴무']],
            ['교환', '상품 교환은 포장과 구매 확인서를 함께 제출하세요.', ['상품 교환', '포장 교환', '구매 확인서', '상품교환']],
            ['접근성', '접근성 지원에는 화면 읽기와 키보드 탐색 기능이 있습니다.', ['접근성 지원', '화면 읽기', '키보드 탐색', '접근성지원']],
        ] as const;
        for (const [title, body] of cases) writeFileSync(join(f.project, title + '.md'), '# ' + title + '\n\n' + body);
        const s = await apply(f, cases.map(c => c[0]));
        let hits = 0;
        for (const [title, , queries] of cases) for (const q of queries) if (f.k.search(target, chat, s.snapshotId, q).some(e => e.title === title + '.md')) hits++;
        expect(hits).toBeGreaterThanOrEqual(36);
    });
    test('production host wiring reads canonical memory with separate identity and path resolvers', async () => {
        const f = setup(); mkdirSync(join(f.project, '.agent-memory'));
        writeFileSync(join(f.project, '.agent-memory/config.json'), JSON.stringify({ schemaVersion: 1, memoryId: '884575df-63c4-407c-8b43-860d1295e663', sourcePath: '.agent-memory/CORE.md', agent: 'claude', autoBackup: false }));
        writeFileSync(join(f.project, '.agent-memory/CORE.md'), '## 안내\n### 상담\n상담은 화요일입니다.');
        // Use another app directory so there cannot be two stores sharing a mutable database.
        const other = join(f.root, 'actual-host'); mkdirSync(other);
        const host = createCsDutyHost(other, async () => JSON.stringify([target, f.project, {status:'found'}]), async () => f.project);
        try {
            const catalog = await host.knowledge!.catalog(target, true, signal());
            expect(catalog.sources.some(s => s.kind === 'memory' && s.title.includes('상담'))).toBe(true);
        } finally { await host.knowledge!.shutdown(); }
    });
    test('larger indexing yields to health requests and cancellation preserves the approved version', async () => {
        const f = setup(), original = await apply(f);
        for (let i = 0; i < 12; i++) writeFileSync(join(f.project, `large-${i}.md`), ('운영 자료의 설명 문단입니다. 여러 질문의 검색에 사용합니다.\n\n').repeat(700));
        const catalog = await f.k.catalog(target, false, signal());
        const server = Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response('healthy')});
        try {
            f.k.prepare(target,catalog.sources.filter(s=>s.title.startsWith('large')).map(({id,hash})=>({id,hash})),false,original.revision,chat);
            expect(await (await fetch(`http://127.0.0.1:${server.port}`)).text()).toBe('healthy');
            expect(f.k.job(target)?.state).toBe('building');
            f.k.cancel(target);
            for (let i=0;i<200&&f.k.job(target)?.state==='building';i++) await Bun.sleep(5);
            expect(f.k.job(target)?.state).toBe('cancelled'); expect(f.k.status(target).snapshotId).toBe(original.snapshotId);
        } finally { server.stop(true); }
    });
});

test('all new operations reject arbitrary keys, unregistered targets and non-boolean scope', () => {
    const valid = { operation: 'sources', targetId: target, includeMemory: true };
    expect(validDutyOperation(valid)).toBe(true);
    expect(validDutyOperation({ ...valid, path: '/etc' })).toBe(false);
    expect(validDutyOperation({ ...valid, targetId: '../etc' })).toBe(false);
    expect(validDutyOperation({ ...valid, includeMemory: 'true' })).toBe(false);
    expect(validDutyOperation({ ...valid, operation: '__proto__' })).toBe(false);
});

test('actual controller receives only approved retrieval; revoke/OFF during AI prevents send, and preview never sends', async () => {
    const f = setup(); await apply(f);
    let state: DutyState = { configs: [], usage: [], clock: 0 }, messages: DutyMessage[] = [], sent = 0;
    let release: (() => void) | undefined;
    const inputs: string[] = [];
    const host: DutyHost = {
        knowledge: f.k, load: () => structuredClone(state), save: s => { state = structuredClone(s); }, now: Date.now,
        resolve: async () => 'project-identity', resolvePath: async () => f.project, discover: async () => [], documents: async () => [], documentText: async () => '',
        binding: async () => 'bound', read: async () => ({ chatTitle: 'room', messages }), diagnose: async () => [],
        answer: async (c,q,s,context) => { inputs.push(JSON.stringify(context)); await new Promise<void>(r => { release = r; }); return '고객센터는 오전 9시에 시작합니다.'; },
        send: async (c,a,s,b,guard) => { guard?.(); sent++; },
    };
    const d = new CsDuty(host), config: DutyConfig = { targetId: target, revision: 0, profileLabel: 'bot', chatId: chat, chatTitle: 'room', knowledge: '', faqs: [], aiEnabled: true, provider: 'claude', modelId: 'claude-haiku-4-5', dailyAiLimit: 5, autoFaq: true };
    await d.configure(config); await d.enable(target, 1, true, f.k.status(target).revision);
    messages = [{ body: '/cs 문의 시간', author: 'visitor', date: 'today', time: 'now', attachment: false }];
    const work = d.tick();
    for (let i=0;i<100&&!release;i++) await Bun.sleep(2);
    expect(release).toBeDefined();
    await d.knowledgeOperation(target, { operation: 'revokeKnowledge' }); release!(); await work;
    expect(sent).toBe(0); expect(inputs[0]).toContain('오전 9시'); expect(inputs[0]).not.toContain('CANARY_');
    await apply(f);
    release = undefined;
    const preview = d.knowledgeOperation(target, { operation: 'previewAnswer', question: '문의 시간', generate: true });
    for (let i=0;i<100&&!release;i++) await Bun.sleep(2);
    release!(); await preview;
    expect(sent).toBe(0); expect(d.status(target).aiUsed).toBe(2);
    release = undefined;
    const cancelled = d.knowledgeOperation(target, { operation: 'previewAnswer', question: '문의 시간', generate: true });
    const rejection = cancelled.then(() => false, () => true);
    for (let i=0;i<100&&!release;i++) await Bun.sleep(2);
    await expect(d.knowledgeOperation(target, {operation:'previewAnswer',question:'second',generate:true})).rejects.toThrow('다른 답변');
    d.disable(target); release!(); expect(await rejection).toBe(true);
    expect(sent).toBe(0);
    await d.shutdown();
});


test('grounded provider output refuses foreign evidence, malformed output, and unsupported claims', () => {
    const evidence=[{id:'source-1',title:'운영 안내',body:'9시 운영',score:1}];
    expect(dutyGroundedAnswer({result:'',structured_output:{answer:'9시입니다.',sourceIds:['source-1']}},evidence)).toContain('근거: 운영 안내');
    expect(dutyGroundedAnswer({result:'```json\n{"answer":"9시","sourceIds":["source-1"]}\n```'},evidence)).toContain('9시');
    expect(()=>dutyGroundedAnswer({result:'',structured_output:{answer:'비공개',sourceIds:['foreign']}},evidence)).toThrow();
    expect(()=>dutyGroundedAnswer({result:'plain text'},evidence)).toThrow();
    expect(dutyGroundedAnswer({result:'',structured_output:{answer:'근거 없는 주장',sourceIds:[]}},evidence)).toContain('확인하지 못했습니다');
});

test('two projects sharing a room receive only their own approved SQLite evidence', async () => {
    const f=setup();await apply(f);
    const other='project-second', catalog=await f.k.catalog(other,false,signal()), source=catalog.sources.find(s=>s.title==='private.md')!;
    f.k.prepare(other,[{id:source.id,hash:source.hash}],false,0,chat);
    for(let i=0;i<100&&f.k.job(other)?.state==='building';i++)await Bun.sleep(5);
    const candidate=f.k.job(other)?.candidate!;
    await f.k.apply(other,candidate.id,candidate.manifestHash,0,chat);
    let state:DutyState={configs:[],usage:[],clock:0},messages:DutyMessage[]=[];
    const inputs=new Map<string,string>(),sent:string[]=[];
    const host:DutyHost={knowledge:f.k,load:()=>structuredClone(state),save:s=>{state=structuredClone(s);},now:Date.now,
        resolve:async()=> 'project-identity',resolvePath:async()=>f.project,discover:async()=>[],documents:async()=>[],documentText:async()=>'',
        binding:async()=> 'bound',read:async()=>({chatTitle:'room',messages}),diagnose:async()=>[],
        answer:async(c,q,s,context)=>{inputs.set(c.targetId,JSON.stringify(context));return 'test response';},
        send:async(c,a,s,b,guard)=>{guard?.();sent.push(c.targetId);}};
    const d=new CsDuty(host),config:DutyConfig={targetId:target,projectAlias:'포털',revision:0,profileLabel:'bot',chatId:chat,chatTitle:'room',knowledge:'',faqs:[],aiEnabled:true,provider:'claude',modelId:'claude-haiku-4-5',dailyAiLimit:5,autoFaq:false};
    await d.configure(config);await d.configure({...config,targetId:other,projectAlias:'결제'});
    await d.enable(target,1,true,f.k.status(target).revision);await d.enable(other,1,true,f.k.status(other).revision);
    messages=['#포털 문의 시간','#결제 비공개'].map(body=>({body,author:'visitor',date:'today',time:body,attachment:false}));
    await d.tick();expect(sent).toEqual([target,other]);
    expect(inputs.get(target)).toContain('오전 9시');expect(inputs.get(target)).not.toContain('CANARY_');
    expect(inputs.get(other)).toContain('CANARY_UNSELECTED_814');expect(inputs.get(other)).not.toContain('오전 9시');
    await d.shutdown();
});

test('same canonical project in two room connections keeps approvals and revocation isolated',async()=>{
 const f=setup();const first=await apply(f,['hours.md']);const second='duty_11111111-1111-4111-8111-111111111111',room='chat_second';
 expect(f.k.status(second).snapshotId).toBeNull();
 expect(()=>f.k.search(second,room,first.snapshotId,'문의 시간')).toThrow();
 const catalog=await f.k.catalog(second,true,signal());const selected=catalog.sources.filter(s=>s.title.includes('지원 연락처')).map(s=>({id:s.id,hash:s.hash}));
 f.k.prepare(second,selected,true,0,room);
 for(let i=0;i<500&&f.k.job(second)?.state==='building';i++)await Bun.sleep(5);
 const c=f.k.job(second)!.candidate!;const grant=await f.k.apply(second,c.id,c.manifestHash,0,room);
 expect(()=>f.k.search(second,chat,grant.snapshotId,'지원 연락처')).toThrow();
 expect(f.k.search(second,room,grant.snapshotId,'지원 연락처').some(e=>e.body.includes('support@example.test'))).toBe(true);
 f.k.revoke(target);
 expect(f.k.status(target).state).toBe('revoked');expect(f.k.status(second).state).toBe('ready');
 expect(f.k.search(second,room,grant.snapshotId,'지원 연락처')).not.toHaveLength(0);
});
