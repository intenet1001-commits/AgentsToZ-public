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
export interface ServiceUseStatus { readiness: ServiceUseReadiness; serviceMemory: ServiceMemoryInspection; turnedOff: boolean; phones?: {id:string;name:string}[]; actions?: AppUseAction[]; tools?: ServiceUseCall['tool'][] }
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
/**
 * One row per activated USE memory. 「USE 끄기」 sets `enabled` false and keeps the row, so turning it back on re-checks the
 * same project/service binding and continues the same memory, app connection and receipts. On disk a turned-off row lives
 * in `off`, not in `services`: an older build reads only `services` (and rejects `enabled:false` there), so after a
 * downgrade every other USE keeps working and this one stays off.
 */
type Activation = { projectId: string; serviceKey: string; serviceMemoryId: string; enabled: boolean };
const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const unknownOutcome = (): ServiceUseOutcome => ({ state: 'unknown', message: '앱 실행 결과를 확인해야 합니다. 원래 요청 ID로 조회하고 같은 작업을 자동 재실행하지 마세요.' });
export const SHADOWLOOP_USE_DRAFT = Object.freeze({
  app: 'ShadowLoop', revision: 'shadowloop-use-v1-draft', state: 'draft' as const, tools: SERVICE_USE_TOOLS,
  problem: 'ShadowLoop 앱의 ‘AI 운영 연결’에서 코드를 발급해 Mac의 작업 세션 → USE 준비에 입력하세요.',
});
export const SERVICE_USE_ENVIRONMENT_PROBLEM = '앱 로그인·보관함·설치·운영 권한을 확인하세요.';
/** The refusal for every new USE request while it is off. It says nothing was lost and how to turn it back on. */
export const SERVICE_USE_OFF_PROBLEM = 'USE가 꺼져 있습니다. 운영기억·앱 연결·이전 결과는 그대로 있습니다. 다시 쓰려면 Mac의 작업 세션 → USE 준비에서 「USE 다시 켜기」를 누르세요.';
/** Off, and the app connection is not there either: the off line must not claim a connection it did not check. */
export const serviceUseOffConnectionProblem = (connectionProblem: string) =>
  `USE가 꺼져 있습니다. 운영기억과 이전 결과는 그대로 있지만 앱 연결은 확인이 필요합니다. ${connectionProblem}`;
export const SERVICE_USE_UNCONNECTED_PROBLEM = '앱이 아직 연결되지 않았습니다. Mac의 작업 세션 → USE 준비에서 앱 연결 코드를 입력하세요. 앱에 연결 기능이 없으면 같은 화면의 ‘워크룸에서 USE 연결 준비’로 먼저 만드세요.';
// Exact texts thrown by the installed connectors (appUseConnector.ts, shadowLoopUseAdapter.ts).
// tests/app-use.test.ts and tests/shadowloop-use-adapter.test.ts produce them from the real connectors.
const CONNECTOR_UNREACHABLE = new Set(['앱의 USE 연결 응답을 확인하지 못했습니다. 앱을 열고 원래 요청 ID로 결과를 확인하세요.', 'ShadowLoop 앱을 열고 AI 운영 연결을 확인하세요. 응답이 유실된 작업은 원래 요청 ID로 조회하세요.']);
const CONNECTOR_REJECTED = new Set(['앱의 USE 운영 권한과 원래 요청 ID를 확인하세요.', 'ShadowLoop 운영 연결·현재 프로필·원래 작업 ID를 확인하세요.']);
const CONNECTOR_CHANGED = new Set(['앱의 사용자·자료·동작 권한이 변경되었습니다. USE 연결을 다시 확인하세요.']);
const CONNECTOR_LOCAL_ONLY = new Set(['이 앱 USE 연결은 이 기기의 로컬 사용자 전용입니다.', '이 ShadowLoop 연결은 이 Mac의 로컬 사용자 전용입니다.']);
const CONNECTOR_OTHER_PROJECT = new Set(['이 프로젝트의 앱 USE 연결 계약을 확인하세요.']);
const errorText = (error: unknown) => error instanceof Error ? error.message : '';
/**
 * Status reaches MCP, voice and the phone, so it never carries raw error text (paths, storage or crypto details).
 * Only the known connector failures become a next step; everything else keeps the generic line.
 */
export function serviceUseEnvironmentProblem(error: unknown, appName: string, owner: string): string {
  const text = errorText(error);
  if (owner !== 'local' && CONNECTOR_LOCAL_ONLY.has(text)) return 'USE 실행은 지금 이 Mac에서만 할 수 있습니다. Mac의 작업 세션이나 커뮤니티에서 요청하세요.';
  if (CONNECTOR_UNREACHABLE.has(text)) return `${appName} 앱이 응답하지 않습니다. 이 Mac에서 앱이 실행 중인지 확인한 뒤 다시 확인하세요.`;
  if (CONNECTOR_CHANGED.has(text)) return '앱의 동작 목록이나 사용자가 바뀌었습니다. 앱에서 연결 코드를 다시 발급해 Mac의 작업 세션 → USE 준비에 입력하세요.';
  return SERVICE_USE_ENVIRONMENT_PROBLEM;
}
/** Connecting is a Mac-local step: the request ID wording of execute/receipt does not apply yet. */
export function serviceUseConnectProblem(error: unknown, appName: string): string {
  const text = errorText(error), shadowLoop = text.startsWith('ShadowLoop');
  if (CONNECTOR_UNREACHABLE.has(text)) return `${shadowLoop ? 'ShadowLoop' : '코드를 발급한'} 앱이 이 Mac에서 실행 중인지 확인한 뒤 다시 연결하세요.`;
  if (CONNECTOR_REJECTED.has(text)) return `${shadowLoop ? 'ShadowLoop' : appName} 앱이 이 코드를 받지 않았습니다. 코드가 만료·해제됐거나 잘못 입력됐을 수 있으니 앱에서 새 코드를 발급하세요.`;
  if (CONNECTOR_OTHER_PROJECT.has(text)) return '이 코드가 선택한 프로젝트와 맞지 않습니다. 위에서 프로젝트를 확인하거나 이 프로젝트의 앱에서 코드를 다시 발급하세요.';
  return text || 'USE 연결을 확인하지 못했습니다.';
}

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
    const rows = (value: unknown, enabled: boolean): value is Activation[] => Array.isArray(value)
      && value.every((r: Activation) => !!r && r.enabled === enabled && [r.projectId, r.serviceKey, r.serviceMemoryId].every(v => typeof v === 'string' && !!v));
    if (data.version !== 1 || !rows(data.services, true) || data.off !== undefined && !rows(data.off, false)) throw Error('USE 활성화 설정을 검증하지 못했습니다.');
    const all: Activation[] = [...data.services, ...(data.off ?? [])];
    if (all.length > 256 || new Set(all.map(r => r.serviceMemoryId)).size !== all.length) throw Error('USE 활성화 설정을 검증하지 못했습니다.');
    return all.map(({ projectId, serviceKey, serviceMemoryId, enabled }) => ({ projectId, serviceKey, serviceMemoryId, enabled }));
  }
  /** One writer at a time. `change` returns the next rows, or null when nothing changes. */
  private async changeActivations(change: (rows: Activation[]) => Activation[] | null) {
    mkdirSync(join(this.deps.appDataDir, 'service-use'), { recursive: true, mode: 0o700 });
    const release = await acquireOwnedFileLock(this.file + '.lock', { label: 'service-use-activation' });
    try {
      const next = change(this.activations());
      if (!next) return;
      if (!release.refresh()) throw Error('USE 활성화 잠금이 변경되었습니다.');
      const services = next.filter(r => r.enabled), off = next.filter(r => !r.enabled);
      const temporary = this.file + '.tmp-' + randomUUID();
      try { writeFileSync(temporary, JSON.stringify({ version: 1, services, ...(off.length ? { off } : {}) }) + '\n', { mode: 0o600 }); renameSync(temporary, this.file); }
      finally { rmSync(temporary, { force: true }); }
    } finally { release(); }
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
      // A turned-off USE is not offered as @/# anywhere; its memory and connection stay for 「USE 다시 켜기」.
      if (!row.enabled || !projectIds.has(row.projectId)) continue;
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
    if (!services.get(projectId)?.includes(serviceKey)) {
      const rows = this.activations().filter(r => r.projectId === projectId && r.serviceKey === serviceKey);
      throw Error(rows.length && rows.every(r => !r.enabled) ? SERVICE_USE_OFF_PROBLEM : '활성화된 USE 운영기억을 확인하세요.');
    }
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
  /**
   * `turnedOff` (Mac-local; publicServiceUseStatus never sends it on a conversational transport) tells 「USE 끄기」 apart
   * from a USE that was never turned on, so the setup dialog can offer 「USE 다시 켜기」.
   */
  async status(projectId: string, owner: string, serviceKey = 'default'): Promise<ServiceUseStatus> {
    const { readable: _readable, readProblem: _readProblem, ...status } = await this.evaluate(projectId, owner, serviceKey);
    return status;
  }
  /**
   * `readable` is execution readiness without the on/off flag: the same memory, app connection and scope. Reading an
   * earlier result (a receipt, a USE thread) needs only that, so turning USE off never hides or loses a result.
   */
  private async evaluate(projectId: string, owner: string, serviceKey: string): Promise<ServiceUseStatus & { readable: boolean; readProblem: string | null }> {
    const { project, memory } = await this.memory(projectId, serviceKey);
    const rows = memory.record ? this.activations().filter(r => r.projectId === projectId && r.serviceKey === serviceKey && r.serviceMemoryId === memory.record!.serviceMemoryId) : [];
    const enabled = rows.some(r => r.enabled), turnedOff = !enabled && rows.length > 0;
    const adapter = await this.adapter(projectId, serviceKey);
    let environmentReady = false, environmentProblem = SERVICE_USE_ENVIRONMENT_PROBLEM;
    let phones:{id:string;name:string}[]|undefined;
    if (adapter) try {
      await this.scope(adapter, owner);
      if(adapter.phoneTargets){
        const targets=await adapter.phoneTargets(owner);
        if(!Array.isArray(targets)||targets.length>256||new Set(targets.map(p=>p?.id)).size!==targets.length||targets.some(p=>!p||typeof p.id!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(p.id)||typeof p.name!=='string'||!p.name.trim()||p.name.length>80||/[\u0000-\u001f\u007f]/.test(p.name)))throw Error('승인 폰 목록을 확인하세요.');
        phones=targets.map(p=>({id:p.id,name:p.name}));
      }
      environmentReady = true;
    } catch (error) { environmentProblem = serviceUseEnvironmentProblem(error, project.projectName, owner); /* Login, app and operating grant remain distinct from activation. */ }
    const draft = project.projectName.toLowerCase() === 'shadowloop';
    const memoryProblem = memory.problem ?? (!memory.ready ? 'USE 운영기억을 먼저 준비하세요.' : memory.record?.storage!=='project-namespace-v1' ? '프로젝트 USE 기억 정본 전환을 먼저 완료하세요.' : null);
    const connectionProblem = !adapter ? draft ? SHADOWLOOP_USE_DRAFT.problem : SERVICE_USE_UNCONNECTED_PROBLEM : !environmentReady ? environmentProblem : null;
    const readable = memory.ready && memory.record?.storage==='project-namespace-v1' && !!adapter && environmentReady;
    return { serviceMemory: memory, turnedOff, ...(phones?{phones}:{}), ...(adapter && environmentReady ? {tools:[...adapter.tools], ...(adapter.actions ? {actions:normalizeAppUseActions(adapter.actions)} : {})} : {}), readiness: {
      enabled, memoryReady: memory.ready, tools: adapter ? 'verified' : draft ? 'draft' : 'unavailable', environmentReady,
      executionReady: enabled && readable,
      problem: memoryProblem ?? (!enabled ? turnedOff ? connectionProblem ? serviceUseOffConnectionProblem(connectionProblem) : SERVICE_USE_OFF_PROBLEM : 'USE를 활성화하세요.' : connectionProblem),
    }, readable, readProblem: memoryProblem ?? connectionProblem };
  }
  async enable(projectId: string, serviceKey = 'default') {
    const { memory } = await this.memory(projectId, serviceKey);
    if (!memory.ready || memory.record?.storage!=='project-namespace-v1') throw Error('프로젝트 USE 기억 정본 전환을 먼저 완료하세요.');
    const serviceMemoryId = memory.record.serviceMemoryId;
    await this.changeActivations(services => {
      const previous = services.find(r => r.serviceMemoryId === serviceMemoryId);
      if (previous) {
        if (previous.projectId !== projectId || previous.serviceKey !== serviceKey) throw Error('기존 USE 활성화의 결속이 다릅니다.');
        // 「USE 다시 켜기」: the same row, memory, connection and receipts. Only the flag changes.
        return previous.enabled ? null : services.map(r => r === previous ? { ...r, enabled: true } : r);
      }
      if (services.length >= 256) throw Error('USE 활성화 한도에 도달했습니다. 기존 기억은 보존했습니다.');
      return [...services, { projectId, serviceKey, serviceMemoryId, enabled: true }];
    });
  }
  /**
   * 「USE 끄기」 is not a migration rollback. The project-namespace USE memory, its memoryId/serviceKey, the app connection
   * and every receipt stay as they are; only the activation flag turns false. While off, @/# no longer offers this USE and
   * a new execution is refused with SERVICE_USE_OFF_PROBLEM, but status and the receipt of an earlier request ID still
   * answer. enable() turns the same row back on. It needs no readable memory, so a broken memory can still be turned off.
   */
  async disable(projectId: string, serviceKey = 'default'): Promise<{ changed: boolean }> {
    let changed = false;
    const mine = (r: Activation) => r.projectId === projectId && r.serviceKey === serviceKey;
    await this.changeActivations(services => {
      if (!services.some(r => mine(r) && r.enabled)) return null;
      changed = true;
      return services.map(r => mine(r) ? { ...r, enabled: false } : r);
    });
    return { changed };
  }
  private async scope(adapter: ServiceUseAdapter, owner: string) {
    const scope = await adapter.scope(owner);
    if (!scope || ![scope.principalId, scope.libraryId, scope.deviceId, scope.installationId, scope.grantRevision].every(v => typeof v === 'string' && !!v && v.length <= 256)
      || !adapter.definitionRevision || !adapter.tools.length || adapter.tools.some(t => !(SERVICE_USE_ALL_TOOLS as readonly string[]).includes(t))) throw Error('앱 운영 권한 결속을 검증하지 못했습니다.');
    if (adapter.tools.includes('app.invoke')) normalizeAppUseActions(adapter.actions);
    // Copy known fields only. An adapter may not smuggle paths, credentials or tool overrides into a receipt.
    return { principalId: scope.principalId, libraryId: scope.libraryId, deviceId: scope.deviceId, installationId: scope.installationId, grantRevision: scope.grantRevision };
  }
  /**
   * The binding a new execution is admitted under. `reading` (an earlier request's receipt or thread, never a new app
   * write) skips only the on/off flag; the memory, connection, scope and tools are checked the same way.
   */
  async bind(projectId: string, owner: string, call: ServiceUseCall, active: () => boolean, options: { reading?: boolean } = {}): Promise<ServiceUseBinding> {
    const input = normalizeServiceUseCall(call);
    const { readiness, serviceMemory, readable, readProblem } = await this.evaluate(projectId, owner, input.serviceKey);
    const ready = options.reading ? readable : readiness.executionReady;
    if (!active() || !ready || !serviceMemory.record) throw Error((options.reading ? readProblem : readiness.problem) ?? 'USE 실행 권한을 확인하세요.');
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
    const call = normalizeServiceUseCall(value), store = this.receipts();
    // Sending an admitted request ID again is a retry, not new work: it answers with the stored result even while USE
    // is off. Only the on/off flag is skipped; the mutate below still refuses to admit anything under that binding.
    const earlier = await store.get(requestId), retry = !!earlier?.serviceExecution && earlier.targetId === projectId && earlier.owner === owner;
    const binding = await this.bind(projectId, owner, call, active, { reading: retry });
    if (expected && digest(expected) !== digest(binding)) throw Error('USE 역할·서비스·사용자·보관함·설치·기억 또는 도구 권한이 변경되었습니다. 새 문맥으로 시작하세요.');
    const intentHash = digest({ owner, binding, call });
    const at = new Date().toISOString(); let admitted = false;
    const receipt = await store.mutate(requestId, active, prior => {
      if (prior) { if (prior.intentHash !== intentHash) throw Error('같은 USE 요청 ID의 문맥 또는 입력이 다릅니다.'); return { record: prior, value: prior }; }
      if (retry) throw Error('USE 실행 영수증이 변경되었습니다.');
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
    // An earlier request still answers while USE is off: a receipt only queries, it never submits the work again.
    const binding = await this.bind(projectId, owner, record.serviceExecution.call, active, { reading: true });
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
