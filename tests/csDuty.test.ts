import { describe, test, expect } from 'bun:test';
import { parseDutyInvocation } from '../src/csDutyRouting';
import { CsDuty, DutyFailure, dutyConfig, type DutyCheck, type DutyConfig, type DutyHost, type DutyMessage, type DutyState } from '../src/csDuty';
const config: DutyConfig = { targetId: 'project-123', revision: 0, profileLabel: 'bot', chatId: 'chat_test', chatTitle: 'support', knowledge: 'Public instructions', faqs: [{ question: 'hours?', answer: '9 to 5' }], provider: 'claude', modelId: 'claude-haiku-4-5', autoFaq: false, aiEnabled: false, dailyAiLimit: 1 };
const msg = (body: string, author = 'visitor'): DutyMessage => ({ body, author, date: '2026-09-09', time: body, attachment: false });
function fixture() {
    let persisted: DutyState = { configs: [], usage: [], clock: 0 }, messages: DutyMessage[] = [], now = 100000000, bind = 'binding';
    const checks: DutyCheck[] = [{ id: 'window', label: '채팅방 창', ok: false, detail: '창을 열어 두세요.' }];
    const sent: string[] = [], calls: string[] = [];
    const host: DutyHost = { load: () => structuredClone(persisted), save: s => { persisted = structuredClone(s); }, now: () => now, resolve: async (id) => id, resolvePath: async () => '/tmp', documents: async () => [], documentText: async () => '', discover: async () => [], binding: async () => bind, read: async () => ({ chatTitle: 'support', messages: structuredClone(messages) }), answer: async (_c, q) => { calls.push(q); return 'AI answer'; }, send: async (_c, a) => { sent.push(a); }, diagnose: async () => checks };
    return { host, sent, calls, get saved() { return persisted; }, set messages(v: DutyMessage[]) { messages = v; }, set now(v: number) { now = v; }, set binding(v: string) { bind = v; } };
}
async function ready(ai = false) { const f = fixture(), d = new CsDuty(f.host); await d.configure({ ...config, aiEnabled: ai }); await d.enable(config.targetId, 1, true); return { f, d }; }
describe('question-only CS duty', () => {
    test('strict scope/config and consent', async () => { const f = fixture(), d = new CsDuty(f.host); expect(() => dutyConfig({ ...config, path: '/tmp' })).toThrow(); await d.configure(config); await expect(d.enable(config.targetId, 1, false)).rejects.toThrow(); await expect(d.enable(config.targetId, 0, true)).rejects.toThrow(); expect(d.status(config.targetId).state).toBe('off'); });
    test('baseline not replayed; FAQ consumes zero AI; duplicate tick does not send', async () => { const f = fixture(); f.messages = [msg('/cs old')]; const d = new CsDuty(f.host); await d.configure(config); await d.enable(config.targetId, 1, true); await d.tick(); expect(f.sent).toEqual([]); f.messages = [msg('/cs old'), msg('/cs hours?')]; await d.tick(); await d.tick(); expect(f.sent).toEqual(['[CS 대직]\n9 to 5']); expect(f.calls).toEqual([]); });
    test('ordinary, bot, unknown and attachments ignored', async () => { const { f, d } = await ready(); f.messages = [msg('hello'), msg('/cs hours?', 'bot'), msg('/cs hours?', '(me)'), msg('/cs hours?', ''), { ...msg('/cs hours?'), attachment: true }]; await d.tick(); expect(f.sent).toEqual([]); });
    test('restart OFF and persisted budgets survive configuration', async () => { const { f, d } = await ready(true); f.messages = [msg('/cs one')]; await d.tick(); expect(f.calls).toEqual(['one']); await d.configure({ ...config, revision: 1, aiEnabled: true }); const restarted = new CsDuty(f.host); expect(restarted.status(config.targetId).state).toBe('off'); await restarted.enable(config.targetId, 2, true); f.messages = [msg('/cs one'), msg('/cs two')]; await restarted.tick(); expect(f.calls).toEqual(['one']); expect(restarted.status(config.targetId).state).toBe('paused'); });
    test('OFF while AI pending prevents send', async () => { const { f, d } = await ready(true); let release!: () => void; f.host.answer = async () => { await new Promise<void>(r => release = r); return 'answer'; }; f.messages = [msg('/cs new')]; const work = d.tick(); while (!release)
        await Promise.resolve(); d.disable(config.targetId); release(); await work; expect(f.sent).toEqual([]); expect(d.status(config.targetId).state).toBe('off'); });
    test('OFF during enabling cannot rearm', async () => { const f = fixture(), d = new CsDuty(f.host); await d.configure(config); let release!: () => void; f.host.read = async () => { await new Promise<void>(r => release = r); return { chatTitle: 'support', messages: [] }; }; const work = d.enable(config.targetId, 1, true); while (!release)
        await Promise.resolve(); d.disable(config.targetId); release(); await work; expect(d.status(config.targetId).state).toBe('off'); });
    test('changed binding and lost history pause without action', async () => { const { f, d } = await ready(); f.binding = 'other'; f.messages = [msg('/cs hours?')]; await d.tick(); expect(f.sent).toEqual([]); expect(d.status(config.targetId).state).toBe('paused'); const r = await ready(); r.f.messages = [msg('old')]; await r.d.tick(); r.f.messages = [msg('/cs hours?')]; await r.d.tick(); expect(r.f.sent).toEqual([]); expect(r.d.status(config.targetId).state).toBe('paused'); });
    test('claim persisted before uncertain send; no retry', async () => { const { f, d } = await ready(true); f.host.send = async () => { expect(f.saved.usage.length).toBe(1); throw Error('uncertain'); }; f.messages = [msg('/cs first')]; await d.tick(); await d.tick(); expect(f.calls.length).toBe(1); expect(d.status(config.targetId).state).toBe('paused'); });
    test('shared room requires explicit distinct aliases', async () => { const { d } = await ready(); await expect(d.configure({ ...config, targetId: 'project-456' })).rejects.toThrow('별칭'); });
    test('clock rollback pauses and status cannot mutate config', async () => { const { f, d } = await ready(true); d.status(config.targetId).config!.knowledge = 'changed'; expect(d.status(config.targetId).config!.knowledge).toBe(config.knowledge); f.messages = [msg('/cs one')]; await d.tick(); f.now = 1; f.messages = [msg('/cs one'), msg('/cs two')]; await d.tick(); expect(f.calls.length).toBe(1); });
    test('shutdown aborts and drains in-flight work', async () => { const { f, d } = await ready(true); let started = false; f.host.answer = async (_c, _q, s) => { started = true; await new Promise<void>(r => s.addEventListener('abort', () => r(), { once: true })); return 'late'; }; f.messages = [msg('/cs question')]; const work = d.tick(); while (!started)
        await Promise.resolve(); await d.shutdown(); await work; expect(f.sent).toEqual([]); expect(d.status(config.targetId).state).toBe('off'); });
    test('parallel ticks dispatch once', async () => { const { f, d } = await ready(); f.messages = [msg('/cs hours?')]; await Promise.all([d.tick(), d.tick(), d.tick()]); expect(f.sent.length).toBe(1); });
});

 test('auto FAQ needs explicit review and stays source-bound after edits', async () => {
    const f=fixture(),d=new CsDuty(f.host);
    await d.configure({...config,aiEnabled:true,autoFaq:true,dailyAiLimit:5});
    await d.enable(config.targetId,1,true);
    f.messages=[msg('/cs question')];await d.tick();
    let current=d.status(config.targetId).config!;
    expect(current.faqs.at(-1)?.approved).toBe(false);
    f.messages=[msg('/cs question'),{...msg('/cs question'),time:'later'}];await d.tick();
    expect(f.calls.length).toBe(2);
    await d.configure({...current,faqs:current.faqs.map(f=>f.learnedFrom?{...f,approved:true}:f)});
    current=d.status(config.targetId).config!;
    await d.enable(config.targetId,current.revision,true);
    f.messages=[msg('/cs question'),{...msg('/cs question'),time:'later'},{...msg('/cs question'),time:'approved'}];
    await d.tick();expect(f.calls.length).toBe(2);
    await d.configure({...current,knowledge:'Changed public instructions'});
    current=d.status(config.targetId).config!;
    expect(current.faqs.length).toBe(2);
    await d.enable(config.targetId,current.revision,true);
    f.messages=[msg('/cs question'),{...msg('/cs question'),time:'later'},{...msg('/cs question'),time:'approved'},{...msg('/cs question'),time:'changed'}];
    await d.tick();expect(f.calls.length).toBe(3);
 });
 test('uncertain answer is not auto learned and failed send never populates FAQ',async()=>{const f=fixture(),d=new CsDuty(f.host);await d.configure({...config,aiEnabled:true,autoFaq:true});f.host.answer=async()=>"I cannot confirm that.";await d.enable(config.targetId,1,true);f.messages=[msg('/cs question')];await d.tick();expect(d.status(config.targetId).config!.faqs).toEqual(config.faqs);});
 test('each provider and model are explicit; unknown provider and shell fragments rejected',()=>{for(const provider of ['claude','codex','agy'] as const)expect(dutyConfig({...config,provider,modelId:'model-1'}).provider).toBe(provider);expect(()=>dutyConfig({...config,provider:'other'})).toThrow();expect(()=>dutyConfig({...config,modelId:'x; command'})).toThrow();});

describe('duty failures stay legible', () => {
    test('enable surfaces the host reason instead of one generic sentence', async () => {
        const f = fixture(), d = new CsDuty(f.host);
        await d.configure(config);
        f.host.read = async () => { throw new DutyFailure('채팅방 창을 읽지 못했습니다. 별도 창으로 열어 두세요.'); };
        await d.enable(config.targetId, 1, true);
        const status = d.status(config.targetId);
        expect(status.state).toBe('paused');
        expect(status.error).toBe('채팅방 창을 읽지 못했습니다. 별도 창으로 열어 두세요.');
    });
    test('an unknown error stays generic and points at the diagnosis', async () => {
        const f = fixture(), d = new CsDuty(f.host);
        await d.configure(config);
        f.host.binding = async () => { throw new TypeError('undefined is not an object'); };
        await d.enable(config.targetId, 1, true);
        const error = d.status(config.targetId).error ?? '';
        expect(error).not.toContain('undefined is not an object');
        expect(error).toContain('연결 진단');
    });
    test('tick keeps the reason for a paused duty', async () => {
        const { f, d } = await ready();
        f.host.read = async () => { throw new DutyFailure('채팅방 응답을 해석하지 못했습니다.'); };
        await d.tick();
        expect(d.status(config.targetId).error).toContain('채팅방 응답을 해석하지 못했습니다.');
    });
    test('diagnose needs a saved config and returns every check, including failures', async () => {
        const f = fixture(), d = new CsDuty(f.host);
        await expect(d.diagnose(config.targetId)).rejects.toThrow();
        await d.configure(config);
        expect(await d.diagnose(config.targetId)).toEqual([{ id: 'window', label: '채팅방 창', ok: false, detail: '창을 열어 두세요.' }]);
    });
    test('ON reports the baseline it will not answer', async () => {
        const f = fixture();
        f.messages = [msg('/cs old'), msg('hello')];
        const d = new CsDuty(f.host);
        await d.configure(config);
        await d.enable(config.targetId, 1, true);
        const status = d.status(config.targetId);
        expect(status.state).toBe('on');
        expect(status.baseline).toBe(2);
        expect(status.since).toBe(status.checkedAt);
        expect(d.status('project-000').baseline).toBe(0);
    });
});

async function sharedRoom() {
    const f = fixture(), d = new CsDuty(f.host);
    await d.configure({...config, projectAlias:'포털', aiEnabled:true, dailyAiLimit:20});
    await d.configure({...config, targetId:'project-456', projectAlias:'결제', aiEnabled:true, dailyAiLimit:20, faqs:[{question:'hours?',answer:'second project hours'}]});
    await d.enable(config.targetId,1,true); await d.enable('project-456',1,true);
    return {f,d};
}
describe('shared chat project routing', () => {
    test('exact commands and Korean aliases; ordinary conversation is ignored', () => {
        expect(parseDutyInvocation('/cs')).toEqual({alias:null,question:''});
        expect(parseDutyInvocation('/cs #포털 질문')).toEqual({alias:'포털',question:'질문'});
        expect(parseDutyInvocation('#PORTAL question')).toEqual({alias:'portal',question:'question'});
        expect(parseDutyInvocation('hello #포털')).toBeNull();
        expect(parseDutyInvocation('@포털 질문')).toBeNull();
        expect(parseDutyInvocation('/csharp')).toBeNull();
        expect(parseDutyInvocation('#')).toBeNull();
        expect(parseDutyInvocation('/cs #')).toBeNull();
    });
    test('one read routes each question to exactly one project with isolated config', async () => {
        const {f,d}=await sharedRoom(); let reads=0; const read=f.host.read;
        f.host.read=async(...args)=>{reads++; return read(...args);};
        const targets:string[]=[]; f.host.answer=async(c,q)=>{targets.push(c.targetId+':'+q);return c.knowledge;};
        f.messages=[msg('#결제 hours?'),msg('/cs #포털 hello'),msg('#결제 hello')];
        await d.tick(); expect(reads).toBe(1); await d.tick();
        expect(f.sent).toEqual(['[CS 대직 · #결제]\nsecond project hours','[CS 대직 · #포털]\nPublic instructions','[CS 대직 · #결제]\nPublic instructions']);
        expect(targets).toEqual(['project-123:hello','project-456:hello']);
    });
    test('ambiguous and unknown requests get one choice prompt without AI or replay', async () => {
        const {f,d}=await sharedRoom();
        f.messages=[msg('/cs'),msg('/cs hours?'),msg('#없는별칭 질문')];
        await Promise.all([d.tick(),d.tick()]); await d.tick();
        expect(f.sent.length).toBe(3); expect(f.sent[0]).toContain('프로젝트 2개');
        expect(f.sent[0]).toContain('#포털'); expect(f.sent[0]).toContain('#결제');
        expect(f.sent[2]).toContain('찾지 못했습니다'); expect(f.calls).toEqual([]);
        expect(f.saved.usage.every(u=>!u.ai)).toBe(true);
    });
    test('OFF target never falls back to another project; bare calls remain ambiguous', async () => {
        const {f,d}=await sharedRoom();d.disable('project-456');
        f.messages=[msg('#결제 hours?'),msg('/cs hours?')];await d.tick();
        expect(f.calls).toEqual([]);expect(f.sent[0]).toContain('OFF');expect(f.sent[1]).toContain('어느 프로젝트');
    });
    test('each newly enabled project keeps its own baseline without dropping older active work', async () => {
        const f=fixture(),d=new CsDuty(f.host);
        await d.configure({...config,projectAlias:'포털'});await d.enable(config.targetId,1,true);
        f.messages=[msg('#포털 hours?'),msg('#결제 hours?')];
        await d.configure({...config,targetId:'project-456',projectAlias:'결제'});await d.enable('project-456',1,true);
        await d.tick();expect(f.sent).toEqual(['[CS 대직 · #포털]\n9 to 5']);
        f.messages=[msg('#포털 hours?'),msg('#결제 hours?'),{...msg('#결제 hours?'),time:'new'}];
        await d.tick();expect(f.sent.at(-1)).toBe('[CS 대직 · #결제]\n9 to 5');
    });
    test('alias uniqueness, validation, restart persistence, and matching profile', async () => {
        const {f,d}=await sharedRoom();
        await expect(d.configure({...config,targetId:'project-789',projectAlias:'포털'})).rejects.toThrow('별칭');
        await expect(d.configure({...config,targetId:'project-789',projectAlias:'기타',profileLabel:'wrong'})).rejects.toThrow('프로필');
        for(const projectAlias of ['two words','../file','@name','x'.repeat(31)]) expect(()=>dutyConfig({...config,projectAlias})).toThrow();
        expect(dutyConfig({...config,projectAlias:'#PORTAL'}).projectAlias).toBe('portal');
        const restarted=new CsDuty(f.host);expect(restarted.status('project-456').config?.projectAlias).toBe('결제');expect(restarted.status('project-456').state).toBe('off');
    });
    test('room change during AI cancels send and cannot produce a fallback answer later', async () => {
        const {f,d}=await sharedRoom();let release!:()=>void;
        f.host.answer=async()=>{await new Promise<void>(r=>release=r);return 'late';};
        f.messages=[msg('#포털 question')];const work=d.tick();while(!release)await Promise.resolve();
        await d.configure({...d.status('project-456').config!,projectAlias:'결제변경'});release();await work;await d.tick();
        expect(f.sent).toEqual([]);expect(f.saved.usage.length).toBe(1);
    });
    test('a failed shared-room send is claimed once across projects', async () => {
        const {f,d}=await sharedRoom();let sends=0;f.host.send=async()=>{sends++;throw Error('uncertain');};
        f.messages=[msg('/cs')];await d.tick();await d.tick();expect(sends).toBe(1);
    });
    test('single project supports old syntax and alias-only asks for a question', async()=>{
        const f=fixture(),d=new CsDuty(f.host);await d.configure({...config,projectAlias:'포털'});await d.enable(config.targetId,1,true);
        f.messages=[msg('/cs hours?'),msg('#포털')];await d.tick();expect(f.sent[0]).toContain('9 to 5');expect(f.sent[1]).toContain('질문을 함께');expect(f.calls).toEqual([]);
    });
});
test('shutdown cancels and drains document extraction',async()=>{
    const f=fixture(),d=new CsDuty(f.host);let entered=false;
    f.host.documentText=async(_id,_paths,signal)=>{entered=true;await new Promise<void>(r=>signal!.addEventListener('abort',()=>r(),{once:true}));signal!.throwIfAborted();return '';};
    const work=d.documentText(config.targetId,['guide.pdf']);const rejection=work.then(()=>false,()=>true);
    while(!entered)await Promise.resolve();await d.shutdown();expect(await rejection).toBe(true);
});
test('failure in one project does not discard another project question from the same room read',async()=>{
    const {f,d}=await sharedRoom();f.host.answer=async(c)=>{if(c.targetId===config.targetId)throw new DutyFailure('AI 연결 실패');return 'other answer';};
    f.messages=[msg('#포털 new question'),msg('#결제 new question')];await d.tick();await d.tick();
    expect(f.sent).toEqual(['[CS 대직 · #결제]\nother answer']);expect(d.status(config.targetId).state).toBe('paused');expect(d.status('project-456').state).toBe('on');
});
test('opening the chat stops every connected duty and never enables or sends',async()=>{
    const {f,d}=await sharedRoom();let opened=0;f.host.revealChat=async(c)=>{expect(c.chatId).toBe(config.chatId);opened++;};
    await d.revealChat(config.targetId);expect(opened).toBe(1);expect(d.status(config.targetId).state).toBe('off');expect(d.status('project-456').state).toBe('off');expect(f.sent).toEqual([]);
});

describe('many-to-many room connections',()=>{
 test('a second room starts unshared and OFF, preserves legacy config, and cannot be reassigned',async()=>{
  const f=fixture(),d=new CsDuty(f.host);await d.configure({...config,projectAlias:'project'});
  const next=await d.createConnection(config.targetId,'chat_other','other');const c=next.config!;
  expect(c.projectTargetId).toBe(config.targetId);expect(c.targetId).not.toBe(config.targetId);
  expect(c.knowledge).toBe('');expect(c.faqs).toEqual([]);expect(c.aiEnabled).toBe(false);expect(next.state).toBe('off');
  expect(d.status(config.targetId).config!.knowledge).toBe(config.knowledge);
  expect(d.connections(config.targetId)).toHaveLength(2);
  expect(d.projectTarget(c.targetId)).toBe(config.targetId);
  await expect(d.createConnection(config.targetId,'chat_other','other')).rejects.toThrow('이미 연결');
  await expect(d.configure({...c,projectTargetId:'project-other'})).rejects.toThrow('변경할 수 없습니다');
  const restarted=new CsDuty(f.host);expect(restarted.projectTarget(c.targetId)).toBe(config.targetId);expect(restarted.status(c.targetId).state).toBe('off');
 });
 test('one project in two rooms keeps independent baselines, answers, stops and durable duplicate claims',async()=>{
  const f=fixture(),d=new CsDuty(f.host);const messages=new Map<string,DutyMessage[]>();const sends:{room:string;answer:string}[]=[];
  f.host.read=async c=>({chatTitle:c.chatTitle,messages:messages.get(c.chatId)??[]});
  f.host.send=async(c,answer)=>{sends.push({room:c.chatId,answer})};
  await d.configure({...config,projectAlias:'project'});const second=(await d.createConnection(config.targetId,'chat_other','other')).config!;
  await d.configure({...second,faqs:[{question:'hours?',answer:'private other room hours'}]});
  messages.set(config.chatId,[msg('already seen')]);
  await d.enable(config.targetId,1,true);await d.enable(second.targetId,2,true);
  expect(d.status(config.targetId).baseline).toBe(1);expect(d.status(second.targetId).baseline).toBe(0);
  messages.set(config.chatId,[msg('already seen'),msg('/cs hours?')]);messages.set('chat_other',[msg('/cs hours?')]);
  await d.tick();await d.tick();expect(sends).toEqual(expect.arrayContaining([{room:config.chatId,answer:'[CS 대직 · #project]\n9 to 5'},{room:'chat_other',answer:'[CS 대직 · #project]\nprivate other room hours'}]));expect(sends).toHaveLength(2);
  d.disable(second.targetId);expect(d.status(config.targetId).state).toBe('on');expect(d.status(second.targetId).state).toBe('off');await d.tick();expect(sends).toHaveLength(2);
 });
});
