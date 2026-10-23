import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { acquireOwnedFileLock } from './portalFileLock';
import { inspectServiceMemory, type ServiceMemoryInspection } from './serviceMemory';
import { WorkroomThreadStore, type StoredWorkroomThread } from './workroomThreadStore';
import { normalizeServiceUseCall, normalizeServiceUseOutcome, SERVICE_USE_TOOLS, type ServiceUseBinding, type ServiceUseCall, type ServiceUseOutcome, type ServiceUseReadiness } from './serviceUseProtocol';
import {referenceExcerpt} from './agentstozMention';
import {normalizeAppUseActions, validateAppUseAction, type AppUseAction} from './appUseCatalog';
import {SERVICE_USE_ALL_TOOLS} from './serviceUseProtocol';

export interface ServiceUseProject { projectId: string; projectName: string; memoryId: string; canonicalPath: string }
/** Conversational transports receive the verified catalog, never local memory paths or credentials. */
export function publicServiceUseStatus(status: {readiness:ServiceUseReadiness;tools?:ServiceUseCall['tool'][];actions?:AppUseAction[];phones?:{id:string;name:string}[]}) {
  return {readiness:status.readiness,...(status.tools?{tools:status.tools}:{}),...(status.actions?{actions:status.actions}:{}),...(status.phones?{phones:status.phones}:{})};
}
/** Installed host code supplies adapters. JSON, prompts, channel names and tool drafts cannot register one. */
export interface ServiceUseAdapter {
  projectId: string;
  serviceKey: string;
  definitionRevision: string;
  tools: readonly ServiceUseCall['tool'][];
  actions?: readonly AppUseAction[];
  /** Application must enforce this exact scope atomically at the operation, including status/cancel. */
  scope(owner: string): Promise<Omit<ServiceUseBinding, 'role' | 'projectId' | 'serviceKey' | 'serviceMemoryId' | 'definitionRevision' | 'allowedTools'>>;
  /** Read-only approved names/IDs for the exact current scope; never part of execution identity. */
  phoneTargets?(owner: string): Promise<readonly {id:string;name:string}[]>;
  execute(call: ServiceUseCall, requestId: string, binding: ServiceUseBinding, active: () => boolean): Promise<ServiceUseOutcome>;
  receipt?(requestId: string, binding: ServiceUseBinding, active: () => boolean): Promise<ServiceUseOutcome>;
}
type Activation = { projectId: string; serviceKey: string; serviceMemoryId: string; enabled: true };
const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const unknownOutcome = (): ServiceUseOutcome => ({ state: 'unknown', message: '앱 실행 결과를 확인해야 합니다. 원래 요청 ID로 조회하고 같은 작업을 자동 재실행하지 마세요.' });
export const SHADOWLOOP_USE_DRAFT = Object.freeze({
  app: 'ShadowLoop', revision: 'shadowloop-use-v1-draft', state: 'draft' as const, tools: SERVICE_USE_TOOLS,
  problem: 'ShadowLoop의 사용자·보관함·설치 결속, 요청 ID별 결과 조회·취소, 승인된 폰의 수신 영수증 계약을 검증해야 합니다. 도구 초안은 실행할 수 없습니다.',
});

export class ServiceUseHost {
  private file: string;
  constructor(private deps: {
    appDataDir: string;
    resolve(projectId: string): Promise<ServiceUseProject>;
    adapters?: readonly ServiceUseAdapter[];
    adapter?: (projectId: string, serviceKey: string) => Promise<ServiceUseAdapter | undefined>;
    receipts?: WorkroomThreadStore;
  }) { this.file = join(deps.appDataDir, 'service-use', 'activation.v1.json'); }

  private activations(): Activation[] {
    if (!existsSync(this.file)) return [];
    const stat = lstatSync(this.file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 262144) throw Error('USE 활성화 설정을 검증하지 못했습니다.');
    const data = JSON.parse(readFileSync(this.file, 'utf8'));
    if (data.version !== 1 || !Array.isArray(data.services) || data.services.length > 256
      || data.services.some((r: Activation) => !r || r.enabled !== true || ![r.projectId, r.serviceKey, r.serviceMemoryId].every(v => typeof v === 'string' && !!v))
      || new Set(data.services.map((r: Activation) => r.serviceMemoryId)).size !== data.services.length) throw Error('USE 활성화 설정을 검증하지 못했습니다.');
    return data.services;
  }
  private async memory(projectId: string, serviceKey = 'default') {
    const project = await this.deps.resolve(projectId);
    const memory = inspectServiceMemory(this.deps.appDataDir, { projectId: project.projectId, projectMemoryId: project.memoryId, serviceKey });
    if (memory.record && (memory.record.linkedProjectId !== project.projectId || memory.record.linkedCanonicalPath !== project.canonicalPath)) throw Error('USE 운영기억의 프로젝트 결속이 다릅니다.');
    return { project, memory };
  }
  /** Roster metadata only: no adapter, login, vault, key or app operation is touched. */
  async mentionServices(projectIds: ReadonlySet<string>): Promise<Map<string, string[]>> {
    const result = new Map<string, string[]>();
    for (const row of this.activations()) {
      if (!projectIds.has(row.projectId)) continue;
      try {
        const {memory} = await this.memory(row.projectId, row.serviceKey);
        if (!memory.ready || memory.record?.serviceMemoryId !== row.serviceMemoryId) continue;
        const keys = result.get(row.projectId) ?? [];
        if (keys.length < 16) keys.push(row.serviceKey);
        result.set(row.projectId, keys);
      } catch { /* A stale or unreadable USE never makes its DEV project disappear. */ }
    }
    return result;
  }
  async reference(projectId: string, serviceKey = 'default'): Promise<{label: string; sourcePath: string; memoryId: string}> {
    const services = await this.mentionServices(new Set([projectId]));
    if (!services.get(projectId)?.includes(serviceKey)) throw Error('활성화된 USE 운영기억을 확인하세요.');
    const {project, memory} = await this.memory(projectId, serviceKey);
    if (!memory.ready || !memory.record) throw Error('USE 운영기억을 확인하세요.');
    return {label: project.projectName, sourcePath: memory.record.sourcePath, memoryId: memory.record.serviceMemoryId};
  }
  /** A # reference reads only an activated memory, without touching the app adapter or credentials. */
  async recallReference(projectId: string, serviceKey: string, query: string) {
    const reference = await this.reference(projectId, serviceKey);
    const descriptor = openSync(reference.sourcePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let text: string, truncated: boolean;
    try {
      const stat = fstatSync(descriptor);
      if (!stat.isFile() || stat.nlink !== 1) throw Error('USE 운영기억 파일을 확인하세요.');
      const buffer = Buffer.alloc(Math.min(stat.size, 32 * 1024));
      const length = readSync(descriptor, buffer, 0, buffer.length, 0);
      text = new TextDecoder().decode(buffer.subarray(0, length), {stream: true});
      truncated = length < stat.size;
    } finally { closeSync(descriptor); }
    const {memory} = await this.memory(projectId, serviceKey);
    if (!memory.record || memory.record.sourcePath !== reference.sourcePath || memory.record.serviceMemoryId !== reference.memoryId) throw Error('USE 운영기억을 확인하세요.');
    const terms = [...new Set(query.normalize('NFKC').toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter(Boolean))];
    const matches = text.split(/\r?\n\s*\r?\n/u).map((body, index) => ({body, index,
      score: terms.filter(term => body.normalize('NFKC').toLowerCase().includes(term)).length,
    })).filter(row => row.score > 0).sort((a, b) => b.score - a.score || a.index - b.index);
    return {role: 'use' as const, serviceKey, memoryId: memory.record.serviceMemoryId,
      contentHash: digest(text), truncated, complete: !truncated && matches.length <= 5,
      hits: matches.slice(0, 5).map(row => ({title: reference.label + ' USE', body: referenceExcerpt(row.body), source: 'use-memory', caution: true})),
    };
  }
  private async adapter(projectId: string, serviceKey: string) {
    const matches = (this.deps.adapters ?? []).filter(a => a.projectId === projectId && a.serviceKey === serviceKey);
    const connected = await this.deps.adapter?.(projectId, serviceKey);
    if(connected&&(connected.projectId!==projectId||connected.serviceKey!==serviceKey))throw Error('앱 운영 정의의 프로젝트 결속이 다릅니다.');
    if (connected) matches.push(connected);
    if (matches.length > 1) throw Error('USE 운영 정의가 중복되었습니다.');
    return matches[0];
  }
  async status(projectId: string, owner: string, serviceKey = 'default'): Promise<{ readiness: ServiceUseReadiness; serviceMemory: ServiceMemoryInspection; phones?: {id:string;name:string}[]; actions?: AppUseAction[]; tools?: ServiceUseCall['tool'][] }> {
    const { project, memory } = await this.memory(projectId, serviceKey);
    const enabled = !!memory.record && this.activations().some(r => r.projectId === projectId && r.serviceKey === serviceKey && r.serviceMemoryId === memory.record!.serviceMemoryId);
    const adapter = await this.adapter(projectId, serviceKey);
    let environmentReady = false;
    let phones:{id:string;name:string}[]|undefined;
    if (adapter) try {
      await this.scope(adapter, owner);
      if(adapter.phoneTargets){
        const targets=await adapter.phoneTargets(owner);
        if(!Array.isArray(targets)||targets.length>256||new Set(targets.map(p=>p?.id)).size!==targets.length||targets.some(p=>!p||typeof p.id!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(p.id)||typeof p.name!=='string'||!p.name.trim()||p.name.length>80||/[\u0000-\u001f\u007f]/.test(p.name)))throw Error('승인 폰 목록을 확인하세요.');
        phones=targets.map(p=>({id:p.id,name:p.name}));
      }
      environmentReady = true;
    } catch { /* Login, app and operating grant remain distinct from activation. */ }
    const draft = project.projectName.toLowerCase() === 'shadowloop';
    return { serviceMemory: memory, ...(phones?{phones}:{}), ...(adapter && environmentReady ? {tools:[...adapter.tools], ...(adapter.actions ? {actions:normalizeAppUseActions(adapter.actions)} : {})} : {}), readiness: {
      enabled, memoryReady: memory.ready, tools: adapter ? 'verified' : draft ? 'draft' : 'unavailable', environmentReady,
      executionReady: enabled && memory.ready && memory.record?.storage==='project-namespace-v1' && !!adapter && environmentReady,
      problem: memory.problem ?? (!memory.ready ? 'USE 운영기억을 먼저 준비하세요.' : memory.record?.storage!=='project-namespace-v1' ? '프로젝트 USE 기억 정본 전환을 먼저 완료하세요.' : !enabled ? 'USE를 활성화하세요.' : !adapter ? draft ? SHADOWLOOP_USE_DRAFT.problem : '검증된 앱 운영 도구가 등록되지 않았습니다.' : !environmentReady ? '앱 로그인·보관함·설치·운영 권한을 확인하세요.' : null),
    } };
  }
  async enable(projectId: string, serviceKey = 'default') {
    const { memory } = await this.memory(projectId, serviceKey);
    if (!memory.ready || memory.record?.storage!=='project-namespace-v1') throw Error('프로젝트 USE 기억 정본 전환을 먼저 완료하세요.');
    mkdirSync(join(this.deps.appDataDir, 'service-use'), { recursive: true, mode: 0o700 });
    const release = await acquireOwnedFileLock(this.file + '.lock', { label: 'service-use-activation' });
    try {
      const services = this.activations();
      const previous = services.find(r => r.serviceMemoryId === memory.record!.serviceMemoryId);
      if (previous) {
        if (previous.projectId !== projectId || previous.serviceKey !== serviceKey) throw Error('기존 USE 활성화의 결속이 다릅니다.');
        return;
      }
      if (services.length >= 256) throw Error('USE 활성화 한도에 도달했습니다. 기존 기억은 보존했습니다.');
      services.push({ projectId, serviceKey, serviceMemoryId: memory.record.serviceMemoryId, enabled: true });
      if (!release.refresh()) throw Error('USE 활성화 잠금이 변경되었습니다.');
      const temporary = this.file + '.tmp-' + randomUUID();
      try { writeFileSync(temporary, JSON.stringify({ version: 1, services }) + '\n', { mode: 0o600 }); renameSync(temporary, this.file); }
      finally { rmSync(temporary, { force: true }); }
    } finally { release(); }
  }
  private async scope(adapter: ServiceUseAdapter, owner: string) {
    const scope = await adapter.scope(owner);
    if (!scope || ![scope.principalId, scope.libraryId, scope.deviceId, scope.installationId, scope.grantRevision].every(v => typeof v === 'string' && !!v && v.length <= 256)
      || !adapter.definitionRevision || !adapter.tools.length || adapter.tools.some(t => !(SERVICE_USE_ALL_TOOLS as readonly string[]).includes(t))) throw Error('앱 운영 권한 결속을 검증하지 못했습니다.');
    if (adapter.tools.includes('app.invoke')) normalizeAppUseActions(adapter.actions);
    // Copy known fields only. An adapter may not smuggle paths, credentials or tool overrides into a receipt.
    return { principalId: scope.principalId, libraryId: scope.libraryId, deviceId: scope.deviceId, installationId: scope.installationId, grantRevision: scope.grantRevision };
  }
  async bind(projectId: string, owner: string, call: ServiceUseCall, active: () => boolean): Promise<ServiceUseBinding> {
    const input = normalizeServiceUseCall(call);
    const { readiness, serviceMemory } = await this.status(projectId, owner, input.serviceKey);
    if (!active() || !readiness.executionReady || !serviceMemory.record) throw Error(readiness.problem ?? 'USE 실행 권한을 확인하세요.');
    const adapter = (await this.adapter(projectId, input.serviceKey))!;
    if (!adapter.tools.includes(input.tool)) throw Error('이 USE 서비스에 허용되지 않은 도구입니다.');
    if (input.tool === 'app.invoke') validateAppUseAction(adapter.actions ?? [], input.input.actionId!, input.input.arguments);
    const scope = await this.scope(adapter, owner);
    if (!active()) throw Error('USE 실행 권한이 변경되었습니다.');
    return { role: 'use', projectId, serviceKey: input.serviceKey, serviceMemoryId: serviceMemory.record.serviceMemoryId,
      ...scope, definitionRevision: adapter.definitionRevision, allowedTools: [...adapter.tools] };
  }
  private receipts() {
    return this.deps.receipts ??= new WorkroomThreadStore(join(this.deps.appDataDir, 'service-use'));
  }
  /** Admission is durable before the application write. Reconnect/restart never replays an unknown write. */
  async execute(projectId: string, owner: string, requestId: string, value: ServiceUseCall, active: () => boolean, expected?: ServiceUseBinding): Promise<ServiceUseOutcome> {
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(requestId)) throw Error('USE 요청 ID를 확인하세요.');
    const call = normalizeServiceUseCall(value), binding = await this.bind(projectId, owner, call, active);
    if (expected && digest(expected) !== digest(binding)) throw Error('USE 역할·서비스·사용자·보관함·설치·기억 또는 도구 권한이 변경되었습니다. 새 문맥으로 시작하세요.');
    const intentHash = digest({ owner, binding, call }), store = this.receipts();
    const at = new Date().toISOString(); let admitted = false;
    const receipt = await store.mutate(requestId, active, prior => {
      if (prior) { if (prior.intentHash !== intentHash) throw Error('같은 USE 요청 ID의 문맥 또는 입력이 다릅니다.'); return { record: prior, value: prior }; }
      admitted = true;
      const record: StoredWorkroomThread = { id: requestId, targetId: projectId, owner, fingerprint: digest(binding), bootId: 'service-use', intentHash,
        title: call.tool, agent: 'codex', sessionId: null, state: 'unknown', revision: 1, createdAt: at, updatedAt: at, messages: [], serviceExecution: { binding, call } };
      return { record, value: record };
    });
    if (!admitted) return receipt.serviceExecution?.outcome ?? unknownOutcome();
    let outcome: ServiceUseOutcome;
    try {
      const current = await this.bind(projectId, owner, call, active);
      if (digest(current) !== digest(binding)) throw Error('USE 권한이 변경되었습니다.');
      outcome = normalizeServiceUseOutcome(await (await this.adapter(projectId, call.serviceKey))!.execute(call, requestId, binding, active));
    } catch { outcome = unknownOutcome(); }
    return store.mutate(requestId, () => true, prior => {
      if (!prior?.serviceExecution || prior.intentHash !== intentHash) throw Error('USE 실행 영수증이 변경되었습니다.');
      if(prior.revision!==receipt.revision)return {record:prior,value:prior.serviceExecution.outcome??unknownOutcome(),unchanged:true};
      prior.serviceExecution.outcome = outcome; prior.state = outcome.state === 'cancelled' ? 'completed' : outcome.state;
      prior.revision++; prior.updatedAt = new Date().toISOString(); return { record: prior, value: outcome };
    });
  }
  async receipt(projectId: string, owner: string, requestId: string, active: () => boolean): Promise<ServiceUseOutcome> {
    const record = await this.receipts().get(requestId);
    if (!record?.serviceExecution || record.targetId !== projectId || record.owner !== owner || !active()) throw Error('이 USE 요청 영수증에 접근할 수 없습니다.');
    const binding = await this.bind(projectId, owner, record.serviceExecution.call, active);
    if (digest(binding) !== digest(record.serviceExecution.binding)) throw Error('원래 USE 실행 문맥이 변경되었습니다.');
    const adapter = await this.adapter(projectId, binding.serviceKey);
    const previous = record.serviceExecution.outcome;
    // Query the app's existing request. This path cannot submit the original work again.
    if (adapter?.receipt && (!previous || ['running','unknown'].includes(previous.state) || record.serviceExecution.call.tool==='phone.deliver'&&previous.evidence?.phoneReceived!==true)) {
      const outcome=normalizeServiceUseOutcome(await adapter.receipt(requestId,binding,active));
      if(!active())throw Error('USE 실행 권한이 변경되었습니다.');
      return this.receipts().mutate(requestId,active,prior=>{
        if(!prior?.serviceExecution||prior.intentHash!==record.intentHash)throw Error('USE 실행 영수증이 변경되었습니다.');
        if(prior.revision!==record.revision||digest(prior.serviceExecution.outcome??null)===digest(outcome))return {record:prior,value:prior.serviceExecution.outcome??unknownOutcome(),unchanged:true};
        prior.serviceExecution.outcome=outcome;prior.state=outcome.state==='cancelled'?'completed':outcome.state;prior.revision++;prior.updatedAt=new Date().toISOString();
        return {record:prior,value:outcome};
      });
    }
    return previous ?? unknownOutcome();
  }
}
