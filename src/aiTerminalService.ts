import { createHash, randomUUID } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join } from 'node:path';
import { terminalOutputPage } from './aiTerminalOutput';
import { AiTerminalScreen } from './aiTerminalScreen';
import { stripViewerTerminalReplies, type ViewerReplyFilterState } from './aiTerminalReplyFilter';
import { dropPartialTerminalPrefix, incompleteEscapeSuffix, keepTailUtf8, renderTerminalPlainText, TERMINAL_TAIL_MAX_BYTES } from './terminalPlainText';
import { WORKROOM_SESSION_ENV, WORKROOM_TARGET_ENV } from './workroomCaller';
import { aiTerminalLaunchArgs, type AiTerminalLaunchProfile } from './aiTerminalLaunchArgs';
import { codexHooksAreAgentsToZOnly, codexSupportsHookTrustFlag } from './codexHookTrust';
import { processGroupOpenFiles, resolveAiTerminalResume, type AiTerminalResume, type AiTerminalResumeSource } from './aiTerminalResume';
import { aiTerminalSubmitSteps } from './aiTerminalSubmit';
import { AI_TERMINAL_PROMPT_REFERENCES_TOO_LARGE_ERROR, normalizeAiTerminalRequest, type AiTerminalAgent, type AiTerminalRequest, type AiTerminalResponse, type AiTerminalSummary } from './aiTerminalProtocol';
import { aiInitialPromptError } from './aiInitialPrompt';
import { WINDOWS_PTY_RUNTIME_MISSING, spawnWindowsPty, windowsPtyAvailable, windowsSignalTree } from './windowsPty';

/**
 * Only reachable when the Windows PTY runtime is missing from the install.
 * Windows Workroom sessions themselves are supported: `spawnWindowsPty` drives
 * ConPTY through node-pty loaded from disk beside the sidecar.
 */
export const AI_TERMINAL_WINDOWS_UNSUPPORTED = WINDOWS_PTY_RUNTIME_MISSING;

/**
 * Whether a Windows start has no PTY to run on. The only canonical decision, so
 * the refusal cannot drift from what actually gates it.
 *
 * An injected spawn wins: the tests above drive the service with a fake child
 * and must not start refusing just because they run on Windows.
 */
export function aiTerminalWindowsStartBlocked(input: {
  platform: string;
  injectedSpawn: boolean;
  ptyAvailable: boolean;
}): boolean {
  return input.platform === 'win32' && !input.injectedSpawn && !input.ptyAvailable;
}

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
  /** false disables the headless screen copy (snapshot reads then replay like before). */
  headlessScreen?: boolean;
  /** Tests: whether the Codex binary knows `--dangerously-bypass-hook-trust` (default: ask `codex --help` once). */
  codexHookTrustSupported?: (executable: string, env: Record<string, string | undefined>) => Promise<boolean>;
  rememberEnded?: (session:{sessionId:string;targetId:string;cwd:string;agent:AiTerminalAgent})=>void;
  verifySavedBeforeClose?: (session:{id:string;targetId:string;cwd:string;inputRevision:number},requestId:string,owner:string)=>Promise<void>;
  activity?: (cwd: string, agent: AiTerminalAgent) => void;
  /** Which conversation a 「다시 시작」 continues (src/aiTerminalResume.ts); null starts a fresh one. */
  resume?: (source: AiTerminalResumeSource) => Promise<AiTerminalResume | null>;
}
interface Session {
  summary: AiTerminalSummary; cwd: string; child: Child; chunks: {seq: number; text: string}[];
  next: number; buffered: number; decoder: TextDecoder; finished: Promise<void>;
  /** Epoch ms of the last PTY output; host-only (the wire summary never carries it). */
  lastOutputAt: number | null;
  requestKeys: Set<string>;
  inputRevision:number; suppressMemoryOnExit?:boolean;
  closing?: Promise<AiTerminalResponse>;
  revalidate?: AiTerminalResolvedTarget['revalidate'];
  /** Headless copy of the PTY screen for `read` with `snapshot:true`. */
  screen?: AiTerminalScreen;
  /** Host-only: the viewer-input stream state for reply stripping (a paste or an escape cut across requests). */
  viewerPaste?: ViewerReplyFilterState;
  /**
   * Host-only: the bytes already written leave the CLI inside a paste a viewer opened. The host's own query
   * answers wait until it ends — written in the middle, an answer would become pasted text (aiTerminalScreen.ts).
   */
  ptyInViewerPaste?: boolean;
  heldReplies?: string[];
  /** Host-only: the permission mode it was launched with, kept by a restart. */
  bypass: boolean;
  launchProfile?: AiTerminalLaunchProfile;
  /** Host-only: the CLI conversation it runs when known (Claude's `--session-id`, or what it resumed). */
  conversationId?: string;
  exitedAt?: string;
}
/** An exited session pruned from the live list; a late read or wait still answers `exited` with its last output. */
interface RetiredSession {
  summary: AiTerminalSummary; lastOutputAt: number | null;
  /** The newest AI_TERMINAL_TAIL_RAW_CHARS of its output, with the original sequence numbers. */
  chunks: {seq: number; text: string}[]; next: number;
}
export const AI_TERMINAL_MAX_REQUEST_HISTORY = 100_000;
export const AI_TERMINAL_MAX_PENDING_MUTATIONS = 256;
/** Newest raw output a tail read renders; enough for its byte budget after escape codes are gone. */
export const AI_TERMINAL_TAIL_RAW_CHARS = 48_000;
/** Pruned sessions whose last output is kept (about 3 MB at most). */
export const AI_TERMINAL_MAX_RETIRED_SESSIONS = 32;
/** How far before a tail window an unfinished escape sequence (e.g. a long OSC link) is looked for. */
const TAIL_ESCAPE_LOOKBACK_CHARS = 4_096;

/**
 * Where a tail window may start. Chunks are cut every 1,024 characters regardless of escape codes.
 * - The caller's own cursor: keep every new character and repair a sequence it split by prepending
 *   the unfinished part from the chunks before.
 * - A window cut by the raw budget, or whose older chunks are gone: older output is omitted anyway,
 *   so drop a partial first line or sequence instead of printing its remainder as text.
 */
function tailWindowStart(raw: string, chunks: readonly {seq: number; text: string}[], firstIndex: number, truncated: boolean): string {
  if (firstIndex <= 0) return dropPartialTerminalPrefix(raw);
  let before = '';
  for (let i = firstIndex - 1; i >= 0 && before.length < TAIL_ESCAPE_LOOKBACK_CHARS; i--) before = chunks[i]!.text + before;
  const carry = incompleteEscapeSuffix(before);
  if (!truncated) return carry + raw;
  return carry || !chunks[firstIndex - 1]!.text.endsWith('\n') ? dropPartialTerminalPrefix(raw) : raw;
}
const stopGroup = (pid: number, signal: NodeJS.Signals) => {
  // Windows has no process group to signal: a negative pid is not a Windows
  // concept, so `process.kill(-pid)` would throw and the CLI's own children
  // would survive. `taskkill /T` is the native tree kill (src/windowsPty.ts).
  if (process.platform === 'win32') { windowsSignalTree(pid, signal); return; }
  try { process.kill(-pid, signal); } catch { /* already exited */ }
};
/** Only multi-line input can become a bracketed paste, so single keystrokes never wait for the screen parser. */
export const aiTerminalPasteCandidate = (data: string) => data.length > 1 && data.includes('\n');
/**
 * Prompt toolkits can swallow Enter while processing a paste burst. Codex
 * also leaves the submitted instruction in its composer in this case.
 * Preserve single keystrokes, but submit a combined paste only after it settles.
 * The byte sequence (including bracketed paste for multi-line text) is `aiTerminalSubmitSteps`.
 */
export async function writeAiTerminalInput(agent: AiTerminalAgent, terminal: Pick<Pty, 'write'>, data: string, screen: {bracketedPaste?: boolean} = {}, written?: () => void): Promise<void> {
  for (const step of aiTerminalSubmitSteps(agent, data, screen)) {
    if ('waitMs' in step) {
      // Bun hands a PTY write to the CLI only on a later event-loop turn. If the loop stalled before that turn, the
      // body and the Enter written after the wait reached the CLI in one read, and Codex took that Enter as part of a
      // paste (real Codex 0.160: 0/6 submitted with a 200 ms stall right after the body). One timer turn flushes the
      // body first, so the measured wait is counted from delivery, not from the write call.
      await new Promise(resolve => setTimeout(resolve, 0));
      await new Promise(resolve => setTimeout(resolve, step.waitMs));
    } else { terminal.write(step.write); written?.(); }
  }
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
  #retired = new Map<string, RetiredSession>();
  /** Running CLI pid (each leads its own process group) → session id. Host-only caller hint, never authority. */
  #sessionByPid = new Map<number, string>();
  #requests = new Map<string, {fingerprint: string; promise: Promise<AiTerminalResponse>}>();
  #remote = new Set<string>();
  #grantEpoch = new Map<string, number>();
  #closed = false;
  #queues = new Map<string,Promise<unknown>>();
  #pendingMutations = 0;
  constructor(private readonly dependencies: AiTerminalDependencies) {}
  #session(id:string,targetId:string) {
    const s=this.#sessions.get(id);
    if(!s||s.summary.targetId!==targetId)throw new Error('선택한 워크룸 세션을 찾을 수 없습니다.');
    return s;
  }
  inspectSession(id:string,targetId:string) {
    const s=this.#session(id,targetId);
    // Host-only cursor for bounded recent context; no terminal text or local path added to the wire.
    let recentOutputCursor=s.next,characters=0;
    for(let i=s.chunks.length-1;i>=0&&characters<6000;i--){const chunk=s.chunks[i]!;characters+=chunk.text.length;recentOutputCursor=chunk.seq-1;}
    return {...s.summary,cwd:s.cwd,inputRevision:s.inputRevision,outputCursor:s.next,recentOutputCursor,lastOutputAt:s.lastOutputAt};
  }
  /** Host-only: this local request ID already started or typed into a session (start IDs stay fenced). */
  hasLocalRequest(requestId:string) { return this.#requests.has(`local:${requestId}`); }
  /** Host-only caller hint: the running session whose CLI (or its process group) is one of these processes. */
  sessionForProcesses(pids:Iterable<number>):AiTerminalSummary|null {
    for(const pid of pids){
      const id=this.#sessionByPid.get(pid),session=id===undefined?undefined:this.#sessions.get(id);
      if(session&&session.summary.state==='running')return this.#summary(session);
    }
    return null;
  }
  /** Host-only: the session while it is running, else null (exited, pruned or unknown). */
  runningSession(id:string):AiTerminalSummary|null {
    const session=this.#sessions.get(id);
    return session&&session.summary.state==='running'?this.#summary(session):null;
  }
  /** Host-only: an exited session already pruned from the live list, while its last output is kept. */
  retiredSession(id:string):AiTerminalSummary|null {
    const retired=this.#retired.get(id);
    return retired?{...retired.summary}:null;
  }
  /** Live or retired output source; both check the target like a live lookup does. */
  #outputSource(id:string,targetId:string):Session|RetiredSession {
    const live=this.#sessions.get(id);
    if(live){if(live.summary.targetId!==targetId)throw new Error('선택한 워크룸 세션을 찾을 수 없습니다.');return live;}
    const retired=this.#retired.get(id);
    if(!retired||retired.summary.targetId!==targetId)throw new Error('선택한 워크룸 세션을 찾을 수 없습니다.');
    return retired;
  }
  /** Host-only summary plus lastOutputAt, for a live session or a retired one (state `exited`). */
  sessionActivity(id:string,targetId:string) {
    const s=this.#outputSource(id,targetId);
    return {...s.summary,lastOutputAt:s.lastOutputAt};
  }
  /** Host-only raw output page after `after`, also for a retired session's kept output. */
  retainedOutputPage(id:string,targetId:string,after:number) {
    return terminalOutputPage(this.#outputSource(id,targetId).chunks,after);
  }
  /** Host-only: the driven CLI's parsed input modes (arrows and bracketed paste depend on them). */
  async inputModes(id:string,targetId:string) {
    const s=this.#session(id,targetId);
    return s.screen ? s.screen.settledModes() : {bracketedPaste:false,applicationCursorKeys:false};
  }
  /**
   * Host-only plain text of the output after `after`, rendered as the terminal shows it and
   * bounded to the last TERMINAL_TAIL_MAX_BYTES. Reads at most AI_TERMINAL_TAIL_RAW_CHARS of
   * the newest output, so a long session starts from a recent cursor instead of its beginning.
   * A retired session answers from its kept output.
   */
  async outputTail(id:string,targetId:string,after=0) {
    const s=this.#outputSource(id,targetId);
    const parts:string[]=[];let characters=0,firstIndex=-1;
    for(let i=s.chunks.length-1;i>=0;i--){
      const chunk=s.chunks[i]!;
      if(chunk.seq<=after||(parts.length&&characters+chunk.text.length>AI_TERMINAL_TAIL_RAW_CHARS))break;
      parts.push(chunk.text);characters+=chunk.text.length;firstIndex=i;
    }
    const nextCursor=Math.max(after,s.next);
    const first=firstIndex<0?null:s.chunks[firstIndex]!.seq;
    const truncatedWindow=first!==null&&first>after+1;
    let raw=parts.reverse().join('');
    // Only output from the very first chunk is known to start at a boundary a terminal can parse.
    if(first!==null&&first>1)raw=tailWindowStart(raw,s.chunks,firstIndex,truncatedWindow);
    const rendered=await renderTerminalPlainText(raw,s.summary.cols,s.summary.rows);
    const bounded=keepTailUtf8(rendered,TERMINAL_TAIL_MAX_BYTES);
    return {text:bounded.text,nextCursor,truncated:bounded.cut||truncatedWindow};
  }
  /** Host-only visible rows of the headless screen copy, or null when that copy is unavailable (or retired). */
  async screenText(id:string,targetId:string) {
    const s=this.#outputSource(id,targetId);
    const nextCursor=s.next;
    const screen='screen' in s&&s.screen?await s.screen.plainRows():null;
    return screen?{...screen,cols:s.summary.cols,nextCursor}:null;
  }
  #retire(session:Session) {
    const kept:{seq:number;text:string}[]=[];let characters=0;
    for(let i=session.chunks.length-1;i>=0;i--){
      const chunk=session.chunks[i]!;
      if(kept.length&&characters+chunk.text.length>AI_TERMINAL_TAIL_RAW_CHARS)break;
      kept.push(chunk);characters+=chunk.text.length;
    }
    this.#retired.set(session.summary.id,{summary:{...session.summary},lastOutputAt:session.lastOutputAt,chunks:kept.reverse(),next:session.next});
    while(this.#retired.size>AI_TERMINAL_MAX_RETIRED_SESSIONS)this.#retired.delete(this.#retired.keys().next().value!);
  }
  remoteAllowed(owner: string) { return this.#remote.has(owner); }
  setRemoteAccess(owner: string, enabled: boolean) {
    if (enabled === this.remoteAllowed(owner)) return;
    this.#grantEpoch.set(owner, (this.#grantEpoch.get(owner) ?? 0) + 1);
    if (enabled) this.#remote.add(owner); else this.#remote.delete(owner);
  }
  #summary(session: Session): AiTerminalSummary { return {...session.summary}; }
  #signal(session:Session,signal:NodeJS.Signals) {(this.dependencies.signalGroup??stopGroup)(session.child.pid,signal);}
  #remember(session:Session) {if(session.suppressMemoryOnExit)return;this.dependencies.rememberEnded?.({sessionId:session.summary.id,targetId:session.summary.targetId,cwd:session.cwd,agent:session.summary.agent});}
  #activity(cwd: string,agent:AiTerminalAgent) { try { this.dependencies.activity?.(cwd,agent); } catch { /* Capture must not break PTY input or exit. */ } }
  #forgetSessionRequests(session:Session) {
    // Once exited, the state fence rejects input/resize even after their retry
    // records are gone. Start IDs remain fenced for this service's lifetime.
    for (const key of session.requestKeys) this.#requests.delete(key);
    session.requestKeys.clear();
  }
  async perform(value: unknown, authority?: AiTerminalAuthority, options: {launchProfile?: AiTerminalLaunchProfile} = {}): Promise<AiTerminalResponse> {
    const request = normalizeAiTerminalRequest(value);
    if (this.#closed) throw new Error('터미널 서버가 종료 중입니다.');
    if (authority && (!(authority.deviceConsentActive ? authority.deviceConsentActive() : this.remoteAllowed(authority.owner)) || authority.isActive?.()===false)) throw new Error('Mac의 AI 터미널 화면에서 이 원격 연결의 터미널 접근을 허용하세요.');
    const visible = (s: Session) => !authority || authority.targets.has(s.summary.targetId);
    if (request.operation === 'list') return {sessions: [...this.#sessions.values()].filter(visible).map(s => this.#summary(s))};
    if (request.operation === 'start' && authority && !authority.targets.has(request.targetId!)) throw new Error('이 원격 연결에 등록된 프로젝트가 아닙니다.');
    if (options.launchProfile && (authority || request.operation !== 'start' || request.agent !== 'claude' || request.resumeFrom)) throw new Error('제한 실행은 이 Mac의 새 Claude 세션에만 쓸 수 있습니다.');
    const session = request.sessionId ? this.#sessions.get(request.sessionId) : null;
    if (request.operation !== 'start' && (!session || !visible(session))) throw new Error('터미널을 찾을 수 없거나 접근 권한이 없습니다.');
    if (request.operation === 'read') {
      if (request.snapshot && session!.screen) {
        const page = await session!.screen.snapshotPage(request.after!,session!.chunks,session!.next).catch(()=>null);
        if (page) return {session: this.#summary(session!), ...page};
      }
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
    const promise = (closing ? Promise.resolve() : this.#queues.get(queueKey) ?? Promise.resolve()).catch(()=>{}).then(()=>this.#mutate(request, session, authority, epoch, options.launchProfile));
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
  /** A remote grant was revoked, its connection left, or it was re-granted (a new epoch) since this request was admitted. */
  #authorityLost(authority: AiTerminalAuthority | undefined, epoch: number | undefined): boolean {
    return !!authority && (!(authority.deviceConsentActive ? authority.deviceConsentActive() : this.remoteAllowed(authority.owner)) || authority.isActive?.()===false || this.#grantEpoch.get(authority.owner) !== epoch);
  }
  async #mutate(r: AiTerminalRequest, session: Session | null | undefined, authority?: AiTerminalAuthority, epoch?: number, launchProfile?: AiTerminalLaunchProfile): Promise<AiTerminalResponse> {
    if (this.#authorityLost(authority, epoch)) throw new Error('원격 터미널 권한이 해제되었습니다.');
    if(this.#closed)throw new Error('터미널 서버가 종료 중입니다.');
    if (r.operation === 'close') {
      if(r.memoryPolicy==='saved'){
        await this.#queues.get(session!.summary.id)?.catch(()=>{});
        if(!this.dependencies.verifySavedBeforeClose)throw new Error('종료 전 저장 확인을 지원하지 않는 호스트입니다.');
        await this.dependencies.verifySavedBeforeClose({...session!.summary,cwd:session!.cwd,inputRevision:session!.inputRevision},r.saveRequestId!,authority?.owner??'local');
        if(authority&&(!(authority.deviceConsentActive?authority.deviceConsentActive():this.remoteAllowed(authority.owner))||authority.isActive?.()===false))throw new Error('원격 권한이 변경되었습니다.');
      }
      if(r.memoryPolicy)session!.suppressMemoryOnExit=true;
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
    if (this.#authorityLost(authority, epoch)) throw new Error('원격 터미널 권한이 해제되었습니다.');
    if (this.#closed) throw new Error('터미널 서버가 종료 중입니다.');
    if (session && (session.closing || session.summary.state !== 'running')) throw new Error('터미널이 종료 중이거나 종료되었습니다.');
    const cwd = realpathSync(target.cwd);
    if (!isAbsolute(cwd) || !statSync(cwd).isDirectory() || (session && cwd !== session.cwd)) throw new Error('프로젝트 경로가 변경되었습니다. 새 터미널을 여세요.');
    if (r.operation === 'start') {
      if(aiTerminalWindowsStartBlocked({platform:process.platform,injectedSpawn:!!this.dependencies.spawn,ptyAvailable:windowsPtyAvailable()}))throw new Error(AI_TERMINAL_WINDOWS_UNSUPPORTED);
      // 「다시 시작」 (VOC 2026-10-02): the earlier session of this project and AI that this start replaces.
      const previous = r.resumeFrom ? this.#sessions.get(r.resumeFrom) : undefined;
      if (r.resumeFrom) {
        if (authority) throw new Error('다시 시작은 Mac의 워크룸에서만 할 수 있습니다.');
        if (!previous || previous.summary.targetId !== targetId || previous.summary.agent !== r.agent) throw new Error('다시 시작할 세션을 찾지 못했습니다. 터미널 새로고침 후 다시 시도하세요.');
        if (previous.cwd !== cwd) throw new Error('프로젝트 경로가 변경되었습니다. 새 터미널을 여세요.');
        if (previous.closing) throw new Error('세션을 종료하는 중입니다. 잠시 후 다시 시도하세요.');
      }
      // `#` references of an @ route that opens a new session travel with its first request.
      const prompt = r.prompt !== undefined && r.references ? await this.#withReferences(r.prompt,r.references,authority,cwd) : r.prompt;
      // The protocol checked the request before the folders were added; the CLI receives this one.
      if (prompt !== r.prompt && aiInitialPromptError(prompt)) throw new Error(AI_TERMINAL_PROMPT_REFERENCES_TOO_LARGE_ERROR);
      if (this.#authorityLost(authority, epoch)) throw new Error('원격 터미널 권한이 해제되었습니다.');
      if (this.#closed) throw new Error('터미널 서버가 종료 중입니다.');
      if ([...this.#sessions.values()].filter(s => s.summary.state === 'running' && s !== previous).length >= 12) throw new Error('실행 중인 터미널은 최대 12개입니다.');
      const executable = this.dependencies.executable(r.agent!);
      if (!executable || !isAbsolute(executable)) throw new Error(`${r.agent} CLI가 설치되어 있지 않습니다.`);
      const env:Record<string,string|undefined> = {...(this.dependencies.env ?? process.env), TERM:'xterm-256color', COLORTERM:'truecolor'};
      // An app opened from the Dock has no locale (measured: a Workroom Codex had only PATH and TERM), so the
      // shell commands an AI runs fell back to C and mishandled Korean text. A user's own locale is kept.
      if (!env.LANG && !env.LC_ALL && !env.LC_CTYPE) env.LANG = 'en_US.UTF-8';
      // A Workroom is a local terminal even when the app itself was relaunched over SSH (`open` passes the
      // caller's environment). Inherited SSH_* made Antigravity treat it as remote and skip the keychain —
      // 「not signed in」 in the Workroom, signed in everywhere else (3호, 2026-10-08).
      delete env.SSH_CONNECTION; delete env.SSH_CLIENT; delete env.SSH_TTY;
      // Keep the CLI's ordinary user environment; never inherit this app's private control capabilities.
      for (const name of Object.keys(env)) if (/^(PORTMGR_|AGENTSTOZ_).*CAPABILITY|^(AGENTSTOZ_VOICE_API_KEY|SUPABASE_SERVICE_ROLE_KEY|VITE_SUPABASE_SERVICE_ROLE_KEY)$/.test(name)) delete (env as Record<string, unknown>)[name];
      // A Workroom opened from another Mac has no approval bypass, so Codex stopped at its hook-trust menu in
      // every project carrying the AgentsToZ activity hook (3호, 2026-10-07). Skip that menu only when that
      // hook is all Codex would run (codexHookTrust.ts); any other hook keeps Codex's own question.
      const codexHookTrust = r.agent === 'codex' && !(previous ? previous.launchProfile : launchProfile)
        && codexHooksAreAgentsToZOnly(cwd, env.CODEX_HOME || join(env.HOME || homedir(), '.codex'))
        && await (this.dependencies.codexHookTrustSupported ?? codexSupportsHookTrustFlag)(executable, env);
      if (this.#closed) throw new Error('터미널 서버가 종료 중입니다.');
      let resume: AiTerminalResume | null = null;
      if (previous) {
        const source: AiTerminalResumeSource = {agent:previous.summary.agent,cwd:previous.cwd,createdAt:previous.summary.createdAt,
          ...(previous.exitedAt?{exitedAt:previous.exitedAt}:{}),...(previous.conversationId?{conversationId:previous.conversationId}:{}),
          ...(previous.summary.state==='running'?{processGroup:previous.child.pid}:{})};
        const resolveResume = this.dependencies.resume ?? (value => resolveAiTerminalResume(value, {home:env.HOME||homedir(),codexHome:env.CODEX_HOME||undefined,claudeConfigDir:env.CLAUDE_CONFIG_DIR||undefined,openFiles:processGroupOpenFiles}));
        // Read while the CLI still runs: Codex names its thread only through a lock the process holds.
        try { resume = await resolveResume(source); } catch { resume = null; }
        // A continued conversation has not ended, so it is not queued for a memory save; one that cannot be
        // continued ends like an ordinary close. The CLI must be gone before another opens its conversation.
        if (previous.summary.state === 'running') await this.perform({operation:'close',requestId:`restart-${randomUUID()}`,sessionId:previous.summary.id,...(resume?{memoryPolicy:'skip' as const}:{})});
        if (this.#closed) throw new Error('터미널 서버가 종료 중입니다.');
      }
      const bypass = previous ? previous.bypass : !!r.bypassPermissions;
      // A restart keeps the restriction of the session it replaces; it never gains or loses it.
      const profile = previous ? previous.launchProfile : launchProfile;
      // A restricted (duty) session talks to outsiders: its transcript is not the user's work, so it never
      // feeds session memory or 「내가 한 말」 capture.
      const summary: AiTerminalSummary = {id:randomUUID(),targetId,agent:r.agent!,state:'running',createdAt:new Date().toISOString(),exitCode:null,cols:r.cols!,rows:r.rows!};
      // Lets an AI in this Workroom tell agentstoz_use which session is its own (a hint, see workroomCaller.ts).
      Object.assign(env,{[WORKROOM_SESSION_ENV]:summary.id,[WORKROOM_TARGET_ENV]:targetId});
      const record = {summary,cwd,inputRevision:0,chunks:[],next:0,buffered:0,decoder:new TextDecoder(),requestKeys:new Set<string>(),revalidate:target.revalidate,lastOutputAt:null,
        bypass,launchProfile:profile,conversationId:resume?.conversationId ?? (r.agent==='claude'?summary.id:undefined)} as unknown as Session;
      // The headless copy also answers «what terminal are you» (DA) and cursor-position (CPR) queries — agy waits for DA,
      // Codex stops reading keys until CPR is answered (aiTerminalScreen.ts).
      try {record.screen=this.dependencies.headlessScreen===false?undefined:new AiTerminalScreen(r.cols!,r.rows!,undefined,data=>{try{if(record.summary.state!=='running')return;if(record.ptyInViewerPaste){const held=record.heldReplies??=[];held.push(data);if(held.length>8)held.shift();return;}record.child?.terminal?.write(data);}catch{}});} catch {record.screen=undefined;}
      const append = (text: string) => {
        if (text) record.lastOutputAt=Date.now();
        for (let start=0;start<text.length;) {
          let end=Math.min(text.length,start+1024);
          if(end<text.length && /[\uD800-\uDBFF]/.test(text[end-1]!)) end--;
          const part=text.slice(start,end); record.chunks.push({seq:++record.next,text:part});record.buffered+=part.length;start=end;
        }
        record.screen?.write(text,record.next);
        while (record.buffered > (this.dependencies.maxBufferChars ?? 1_000_000) && record.chunks.length > 1) record.buffered-=record.chunks.shift()!.text.length;
      };
      // Bun.spawn has no Windows PTY ("terminal option is not supported on this
      // platform"), so win32 goes through node-pty instead; both satisfy the
      // same `Child` shape, and an injected spawn still wins for tests.
      const spawn = this.dependencies.spawn
        ?? (process.platform === 'win32'
          ? ((args,options) => spawnWindowsPty(args as string[],options as any) as any)
          : ((args,options) => (Bun.spawn as any)(args,options)));
      const args = [executable, ...aiTerminalLaunchArgs(r.agent!, summary.id, prompt, bypass, resume, profile, codexHookTrust)];
      let eof!:()=>void;const streamEnded=new Promise<void>(resolve=>{eof=resolve});
      record.child = spawn(args,{cwd,env,detached:true,terminal:{cols:r.cols,rows:r.rows,exit:()=>eof(),data:(_pty:Pty,data:Uint8Array)=>append(record.decoder.decode(data,{stream:true}))}});
      this.#sessions.set(summary.id,record);
      const pid=record.child.pid;this.#sessionByPid.set(pid,summary.id);
      const unmapPid=()=>{if(this.#sessionByPid.get(pid)===summary.id)this.#sessionByPid.delete(pid);};
      if(profile)record.suppressMemoryOnExit=true;else this.#activity(cwd,r.agent!);
      record.finished=record.child.exited.then(async code => {
        // Process exit and PTY EOF are distinct. Drain its final screen before publishing exited.
        let timer:ReturnType<typeof setTimeout>|undefined;
        await Promise.race([streamEnded,new Promise(resolve=>{timer=setTimeout(resolve,1000)})]);clearTimeout(timer);
        append(record.decoder.decode());record.exitedAt=new Date().toISOString();summary.state='exited';summary.exitCode=code;unmapPid();record.child.terminal.close();this.#forgetSessionRequests(record);
        if(!record.suppressMemoryOnExit)this.#activity(cwd,record.summary.agent);
        try {this.#remember(record);} catch { /* Explicit close can retry durable enqueue. */ }
      },()=>{record.exitedAt=new Date().toISOString();summary.state='exited';summary.exitCode=-1;unmapPid();record.child.terminal.close();this.#forgetSessionRequests(record);});
      // Pruned sessions stay readable as retired (exited, last output) for a late read or wait.
      for (const [id,old] of this.#sessions) if (this.#sessions.size>24 && old.summary.state==='exited') {old.screen?.dispose();this.#sessions.delete(id);this.#retire(old);}
      return {session:this.#summary(record),...(previous?{resumed:!!resume}:{})};
    }
    {
      if (session!.summary.state !== 'running') throw new Error('종료된 터미널입니다. 새 세션을 여세요.');
      if (r.operation === 'input' && r.expectedInputRevision !== undefined && r.expectedInputRevision !== session!.inputRevision) throw new Error('워크룸 입력이 변경되었습니다. 음성 초안을 다시 확인하세요.');
      if (r.operation === 'input') {
        // The host screen answers DA and cursor-position queries itself; a viewer's forwarded answer is a duplicate.
        // The stream state is filtered on a copy and kept only once these bytes are written (or there is nothing to write):
        // a request refused below must not leave the filter believing a paste opened or closed.
        const filterState:ViewerReplyFilterState={...(session!.viewerPaste??{pasteOpen:false})};
        const typed=session!.screen?stripViewerTerminalReplies(r.data!,filterState,{ambiguousIsReply:session!.summary.agent==='codex'||session!.screen.answeredPlainCursorRecently()}):r.data!;
        if(!typed){if(session!.screen)session!.viewerPaste=filterState;return {session:this.#summary(session!)};}
        const data=r.references?await this.#withReferences(typed,r.references,authority,cwd):typed;
        // Decided here, not by each caller, so the Workroom UI, voice and agentstoz_use paths paste alike.
        const bracketedPaste=aiTerminalPasteCandidate(data)&&!!session!.screen&&(await session!.screen.settledModes()).bracketedPaste;
        // Both waits above can outlast a revoked grant or a closed connection; check again right before the write.
        if (this.#authorityLost(authority, epoch)) throw new Error('원격 터미널 권한이 해제되었습니다.');
        if (this.#closed) throw new Error('터미널 서버가 종료 중입니다.');
        if (session!.closing || session!.summary.state !== 'running') throw new Error('터미널이 종료 중이거나 종료되었습니다.');
        session!.suppressMemoryOnExit=!!session!.launchProfile;session!.inputRevision++;
        if(session!.screen)session!.viewerPaste=filterState;
        // After the body is written the CLI is (or is no longer) inside a viewer's paste; answers held meanwhile follow it.
        const written=()=>{const s=session!;s.ptyInViewerPaste=!!s.viewerPaste?.pasteOpen;if(s.ptyInViewerPaste||!s.heldReplies?.length)return;const held=s.heldReplies;s.heldReplies=[];for(const reply of held)s.child.terminal.write(reply);};
        await writeAiTerminalInput(session!.summary.agent,session!.child.terminal,data,{bracketedPaste},written);
        if(!session!.launchProfile)this.#activity(cwd,session!.summary.agent);
      }
      else {session!.child.terminal.resize(r.cols!,r.rows!);session!.screen?.resize(r.cols!,r.rows!);session!.summary.cols=r.cols!;session!.summary.rows=r.rows!;}
    }
    return {session:this.#summary(session!)};
  }
  /** `#` references: the client names opaque ids, the host resolves and verifies each folder
   * with the same registration and authority checks as a start. One line, before Enter,
   * so no embedded newline can submit the prompt early. */
  async #withReferences(data:string,references:readonly string[],authority:{targets?:ReadonlySet<string>}|undefined,cwd:string):Promise<string> {
    const entries:string[]=[];
    for(const id of references){
      if(authority?.targets&&!authority.targets.has(id))throw new Error('참고할 프로젝트에 대한 권한이 없습니다.');
      let folder:string;
      try{folder=realpathSync((await this.dependencies.resolveTarget(id)).cwd);if(!isAbsolute(folder)||!statSync(folder).isDirectory())throw new Error('not a folder');}
      catch{throw new Error('참고할 프로젝트를 찾지 못했습니다. 프로젝트 목록을 새로고침하세요.');}
      if(folder!==cwd)entries.push(`${basename(folder)}=${folder}`);
    }
    if(!entries.length)return data;
    const enter=data.length>1&&data.endsWith('\r');const body=enter?data.slice(0,-1):data;
    return `${body} (참고 프로젝트 · 읽어서 참고만 하고 수정은 현재 프로젝트에서: ${entries.join('; ')})${enter?'\r':''}`;
  }
  async shutdown() {
    this.#closed=true;this.#remote.clear();
    for(const s of this.#sessions.values()) {try {this.#remember(s);} catch { /* Never prevent process cleanup. */ }}
    for (const s of this.#sessions.values()) if(s.summary.state==='running') this.#signal(s,'SIGTERM');
    await new Promise(resolve=>setTimeout(resolve,200));
    for (const s of this.#sessions.values()) if(s.summary.state==='running') {this.#signal(s,'SIGKILL');s.child.terminal.close();}
    for (const s of this.#sessions.values()) s.screen?.dispose();
  }
}
