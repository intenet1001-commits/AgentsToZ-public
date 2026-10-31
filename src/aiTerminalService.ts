import {effortComposerEmpty} from './workroomEffortRuntime';
import type {ScheduleSnapshot} from './workroomScheduleHost';
import type {WorkroomSchedule,WorkroomScheduleRun} from './workroomScheduleProtocol';
import {claudeInputChangesConversation,normalizeContextCommandRequest,type ContextCommandBinding} from './contextSessionCommand';
import {parseUseReferenceId} from './projectUseMention';
import {cliInfoFromScreen} from './workroomCliCommands';
import {changeWorkroomEffort,WorkroomEffortNotReadyError,WORKROOM_EFFORT_READY_WAIT_MS} from './workroomEffortRuntime';
import {workroomEffortRuntimeSupport} from './workroomEffortRuntimeSupport';
import {classifyWorkroomEffort,workroomEffortRequestText} from './workroomEffortPolicy';
import type {DesktopEffortMode,WorkroomEffortMode} from './workroomEffortMode';
import { createHash, randomUUID } from 'node:crypto';
import { accessSync, constants, realpathSync, statSync, lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, dirname } from 'node:path';
import { terminalOutputPage } from './aiTerminalOutput';
import { AiTerminalScreen } from './aiTerminalScreen';
import { stripViewerTerminalReplies, type ViewerReplyFilterState } from './aiTerminalReplyFilter';
import { dropPartialTerminalPrefix, incompleteEscapeSuffix, keepTailUtf8, renderTerminalPlainText, TERMINAL_TAIL_MAX_BYTES } from './terminalPlainText';
import { WORKROOM_SESSION_ENV, WORKROOM_TARGET_ENV } from './workroomCaller';
import { aiTerminalLaunchArgs, launchModelError, type AiTerminalLaunchModel, type AiTerminalLaunchProfile } from './aiTerminalLaunchArgs';
import { codexHooksAreAgentsToZOnly, codexSupportsHookTrustFlag } from './codexHookTrust';
import { processGroupOpenFiles, resolveAiTerminalResume, type AiTerminalResume, type AiTerminalResumeSource } from './aiTerminalResume';
import { aiTerminalSubmitSteps } from './aiTerminalSubmit';
import { AI_TERMINAL_PROMPT_REFERENCES_TOO_LARGE_ERROR, normalizeAiTerminalRequest, type AiTerminalAgent, type AiTerminalRequest, type AiTerminalResponse, type AiTerminalSummary } from './aiTerminalProtocol';
import { aiInitialPromptError } from './aiInitialPrompt';
import { WINDOWS_PTY_RUNTIME_MISSING, spawnWindowsPty, windowsPtyAvailable, windowsSignalTree } from './windowsPty';
import {HOST_CLI_ACCOUNT_ID, cliAccountAgent} from './cliAccountProtocol';
import type {CliAccountManager, CliAccountLaunch} from './cliAccountManager';
import {workroomSessionContext} from './workroomConversationIdentity';
import {WorkroomSubmissions} from './workroomSubmissions';
import {splitWorkroomAttachmentBlock,withSuffixBeforeWorkroomAttachments,workroomAttachmentMessage} from './workroomImageAttachments';
import {WORKROOM_LAUNCH_SCOPE,WORKROOM_LAUNCH_SUBMISSION_FEATURE,WORKROOM_SUBMISSION_FEATURE,WORKROOM_SUBMISSION_RECENT_FEATURE,submissionDigest,submissionManifestHash} from './workroomSubmissionProtocol';
import type {CorrectionTaskExposure,CorrectionTaskGuidance} from './projectMemoryCorrectionContext';
import {WORKROOM_ACTIVITY_SAMPLE_MS,WorkroomActivityBoard,normalizeWorkroomActivityRequest,workroomInputIsRequest,workroomSampleInputs,workroomSampleWantsRows,type WorkroomActivityCursor,type WorkroomActivityPage,type WorkroomExitCause,type WorkroomSampleMemory} from './aiTerminalActivity';
import {WORKROOM_TRANSCRIPT_TICK_BYTES,verifyWorkroomTranscriptWitness,type WorkroomTranscriptWitness,type WorkroomTurnSignals} from './aiTerminalActivityTranscript';
import {savedWorkroomConversation} from './workroomConversationIdentity';
import {codexEffortModel as readCodexEffortModel,type CodexEffortModel} from './codexEffortModel';
import {normalizeWorkroomEffortRequest,type WorkroomEffortSettingStore} from './workroomEffortSetting';
import {hermesVariantOf,type HermesVariant} from './hermesVariants';
import {noteWorkroomEffortRequest,observeWorkroomEffortScreen,planWorkroomEffort,workroomEffortInputIsManual,workroomEffortRecord,type WorkroomEffortRecord,type WorkroomEffortState,type WorkroomLaunchEffort} from './workroomEffortSession';
import {workroomEffortView,type WorkroomEffortView} from './workroomEffortView';
import {WORKROOM_CONTEXT_SAVE_REFUSALS,type WorkroomSavedPurpose} from './workroomSavedReceipt';
import {reconcileAgyCliUnfinishedWork} from './agentstozInvocationInstaller';

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
  /** Host-only task binding, never a wire field. Checked immediately before spawn/input. */
  validateTarget?:(targetId:string,cwd:string)=>void;
  /** Separate host-resolved permission for explicit account selection. */
  accountSelectionAllowed?:()=>boolean;
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
/**
 * Phone attachments (w13): ids the Mac admitted for one receipt owner and project (src/workroomRemoteAttachments.server.ts).
 * `check` at a submission's begin, `lease` right before its write; both throw the words the composer shows.
 */
export interface AiTerminalRemoteAttachments {
  check(ids:readonly string[],scope:{owner:string;targetId:string}):void;
  lease(ids:readonly string[],scope:{owner:string;targetId:string}):{images:string[];files:string[];recheck():void;consume():void;release():void};
}
/** A phone's own text may not carry a block naming this Mac's files; only the host builds that block. */
const REMOTE_TEXT_BLOCK_REFUSAL='다른 기기에서 보낸 요청에는 이 기기의 이미지·파일을 첨부할 수 없습니다. 작성 내용은 유지했습니다.';
export interface AiTerminalDependencies {
  submissions?:()=>import('./workroomConversationJournal').WorkroomConversationJournal;
  /** Phone attachment ids → this Mac's saved files; absent on a host that does not advertise workroom-attach-v1. */
  remoteAttachments?:AiTerminalRemoteAttachments;
  corrections?:(cwd:string,targetId:string,text:string)=>Promise<CorrectionTaskGuidance|null>;
  /** Checks the image paths a whole-request submission names (src/workroomImages.ts); throws to refuse before writing. */
  /** Images (this app's own copies) and other files or folders (referenced in place), checked right before the write. */
  submissionAttachments?:(paths:readonly string[],files?:readonly string[])=>void;
  /** Optional host-local history. No history operations are added to terminal-v1. */
  threadInput?:(sessionId:string,text:string,revision:number)=>Promise<(()=>Promise<void>)|undefined>;
  threadQuestion?:(sessionId:string,rows:readonly string[],revision:number)=>Promise<void>;
  threadCompleted?:(sessionId:string,completion:{key:string;resultText:string},revision:number,active:()=>boolean)=>Promise<void>;
  threadEnded?:(sessionId:string)=>Promise<void>;
  history?: import('./workroomConversationHost').WorkroomHistoryObserver;
  accounts?: CliAccountManager;
  /** The project's own gh·supabase·vercel·gws account routing for a Workroom (platformCliWorkroom.ts); never a token. */
  cliAccountEnvironment?: (input:{targetId:string;cwd:string;env:Record<string,string|undefined>})=>Promise<Record<string,string>>;
  resolveTarget(id: string): Promise<AiTerminalResolvedTarget>;
  resolveUseReference?(projectId: string, serviceKey: string): Promise<{cwd: string; label: string}>;
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
  verifyContextSync?:(cwd:string)=>Promise<void>;
  /** `close` checks the whole project since the save; `context` (the dock's /compact·/clear) only this conversation, and
   *  returns when that save started (src/workroomSavedReceipt.ts). */
  verifySavedBeforeClose?: (session:{id:string;targetId:string;cwd:string;inputRevision:number},requestId:string,owner:string,purpose?:WorkroomSavedPurpose)=>Promise<void|{startedAt:number|null}>;
  activity?: (cwd: string, agent: AiTerminalAgent) => void;
  /** Which conversation a 「다시 시작」 continues (src/aiTerminalResume.ts); null starts a fresh one. */
  resume?: (source: AiTerminalResumeSource) => Promise<AiTerminalResume | null>;
  /** Activity clock (tests); the sampler, output times and transitions all read it. */
  activityClock?: () => number;
  /** false: no 1 s activity timer (tests drive `sampleActivity()` themselves). */
  activitySampler?: boolean;
  /** Exact turn ends from CLI transcripts (src/aiTerminalActivityTranscript.ts). Omitted: screen tier only. */
  turnSignals?: WorkroomTurnSignals;
  /**
   * The Mac's 「에포트 자동」 setting (src/workroomEffortSetting.ts, default ON). Omitted: auto never runs and the
   * launch arguments stay exactly as before (tests and older callers).
   */
  effortAuto?: WorkroomEffortSettingStore;
  /** Tests may provide a native-control adapter; it must not run inference. */
  effortRuntime?: typeof changeWorkroomEffort;
  effortRuntimeSupport?: typeof workroomEffortRuntimeSupport;
  /** Tests: the Codex model proof (default: src/codexEffortModel.ts reading the config files, read-only). */
  codexEffortModel?: (input:{env:Record<string,string|undefined>;cwd:string;args:readonly string[];launchModel?:string})=>CodexEffortModel;
}
interface Session {
  historyEnv?: Record<string,string|undefined>;
  summary: AiTerminalSummary; cwd: string; child: Child; chunks: {seq: number; text: string}[];
  next: number; buffered: number; decoder: TextDecoder; finished: Promise<void>;
  /** Epoch ms of the last PTY output; host-only (the wire summary never carries it). */
  lastOutputAt: number | null;
  requestKeys: Set<string>;
  inputRevision:number; suppressMemoryOnExit?:boolean;
  completedInputRevision?:number;
  completedTranscriptWitness?:WorkroomTranscriptWitness;
  completedObservedModel?:string;
  pendingThreadCompletion?:{key:string;resultText:string;revision:number;retryAt:number};
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
  /** Host-only model chosen at launch (team members); a restart keeps it. */
  launchModel?: AiTerminalLaunchModel;
  /** Host-only: the CLI conversation it runs when known (Claude's `--session-id`, or what it resumed). */
  conversationId?: string;
  exitedAt?: string;
  /** A restart remains bound to the original account even if the project default changed. */
  accountLaunch?: CliAccountLaunch;
  /** Host-only: why the CLI is ending when a viewer or the app caused it (never announced). */
  exitCause?: WorkroomExitCause;
  /** The cause a close in progress applies once it signals the CLI (a restart), instead of «close». */
  closeCause?: WorkroomExitCause;
  /** Host-only activity sampling (src/aiTerminalActivity.ts `workroomSampleInputs`): output already sampled, the rows' key, a question. */
  activitySample?: WorkroomSampleMemory;
  /** Started with a first request: the CLI is saving a conversation from its first second (history liveness tick). */
  firstRequest?: boolean;
  /** Host-only 「에포트 자동」 state (src/workroomEffortSession.ts); never on the wire summary. */
  effort?: WorkroomEffortState;
}
/** An exited session pruned from the live list; a late read or wait still answers `exited` with its last output. */
interface RetiredSession {
  summary: AiTerminalSummary; lastOutputAt: number | null;
  /** The newest AI_TERMINAL_TAIL_RAW_CHARS of its output, with the original sequence numbers. */
  chunks: {seq: number; text: string}[]; next: number;
}
type AiTerminalStartGuard=(context:import('./workroomConversationHost').WorkroomSessionContext)=>void|(()=>void)|Promise<void|(()=>void)>;
/** The schedule owner serializes this synchronous native effect with pause/stop. */
export type AiTerminalEffectGate=<T>(effect:()=>T)=>T;
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
export async function writeAiTerminalInput(agent: AiTerminalAgent, terminal: Pick<Pty, 'write'>, data: string, screen: {bracketedPaste?: boolean} = {}, written?: () => void, requireComplete=false,allowed?:()=>boolean,effectGate?:AiTerminalEffectGate): Promise<void> {
  for (const step of aiTerminalSubmitSteps(agent, data, screen)) {
    if ('waitMs' in step) {
      // Bun hands a PTY write to the CLI only on a later event-loop turn. If the loop stalled before that turn, the
      // body and the Enter written after the wait reached the CLI in one read, and Codex took that Enter as part of a
      // paste (real Codex 0.160: 0/6 submitted with a 200 ms stall right after the body). One timer turn flushes the
      // body first, so the measured wait is counted from delivery, not from the write call.
      await new Promise(resolve => setTimeout(resolve, 0));
      await new Promise(resolve => setTimeout(resolve, step.waitMs));
    } else {if(allowed&&!allowed())throw Error('입력 도중 권한 또는 연결이 변경되었습니다. 자동으로 다시 보내지 않습니다.');const count=effectGate?effectGate(()=>terminal.write(step.write)):terminal.write(step.write);if(requireComplete&&count!==Buffer.byteLength(step.write))throw Error('터미널 쓰기가 일부만 완료됐을 수 있습니다. 자동으로 다시 보내지 않습니다.');written?.(); }
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
  /** Restored PTYs remain bound to the original schedule only for this host process lifetime. */
  #scheduleRestorations=new Map<string,{scheduleId:string;binding:WorkroomSchedule['binding'];providerConversationId:string;inputRevision:number;configFingerprint:string;accountFingerprint:string;targetFingerprint:string;model:{model:string;provider?:string}}>();
  #retired = new Map<string, RetiredSession>();
  /** 「다시 시작」 lineage, host-only: a session id → the session its `resumeFrom` start opened. Bounded like #retired. */
  #continuedBy = new Map<string, string>();
  /** Running CLI pid (each leads its own process group) → session id. Host-only caller hint, never authority. */
  #sessionByPid = new Map<number, string>();
  #requests = new Map<string, {fingerprint: string; promise: Promise<AiTerminalResponse>}>();
  #remote = new Set<string>();
  #grantEpoch = new Map<string, number>();
  #closed = false;
  #queues = new Map<string,Promise<unknown>>();
  #pendingMutations = 0;
  #submissions:WorkroomSubmissions|undefined;
  readonly #now:()=>number;
  readonly #board:WorkroomActivityBoard;
  #sampler:ReturnType<typeof setInterval>|undefined;
  #sampling:Promise<void>|null=null;
  constructor(private readonly dependencies: AiTerminalDependencies) {
    if(dependencies.submissions)this.#submissions=new WorkroomSubmissions(dependencies.submissions);
    this.#now=dependencies.activityClock??Date.now;
    this.#board=new WorkroomActivityBoard(this.#now);
  }
  wholeSubmissionSupported(){return !!this.#submissions;}
  /** Host-only reviewed voice path, using the same durable metadata and current grants as the composer. */
  async submitReviewed(requestId:string,sessionId:string,data:string,revision:number,authority:AiTerminalAuthority,references:readonly string[]=[]){
    const id='reviewed_'+createHash('sha256').update(requestId).digest('hex').slice(0,40);
    const outcome=await this.#submitWhole({id,sessionId,data,references,revision,authority,changed:'확인한 음성 지시 내용이 변경되었습니다. 새 초안을 다시 확인하세요.'});
    if(outcome.state==='written')return;
    if(outcome.replayed)throw Error('이 지시의 전송 결과가 미확정입니다. 워크룸 결과를 확인하기 전에는 다시 보내지 않습니다.');
    throw Error('이 지시의 전송 결과가 미확정입니다. 자동으로 다시 보내지 않습니다.');
  }
  /**
   * Host-only whole-request submission of an instruction this Mac composed itself (agentstoz_use), under its own
   * receipt namespace. Returns the final receipt state; never retries and never falls back to raw input. Once a write
   * has started its outcome comes back as a receipt (`unknown` when it failed part-way), so a thrown error means
   * nothing was written — including the same id reused for different text. `skipCorrections` types the text exactly
   * as given (no reported-correction context appended, no correction lookup that could refuse it), as the raw input
   * path did: an instruction another AI composed may be a slash command whose arguments the suffix would change.
   */
  async submitHostInstruction(input:{id:string;sessionId:string;data:string;receiptOwner:string;references?:readonly string[];skipCorrections?:boolean;revision?:number;active?:()=>boolean;validateTarget?:(targetId:string,cwd:string)=>void;beforeInput?:()=>Promise<void>;writeEffectGate?:AiTerminalEffectGate}):Promise<{state:import('./workroomSubmissionProtocol').WorkroomSubmissionReceipt['state'];session?:AiTerminalSummary}>{
    const {state,session}=await this.#submitWhole({id:input.id,sessionId:input.sessionId,data:input.data,references:input.references??[],revision:input.revision,...(input.active?{authority:{owner:input.receiptOwner,targets:new Set([this.runningSession(input.sessionId)?.targetId??'']),isActive:input.active,deviceConsentActive:input.active,validateTarget:input.validateTarget}}:{}),receiptOwner:input.receiptOwner,skipCorrections:input.skipCorrections===true,changed:'같은 요청 ID에 다른 입력을 보낼 수 없습니다.',beforeInput:input.beforeInput,writeEffectGate:input.writeEffectGate});
    return {state,...(session?{session}:{})};
  }
  async #submitWhole(input:{id:string;sessionId:string;data:string;references:readonly string[];revision?:number;authority?:AiTerminalAuthority;receiptOwner?:string;skipCorrections?:boolean;changed:string;beforeInput?:()=>Promise<void>;writeEffectGate?:AiTerminalEffectGate}):Promise<{state:import('./workroomSubmissionProtocol').WorkroomSubmissionReceipt['state'];replayed:boolean;session?:AiTerminalSummary}>{
    if(!this.#submissions)throw Error('전체 요청 제출을 지원하지 않습니다.');
    const {id,sessionId,references,authority}=input;
    const owner=authority?.owner??input.receiptOwner!;
    const run=(request:Record<string,unknown>)=>this.perform(request,authority,{...(!authority?{receiptOwner:input.receiptOwner,...(input.skipCorrections?{skipCorrections:true}:{})}:{}),...(input.beforeInput?{beforeInput:input.beforeInput}:{}),...(input.writeEffectGate?{writeEffectGate:input.writeEffectGate}:{})});
    const bytes=Buffer.from(input.data,'utf8');
    const previous=this.#submissions.find(id,{owner,sessionId});
    if(previous&&previous.record.intentHash!==submissionManifestHash(bytes.length,submissionDigest(bytes),references))throw Error(input.changed);
    // Refused before the write fence: the same id answers that refusal again, it is never written later.
    if(previous?.receipt.state==='rejected')throw Error('이 요청은 앞서 터미널에 쓰기 전에 거절되었습니다. 같은 요청 ID로는 다시 쓰지 않습니다.');
    if(previous&&['written','unknown','write_started'].includes(previous.receipt.state)){
      const response=await run({operation:'submission',requestId:id+'_status',sessionId,submission:{phase:'status',id}});
      return {state:response.submission?.state??'unknown',replayed:true};
    }
    const begin=await run({operation:'submission',requestId:id+'_begin',sessionId,...(input.revision!==undefined?{expectedInputRevision:input.revision}:{}),...(references.length?{references:[...references]}:{}),submission:{phase:'begin',id,bytes:bytes.length,digest:submissionDigest(bytes),chunks:Math.ceil(bytes.length/4000)}});
    const epoch=begin.submission!.epoch;
    for(let index=0;index<Math.ceil(bytes.length/4000);index++)await run({operation:'submission',requestId:id+'_part_'+index,sessionId,submission:{phase:'chunk',id,epoch,index,data:bytes.subarray(index*4000,(index+1)*4000).toString('base64')}});
    const result=await run({operation:'submission',requestId:id+'_commit',sessionId,submission:{phase:'commit',id,epoch}});
    return {state:result.submission?.state??'unknown',replayed:false,...(result.session?{session:result.session}:{})};
  }
  /** Host-only metadata projection used by local durable history. */
  historySessions(): import('./workroomConversationHost').WorkroomSessionContext[] {
    return [...this.#sessions.values()].flatMap(session => {
      try { return [this.#historyContext(session)]; } catch { return []; }
    });
  }
  #historyContext(session: Session): import('./workroomConversationHost').WorkroomSessionContext {
    const context = workroomSessionContext(this.#summary(session),session.cwd,
      session.historyEnv ?? session.accountLaunch?.env ?? this.dependencies.env ?? process.env,
      !!session.launchProfile,session.conversationId);
    return {...context,...(session.summary.state==='running'?{processGroup:session.child.pid}:{}),...(session.exitedAt?{exitedAt:session.exitedAt}:{}),
      bypass:session.bypass,submitted:session.inputRevision>0||!!session.firstRequest};
  }
  async prepareHistoryContext(record: import('./workroomConversationProtocol').WorkroomConversation) {
    if (this.#closed || !cliAccountAgent(record.agent)) throw new Error('이 대화의 CLI 재개를 지원하지 않습니다.');
    const target = await this.dependencies.resolveTarget(record.targetId);
    const base = this.dependencies.env ?? process.env;
    if (record.accountId !== HOST_CLI_ACCOUNT_ID && !this.dependencies.accounts) throw new Error('원래 CLI 계정 관리가 필요합니다.');
    const account = this.dependencies.accounts ? await this.dependencies.accounts.launch(record.targetId,record.agent,record.accountId,base) : undefined;
    const fresh = target.revalidate ? await target.revalidate() : await this.dependencies.resolveTarget(record.targetId);
    if (realpathSync(fresh.cwd)!==realpathSync(target.cwd)) throw new Error('원래 프로젝트가 변경되었습니다.');
    return workroomSessionContext({id:record.sessionId,targetId:record.targetId,agent:record.agent,state:'exited',
      createdAt:record.createdAt,exitCode:null,cols:100,rows:30,accountId:record.accountId,accountLabel:account?.label??record.accountLabel},
      fresh.cwd,account?.env??base,false);
  }
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
    return {...s.summary,cwd:s.cwd,inputRevision:s.inputRevision,completedInputRevision:s.completedInputRevision??null,outputCursor:s.next,recentOutputCursor,lastOutputAt:s.lastOutputAt};
  }
  #scheduleConfigFingerprint(s:Session):string|null {
    const env=s.historyEnv??s.accountLaunch?.env??this.dependencies.env??process.env;
    const cliHome=s.summary.agent==='codex'?env.CODEX_HOME??join(env.HOME??homedir(),'.codex'):env.CLAUDE_CONFIG_DIR??join(env.HOME??homedir(),'.claude');
    if(!isAbsolute(cliHome))return null;
    const configPaths=[join(cliHome,s.summary.agent==='codex'?'config.toml':'settings.json')];
    let directory=s.cwd,complete=false,valid=true;
    for(let depth=0;depth<32;depth++){
      configPaths.push(join(directory,'.codex','config.toml'),join(directory,'.claude','settings.json'),join(directory,'.claude','settings.local.json'));
      const parent=dirname(directory);if(parent===directory){complete=true;break;}directory=parent;
    }
    const configIdentity=configPaths.map(path=>{try{const f=lstatSync(path);if(!f.isFile()||f.isSymbolicLink())valid=false;return [path,f.dev,f.ino,f.size,f.mtimeMs];}catch(e:any){if(e.code!=='ENOENT')valid=false;return [path,e.code==='ENOENT'?'absent':'unavailable'];}});
    return complete&&valid?createHash('sha256').update(JSON.stringify(configIdentity)).digest('hex'):null;
  }
  /** Host-only scheduler evidence. This projection neither creates a session nor copies terminal text. */
  async scheduleSnapshot(id:string):Promise<ScheduleSnapshot>{
    const s=this.#sessions.get(id);if(!s||s.summary.state!=='running'||s.closing||s.launchProfile||this.#closed)throw Error('실행 중인 일반 워크룸을 선택하세요. 종료된 터미널은 자동으로 열지 않습니다.');
    if(!['codex','claude'].includes(s.summary.agent))throw Error('이 CLI는 현재 모델·계정·대화와 요청 완료를 확인하는 예약 어댑터가 아직 없습니다.');
    const revision=s.inputRevision,cursor=s.next,frame=await s.screen?.plainRows();
    const context=this.#historyContext(s),info=frame?cliInfoFromScreen(s.summary.agent,frame.rows):null;
    const model=info?.model??s.launchModel?.model??'',configIdentity=this.#scheduleConfigFingerprint(s);
    if(!configIdentity)throw Error('CLI 설정의 경로·소유 상태를 확인하지 못해 예약 실행을 허용하지 않습니다.');
    const identity=createHash('sha256').update(JSON.stringify([s.summary.id,s.summary.createdAt,context.targetFingerprint,context.accountFingerprint,s.conversationId??null,model,s.launchModel?.provider??null,s.bypass,configIdentity])).digest('hex');
    const activity=this.#board.tracker(id)?.activity.state;
    const stable=revision===s.inputRevision&&cursor===s.next;
    // A quiet TUI can still be waiting for a model/tool. Only a never-submitted fresh CLI, or this exact
    // input revision's host-observed transcript completion, authorizes unattended input.
    const turnComplete=s.inputRevision===0&&!s.firstRequest||s.completedInputRevision===s.inputRevision;
    const ready=stable&&!!model&&!!frame&&effortComposerEmpty(frame,s.summary.agent)
      &&turnComplete&&['idle','turn-finished'].includes(activity??'')&&!s.effort?.automaticPending&&!s.pendingThreadCompletion;
    return {binding:{sessionId:id,targetId:s.summary.targetId,agent:s.summary.agent,model,accountId:s.summary.accountId??'host-default',identity,bypass:s.bypass},
      inputRevision:revision,outputCursor:cursor,ready,canStartNew:!!s.launchModel&&(!info?.model||info.model===s.launchModel.model),
      reason:!model?'현재 모델을 확인할 수 없습니다.':ready?'입력 대기 상태입니다.':'작업·작성 중인 입력·승인 화면이 있습니다. 원래 워크룸에서 확인하세요.'};
  }
  /** Absence is distinct from a live session whose original binding can no longer be proven. */
  async inspectBoundSchedule(schedule:WorkroomSchedule,id:string):Promise<ScheduleSnapshot|null>{
    const session=this.#sessions.get(id);
    if(!session||session.summary.state!=='running')return null;
    const snapshot=await this.scheduleSnapshot(id),expected=schedule.binding;
    if(id!==expected.sessionId){
      const bound=this.#scheduleRestorations.get(id),context=this.#historyContext(session);
      if(!bound||bound.scheduleId!==schedule.id||bound.binding.identity!==expected.identity||session.inputRevision!==bound.inputRevision
        ||session.conversationId!==bound.providerConversationId||context.accountFingerprint!==bound.accountFingerprint||context.targetFingerprint!==bound.targetFingerprint
        ||this.#scheduleConfigFingerprint(session)!==bound.configFingerprint||!session.launchModel
        ||session.launchModel.model!==bound.model.model||session.launchModel.provider!==bound.model.provider||session.bypass!==expected.bypass)
        throw Error('복원한 워크룸과 원래 대화의 결속이 변경되었습니다.');
      snapshot.binding={...bound.binding,sessionId:id};
    }
    const actual=snapshot.binding;
    if(actual.identity!==expected.identity||actual.targetId!==expected.targetId||actual.agent!==expected.agent||actual.model!==expected.model||actual.accountId!==expected.accountId||actual.bypass!==expected.bypass)
      throw Error('프로젝트·계정·모델·대화가 변경되어 예약을 멈췄습니다.');
    return snapshot;
  }
  /** In-process recovery evidence only. Never project this into management or mobile responses. */
  async scheduleRestoreFacts(id:string,schedule?:WorkroomSchedule){
    const s=this.#sessions.get(id);
    if(!s||s.closing||s.launchProfile||this.#closed||!['codex','claude'].includes(s.summary.agent)||!s.launchModel
      ||(s.inputRevision===0&&!s.firstRequest)||s.completedInputRevision!==s.inputRevision||!s.completedTranscriptWitness||s.completedObservedModel!==s.launchModel.model||s.pendingThreadCompletion)
      throw Error('원래 모델과 마지막 요청 완료를 확인하지 못했습니다.');
    const revision=s.inputRevision,cursor=s.next,context=this.#historyContext(s),configFingerprint=this.#scheduleConfigFingerprint(s);
    if(!configFingerprint)throw Error('원래 CLI 설정을 확인하지 못했습니다.');
    if(schedule&&id!==schedule.binding.sessionId){
      const bound=this.#scheduleRestorations.get(id);
      if(!bound||bound.scheduleId!==schedule.id||bound.binding.identity!==schedule.binding.identity
        ||bound.inputRevision!==revision||s.conversationId!==bound.providerConversationId||context.accountFingerprint!==bound.accountFingerprint
        ||context.targetFingerprint!==bound.targetFingerprint||configFingerprint!==bound.configFingerprint
        ||s.launchModel.model!==bound.model.model||s.launchModel.provider!==bound.model.provider||s.bypass!==schedule.binding.bypass)
        throw Error('복원한 대화에 사람 입력이 있거나 대화 결속이 변경되었습니다.');
    }
    if(!verifyWorkroomTranscriptWitness(s.completedTranscriptWitness,s.completedTranscriptWitness.path))throw Error('마지막 응답 이후 저장된 대화가 변경되었습니다.');
    const frame=s.summary.state==='running'?await s.screen?.plainRows():null;
    const observed=frame?cliInfoFromScreen(s.summary.agent,frame.rows).model:undefined;
    if(observed&&observed!==s.launchModel.model)throw Error('현재 모델이 원래 실행 모델과 다릅니다.');
    const fresh=this.#historyContext(s);
    if(s.inputRevision!==revision||s.next!==cursor||s.completedInputRevision!==revision||s.closing||this.#closed
      ||fresh.accountFingerprint!==context.accountFingerprint||fresh.targetFingerprint!==context.targetFingerprint||this.#scheduleConfigFingerprint(s)!==configFingerprint)
      throw Error('워크룸이 변경되어 대화 복원 근거를 확인하지 못했습니다.');
    return {sessionId:id,context,launchModel:{...s.launchModel},inputRevision:revision,completedInputRevision:revision,configFingerprint,transcriptWitness:{...s.completedTranscriptWitness}};
  }
  /** Call only after the history service verified the saved provider ID and its exact resume receipt. */
  async adoptRestoredSchedule(schedule:WorkroomSchedule,sessionId:string,providerConversationId:string,sourceId=schedule.binding.sessionId):Promise<ScheduleSnapshot>{
    if(schedule.mode!=='continue'||sessionId===schedule.binding.sessionId||sessionId===sourceId||!providerConversationId)throw Error('대화 복원 결속을 확인하지 못했습니다.');
    const original=this.#sessions.get(sourceId),restored=this.#sessions.get(sessionId);
    if(!original||original.summary.state==='running'||!restored||restored.summary.state!=='running'||restored.inputRevision!==0||restored.firstRequest||restored.conversationId!==providerConversationId)
      throw Error('원래 대화 또는 복원 워크룸의 상태를 확인하지 못했습니다.');
    const facts=await this.scheduleRestoreFacts(sourceId,schedule),context=this.#historyContext(restored);
    const saved=savedWorkroomConversation(original.summary.agent,facts.context.providerHome,facts.context.cwd,providerConversationId);
    if(!saved||!verifyWorkroomTranscriptWitness(facts.transcriptWitness,saved))throw Error('원래 완료 이후 저장된 대화가 변경되어 복원을 멈췄습니다.');
    const identity=createHash('sha256').update(JSON.stringify([original.summary.id,original.summary.createdAt,facts.context.targetFingerprint,facts.context.accountFingerprint,original.conversationId??null,facts.launchModel.model,facts.launchModel.provider??null,original.bypass,facts.configFingerprint])).digest('hex');
    if((sourceId===schedule.binding.sessionId&&identity!==schedule.binding.identity)||facts.context.providerConversationId&&facts.context.providerConversationId!==providerConversationId
      ||restored.summary.targetId!==schedule.binding.targetId||restored.summary.agent!==schedule.binding.agent||restored.bypass!==schedule.binding.bypass
      ||context.accountFingerprint!==facts.context.accountFingerprint||context.targetFingerprint!==facts.context.targetFingerprint
      ||this.#scheduleConfigFingerprint(restored)!==facts.configFingerprint||!restored.launchModel
      ||restored.launchModel.model!==facts.launchModel.model||restored.launchModel.provider!==facts.launchModel.provider)
      throw Error('복원한 대화의 계정·모델·설정이 원래 대화와 다릅니다.');
    this.#scheduleRestorations.set(sessionId,{scheduleId:schedule.id,binding:{...schedule.binding},providerConversationId,inputRevision:0,configFingerprint:facts.configFingerprint,
      accountFingerprint:context.accountFingerprint,targetFingerprint:context.targetFingerprint,model:{...facts.launchModel}});
    try{return await this.inspectBoundSchedule(schedule,sessionId)??(()=>{throw Error('복원한 워크룸이 종료되었습니다.');})();}
    catch(error){this.#scheduleRestorations.delete(sessionId);throw error;}
  }
  async dispatchSchedule(schedule:WorkroomSchedule,run:WorkroomScheduleRun,snapshot:ScheduleSnapshot,active:()=>boolean,effectGate:AiTerminalEffectGate){
    if(typeof effectGate!=='function')throw Error('예약 실행 동기화 권한을 확인하지 못했습니다.');
    const source=this.#sessions.get(snapshot.binding.sessionId);if(!source)throw Error('원래 워크룸이 없습니다.');
    const expectedContext=this.#historyContext(source);
    const expectedConfig=this.#scheduleConfigFingerprint(source);
    const finalCheck=()=>{const current=this.#historyContext(source);if(this.#closed||source.closing||source.summary.state!=='running'||current.accountFingerprint!==expectedContext.accountFingerprint||current.targetFingerprint!==expectedContext.targetFingerprint||!expectedConfig||this.#scheduleConfigFingerprint(source)!==expectedConfig)throw Error('예약 실행 직전에 대상이 변경되었습니다.');};
    const verify=async()=>{
      if(!active())throw Error('예약 실행 권한이 종료되었습니다.');
      const current=await this.inspectBoundSchedule(schedule,source.summary.id);
      if(!current||!current.ready||current.binding.identity!==snapshot.binding.identity||current.inputRevision!==snapshot.inputRevision||current.outputCursor!==snapshot.outputCursor||!active())throw Error('예약 입력 직전에 워크룸이 변경되었습니다.');
    };
    await verify();
    if(schedule.mode==='new-conversation'){
      if(!source.launchModel)throw Error('원래 모델·공급자를 고정할 수 없습니다.');
      const response=await this.perform({operation:'start',requestId:run.id,targetId:source.summary.targetId,agent:source.summary.agent,
        accountId:source.summary.accountId,cols:source.summary.cols,rows:source.summary.rows,bypassPermissions:false,prompt:schedule.prompt},
        undefined,{receiptOwner:'schedule:'+run.id,launchModel:source.launchModel,startEffectGate:effect=>effectGate(()=>{finalCheck();if(source.inputRevision!==snapshot.inputRevision||source.next!==snapshot.outputCursor)throw Error('예약 실행 직전에 워크룸이 변경되었습니다.');return effect();}),startGuard:async context=>{
          await verify();if(context.accountFingerprint!==expectedContext.accountFingerprint||context.targetFingerprint!==expectedContext.targetFingerprint)throw Error('예약 대상의 계정 또는 프로젝트가 바뀌었습니다.');
          return ()=>{const current=this.#historyContext(source);if(!active()||source.inputRevision!==snapshot.inputRevision||source.next!==snapshot.outputCursor||current.accountFingerprint!==expectedContext.accountFingerprint||current.targetFingerprint!==expectedContext.targetFingerprint||!expectedConfig||this.#scheduleConfigFingerprint(source)!==expectedConfig)throw Error('예약 실행 직전에 대상 또는 동의가 변경되었습니다.');};
        }});
      if(!response.session)throw Error('새 대화 실행 결과가 불명입니다.');
      return {state:'submitted' as const,sessionId:response.session.id,inputRevision:0};
    }
    const result=await this.submitHostInstruction({id:run.id,sessionId:source.summary.id,data:schedule.prompt+'\r',revision:snapshot.inputRevision,
      receiptOwner:'schedule:'+run.id,active,beforeInput:verify,writeEffectGate:effect=>effectGate(()=>{finalCheck();if(source.inputRevision!==snapshot.inputRevision+1)throw Error('예약 입력 중 워크룸이 변경되었습니다.');return effect();}),
      validateTarget:(targetId,cwd)=>{const context=this.#historyContext(source);if(targetId!==source.summary.targetId||realpathSync(cwd)!==source.cwd||context.accountFingerprint!==expectedContext.accountFingerprint||context.targetFingerprint!==expectedContext.targetFingerprint||!expectedConfig||this.#scheduleConfigFingerprint(source)!==expectedConfig)throw Error('예약 대상이 바뀌었습니다.');}});
    const restored=this.#scheduleRestorations.get(source.summary.id);if(result.state==='written'&&restored&&restored.scheduleId===schedule.id&&restored.inputRevision===snapshot.inputRevision)restored.inputRevision++;
    return {state:result.state==='written'?'submitted' as const:'unknown' as const,sessionId:source.summary.id,inputRevision:snapshot.inputRevision+1};
  }
  /** Only this exact submitted turn's host-observed completion is a completed scheduled run. */
  async reconcileSchedule(run:WorkroomScheduleRun):Promise<'completed'|'submitted'|'unknown'|'failed'>{
    const s=this.#sessions.get(run.sessionId);if(!s)return 'unknown';
    if(run.state==='dispatching')return 'unknown';
    if(run.inputRevision!==undefined&&s.completedInputRevision===run.inputRevision)return 'completed';
    if(run.inputRevision!==undefined&&s.inputRevision>run.inputRevision)return 'unknown';
    // A process exit says nothing about whether the submitted turn already performed work.
    // Without its exact completion (or a future proven failure receipt), keep the outcome unknown.
    if(s.summary.state!=='running')return 'unknown';
    return 'submitted';
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
  /**
   * Host-only: which 「Hermes · Claude」/「Hermes · Codex」 variant each live session was launched with
   * (src/hermesVariants.ts). Kept off `AiTerminalSummary` on purpose — a phone normalizer rejects unknown keys —
   * so this Mac's panels read it through their own local path.
   */
  hermesVariantSessions():Array<{sessionId:string;variant:HermesVariant}> {
    return [...this.#sessions.values()].flatMap(session => {
      const variant = session.summary.agent==='hermes' ? hermesVariantOf(session.launchModel) : null;
      return variant ? [{sessionId:session.summary.id,variant}] : [];
    });
  }
  /** Host-only: the session while it is running, else null (exited, pruned or unknown). */
  runningSession(id:string):AiTerminalSummary|null {
    const session=this.#sessions.get(id);
    return session&&session.summary.state==='running'?this.#summary(session):null;
  }
  /** Native context commands belong only to an exactly bound local Claude Workroom. */
  contextCommandBindings():ContextCommandBinding[]{
    if(!this.#submissions||!this.dependencies.verifySavedBeforeClose||!this.dependencies.verifyContextSync)return [];
    return [...this.#sessions.values()].filter(s=>s.summary.agent==='claude'&&s.summary.state==='running'&&!s.launchProfile&&!!s.conversationId)
      .map(s=>({providerSessionId:s.conversationId!,sessionId:s.summary.id,targetId:s.summary.targetId,inputRevision:s.inputRevision}));
  }
  async performContextCommand(value:unknown){
    const request=normalizeContextCommandRequest(value);
    if(request.operation==='context.status')return {bindings:this.contextCommandBindings()};
    // sessionOpen: once the Workroom that took the request is closed, nothing more can reach it (src/contextSessionCommandClient.ts).
    if(request.operation==='context.receipt')return {state:this.#submissions?.find('context_'+request.requestId,{owner:'local-context',sessionId:request.sessionId})?.receipt.state??'not-found',sessionOpen:!!this.runningSession(request.sessionId)};
    if(request.operation!=='context.execute')throw Error('컨텍스트 저장은 기존 저장 dispatcher를 사용하세요.');
    const session=this.#sessions.get(request.sessionId);
    if(!session){
      // Closed and pruned. A request it already took keeps that answer; anything else can no longer reach it.
      const taken=this.#submissions?.find('context_'+request.requestId,{owner:'local-context',sessionId:request.sessionId})?.receipt.state;
      if(taken)return taken==='written'||taken==='rejected'?{state:taken}:{state:'unknown',error:'워크룸 세션이 닫혀 전송 결과를 확인할 수 없습니다.'};
      return {state:'rejected',error:'워크룸 세션이 닫혀 명령을 보내지 않았습니다.'};
    }
    if(session.summary.agent!=='claude'||session.launchProfile)return {state:'rejected',error:'이 Claude Code 워크룸을 정확히 확인하지 못했습니다. 명령을 보내지 않았습니다.'};
    const command=`/${request.command}\r`,id='context_'+request.requestId;
    const previous=this.#submissions?.find(id,{owner:'local-context',sessionId:request.sessionId});
    if(!previous){
      if(session.conversationId!==request.providerSessionId||session.inputRevision!==request.inputRevision)return {state:'rejected',error:'세션 또는 입력이 변경되어 명령을 보내지 않았습니다. 다시 저장 후 실행하세요.'};
    }
    const result=await this.submitHostInstruction({id,sessionId:request.sessionId,data:command,receiptOwner:'local-context',skipCorrections:true,revision:request.inputRevision,beforeInput:async()=>{
      if(this.#closed||session.closing||session.summary.state!=='running'||session.conversationId!==request.providerSessionId||session.inputRevision!==request.inputRevision)throw Error('세션 또는 입력이 변경되어 명령을 보내지 않았습니다.');
      if(!this.dependencies.verifySavedBeforeClose||!this.dependencies.verifyContextSync)throw Error('저장·동기화 확인을 지원하지 않는 호스트입니다.');
      const saved={id:session.summary.id,targetId:session.summary.targetId,cwd:session.cwd,inputRevision:session.inputRevision};
      await this.dependencies.verifySavedBeforeClose(saved,request.saveRequestId,'local','context');
      await this.dependencies.verifyContextSync(session.cwd);
      const frame=await session.screen?.plainRows();
      const proof=await this.dependencies.verifySavedBeforeClose(saved,request.saveRequestId,'local','context');
      const activity=this.#board.tracker(session.summary.id)?.activity;
      if(!activity||!['idle','turn-finished'].includes(activity.state)||!effortComposerEmpty(frame??null,'claude')||session.inputRevision!==request.inputRevision)throw Error('Claude가 작업 중이거나 입력칸·승인 화면이 사용 중입니다. 입력 대기 상태에서 다시 실행하세요.');
      // Only this conversation decides (not other worktrees or agents): a turn that ended, or work that began, after the
      // save started may be missing from it. Same input revision alone cannot see output without new input.
      const startedAt=proof?.startedAt;
      if(typeof startedAt!=='number'||!Number.isFinite(startedAt)||activity.since>startedAt)throw Error(WORKROOM_CONTEXT_SAVE_REFUSALS.changed);
    }}).catch(error=>{
      if(request.command==='clear'){
        try{const receipt=this.#submissions?.find(id,{owner:'local-context',sessionId:request.sessionId});if(receipt&&['write_started','written','unknown'].includes(receipt.receipt.state))session.conversationId=undefined;}
        catch{session.conversationId=undefined;}
      }
      throw error;
    });
    // /clear rotates the provider's conversation. Never target the new one through the old row.
    if(request.command==='clear'&&(result.state==='written'||result.state==='unknown'))session.conversationId=undefined;
    return {state:result.state};
  }
  accountInUse(id: string): boolean { return [...this.#sessions.values()].some(s => s.summary.state === 'running' && s.summary.accountId === id); }
  selectedAccount(target: string, agent: AiTerminalAgent): string {
    return cliAccountAgent(agent) && this.dependencies.accounts ? this.dependencies.accounts.store.selected(target, agent) : HOST_CLI_ACCOUNT_ID;
  }
  /** Host-only: an exited session already pruned from the live list, while its last output is kept. */
  retiredSession(id:string):AiTerminalSummary|null {
    const retired=this.#retired.get(id);
    return retired?{...retired.summary}:null;
  }
  /** Host-only: the session a 「다시 시작」 of `id` opened (its exact `resumeFrom` lineage, one step), else null. */
  continuationOf(id:string):string|null { return this.#continuedBy.get(id) ?? null; }
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
  /** Host-only activity of every live session (not on any wire summary). */
  activitySnapshot() { return this.#board.snapshot(); }
  /** Transitions after a cursor, or `{reset:true}` with the snapshot when the cursor is from another boot or too old. */
  activityEvents(after?: WorkroomActivityCursor): WorkroomActivityPage { return this.#board.events(after); }
  /** Long-poll: resolves on the next transition or after `timeoutMs` (capped at 25 s). */
  waitActivity(after: WorkroomActivityCursor | undefined, timeoutMs: number): Promise<WorkroomActivityPage> { return this.#board.wait(after, timeoutMs); }
  /** A visible, focused window shows this session: a finished turn becomes idle. */
  markSeen(sessionId: string): boolean {
    const session=this.#sessions.get(sessionId);
    if(!session||session.summary.state!=='running')return false;
    return this.#board.apply(sessionId,{type:'seen',at:this.#now(),turn:session.inputRevision});
  }
  /**
   * The local `activity` / `seen` operations. Refused for any remote authority (relay, LAN) and for another
   * community device (`receiptOwner`) in this wave: the phone gets its own opt-in read path later (S5).
   */
  async performActivity(value: unknown, authority?: AiTerminalAuthority, options: {receiptOwner?: string} = {}): Promise<{activity: WorkroomActivityPage} | {seen: boolean}> {
    if (authority || options.receiptOwner !== undefined) throw new Error('워크룸 상태는 이 Mac의 화면에서만 확인할 수 있습니다.');
    if (this.#closed) throw new Error('터미널 서버가 종료 중입니다.');
    const request = normalizeWorkroomActivityRequest(value);
    if (request.operation === 'seen') return {seen: this.markSeen(request.sessionId)};
    return {activity: await this.#board.wait(request.after, request.waitMs)};
  }
  /**
   * The local 「에포트 자동」 operation (w16): read the Mac setting and the host-only effort records, or change the
   * setting. Like `activity`, refused for any remote authority and for another community device — the Mac whose
   * CLIs run owns the choice; a phone sees its effect on the CLI's own screen.
   */
  async performEffort(value: unknown, authority?: AiTerminalAuthority, options: {receiptOwner?: string} = {}): Promise<{effort: {auto: boolean; mode?: WorkroomEffortMode; desktopMode?: DesktopEffortMode; sessions: WorkroomEffortRecord[]}}> {
    if (authority || options.receiptOwner !== undefined) throw new Error('에포트 자동 설정은 이 Mac의 워크룸 화면에서만 바꿀 수 있습니다.');
    if (this.#closed) throw new Error('터미널 서버가 종료 중입니다.');
    const request = normalizeWorkroomEffortRequest(value);
    const setting = this.dependencies.effortAuto;
    if (request.desktopMode !== undefined) {
      if (!setting?.setDesktopMode) throw Error('이 호스트는 앱 에포트 추천 설정을 지원하지 않습니다. 앱을 업데이트하세요.');
      setting.setDesktopMode(request.desktopMode);
    }
    if (request.mode !== undefined) {
      if (!setting?.setMode) throw Error('이 호스트는 세 가지 에포트 모드를 지원하지 않습니다. 앱을 업데이트하세요.');
      setting.setMode(request.mode);
    }
    if (request.set !== undefined) {
      if (!setting) throw new Error('이 호스트는 에포트 자동을 지원하지 않습니다. 앱을 업데이트하세요.');
      setting.set(request.set);
    }
    const ids = request.sessionIds ? new Set(request.sessionIds) : null;
    const sessions = [...this.#sessions.values()].filter(s => !ids || ids.has(s.summary.id)).map(s => workroomEffortRecord(s.summary.id, s.summary.agent, s.effort));
    return {effort: {auto: this.#effortAuto(), ...(request.effortModes ? {mode: this.#effortMode()} : {}),
      ...(request.desktopEffortModes && setting?.getDesktopMode ? {desktopMode:setting.getDesktopMode()} : {}), sessions}};
  }
  #effortMode(): WorkroomEffortMode { try { return this.dependencies.effortAuto?.getMode?.() ?? (this.dependencies.effortAuto?.get() ? 'auto' : 'off'); } catch { return 'off'; } }
  async #adjustEffort(session: Session, text: string, active: () => boolean) {
    const state=session.effort;
    // A level the person pinned for this session (a team member) is never changed by auto.
    if(!state||state.pinned||!this.dependencies.effortAuto?.getMode||session.launchProfile)return;
    const mode=this.#effortMode();
    if(mode==='off'){state.advice=undefined;state.runtimeStatus=undefined;return;}
    const decision=classifyWorkroomEffort(workroomEffortRequestText(text));if(!decision)return;
    noteWorkroomEffortRequest(state,session.summary.agent,text,true,new Date().toISOString());
    if(mode==='recommend')return;
    if(session.summary.agent==='agy'||session.historyEnv?.CLAUDE_CODE_EFFORT_LEVEL&&session.summary.agent==='claude')return;
    if(!session.screen){state.runtimeStatus='unsupported';return;}
    const frame=await session.screen.plainRows();
    if(frame)observeWorkroomEffortScreen(state,session.summary.agent,frame.rows);
    // Auto ON authorizes the next contextual decision even after a native effort selection.
    state.manual=false;
    const current=frame?cliInfoFromScreen(session.summary.agent,frame.rows).effort??state.seen:state.seen;
    if(current===decision.tier){state.advice=undefined;return;}
    const executable=this.dependencies.executable(session.summary.agent);if(!executable){state.runtimeStatus='unsupported';return;}
    const support=(this.dependencies.effortRuntimeSupport??workroomEffortRuntimeSupport)(executable,session.summary.agent,session.historyEnv??{},session.cwd);
    const revision=session.inputRevision;
    const allowed=()=>active()&&session.inputRevision===revision&&this.#effortMode()==='auto'&&!state.manual;
    state.automaticPending=true;state.runtimeStatus='deferred';
    // Whether any key reached the CLI. Without one the CLI still runs at `seen`, and this request goes at that level.
    let typed=false;
    try{
      const outcome=await (this.dependencies.effortRuntime??changeWorkroomEffort)({agent:session.summary.agent,level:decision.tier,current,
        read:()=>session.screen!.plainRows(),write:async data=>{
          if(!allowed())throw Error('워크룸 입력이 변경되었습니다.');
          let valid=false;
          try{
            const binding=session.revalidate?await session.revalidate():await this.dependencies.resolveTarget(session.summary.targetId);
            valid=realpathSync(binding.cwd)===session.cwd&&allowed();
          }catch{/* A resolver/filesystem failure must not expose a local path to a phone. */}
          if(!valid)throw Error('워크룸 프로젝트 또는 입력 권한이 변경되었습니다. 작성한 요청은 유지했습니다.');
          typed=true;session.child.terminal.write(data);
        },active:allowed,
        idle:()=>['idle','turn-finished'].includes(this.#board.tracker(session.summary.id)?.activity.state??''),timeoutMs:WORKROOM_EFFORT_READY_WAIT_MS,
        cols:session.summary.cols,refusal:state.effortRefusal,refused:refusal=>{state.effortRefusal=refusal;},...support});
      // The CLI cancelled or refused the change and its screen proves the level did not move: like a request with no key
      // typed, it goes on at the current level and the advice says so (no new runtimeStatus — strict readers reject one).
      if(outcome==='unchanged')state.runtimeStatus=undefined;
      // A key typed without a confirmed change is a partial mutation: refused like any other unconfirmed change.
      else if(outcome!=='applied'&&typed)throw Error('에포트 변경을 확인하지 못했습니다. 원본 워크룸을 확인하세요. 작성한 요청은 유지했습니다.');
      else state.runtimeStatus=outcome;
      if(outcome==='applied'){state.level=decision.tier;state.tier=decision.tier;state.reason=decision.reason;state.origin='runtime';state.seen=decision.tier;state.advice=undefined;delete state.skipped;return;}
    }catch(error){
      // No empty, idle composer in time and nothing typed: the CLI stays at its current effort, said by the advice line,
      // and the next request is judged again. Holding it past every client timeout left it `prepared` and fenced the
      // composer (2026-10-30). Any other failure — keys typed, picker or question — still refuses the request.
      if(!(error instanceof WorkroomEffortNotReadyError&&!typed)){state.runtimeStatus='unconfirmed';throw error;}
      state.runtimeStatus=undefined;
    }
    finally{
      // Establish a new observation baseline before the sampler resumes manual-change detection. When no key was typed
      // the CLI's level did not move: keep `seen`, so the next request still knows it (the effort row may be off screen).
      const rows=(await session.screen.plainRows())?.rows??[],kept=typed?undefined:state.seen;
      delete state.phraseLines;delete state.seen;state.automaticPending=false;
      if(kept)state.seen=kept;
      observeWorkroomEffortScreen(state,session.summary.agent,rows);
    }
    // Not changed: the advice line says the effort stays as it is (never 「입력 대기」).
    state.advice={tier:decision.tier,reason:decision.reason,at:new Date().toISOString()};
    // Unchanged effort goes into a native Claude/Codex composer only when it is proven empty now (a dimmed native
    // placeholder counts): a real, changed or unreadable draft would merge with the request. Refused before the write
    // fence, so not one byte of it is typed and the person's draft stays (ROOT review, 2026-10-30). A CLI that cannot be
    // switched at run time (no session picker, no default keys) keeps its plain write path.
    const nativeTui=session.summary.agent==='claude'&&support.claudeSessionPicker||session.summary.agent==='codex'&&support.codexDefaultKeys;
    if(nativeTui&&!effortComposerEmpty(await session.screen.plainRows(),session.summary.agent))
      throw Error('CLI 입력칸에 작성 중이거나 확인할 수 없는 내용이 있어 요청을 입력하지 않았습니다. 원본 워크룸의 입력칸을 확인한 뒤 다시 보내세요. 작성한 요청은 유지했습니다.');
  }
  #effortAuto(): boolean { try { return this.dependencies.effortAuto?.get() ?? false; } catch { return false; } }
  /**
   * 「에포트 자동」 through the Workroom workspace channel (w16 Build B, `workroom.effort`): this Mac's own windows, a phone
   * holding `targetId` (the workspace gateway checked that grant) and another community Mac (its executor refuses `set`).
   * Answers the setting and, with a session of that target, its record. The session is checked before anything changes.
   */
  workspaceEffort(input: {targetId: string; sessionId?: string; set?: boolean; mode?: WorkroomEffortMode; effortModes?: true; effortExtended?: true}): WorkroomEffortView {
    if (this.#closed) throw new Error('터미널 서버가 종료 중입니다.');
    const session = input.sessionId === undefined ? undefined : this.#session(input.sessionId, input.targetId);
    if (input.mode !== undefined) {
      const setting = this.dependencies.effortAuto;
      if (!setting?.setMode) throw Error('이 호스트는 세 가지 에포트 모드를 지원하지 않습니다. 앱을 업데이트하세요.');
      try { setting.setMode(input.mode); } catch { throw Error('에포트 조정 모드를 저장하지 못했습니다. Mac에서 저장 공간과 앱 데이터 접근 권한을 확인한 뒤 다시 시도하세요.'); }
    }
    if (input.set !== undefined) {
      const setting = this.dependencies.effortAuto;
      if (!setting) throw new Error('이 호스트는 에포트 자동을 지원하지 않습니다. 앱을 업데이트하세요.');
      try { setting.set(input.set); }
      catch { throw new Error('에포트 자동 설정을 저장하지 못했습니다. Mac에서 저장 공간과 앱 데이터 접근 권한을 확인한 뒤 다시 시도하세요.'); }
    }
    return workroomEffortView(this.#effortAuto(), session ? workroomEffortRecord(session.summary.id, session.summary.agent, session.effort) : undefined, input.effortModes ? this.#effortMode() : undefined, input.effortExtended === true);
  }
  /** One sweep (the 1 s timer calls this): rows at most once per running session, then bounded transcript tails. */
  sampleActivity(): Promise<void> {
    if (this.#sampling) return this.#sampling;
    this.#sampling = this.#sample().finally(() => { this.#sampling = null; });
    return this.#sampling;
  }
  async #sample() {
    const running = [...this.#sessions.values()].filter(s => s.summary.state === 'running' && !s.closing);
    for (const session of running) {
      const id = session.summary.id;
      const pending=session.pendingThreadCompletion;
      if(pending){
        const active=()=>!this.#closed&&!session.closing&&session.summary.state==='running'&&session.inputRevision===pending.revision;
        if(!active())delete session.pendingThreadCompletion;
        else if(this.#now()>=pending.retryAt)try{await this.dependencies.threadCompleted?.(id,pending,pending.revision,active);delete session.pendingThreadCompletion;}catch{pending.retryAt=this.#now()+15_000;/* Retry this bounded observation, never the AI request. */}
      }
      if (!this.#board.has(id)) continue;
      const memory = session.activitySample ??= {startedAt: this.#now()};
      let rows: string[] | null | undefined;
      if (workroomSampleWantsRows(memory, session.lastOutputAt)) {
        try { rows = session.screen ? (await session.screen.plainRows())?.rows ?? null : null; } catch { rows = null; }
        // The effort the CLI shows, and a change the person made themselves, from the rows already read (w16).
        if (rows && session.effort) try { observeWorkroomEffortScreen(session.effort, session.summary.agent, rows); } catch { /* advisory */ }
      }
      for (const input of workroomSampleInputs(memory, {at: this.#now(), turn: session.inputRevision, lastOutputAt: session.lastOutputAt, rows}))
        this.#board.apply(id, input);
      if(rows&&!session.effort?.automaticPending&&this.#board.tracker(id)?.activity.state==='needs-answer')try{await this.dependencies.threadQuestion?.(id,rows,session.inputRevision);}catch{/* The Workroom remains the live question surface. */}
    }
    const signals = this.dependencies.turnSignals;
    if (!signals) return;
    let budget = WORKROOM_TRANSCRIPT_TICK_BYTES;
    for (const session of running) {
      if (budget <= 0 || session.summary.state !== 'running' || (session.summary.agent !== 'claude' && session.summary.agent !== 'codex')) continue;
      const id = session.summary.id, tracker = this.#board.tracker(id);
      if (!tracker) continue;
      try {
        const env = session.historyEnv ?? session.accountLaunch?.env ?? this.dependencies.env ?? process.env;
        const revision=session.inputRevision;
        const {completions, bytes,witness} = await signals.poll({sessionId: id, agent: session.summary.agent, cwd: session.cwd, env, createdAt: session.summary.createdAt,
          ...(session.conversationId ? {conversationId: session.conversationId} : {}), processGroup: session.child.pid,
          restricted: !!session.launchProfile, lastSubmitAt: tracker.lastSubmitAt}, budget);
        budget -= bytes;
        if(session.inputRevision!==revision||session.closing||session.summary.state!=='running')continue;
        for (const completion of completions){
          const changed=this.#board.apply(id, {type: 'transcript', at: this.#now(), turn: revision, key: completion.key, completedAt: completion.completedAt});
          const finished=this.#board.tracker(id)?.activity;
          if(changed&&finished?.state==='turn-finished'&&finished.exact&&finished.source==='transcript'){
            session.completedInputRevision=revision;
            session.completedTranscriptWitness=witness?.key===completion.key?witness:undefined;
            session.completedObservedModel=undefined;
            const cursor=session.next,frame=await session.screen?.plainRows();
            if(frame&&session.inputRevision===revision&&session.next===cursor&&session.summary.state==='running'&&!session.closing)
              session.completedObservedModel=cliInfoFromScreen(session.summary.agent,frame.rows).model;
            if(completion.resultText&&this.dependencies.threadCompleted){
              const pending={key:completion.key,resultText:completion.resultText,revision,retryAt:this.#now()+15_000};session.pendingThreadCompletion=pending;
              const active=()=>!this.#closed&&!session.closing&&session.summary.state==='running'&&session.inputRevision===revision;
              try{await this.dependencies.threadCompleted(id,pending,revision,active);delete session.pendingThreadCompletion;}catch{/* Retry the observation next sweep; never resend the request. */}
            }
          }
        }
      } catch { /* A transcript is an optional exact signal; the screen tier keeps working. */ }
    }
  }
  #ensureSampler() {
    if (this.#sampler || this.#closed || this.dependencies.activitySampler === false) return;
    this.#sampler = setInterval(() => {
      if (![...this.#sessions.values()].some(s => s.summary.state === 'running')) { clearInterval(this.#sampler); this.#sampler = undefined; return; }
      void this.sampleActivity();
    }, WORKROOM_ACTIVITY_SAMPLE_MS);
    (this.#sampler as any).unref?.();
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
    this.#submissions?.release(session.summary.id);
    // Once exited, the state fence rejects input/resize even after their retry
    // records are gone. Start IDs remain fenced for this service's lifetime.
    for (const key of session.requestKeys) this.#requests.delete(key);
    session.requestKeys.clear();
  }
  /** `receiptOwner` is host-only (never on the wire): the namespace for whole-request submission receipts. Without an
   *  authority it names another community device driving this Workroom; with one it is the transport's stable principal
   *  (a LAN controller survives a restore that rotates `authority.owner`). It is a lookup key only — every grant, target
   *  and execution decision below reads `authority`, never this. */
  async perform(value: unknown, authority?: AiTerminalAuthority, options: {launchProfile?: AiTerminalLaunchProfile; launchModel?: AiTerminalLaunchModel; launchEffort?: WorkroomLaunchEffort; historyResume?: import('./workroomConversationHost').WorkroomHistoryLaunch; receiptOwner?: string; skipCorrections?: boolean; startGuard?:AiTerminalStartGuard;beforeInput?:()=>Promise<void>;writeEffectGate?:AiTerminalEffectGate;startEffectGate?:AiTerminalEffectGate;opsWorker?:boolean} = {}): Promise<AiTerminalResponse> {
    const request = normalizeAiTerminalRequest(value);
    if (options.receiptOwner !== undefined && (options.receiptOwner === 'local' || (authority
      ? typeof options.receiptOwner !== 'string' || options.receiptOwner.length < 3 || options.receiptOwner.length > 300 || /[\x00-\x1f\x7f]/.test(options.receiptOwner) || /^community(?::|$)/.test(options.receiptOwner)
      : !/^[a-z][a-z0-9:_-]{2,160}$/.test(options.receiptOwner)))) throw new Error('제출 기록의 소유자를 확인하지 못했습니다.');
    // Host-only, for an instruction this Mac's automation composed under its own receipt namespace (never the composer's).
    if (options.skipCorrections && (authority || options.receiptOwner === undefined || request.operation !== 'submission')) throw new Error('교정 문맥 생략은 이 Mac의 호스트 제출에만 쓸 수 있습니다.');
    const receiptOwner = options.receiptOwner ?? authority?.owner ?? 'local';
    if (this.#closed) throw new Error('터미널 서버가 종료 중입니다.');
    if (authority && (!(authority.deviceConsentActive ? authority.deviceConsentActive() : this.remoteAllowed(authority.owner)) || authority.isActive?.()===false)) throw new Error('Mac의 AI 터미널 화면에서 이 원격 연결의 터미널 접근을 허용하세요.');
    const visible = (s: Session) => !authority || authority.targets.has(s.summary.targetId);
    if (request.operation === 'list') return {sessions: [...this.#sessions.values()].filter(visible).map(s => this.#summary(s)),...(request.capabilities?{features:this.#submissions?[WORKROOM_SUBMISSION_FEATURE,WORKROOM_LAUNCH_SUBMISSION_FEATURE,WORKROOM_SUBMISSION_RECENT_FEATURE]:[]}:{})};
    if ((request.operation === 'start' || request.operation === 'accounts') && authority && !authority.targets.has(request.targetId!)) throw new Error('이 원격 연결에 등록된 프로젝트가 아닙니다.');
    if (authority && (request.operation === 'accounts' || request.accountId !== undefined) && !authority.accountSelectionAllowed?.()) throw new Error('Mac에서 이 기기의 계정 선택 권한을 별도로 허용하세요.');
    if (options.launchProfile && (authority || request.operation !== 'start' || request.agent !== 'claude' || request.resumeFrom)) throw new Error('제한 실행은 이 Mac의 새 Claude 세션에만 쓸 수 있습니다.');
    if (options.launchModel) {
      if (authority || request.operation !== 'start' || request.resumeFrom || options.launchProfile) throw new Error('모델 지정은 이 Mac의 새 워크룸 시작에만 쓸 수 있습니다.');
      const modelError = launchModelError(request.agent!, options.launchModel); if (modelError) throw new Error(modelError);
    }
    if (options.launchEffort && (authority || request.operation !== 'start' || request.resumeFrom || options.launchProfile || options.historyResume)) throw new Error('에포트 지정은 이 Mac의 새 워크룸 시작에만 쓸 수 있습니다.');
    // Host-only: the OPS host starts the worker for a task another Mac handed over (opsWorkerToolApproval.ts).
    if (options.opsWorker && (authority || request.operation !== 'start' || request.resumeFrom || request.bypassPermissions || options.launchProfile || options.historyResume)) throw new Error('OPS 작업 도구 허용은 이 Mac의 OPS 호스트가 여는 새 워크룸에만 쓸 수 있습니다.');
    if (options.historyResume && (authority || request.operation !== 'start' || request.resumeFrom || request.prompt !== undefined
      || request.references !== undefined || request.bypassPermissions !== undefined || options.launchProfile
      || request.agent !== options.historyResume.resume.agent || request.accountId !== options.historyResume.accountId)) throw new Error('대화 기록 재개는 로컬의 확인된 요청만 허용합니다.');
    const session = request.sessionId ? this.#sessions.get(request.sessionId) : null;
    // A launch submission (terminal-start-submission-v1) has no session yet; its receipt lives in the launch scope.
    const launchScope = request.operation === 'submission' && request.sessionId === undefined;
    if(request.operation==='submission'&&(request.submission?.phase==='status'||request.submission?.phase==='recent')){
      if(!this.#submissions)throw Error('이 호스트는 전체 요청 제출을 지원하지 않습니다. 앱을 업데이트하세요.');
      const context=launchScope?{owner:receiptOwner,sessionId:'',scope:WORKROOM_LAUNCH_SCOPE}:{owner:receiptOwner,sessionId:request.sessionId!};
      if(request.submission.phase==='recent'){
        // Read-only: never writes, never re-executes. Rows outside this grant are hidden, not refused.
        return {submissions:this.#submissions.recent(receiptOwner,context.scope??context.sessionId).filter(({record})=>!authority||authority.targets.has(record.targetId)).map(({receipt})=>receipt)};
      }
      const {record,receipt}=this.#submissions.status(request.submission.id,context);
      if(authority&&!authority.targets.has(record.targetId))throw Error('이 프로젝트의 제출 기록 권한이 없습니다.');
      const launched=launchScope&&receipt.sessionId?this.#sessions.get(receipt.sessionId):undefined;
      return {submission:receipt,...(launched&&visible(launched)?{session:this.#summary(launched)}:{})};
    }
    if(launchScope){
      const submission=request.submission!;
      // The same guards as `start`, before anything is prepared: the grant names the target. A permission bypass keeps
      // `start`'s rule for this Mac and a granted phone; another community device never gets one (its executor refuses
      // a top-level bypass, and this nested one is refused here).
      if((submission.phase==='begin'||submission.phase==='single')&&submission.launch){
        if(authority&&!authority.targets.has(submission.launch.targetId))throw new Error('이 원격 연결에 등록된 프로젝트가 아닙니다.');
        if(submission.launch.bypassPermissions&&!authority&&receiptOwner!=='local')throw new Error('다른 기기에서는 권한 우회나 다시 시작으로 세션을 열 수 없습니다. 세션을 열 기기 앞에서 직접 여세요.');
      }
    }
    else if (request.operation !== 'start' && request.operation !== 'accounts' && (!session || !visible(session))) throw new Error('터미널을 찾을 수 없거나 접근 권한이 없습니다.');
    if (request.operation === 'accounts' && request.accountAction === 'list') {
      if (!this.dependencies.accounts) throw new Error('이 호스트는 계정 선택을 지원하지 않습니다. 호스트 앱을 업데이트하세요.');
      const epoch = authority ? this.#grantEpoch.get(authority.owner) : undefined;
      await this.dependencies.resolveTarget(request.targetId!);
      if (authority && (this.#authorityLost(authority,epoch) || !authority.accountSelectionAllowed?.())) throw new Error('계정 선택 권한이 해제되었습니다.');
      return {accounts: this.dependencies.accounts.selection(request.targetId!, request.agent as 'codex'|'claude')};
    }
    if (request.operation === 'read') {
      // A read is never «seen» (review 2026-10-16): remote panels poll in the background and an @ delivery reads the
      // receiver's screen, neither a person looking. Seen stays local (visible + focused window); a remote keystroke
      // into the session still moves a finished turn on.
      if (request.snapshot && session!.screen) {
        const page = await session!.screen.snapshotPage(request.after!,session!.chunks,session!.next).catch(()=>null);
        if (page) {
          // A cached continuation describes the grid at serialization, even if another viewer resized the PTY
          // between its pages. Keep terminal-v1's strict wire keys; ordinary reads/list still report the live size.
          const {cols,rows,chunks,nextCursor,hasMore,truncated}=page;
          return {session:{...this.#summary(session!),cols,rows},chunks,nextCursor,hasMore,truncated};
        }
      }
      return {session: this.#summary(session!), ...terminalOutputPage(session!.chunks,request.after!)};
    }
    // Retry ids are fenced before any await or write: neither a lost response nor double-click types twice.
    const key = `${authority?.owner ?? 'local'}:${request.requestId}`;
    // A host-local history start carries a resume intent outside terminal-v1. It must not reuse the
    // result of an ordinary start (or a different logical conversation) with the same wire request ID.
    const historyIntent=options.historyResume;
    const historyReplay=historyIntent?{historyResume:{logicalConversationId:historyIntent.logicalConversationId,
      resume:historyIntent.resume,accountId:historyIntent.accountId,cwd:historyIntent.cwd}}:{};
    const replayIntent=options.launchModel?{request,...historyReplay,launchModel:{model:options.launchModel.model,...(options.launchModel.provider?{provider:options.launchModel.provider}:{})}}
      :historyIntent?{request,...historyReplay}:request;
    const fingerprint = createHash('sha256').update(JSON.stringify(replayIntent)).digest('hex');
    const previous = this.#requests.get(key);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new Error('같은 요청 ID에 다른 입력을 보낼 수 없습니다.');
      return previous.promise;
    }
    if (request.operation === 'close' && session!.closing) return session!.closing;
    if (request.operation === 'input' || request.operation === 'resize' || request.operation==='submission'&&!launchScope) {
      if (session!.summary.state !== 'running') throw new Error('종료된 터미널입니다. 새 세션을 여세요.');
      if (session!.closing) throw new Error('터미널이 종료 중입니다.');
    }
    const closing = request.operation === 'close';
    if(closing)this.#submissions?.release(request.sessionId!);
    // Close is naturally idempotent per session and must remain available even
    // when a live session has used its entire exactly-once input history.
    if (!closing && this.#requests.size >= AI_TERMINAL_MAX_REQUEST_HISTORY) throw new Error('터미널 요청 이력이 가득 찼습니다. 세션을 종료하면 입력 기록이 정리됩니다.');
    if (!closing && this.#pendingMutations >= AI_TERMINAL_MAX_PENDING_MUTATIONS) throw new Error('처리 중인 터미널 입력이 너무 많습니다. 잠시 후 다시 시도하세요.');
    const queueKey = request.sessionId ?? 'start';
    const epoch = authority ? this.#grantEpoch.get(authority.owner) : undefined;
    // Stop does not wait for a stalled checkout proof or queued keystrokes.
    // The mutation fence below prevents those writes after close is requested.
    const effortInterrupt=!!session?.effort?.automaticPending&&request.operation==='input'&&request.data==='\x1b';
    const promise = (closing||effortInterrupt ? Promise.resolve() : this.#queues.get(queueKey) ?? Promise.resolve()).catch(()=>{}).then(()=>this.#mutate(request, session, authority, epoch, options.launchProfile, options.historyResume, undefined, receiptOwner, options.skipCorrections === true,undefined,undefined,options.startGuard,options.launchModel,options.launchEffort,options.beforeInput,options.writeEffectGate,options.startEffectGate,options.opsWorker === true));
    if (!closing&&!effortInterrupt) this.#queues.set(queueKey,promise);
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
  /** `remoteAttachmentIds` is host-only: the ids of an admitted submission (never read from a wire `input`). */
  async #mutate(r: AiTerminalRequest, session: Session | null | undefined, authority?: AiTerminalAuthority, epoch?: number, launchProfile?: AiTerminalLaunchProfile, historyResume?: import('./workroomConversationHost').WorkroomHistoryLaunch,submissionWrite?:(exposure?:CorrectionTaskExposure)=>void,receiptOwner=authority?.owner??'local',skipCorrections=false,launchStart?:{sessionId:string;started:()=>void},remoteAttachmentIds?:readonly string[],startGuard?:AiTerminalStartGuard,launchModel?:AiTerminalLaunchModel,launchEffort?:WorkroomLaunchEffort,beforeInput?:()=>Promise<void>,writeEffectGate?:AiTerminalEffectGate,startEffectGate?:AiTerminalEffectGate,opsWorker=false): Promise<AiTerminalResponse> {
    if (this.#authorityLost(authority, epoch)) throw new Error('원격 터미널 권한이 해제되었습니다.');
    if (authority && (r.operation === 'accounts' || r.accountId !== undefined) && !authority.accountSelectionAllowed?.()) throw new Error('계정 선택 권한이 해제되었습니다.');
    if(this.#closed)throw new Error('터미널 서버가 종료 중입니다.');
    if(r.operation==='submission'&&r.sessionId===undefined)return this.#launchSubmission(r,authority,epoch,receiptOwner);
    if (r.operation === 'close') {
      if(r.memoryPolicy==='saved'){
        await this.#queues.get(session!.summary.id)?.catch(()=>{});
        if(!this.dependencies.verifySavedBeforeClose)throw new Error('종료 전 저장 확인을 지원하지 않는 호스트입니다.');
        await this.dependencies.verifySavedBeforeClose({...session!.summary,cwd:session!.cwd,inputRevision:session!.inputRevision},r.saveRequestId!,authority?.owner??'local','close');
        if(authority&&(!(authority.deviceConsentActive?authority.deviceConsentActive():this.remoteAllowed(authority.owner))||authority.isActive?.()===false))throw new Error('원격 권한이 변경되었습니다.');
      }
      if(r.memoryPolicy)session!.suppressMemoryOnExit=true;
      // Persist the request before terminating the CLI; save runs only after exit.
      this.#remember(session!);
      if (session!.summary.state === 'exited') return {session:this.#summary(session!)};
      // Ended by a viewer, not by itself: never announced (critique item 6). Set only now that the CLI is signalled — a
      // close that failed above leaves a later crash announced. A restart passes its own cause (#closeCause).
      session!.exitCause??=session!.closeCause??'close';
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
    if (r.operation === 'accounts') {
      if (!this.dependencies.accounts) throw new Error('이 호스트는 계정 선택을 지원하지 않습니다. 호스트 앱을 업데이트하세요.');
      return {accounts: await this.dependencies.accounts.select(targetId, r.agent as 'codex'|'claude', r.accountId!, r.requestId, authority?.owner ?? 'local',
        () => !this.#closed && !this.#authorityLost(authority,epoch) && (!authority || !!authority.accountSelectionAllowed?.()))};
    }
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
      if (r.accountId !== undefined && !this.dependencies.accounts && !(historyResume && r.accountId===HOST_CLI_ACCOUNT_ID)) throw new Error('이 호스트는 계정 선택을 지원하지 않습니다.');
      const effectiveProfile = previous ? previous.launchProfile : launchProfile;
      if (effectiveProfile && r.accountId !== undefined && r.accountId !== HOST_CLI_ACCOUNT_ID) throw new Error('제한 실행은 기존 호스트 계정만 사용합니다.');
      const baseEnv = previous?.accountLaunch?.env ?? this.dependencies.env ?? process.env;
      const accountLaunch = cliAccountAgent(r.agent) && this.dependencies.accounts
        ? await this.dependencies.accounts.launch(targetId,r.agent, previous?.accountLaunch?.accountId ?? (effectiveProfile ? HOST_CLI_ACCOUNT_ID : r.accountId),baseEnv)
        : undefined;
      if (this.#closed || this.#authorityLost(authority,epoch) || authority && r.accountId !== undefined && !authority.accountSelectionAllowed?.()) throw new Error('계정 선택 또는 터미널 권한이 해제되었습니다.');
      const env:Record<string,string|undefined> = {...(accountLaunch?.env ?? baseEnv), TERM:'xterm-256color', COLORTERM:'truecolor'};
      // An app opened from the Dock has no locale (measured: a Workroom Codex had only PATH and TERM), so the
      // shell commands an AI runs fell back to C and mishandled Korean text. A user's own locale is kept.
      if (!env.LANG && !env.LC_ALL && !env.LC_CTYPE) env.LANG = 'en_US.UTF-8';
      // A Workroom is a local terminal even when the app itself was relaunched over SSH (`open` passes the
      // caller's environment). Inherited SSH_* made Antigravity treat it as remote and skip the keychain —
      // 「not signed in」 in the Workroom, signed in everywhere else (3호, 2026-10-08).
      delete env.SSH_CONNECTION; delete env.SSH_CLIENT; delete env.SSH_TTY;
      // Keep the CLI's ordinary user environment; never inherit this app's private control capabilities.
      for (const name of Object.keys(env)) if (/^(PORTMGR_|AGENTSTOZ_).*CAPABILITY|^(AGENTSTOZ_VOICE_API_KEY|SUPABASE_SERVICE_ROLE_KEY|VITE_SUPABASE_SERVICE_ROLE_KEY)$/.test(name)) delete (env as Record<string, unknown>)[name];
      // The project's own CLI accounts win over this Mac's logins. A restricted (duty) session keeps this Mac's.
      if (this.dependencies.cliAccountEnvironment && !(previous ? previous.launchProfile : launchProfile)) Object.assign(env, await this.dependencies.cliAccountEnvironment({targetId,cwd,env}));
      // A Workroom opened from another Mac has no approval bypass, so Codex stopped at its hook-trust menu in
      // every project carrying the AgentsToZ activity hook (3호, 2026-10-07). Skip that menu only when that
      // hook is all Codex would run (codexHookTrust.ts); any other hook keeps Codex's own question.
      const codexHookTrust = r.agent === 'codex' && !(previous ? previous.launchProfile : launchProfile)
        && codexHooksAreAgentsToZOnly(cwd, env.CODEX_HOME || join(env.HOME || homedir(), '.codex'))
        && await (this.dependencies.codexHookTrustSupported ?? codexSupportsHookTrustFlag)(executable, env);
      if (this.#closed) throw new Error('터미널 서버가 종료 중입니다.');
      let resume: AiTerminalResume | null = historyResume?.resume ?? null;
      if (previous) {
        const source: AiTerminalResumeSource = {agent:previous.summary.agent,cwd:previous.cwd,createdAt:previous.summary.createdAt,
          ...(previous.exitedAt?{exitedAt:previous.exitedAt}:{}),...(previous.conversationId?{conversationId:previous.conversationId}:{}),
          ...(previous.summary.state==='running'?{processGroup:previous.child.pid}:{})};
        const resolveResume = this.dependencies.resume ?? (value => resolveAiTerminalResume(value, {home:env.HOME||homedir(),codexHome:env.CODEX_HOME||undefined,claudeConfigDir:env.CLAUDE_CONFIG_DIR||undefined,openFiles:processGroupOpenFiles}));
        // Read while the CLI still runs: Codex names its thread only through a lock the process holds.
        try { resume = await resolveResume(source); } catch { resume = null; }
        // A continued conversation has not ended, so it is not queued for a memory save; one that cannot be
        // continued ends like an ordinary close. The CLI must be gone before another opens its conversation.
        // The cause is applied by the close only once it signals the CLI; a close that fails leaves none behind.
        previous.closeCause = 'restart';
        try { if (previous.summary.state === 'running') await this.perform({operation:'close',requestId:`restart-${randomUUID()}`,sessionId:previous.summary.id,...(resume?{memoryPolicy:'skip' as const}:{})}); }
        finally { previous.closeCause = undefined; }
        if (this.#closed) throw new Error('터미널 서버가 종료 중입니다.');
      }
      const bypass = previous ? previous.bypass : !!r.bypassPermissions;
      // A restart keeps the restriction of the session it replaces; it never gains or loses it.
      const profile = previous ? previous.launchProfile : launchProfile;
      const model = previous ? previous.launchModel : launchModel;
      const requestedPin = previous?.effort?.pinned ?? (launchEffort && 'pinned' in launchEffort ? launchEffort.pinned : undefined);
      if (r.agent === 'claude' && (requestedPin === 'xhigh' || requestedPin === 'max') &&
          (env.CLAUDE_CODE_DISABLE_THINKING === '1' || env.MAX_THINKING_TOKENS === '0'))
        throw new Error('Claude의 thinking이 꺼져 있어 고정 에포트를 적용할 수 없습니다.');
      // 「에포트 자동」 (w16): decided from the person's first request (before `#` references), or kept from the session a
      // restart replaces. A team member brings a pinned level or the task text to classify (launchEffort). Read-only; a
      // level a model may reject is never passed (codexEffortModel.ts) — a model we chose is proven against the catalog, and a
      // Hermes model and provider we chose against the levels its adapter carries (teamHermesEffortLevels).
      const effort = planWorkroomEffort({agent:r.agent!,...(r.prompt!==undefined?{prompt:r.prompt}:{}),auto:this.#effortAuto(),mode:this.#effortMode(),restricted:!!profile,historyResume:!!historyResume,
        ...(previous?{previous:previous.effort??{manual:false}}:launchEffort&&'pinned' in launchEffort?{pinned:launchEffort.pinned}:launchEffort?{requestText:launchEffort.requestText}:{}),envOverride:!!env.CLAUDE_CODE_EFFORT_LEVEL,...(r.agent==='hermes'&&model?{hermesModel:model}:{}),
        codexAllowed:()=>{try{const proof=(this.dependencies.codexEffortModel??readCodexEffortModel)({env,cwd,args:accountLaunch?.args??[],...(model?{launchModel:model.model}:{})});return proof.ok?proof.allowed:null;}catch{return null;}}});
      if (effort.pinned && !effort.level) throw new Error(`고정 에포트 ${effort.pinned}를 적용할 수 없어 시작하지 않았습니다 (${effort.skipped ?? 'unsupported'}).`);
      // A restricted (duty) session talks to outsiders: its transcript is not the user's work, so it never
      // feeds session memory or 「내가 한 말」 capture.
      if (launchStart && this.#sessions.has(launchStart.sessionId)) throw new Error('이미 시작된 세션입니다. 자동으로 다시 시작하지 않습니다.');
      const summary: AiTerminalSummary = {id:launchStart?.sessionId ?? randomUUID(),targetId,agent:r.agent!,state:'running',createdAt:new Date().toISOString(),exitCode:null,cols:r.cols!,rows:r.rows!,...(accountLaunch?{accountId:accountLaunch.accountId,accountLabel:accountLaunch.label}:{})};
      // Lets an AI in this Workroom tell agentstoz_use which session is its own (a hint, see workroomCaller.ts).
      Object.assign(env,{[WORKROOM_SESSION_ENV]:summary.id,[WORKROOM_TARGET_ENV]:targetId});
      const record = {summary,cwd,inputRevision:0,chunks:[],next:0,buffered:0,decoder:new TextDecoder(),requestKeys:new Set<string>(),revalidate:target.revalidate,lastOutputAt:null,
        bypass,launchProfile:profile,launchModel:model,accountLaunch,historyEnv:env,conversationId:resume?.conversationId ?? (r.agent==='claude'?summary.id:undefined),firstRequest:prompt!==undefined,effort} as unknown as Session;
      // The headless copy also answers «what terminal are you» (DA) and cursor-position (CPR) queries — agy waits for DA,
      // Codex stops reading keys until CPR is answered (aiTerminalScreen.ts).
      try {record.screen=this.dependencies.headlessScreen===false?undefined:new AiTerminalScreen(r.cols!,r.rows!,undefined,data=>{try{if(record.summary.state!=='running')return;if(record.ptyInViewerPaste){const held=record.heldReplies??=[];held.push(data);if(held.length>8)held.shift();return;}record.child?.terminal?.write(data);}catch{}});} catch {record.screen=undefined;}
      const append = (text: string) => {
        if (text) record.lastOutputAt=this.#now();
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
      const args = [executable, ...(accountLaunch?.args ?? []), ...aiTerminalLaunchArgs(r.agent!, summary.id, prompt, bypass, resume, profile, codexHookTrust, effort.level ?? null, model, opsWorker && !previous)];
      // Only the account feature introduced an authentication await here. Legacy adapters without
      // account management keep their original checkout proof and admission timing.
      if (accountLaunch) {
        const freshTarget = target.revalidate ? await target.revalidate() : await this.dependencies.resolveTarget(targetId);
        if (realpathSync(freshTarget.cwd) !== cwd) throw new Error('프로젝트 경로가 변경되었습니다. 새 터미널을 여세요.');
        this.dependencies.accounts!.validateLaunch(accountLaunch.accountId);
      }
      if (this.#closed || this.#authorityLost(authority,epoch) || authority && r.accountId !== undefined && !authority.accountSelectionAllowed?.()) throw new Error('계정 선택 또는 터미널 권한이 해제되었습니다.');
      if (historyResume) {
        if (realpathSync(historyResume.cwd)!==cwd) throw new Error('원래 대화의 프로젝트가 변경되었습니다.');
        const proof=workroomSessionContext(summary,cwd,env,!!profile,resume?.conversationId);
        await historyResume.validate(proof);
        const fresh=target.revalidate?await target.revalidate():await this.dependencies.resolveTarget(targetId);
        const current=workroomSessionContext(summary,fresh.cwd,env,!!profile,resume?.conversationId);
        if(current.cwd!==cwd||current.targetFingerprint!==proof.targetFingerprint||current.accountFingerprint!==proof.accountFingerprint) throw new Error('대화 재개 준비 중 계정 또는 프로젝트가 변경되었습니다.');
        if(accountLaunch)this.dependencies.accounts!.validateLaunch(accountLaunch.accountId);
        if(this.#closed)throw new Error('터미널 서버가 종료 중입니다.');
      }
      if(authority?.validateTarget){const current=target.revalidate?await target.revalidate():await this.dependencies.resolveTarget(targetId);if(realpathSync(current.cwd)!==cwd)throw Error('업무 프로젝트가 변경되었습니다.');authority.validateTarget(targetId,cwd);if(this.#closed||this.#authorityLost(authority,epoch))throw Error('워크룸 실행 권한이 변경되었습니다.');}
      let eof!:()=>void;const streamEnded=new Promise<void>(resolve=>{eof=resolve});
      if(startGuard){
        const proof=workroomSessionContext(summary,cwd,env,!!profile,resume?.conversationId);
        const finalGuard=await startGuard(proof);
        if(this.#closed||this.#authorityLost(authority,epoch))throw Error('워크룸 시작 권한이 변경되었습니다.');
        const fresh=target.revalidate?await target.revalidate():await this.dependencies.resolveTarget(targetId);
        if(realpathSync(fresh.cwd)!==cwd)throw Error('워크룸 프로젝트가 변경되었습니다.');
        if(accountLaunch)this.dependencies.accounts!.validateLaunch(accountLaunch.accountId);
        finalGuard?.();
      }
      // Refresh only this managed skill before launching. A real executable may
      // create the CLI home under an existing safe .gemini even on its first run.
      if(r.agent==='agy' && /^agy(?:\.exe)?$/i.test(basename(executable)) && env.AGENTSTOZ_SKIP_OUTPUT_STYLE_SYNC!=='1') {
        try {
          if(statSync(executable).isFile()) {
            accessSync(executable, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
            reconcileAgyCliUnfinishedWork(env.HOME && isAbsolute(env.HOME) ? env.HOME : homedir(), {createCliHome:true});
          }
        } catch(error) { console.warn('[AgentsToZ] agy 스킬 맞춤 실패:', (error as Error)?.message ?? String(error)); }
      }
      historyResume?.launching();
      // A launch receipt crosses its write fence (prepared → write_started) here, right before the spawn: a crash
      // from now on reads as «unknown» and is never started again.
      launchStart?.started();
      const spawnChild=()=>spawn(args,{cwd,env,detached:true,terminal:{cols:r.cols,rows:r.rows,exit:()=>eof(),data:(_pty:Pty,data:Uint8Array)=>append(record.decoder.decode(data,{stream:true}))}});
      record.child=startEffectGate?startEffectGate(spawnChild):spawnChild();
      this.#sessions.set(summary.id,record);
      // Only a start that replaced a validated `previous` (same target, AI and folder) records a continuation.
      if(previous){this.#continuedBy.set(previous.summary.id,summary.id);while(this.#continuedBy.size>AI_TERMINAL_MAX_RETIRED_SESSIONS*4)this.#continuedBy.delete(this.#continuedBy.keys().next().value!);}
      record.activitySample={startedAt:this.#now()};
      this.#board.track(summary.id,{targetId,agent:r.agent!,turn:0,lastOutputAt:()=>record.lastOutputAt});
      // A first request travels with the spawn: the CLI is working on it from the start.
      if(prompt!==undefined)this.#board.apply(summary.id,{type:'submit',at:this.#now(),turn:0});
      this.#ensureSampler();
      const pid=record.child.pid;this.#sessionByPid.set(pid,summary.id);
      const unmapPid=()=>{if(this.#sessionByPid.get(pid)===summary.id)this.#sessionByPid.delete(pid);};
      if(profile)record.suppressMemoryOnExit=true;else this.#activity(cwd,r.agent!);
      record.finished=record.child.exited.then(async code => {
        // Process exit and PTY EOF are distinct. Drain its final screen before publishing exited.
        let timer:ReturnType<typeof setTimeout>|undefined;
        await Promise.race([streamEnded,new Promise(resolve=>{timer=setTimeout(resolve,1000)})]);clearTimeout(timer);
        append(record.decoder.decode());record.exitedAt=new Date().toISOString();summary.state='exited';summary.exitCode=code;unmapPid();record.child.terminal.close();this.#forgetSessionRequests(record);
        this.#board.apply(summary.id,{type:'exit',at:this.#now(),turn:record.inputRevision,code,cause:record.exitCause??'exit'});this.dependencies.turnSignals?.forget(summary.id);try{await this.dependencies.threadEnded?.(summary.id);}catch{}
        if(!record.suppressMemoryOnExit)this.#activity(cwd,record.summary.agent);
        try {this.#remember(record);} catch { /* Explicit close can retry durable enqueue. */ }
        // An exit our own shutdown caused is not an end of the conversation (w14, R1): the row stays `running` and the
        // next boot offers to reopen it. Recording it here raced the 200 ms shutdown wait — a CLI that left in time read
        // 「종료됨」, one that needed SIGKILL read 「재시작 전」. The shutdown already captured its binding while it ran.
        if(record.exitCause!=='shutdown')try {await this.dependencies.history?.ended(this.#historyContext(record));} catch { /* Existing terminal exit remains authoritative. */ }
      },async()=>{record.exitedAt=new Date().toISOString();summary.state='exited';summary.exitCode=-1;unmapPid();record.child.terminal.close();this.#forgetSessionRequests(record);
        this.#board.apply(summary.id,{type:'exit',at:this.#now(),turn:record.inputRevision,code:-1,cause:record.exitCause??'exit'});this.dependencies.turnSignals?.forget(summary.id);try{await this.dependencies.threadEnded?.(summary.id);}catch{}if(record.exitCause!=='shutdown')try{await this.dependencies.history?.ended(this.#historyContext(record));}catch{}});
      // Pruned sessions stay readable as retired (exited, last output) for a late read or wait.
      for (const [id,old] of this.#sessions) if (this.#sessions.size>24 && old.summary.state==='exited') {old.screen?.dispose();this.#sessions.delete(id);this.#scheduleRestorations.delete(id);this.#retire(old);this.#board.forget(id);}
      if(this.dependencies.history){
        try {this.dependencies.history.started(this.#historyContext(record),historyResume?.logicalConversationId,previous&&resume?previous.summary.id:undefined);}
        catch(error){if(historyResume)throw error;}
      }
      return {session:this.#summary(record),...(previous?{resumed:!!resume}:{})};
    }
    if(r.operation==='submission'){
      if(!this.#submissions)throw Error('이 호스트는 전체 요청 제출을 지원하지 않습니다. 앱을 업데이트하세요.');
      if(r.expectedInputRevision!==undefined&&r.expectedInputRevision!==session!.inputRevision)throw Error('워크룸 입력이 변경되었습니다. 음성 초안을 다시 확인하세요.');
      const binding=createHash('sha256').update(JSON.stringify([session!.cwd,session!.summary.targetId,session!.summary.accountId??'host-default',session!.accountLaunch?.env??null])).digest('hex');
      // Phone attachment ids are checked before anything is prepared — unless this id already has a receipt: a replay
      // returns that receipt unchanged, even after the ids expired.
      this.#checkAttachmentsAtBegin(r.submission!,{owner:receiptOwner,sessionId:session!.summary.id},authority,receiptOwner,session!.summary.targetId);
      const receipt=await this.#submissions.perform(r.submission!,{owner:receiptOwner,sessionId:session!.summary.id,targetId:session!.summary.targetId,binding,revision:session!.inputRevision},r.references??[],async(data,start,references,meta)=>{
        await this.#mutate({operation:'input',requestId:r.requestId,sessionId:r.sessionId,data,expectedInputRevision:session!.inputRevision,...(references.length?{references:[...references]}:{})},session,authority,epoch,undefined,undefined,start,receiptOwner,skipCorrections,undefined,meta.attachments,undefined,undefined,undefined,beforeInput,writeEffectGate);
      });
      return {session:this.#summary(session!),submission:receipt};
    }
    {
      if (session!.summary.state !== 'running') throw new Error('종료된 터미널입니다. 새 세션을 여세요.');
      if (r.operation === 'input' && r.expectedInputRevision !== undefined && r.expectedInputRevision !== session!.inputRevision) throw new Error('워크룸 입력이 변경되었습니다. 음성 초안을 다시 확인하세요.');
      if (r.operation === 'input') {
        // Esc is the explicit cancel path while native effort control is waiting; it must not queue behind that submission.
        if(!submissionWrite&&!(session!.effort?.automaticPending&&r.data==='\x1b'))this.#submissions?.assertRawAllowed(session!.summary.id);
        // The host screen answers DA and cursor-position queries itself; a viewer's forwarded answer is a duplicate.
        // The stream state is filtered on a copy and kept only once these bytes are written (or there is nothing to write):
        // a request refused below must not leave the filter believing a paste opened or closed.
        const filterState:ViewerReplyFilterState={...(session!.viewerPaste??{pasteOpen:false})};
        const typed=session!.screen?stripViewerTerminalReplies(r.data!,filterState,{ambiguousIsReply:session!.summary.agent==='codex'||session!.screen.answeredPlainCursorRecently()}):r.data!;
        if(!typed){if(session!.screen)session!.viewerPaste=filterState;return {session:this.#summary(session!)};}
        // Phone attachments (w13): the ids are leased (owner, project, expiry, files on disk) and pinned until the write is
        // done; the host builds the block from them. The phone's own text never carries one.
        const lease=remoteAttachmentIds?.length&&submissionWrite?this.#leaseAttachments(remoteAttachmentIds,typed,authority,receiptOwner,session!.summary.targetId):undefined;
        try{
          const enter=typed.endsWith('\r')?'\r':'';
          const base=lease?workroomAttachmentMessage(enter?typed.slice(0,-1):typed,lease.images,lease.files)+enter:typed;
          let data=r.references?await this.#withReferences(base,r.references,authority,cwd):base;
          const correction=submissionWrite&&!skipCorrections?await this.dependencies.corrections?.(cwd,session!.summary.targetId,typed)??null:null;
          if(correction)data=withSuffixBeforeWorkroomAttachments(data,'  '+correction.text.replace(/[\r\n\t]+/g,' '));
          if(submissionWrite&&Buffer.byteLength(data)>24_000)throw Error(lease?'첨부 경로·참고 프로젝트를 포함한 요청이 24,000바이트를 넘습니다. 글을 줄이세요. 작성 내용은 유지했습니다.':'참고 프로젝트를 포함한 요청이 24,000바이트를 넘습니다.');
          // Decided here, not by each caller, so the Workroom UI, voice and agentstoz_use paths paste alike.
          let bracketedPaste=aiTerminalPasteCandidate(data)&&!!session!.screen&&(await session!.screen.settledModes()).bracketedPaste;
          if(submissionWrite&&data.includes('\n')&&!bracketedPaste)throw Error('터미널이 여러 줄 요청을 받을 준비가 되지 않았습니다. 작성 내용은 유지했으니 입력 준비 후 다시 보내세요.');
          // Both waits above can outlast a revoked grant or a closed connection; check again right before the write.
          if (this.#authorityLost(authority, epoch)) throw new Error('원격 터미널 권한이 해제되었습니다.');
          if (this.#closed) throw new Error('터미널 서버가 종료 중입니다.');
          if (session!.closing || session!.summary.state !== 'running') throw new Error('터미널이 종료 중이거나 종료되었습니다.');
          // Images ride a submission from this Mac only, and each named file is checked last, right before the write.
          // Only the trailing block the composer writes is an attachment; a header merely quoted in the text (malformed,
          // mid-text) is plain text from any sender, as it is on the raw path.
          const block=submissionWrite&&!lease?splitWorkroomAttachmentBlock(typed.endsWith('\r')?typed.slice(0,-1):typed):null;
          if(block){
            if(authority||receiptOwner!=='local')throw new Error(REMOTE_TEXT_BLOCK_REFUSAL);
            if(!this.dependencies.submissionAttachments)throw new Error('이 호스트는 첨부 이미지·파일을 확인할 수 없습니다. 작성 내용은 유지했습니다.');
            this.dependencies.submissionAttachments(block.paths,block.files??[]);
          }
          correction?.validate();
          // Last look before the write fence: every leased file is still this app's own regular file.
          lease?.recheck();
          if(submissionWrite&&!beforeInput&&!workroomEffortInputIsManual(session!.summary.agent,typed))await this.#adjustEffort(session!,typed,()=>{
            if(this.#closed||session!.closing||session!.summary.state!=='running'||this.#authorityLost(authority,epoch))return false;
            try{authority?.validateTarget?.(session!.summary.targetId,cwd);}catch{return false;}
            return true;
          });
          if(submissionWrite&&session!.screen)bracketedPaste=aiTerminalPasteCandidate(data)&&(await session!.screen.settledModes()).bracketedPaste;
          const threadWritten=(submissionWrite||workroomInputIsRequest(typed))?await this.dependencies.threadInput?.(session!.summary.id,typed,session!.inputRevision+1):undefined;
          await beforeInput?.();
          const changesConversation=session!.summary.agent==='claude'&&typed.endsWith('\r')&&claudeInputChangesConversation(typed,await session!.screen?.plainRows());
          if(this.#closed||session!.closing||session!.summary.state!=='running'||this.#authorityLost(authority,epoch))throw Error('워크룸 입력 권한 또는 연결이 변경되었습니다.');
          authority?.validateTarget?.(session!.summary.targetId,cwd);
          correction?.validate();lease?.recheck();
          submissionWrite?.(correction?.exposure);
          if(changesConversation)session!.conversationId=undefined;
          lease?.consume();
          session!.suppressMemoryOnExit=!!session!.launchProfile;session!.inputRevision++;
          // The first input of a session started without a request is a durable fact of the history (w14).
          if(session!.inputRevision===1&&!session!.firstRequest)try{this.dependencies.history?.input?.(session!.summary.id);}catch{/* history is advisory */}
          if(session!.screen)session!.viewerPaste=filterState;
          // After the body is written the CLI is (or is no longer) inside a viewer's paste; answers held meanwhile follow it.
          const written=()=>{const s=session!;s.ptyInViewerPaste=!!s.viewerPaste?.pasteOpen;if(s.ptyInViewerPaste||!s.heldReplies?.length)return;const held=s.heldReplies;s.heldReplies=[];for(const reply of held)s.child.terminal.write(reply);};
          await writeAiTerminalInput(session!.summary.agent,session!.child.terminal,data,{bracketedPaste},written,!!submissionWrite,()=>!this.#closed&&!session!.closing&&session!.summary.state==='running'&&!this.#authorityLost(authority,epoch),writeEffectGate);
          // A request is a whole-request submission or text ended by Enter; any other input — a lone Enter included — is a
          // keystroke (it answers a menu, confirms a popup or edits the CLI's own line).
          this.#board.apply(session!.summary.id,{type:submissionWrite||workroomInputIsRequest(typed)?'submit':'keys',at:this.#now(),turn:session!.inputRevision});
          // 「에포트 자동」 (w16): the person's own /effort or /model stops auto for this session; a whole request (not an
          // instruction another AI composed) may record advice on older boolean-only stores. Runtime control happens before the write fence.
          if(session!.effort)try{
            if(workroomEffortInputIsManual(session!.summary.agent,typed)){session!.effort.manual=true;session!.effort.advice=undefined;}
            else if(submissionWrite&&!skipCorrections&&!this.dependencies.effortAuto?.getMode)noteWorkroomEffortRequest(session!.effort,session!.summary.agent,typed,this.#effortAuto(),new Date().toISOString());
          }catch{/* advisory */}

          if(threadWritten)try{await threadWritten();}catch{/* The durable submission receipt remains authoritative; never repeat a written input. */}
          if(!session!.launchProfile)this.#activity(cwd,session!.summary.agent);
        }finally{lease?.release();}
      }
      else {session!.child.terminal.resize(r.cols!,r.rows!);session!.screen?.resize(r.cols!,r.rows!);session!.summary.cols=r.cols!;session!.summary.rows=r.rows!;}
    }
    return {session:this.#summary(session!)};
  }
  /** A new session's first request as a whole-request submission. The receipt fences the spawn exactly like an input
   *  submission fences its PTY write; the start itself runs the ordinary start path with all of its guards. */
  async #launchSubmission(r:AiTerminalRequest,authority:AiTerminalAuthority|undefined,epoch:number|undefined,receiptOwner:string):Promise<AiTerminalResponse>{
    if(!this.#submissions)throw Error('이 호스트는 전체 요청 제출을 지원하지 않습니다. 앱을 업데이트하세요.');
    const context=this.#submissions.launchContext(r.submission!,receiptOwner);
    if(authority&&!authority.targets.has(context.targetId))throw new Error('이 원격 연결에 등록된 프로젝트가 아닙니다.');
    this.#checkAttachmentsAtBegin(r.submission!,{owner:receiptOwner,sessionId:'',scope:WORKROOM_LAUNCH_SCOPE},authority,receiptOwner,context.targetId);
    const receipt=await this.#submissions.perform(r.submission!,context,r.references??[],async(text,start,references,meta)=>{
      const launch=meta.launch;
      if(!launch)throw new Error('새 세션 시작 정보가 없습니다. 작성 내용은 유지했습니다.');
      if(launch.bypassPermissions&&!authority&&receiptOwner!=='local')throw new Error('다른 기기에서는 권한 우회나 다시 시작으로 세션을 열 수 없습니다. 세션을 열 기기 앞에서 직접 여세요.');
      // Phone attachments (w13): the host builds the first request's block from the leased ids, re-checks them at the
      // spawn fence and consumes them once the fence is crossed.
      const lease=meta.attachments?.length?this.#leaseAttachments(meta.attachments,text,authority,receiptOwner,launch.targetId):undefined;
      try{
        const prompt=lease?workroomAttachmentMessage(text.slice(0,-1),lease.images,lease.files):text.slice(0,-1);
        if(lease&&aiInitialPromptError(prompt))throw new Error('첨부 경로까지 합쳐 24,000바이트를 넘습니다. 글을 줄이세요. 작성 내용은 유지했습니다.');
        // Validated exactly as a `start` with a first request would be.
        const startRequest=normalizeAiTerminalRequest({operation:'start',requestId:r.requestId,targetId:launch.targetId,agent:launch.agent,cols:launch.cols,rows:launch.rows,
          ...(launch.bypassPermissions!==undefined?{bypassPermissions:launch.bypassPermissions}:{}),prompt,...(references.length?{references:[...references]}:{})});
        await this.#mutate(startRequest,null,authority,epoch,undefined,undefined,undefined,receiptOwner,false,{sessionId:meta.sessionId,started:()=>{lease?.recheck();start();lease?.consume();}});
      }finally{lease?.release();}
    });
    const launched=receipt.sessionId?this.#sessions.get(receipt.sessionId):undefined;
    return {submission:receipt,...(launched&&(!authority||authority.targets.has(launched.summary.targetId))?{session:this.#summary(launched)}:{})};
  }
  /**
   * w13: phone attachment ids on a begin/single. Only a phone with a remote authority sends them (this Mac's own composer
   * and another community Mac never do); every id must be this receipt owner's, this project's and unexpired. Skipped
   * when the id already has a receipt — the host's journal then answers the replay.
   */
  #checkAttachmentsAtBegin(command:import('./workroomSubmissionProtocol').WorkroomSubmissionCommand,context:{owner:string;sessionId:string;scope?:string},authority:AiTerminalAuthority|undefined,receiptOwner:string,targetId:string){
    if(command.phase!=='begin'&&command.phase!=='single')return;
    const ids=command.attachments;
    if(!ids?.length||this.#submissions?.find(command.id,context))return;
    this.#attachmentSender(authority,receiptOwner).check(ids,{owner:receiptOwner,targetId});
  }
  #attachmentSender(authority:AiTerminalAuthority|undefined,receiptOwner:string):AiTerminalRemoteAttachments{
    if(!authority||receiptOwner==='local'||/^community(?::|$)/.test(receiptOwner))throw new Error('휴대폰 첨부는 그 휴대폰에서 보낸 요청에만 넣을 수 있습니다. 작성 내용은 유지했습니다.');
    if(!this.dependencies.remoteAttachments)throw new Error('이 Mac은 휴대폰 첨부를 받을 수 없습니다. Mac 앱을 업데이트하세요. 작성 내용은 유지했습니다.');
    return this.dependencies.remoteAttachments;
  }
  #leaseAttachments(ids:readonly string[],text:string,authority:AiTerminalAuthority|undefined,receiptOwner:string,targetId:string){
    const sender=this.#attachmentSender(authority,receiptOwner);
    if(splitWorkroomAttachmentBlock(text.endsWith('\r')?text.slice(0,-1):text))throw new Error(REMOTE_TEXT_BLOCK_REFUSAL);
    return sender.lease(ids,{owner:receiptOwner,targetId});
  }
  /** `#` references: the client names opaque ids, the host resolves and verifies each folder
   * with the same registration and authority checks as a start. One line, before Enter,
   * so no embedded newline can submit the prompt early. */
  async #withReferences(data:string,references:readonly string[],authority:{targets?:ReadonlySet<string>}|undefined,cwd:string):Promise<string> {
    const entries:string[]=[];
    for(const id of references){
      const use = parseUseReferenceId(id), projectId = use?.targetId ?? id;
      if(authority?.targets&&!authority.targets.has(projectId))throw new Error('참고할 프로젝트에 대한 권한이 없습니다.');
      let folder:string;
      try{
        if(use&&!this.dependencies.resolveUseReference)throw Error('USE 참고를 지원하지 않습니다.');
        const target=use?await this.dependencies.resolveUseReference!(use.targetId,use.serviceKey):await this.dependencies.resolveTarget(id);
        folder=realpathSync(target.cwd);if(!isAbsolute(folder)||!statSync(folder).isDirectory())throw new Error('not a folder');
      }
      catch{throw new Error('참고할 프로젝트를 찾지 못했습니다. 프로젝트 목록을 새로고침하세요.');}
      if(folder!==cwd)entries.push(`${use ? 'USE 운영기억 · 실행 없이 읽기 전용 참고' : basename(folder)}=${folder}`);
    }
    if(!entries.length)return data;
    // Before any image block: an attached path stays alone on its line.
    return withSuffixBeforeWorkroomAttachments(data,` (참고 프로젝트 · 읽어서 참고만 하고 수정은 현재 프로젝트에서: ${entries.join('; ')})`);
  }
  async shutdown() {
    this.#closed=true;this.#remote.clear();
    if(this.#sampler){clearInterval(this.#sampler);this.#sampler=undefined;}
    for(const s of this.#sessions.values())if(s.summary.state==='running')s.exitCause??='shutdown';
    this.#board.release();
    this.#submissions?.close();
    // Capture the exact provider binding while its process still owns its files.
    if(this.dependencies.history)await Promise.allSettled(this.historySessions().map(context=>this.dependencies.history!.ended(context)));
    for(const s of this.#sessions.values()) {try {this.#remember(s);} catch { /* Never prevent process cleanup. */ }}
    for (const s of this.#sessions.values()) if(s.summary.state==='running') this.#signal(s,'SIGTERM');
    await new Promise(resolve=>setTimeout(resolve,200));
    for (const s of this.#sessions.values()) if(s.summary.state==='running') {this.#signal(s,'SIGKILL');s.child.terminal.close();}
    for (const s of this.#sessions.values()) s.screen?.dispose();
  }
}
