import {randomUUID} from 'node:crypto';
import type {ContextOrcaCommandRequest} from './contextSessionCommand';
import {inspectLiveOrcaTerminal,inspectOrcaSessionBinding,orcaPaneLeafId,type OrcaSessionBinding} from './orcaSessionLookup';
import type {WorkroomConversationJournal} from './workroomConversationJournal';
import {submissionKey,submissionOwnerDigest,type StoredSubmission} from './workroomSubmissions';

/**
 * Native /compact and /clear for a Claude Code running in an Orca terminal (user decision 2026-10-29: 「Orca Claude에도
 * 보낸다」). There is no Workroom session to hold: the server finds the terminal again from the row's captured identity
 * (context snapshot `orcaPaneKey`·`orcaWorktreeId` → Orca's persisted provider session → exactly ONE live runtime
 * handle) and never takes a handle, path or text from the caller.
 *
 * Before the write: memory saved and synced (checked twice: before the terminal is resolved and again after Orca's
 * own idle signal), then a rendered screen whose Claude composer is empty with no turn running. The screen read is the
 * last look before the write — only one `terminal show` and the local journal sit between them, never a memory or network
 * check, because Orca's prompt delivery types into whatever the composer holds. The send carries the request ID as
 * Orca's `--retry-request` identity and its receipt must name the same runtime, handle and process incarnation.
 *
 * Every request the host answers leaves a durable receipt in the Workroom submission journal, refusals included, so a
 * lost reply always resolves. An outcome that is not proven is `unknown`: that session is fenced and nothing is ever
 * sent again for it until a person acknowledges that one receipt (acknowledge). Acknowledging a request the host never
 * recorded leaves a tombstone under its key, so a late arrival of that request is refused, never sent. Nothing here
 * releases a fence by itself.
 */
export const CONTEXT_ORCA_RECEIPT_OWNER='local-context-orca';
const PROMPT_DELIVERY='terminal.prompt-delivery.v1';
/** Not a project: keeps these receipts out of a project's correction-task summary. */
const RECEIPT_TARGET='orca-context';

export type ContextOrcaOutcome={state:'written'}|{state:'rejected';error:string}|{state:'unknown';error:string};
type Journal=Pick<WorkroomConversationJournal,'bootId'|'submission'|'prepareSubmission'|'transitionSubmission'|'unsettledSubmissions'|'acknowledgeSubmission'>;
export interface ContextOrcaHost {
  /** The row's own capture (context/<providerSessionId>.json), or null. */
  snapshot(providerSessionId:string):Record<string,unknown>|null;
  /** Orca's persisted workspace session (src/orcaProfileState.ts). */
  sessionState():{kind:'ok';state:unknown}|{kind:'unavailable'};
  cli():string|null;
  /** One CLI call with `--json` appended. Resolves the parsed JSON document; rejects when the call or its output is unreadable. */
  run(cli:string,args:string[],timeoutMs:number):Promise<unknown>;
  /** Throws (with the reason) unless this session's project memory is saved and backed up. */
  verifyMemory(snapshot:Record<string,unknown>):Promise<void>;
  journal():Journal;
  /** Serializes every Orca CLI use in this process (api-server withOrcaLock). */
  lock<T>(work:()=>Promise<T>):Promise<T>;
  submitObserveSeconds?:number;
}

const object=(value:unknown):Record<string,unknown>|null=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:null;
const text=(value:unknown):string|null=>typeof value==='string'&&value.trim()?value:null;
class Refused extends Error {}
const refuse=(message:string):never=>{throw new Refused(message);};
function envelope(raw:unknown){
  const root=object(raw);
  if(!root||root.ok!==true)return null;
  return {body:object(root.result)??{},runtimeId:text(object(root._meta)?.runtimeId)};
}

/** Claude's composer is the prompt line between the two rules at the bottom of its screen. A draft, an approval list
 *  (`❯ 1. Yes`) or a running turn (「esc to interrupt」) is not an empty composer. */
export function claudeOrcaComposerEmpty(rows:readonly string[]):boolean {
  const lines=rows.map(row=>row.replace(/ /g,' '));
  if(lines.some(line=>/esc to interrupt/i.test(line)))return false;
  const rule=/^\s*[─━]{5,}\s*$/;
  for(let i=lines.length-2;i>=1;i--){
    if(!/^\s*[❯>]/.test(lines[i]!))continue;
    return /^\s*[❯>]\s*$/.test(lines[i]!)&&rule.test(lines[i-1]!)&&rule.test(lines[i+1]!);
  }
  return false;
}

interface Live {cli:string;handle:string;runtimeId:string;incarnationId:string}
async function verifiedTerminal(host:ContextOrcaHost,binding:OrcaSessionBinding):Promise<Live> {
  const cli=host.cli();if(!cli)return refuse('Orca CLI를 찾지 못했습니다. 명령을 보내지 않았습니다.');
  const status=envelope(await host.run(cli,['status'],5_000).catch(()=>null)),runtime=object(status?.body.runtime);
  const runtimeId=text(runtime?.runtimeId);
  if(!status||object(status.body.app)?.running!==true||runtime?.reachable!==true||!runtimeId||status.runtimeId!==runtimeId)return refuse('Orca 실행 상태를 확인하지 못했습니다. 명령을 보내지 않았습니다.');
  if(!Array.isArray(runtime.capabilities)||!runtime.capabilities.includes(PROMPT_DELIVERY))return refuse('이 Orca는 전송 영수증을 지원하지 않습니다. Orca를 업데이트한 뒤 다시 실행하세요. 명령을 보내지 않았습니다.');
  const listed=envelope(await host.run(cli,['terminal','list','--limit','1000'],8_000).catch(()=>null));
  const found=listed&&listed.runtimeId===runtimeId?inspectLiveOrcaTerminal(listed.body,binding):null;
  if(found?.kind!=='one')return refuse('Orca에서 이 대화의 터미널을 하나로 확인하지 못했습니다. 명령을 보내지 않았습니다.');
  const shown=envelope(await host.run(cli,['terminal','show','--terminal',found.value.handle],8_000).catch(()=>null)),terminal=object(shown?.body.terminal);
  const leaf=orcaPaneLeafId(binding),incarnationId=text(terminal?.incarnationId);
  if(!shown||shown.runtimeId!==runtimeId||!terminal||terminal.handle!==found.value.handle||terminal.tabId!==binding.tabId||terminal.worktreeId!==binding.worktreeId
    ||leaf&&text(terminal.leafId)&&terminal.leafId!==leaf||terminal.orphaned===true||!incarnationId)return refuse('Orca 터미널을 다시 검증하지 못했습니다. 명령을 보내지 않았습니다.');
  if(terminal.agentIdentity!=='claude'||terminal.connected!==true||terminal.writable!==true||terminal.executionHostId!=='local')return refuse('이 Orca 터미널이 이 Mac의 Claude Code로 확인되지 않았습니다. 명령을 보내지 않았습니다.');
  return {cli,handle:found.value.handle,runtimeId,incarnationId};
}

const BUSY='Claude가 작업 중이거나 입력칸·승인 화면이 사용 중입니다. 입력 대기 상태에서 다시 실행하세요. 명령을 보내지 않았습니다.';
async function waitIdle(host:ContextOrcaHost,live:Live){
  const waited=envelope(await host.run(live.cli,['terminal','wait','--terminal',live.handle,'--for','tui-idle','--timeout-ms','1500'],8_000).catch(()=>null)),wait=object(waited?.body.wait);
  if(!waited||waited.runtimeId!==live.runtimeId||wait?.handle!==live.handle||wait.condition!=='tui-idle'||wait.satisfied!==true)return refuse(BUSY);
}
async function assertComposerEmpty(host:ContextOrcaHost,live:Live){
  const read=envelope(await host.run(live.cli,['terminal','read','--terminal',live.handle,'--screen','--limit','80'],8_000).catch(()=>null)),terminal=object(read?.body.terminal);
  if(!read||read.runtimeId!==live.runtimeId||terminal?.handle!==live.handle||terminal.source!=='screen'||!Array.isArray(terminal.tail)||!terminal.tail.every(row=>typeof row==='string'))
    return refuse('Orca 화면을 확인하지 못했습니다. 명령을 보내지 않았습니다.');
  if(typeof terminal.draft==='string'&&terminal.draft.trim()||!claudeOrcaComposerEmpty(terminal.tail as string[]))return refuse(BUSY);
}

/** Right before the write, as teamExternalHost.submit does: still the same runtime, handle and process incarnation. */
async function assertUnchanged(host:ContextOrcaHost,live:Live){
  const shown=envelope(await host.run(live.cli,['terminal','show','--terminal',live.handle],8_000).catch(()=>null)),terminal=object(shown?.body.terminal);
  if(!shown||shown.runtimeId!==live.runtimeId||terminal?.handle!==live.handle||terminal.incarnationId!==live.incarnationId||terminal.connected!==true||terminal.writable!==true)
    return refuse('Orca 터미널이 그사이 바뀌었습니다. 명령을 보내지 않았습니다.');
}

function bindingOf(host:ContextOrcaHost,providerSessionId:string){
  const snapshot=host.snapshot(providerSessionId),context=object(snapshot?.launchContext);
  const paneKey=text(context?.orcaPaneKey),worktreeId=text(context?.orcaWorktreeId);
  if(!snapshot||!paneKey||!worktreeId)return refuse('이 대화의 Orca 터미널 정보가 없습니다. 명령을 보내지 않았습니다.');
  const persisted=host.sessionState();
  if(persisted.kind!=='ok')return refuse('Orca의 현재 세션 정보를 읽지 못했습니다. 명령을 보내지 않았습니다.');
  const binding=inspectOrcaSessionBinding(persisted.state,providerSessionId,paneKey);
  if(binding.kind!=='one'||binding.value.worktreeId!==worktreeId)return refuse('Orca의 저장된 세션과 이 대화가 일치하지 않습니다. 명령을 보내지 않았습니다.');
  return {snapshot,binding:binding.value};
}

type RequestIdentity={providerSessionId:string;requestId:string};
const keyFor=(request:RequestIdentity)=>submissionKey({owner:CONTEXT_ORCA_RECEIPT_OWNER,sessionId:request.providerSessionId},'context_'+request.requestId);
/** Never equal to an execute fingerprint: a request a person released before the host ever recorded it. */
const tombstoneOf=(request:RequestIdentity)=>JSON.stringify(['orca-context-acknowledged',request.providerSessionId]);
const liveBinding=(live:Live)=>JSON.stringify([live.runtimeId,live.handle,live.incarnationId]);
function receiptOf(journal:Journal,request:RequestIdentity,fingerprint:string,binding:string,state:'prepared'|'rejected',acknowledgedAt?:string):StoredSubmission {
  return {key:keyFor(request),id:'context_'+request.requestId,owner:submissionOwnerDigest(CONTEXT_ORCA_RECEIPT_OWNER),sessionId:request.providerSessionId,targetId:RECEIPT_TARGET,
    binding,revision:0,fingerprint,intentHash:fingerprint,epoch:randomUUID(),bootId:journal.bootId,state,...(acknowledgedAt?{acknowledgedAt}:{})};
}
// Outside the lock a prepared row is never in flight: it was never written. write_started without an outcome is unknown.
const reported=(record:StoredSubmission)=>record.state==='write_started'?'unknown':record.state==='prepared'?'rejected':record.state;

async function execute(host:ContextOrcaHost,request:Extract<ContextOrcaCommandRequest,{operation:'context.orca.execute'}>):Promise<ContextOrcaOutcome> {
  const journal=host.journal(),key=keyFor(request),owner=submissionOwnerDigest(CONTEXT_ORCA_RECEIPT_OWNER);
  const fingerprint=JSON.stringify(['orca-context',request.command,request.providerSessionId]);
  const previous=journal.submission(key);
  if(previous){
    // The same request again is answered from its receipt; it is never written twice.
    if(previous.fingerprint===tombstoneOf(request))return {state:'rejected',error:'이 요청은 「미확정 해제」로 이미 정리됐습니다. 명령을 보내지 않았습니다.'};
    if(previous.fingerprint!==fingerprint)return {state:'rejected',error:'같은 요청 ID의 내용이 다릅니다. 명령을 보내지 않았습니다.'};
    const state=reported(previous);
    return state==='written'?{state}:state==='rejected'?{state,error:'이 요청은 보내기 전에 중단됐습니다.'}:{state:'unknown',error:'이 요청의 전송 결과가 미확정입니다. 자동으로 다시 보내지 않습니다.'};
  }
  // A refusal is a durable `rejected` receipt too: a reply lost on the way back (sidecar restart, the proxy's read timeout
  // while this waited for the Orca lock) then resolves to "not sent" instead of a fence no button can release.
  const refused=(error:string,binding='[]'):ContextOrcaOutcome=>{
    try{journal.prepareSubmission(receiptOf(journal,request,fingerprint,binding,'rejected'));}catch{/* still not sent; a lost reply stays fenced until acknowledged */}
    return {state:'rejected',error};
  };
  if(journal.unsettledSubmissions(owner,request.providerSessionId,1).length)
    return refused('이 대화에 결과가 미확정인 컨텍스트 명령이 있습니다. 직접 확인한 뒤 「미확정 해제」를 눌러야 다시 보낼 수 있습니다.');
  let live:Live|undefined;
  try{
    const {snapshot,binding}=bindingOf(host,request.providerSessionId);
    await host.verifyMemory(snapshot);
    live=await verifiedTerminal(host,binding);
    await waitIdle(host,live);
    // The idle wait can take seconds; memory written meanwhile must be saved and synced again. This slow check runs
    // before the screen read, so nothing but one `show` separates the empty composer from the write.
    await host.verifyMemory(snapshot);
    await assertComposerEmpty(host,live);
    await assertUnchanged(host,live);
  }catch(error){return refused(error instanceof Error?error.message:String(error),live&&liveBinding(live));}
  const record=receiptOf(journal,request,fingerprint,liveBinding(live),'prepared');
  try{journal.prepareSubmission(record);journal.transitionSubmission(key,'prepared','write_started');}
  catch(error){
    try{journal.transitionSubmission(key,'prepared','rejected');}catch{/* never prepared, or still fenced until restart */}
    return {state:'rejected',error:`전송 기록을 남기지 못해 명령을 보내지 않았습니다. (${error instanceof Error?error.message:String(error)})`};
  }
  const unknown=(error:string):ContextOrcaOutcome=>{try{journal.transitionSubmission(key,'write_started','unknown');}catch{/* stays write_started: still fenced */}return {state:'unknown',error};};
  const settle=(to:'written'|'rejected')=>{try{journal.transitionSubmission(key,'write_started',to);return true;}catch{return false;}};
  let raw:unknown;
  try{
    raw=await host.run(live.cli,['terminal','send','--terminal',live.handle,'--text',`/${request.command}`,'--enter',
      '--wait-submit',String(Math.max(1,Math.min(10,host.submitObserveSeconds??2))),'--retry-request',request.requestId],30_000);
  }catch{return unknown('Orca 전송 결과를 확인하지 못했습니다. 같은 명령을 다시 보내지 말고 Orca 화면을 확인하세요.');}
  const sent=envelope(raw),send=object(sent?.body.send),prompt=object(send?.prompt);
  if(!sent||sent.runtimeId!==live.runtimeId||send?.handle!==live.handle||prompt?.processIncarnation!==live.incarnationId)
    return unknown('Orca가 같은 터미널·프로세스로 받았는지 확인하지 못했습니다. 같은 명령을 다시 보내지 말고 Orca 화면을 확인하세요.');
  if(send.accepted===false)return settle('rejected')?{state:'rejected',error:'Orca가 입력을 받지 않았습니다. 명령은 전송되지 않았습니다.'}:unknown('전송 기록을 정리하지 못했습니다. 자동으로 다시 보내지 않습니다.');
  if(send.accepted!==true)return unknown('Orca 전송 결과가 미확정입니다. 같은 명령을 다시 보내지 말고 Orca 화면을 확인하세요.');
  return settle('written')?{state:'written'}:unknown('전송 기록을 저장하지 못했습니다. 자동으로 다시 보내지 않습니다.');
}

/** context.orca.execute · receipt · acknowledge, all under the one Orca lock so an acknowledgement never races a send. */
export function performContextOrcaCommand(host:ContextOrcaHost,request:ContextOrcaCommandRequest){
  return host.lock(async()=>{
    if(request.operation==='context.orca.execute')return execute(host,request);
    const journal=host.journal(),key=keyFor(request),record=journal.submission(key);
    if(!record){
      if(request.operation==='context.orca.receipt')return {state:'not-found' as const};
      // A person released a request this host never recorded (its reply was lost before it arrived, or it never will).
      // The tombstone keeps its key: if it arrives after all, it is refused and never sent.
      journal.prepareSubmission(receiptOf(journal,request,tombstoneOf(request),'[]','rejected',new Date().toISOString()));
      return {state:'not-found' as const,acknowledged:true};
    }
    if(request.operation==='context.orca.receipt')return {state:reported(record),acknowledged:!!record.acknowledgedAt};
    // A settled outcome has no fence to release; it is reported so the dock can drop its own pending mark.
    const state=reported(record);
    if(state==='written'||state==='rejected')return {state,acknowledged:!!record.acknowledgedAt};
    const acknowledged=journal.acknowledgeSubmission(key);
    return {state:reported(acknowledged),acknowledged:true};
  });
}

