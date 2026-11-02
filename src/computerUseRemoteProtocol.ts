import {
  COMMUNITY_CONTROL_EXECUTE_TIMEOUT_MESSAGE,
  COMMUNITY_CONTROL_RESPONSE_TOO_LARGE_MESSAGE,
  OPS_REQUEST_LEGACY_UNSUPPORTED_MESSAGE,
} from './opsRequestProtocol';
import {REMOTE_CONTROL_RELAY_P256_PUBLIC_KEY_BYTES,decodeRemoteControlRelayBase64Url} from './remoteControlRelayContract';

/**
 * Computer use between community Macs, without a Workroom (feature 1,
 * docs/design/remote-computer-use-2026-11-01/DESIGN.md §8). A Mac's AI drives another Mac through the community control
 * mailbox under the new kind `computer-use`; the other Mac runs it with its own ComputerUseRuntime and its own Control.
 *
 * This module is the shared wire contract: the closed envelope shapes, limits, error codes with their fixed sentences,
 * the mapping of an older receiver's sentences, and the receipt verdict (§7.8). It is pure — no Node built-ins — because
 * the MCP process, both sidecars and the panel read it. Sealing lives in `computerUseRemoteCrypto.ts`.
 */

export const COMPUTER_USE_REMOTE_KIND='computer-use' as const;
export const COMPUTER_USE_REMOTE_VERSION=1 as const;
export const COMPUTER_USE_REMOTE_OPS=['hello','call','part','heartbeat','disconnect'] as const;
export type ComputerUseRemoteOp=typeof COMPUTER_USE_REMOTE_OPS[number];
/** The ops whose request carries a sealed box. `hello` carries a public key and `part` a reference, nothing secret. */
export const COMPUTER_USE_REMOTE_SEALED_OPS=['call','heartbeat','disconnect'] as const;
export type ComputerUseRemoteSealedOp=typeof COMPUTER_USE_REMOTE_SEALED_OPS[number];
/** The sender's own claim (bound into the AAD). A receiver refuses anything but darwin (RC-19, D10): an untested path, not forgery. */
export const COMPUTER_USE_REMOTE_PLATFORMS=['darwin','win32','other'] as const;
export type ComputerUseRemotePlatform=typeof COMPUTER_USE_REMOTE_PLATFORMS[number];
export function computerUseRemotePlatform(platform:string):ComputerUseRemotePlatform{
  return platform==='darwin'||platform==='win32'?platform:'other';
}

/** Every bound of §8.7 in one place, so the sender, the receiver and the tests read the same numbers. */
export const COMPUTER_USE_REMOTE_LIMITS={
  /** Mailbox waits of one hop. The control channel's own default is 20 s (src/agentDialogueHost.ts). */
  helloTimeoutMs:15_000,callTimeoutMs:20_000,partTimeoutMs:8_000,
  /** The sender's whole remote route, and the MCP fetch around it. Short of time: no call is sent (REMOTE_SESSION_PENDING). */
  routeBudgetMs:40_000,mcpFetchMs:45_000,
  /** The receiver answers a row within this after taking it, so the answer lands inside the sender's 20 s. */
  receiverAnswerMs:15_000,
  /** RC-6, judged on the receiver's clock when execution starts: 20 s sender deadline − 5 s skew > 12 s. 5 s = Control `skewMs`. */
  staleAfterMs:12_000,futureSkewMs:5_000,
  /** Remote sessions on a receiver: per sending device and in total (inside the runtime's 64 connections). */
  sessionsPerDevice:4,sessionsTotal:16,
  helloPerDevicePerMinute:4,
  requestAccessIntervalMs:10_000,
  /** The receiver's one execution lane (Control serves one request at a time). Over it: not-run(busy) at once. */
  laneDepth:8,lanePerDevice:4,
  /** Sender rows per target device: awaiting an answer, and unanswered in ten minutes (the mailbox allows 64 per endpoint). */
  awaitingRowsPerDevice:8,unansweredRowsPerDevice:24,unansweredWindowMs:600_000,
  /** An awaiting slot frees after this even without an answer (the live inbox window may be two minutes). */
  awaitingReleaseMs:130_000,
  captureIntervalMs:2_000,captureBytesPerMinute:6*1024*1024,
  heartbeatForwardMs:25_000,heartbeatIdleStopMs:600_000,
  /** RC-16 memory: the receiver keeps settled ledger entries at least this long; the sender closes at sentAt + 10 min. */
  ledgerRetentionMs:900_000,ledgerPerConnection:1024,senderLedgerWindowMs:600_000,bindingTtlMs:900_000,
  lateAnswersPerSession:8,lateAnswerMemoryMs:600_000,
  disconnectBlockMs:1_800_000,noticeGroupMs:300_000,
  partCacheMs:15_000,partCacheBytes:8*1024*1024,
  /** Plaintext frame: u32be metaLen ‖ meta JSON ‖ optional binary attachment (a JPEG's own bytes). */
  requestFrameMaxBytes:16_000,metaMaxBytes:60_000,attachmentMaxBytes:240_000,
  /** A sealed reply over one part is split; the worst case (4 + 60,000 + 240,000 bytes) is 400,028 characters → two parts. */
  partMaxChars:210_000,partsMax:2,
  /** The mailbox table's own checks (src/agentDialogueSql.ts): octet_length of the jsonb text. */
  mailboxRequestMaxBytes:65_536,mailboxResponseMaxBytes:262_144,
  remoteAppNameMaxChars:80,
} as const;

/** AES-GCM adds a 16-byte tag; the box is standard padded base64 of ciphertext ‖ tag. */
export const COMPUTER_USE_REMOTE_TAG_BYTES=16;
export function computerUseRemoteBoxChars(plaintextBytes:number):number{
  return 4*Math.ceil((plaintextBytes+COMPUTER_USE_REMOTE_TAG_BYTES)/3);
}
/** The largest box a request may carry: a full 16,000-byte call frame. */
export const COMPUTER_USE_REMOTE_REQUEST_BOX_MAX_CHARS=computerUseRemoteBoxChars(COMPUTER_USE_REMOTE_LIMITS.requestFrameMaxBytes);
export const COMPUTER_USE_REMOTE_REPLY_FRAME_MAX_BYTES=4+COMPUTER_USE_REMOTE_LIMITS.metaMaxBytes+COMPUTER_USE_REMOTE_LIMITS.attachmentMaxBytes;

/** Operations a remote AI may put in a call box: only agent operations, never management (RC-3). */
export const COMPUTER_USE_REMOTE_CALL_OPERATIONS=['scope-status','scope-request-access','scope-observe','scope-capture','scope-click','scope-type-text',
  'scope-key','scope-scroll','scope-drag','scope-focus-app','scope-receipt','scope-request-human'] as const;
export type ComputerUseRemoteCallOperation=typeof COMPUTER_USE_REMOTE_CALL_OPERATIONS[number];
/** RC-6: everything that changes state on the receiver. A late one is never started. */
export const COMPUTER_USE_REMOTE_STATE_CHANGING_OPERATIONS:readonly ComputerUseRemoteCallOperation[]=['scope-request-access','scope-request-human',
  'scope-click','scope-type-text','scope-key','scope-scroll','scope-drag','scope-focus-app'];
/** RC-7/RC-8: inputs carry a requestId. An unknown outcome of one blocks further input to that device until its receipt settles. */
export const COMPUTER_USE_REMOTE_INPUT_OPERATIONS:readonly ComputerUseRemoteCallOperation[]=['scope-click','scope-type-text','scope-key',
  'scope-scroll','scope-drag','scope-focus-app'];
export const isComputerUseRemoteStateChange=(operation:unknown)=>(COMPUTER_USE_REMOTE_STATE_CHANGING_OPERATIONS as readonly unknown[]).includes(operation);
export const isComputerUseRemoteInput=(operation:unknown)=>(COMPUTER_USE_REMOTE_INPUT_OPERATIONS as readonly unknown[]).includes(operation);
/** Operations that change nothing on the receiver the AI acts on. `hello` and `heartbeat` are envelope ops (RC-9, §7.8-10). */
const COMPUTER_USE_REMOTE_READ_OPERATIONS:readonly unknown[]=['scope-status','scope-observe','scope-capture','scope-receipt','hello','heartbeat'];
/**
 * What a request may change on the receiver — this decides how an open outcome is read (§7.8-1, RC-6, RC-7):
 * - `input` (click, type-text, key, scroll, drag, focus-app): carries a requestId. An open outcome is `unknown`: it blocks
 *   further input to that device and is settled only by its receipt.
 * - `state-change` (request-access, request-human; and the envelope op `disconnect`): changes the receiver's grant or session
 *   with no requestId and no receipt — a grant may have opened (request-access) or been halted (request-human). An open
 *   outcome is `state-unknown`: nothing is resent automatically, no input is blocked, and the AI reads status to learn it.
 * - `read` (status, observe, capture, receipt; the envelope ops `hello` and `heartbeat`): changes nothing the AI acts on.
 * An operation not listed here is read as an input: an unknown request is never reported as having changed nothing.
 */
export type ComputerUseRemoteEffect='input'|'state-change'|'read';
export function computerUseRemoteEffect(operation:unknown):ComputerUseRemoteEffect{
  if(COMPUTER_USE_REMOTE_READ_OPERATIONS.includes(operation))return 'read';
  if(operation==='disconnect'||isComputerUseRemoteStateChange(operation)&&!isComputerUseRemoteInput(operation))return 'state-change';
  return 'input';
}

/**
 * RC-6 on the receiver's clock at the moment execution starts (not when the row was taken): older than 12 s, or more than
 * 5 s in the future, is never started. The boundaries themselves still run.
 */
export function computerUseRemoteSentAtCheck(sentAt:number,now:number):'ok'|'stale'|'clock'{
  if(!Number.isSafeInteger(sentAt)||!Number.isFinite(now))return 'clock';
  if(sentAt-now>COMPUTER_USE_REMOTE_LIMITS.futureSkewMs)return 'clock';
  if(now-sentAt>COMPUTER_USE_REMOTE_LIMITS.staleAfterMs)return 'stale';
  return 'ok';
}

// ── Error codes and their fixed sentences (§10) ─────────────────────────────────────────────────────────────────────
/**
 * - `not-run`: certainly not executed.
 * - `unknown`: an input whose outcome is open — never resend it; it blocks further input to that device until its receipt
 *   settles.
 * - `state-unknown`: a request-access or request-human (or a disconnect) whose outcome is open — a grant may have opened or
 *   been halted. It has no requestId and no receipt and blocks no input; nothing is resent automatically, and the AI reads
 *   status before deciding.
 * - `read`: a read failed; nothing changed and the AI may read again.
 * `computerUseRemoteEffect` decides which open outcome a request gets. D11 (2026-11-01, the person: 「처음부터 전부 허용」):
 * there is no REMOTE_POINTER_DISABLED — remote right/double click, scroll and drag follow the same rules as local input.
 */
export type ComputerUseRemoteOutcome='not-run'|'unknown'|'state-unknown'|'read';
const ERRORS={
  REMOTE_DEVICE_UNKNOWN:{outcome:'not-run',message:'그 기기를 커뮤니티에서 찾지 못했습니다. devices로 다시 고르세요.'},
  REMOTE_SELF:{outcome:'not-run',message:'이 Mac은 device 없이 쓰세요.'},
  REMOTE_PROFILE_REQUIRED:{outcome:'not-run',message:'이 Mac의 공유 총괄 폴더 연결이 필요합니다(아젠투지 설정).'},
  REMOTE_NOT_IN_COMMUNITY:{outcome:'not-run',message:'두 Mac이 같은 커뮤니티에 있지 않습니다.'},
  REMOTE_HOST_OUTDATED:{outcome:'not-run',message:'그 기기의 AgentsToZ를 업데이트하세요(Windows라면 아직 지원하지 않습니다).'},
  REMOTE_UNSUPPORTED:{outcome:'not-run',message:'그 기기에서는 컴퓨터 유즈를 받을 수 없습니다(macOS 설치 앱 + Control 필요).'},
  REMOTE_SENDER_UNSUPPORTED:{outcome:'not-run',message:'Mac에서 보낸 요청만 받습니다.'},
  REMOTE_BLOCKED_BY_PERSON:{outcome:'not-run',message:'그 Mac에서 다른 Mac의 AI를 막아 두었습니다(사람의 설정).'},
  REMOTE_DEVICE_BLOCKED:{outcome:'not-run',message:'그 Mac의 사람이 이 기기(또는 이 연결)를 막았습니다.'},
  REMOTE_NEEDS_STANDING:{outcome:'not-run',message:'그 Mac의 Control에서 사람이 상시 허용을 켜야 합니다(그 Mac 앞 또는 원격 데스크톱, 암호 가능).'},
  REMOTE_APP_SCOPE_ACTIVE:{outcome:'not-run',message:'그 Mac은 지금 한 앱만 허용돼 있어 다른 Mac의 AI는 쓸 수 없습니다.'},
  REMOTE_PEER_NOT_READY:{outcome:'not-run',message:'그 Mac이 지금 승인할 수 없는 상태입니다(잠김·보안 입력·권한 꺼짐일 수 있음). 원격 AI는 풀 수 없습니다.'},
  REMOTE_RECOVERY_REQUIRED:{outcome:'not-run',message:'그 Mac의 컴퓨터 유즈 패널에서 사람이 검토해야 다시 씁니다(그 Mac 앞·원격 데스크톱·Viewer). 그동안 그 Mac의 AI도 멈춥니다. 같은 동작을 다시 보내지 마세요.'},
  REMOTE_NO_ANSWER:{outcome:'read',message:'그 Mac이 답하지 않습니다. 켜져 있는지, AgentsToZ가 실행 중인지, 공유 총괄 폴더 연결이 살아 있는지 확인하세요.'},
  REMOTE_BAD_ANSWER:{outcome:'read',message:'그 Mac의 답을 확인하지 못했습니다. 상태를 다시 읽으세요.'},
  REMOTE_UNKNOWN_OUTCOME:{outcome:'unknown',message:'결과를 모릅니다. 자동으로 다시 보내지 않았습니다. 같은 device·requestId로 receipt를 보세요. 새 requestId로 다시 보내지 마세요.'},
  REMOTE_STATE_UNKNOWN:{outcome:'state-unknown',message:'그 Mac에서 이 요청이 처리됐는지 모릅니다(허용이 열렸거나 멈췄을 수 있습니다). 자동으로 다시 보내지 않았습니다. status로 그 Mac의 상태를 읽은 뒤 정하세요.'},
  REMOTE_BLOCKED_BY_UNKNOWN:{outcome:'not-run',message:'앞선 동작의 결과를 모르는 동안 그 Mac에 새 입력을 보내지 않습니다. 같은 device·requestId로 receipt를 보세요.'},
  REMOTE_ID_BOUND_ELSEWHERE:{outcome:'not-run',message:'이 requestId(grant)는 다른 곳에 묶여 있습니다. 그 device에서 확인하세요.'},
  REMOTE_SESSION_RESTARTED:{outcome:'not-run',message:'그 Mac의 AgentsToZ가 다시 시작돼 이 입력은 보내지 않았습니다. observe부터 다시 하세요.'},
  REMOTE_SESSION_MISSING:{outcome:'not-run',message:'그 Mac에 이 연결의 세션이 없어 실행하지 않았습니다(다시 시작됐거나 연결이 끝났습니다).'},
  REMOTE_SESSION_PENDING:{outcome:'not-run',message:'연결을 준비하느라 보내지 않았습니다. 다시 observe한 뒤 보내세요.'},
  REMOTE_NOT_RUN:{outcome:'not-run',message:'실행하지 않았습니다. observe로 화면을 본 뒤 새 requestId로 보내세요.'},
  REMOTE_PART_LOST:{outcome:'read',message:'이미지 일부를 받지 못했습니다 — capture 또는 observe를 다시 하세요.'},
  REMOTE_LOOP_TARGET:{outcome:'not-run',message:'다른 Mac의 AI는 그 Mac의 터미널·AI 앱·스크립트 도구·원격 데스크톱 앱에 입력하지 않습니다.'},
  REMOTE_DESKTOP_CLIENT:{outcome:'not-run',message:'원격 데스크톱 앱에는 AI가 입력하지 않습니다(다른 기기로 사람처럼 들어가게 됩니다).'},
  REMOTE_CHAIN_DENIED:{outcome:'not-run',message:'다른 Mac이 이 Mac을 쓰는 동안에는 여기서 또 다른 Mac을 쓸 수 없습니다.'},
  REMOTE_RATE_LIMITED:{outcome:'not-run',message:'요청이 많습니다. 잠시 뒤 하세요.'},
  REMOTE_BAD_REQUEST:{outcome:'not-run',message:'요청 형식을 확인하지 못해 그 Mac이 실행하지 않았습니다.'},
} as const satisfies Record<string,{outcome:ComputerUseRemoteOutcome;message:string}>;
export type ComputerUseRemoteErrorCode=keyof typeof ERRORS;
export const COMPUTER_USE_REMOTE_ERRORS:Readonly<Record<ComputerUseRemoteErrorCode,{readonly outcome:ComputerUseRemoteOutcome;readonly message:string}>>=ERRORS;
export const COMPUTER_USE_REMOTE_ERROR_CODES=Object.keys(ERRORS) as ComputerUseRemoteErrorCode[];

/** The sentence for an open receipt that could not be settled in the end (§7.8-7). */
export const COMPUTER_USE_REMOTE_UNKNOWN_FINAL_MESSAGE='끝내 확인하지 못했습니다. 같은 동작을 다시 보내지 말고 observe로 그 Mac 화면을 본 뒤, 필요하면 사람에게 알리세요.';
/** §7.8-3/11: an ID this connection never sent to that device is not asked about; it may be another connection's. */
export const COMPUTER_USE_REMOTE_NOT_THIS_CONNECTION_MESSAGE='이 연결이 보낸 요청이 아니라 확인할 수 없습니다(unknown-final). 같은 동작을 다시 보내지 말고 observe로 그 Mac 화면을 보세요.';
/**
 * The mailbox poll's own answer when its 60 s budget ran out before a row (src/agentDialogueHost.ts, controlPoll). The row
 * was taken and never executed. Pinned here and by a test against that file: a sender recognises it by its exact text.
 */
export const COMMUNITY_CONTROL_POLL_BUSY_MESSAGE='상대 기기가 바빠 이 요청을 실행하지 않았습니다. 다시 시도하세요.';

export class ComputerUseRemoteError extends Error {
  readonly outcome:ComputerUseRemoteOutcome;
  constructor(readonly code:ComputerUseRemoteErrorCode,message:string=ERRORS[code].message){
    super(message);this.name='ComputerUseRemoteError';this.outcome=ERRORS[code].outcome;
  }
}
const requestIdPattern=/^[A-Za-z0-9_-]{8,128}$/;
/** Text that names only an ID the AI itself chose (checked), never anything read off a screen. */
export function computerUseRemoteErrorMessage(code:ComputerUseRemoteErrorCode,detail:{requestId?:string;lastSeenMinutes?:number;boundTo?:string}={}):string{
  const requestId=typeof detail.requestId==='string'&&requestIdPattern.test(detail.requestId)?detail.requestId:null;
  if(code==='REMOTE_UNKNOWN_OUTCOME'&&requestId)
    return `결과를 모릅니다(requestId ${requestId}). 자동으로 다시 보내지 않았습니다. 같은 device·requestId로 receipt를 보세요. 새 requestId로 다시 보내지 마세요.`;
  if(code==='REMOTE_BLOCKED_BY_UNKNOWN'&&requestId)
    return `앞선 동작(requestId ${requestId})의 결과를 모르는 동안 그 Mac에 새 입력을 보내지 않습니다. 같은 device·requestId로 receipt를 보세요.`;
  if(code==='REMOTE_NO_ANSWER'&&Number.isSafeInteger(detail.lastSeenMinutes)&&(detail.lastSeenMinutes as number)>=0)
    return `그 Mac이 답하지 않습니다(마지막 신호 ${detail.lastSeenMinutes}분 전). 켜져 있는지, AgentsToZ가 실행 중인지, 공유 총괄 폴더 연결이 살아 있는지 확인하세요.`;
  if(code==='REMOTE_ID_BOUND_ELSEWHERE'&&typeof detail.boundTo==='string'){
    const where=computerUseRemoteCleanText(detail.boundTo,40);
    if(where)return `이 requestId(grant)는 ${where}에 묶여 있습니다. 그 device에서 확인하세요.`;
  }
  return ERRORS[code].message;
}
export function computerUseRemoteError(code:ComputerUseRemoteErrorCode,detail?:Parameters<typeof computerUseRemoteErrorMessage>[1]){
  return new ComputerUseRemoteError(code,computerUseRemoteErrorMessage(code,detail));
}

// ── Receipts ────────────────────────────────────────────────────────────────────────────────────────────────────────
/** What ScopeHost answers for a dispatched input (docs/claude/computer-use.md 「결과」). */
export const COMPUTER_USE_REMOTE_ACTUAL_RECEIPT_STATES=['confirmed','refused','dispatched-unverified','unknown','human-takeover'] as const;
/** Why the receiver certainly did not run an input (§8.4). */
export const COMPUTER_USE_REMOTE_NOT_RUN_REASONS=['stale','clock','busy','session-ended','receiver-off','blocked'] as const;
export type ComputerUseRemoteNotRunReason=typeof COMPUTER_USE_REMOTE_NOT_RUN_REASONS[number];
/** Every state a receiver's receipt answer can carry (§7.8-4). */
export const COMPUTER_USE_REMOTE_RECEIPT_STATES=[...COMPUTER_USE_REMOTE_ACTUAL_RECEIPT_STATES,'in-progress','not-run','evicted','unseen'] as const;
export type ComputerUseRemoteReceiptState=typeof COMPUTER_USE_REMOTE_RECEIPT_STATES[number];
const NOT_RUN_LABELS:Record<ComputerUseRemoteNotRunReason|'unseen',string>={stale:'늦게 도착',clock:'두 Mac 시계가 어긋남',busy:'그 Mac이 바쁨',
  'session-ended':'연결이 끝남','receiver-off':'그 Mac에서 받기가 꺼짐',blocked:'그 Mac에서 막힘',unseen:'그 Mac에 도착하지 않음'};
export function computerUseRemoteNotRunMessage(reason:ComputerUseRemoteNotRunReason|'unseen'):string{
  const label=NOT_RUN_LABELS[reason]??'실행하지 않음';
  return `실행하지 않았습니다(${label}). observe로 화면을 본 뒤 새 requestId로 보내세요.${reason==='clock'||reason==='stale'?' 시계가 어긋났다면 두 Mac 시계를 확인하세요.':''}`;
}

export interface ComputerUseRemoteReceipt {
  requestId:string;state:ComputerUseRemoteReceiptState;reason?:string;guardReason?:string;guardSamples?:Record<string,unknown>;
}
export interface ComputerUseRemoteReceiptAnswer {
  success?:true;bootId:string;evictedThroughSentAt:number|null;receipt:ComputerUseRemoteReceipt;owner?:'human'|'person'|'agent';guidance?:string;
}
const plain=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)
  &&(Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null);
const keysWithin=(value:Record<string,unknown>,allowed:readonly string[])=>Object.keys(value).every(key=>allowed.includes(key));
const hex32=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{32}$/.test(value);
const code60=(value:unknown):value is string=>typeof value==='string'&&/^[a-z-]{1,60}$/.test(value);
const utf8=new TextEncoder();
const byteLength=(value:string)=>utf8.encode(value).byteLength;

/** Content-free guard readings ride along with an actual receipt; anything bigger or differently shaped is dropped whole. */
function guardSamples(value:unknown):Record<string,unknown>|undefined{
  if(!plain(value)||!Object.keys(value).length||!keysWithin(value,['before','after','refusal']))return undefined;
  if(!Object.values(value).every(plain))return undefined;
  return byteLength(JSON.stringify(value))<=2048?structuredClone(value):undefined;
}
/** Closed: a receipt from another Mac is that Mac's claim, so only known fields of known shape pass to the AI. */
export function parseComputerUseRemoteReceipt(value:unknown):ComputerUseRemoteReceipt|null{
  if(!plain(value)||!keysWithin(value,['requestId','state','reason','guardReason','guardSamples']))return null;
  if(typeof value.requestId!=='string'||!requestIdPattern.test(value.requestId))return null;
  const state=value.state as ComputerUseRemoteReceiptState;
  if(!(COMPUTER_USE_REMOTE_RECEIPT_STATES as readonly unknown[]).includes(state))return null;
  const actual=(COMPUTER_USE_REMOTE_ACTUAL_RECEIPT_STATES as readonly unknown[]).includes(state);
  const receipt:ComputerUseRemoteReceipt={requestId:value.requestId,state};
  if(state==='not-run'){
    if(!(COMPUTER_USE_REMOTE_NOT_RUN_REASONS as readonly unknown[]).includes(value.reason))return null;
    receipt.reason=value.reason as string;
  }else if('reason' in value){if(!actual||!code60(value.reason))return null;receipt.reason=value.reason;}
  if('guardReason' in value){if(!actual||!code60(value.guardReason))return null;receipt.guardReason=value.guardReason;}
  if('guardSamples' in value){
    if(!actual)return null;const samples=guardSamples(value.guardSamples);if(samples)receipt.guardSamples=samples;
  }
  return receipt;
}
/** The receiver's answer to a remote `receipt`: always with its bootId and that connection's evictedThroughSentAt (§7.8-4). */
export function parseComputerUseRemoteReceiptAnswer(value:unknown):ComputerUseRemoteReceiptAnswer|null{
  if(!plain(value)||!keysWithin(value,['success','bootId','evictedThroughSentAt','receipt','owner','guidance']))return null;
  if('success' in value&&value.success!==true)return null;
  if(!hex32(value.bootId))return null;
  const evicted=value.evictedThroughSentAt;
  if(evicted!==null&&!(Number.isSafeInteger(evicted)&&(evicted as number)>=0))return null;
  const receipt=parseComputerUseRemoteReceipt(value.receipt);if(!receipt)return null;
  if('owner' in value&&!['human','person','agent'].includes(value.owner as string))return null;
  if('guidance' in value&&(typeof value.guidance!=='string'||value.guidance.length>1000))return null;
  return {...(value.success===true?{success:true as const}:{}),bootId:value.bootId,evictedThroughSentAt:evicted as number|null,receipt,
    ...(typeof value.owner==='string'?{owner:value.owner as 'human'|'person'|'agent'}:{}),
    ...(typeof value.guidance==='string'?{guidance:value.guidance}:{})};
}
/** For the receiver: build the answer through the same parser, so it can never send a shape the sender refuses. */
export function computerUseRemoteReceiptAnswer(value:ComputerUseRemoteReceiptAnswer):ComputerUseRemoteReceiptAnswer{
  const parsed=parseComputerUseRemoteReceiptAnswer(value);
  if(!parsed)throw new ComputerUseRemoteError('REMOTE_BAD_ANSWER');
  return parsed;
}

/** The sender's unknown-outcome ledger entry (§7.8-1): the input, the device it went to, its sentAt and that device's bootId. */
export interface ComputerUseRemoteLedgerEntry {requestId:string;deviceId:string;sentAt:number;bootId:string}
export type ComputerUseRemoteReceiptVerdict=
  |{verdict:'receipt';settled:true;receipt:ComputerUseRemoteReceipt;owner?:'human'|'person'|'agent';guidance?:string}
  |{verdict:'not-run';settled:true;reason:ComputerUseRemoteNotRunReason|'unseen';message:string}
  |{verdict:'unknown-final';settled:true;why:'boot-changed'|'evicted'|'evicted-range'|'window-passed'|'invalid-entry';message:string}
  |{verdict:'pending';settled:false;why:'in-progress'|'bad-answer';message:string};
/** The sender's window for an open entry: sentAt + 10 minutes, on the sender's own clock (sentAt is the sender's value). */
export function computerUseRemoteLedgerOpen(entry:Pick<ComputerUseRemoteLedgerEntry,'sentAt'>,now:number):boolean{
  return now<entry.sentAt+COMPUTER_USE_REMOTE_LIMITS.senderLedgerWindowMs;
}
const unknownFinal=(why:Extract<ComputerUseRemoteReceiptVerdict,{verdict:'unknown-final'}>['why']):ComputerUseRemoteReceiptVerdict=>
  ({verdict:'unknown-final',settled:true,why,message:COMPUTER_USE_REMOTE_UNKNOWN_FINAL_MESSAGE});
const RECEIPT_PENDING_MESSAGE='그 Mac에서 아직 실행 중이거나 답을 확인하지 못했습니다. 같은 device·requestId로 잠시 뒤 receipt를 다시 보세요. 새 requestId로 다시 보내지 마세요.';

/**
 * §7.8-5 — how the sender settles an open input from the receiver's receipt answer. CLAUDE.md: an "absent" receipt is
 * evidence only when asked of the same owner; here that means the same connection (the receiver keys its ledger by device
 * and connection tag), the same boot, and inside the remembered range:
 * - a positive record (an actual receipt, not-run) settles as it is — the receiver keeps those at least 15 minutes;
 * - `unseen` means not run only when the bootId matches, nothing at or after this sentAt was evicted
 *   (`evictedThroughSentAt` null or earlier), and now < sentAt + 10 min; otherwise unknown-final;
 * - `evicted` and any bootId mismatch are always unknown-final;
 * - `in-progress` keeps the entry open, until the window passes (then unknown-final);
 * - an answer that does not parse or names another requestId — or no answer at all: pass `undefined` when the receipt call
 *   itself failed — settles nothing inside the window (ask again) and is unknown-final once it has passed (§7.8-7). A
 *   receiver too new or too old for this parser, or a boxed `{error}`, must not keep the device's input blocked forever.
 */
export function remoteReceiptVerdict(entry:ComputerUseRemoteLedgerEntry,answer:unknown,now:number):ComputerUseRemoteReceiptVerdict{
  if(!entry||typeof entry.requestId!=='string'||!requestIdPattern.test(entry.requestId)||!Number.isSafeInteger(entry.sentAt)||!hex32(entry.bootId))
    return unknownFinal('invalid-entry');
  const parsed=parseComputerUseRemoteReceiptAnswer(answer);
  if(!parsed||parsed.receipt.requestId!==entry.requestId)return computerUseRemoteLedgerOpen(entry,now)
    ?{verdict:'pending',settled:false,why:'bad-answer',message:RECEIPT_PENDING_MESSAGE}:unknownFinal('window-passed');
  if(parsed.bootId!==entry.bootId)return unknownFinal('boot-changed');
  const {receipt}=parsed;
  if((COMPUTER_USE_REMOTE_ACTUAL_RECEIPT_STATES as readonly string[]).includes(receipt.state))
    return {verdict:'receipt',settled:true,receipt,...(parsed.owner?{owner:parsed.owner}:{}),...(parsed.guidance?{guidance:parsed.guidance}:{})};
  if(receipt.state==='not-run'){
    const reason=receipt.reason as ComputerUseRemoteNotRunReason;
    return {verdict:'not-run',settled:true,reason,message:computerUseRemoteNotRunMessage(reason)};
  }
  if(receipt.state==='evicted')return unknownFinal('evicted');
  if(receipt.state==='in-progress')return computerUseRemoteLedgerOpen(entry,now)
    ?{verdict:'pending',settled:false,why:'in-progress',message:RECEIPT_PENDING_MESSAGE}:unknownFinal('window-passed');
  // unseen: absence is evidence only inside the remembered range.
  if(parsed.evictedThroughSentAt!==null&&parsed.evictedThroughSentAt>=entry.sentAt)return unknownFinal('evicted-range');
  if(!computerUseRemoteLedgerOpen(entry,now))return unknownFinal('window-passed');
  return {verdict:'not-run',settled:true,reason:'unseen',message:computerUseRemoteNotRunMessage('unseen')};
}

// ── Envelopes (the plaintext part of a mailbox request — closed key sets per op) ─────────────────────────────────────
interface EnvelopeBase {kind:typeof COMPUTER_USE_REMOTE_KIND;v:typeof COMPUTER_USE_REMOTE_VERSION;session:string;seq:number;sentAt:number}
export type ComputerUseRemoteHello=EnvelopeBase&{op:'hello';seq:0;pub:string;instance:string;platform:ComputerUseRemotePlatform};
export type ComputerUseRemoteCall=EnvelopeBase&{op:'call';box:string};
/** The rest of a call's split reply. Its `seq` is that call's seq, never a new one — see `computerUseRemotePartRequest`. */
export type ComputerUseRemotePart=EnvelopeBase&{op:'part';ref:string;index:1};
export type ComputerUseRemoteBackground=EnvelopeBase&{op:'heartbeat'|'disconnect';bg:1;box:string};
export type ComputerUseRemoteEnvelope=ComputerUseRemoteHello|ComputerUseRemoteCall|ComputerUseRemotePart|ComputerUseRemoteBackground;
const ENVELOPE_KEYS:Record<ComputerUseRemoteOp,readonly string[]>={
  hello:['kind','v','op','session','seq','sentAt','pub','instance','platform'],
  call:['kind','v','op','session','seq','sentAt','box'],
  part:['kind','v','op','session','seq','sentAt','ref','index'],
  heartbeat:['kind','v','op','session','seq','sentAt','bg','box'],
  disconnect:['kind','v','op','session','seq','sentAt','bg','box'],
};
const BASE64=/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
/** A sealed box: canonical padded base64, at least one tag long, at most `maxChars`. */
export function isComputerUseRemoteBox(value:unknown,maxChars:number):value is string{
  return typeof value==='string'&&value.length>=computerUseRemoteBoxChars(0)&&value.length<=maxChars&&value.length%4===0&&BASE64.test(value);
}
function isP256PublicKey(value:unknown):value is string{
  if(typeof value!=='string'||value.length>128)return false;
  try{const bytes=decodeRemoteControlRelayBase64Url(value,'pub');return bytes.byteLength===REMOTE_CONTROL_RELAY_P256_PUBLIC_KEY_BYTES&&bytes[0]===0x04;}
  catch{return false;}
}
/** Routing only: is this mailbox request meant for the computer-use path (RC-14 refuses it everywhere else)? */
export function isComputerUseRemoteRequest(value:unknown):boolean{
  return plain(value)&&value.kind===COMPUTER_USE_REMOTE_KIND;
}
/**
 * Every mailbox request of kind `computer-use` passes this before anything else, and every refusal here happens before
 * decryption and execution. Exact key sets: an unknown or missing key, a wrong size, a sequence number out of range or a
 * platform outside the three values is refused whole (REMOTE_BAD_REQUEST).
 */
export function parseComputerUseRemoteEnvelope(value:unknown):ComputerUseRemoteEnvelope{
  const bad=():never=>{throw new ComputerUseRemoteError('REMOTE_BAD_REQUEST');};
  if(!plain(value)||value.kind!==COMPUTER_USE_REMOTE_KIND||value.v!==COMPUTER_USE_REMOTE_VERSION)return bad();
  const op=value.op as ComputerUseRemoteOp;
  if(!(COMPUTER_USE_REMOTE_OPS as readonly unknown[]).includes(op))return bad();
  const keys=ENVELOPE_KEYS[op],present=Object.keys(value);
  if(present.length!==keys.length||!present.every(key=>keys.includes(key)))return bad();
  if(!hex32(value.session)||!Number.isSafeInteger(value.sentAt)||(value.sentAt as number)<=0)return bad();
  const seq=value.seq;
  if(op==='hello'?seq!==0:!(Number.isSafeInteger(seq)&&(seq as number)>=1))return bad();
  const base={kind:COMPUTER_USE_REMOTE_KIND,v:COMPUTER_USE_REMOTE_VERSION,session:value.session as string,seq:seq as number,sentAt:value.sentAt as number};
  switch(op){
    case 'hello':
      if(!isP256PublicKey(value.pub)||!hex32(value.instance)||!(COMPUTER_USE_REMOTE_PLATFORMS as readonly unknown[]).includes(value.platform))return bad();
      return {...base,op,seq:0,pub:value.pub,instance:value.instance,platform:value.platform as ComputerUseRemotePlatform};
    case 'call':
      if(!isComputerUseRemoteBox(value.box,COMPUTER_USE_REMOTE_REQUEST_BOX_MAX_CHARS))return bad();
      return {...base,op,box:value.box};
    case 'part':
      if(!hex32(value.ref)||value.index!==1)return bad();
      return {...base,op,ref:value.ref,index:1};
    default:
      if(value.bg!==1||!isComputerUseRemoteBox(value.box,COMPUTER_USE_REMOTE_REQUEST_BOX_MAX_CHARS))return bad();
      return {...base,op,bg:1,box:value.box};
  }
}
/**
 * The one meaning of a part's `seq` (§7.4, §8.1), so that the sender (WP4) and the receiver (WP3) cannot pick different
 * rules: it is **the seq of the call whose reply it fetches**.
 * - A part is not sealed, so its seq is not authenticated and orders nothing. The sender seals no request at it (the call
 *   already did) and opens the joined reply under that call's header; its next sealed request takes the next seq as usual.
 * - The receiver serves a part only when session, seq and ref are exactly those of the call whose rest it cached
 *   (`computerUseRemotePartMatches`). It never compares a part's seq with the channel's `lastRequestSeq` and never
 *   advances it.
 * - `sentAt` is the part's own sending time. No sentAt guard applies: a part changes nothing.
 * - Any failure of a part is the loss of that call's reply: classify it with `{operation:<the call's>, part:true}`.
 */
export function computerUseRemotePartRequest(call:{session:string;seq:number},ref:string,sentAt:number):ComputerUseRemotePart{
  return parseComputerUseRemoteEnvelope({kind:COMPUTER_USE_REMOTE_KIND,v:COMPUTER_USE_REMOTE_VERSION,op:'part',session:call.session,seq:call.seq,
    sentAt,ref,index:1}) as ComputerUseRemotePart;
}
/** For the receiver: does this part fetch the rest it cached for the call (session, seq) whose reply carried `ref`? */
export function computerUseRemotePartMatches(part:ComputerUseRemotePart,cached:{session:string;seq:number;ref:string}):boolean{
  return part.op==='part'&&part.session===cached.session&&part.seq===cached.seq&&part.ref===cached.ref;
}

// ── Replies (the `body` of an `{ok:true, body}` mailbox answer) ─────────────────────────────────────────────────────
export type ComputerUseRemoteHelloReply={v:1;pub:string;bootId:string};
export type ComputerUseRemoteCallReply={v:1;box:string;parts:1}|{v:1;box:string;parts:2;ref:string};
export type ComputerUseRemoteBoxReply={v:1;box:string};
export type ComputerUseRemoteReply=ComputerUseRemoteHelloReply|ComputerUseRemoteCallReply|ComputerUseRemoteBoxReply;
/** The sender's closed reading of a receiver's answer body. Anything else is a bad answer, and for an input an unknown outcome. */
export function parseComputerUseRemoteReply(op:'hello',value:unknown):ComputerUseRemoteHelloReply;
export function parseComputerUseRemoteReply(op:'call',value:unknown):ComputerUseRemoteCallReply;
export function parseComputerUseRemoteReply(op:'part'|'heartbeat'|'disconnect',value:unknown):ComputerUseRemoteBoxReply;
export function parseComputerUseRemoteReply(op:ComputerUseRemoteOp,value:unknown):ComputerUseRemoteReply{
  const bad=():never=>{throw new ComputerUseRemoteError('REMOTE_BAD_ANSWER');};
  if(!plain(value)||value.v!==COMPUTER_USE_REMOTE_VERSION)return bad();
  const max=COMPUTER_USE_REMOTE_LIMITS.partMaxChars,keys=Object.keys(value);
  const only=(allowed:readonly string[])=>keys.length===allowed.length&&keys.every(key=>allowed.includes(key));
  if(op==='hello'){
    if(!only(['v','pub','bootId'])||!isP256PublicKey(value.pub)||!hex32(value.bootId))return bad();
    return {v:1,pub:value.pub,bootId:value.bootId};
  }
  if(op==='call'){
    if(value.parts===1&&only(['v','box','parts'])&&isComputerUseRemoteBox(value.box,max))return {v:1,box:value.box,parts:1};
    // The first part is cut at a 4-character boundary, so it is itself canonical base64 of no meaning alone.
    if(value.parts===2&&only(['v','box','parts','ref'])&&hex32(value.ref)&&isPartChunk(value.box,max,true))return {v:1,box:value.box as string,parts:2,ref:value.ref};
    return bad();
  }
  if(!only(['v','box']))return bad();
  if(op==='part'?!isPartChunk(value.box,max,false):!isComputerUseRemoteBox(value.box,max))return bad();
  return {v:1,box:value.box as string};
}
/** A part of a split box: the first is exactly `partMaxChars` long and unpadded, the second is the padded tail. */
function isPartChunk(value:unknown,max:number,first:boolean):boolean{
  if(typeof value!=='string'||!value.length||value.length>max||value.length%4!==0||!BASE64.test(value))return false;
  return first?value.length===max&&!value.endsWith('='):true;
}

// ── Refusals and how a sender reads them ────────────────────────────────────────────────────────────────────────────
/**
 * The refusals a receiver gives at envelope level, as `{ok:false, error:<sentence>}`, before decrypting or executing
 * anything (§8.1). The code does not travel, so the sender recovers it from the exact sentence — each must stay unique.
 * Everything after decryption is answered inside the box instead (RC-5).
 */
export const COMPUTER_USE_REMOTE_ENVELOPE_REFUSALS=['REMOTE_UNSUPPORTED','REMOTE_SENDER_UNSUPPORTED','REMOTE_BLOCKED_BY_PERSON',
  'REMOTE_DEVICE_BLOCKED','REMOTE_RATE_LIMITED','REMOTE_SESSION_MISSING','REMOTE_BAD_REQUEST','REMOTE_PART_LOST'] as const satisfies readonly ComputerUseRemoteErrorCode[];
export type ComputerUseRemoteEnvelopeRefusal=typeof COMPUTER_USE_REMOTE_ENVELOPE_REFUSALS[number];
export function computerUseRemoteEnvelopeRefusal(code:ComputerUseRemoteEnvelopeRefusal):{ok:false;error:string}{
  return {ok:false,error:ERRORS[code].message};
}
export type ComputerUseRemoteClassified=
  |{outcome:'not-run';code:ComputerUseRemoteErrorCode;reason?:ComputerUseRemoteNotRunReason;message:string}
  |{outcome:'unknown';code:'REMOTE_UNKNOWN_OUTCOME';message:string;bug?:true}
  |{outcome:'state-unknown';code:'REMOTE_STATE_UNKNOWN';message:string;bug?:true}
  |{outcome:'read';code:ComputerUseRemoteErrorCode;message:string;bug?:true};
/** What the classifiers need to know about the request that failed. */
export interface ComputerUseRemoteClassifyOptions {
  /**
   * The call's operation, or the envelope op for hello, heartbeat and disconnect. For a `part` request: the operation of the
   * call whose reply it fetches. `computerUseRemoteEffect` reads it; anything it does not know is treated as an input.
   */
  operation:ComputerUseRemoteCallOperation|'hello'|'heartbeat'|'disconnect';
  /** A `part` request: its call already ran, so any failure is the loss of that call's reply (REMOTE_PART_LOST), never a not-run. */
  part?:boolean;
  requestId?:string;
}
const classified=(code:ComputerUseRemoteErrorCode,reason?:ComputerUseRemoteNotRunReason):ComputerUseRemoteClassified=>
  ({outcome:'not-run',code,...(reason?{reason}:{}),message:reason?computerUseRemoteNotRunMessage(reason):ERRORS[code].message});
/**
 * An open outcome, by what the request may have changed (`computerUseRemoteEffect`): an input is unknown (never resent,
 * settled by its receipt), a request-access/request-human/disconnect is state-unknown (read status), a read just failed.
 */
function open(options:ComputerUseRemoteClassifyOptions,readCode:ComputerUseRemoteErrorCode,bug?:true):ComputerUseRemoteClassified{
  const flag=bug?{bug}:{};
  switch(computerUseRemoteEffect(options.operation)){
    case 'read':return {outcome:'read',code:readCode,message:ERRORS[readCode].message,...flag};
    case 'state-change':return {outcome:'state-unknown',code:'REMOTE_STATE_UNKNOWN',message:ERRORS.REMOTE_STATE_UNKNOWN.message,...flag};
    default:return {outcome:'unknown',code:'REMOTE_UNKNOWN_OUTCOME',
      message:computerUseRemoteErrorMessage('REMOTE_UNKNOWN_OUTCOME',{requestId:options.requestId}),...flag};
  }
}
/** The call ran; only its reply was lost. */
const partLost=(options:ComputerUseRemoteClassifyOptions)=>open(options,'REMOTE_PART_LOST');
const ENVELOPE_SENTENCES=new Map<string,ComputerUseRemoteEnvelopeRefusal>(COMPUTER_USE_REMOTE_ENVELOPE_REFUSALS.map(code=>[ERRORS[code].message,code]));

/**
 * A receiver's `{ok:false, error}` answer, read by its exact text (like src/opsRequestDispatch.ts):
 * - an AgentsToZ from before this feature answers 「지원하지 않는 기기 제어 요청입니다.」 → REMOTE_HOST_OUTDATED, not run;
 * - the poll's budget answer 「상대 기기가 바빠 …」 → not run (busy);
 * - the execution deadline 「… 실행됐는지는 알 수 없습니다.」 → open: an input unknown, a state change state-unknown, a read failed;
 * - the response-too-large answer is a bug here (replies are split): open as above, flagged;
 * - one of this protocol's envelope refusals → that code, not run — except REMOTE_PART_LOST, the loss of a reply: open as
 *   above under that code;
 * - any other text proves nothing about admission: open as above.
 * Whatever its text, the refusal of a `part` request (`options.part`) is the loss of its call's reply.
 */
export function classifyComputerUseRemoteRefusal(error:unknown,options:ComputerUseRemoteClassifyOptions):ComputerUseRemoteClassified{
  if(options.part)return partLost(options);
  if(typeof error!=='string')return open(options,'REMOTE_BAD_ANSWER');
  if(error===OPS_REQUEST_LEGACY_UNSUPPORTED_MESSAGE)return classified('REMOTE_HOST_OUTDATED');
  if(error===COMMUNITY_CONTROL_POLL_BUSY_MESSAGE)return classified('REMOTE_NOT_RUN','busy');
  if(error===COMMUNITY_CONTROL_EXECUTE_TIMEOUT_MESSAGE)return open(options,'REMOTE_NO_ANSWER');
  if(error===COMMUNITY_CONTROL_RESPONSE_TOO_LARGE_MESSAGE)return open(options,'REMOTE_BAD_ANSWER',true);
  const code=ENVELOPE_SENTENCES.get(error);
  if(code==='REMOTE_PART_LOST')return partLost(options);
  if(code)return classified(code);
  return open(options,'REMOTE_BAD_ANSWER');
}
/**
 * The database function's refusals of `control-send`. They are raised before the insert, in the same transaction, so a
 * row was never written. They reach the sender as the exact token (AgentDialogueHostError message, api-server.ts rpc).
 */
const SEND_REFUSALS:Record<string,ComputerUseRemoteErrorCode>={
  AGENT_DIALOGUE_CONTROL_NOT_IN_COMMUNITY:'REMOTE_NOT_IN_COMMUNITY',
  AGENT_DIALOGUE_CONTROL_TARGET_UNAVAILABLE:'REMOTE_NOT_IN_COMMUNITY',
  AGENT_DIALOGUE_CONTROL_BUSY:'REMOTE_RATE_LIMITED',
  AGENT_DIALOGUE_CONTROL_INVALID:'REMOTE_BAD_REQUEST',
  AGENT_DIALOGUE_CONTROL_TARGET_INVALID:'REMOTE_DEVICE_UNKNOWN',
  AGENT_DIALOGUE_SHARED_PROFILE_REQUIRED:'REMOTE_PROFILE_REQUIRED',
  AGENT_DIALOGUE_DEVICE_REQUIRED:'REMOTE_PROFILE_REQUIRED',
  AGENT_DIALOGUE_DEVICE_KEY_MISMATCH:'REMOTE_PROFILE_REQUIRED',
  AGENT_DIALOGUE_DEVICE_UNAUTHORIZED:'REMOTE_PROFILE_REQUIRED',
  AGENT_DIALOGUE_SOURCE_UNAVAILABLE:'REMOTE_PROFILE_REQUIRED',
};
/**
 * A failure of the mailbox call itself (`controlCall` threw). `sent` is whether the row was confirmed written (its
 * `onSent`). Before that, only the database's own refusal tokens prove no row exists — a network failure may have
 * committed the insert anyway. After it, every failure — the 20 s deadline included — leaves the outcome open (unknown
 * for an input, state-unknown for a state change; a read just failed).
 */
export function classifyComputerUseRemoteTransportFailure(error:unknown,options:ComputerUseRemoteClassifyOptions&{sent:boolean}):ComputerUseRemoteClassified{
  if(options.part)return partLost(options);
  const fields=error&&typeof error==='object'?error as {code?:unknown;message?:unknown}:{};
  if(!options.sent){
    for(const token of [fields.message,fields.code]){
      if(typeof token==='string'&&Object.hasOwn(SEND_REFUSALS,token))return classified(SEND_REFUSALS[token]!);
    }
  }
  return open(options,'REMOTE_NO_ANSWER');
}
/**
 * An `{ok:true}` answer that cannot be used (§7.8-1): a body the reply parser refuses, a box that does not open, or a
 * `device` echo that differs from the request. The row was taken, so the outcome is open (unknown for an input,
 * state-unknown for a state change); a read just failed.
 */
export function classifyComputerUseRemoteBadAnswer(options:ComputerUseRemoteClassifyOptions):ComputerUseRemoteClassified{
  if(options.part)return partLost(options);
  return open(options,'REMOTE_BAD_ANSWER');
}

// ── The call box's content ──────────────────────────────────────────────────────────────────────────────────────────
/**
 * Inside a call box: the agent request for the receiver's ScopeHost, plus (on the first call) the sender's MCP client name
 * and host app for the receiver's label. Only the operation is checked here; the receiver's own closed parser checks the
 * rest and its refusal goes back inside the box.
 */
export interface ComputerUseRemoteCallMeta {request:Record<string,unknown>&{operation:ComputerUseRemoteCallOperation};client?:string;host?:string}
export function parseComputerUseRemoteCallMeta(meta:unknown):ComputerUseRemoteCallMeta{
  if(!plain(meta)||!(COMPUTER_USE_REMOTE_CALL_OPERATIONS as readonly unknown[]).includes(meta.operation))throw new ComputerUseRemoteError('REMOTE_BAD_REQUEST');
  const {client,host,...request}=meta;
  const label=(value:unknown)=>{
    if(value===undefined)return undefined;
    if(typeof value!=='string')throw new ComputerUseRemoteError('REMOTE_BAD_REQUEST');
    return computerUseRemoteCleanText(value,64)||undefined;
  };
  const cleanClient=label(client),cleanHost=label(host);
  return {request:request as ComputerUseRemoteCallMeta['request'],...(cleanClient?{client:cleanClient}:{}),...(cleanHost?{host:cleanHost}:{})};
}
/** Heartbeat and disconnect boxes are empty: sealed only so that nobody else can end a connection. */
export function isComputerUseRemoteEmptyMeta(meta:unknown):boolean{return plain(meta)&&Object.keys(meta).length===0;}

// ── Small shared helpers ────────────────────────────────────────────────────────────────────────────────────────────
/**
 * Names that come from the other Mac (its endpoint display name, its MCP client) are its own claim. Control and format
 * characters (Cc, Cf — which includes bidirectional overrides and zero-width characters) and line separators are removed,
 * whitespace collapsed, then cut to `max` code points.
 */
export function computerUseRemoteCleanText(value:string,max:number):string{
  const cleaned=value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu,'').replace(/\s+/gu,' ').trim();
  return Array.from(cleaned).slice(0,Math.max(0,max)).join('').trim();
}
/** A fresh 128-bit ID as 32 lowercase hex characters: session, part reference, bootId. */
export function newComputerUseRemoteId():string{
  const bytes=globalThis.crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes,byte=>byte.toString(16).padStart(2,'0')).join('');
}
/**
 * The connection tag (§6): the first 32 hex characters of sha256('agentstoz-cu-remote-instance\0' + instance), where
 * `instance` is the MCP process's 64-hex instance header. Not a secret; it keys the receiver's ledger per AI connection.
 */
export async function computerUseRemoteConnectionTag(instance:string):Promise<string>{
  if(typeof instance!=='string'||!/^[a-f0-9]{64}$/.test(instance))throw new ComputerUseRemoteError('REMOTE_BAD_REQUEST','AI 연결을 확인하지 못했습니다.');
  const digest=new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256',utf8.encode(`agentstoz-cu-remote-instance\0${instance}`)));
  return Array.from(digest.subarray(0,16),byte=>byte.toString(16).padStart(2,'0')).join('');
}
