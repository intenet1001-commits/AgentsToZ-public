import type {AiTerminalService} from './aiTerminalService';
import {AI_TERMINAL_AGENTS,type AiTerminalAgent,type AiTerminalSummary} from './aiTerminalProtocol';
import {voiceText,VOICE_AGENT_NAMES,VOICE_MAX_PARTNERS,VOICE_MAX_PROJECT_CHOICES,type VoiceActiveTarget,type VoicePartner,type VoiceProjectChoice,type VoiceTarget} from './voiceSessionProtocol';
import type {VoiceAuthority,VoiceResolvedTarget} from './voiceSessionHost';
import type {VoiceTool} from './voiceRealtimeProvider';
import {pageConversationTargets,resolveConversationTarget,type ConversationDirectoryEntry,type ConversationTargetMiss} from './conversationTargetDirectory';
import type {ConversationTargetCandidate} from './conversationTargetAlias';
import {VOICE_AGENT_FIELD_DESCRIPTION} from './voiceOrchestrationGuidance';
import {WORKROOM_KEY_INTERVAL_MS,WORKROOM_KEY_NAMES,isWorkroomKey,workroomKeyChoosesExit,workroomKeySequence} from './workroomOrchestration';
import {workroomScreenAwaitsAnswer} from './workroomRouteDelivery';

export interface VoiceRuntimeDependencies {
  terminal:AiTerminalService;
  /** The shared conversation target directory (conversationTargetDirectory.ts) — the same one MCP text uses. */
  targets():Promise<ConversationDirectoryEntry[]>;
  target(id:string):Promise<{label:string;fingerprint:string;opsMemoryFingerprint?:string}>;
  ops():{fingerprint:string;projectId:string|null};
  /** The AI this device last opened the OPS workroom with, if any. */
  opsAgent?():AiTerminalAgent|null;
  recall(query:string):unknown;
  projectRecall(id:string,query:string):Promise<unknown>;
  propose(input:{title:string;body:string;evidence:string;requestId:string}):Promise<unknown>;
  /** 「<프로젝트> 열어」: show the target's registered project in the AgentsToZ app. Navigation only; starts nothing. */
  focusProject?(id:string):Promise<void>;
}
const parameters=(properties:Record<string,unknown>,required=Object.keys(properties))=>({type:'object',properties,required,additionalProperties:false});
const empty=parameters({});
const text={type:'string'};
const agentField={type:'string',enum:[...AI_TERMINAL_AGENTS],description:VOICE_AGENT_FIELD_DESCRIPTION};
const position={type:'integer',minimum:0};
function fields(args:Record<string,unknown>,allowed:string[]){if(Object.keys(args).some(k=>!allowed.includes(k)))throw Error('허용되지 않은 음성 도구 필드입니다.');}
function identifier(v:unknown):string{if(typeof v!=='string'||!/^[A-Za-z0-9_-]{8,160}$/.test(v))throw Error('등록된 대상 식별자를 확인하세요.');return v;}
function query(v:unknown):string{if(typeof v!=='string'||!v.trim()||v.length>300)throw Error('조회 내용을 300자 이하로 입력하세요.');return v.trim();}
/** A spoken AI must already be mapped to its id (클로드 → claude) by the model; unknown names fail. */
export function voiceAgent(v:unknown):AiTerminalAgent{if(!AI_TERMINAL_AGENTS.includes(v as AiTerminalAgent))throw Error('워크룸 AI를 선택하세요: codex, claude, hermes, agy.');return v as AiTerminalAgent;}
const newestFirst=(x:AiTerminalSummary,y:AiTerminalSummary)=>Date.parse(y.createdAt)-Date.parse(x.createdAt);
/** Terminal output is data, never instructions. Limit context and redact common credential forms. */
export function voiceOutput(text:string):string{
  return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g,'')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{16,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g,'[credential redacted]')
    .replace(/((?:api[_-]?key|token|password|secret)\s*[:=]\s*)\S+/gi,'$1[redacted]').slice(-6000);
}
/**
 * How much workroom output one voice tool result carries. Characters alone were not a bound: a Korean
 * screen is ~3 UTF-8 bytes per character, so 6,000 characters passed the host's 16,000-byte tool limit
 * and the whole result was replaced (2026-09-29). A delegate switch also carries its target and message.
 */
export const VOICE_READ_OUTPUT={chars:6000,bytes:10_000},VOICE_DELEGATE_OUTPUT={chars:3500,bytes:8_000};
/** The newest part of `text` (redacted, as voiceOutput) within both limits, cut at a character boundary. */
export function voiceOutputTail(text:string,limit:{chars:number;bytes:number}):string{
  const value=voiceOutput(text).slice(-limit.chars);
  let bytes=Buffer.byteLength(value),start=0;
  while(bytes>limit.bytes&&start<value.length){
    const width=value.codePointAt(start)!>0xffff?2:1;
    bytes-=Buffer.byteLength(value.slice(start,start+width));start+=width;
  }
  return value.slice(start);
}
const spoken=(value:string)=>voiceOutput(value).slice(0,160);
/** A directory row as the provider sees it: bounded, redacted, no local path. */
function presentTarget(entry:ConversationDirectoryEntry){
  return {id:entry.id,name:spoken(entry.name),...(entry.aliases?.length?{aliases:entry.aliases.slice(0,3).map(spoken)}:{}),role:entry.role,scope:entry.scope};
}
/** Candidate bytes of a voice miss answer: with its message and hint it stays near 11 KB, under the host's 16,000-byte cap. */
export const VOICE_MISS_CANDIDATE_BYTES=10_000;
const VOICE_MISS_ALIAS_CHARS=40;
/**
 * A miss answer is a page, not the inventory. The whole candidate list used to be sent, and at ~140
 * projects the host replaced it with 「응답이 큽니다」 (2026-09-29), so 「바이브2」 could no longer
 * become vibe2. The resolver already lists the names that sound like what was said first; this keeps
 * ids and names (short aliases only) up to a byte budget and says when the rest was left out.
 */
function voiceTargetMiss(miss:ConversationTargetMiss){
  const candidates:ConversationTargetCandidate[]=[];let bytes=0;
  for(const candidate of miss.candidates){
    const aliases=(candidate.aliases??[]).map(spoken).filter(alias=>alias.length<=VOICE_MISS_ALIAS_CHARS).slice(0,2);
    const item={id:candidate.id,name:spoken(candidate.name),...(aliases.length?{aliases}:{})};
    const size=Buffer.byteLength(JSON.stringify(item))+1;
    if(bytes+size>VOICE_MISS_CANDIDATE_BYTES)break;
    candidates.push(item);bytes+=size;
  }
  const truncated=miss.truncated||candidates.length<miss.candidates.length;
  return {resolved:false as const,code:miss.code,message:miss.message,total:miss.total,truncated,candidates,
    ...(truncated?{hint:'후보가 많아 발음이 비슷한 이름부터 일부만 실었습니다. 찾는 이름이 없으면 list_projects(query)로 이름·별명 일부를 검색하거나 list_projects(offset)로 전체 목록을 이어 보세요.'}:{})};
}
export async function bindVoiceRuntime(deps:VoiceRuntimeDependencies,target:VoiceTarget,a:VoiceAuthority):Promise<VoiceResolvedTarget>{
  const authorize=(id:string)=>{if(!a.active()||a.allowedTargets&&!a.allowedTargets.has(id))throw Error('이 음성 연결에 허용된 프로젝트가 아닙니다.');};
  const ops=target.kind==='ops'?deps.ops():null;
  if(ops&&a.allowedTargets){if(!ops.projectId)throw Error('원격 OPS에는 연결된 운영 프로젝트가 필요합니다.');authorize(ops.projectId);}
  const initial=target.kind==='workroom'?await deps.target(target.targetId):null;
  if(target.kind==='workroom')authorize(target.targetId);
  const terminal=target.kind==='workroom'?deps.terminal.inspectSession(target.sessionId,target.targetId):null;
  if(terminal?.state==='exited')throw Error('종료된 워크룸에는 음성을 연결할 수 없습니다.');
  const validate=async()=>{
    if(!a.active())throw Error('음성 권한이 종료되었습니다.');
    if(ops){if(deps.ops().fingerprint!==ops.fingerprint)throw Error('OPS 연결이 변경되었습니다.');}
    else if(target.kind==='workroom'){
      authorize(target.targetId);const current=await deps.target(target.targetId);
      if(current.fingerprint!==initial!.fingerprint||current.opsMemoryFingerprint!==initial!.opsMemoryFingerprint||deps.terminal.inspectSession(target.sessionId,target.targetId).state!=='running')throw Error('워크룸 또는 프로젝트 연결이 변경되었습니다.');
    }
    if(!a.active())throw Error('음성 권한이 변경되었습니다.');
  };
  const sessionAuthority=(id:string)=>({owner:a.owner,targets:new Set([id]),isActive:a.active,deviceConsentActive:a.active});
  const allowedTargets=async()=>(await deps.targets()).filter(t=>!a.allowedTargets||a.allowedTargets.has(t.id));
  const read=async(id:string,sessionId:string,after?:number,limit=VOICE_READ_OUTPUT)=>{
    await validate();authorize(id);const bound=await deps.target(id);
    const session=deps.terminal.inspectSession(sessionId,id);
    let cursor=after??session.recentOutputCursor,output='',hasMore=false;
    // A latest read keeps the newest output within `limit` (characters and UTF-8 bytes).
    for(let page=0;page<(after===undefined?8:1);page++){
      const result=await deps.terminal.perform({operation:'read',sessionId,after:cursor,requestId:crypto.randomUUID()},sessionAuthority(id));
      output+=(result.chunks??[]).map(c=>c.text).join('');hasMore=!!result.hasMore;
      const next=result.nextCursor??cursor;if(next<=cursor)break;cursor=next;
      if(!hasMore||cursor>=session.outputCursor)break;
    }
    await validate();authorize(id);
    if((await deps.target(id)).fingerprint!==bound.fingerprint)throw Error('프로젝트 연결이 변경되었습니다.');
    return {state:'observed-output',completed:false,partial:true,project:bound.label,agent:session.agent,sessionId,observedAt:new Date().toISOString(),nextCursor:cursor,hasMore,output:voiceOutputTail(output,limit)};
  };
  const outputPosition=(v:unknown)=>{if(v===undefined)return undefined;if(!Number.isSafeInteger(v)||Number(v)<0)throw Error('출력 위치를 확인하세요.');return Number(v);};
  /**
   * The workroom a spoken request lands in. A named AI reuses its own running workroom or opens
   * one — asking for claude never silently lands on a running codex. Without a named AI the
   * newest running workroom (any AI) continues, else `fallback` opens one.
   */
  const ensureWorkroom=async(id:string,requested:AiTerminalAgent|undefined,fallback:()=>AiTerminalAgent,requestId:string)=>{
    const listed=await deps.terminal.perform({operation:'list',requestId:crypto.randomUUID()},sessionAuthority(id));
    const running=(listed.sessions??[]).filter(s=>s.targetId===id&&s.state==='running'&&(!requested||s.agent===requested)).sort(newestFirst)[0];
    if(running)return {session:running,reused:true};
    const started=await deps.terminal.perform({operation:'start',requestId,targetId:id,agent:requested??fallback(),cols:100,rows:28,bypassPermissions:false},sessionAuthority(id));
    if(!started.session)throw Error('워크룸을 연결하지 못했습니다.');
    return {session:started.session,reused:false};
  };
  /** The question a workroom's screen is waiting on (trust, approval, menu), or null when it is ready for input. */
  const pendingQuestion=async(id:string,sessionId:string)=>{
    const screen=await deps.terminal.screenText(sessionId,id).catch(()=>null);
    if(!screen||!workroomScreenAwaitsAnswer(screen.rows))return null;
    return screen.rows.map(row=>row.trim()).filter(Boolean).slice(-4).join(' / ').slice(0,300);
  };
  /**
   * Voice answers a workroom's question with named keys (VOC 2026-09-30: 「1번 눌러줘」, 「엔터」) — the same
   * keys the agentstoz_use MCP allows, so nothing that raises a worker's permissions (no Shift+Tab).
   */
  /** The voice's own last key presses, so a draft may move past exactly them and nothing a person typed. */
  let lastKeys:null|{sessionId:string;before:number;after:number;count:number}=null;
  /** The workroom whose question just refused a send: 「1번 눌러줘」 answers that one, not whoever else is connected. */
  let questionRoom:null|{id:string;sessionId:string}=null;
  const pressKeys=async(id:string,sessionId:string,keys:unknown,requestId:string)=>{
    if(!Array.isArray(keys)||keys.length<1||keys.length>6||!keys.every(isWorkroomKey))throw Error(`keys는 허용된 키 1~6개입니다: ${WORKROOM_KEY_NAMES.join(', ')}`);
    await validate();authorize(id);await deps.target(id);
    if(deps.terminal.inspectSession(sessionId,id).state!=='running')throw Error('실행 중인 워크룸이 아닙니다.');
    const modes=await deps.terminal.inputModes(sessionId,id);
    const before=deps.terminal.inspectSession(sessionId,id).inputRevision;
    for(const [index,key] of keys.entries()){
      if(index)await new Promise(r=>setTimeout(r,WORKROOM_KEY_INTERVAL_MS));
      // Enter or a digit that would choose 「No, exit」 ends the worker: never by voice (VOC 2026-09-30).
      if(key==='enter'||/^[1-9]$/.test(key)){
        if(index)await new Promise(r=>setTimeout(r,200)); // the arrow before it has to redraw first
        const screen=await deps.terminal.screenText(sessionId,id).catch(()=>null);
        const exit=screen&&workroomScreenAwaitsAnswer(screen.rows)?workroomKeyChoosesExit(screen.rows,key):null;
        if(exit){
          lastKeys=index?{sessionId,before,after:deps.terminal.inspectSession(sessionId,id).inputRevision,count:index}:lastKeys;
          throw Error(`「${key}」는 「${exit}」를 골라 워크룸 CLI를 종료시키므로 누르지 않았습니다${index?` (앞의 ${keys.slice(0,index).join(', ')}는 눌렀습니다)`:''}. enter는 ❯로 강조된 항목을 고릅니다. 사용자가 원하는 항목으로 up/down을 눌러 옮긴 뒤 enter를 누르세요(예: ["down","enter"]). 워크룸을 끝내는 것은 사용자가 세션 종료 버튼으로 합니다.`);
        }
      }
      await deps.terminal.perform({operation:'input',sessionId,requestId:requestId+'_k'+index,data:workroomKeySequence(key,modes)},sessionAuthority(id));
    }
    lastKeys={sessionId,before,after:deps.terminal.inspectSession(sessionId,id).inputRevision,count:keys.length};
    await new Promise(r=>setTimeout(r,400));
    const after=deps.terminal.inspectSession(sessionId,id);
    if(after.state!=='running'){
      if(delegate?.sessionId===sessionId){endedPartner={label:delegate.label+' · '+(VOICE_AGENT_NAMES[delegate.agent]??delegate.agent),exitCode:after.exitCode??null,told:true};delegate=null;}
      return {state:'workroom-exited',completed:true,keys,sessionId,exitCode:after.exitCode??null,
        message:`키를 누른 뒤 워크룸 CLI가 종료되었습니다(종료 코드 ${after.exitCode??'확인 중'}). 사용자에게 그대로 알리세요. 다시 쓰려면 그 프로젝트 담당자를 다시 부르면 새 워크룸이 열립니다.`};
    }
    const screen=await deps.terminal.screenText(sessionId,id).catch(()=>null);
    return {state:'keys-sent',completed:false,keys,sessionId,screen:screen?screen.rows.map(row=>row.trimEnd()).filter(row=>row.trim()).slice(-8).join('\n').slice(0,1500):null,
      message:'키를 눌렀습니다. 화면이 바뀌었는지 screen으로 확인해 설명하세요.'};
  };
  const reviewWorkroom=async(targetValue:string,sessionValue:string)=>{
    const id=identifier(targetValue),sessionId=identifier(sessionValue);
    await validate();authorize(id);const bound=await deps.target(id);
    const s=deps.terminal.inspectSession(sessionId,id);let revision=s.inputRevision;
    if(s.state!=='running')throw Error('실행 중인 워크룸을 선택하세요.');
    let submittedAfter:number|undefined,observedAfter:number|undefined;
    return {label:bound.label+' · '+s.agent,agent:s.agent,targetId:id,sessionId,rebase:()=>{const k=lastKeys;lastKeys=null;
      // Only when every input since the draft was this voice's own keys; a person's typing still blocks the send.
      if(k&&k.sessionId===sessionId&&k.before===revision&&k.after===k.before+k.count&&deps.terminal.inspectSession(sessionId,id).inputRevision===k.after)revision=k.after;},send:async(text:string,requestId:string,active:()=>boolean,references?:readonly string[])=>{
      await validate();authorize(id);
      // # 언급 folders: each one registered and allowed to this voice, like the workroom's own # 참고.
      const refs=[...new Set(references??[])].filter(ref=>ref!==id);for(const ref of refs){authorize(ref);await deps.target(ref);}
      if((await deps.target(id)).fingerprint!==bound.fingerprint||!active())throw Error('음성 지시 대상이 변경되었습니다.');
      // Never type into a question: the Enter at the end would answer it (trust, approval, y/n).
      const question=await pendingQuestion(id,sessionId);
      if(question){questionRoom={id,sessionId};throw Error(`워크룸이 질문에 답을 기다리고 있어 보내지 않았습니다: 「${question}」 먼저 답하세요(예: 「1번 눌러줘」, 「엔터」).`);}
      if(questionRoom?.sessionId===sessionId)questionRoom=null;
      submittedAfter=deps.terminal.inspectSession(sessionId,id).outputCursor;
      observedAfter=submittedAfter;
      await deps.terminal.perform({operation:'input',sessionId,requestId,data:voiceText(text).replace(/[\n\t]+/g,' ')+'\r',expectedInputRevision:revision,...(refs.length?{references:refs}:{})},
        {...sessionAuthority(id),targets:new Set([id,...refs]),isActive:()=>a.active()&&active()});
    },observe:async()=>{
      if(submittedAfter===undefined)throw Error('워크룸 입력 전의 출력 위치를 확인할 수 없습니다.');
      const result=await read(id,sessionId,observedAfter??submittedAfter);
      observedAfter=result.nextCursor;
      return result;
    }};
  };
  const review=target.kind==='workroom'?async(_text:string)=>reviewWorkroom(target.targetId,target.sessionId):undefined;
  let delegate:null|{targetId:string;label:string;fingerprint:string;sessionId:string;agent:AiTerminalAgent}=null;
  /** The partner whose workroom CLI ended (a wrong trust answer, /exit): the dock falls back to the 총괄. */
  let endedPartner:null|{label:string;exitCode:number|null;told:boolean}=null;
  const delegateAlive=()=>{
    if(!delegate)return;let state:{state:string;exitCode?:number|null}|null=null;
    try{state=deps.terminal.inspectSession(delegate.sessionId,delegate.targetId);}catch{state=null;}
    if(state?.state==='running')return;
    endedPartner={label:delegate.label+' · '+(VOICE_AGENT_NAMES[delegate.agent]??delegate.agent),exitCode:state?.exitCode??null,told:false};delegate=null;
  };
  /** The OPS workroom the last OPS draft aims at, so its trust/approval question can be answered by voice too. */
  let opsWorkroom:null|{id:string;sessionId:string}=null;
  const currentDelegate=async()=>{
    if(!delegate)throw Error('먼저 프로젝트 담당자를 연결하세요.');
    await validate();authorize(delegate.targetId);const current=await deps.target(delegate.targetId);
    const session=deps.terminal.inspectSession(delegate.sessionId,delegate.targetId);
    if(current.fingerprint!==delegate.fingerprint||session.state!=='running')throw Error('연결한 프로젝트 담당자 워크룸이 변경되거나 종료되었습니다. 다시 연결하세요.');
    return {...delegate,session};
  };
  // OPS default AI: the OPS workroom already running (any AI) → the AI this device last opened OPS with → codex.
  const reviewOps=ops?async(agent?:AiTerminalAgent)=>{
    if(!ops.projectId)throw Error('OPS 채팅을 사용하려면 등록된 Control 운영 프로젝트를 연결하세요.');
    const id=ops.projectId;authorize(id);await deps.target(id);
    const requested=agent===undefined?undefined:voiceAgent(agent);
    const saved=deps.opsAgent?.(),remembered=saved&&AI_TERMINAL_AGENTS.includes(saved)?saved:'codex';
    try{
      const {session,reused}=await ensureWorkroom(id,requested,()=>remembered,crypto.randomUUID());opsWorkroom={id,sessionId:session.id};
      return {...await reviewWorkroom(id,session.id),reused};
    }catch(error){
      // The remembered AI is also recorded when OPS was opened in a desktop app, so its CLI may be
      // missing here. Only that remembered choice falls back to codex; an AI the person named is
      // never swapped silently, and the result says which AI could not start.
      if(requested!==undefined||remembered==='codex')throw error;
      const {session,reused}=await ensureWorkroom(id,undefined,()=>'codex',crypto.randomUUID());opsWorkroom={id,sessionId:session.id};
      return {...await reviewWorkroom(id,session.id),reused,...(session.agent==='codex'?{fallbackFrom:remembered}:{})};
    }
  }:undefined;
  const tools:VoiceTool[]=ops?[
    {name:'list_projects',description:'허용된 등록 프로젝트·워크트리를 한 번에 최대 40개씩 봅니다. query로 이름·별명을 검색하고(대소문자·공백 무시), nextOffset이 있으면 offset으로 이어 봅니다. total이 전체 개수입니다.',parameters:parameters({query:text,offset:position},[])},
    {name:'resolve_target_alias',description:'음성·채팅 공통 호칭을 현재 OPS, DEV 프로젝트 또는 이름이 지정된 프로젝트로 확정합니다. alias에는 동사 없이 이름(필요하면 담당자)만 넣습니다. resolved:false이면 candidates에서 발음이 같은 정확한 이름(예: 바이브2 → vibe2)으로 다시 호출하고, 확실하지 않으면 사용자에게 확인합니다. 호칭만으로 작업을 실행하지 않습니다.',parameters:parameters({alias:text})},
    {name:'connect_project_delegate',description:'resolve_target_alias로 확정한 프로젝트 담당자에게 전환합니다. agent를 주면 그 AI의 실행 중 워크룸을 재사용하고, 없으면 그 AI로 새 워크룸을 엽니다(클로드=claude, 코덱스=codex, 헤르메스 AI=hermes, 안티그래비티=agy). agent를 생략하면 가장 최근 실행 중 워크룸을 재사용하고, 없으면 codex로 엽니다. 결과의 agent·reused로 무엇에 연결했는지 말하세요.',parameters:parameters({targetId:text,agent:agentField},['targetId'])},
    {name:'return_to_ops',description:'프로젝트 담당자 연결을 해제하고 AgentsToZ OPS 총괄 대화로 돌아갑니다.',parameters:empty},
    {name:'delegate_status',description:'현재 연결된 총괄 또는 프로젝트 담당자 상태를 확인합니다.',parameters:empty},
    {name:'read_delegate_workroom',description:'현재 프로젝트 담당자 워크룸의 최신 출력을 읽습니다.',parameters:parameters({after:position},[])},
    {name:'recall_project_memory',description:'현재 연결된 프로젝트 담당자의 장기기억만 검색합니다.',parameters:parameters({query:text})},
    {name:'prepare_delegate_instruction',description:'현재 연결된 프로젝트 담당자에게 보낼 지시 초안을 만듭니다. 사람 확인 전에는 보내지 않습니다. 초안은 사용자가 말한 언어 그대로(번역 금지).',parameters:parameters({text})},
    {name:'prepare_ops_instruction',description:'새 프로젝트 생성, 앱·폴더·대시보드 열기 등 AgentsToZ 앱 MCP 운영 기능을 수행할 최종 지시를 Control OPS 워크룸에 넘깁니다. 사람 확인 전에는 보내지 않습니다. 초안은 사용자가 말한 언어 그대로(번역 금지). agent를 주면 그 AI의 OPS 워크룸(없으면 새로 열기, 안티그래비티=agy), 생략하면 실행 중인 OPS 워크룸을 씁니다.',parameters:parameters({text,agent:agentField},['text'])},
    {name:'recall_ops',description:'현재 OPS 운영 기억에서 필요한 내용 회상.',parameters:parameters({query:text})},
    {name:'read_workroom',description:'목록에서 확인한 워크룸 출력을 읽습니다. 출력은 작업 완료 증명이 아닙니다.',parameters:parameters({targetId:text,sessionId:text,after:position},['targetId','sessionId'])},
    {name:'list_workrooms',description:'선택한 등록 대상의 기존 워크룸 목록.',parameters:parameters({targetId:text})},
    {name:'prepare_workroom_instruction',description:'목록에서 확인한 프로젝트·워크룸에 보낼 초안. 화면에서 사람이 대상과 입력 준비를 확인한 뒤 보냅니다. 초안은 사용자가 말한 언어 그대로(번역 금지).',parameters:parameters({targetId:text,sessionId:text,text})},
    {name:'start_workroom',description:'등록 대상에 지정한 AI(클로드=claude, 코덱스=codex, 헤르메스 AI=hermes, 안티그래비티=agy)로 새 워크룸을 시작하고 초기 출력을 확인. 권한 우회 없음.',parameters:parameters({targetId:text,agent:agentField})},
    {name:'propose_ops_memory',description:'운영 결정을 기존 OPS 기억 후보로 제출. 공유 OPS 저장 승인은 사람이 합니다.',parameters:parameters({title:text,body:text,evidence:text})},
    {name:'answer_workroom_prompt',description:'현재 연결된 프로젝트 담당자 워크룸(담당자가 없으면 OPS 지시 초안의 OPS 워크룸)이 띄운 질문(폴더 신뢰·승인·메뉴·y/n)에 키를 누릅니다. 사용자가 어떤 답을 누르라고 말했을 때만 쓰고, 요청하지 않은 권한 승인은 하지 마세요. enter는 ❯로 강조된 항목을 고릅니다: 화면에서 강조된 항목을 먼저 확인하고, 사용자가 원하는 항목이 아니면 up/down으로 옮긴 뒤 enter(예: 강조가 「No, exit」인데 신뢰하라면 ["down","enter"]). 번호 없는 목록에는 숫자 키를 쓰지 마세요. 워크룸을 종료시키는 항목(exit)은 누르지 않습니다. 예: 「1번」=["1"], 「엔터」=["enter"].',parameters:parameters({keys:{type:'array',items:{type:'string',enum:[...WORKROOM_KEY_NAMES]},minItems:1,maxItems:6}})},
  ]:[
    {name:'read_workroom',description:'현재 프로젝트와 작업 상태 질문에 반드시 사용하세요. after 생략 시 최신 출력, 지정 시 해당 위치 이후 출력. 출력만으로 완료를 단정하지 마세요.',parameters:parameters({after:position},[])},
    {name:'recall_project_memory',description:'현재 연결된 프로젝트의 장기기억에서 결정·제약·과거 교훈을 검색합니다. 다른 프로젝트 기억은 조회하지 않습니다.',parameters:parameters({query:text})},
    {name:'answer_workroom_prompt',description:'이 워크룸이 띄운 질문(폴더 신뢰·승인·메뉴·y/n)에 키를 누릅니다. 사용자가 어떤 답을 누르라고 말했을 때만 쓰세요. enter는 ❯로 강조된 항목을 고릅니다. 원하는 항목이 강조돼 있지 않으면 up/down으로 옮긴 뒤 enter를 누르고, 번호 없는 목록에는 숫자 키를 쓰지 마세요. 워크룸을 종료시키는 항목(exit)은 누르지 않습니다.',parameters:parameters({keys:{type:'array',items:{type:'string',enum:[...WORKROOM_KEY_NAMES]},minItems:1,maxItems:6}})},
  ];
  if(ops&&deps.focusProject)tools.push({name:'open_project',description:'resolve_target_alias로 확정한 프로젝트를 AgentsToZ 앱의 프로젝트 화면에 띄웁니다(“<프로젝트> 열어”, “<프로젝트> 보여줘”). 선택과 화면 이동만 하고 워크룸이나 AI는 실행하지 않습니다.',parameters:parameters({targetId:text})});
  if(!ops&&initial?.opsMemoryFingerprint)tools.push(
    {name:'recall_ops',description:'상단 OPS 음성과 동일한 운영 기억을 조회합니다.',parameters:parameters({query:text})},
    {name:'propose_ops_memory',description:'같은 OPS 운영 기억에 결정을 후보로 제출합니다. 공유 기억은 사람이 검토합니다.',parameters:parameters({title:text,body:text,evidence:text})});
  // The voice dock (VOC 2026-09-29): the 총괄 plus the running workrooms a tap can switch to. The OPS
  // project's own workrooms are the 총괄's hands, not someone to talk to directly, so they are left out.
  const partners=ops?async():Promise<VoiceActiveTarget[]>=>{
    await validate();
    const entries=(await allowedTargets()).filter(t=>t.id!==ops.projectId),ids=new Set(entries.map(t=>t.id));
    const listed=ids.size?await deps.terminal.perform({operation:'list',requestId:crypto.randomUUID()},{owner:a.owner,targets:ids,isActive:a.active,deviceConsentActive:a.active}):{sessions:[]};
    const out:VoiceActiveTarget[]=[{kind:'ops',label:'AgentsToZ OPS'}];
    const running=(listed.sessions??[]).filter(s=>s.state==='running'&&ids.has(s.targetId));
    // Two workrooms of one project and AI read 「vibe2 #1」「vibe2 #2」 in start order, like the Workroom tabs.
    const ordinal=new Map<string,string>(),groups=new Map<string,AiTerminalSummary[]>();
    for(const s of running){const k=s.targetId+'\u0000'+s.agent;groups.set(k,[...(groups.get(k)??[]),s]);}
    for(const group of groups.values())if(group.length>1)[...group].sort((x,y)=>Date.parse(x.createdAt)-Date.parse(y.createdAt)||x.id.localeCompare(y.id)).forEach((s,i)=>ordinal.set(s.id,` #${i+1}`));
    for(const s of [...running].sort(newestFirst)){
      if(out.length>=VOICE_MAX_PARTNERS)break;
      out.push({kind:'workroom',label:(await deps.target(s.targetId)).label+(ordinal.get(s.id)??''),targetId:s.targetId,sessionId:s.id,agent:s.agent});
    }
    await validate();return out;
  }:undefined;
  /** A tap on the dock: exactly what return_to_ops / connect_project_delegate do, for one chosen workroom. */
  /** ⋯ in the dock: any allowed project (the 총괄's own OPS project is not someone to talk to). */
  const searchProjectsPage=ops?async(wanted?:string,offset=0)=>{
    await validate();
    const page=pageConversationTargets((await allowedTargets()).filter(t=>t.id!==ops.projectId),{query:wanted?.trim()||undefined,offset,limit:VOICE_MAX_PROJECT_CHOICES,present:entry=>({id:entry.id,label:spoken(entry.name)})});
    return {projects:page.projects,total:page.total,nextOffset:page.nextOffset};
  }:undefined;
  const searchProjects=searchProjectsPage?async(wanted?:string):Promise<VoiceProjectChoice[]>=>
    (await searchProjectsPage(wanted)).projects:undefined;
  const switchPartner=ops?async(to:VoicePartner):Promise<VoiceActiveTarget>=>{
    await validate();
    if(to.kind==='ops'){delegate=null;return {kind:'ops',label:'AgentsToZ OPS'};}
    if(to.kind==='project'){
      // The same rule as 「<프로젝트> 담당자 불러」: the named AI's running workroom, else any running one, else a new one.
      const id=identifier(to.targetId);authorize(id);if(id===ops.projectId)throw Error('총괄은 「총괄」 버튼으로 고르세요.');
      const bound=await deps.target(id);
      const {session}=await ensureWorkroom(id,to.agent===undefined?undefined:voiceAgent(to.agent),()=>'codex',crypto.randomUUID());
      const confirmed=await deps.target(id);if(confirmed.fingerprint!==bound.fingerprint)throw Error('프로젝트 연결이 변경되었습니다. 다시 시도하세요.');
      delegate={targetId:id,label:confirmed.label,fingerprint:confirmed.fingerprint,sessionId:session.id,agent:session.agent};
      return {kind:'workroom',label:confirmed.label,targetId:id,sessionId:session.id,agent:session.agent};
    }
    // A phone names a workroom by its own control id; the session id is the same everywhere, so the
    // workroom is found by session among the allowed projects and its real project id is checked.
    const sessionId=identifier(to.sessionId);identifier(to.targetId);
    const allowed=(await allowedTargets()).map(t=>t.id);
    const listed=allowed.length?await deps.terminal.perform({operation:'list',requestId:crypto.randomUUID()},{owner:a.owner,targets:new Set(allowed),isActive:a.active,deviceConsentActive:a.active}):{sessions:[]};
    const found=(listed.sessions??[]).find(s=>s.id===sessionId&&s.state==='running');
    if(!found)throw Error('실행 중인 워크룸을 선택하세요. 이 음성 연결에 허용된 프로젝트인지도 확인하세요.');
    const id=found.targetId;authorize(id);const bound=await deps.target(id);
    const session=deps.terminal.inspectSession(sessionId,id);
    if(session.state!=='running')throw Error('실행 중인 워크룸을 선택하세요.');
    const confirmed=await deps.target(id);if(confirmed.fingerprint!==bound.fingerprint)throw Error('프로젝트 연결이 변경되었습니다. 다시 시도하세요.');
    delegate={targetId:id,label:confirmed.label,fingerprint:confirmed.fingerprint,sessionId,agent:session.agent};
    return {kind:'workroom',label:confirmed.label,targetId:id,sessionId,agent:session.agent};
  }:undefined;
  return {key:ops?'ops:'+ops.fingerprint:'workroom:'+terminal!.id,label:ops?'AgentsToZ OPS':initial!.label+' · '+terminal!.agent,validate,tools,review,reviewOps,reviewWorkroom:ops?reviewWorkroom:undefined,partners,switchPartner,searchProjects,searchProjectsPage,
    mentions:ops?async(ids:readonly string[])=>{
      await validate();const out:{id:string;label:string}[]=[];
      for(const value of ids){const ref=identifier(value);authorize(ref);out.push({id:ref,label:(await deps.target(ref)).label});}
      return out;
    }:undefined,
    routeInput:ops?async(value:string,text:string,references:readonly string[]|undefined,requestId:string,active:()=>boolean)=>{
      await validate();const id=identifier(value);authorize(id);
      if(id===ops.projectId)throw Error('총괄에게는 @ 없이 입력하세요.');
      const bound=await deps.target(id);
      const listed=await deps.terminal.perform({operation:'list',requestId:crypto.randomUUID()},sessionAuthority(id));
      const running=(listed.sessions??[]).filter(s=>s.targetId===id&&s.state==='running').sort(newestFirst)[0];
      if(running){const review=await reviewWorkroom(id,running.id);await review.send(text,requestId,active,references);return {label:bound.label,targetId:id,sessionId:running.id,agent:running.agent,review};}
      // No workroom yet: the words are its first request, never typed into a CLI still showing trust or login.
      const refs=[...new Set(references??[])].filter(ref=>ref!==id);for(const ref of refs){authorize(ref);await deps.target(ref);}
      if(!active())throw Error('음성 연결이 종료되었습니다.');
      const started=await deps.terminal.perform({operation:'start',requestId,targetId:id,agent:'codex',cols:100,rows:28,bypassPermissions:false,prompt:voiceText(text),...(refs.length?{references:refs}:{})},
        {...sessionAuthority(id),targets:new Set([id,...refs])});
      if(!started.session)throw Error('워크룸을 열지 못했습니다.');
      return {label:bound.label,targetId:id,sessionId:started.session.id,agent:started.session.agent};
    }:undefined,
    takeEndedPartner:()=>{delegateAlive();const ended=endedPartner;endedPartner=null;return ended;},
    activeTarget:():VoiceActiveTarget=>{delegateAlive();return delegate?{kind:'workroom',label:delegate.label,targetId:delegate.targetId,sessionId:delegate.sessionId,agent:delegate.agent}:ops?{kind:'ops',label:'AgentsToZ OPS'}:{kind:'workroom',label:initial!.label,targetId:target.kind==='workroom'?target.targetId:'',sessionId:target.kind==='workroom'?target.sessionId:'',agent:terminal!.agent};},
    context:async()=>{
      await validate();
      if(target.kind==='workroom')return {kind:'workroom',...await read(target.targetId,target.sessionId),...(initial?.opsMemoryFingerprint?{memoryScope:'same OPS operating memory',operatingMemory:voiceOutput(JSON.stringify(deps.recall('운영 결정 선호 규칙')))}:{})};
      // A compact map, not the inventory: 150 projects made the start context the largest thing the
      // model read. The full list is one list_projects(query) away.
      const entries=await allowedTargets(),mains=entries.filter(t=>t.scope==='main'),names=new Map(entries.map(t=>[t.id,t.name]));
      const brief=(t:ConversationDirectoryEntry)=>({id:t.id,name:spoken(t.name)});
      const listed=entries.length?await deps.terminal.perform({operation:'list',requestId:crypto.randomUUID()},{owner:a.owner,targets:new Set(entries.map(t=>t.id)),isActive:a.active,deviceConsentActive:a.active}):{sessions:[]};
      const running=(listed.sessions??[]).filter(s=>s.state==='running'&&names.has(s.targetId)).sort(newestFirst).slice(0,12)
        .map(s=>({targetId:s.targetId,name:spoken(names.get(s.targetId)!),agent:s.agent,sessionId:s.id}));
      await validate();
      return {kind:'ops',project:'AgentsToZ OPS',counts:{projects:mains.length,worktrees:entries.length-mains.length,runningWorkrooms:running.length},
        ops:mains.filter(t=>t.role==='ops').slice(0,4).map(brief),dev:mains.filter(t=>t.role==='dev').slice(0,4).map(brief),running,
        hint:'전체 프로젝트 목록은 싣지 않았습니다. 프로젝트를 찾을 때는 list_projects(query)로 이름·별명을 검색하거나 resolve_target_alias로 확정하세요.',
        partial:true,observedAt:new Date().toISOString()};
    },
    run:async(name,args,requestId)=>{
      await validate();
      if(name==='list_projects'&&ops){
        fields(args,['query','offset']);
        const wanted=args.query===undefined?undefined:query(args.query),offset=outputPosition(args.offset)??0;
        const page=pageConversationTargets(await allowedTargets(),{query:wanted,offset,present:presentTarget});
        return {total:page.total,offset:page.offset,nextOffset:page.nextOffset,count:page.projects.length,...(wanted?{query:wanted}:{}),projects:page.projects};
      }
      if(name==='resolve_target_alias'&&ops){
        fields(args,['alias']);
        // A miss hands the model the exact names instead of a bare failure: a spoken 「바이브2」 is vibe2,
        // and only the model can make that mapping (then confirm it with the user if unsure).
        const outcome=resolveConversationTarget(query(args.alias),await allowedTargets());
        return outcome.resolved?outcome:voiceTargetMiss(outcome);
      }
      if(name==='connect_project_delegate'&&ops){
        fields(args,['targetId','agent']);const id=identifier(args.targetId);authorize(id);const bound=await deps.target(id);
        const requested=args.agent===undefined?undefined:voiceAgent(args.agent);
        const {session,reused}=await ensureWorkroom(id,requested,()=>'codex',requestId);
        const confirmed=await deps.target(id);if(confirmed.fingerprint!==bound.fingerprint)throw Error('프로젝트 연결이 변경되었습니다. 다시 시도하세요.');
        delegate={targetId:id,label:confirmed.label,fingerprint:confirmed.fingerprint,sessionId:session.id,agent:session.agent};
        return {state:'delegate-connected',completed:false,agent:session.agent,reused,activeTarget:{kind:'workroom',label:confirmed.label,targetId:id,sessionId:session.id,agent:session.agent},initialOutput:await read(id,session.id,undefined,VOICE_DELEGATE_OUTPUT),
          message:(reused?`${confirmed.label} 프로젝트 담당자(${session.agent}) 워크룸에 연결했습니다.`:`${confirmed.label} 프로젝트 담당자를 ${session.agent} 새 워크룸으로 열었습니다. 로그인·폴더 신뢰 화면이 보이면 사용자에게 확인하세요.`)+' 이제 사용자의 말과 입력은 이 워크룸에 그대로 입력되고, 당신은 관찰된 출력만 요약해 말합니다.'};
      }
      if(name==='open_project'&&ops&&deps.focusProject){
        fields(args,['targetId']);const id=identifier(args.targetId);authorize(id);const bound=await deps.target(id);
        await deps.focusProject(id);
        return {state:'project-opened',completed:true,targetId:id,project:bound.label,message:`AgentsToZ 앱에서 ${bound.label} 프로젝트 화면을 열었습니다. 워크룸이나 AI는 실행하지 않았습니다.`};
      }
      if(name==='return_to_ops'&&ops){fields(args,[]);delegate=null;return {state:'ops-active',completed:true,activeTarget:{kind:'ops',label:'AgentsToZ OPS'},message:'AgentsToZ OPS 총괄로 돌아왔습니다.'};}
      if(name==='delegate_status'&&ops){fields(args,[]);if(!delegate)return {state:'ops-active',activeTarget:{kind:'ops',label:'AgentsToZ OPS'}};const d=await currentDelegate();return {state:'delegate-connected',activeTarget:{kind:'workroom',label:d.label,targetId:d.targetId,sessionId:d.sessionId,agent:d.agent}};}
      if(name==='read_delegate_workroom'&&ops){fields(args,['after']);const d=await currentDelegate();return read(d.targetId,d.sessionId,outputPosition(args.after));}
      if(name==='recall_project_memory'&&ops){fields(args,['query']);const d=await currentDelegate();const result=await deps.projectRecall(d.targetId,query(args.query));await currentDelegate();return result;}
      if(name==='recall_ops'&&(ops||initial?.opsMemoryFingerprint)){fields(args,['query']);return deps.recall(query(args.query));}
      if(name==='recall_project_memory'&&target.kind==='workroom'){fields(args,['query']);await validate();const result=await deps.projectRecall(target.targetId,query(args.query));await validate();return result;}
      if(name==='propose_ops_memory'&&(ops||initial?.opsMemoryFingerprint)){
        fields(args,['title','body','evidence']);
        // Native/SAS human review is not a voice tool. LAN may not promote OPS memory.
        if(a.owner!=='local')throw Error('운영 기억 후보는 Mac OPS에서 제출하세요.');
        return deps.propose({title:query(args.title),body:voiceText(args.body),evidence:voiceText(args.evidence),requestId});
      }
      if(name==='list_workrooms'&&ops){fields(args,['targetId']);const id=identifier(args.targetId);authorize(id);await deps.target(id);const r=await deps.terminal.perform({operation:'list',requestId},sessionAuthority(id));return r.sessions;}
      if(name==='start_workroom'&&ops){
        fields(args,['targetId','agent']);const id=identifier(args.targetId);authorize(id);const bound=await deps.target(id);
        const agent=voiceAgent(args.agent);
        const r=await deps.terminal.perform({operation:'start',requestId,targetId:id,agent,cols:100,rows:28,bypassPermissions:false},sessionAuthority(id));
        return {state:'started',completed:false,project:bound.label,session:r.session,initialOutput:r.session?await read(id,r.session.id,0):null,message:'워크룸을 열었습니다. 로그인·폴더 신뢰 화면이 보이면 사용자에게 확인하세요. 이 워크룸 담당자와 이어서 말하려면 connect_project_delegate로 전환하세요. 사용자는 음성 도크의 대화 상대 버튼으로도 바꿀 수 있습니다.'};
      }
      if(name==='answer_workroom_prompt'){
        fields(args,['keys']);
        if(ops){
          const q=questionRoom;
          if(q&&deps.terminal.inspectSession(q.sessionId,q.id).state==='running'&&await pendingQuestion(q.id,q.sessionId))return pressKeys(q.id,q.sessionId,args.keys,requestId);
          if(delegate){const d=await currentDelegate();return pressKeys(d.targetId,d.sessionId,args.keys,requestId);}
          if(opsWorkroom)return pressKeys(opsWorkroom.id,opsWorkroom.sessionId,args.keys,requestId);
          throw Error('먼저 프로젝트 담당자를 연결하거나 OPS 지시 초안을 만드세요. 총괄 상태에서는 워크룸 키를 누르지 않습니다.');
        }
        if(target.kind==='workroom')return pressKeys(target.targetId,target.sessionId,args.keys,requestId);
      }
      if(name==='read_workroom'&&ops){fields(args,['targetId','sessionId','after']);return read(identifier(args.targetId),identifier(args.sessionId),outputPosition(args.after));}
      if(name==='read_workroom'&&target.kind==='workroom'){fields(args,['after']);return read(target.targetId,target.sessionId,outputPosition(args.after));}
      throw Error('허용되지 않은 음성 도구입니다.');
    }};
}
