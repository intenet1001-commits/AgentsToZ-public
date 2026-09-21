/** Local, question-only duty controller. No project paths, shell tools or write actions enter its interface. */
import { createHash } from 'node:crypto';
import type { DutyKnowledge } from './csDutyKnowledge';
import { DutyKnowledgeFailure } from './csDutySources';
import { EMPTY_DUTY_KNOWLEDGE, type DutyAnswerContext, type DutySourceSelection } from './csDutyKnowledgeTypes';
import { normalizeDutyAlias, validDutyAlias, parseDutyInvocation } from './csDutyRouting';
import {validDutyModel,type DutyProvider} from './csDutyModels';
export const CS_DUTY_PATH = '/api/agent-runtime/cs-duty';
export type DutyConfig = {
    targetId: string;
    /** Optional backing project for an additional room connection. Legacy IDs stay valid. */
    projectTargetId?: string;
    revision: number;
    profileLabel: string;
    projectAlias?: string;
    chatId: string;
    chatTitle: string;
    knowledge: string;
    faqs: {
        question: string;
        answer: string;
        learnedFrom?: string;
        approved?: boolean;
    }[];
    provider: DutyProvider;
    modelId: string;
    autoFaq: boolean;
    aiEnabled: boolean;
    dailyAiLimit: number;
};
export type DutyMessage = {
    author: string;
    body: string;
    date: string;
    time: string;
    attachment: boolean;
};
export type DutySnapshot = {
    chatTitle: string;
    messages: DutyMessage[];
};
export type DutyState = {
    configs: DutyConfig[];
    usage: {
        targetId: string;
        at: number;
        hash: string;
        ai: boolean;
    }[];
    clock: number;
};
export interface DutyHost {
    knowledge?: DutyKnowledge;
    load(): DutyState;
    save(state: DutyState): void;
    now(): number;
    /** Opaque identity token, compared to detect a project moving under a live run.
     * It is NOT a path — the app encodes several fields into it. */
    resolve(targetId: string): Promise<string>;
    /** The verified project directory. Separate from resolve() precisely because that
     * one is an identity token; using it as a path silently listed nothing. */
    resolvePath(targetId: string): Promise<string>;
    discover(signal: AbortSignal): Promise<{
        id: string;
        title: string;
    }[]>;
    binding(config: DutyConfig, signal: AbortSignal): Promise<string>;
    read(config: DutyConfig, signal: AbortSignal): Promise<DutySnapshot>;
    answer(config: DutyConfig, question: string, signal: AbortSignal, context?: DutyAnswerContext): Promise<string>;
    send(config: DutyConfig, answer: string, signal: AbortSignal, expectedBinding: string, beforeSend?: () => void): Promise<void>;
    revealChat?(config: DutyConfig, signal: AbortSignal): Promise<void>;
    diagnose(config: DutyConfig, signal: AbortSignal): Promise<DutyCheck[]>;
    documents(targetId: string): Promise<DutyDocument[]>;
    documentText(targetId: string, paths: string[], signal?: AbortSignal): Promise<string>;
}
/** A project document the operator may paste into the shared knowledge. Listing is not
 * sharing: the text only leaves the machine after it is reviewed in the panel and saved. */
export type DutyDocument = { path: string; bytes: number; warning?: string };
export const dutyHash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
export const dutyKnowledgeDigest=(c:DutyConfig)=>dutyHash([c.knowledge,c.faqs.filter(f=>!f.learnedFrom)]);
/** Operator-facing failure. Its text reaches the panel verbatim, so it must stay free of
 * paths, stderr and secrets. Anything else surfaces as a generic message instead. */
export class DutyFailure extends Error { constructor(message: string) { super(message); this.name = 'DutyFailure'; } }
export const dutyReason = (error: unknown, fallback: string) => (error instanceof DutyFailure || error instanceof DutyKnowledgeFailure) && error.message ? error.message : fallback;
export type DutyCheck = { id: string; label: string; ok: boolean; detail: string };
function fail(message: string): never { throw new DutyFailure(message); }
const text = (v: unknown, max: number) => typeof v === 'string' && v.trim() && Buffer.byteLength(v) <= max && !v.includes('\0') ? v.trim() : fail('입력 내용과 길이를 확인하세요.');
export function dutyConfig(v: any): DutyConfig {
    if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).filter(k => !['projectAlias','projectTargetId'].includes(k)).sort().join() !== ['targetId', 'revision', 'profileLabel', 'chatId', 'chatTitle', 'knowledge', 'faqs', 'aiEnabled', 'dailyAiLimit','provider','modelId','autoFaq'].sort().join())
        return fail('대직 설정 형식이 올바르지 않습니다.');
    if (v.projectTargetId !== undefined && (typeof v.projectTargetId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(v.projectTargetId) || !/^duty_[a-f0-9-]{36}$/.test(v.targetId) || v.projectTargetId === v.targetId)) fail('프로젝트 연결 식별자를 확인하세요.');
    if (v.projectAlias !== undefined && (typeof v.projectAlias !== 'string' || (v.projectAlias !== '' && !validDutyAlias(normalizeDutyAlias(v.projectAlias))))) fail('프로젝트 별칭은 한글·영문·숫자·하이픈으로 1~30자 입력하세요.');
    if (!validDutyModel(v.provider,v.modelId)||typeof v.autoFaq!=='boolean')return fail('AI와 모델 설정을 확인하세요.');
    if (typeof v.targetId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(v.targetId) || !Number.isSafeInteger(v.revision) || v.revision < 0 || !/^chat_[a-zA-Z0-9_-]{1,100}$/.test(v.chatId) || typeof v.aiEnabled !== 'boolean' || !Number.isInteger(v.dailyAiLimit) || v.dailyAiLimit < 1 || v.dailyAiLimit > 20 || !Array.isArray(v.faqs) || v.faqs.length > 30)
        return fail('대직 설정 범위를 확인하세요.');
    if (Buffer.byteLength(JSON.stringify(v)) > 40000)
        return fail('공유 안내 자료와 FAQ는 합계 40KB 이하여야 합니다.');
    const faqs = v.faqs.map((f: any) => { if (!f || Object.keys(f).some(k=>!['answer','question','learnedFrom','approved'].includes(k)) || (f.learnedFrom!==undefined&&!/^[a-f0-9]{64}$/.test(f.learnedFrom)) || (f.approved !== undefined && (typeof f.approved !== 'boolean' || !f.learnedFrom)))
        return fail('FAQ 형식이 올바르지 않습니다.'); return { question: text(f.question, 500), answer: text(f.answer, 4000), ...(f.learnedFrom?{learnedFrom:f.learnedFrom, ...(f.approved !== undefined ? {approved:f.approved} : {})}:{}) };  });
    if (new Set(faqs.map((f: {
        question: string;
    }) => f.question)).size !== faqs.length)
        return fail('같은 FAQ 질문을 중복 등록할 수 없습니다.');
    return { ...(v.projectTargetId !== undefined ? {projectTargetId:v.projectTargetId} : {}), ...(v.projectAlias !== undefined ? { projectAlias: normalizeDutyAlias(v.projectAlias) } : {}), targetId: v.targetId, revision: v.revision, profileLabel: text(v.profileLabel, 200), chatId: v.chatId, chatTitle: text(v.chatTitle, 300), knowledge: typeof v.knowledge === 'string' && !v.knowledge.trim() ? '' : text(v.knowledge, 24000), faqs, provider:v.provider,modelId:v.modelId,autoFaq:v.autoFaq, aiEnabled: v.aiEnabled, dailyAiLimit: v.dailyAiLimit };
}
type Active = {
    config: DutyConfig;
    abort: AbortController;
    binding: string;
    project: string;
    previous: string[];
    state: 'starting' | 'on' | 'answering' | 'paused';
    error: string | null;
    replied: number;
    checkedAt: number | null;
    since: number | null;
    snapshot: string | null;
};
export class CsDuty {
    #active = new Map<string, Active>();
    #state: DutyState;
    #busy = false;
    #cursor = 0;
    #closed = false;
    #ioBusy = false;
    #pending = new Set<Promise<unknown>>();
    #lifetime = new AbortController();
    #previewAbort = new Map<string, AbortController>();
    constructor(private host: DutyHost) {
        const s = host.load();
        if (!s || !Array.isArray(s.configs) || s.configs.length > 64 || !Array.isArray(s.usage) || s.usage.length > 6400 || !Number.isSafeInteger(s.clock) || s.clock < 0)
            fail('대직 저장소를 확인하세요.');
        this.#state = { configs: s.configs.map(c=>dutyConfig(Object.assign({provider:'claude',modelId:'claude-sonnet-4-6',autoFaq:false},c))), usage: s.usage, clock: s.clock };
        if (new Set(s.configs.map(c => c.targetId)).size !== s.configs.length || s.usage.some(u => !u || !s.configs.some(c => c.targetId === u.targetId) || !Number.isSafeInteger(u.at) || u.at < 0 || !(/^[a-f0-9]{64}$/).test(u.hash) || typeof u.ai !== 'boolean'))
            fail('대직 저장소를 확인하세요.');
    }
    projectTarget(targetId: string) { return this.#state.configs.find(c=>c.targetId===targetId)?.projectTargetId ?? targetId; }
    connections(projectTargetId: string) { return this.#state.configs.filter(c=>(c.projectTargetId??c.targetId)===projectTargetId).map(c=>({targetId:c.targetId,chatTitle:c.chatTitle,chatId:c.chatId,state:this.#active.get(c.targetId)?.state??'off'})); }
    async createConnection(projectTargetId: string, chatId: string, chatTitle: string) {
        if(this.#closed)fail('대직이 종료되었습니다.');
        if(this.projectTarget(projectTargetId)!==projectTargetId)fail('원본 프로젝트에서 연결을 추가하세요.');
        const existing=this.#state.configs.filter(c=>(c.projectTargetId??c.targetId)===projectTargetId);
        if(existing.length>=8)fail('프로젝트당 최대 8개 방을 연결할 수 있습니다.');
        if(existing.some(c=>c.chatId===chatId))fail('이 프로젝트에 이미 연결한 채팅방입니다.');
        const base=existing[0];
        if(!base)fail('첫 채팅방 설정을 먼저 저장하세요.');
        return this.configure({...base,targetId:'duty_'+crypto.randomUUID(),projectTargetId,revision:0,chatId,chatTitle,knowledge:'',faqs:[],aiEnabled:false});
    }
    status(targetId: string) { const a = this.#active.get(targetId), config = this.#state.configs.find(c => c.targetId === targetId); return { projectConnections:this.connections(this.projectTarget(targetId)), config: structuredClone(config ?? null), roomProjects: this.#state.configs.filter(c => c.chatId === config?.chatId).map(c => ({ targetId: c.targetId, alias: c.projectAlias ?? '', state: this.#active.get(c.targetId)?.state ?? 'off' })), knowledge: this.host.knowledge?.status(targetId) ?? structuredClone(EMPTY_DUTY_KNOWLEDGE), knowledgeJob: this.host.knowledge?.job(targetId) ?? null, state: a?.state ?? 'off', error: a?.error ?? null, replied: a?.replied ?? 0, checkedAt: a?.checkedAt ?? null, baseline: a?.previous.length ?? 0, since: a?.since ?? null, aiUsed: this.#state.usage.filter(u => u.targetId === targetId && u.ai && u.at > this.host.now() - 86400000).length }; }
    async #io<T>(action: () => Promise<T>) { if (this.#ioBusy)
        return fail('카카오톡 연결을 확인 중입니다. 잠시 후 다시 시도하세요.'); this.#ioBusy = true; const work = Promise.resolve().then(action); this.#pending.add(work); try {
        return await work;
    }
    finally {
        this.#pending.delete(work);
        this.#ioBusy = false;
    } }
    /** Reports each precondition separately. ON reports only the first failure, which is not
     * enough to tell "KakaoTalk is closed" from "that chat window is not open". */
    #digest(c: DutyConfig, snapshot: string | null) { return snapshot ? dutyHash([dutyKnowledgeDigest(c), snapshot]) : dutyKnowledgeDigest(c); }
    #faqUsable(c: DutyConfig, f: DutyConfig['faqs'][number], snapshot: string | null) { return !f.learnedFrom || (f.approved === true && f.learnedFrom === this.#digest(c, snapshot)); }
    #knowledge() { if (!this.host.knowledge) fail('검색 자료 기능을 사용할 수 없습니다.'); return this.host.knowledge; }
    #config(target: string) { const c = this.#state.configs.find(c => c.targetId === target); if (!c) fail('먼저 설정을 저장하세요.'); return c; }
    async knowledgeOperation(targetId: string, body: any) {
        if (this.#closed) fail('대직이 종료되었습니다.');
        const k = this.#knowledge();
        const signal = AbortSignal.any([this.#lifetime.signal, AbortSignal.timeout(60000)]);
        if (body.operation === 'sources') return await k.catalog(targetId, body.includeMemory === true, signal);
        if (body.operation === 'sourcePreview') return { source: await k.sourcePreview(targetId, body.selection, body.includeMemory === true, signal) };
        if (body.operation === 'candidatePreview') return { source: k.candidatePreview(targetId, body.candidateId, body.sourceId) };
        if (body.operation === 'knowledgeJob') return { job: k.job(targetId) };
        if (body.operation === 'cancelKnowledgeJob') { k.cancel(targetId); return { job: k.job(targetId) }; }
        if (body.operation === 'revokeKnowledge') { this.disable(targetId); k.revoke(targetId); return this.status(targetId); }
        const c = this.#config(targetId);
        if (body.operation === 'prepareKnowledge') return { job: k.prepare(targetId, body.selections, body.includeMemory === true, body.revision, c.chatId) };
        if (body.operation === 'checkKnowledgeUpdates') return await k.updates(targetId, signal);
        if (body.operation === 'applyKnowledge') {
            if (body.consent !== true || c.revision !== body.configRevision) fail('검토한 자료와 저장된 설정을 확인하세요.');
            this.disable(targetId);
            await k.apply(targetId, body.candidateId, body.manifestHash, body.revision, c.chatId);
            this.disable(targetId);
            if (this.#config(targetId).revision !== c.revision) { k.revoke(targetId); fail('적용 중 설정이 바뀌었습니다. 다시 검토하세요.'); }
            return this.status(targetId);
        }
        if (body.operation === 'previewAnswer') {
            const question = text(body.question, 2000), snapshot = k.status(targetId).snapshotId;
            if (this.#ioBusy) fail('다른 답변을 처리 중입니다. 잠시 후 다시 시도하세요.');
            const previewAbort = new AbortController();
            const previewSignal = AbortSignal.any([signal, previewAbort.signal]);
            this.#previewAbort.set(targetId, previewAbort);
            return this.#io(async () => {
                previewSignal.throwIfAborted();
                await k.validate(targetId, c.chatId, snapshot);
                const evidence = k.search(targetId, c.chatId, snapshot, question);
                const faq = c.faqs.find(f => f.question === question && this.#faqUsable(c, f, snapshot));
                const ai = body.generate === true && !faq;
                let answer: string | null = faq?.answer ?? null;
                if (ai) {
                    if (!c.aiEnabled) fail('AI 답변 사용 설정을 먼저 저장하세요.');
                    this.#claim({ config: c } as Active, dutyHash(['preview', crypto.randomUUID()]), true);
                    answer = await this.host.answer({ ...c, faqs: c.faqs.filter(f => this.#faqUsable(c, f, snapshot)) }, question, previewSignal, { evidence, snapshotId: snapshot });
                    previewSignal.throwIfAborted();
                    await k.validate(targetId, c.chatId, snapshot);
                    if (this.#config(targetId).revision !== c.revision) fail('시험 중 설정이 바뀌었습니다.');
                }
                previewSignal.throwIfAborted();
                return { preview: { answer, evidence, aiUsed: ai, snapshotId: snapshot } };
            }).finally(() => { if (this.#previewAbort.get(targetId) === previewAbort) this.#previewAbort.delete(targetId); });
        }
        fail('허용되지 않은 자료 요청입니다.');
    }
    async revealChat(targetId: string) {
        if (this.#closed || !this.host.revealChat) fail('채팅창을 열 수 없습니다.');
        const c = this.#config(targetId);
        for (const peer of this.#state.configs.filter(p => p.chatId === c.chatId)) this.disable(peer.targetId);
        await this.#io(() => this.host.revealChat!(c, AbortSignal.any([this.#lifetime.signal, AbortSignal.timeout(15000)])));
        return this.status(targetId);
    }
    async diagnose(targetId: string): Promise<DutyCheck[]> {
        if (this.#closed)
            fail('대직이 종료되었습니다.');
        const c = this.#state.configs.find(x => x.targetId === targetId);
        if (!c)
            fail('먼저 설정을 저장하세요. 저장한 설정으로만 연결을 진단합니다.');
        return this.#io(() => this.host.diagnose(c, AbortSignal.any([this.#lifetime.signal, AbortSignal.timeout(60000)])));
    }
    async documents(targetId: string) { if (this.#closed)
        fail('대직이 종료되었습니다.'); return this.host.documents(targetId); }
    async documentText(targetId: string, paths: string[]) {
        if (this.#closed)
            fail('대직이 종료되었습니다.');
        if (!Array.isArray(paths) || !paths.length)
            fail('불러올 문서를 선택하세요.');
        if (paths.length > 20)
            fail('한 번에 최대 20개까지 불러옵니다.');
        const work = this.host.documentText(targetId, paths, AbortSignal.any([this.#lifetime.signal, AbortSignal.timeout(60000)]));
        this.#pending.add(work);
        try { return await work; } finally { this.#pending.delete(work); }
    }
    async discover() { if (this.#closed)
        fail('대직이 종료되었습니다.'); return this.#io(() => this.host.discover(AbortSignal.any([this.#lifetime.signal, AbortSignal.timeout(15000)]))); }
    async configure(raw: unknown) {
        const c = dutyConfig(raw);
        // Preserve generated candidates; only approved candidates from the current digest may answer.
        await this.host.resolve(c.projectTargetId ?? c.targetId);
        if (this.#closed)
            fail('대직이 종료되었습니다.');
        const old = this.#state.configs.find(x => x.targetId === c.targetId);
        if(old && (old.projectTargetId??old.targetId)!==(c.projectTargetId??c.targetId))fail('저장된 연결의 프로젝트를 변경할 수 없습니다.');
        if(this.#state.configs.some(p=>p.targetId!==c.targetId && (p.projectTargetId??p.targetId)===(c.projectTargetId??c.targetId) && p.chatId===c.chatId))fail('이 프로젝트에 이미 연결한 채팅방입니다.');
        if(!old && this.connections(c.projectTargetId??c.targetId).length>=8)fail('프로젝트당 최대 8개 방을 연결할 수 있습니다.');
        if ((old?.revision ?? 0) !== c.revision)
            fail('다른 화면에서 설정이 바뀌었습니다. 다시 불러오세요.');
        if (!old && this.#state.configs.length >= 64)
            fail('이 단말의 대직 설정은 최대 64개입니다.');
        const peers = this.#state.configs.filter(x => x.targetId !== c.targetId && x.chatId === c.chatId);
        if (peers.length >= 8) fail('한 채팅방에는 최대 8개 프로젝트를 연결할 수 있습니다.');
        if (peers.length && !c.projectAlias) fail('같은 채팅방을 함께 쓰려면 각 프로젝트의 #별칭을 먼저 저장하세요.');
        if (peers.some(x => x.projectAlias === c.projectAlias)) fail('이 채팅방에서 이미 사용하는 프로젝트 별칭입니다. 다른 별칭을 입력하세요.');
        if (peers.some(x => x.chatTitle !== c.chatTitle || x.profileLabel !== c.profileLabel)) fail('같은 채팅방에 연결된 프로젝트의 채팅방 이름과 대직 프로필 이름을 일치시켜 주세요.');
        this.disable(c.targetId);
        const next = { ...this.#state, configs: [...this.#state.configs.filter(x => x.targetId !== c.targetId), { ...c, revision: c.revision + 1 }] };
        this.host.save(next);
        this.#state = next;
        return this.status(c.targetId);
    }
    disable(targetId: string) { this.#previewAbort.get(targetId)?.abort(); const a = this.#active.get(targetId); a?.abort.abort(); this.#active.delete(targetId); return this.status(targetId); }
    async enable(targetId: string, revision: number, consent: unknown, knowledgeRevision?: number) {
        if (consent !== true || this.#closed)
            fail('프로필·채팅방·자동 답변 전송에 동의해야 합니다.');
        const c = this.#state.configs.find(x => x.targetId === targetId);
        if (!c || c.revision !== revision)
            fail('저장된 설정을 다시 확인하세요.');
        if (this.host.knowledge && this.host.knowledge.status(targetId).revision !== knowledgeRevision) fail('공유 자료가 바뀌었습니다. 확인 후 다시 동의하세요.');
        const prior = this.#active.get(targetId);
        if (prior && prior.state !== 'paused')
            return this.status(targetId);
        const peers = this.#state.configs.filter(x => x.chatId === c.chatId);
        if (peers.length > 1 && (peers.some(x => !x.projectAlias || x.chatTitle !== c.chatTitle || x.profileLabel !== c.profileLabel) || new Set(peers.map(x => x.projectAlias)).size !== peers.length)) fail('같은 방의 프로젝트 별칭과 프로필 설정을 확인하세요.');
        if (this.#active.size >= 8 && !prior)
            fail('동시에 켤 수 있는 대직은 최대 8개입니다.');
        if (this.#ioBusy)
            fail('카카오톡 연결을 확인 중입니다. 잠시 후 다시 시도하세요.');
        this.disable(targetId);
        const a: Active = { config: { ...c }, abort: new AbortController(), binding: '', project: '', previous: [], state: 'starting', error: null, replied: 0, checkedAt: null, since: null, snapshot: this.host.knowledge?.status(targetId).snapshotId ?? null };
        this.#active.set(targetId, a);
        const deadline = setTimeout(() => a.abort.abort(), 60000);
        try {
            await this.#io(async () => {
                a.project = await this.host.resolve(targetId);
                await this.host.knowledge?.validate(targetId, c.chatId, a.snapshot);
                a.binding = await this.host.binding(c, a.abort.signal);
                const snapshot = await this.host.read(c, a.abort.signal);
                a.previous = this.#snapshot(c, snapshot);
                await this.host.knowledge?.validate(targetId, c.chatId, a.snapshot);
                if (a.abort.signal.aborted || this.#active.get(targetId) !== a)
                    return;
                a.state = 'on';
                a.checkedAt = this.host.now();
                a.since = a.checkedAt;
            });
        }
        catch (e) {
            if (this.#active.get(targetId) === a) {
                a.state = 'paused';
                // A single generic sentence made every distinct cause look identical, so the
                // operator had nothing to act on. Known causes now reach the panel verbatim.
                a.error = a.abort.signal.aborted
                    ? '60초 안에 연결을 확인하지 못했습니다. 카카오톡과 선택한 채팅방 창을 확인하고 다시 시도하세요.'
                    : dutyReason(e, '연결하지 못했습니다. 「연결 진단」으로 어느 단계가 막혔는지 확인하세요.');
            }
        }
        clearTimeout(deadline);
        return this.status(targetId);
    }
    #snapshot(c: DutyConfig, s: DutySnapshot) { if (s.chatTitle !== c.chatTitle || s.messages.length > 50)
        fail('채팅방이나 읽기 범위가 달라졌습니다.'); return s.messages.map(m => dutyHash(m)); }
    async #valid(a: Active) { await this.host.knowledge?.validate(a.config.targetId, a.config.chatId, a.snapshot); a.abort.signal.throwIfAborted(); if (this.#active.get(a.config.targetId) !== a || this.#closed || a.project !== await this.host.resolve(a.config.targetId) || a.binding !== await this.host.binding(a.config, a.abort.signal))
        fail('프로젝트 또는 카카오톡 연결이 변경됐습니다.'); a.abort.signal.throwIfAborted(); }
    #claim(a: Active, hash: string, ai: boolean) {
        const now = this.host.now();
        if (now < this.#state.clock)
            fail('시스템 시각을 확인하세요.');
        const usage = this.#state.usage.filter(u => u.at > now - 86400000), mine = usage.filter(u => u.targetId === a.config.targetId);
        // A room message is claimed before any attempt, across all projects in that room.
        const roomIds = new Set(this.#state.configs.filter(c => c.chatId === a.config.chatId).map(c => c.targetId));
        if (usage.some(u => roomIds.has(u.targetId) && u.hash === hash))
            return false;
        if (mine.length >= 100 || (ai && mine.filter(u => u.ai).length >= a.config.dailyAiLimit))
            fail('최근 24시간 답변 한도에 도달했습니다.');
        const next = { ...this.#state, clock: now, usage: [...usage, { targetId: a.config.targetId, at: now, hash, ai }] };
        this.host.save(next);
        this.#state = next;
        return true;
    }
    #pause(a: Active, error: unknown) {
        if (this.#active.get(a.config.targetId) !== a) return;
        a.state = 'paused';
        a.error = '대직을 일시 중지했습니다 · ' + dutyReason(error, '연결·호출 한도 또는 전송 결과를 확인하세요.') + ' 미확정 답변은 자동 재전송하지 않습니다.';
    }
    #roomStamp(chatId: string) {
        return dutyHash(this.#state.configs.filter(c => c.chatId === chatId).map(c => [c.targetId, c.revision, c.projectAlias, this.#active.get(c.targetId)?.abort.signal.aborted ?? true, this.#active.get(c.targetId)?.state === 'paused']));
    }
    async tick() {
        if (this.#closed || this.#busy || this.#ioBusy) return;
        const rooms = [...new Set([...this.#active.values()].filter(a => a.state === 'on').map(a => a.config.chatId))];
        if (!rooms.length) return;
        const chatId = rooms[this.#cursor++ % rooms.length]!;
        this.#cursor %= 8;
        const group = [...this.#active.values()].filter(a => a.config.chatId === chatId && a.state === 'on');
        let current = group[0]!;
        this.#busy = true;
        const deadline = setTimeout(() => { for (const a of group) { a.abort.abort(); this.#pause(a, new DutyFailure('답변 처리 시간이 초과되었습니다.')); } }, 180000);
        try {
            await this.#io(async () => {
                await this.#valid(current);
                const s = await this.host.read(current.config, current.abort.signal);
                // One room read, independent ON baselines: enabling a second project never
                // replays its old questions or eats the first project's pending questions.
                const freshByProject = new Map<string, Set<number>>();
                for (const a of group) {
                    const hashes = this.#snapshot(a.config, s);
                    let overlap = 0;
                    for (let n = Math.min(a.previous.length, hashes.length); n > 0; n--)
                        if (a.previous.slice(-n).every((h, i) => h === hashes[i])) { overlap = n; break; }
                    if (a.previous.length && !overlap) {
                        a.state = 'paused'; a.error = '대화 연속성을 확인하지 못했습니다. 다시 켜기 전 채팅방을 확인하세요.';
                        continue;
                    }
                    a.previous = hashes; a.checkedAt = this.host.now();
                    freshByProject.set(a.config.targetId, new Set(s.messages.map((_, i) => i).slice(overlap)));
                }
                for (const [index, m] of s.messages.entries()) {
                    const available = group.filter(a => this.#active.get(a.config.targetId) === a && a.state === 'on' && !a.abort.signal.aborted && freshByProject.get(a.config.targetId)?.has(index));
                    if (!available.length) continue;
                    const configs = this.#state.configs.filter(c => c.chatId === chatId);
                    if (m.attachment || !m.author.trim() || m.author === '(me)' || configs.some(c => c.profileLabel === m.author)) continue;
                    const invocation = parseDutyInvocation(m.body);
                    if (!invocation || Buffer.byteLength(m.body) > 2200) continue;
                    const selected = invocation.alias !== null ? configs.find(c => c.projectAlias === invocation.alias) : configs.length === 1 ? configs[0] : undefined;
                    const choices = configs.map(c => `#${c.projectAlias || '별칭-미설정'}${this.#active.get(c.targetId)?.state === 'on' ? '' : ' (OFF)'}`).join(', ');
                    let guidance: string | null = null;
                    if (!selected) guidance = `${invocation.alias !== null ? '해당 프로젝트 별칭을 찾지 못했습니다.' : `이 채팅방에는 프로젝트 ${configs.length}개가 연결되어 있습니다. 어느 프로젝트에 문의하시나요?`}\n${choices}\n#프로젝트별칭 질문 형식으로 다시 보내 주세요.`;
                    else if (this.#active.get(selected.targetId)?.state !== 'on') guidance = `#${selected.projectAlias || '프로젝트'} 대직은 현재 OFF 또는 일시 중지 상태입니다. 담당자가 대직을 켠 뒤 다시 질문해 주세요.`;
                    else if (!invocation.question) guidance = `질문을 함께 보내 주세요. 예: ${selected.projectAlias ? '#' + selected.projectAlias : '/cs'} 이용 방법 알려줘`;
                    const a = guidance ? available[0]! : available.find(a => a.config.targetId === selected!.targetId);
                    if (!a) continue; // addressed project's message predates its own ON baseline
                    current = a;
                    try {
                        const stamp = this.#roomStamp(chatId);
                        const routeValid = () => { a.abort.signal.throwIfAborted(); if (this.#roomStamp(chatId) !== stamp) fail('채팅방의 프로젝트 연결이 바뀌었습니다. 질문을 다시 보내 주세요.'); };
                        const question = invocation.question;
                        if (Buffer.byteLength(question) > 2000) continue;
                        const faq = guidance ? undefined : a.config.faqs.find(f => f.question === question && this.#faqUsable(a.config, f, a.snapshot));
                        const ai = !guidance && !faq && a.config.aiEnabled;
                        await this.#valid(a); routeValid();
                        if (!this.#claim(a, dutyHash(m), ai)) continue;
                        a.state = 'answering';
                        const evidence = guidance ? [] : this.host.knowledge?.search(a.config.targetId, chatId, a.snapshot, question) ?? [];
                        const answer = guidance ?? faq?.answer ?? (ai ? await this.host.answer({ ...a.config, faqs: a.config.faqs.filter(f => this.#faqUsable(a.config, f, a.snapshot)) }, question, a.abort.signal, { evidence, snapshotId: a.snapshot }) : '공유된 안내 자료에서 답변을 확인하지 못했습니다.');
                        if (typeof answer !== 'string' || !answer.trim() || Buffer.byteLength(answer) > 6000) fail('답변을 확인하지 못했습니다.');
                        await this.#valid(a); routeValid();
                        const prefix = !guidance && a.config.projectAlias ? `[CS 대직 · #${a.config.projectAlias}]` : '[CS 대직]';
                        await this.host.send(a.config, prefix + '\n' + answer, a.abort.signal, a.binding, () => { routeValid(); this.host.knowledge?.assert(a.config.targetId, chatId, a.snapshot); });
                        a.replied++;
                        if(ai&&a.config.autoFaq&&a.config.faqs.length<30&&!a.config.faqs.some(f=>f.question===question)&&Buffer.byteLength(question)<=500&&Buffer.byteLength(answer)<=4000&&!/(확인하지 못|알 수 없|모르겠|cannot confirm|don't know|not enough information)/i.test(answer)&&this.#active.get(a.config.targetId)===a&&!a.abort.signal.aborted){
                          const updated={...a.config,revision:a.config.revision+1,faqs:[...a.config.faqs,{question,answer,learnedFrom:this.#digest(a.config,a.snapshot),approved:false}]};
                          if(Buffer.byteLength(JSON.stringify(updated))<=40000){const next={...this.#state,configs:this.#state.configs.map(c=>c.targetId===updated.targetId?updated:c)};this.host.save(next);this.#state=next;a.config=updated;}
                        }
                        a.state = 'on';
                    } catch (e) { this.#pause(a, e); }
                }
            });
        } catch (e) {
            this.#pause(current, e);
        } finally { clearTimeout(deadline); this.#busy = false; }
    }
    async shutdown() { this.#closed = true; this.#lifetime.abort(); for (const a of this.#active.values())
        a.abort.abort(); this.#active.clear(); await Promise.allSettled([...this.#pending]); await this.host.knowledge?.shutdown(); }
}
