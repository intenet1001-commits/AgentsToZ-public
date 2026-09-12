import { createHash, randomUUID } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { terminalOutputPage } from './aiTerminalOutput';
import { normalizeAiTerminalRequest, type AiTerminalAgent, type AiTerminalRequest, type AiTerminalResponse, type AiTerminalSummary } from './aiTerminalProtocol';

type Pty = { write(data: string): number; resize(cols: number, rows: number): void; close(): void };
type Child = { pid: number; terminal: Pty; exited: Promise<number>; kill(signal?: number | string): void };
export interface AiTerminalResolvedTarget {
  cwd: string;
  /** Checks the existing session binding; never accepts a path from its caller. */
  revalidate?: () => Promise<{cwd:string}>;
}
export interface AiTerminalAuthority {
  owner:string;
  targets:ReadonlySet<string>;
  /** Internal live connection proof, never accepted from a wire request. */
  isActive?:()=>boolean;
  /** Verified durable consent, supplied only by the host gateway; never a wire field. */
  deviceConsentActive?:()=>boolean;
}

/** Live canonical mapping of every registered path. A symlink can change
 * without changing ports.json, and an alias introduced by another row can
 * make the selected checkout ambiguous. Neither change may reuse a proof. */
export function aiTerminalRegistrationEvidence(rows:readonly {
  id?:unknown;folderPath?:unknown;worktreePath?:unknown;worktreeParentId?:unknown;
}[]):string {
  const text = (value:unknown) => typeof value === 'string' ? value.trim() : '';
  const directory = (requested:string):unknown => {
    if (isAbsolute(requested) && !/[\u0000\r\n]/.test(requested)) {
      try {
        const canonical = realpathSync(requested), stat = statSync(canonical);
        return stat.isDirectory() ? [canonical,stat.dev,stat.ino] : 'not-directory';
      } catch (error:any) {
        return error?.code === 'ENOENT' || error?.code === 'ENOTDIR' ? 'missing' : 'unknown';
      }
    }
    return 'invalid';
  };
  return JSON.stringify(rows.map(row=>{
    const folder = text(row?.folderPath), worktree = text(row?.worktreePath);
    // folderPath also anchors Git family discovery when a row has both paths.
    return [text(row?.id),folder,directory(folder),worktree,directory(worktree),text(row?.worktreeParentId)];
  }));
}

/**
 * Cache a successful execution proof by filesystem evidence, never by time.
 * Every keystroke checks the live authority/checkout fingerprint. A changed
 * fingerprint requires the ordinary resolver again before any PTY write.
 */
export async function bindAiTerminalTarget<T extends {cwd:string}>(
  resolveTarget: () => Promise<T>,
  identity: (target:T) => string,
  fingerprint: (target:T) => string | Promise<string>,
): Promise<AiTerminalResolvedTarget> {
  const target = await resolveTarget();
  const boundIdentity = identity(target);
  let proof = await fingerprint(target);
  // Bracket the proof: a registry/Git replacement during its first resolution
  // must not become the baseline that future inputs mistakenly trust.
  const verified = await resolveTarget();
  const assertIdentity = (value:T) => {
    if (value.cwd !== target.cwd || identity(value) !== boundIdentity) {
      throw new Error('프로젝트 경로 또는 Git 연결이 변경되었습니다. 새 터미널을 여세요.');
    }
  };
  assertIdentity(verified);
  if (await fingerprint(verified) !== proof) throw new Error('프로젝트 상태가 변경되었습니다. 다시 시도하세요.');
  return {cwd:target.cwd,revalidate:async()=>{
    assertIdentity(target);
    const current = await fingerprint(target);
    if (current !== proof) {
      const fresh = await resolveTarget();
      assertIdentity(fresh);
      if (await fingerprint(fresh) !== current) throw new Error('프로젝트 상태가 변경되었습니다. 다시 시도하세요.');
      proof = current;
    }
    return {cwd:target.cwd};
  }};
}
export interface AiTerminalDependencies {
  resolveTarget(id: string): Promise<AiTerminalResolvedTarget>;
  executable(agent: AiTerminalAgent): string | null;
  spawn?: (args: string[], options: Record<string, unknown>) => Child;
  signalGroup?: (pid:number,signal:NodeJS.Signals)=>void;
  env?: Record<string, string | undefined>;
  maxBufferChars?: number;
  rememberEnded?: (session:{sessionId:string;targetId:string;cwd:string;agent:AiTerminalAgent})=>void;
  activity?: (cwd: string, agent: AiTerminalAgent) => void;
}
interface Session {
  summary: AiTerminalSummary; cwd: string; child: Child; chunks: {seq: number; text: string}[];
  next: number; buffered: number; decoder: TextDecoder; finished: Promise<void>;
  requestKeys: Set<string>;
  closing?: Promise<AiTerminalResponse>;
  revalidate?: AiTerminalResolvedTarget['revalidate'];
}
export const AI_TERMINAL_MAX_REQUEST_HISTORY = 100_000;
export const AI_TERMINAL_MAX_PENDING_MUTATIONS = 256;
const stopGroup = (pid: number, signal: NodeJS.Signals) => { try { process.kill(-pid, signal); } catch { /* already exited */ } };
/**
 * Prompt toolkits can swallow Enter while processing a paste burst. Codex
 * also leaves the submitted instruction in its composer in this case.
 * Preserve single keystrokes, but submit a combined paste only after it settles.
 */
export async function writeAiTerminalInput(agent: AiTerminalAgent, terminal: Pick<Pty, 'write'>, data: string): Promise<void> {
  if (data.length > 1 && data.endsWith('\r')) {
    terminal.write(data.slice(0, -1));
    await new Promise(resolve => setTimeout(resolve, agent==='codex'?150:40));
    terminal.write('\r');
    return;
  }
  terminal.write(data);
}
async function waitForTerminalExit(child:Child, timeoutMs:number, required=false) {
  let timer:ReturnType<typeof setTimeout>|undefined;
  try {
    await Promise.race([child.exited,new Promise<void>((resolve,reject)=>{
      timer=setTimeout(()=>required?reject(new Error('프로세스 종료를 확인하지 못했습니다. 다시 확인하세요.')):resolve(),timeoutMs);
    })]);
  } finally {clearTimeout(timer);}
}
export class AiTerminalService {
  #sessions = new Map<string, Session>();
  #requests = new Map<string, {fingerprint: string; promise: Promise<AiTerminalResponse>}>();
  #remote = new Set<string>();
  #grantEpoch = new Map<string, number>();
  #closed = false;
  #queues = new Map<string,Promise<unknown>>();
  #pendingMutations = 0;
  constructor(private readonly dependencies: AiTerminalDependencies) {}
  remoteAllowed(owner: string) { return this.#remote.has(owner); }
  setRemoteAccess(owner: string, enabled: boolean) {
    if (enabled === this.remoteAllowed(owner)) return;
    this.#grantEpoch.set(owner, (this.#grantEpoch.get(owner) ?? 0) + 1);
    if (enabled) this.#remote.add(owner); else this.#remote.delete(owner);
  }
  #summary(session: Session): AiTerminalSummary { return {...session.summary}; }
  #signal(session:Session,signal:NodeJS.Signals) {(this.dependencies.signalGroup??stopGroup)(session.child.pid,signal);}
  #remember(session:Session) {this.dependencies.rememberEnded?.({sessionId:session.summary.id,targetId:session.summary.targetId,cwd:session.cwd,agent:session.summary.agent});}
  #activity(cwd: string,agent:AiTerminalAgent) { try { this.dependencies.activity?.(cwd,agent); } catch { /* Capture must not break PTY input or exit. */ } }
  #forgetSessionRequests(session:Session) {
    // Once exited, the state fence rejects input/resize even after their retry
    // records are gone. Start IDs remain fenced for this service's lifetime.
    for (const key of session.requestKeys) this.#requests.delete(key);
    session.requestKeys.clear();
  }
  async perform(value: unknown, authority?: AiTerminalAuthority): Promise<AiTerminalResponse> {
    const request = normalizeAiTerminalRequest(value);
    if (this.#closed) throw new Error('터미널 서버가 종료 중입니다.');
    if (authority && (!(authority.deviceConsentActive ? authority.deviceConsentActive() : this.remoteAllowed(authority.owner)) || authority.isActive?.()===false)) throw new Error('Mac의 AI 터미널 화면에서 이 원격 연결의 터미널 접근을 허용하세요.');
    const visible = (s: Session) => !authority || authority.targets.has(s.summary.targetId);
    if (request.operation === 'list') return {sessions: [...this.#sessions.values()].filter(visible).map(s => this.#summary(s))};
    if (request.operation === 'start' && authority && !authority.targets.has(request.targetId!)) throw new Error('이 원격 연결에 등록된 프로젝트가 아닙니다.');
    const session = request.sessionId ? this.#sessions.get(request.sessionId) : null;
    if (request.operation !== 'start' && (!session || !visible(session))) throw new Error('터미널을 찾을 수 없거나 접근 권한이 없습니다.');
    if (request.operation === 'read') {
      return {session: this.#summary(session!), ...terminalOutputPage(session!.chunks,request.after!)};
    }
    // Retry ids are fenced before any await or write: neither a lost response nor double-click types twice.
    const key = `${authority?.owner ?? 'local'}:${request.requestId}`;
    const fingerprint = createHash('sha256').update(JSON.stringify(request)).digest('hex');
    const previous = this.#requests.get(key);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new Error('같은 요청 ID에 다른 입력을 보낼 수 없습니다.');
      return previous.promise;
    }
    if (request.operation === 'close' && session!.closing) return session!.closing;
    if (request.operation === 'input' || request.operation === 'resize') {
      if (session!.summary.state !== 'running') throw new Error('종료된 터미널입니다. 새 세션을 여세요.');
      if (session!.closing) throw new Error('터미널이 종료 중입니다.');
    }
    const closing = request.operation === 'close';
    // Close is naturally idempotent per session and must remain available even
    // when a live session has used its entire exactly-once input history.
    if (!closing && this.#requests.size >= AI_TERMINAL_MAX_REQUEST_HISTORY) throw new Error('터미널 요청 이력이 가득 찼습니다. 세션을 종료하면 입력 기록이 정리됩니다.');
    if (!closing && this.#pendingMutations >= AI_TERMINAL_MAX_PENDING_MUTATIONS) throw new Error('처리 중인 터미널 입력이 너무 많습니다. 잠시 후 다시 시도하세요.');
    const queueKey = request.sessionId ?? 'start';
    const epoch = authority ? this.#grantEpoch.get(authority.owner) : undefined;
    // Stop does not wait for a stalled checkout proof or queued keystrokes.
    // The mutation fence below prevents those writes after close is requested.
    const promise = (closing ? Promise.resolve() : this.#queues.get(queueKey) ?? Promise.resolve()).catch(()=>{}).then(()=>this.#mutate(request, session, authority, epoch));
    if (!closing) this.#queues.set(queueKey,promise);
    if (closing) session!.closing = promise;
    else {
      this.#pendingMutations++;
      this.#requests.set(key, {fingerprint, promise});
      session?.requestKeys.add(key);
    }
    const settled = () => {
      if (this.#queues.get(queueKey) === promise) this.#queues.delete(queueKey);
      if (closing) {if (session!.closing === promise) session!.closing = undefined;}
      else this.#pendingMutations--;
    };
    void promise.then(settled, settled);
    return promise;
  }
  async #mutate(r: AiTerminalRequest, session: Session | null | undefined, authority?: AiTerminalAuthority, epoch?: number): Promise<AiTerminalResponse> {
    if (authority && (!(authority.deviceConsentActive ? authority.deviceConsentActive() : this.remoteAllowed(authority.owner)) || authority.isActive?.()===false || this.#grantEpoch.get(authority.owner) !== epoch)) throw new Error('원격 터미널 권한이 해제되었습니다.');
    if(this.#closed)throw new Error('터미널 서버가 종료 중입니다.');
    if (r.operation === 'close') {
      // Persist the request before terminating the CLI; save runs only after exit.
      this.#remember(session!);
      if (session!.summary.state === 'exited') return {session:this.#summary(session!)};
      this.#signal(session!,'SIGTERM');
      await waitForTerminalExit(session!.child,500);
      if(session!.summary.state==='running') this.#signal(session!,'SIGKILL');
      await waitForTerminalExit(session!.child,2_000,true);
      await session!.finished;
      session!.child.terminal.close();
      return {session:this.#summary(session!)};
    }
    if (session && (session.closing || session.summary.state !== 'running')) throw new Error('터미널이 종료 중이거나 종료되었습니다.');
    const targetId = r.targetId ?? session!.summary.targetId;
    const target:AiTerminalResolvedTarget = session?.revalidate
      ? await session.revalidate()
      : await this.dependencies.resolveTarget(targetId);
    if (authority && (!(authority.deviceConsentActive ? authority.deviceConsentActive() : this.remoteAllowed(authority.owner)) || authority.isActive?.()===false || this.#grantEpoch.get(authority.owner) !== epoch)) throw new Error('원격 터미널 권한이 해제되었습니다.');
    if (this.#closed) throw new Error('터미널 서버가 종료 중입니다.');
    if (session && (session.closing || session.summary.state !== 'running')) throw new Error('터미널이 종료 중이거나 종료되었습니다.');
    const cwd = realpathSync(target.cwd);
    if (!isAbsolute(cwd) || !statSync(cwd).isDirectory() || (session && cwd !== session.cwd)) throw new Error('프로젝트 경로가 변경되었습니다. 새 터미널을 여세요.');
    if (r.operation === 'start') {
      if(process.platform==='win32')throw new Error('AI 터미널은 현재 macOS·Linux에서 지원합니다.');
      if ([...this.#sessions.values()].filter(s => s.summary.state === 'running').length >= 12) throw new Error('실행 중인 터미널은 최대 12개입니다.');
      const executable = this.dependencies.executable(r.agent!);
      if (!executable || !isAbsolute(executable)) throw new Error(`${r.agent} CLI가 설치되어 있지 않습니다.`);
      const env = {...(this.dependencies.env ?? process.env), TERM:'xterm-256color', COLORTERM:'truecolor'};
      // Keep the CLI's ordinary user environment; never inherit this app's private control capabilities.
      for (const name of Object.keys(env)) if (/^(PORTMGR_|AGENTSTOZ_).*CAPABILITY|^(SUPABASE_SERVICE_ROLE_KEY|VITE_SUPABASE_SERVICE_ROLE_KEY)$/.test(name)) delete (env as Record<string, unknown>)[name];
      const summary: AiTerminalSummary = {id:randomUUID(),targetId,agent:r.agent!,state:'running',createdAt:new Date().toISOString(),exitCode:null,cols:r.cols!,rows:r.rows!};
      const record = {summary,cwd,chunks:[],next:0,buffered:0,decoder:new TextDecoder(),requestKeys:new Set<string>(),revalidate:target.revalidate} as unknown as Session;
      const append = (text: string) => {
        for (let start=0;start<text.length;) {
          let end=Math.min(text.length,start+1024);
          if(end<text.length && /[\uD800-\uDBFF]/.test(text[end-1]!)) end--;
          const part=text.slice(start,end); record.chunks.push({seq:++record.next,text:part});record.buffered+=part.length;start=end;
        }
        while (record.buffered > (this.dependencies.maxBufferChars ?? 1_000_000) && record.chunks.length > 1) record.buffered-=record.chunks.shift()!.text.length;
      };
      const spawn = this.dependencies.spawn ?? ((args,options) => (Bun.spawn as any)(args,options));
      const args = r.prompt ? [executable, '--', r.prompt] : [executable];
      let eof!:()=>void;const streamEnded=new Promise<void>(resolve=>{eof=resolve});
      record.child = spawn(args,{cwd,env,detached:true,terminal:{cols:r.cols,rows:r.rows,exit:()=>eof(),data:(_pty:Pty,data:Uint8Array)=>append(record.decoder.decode(data,{stream:true}))}});
      this.#sessions.set(summary.id,record);
      this.#activity(cwd,r.agent!);
      record.finished=record.child.exited.then(async code => {
        // Process exit and PTY EOF are distinct. Drain its final screen before publishing exited.
        let timer:ReturnType<typeof setTimeout>|undefined;
        await Promise.race([streamEnded,new Promise(resolve=>{timer=setTimeout(resolve,1000)})]);clearTimeout(timer);
        append(record.decoder.decode());summary.state='exited';summary.exitCode=code;record.child.terminal.close();this.#forgetSessionRequests(record);
        this.#activity(cwd,record.summary.agent);
        try {this.#remember(record);} catch { /* Explicit close can retry durable enqueue. */ }
      },()=>{summary.state='exited';summary.exitCode=-1;record.child.terminal.close();this.#forgetSessionRequests(record);});
      for (const [id,old] of this.#sessions) if (this.#sessions.size>24 && old.summary.state==='exited') this.#sessions.delete(id);
      return {session:this.#summary(record)};
    }
    {
      if (session!.summary.state !== 'running') throw new Error('종료된 터미널입니다. 새 세션을 여세요.');
      if (r.operation === 'input') { await writeAiTerminalInput(session!.summary.agent,session!.child.terminal,r.data!); this.#activity(cwd,session!.summary.agent); }
      else {session!.child.terminal.resize(r.cols!,r.rows!);session!.summary.cols=r.cols!;session!.summary.rows=r.rows!;}
    }
    return {session:this.#summary(session!)};
  }
  async shutdown() {
    this.#closed=true;this.#remote.clear();
    for(const s of this.#sessions.values()) {try {this.#remember(s);} catch { /* Never prevent process cleanup. */ }}
    for (const s of this.#sessions.values()) if(s.summary.state==='running') this.#signal(s,'SIGTERM');
    await new Promise(resolve=>setTimeout(resolve,200));
    for (const s of this.#sessions.values()) if(s.summary.state==='running') {this.#signal(s,'SIGKILL');s.child.terminal.close();}
  }
}
