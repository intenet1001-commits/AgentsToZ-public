import {validVoiceHistoryPage,validVoiceHistoryDetail,validVoiceRecordStatus,type VoiceHistoryPage,type VoiceHistoryDetail,type VoiceRecordStatus} from './voiceHistoryProtocol';
/** Shared, bounded wire contract. Provider credentials and filesystem paths never belong here. */
export const VOICE_ENDPOINT = '/api/agent-runtime/voice';
export const VOICE_FEATURE = 'voice-v1';
export const VOICE_MAX_SDP_BYTES = 24_000;
export const VOICE_MAX_TEXT_BYTES = 4_000;
/** A conversation ends normally at its 15-minute limit; saved speech stays a complete record. */
export const VOICE_TIME_LIMIT_NOTICE = '15분 음성 대화를 마쳤습니다. 저장한 발언은 내가 한 말에 남아 있고, 새 대화를 시작할 수 있습니다.';
/** The host counts the limit from prepare; the client ends this much earlier so the end is its own clean stop. */
export const VOICE_CONVERSATION_LIMIT_MS = 15*60_000;
export const VOICE_CLIENT_LIMIT_MARGIN_MS = 2_000;
/** The host's notice after typing an instruction into a workroom; the workroom shows it under its input box. */
/** How the dock, notices and the model name each AI — one table so a notice says what the dock shows. */
export const VOICE_AGENT_NAMES:Record<string,string>={codex:'Codex',claude:'Claude',hermes:'Hermes',agy:'Antigravity'};
export const VOICE_SENT_NOTICE = '아젠투지가 워크룸에 보냄';
export type VoiceMode = 'dictation' | 'conversation';
export type VoiceProvider = 'openai' | 'gemini';
export type VoiceTarget = {kind:'ops'} | {kind:'workroom';targetId:string;sessionId:string};
/** Who a tap on the dock switches to. `project` reuses the named AI's running workroom (any AI when unnamed) or opens one. */
export type VoicePartner = VoiceTarget | {kind:'project';targetId:string;agent?:'codex'|'claude'|'hermes'|'agy'};
/** One row of the dock's project picker: no path, bounded. */
export interface VoiceProjectChoice {id:string;label:string}
export const VOICE_MAX_PROJECT_CHOICES=12;
export interface VoiceProjectPage {projects:VoiceProjectChoice[];total:number;nextOffset:number|null}
/** # 언급 in one typed message (the workroom input's own # limit). */
export const VOICE_MAX_REFERENCES=8;
export type VoiceActiveTarget = {kind:'ops';label:string} | {kind:'workroom';label:string;targetId:string;sessionId:string;agent:'codex'|'claude'|'hermes'|'agy'};
export type VoiceAction = 'capabilities' | 'configure' | 'prepare' | 'connect' | 'media.connect' | 'media.append' | 'media.read' | 'media.end' | 'state' | 'stop' | 'submit' | 'discard' | 'signal.append' | 'signal.connect' | 'signal.read' | 'history.list' | 'history.read' | 'history.review'|'history.remember'|'history.memory-status'
  /** The voice dock (VOC 2026-09-29): who can answer, a tap that switches, and a two-language subtitle line. */
  | 'partners' | 'partner' | 'caption'
  /** ⋯ in the dock: allowed projects to pick from (query in `text`). */
  | 'projects'
  | 'projects.page'
  /** Typed in the dock: said to whoever is answering, answered aloud. */
  | 'say'
  /** Asks whether this Mac relays 담당자 conversations (an older Mac refuses it, so the dock does not promise it). */
  | 'relay';
export interface VoiceRequest {
  action:VoiceAction; requestId:string;
  recordConsent?:boolean; interrupted?:boolean; before?:string; cursor?:string;
  /** history.list: 'ops' (아젠투지) or one workroom target id. */
  scope?:string;
  target?:VoiceTarget; mode?:VoiceMode;
  /** say: # 언급 — registered projects the typed words mean (the 총괄 gets their exact ids, a workroom their folders). */
  references?:string[];
  /** say: @ 호출 — this one message goes into that project's workroom; the partner stays the same. */
  route?:string;
  /** partner: the 총괄, one running workroom session, or a project (its running workroom, else a new one). */
  partner?:VoicePartner; provider?:VoiceProvider; consent?:boolean; sessionId?:string; sdp?:string; audio?:string;
  part?:number; parts?:number; chunk?:string; draftId?:string; text?:string; inputReady?:boolean; apiKey?:string; model?:string; voice?:string; removeKey?:boolean;
  offset?:number;
}
export interface VoiceDraft {id:string;text:string;label:string}
export interface VoiceSnapshot {
  id:string; state:'prepared'|'connecting'|'active'|'ended'|'failed'; mode:VoiceMode; provider:VoiceProvider; label:string;
  activeTarget?:VoiceActiveTarget;
  /** Most recent Workroom opened by this voice session. The event id prevents repeated pop-outs on state polling. */
  openedWorkroom?:Extract<VoiceActiveTarget,{kind:'workroom'}>&{eventId:string};
  recording?:VoiceRecordStatus;
  draft:VoiceDraft|null; notice:string; expiresAt:number;
}
/** One subtitle line: what was said and its translation into the other language. */
export interface VoiceCaption {text:string;translation:string;source:'ko'|'en'}
/** The 총괄 plus running workrooms the dock can switch to (the 총괄 first). */
export const VOICE_MAX_PARTNERS=9;
export interface VoiceResponse {
  partners?:VoiceActiveTarget[]; caption?:VoiceCaption; projects?:VoiceProjectChoice[]; projectPage?:VoiceProjectPage;
  historySupported?:boolean; history?:VoiceHistoryPage; detail?:VoiceHistoryDetail; reviewMessage?:string;
  configured?:boolean; model?:string; voice?:string; keySource?:'environment'|'keychain'|'none';
  providers?:Partial<Record<VoiceProvider,{configured:boolean;model:string;keySource?:'environment'|'keychain'|'encrypted'|'none'}>>;
  session?:VoiceSnapshot; sdp?:string; chunk?:string; part?:number; parts?:number; media?:VoiceMediaEvent[];
}
export type VoiceMediaEvent={kind:'audio';data:string}|{kind:'input-transcript'|'output-transcript';text:string;final:boolean}|{kind:'interrupted'};
const id=(x:unknown):x is string=>typeof x==='string'&&/^[A-Za-z0-9_-]{8,160}$/.test(x);
const size=(x:string)=>new TextEncoder().encode(x).length;
const base64Bytes=(x:string)=>Math.floor(x.length*3/4)-(x.endsWith('==')?2:x.endsWith('=')?1:0);
const object=(x:unknown):x is Record<string,unknown>=>!!x&&typeof x==='object'&&!Array.isArray(x);
export function voiceText(x:unknown):string {
  if(typeof x!=='string'||!x.trim()||size(x)>VOICE_MAX_TEXT_BYTES||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(x))throw new Error('음성 지시는 제어 문자 없이 4,000바이트 이하로 입력하세요.');
  return x.replace(/\r\n?/g,'\n').trim();
}
export function normalizeVoiceTarget(x:unknown):VoiceTarget {
  if(!object(x))throw new Error('음성 대상을 확인하세요.');
  if(x.kind==='ops'&&Object.keys(x).length===1)return {kind:'ops'};
  if(x.kind==='workroom'&&id(x.targetId)&&id(x.sessionId)&&Object.keys(x).every(k=>['kind','targetId','sessionId'].includes(k)))return {kind:'workroom',targetId:x.targetId,sessionId:x.sessionId};
  throw new Error('현재 워크룸 음성 대상을 확인하세요.');
}
export function normalizeVoicePartner(x:unknown):VoicePartner {
  if(object(x)&&x.kind==='project'){
    if(!id(x.targetId)||Object.keys(x).some(k=>!['kind','targetId','agent'].includes(k))||x.agent!==undefined&&!['codex','claude','hermes','agy'].includes(x.agent as string))throw new Error('대화 상대로 고른 프로젝트를 확인하세요.');
    return {kind:'project',targetId:x.targetId,...(x.agent===undefined?{}:{agent:x.agent as 'codex'|'claude'|'hermes'|'agy'})};
  }
  return normalizeVoiceTarget(x);
}
export function normalizeVoiceRequest(value:unknown):VoiceRequest {
  if(!object(value)||!id(value.requestId))throw new Error('음성 요청 형식이 올바르지 않습니다.');
  const fields:Record<VoiceAction,string[]>={capabilities:[],configure:['provider','apiKey','model','voice','removeKey'],prepare:['target','mode','provider','consent','recordConsent'],connect:['sessionId','sdp'],'media.connect':['sessionId'],'media.append':['sessionId','audio'],'media.read':['sessionId'],'media.end':['sessionId'],state:['sessionId'],stop:['sessionId','interrupted'],submit:['sessionId','draftId','text','inputReady'],discard:['sessionId','draftId'],'signal.append':['sessionId','part','parts','chunk'],'signal.connect':['sessionId'],'signal.read':['sessionId','part'],'history.list':['before','scope'],'history.read':['sessionId','cursor'],'history.review':['sessionId','text'],'history.remember':['sessionId'],'history.memory-status':['sessionId'],partners:['sessionId'],partner:['sessionId','partner'],caption:['sessionId','text'],projects:['sessionId','text'],'projects.page':['sessionId','text','offset'],say:['sessionId','text','references','route'],relay:['sessionId']};
  if(typeof value.action!=='string'||!Object.hasOwn(fields,value.action)||Object.keys(value).some(k=>!['action','requestId',...fields[value.action as VoiceAction]].includes(k)))throw new Error('지원하지 않는 음성 요청입니다.');
  const r=value as unknown as VoiceRequest;
  if(r.interrupted!==undefined&&typeof r.interrupted!=='boolean')throw Error('음성 종료 상태를 확인하세요.');
  if(r.recordConsent!==undefined&&typeof r.recordConsent!=='boolean')throw Error('음성 기록 동의를 확인하세요.');
  if(r.before!==undefined&&!id(r.before))throw Error('음성 기록 목록 위치를 확인하세요.');
  if(r.cursor!==undefined&&(typeof r.cursor!=='string'||!/^\d{1,16}:\d{1,8}$/.test(r.cursor)))throw Error('음성 기록 위치를 확인하세요.');
  if(r.scope!==undefined&&r.scope!=='ops'&&!id(r.scope))throw Error('음성 기록 범위를 확인하세요.');
  if(r.action==='history.review'||r.action==='caption'||r.action==='say')voiceText(r.text);
  if(r.action==='partner')r.partner=normalizeVoicePartner(r.partner);
  if(r.route!==undefined&&!id(r.route))throw new Error('@ 호출할 프로젝트를 확인하세요.');
  if(r.references!==undefined&&(!Array.isArray(r.references)||r.references.length<1||r.references.length>VOICE_MAX_REFERENCES||!r.references.every(id)||new Set(r.references).size!==r.references.length))throw new Error(`# 언급은 프로젝트 1~${VOICE_MAX_REFERENCES}개입니다.`);
  if(['projects','projects.page'].includes(r.action)&&r.text!==undefined&&(typeof r.text!=='string'||r.text.length>300||/[\u0000-\u001f\u007f]/.test(r.text)))throw new Error('프로젝트 검색어를 300자 이하로 입력하세요.');
  if(r.action==='projects.page'&&r.offset!==undefined&&(!Number.isSafeInteger(r.offset)||r.offset<0||r.offset>10_000))throw new Error('프로젝트 목록 위치를 확인하세요.');
  if(r.action==='prepare'){normalizeVoiceTarget(r.target);if(r.provider!==undefined&&!['openai','gemini'].includes(r.provider)||!['dictation','conversation'].includes(r.mode!)||r.consent!==true)throw new Error('음성 제공자 전송 내용을 확인하고 시작하세요.');}
  if(['connect','media.connect','media.append','media.read','media.end','state','stop','submit','discard','signal.append','signal.connect','signal.read','history.read','history.review','history.remember','history.memory-status','partners','partner','caption','projects','projects.page','say','relay'].includes(r.action)&&!id(r.sessionId))throw new Error('음성 세션을 확인하세요.');
  if(r.action==='connect'&&(typeof r.sdp!=='string'||!r.sdp.startsWith('v=0')||size(r.sdp)>VOICE_MAX_SDP_BYTES))throw new Error('음성 연결 정보가 올바르지 않습니다.');
  if(r.action==='media.append'&&(typeof r.audio!=='string'||r.audio.length>6_000||!r.audio.length||!/^[A-Za-z0-9+/]+={0,2}$/.test(r.audio)||base64Bytes(r.audio)>4_000))throw new Error('음성 데이터 형식이 올바르지 않습니다.');
  if(r.action==='submit'){if(!id(r.draftId)||r.inputReady!==true)throw new Error('워크룸 입력 준비 상태를 확인하세요.');voiceText(r.text);}
  if(r.action==='discard'&&!id(r.draftId))throw new Error('음성 초안을 확인하세요.');
  if(['signal.append','signal.read'].includes(r.action)&&(!Number.isSafeInteger(r.part)||r.part!<0||r.part!>7))throw new Error('음성 연결 조각 위치를 확인하세요.');
  if(r.action==='signal.append'&&(!Number.isSafeInteger(r.parts)||r.parts!<1||r.parts!>8||r.part!>=r.parts!||typeof r.chunk!=='string'||size(r.chunk)>5000))throw new Error('음성 연결 조각을 확인하세요.');
  if(r.action==='configure'){
    const provider=r.provider??'openai';if(!['openai','gemini'].includes(provider))throw new Error('음성 제공자를 확인하세요.');
    if(r.apiKey!==undefined&&(typeof r.apiKey!=='string'||r.apiKey.length<20||r.apiKey.length>(provider==='openai'?512:2048)||!/^[\x21-\x7e]+$/.test(r.apiKey)))throw new Error('API 키 형식을 확인하세요.');
    if(r.model!==undefined&&(typeof r.model!=='string'||!(provider==='openai'?/^gpt-realtime(?:[a-z0-9.-]{0,80})$/:/^gemini-[a-z0-9][a-z0-9.-]{0,100}$/).test(r.model)))throw new Error('Realtime 모델 ID를 확인하세요.');
    if(r.voice!==undefined&&!['alloy','ash','ballad','coral','echo','sage','shimmer','verse','marin','cedar'].includes(r.voice))throw new Error('음성을 선택하세요.');
    if(r.removeKey!==undefined&&typeof r.removeKey!=='boolean'||r.removeKey&&r.apiKey)throw new Error('키 설정을 확인하세요.');
  }
  return r;
}
function validActiveTarget(active:unknown):active is VoiceActiveTarget{
  if(!object(active)||typeof active.label!=='string'||!active.label||active.label.length>300)return false;
  if(active.kind==='ops')return Object.keys(active).every(k=>['kind','label'].includes(k));
  if(active.kind==='workroom')return Object.keys(active).every(k=>['kind','label','targetId','sessionId','agent'].includes(k))&&id(active.targetId)&&id(active.sessionId)&&['codex','claude','hermes','agy'].includes(active.agent as string);
  return false;
}
export function normalizeVoiceResponse(x:unknown):VoiceResponse {
  const fail=():never=>{throw new Error('음성 응답을 확인하지 못했습니다.');};
  if(!object(x)||Object.keys(x).some(k=>!['configured','model','voice','keySource','providers','session','sdp','chunk','part','parts','media','historySupported','history','detail','reviewMessage','partners','caption','projects','projectPage'].includes(k))||size(JSON.stringify(x))>32_000)return fail();
  if(x.historySupported!==undefined&&typeof x.historySupported!=='boolean'||x.history!==undefined&&!validVoiceHistoryPage(x.history)||x.detail!==undefined&&!validVoiceHistoryDetail(x.detail)||x.reviewMessage!==undefined&&(typeof x.reviewMessage!=='string'||x.reviewMessage.length>500))return fail();
  if(x.configured!==undefined&&typeof x.configured!=='boolean')return fail();
  if(x.model!==undefined&&(typeof x.model!=='string'||x.model.length>100))return fail();
  if(x.voice!==undefined&&(typeof x.voice!=='string'||x.voice.length>30))return fail();
  if(x.keySource!==undefined&&!['environment','keychain','none'].includes(x.keySource as string))return fail();
  if(x.providers!==undefined){if(!object(x.providers)||Object.keys(x.providers).some(k=>!['openai','gemini'].includes(k)))return fail();for(const value of Object.values(x.providers)){if(!object(value)||Object.keys(value).some(k=>!['configured','model','keySource'].includes(k))||typeof value.configured!=='boolean'||typeof value.model!=='string'||value.model.length>110||value.keySource!==undefined&&!['environment','keychain','encrypted','none'].includes(value.keySource as string))return fail();}}
  if(x.partners!==undefined&&(!Array.isArray(x.partners)||x.partners.length>VOICE_MAX_PARTNERS||!x.partners.every(validActiveTarget)))return fail();
  if(x.projects!==undefined&&(!Array.isArray(x.projects)||x.projects.length>VOICE_MAX_PROJECT_CHOICES||!x.projects.every(p=>object(p)&&Object.keys(p).every(k=>['id','label'].includes(k))&&id(p.id)&&typeof p.label==='string'&&!!p.label&&p.label.length<=160)))return fail();
  if(x.projectPage!==undefined){const page=x.projectPage;if(!object(page)||Object.keys(page).some(k=>!['projects','total','nextOffset'].includes(k))||!Number.isSafeInteger(page.total)||Number(page.total)<0||Number(page.total)>10_000||page.nextOffset!==null&&(!Number.isSafeInteger(page.nextOffset)||Number(page.nextOffset)<0||Number(page.nextOffset)>Number(page.total))||!Array.isArray(page.projects)||page.projects.length>VOICE_MAX_PROJECT_CHOICES||!page.projects.every(p=>object(p)&&Object.keys(p).every(k=>['id','label'].includes(k))&&id(p.id)&&typeof p.label==='string'&&!!p.label&&p.label.length<=160))return fail();}
  if(x.caption!==undefined){const c=x.caption;if(!object(c)||Object.keys(c).some(k=>!['text','translation','source'].includes(k))||typeof c.text!=='string'||c.text.length>4000||typeof c.translation!=='string'||c.translation.length>6000||!['ko','en'].includes(c.source as string))return fail();}
  if(x.sdp!==undefined&&(typeof x.sdp!=='string'||!x.sdp.startsWith('v=0')||size(x.sdp)>VOICE_MAX_SDP_BYTES))return fail();
  if(x.chunk!==undefined&&(typeof x.chunk!=='string'||size(x.chunk)>5000||!Number.isSafeInteger(x.part)||!Number.isSafeInteger(x.parts)||Number(x.part)<0||Number(x.part)>=Number(x.parts)||Number(x.parts)>8))return fail();
  if(x.chunk===undefined&&(x.part!==undefined||x.parts!==undefined))return fail();
  if(x.media!==undefined){if(!Array.isArray(x.media)||x.media.length>16)return fail();for(const event of x.media){if(!object(event)||!['audio','input-transcript','output-transcript','interrupted'].includes(event.kind as string))return fail();if(event.kind==='audio'&&(Object.keys(event).some(k=>!['kind','data'].includes(k))||typeof event.data!=='string'||event.data.length>6000||!/^[A-Za-z0-9+/]+={0,2}$/.test(event.data)))return fail();if(['input-transcript','output-transcript'].includes(event.kind as string)&&(Object.keys(event).some(k=>!['kind','text','final'].includes(k))||typeof event.text!=='string'||event.text.length>6000||typeof event.final!=='boolean'))return fail();if(event.kind==='interrupted'&&Object.keys(event).length!==1)return fail();}}
  if(x.session!==undefined){
    const s=x.session;
    if(!object(s)||Object.keys(s).some(k=>!['id','state','mode','provider','label','activeTarget','openedWorkroom','draft','notice','expiresAt','recording'].includes(k))||!id(s.id)||!['prepared','connecting','active','ended','failed'].includes(s.state as string)||!['dictation','conversation'].includes(s.mode as string)||s.provider!==undefined&&!['openai','gemini'].includes(s.provider as string)||typeof s.label!=='string'||s.label.length>300||typeof s.notice!=='string'||s.notice.length>1000||typeof s.expiresAt!=='number'||!Number.isFinite(s.expiresAt))return fail();
    if(s.activeTarget!==undefined&&!validActiveTarget(s.activeTarget))return fail();
    if(s.openedWorkroom!==undefined){const opened=s.openedWorkroom;if(!object(opened)||!id(opened.eventId)||!validActiveTarget({kind:opened.kind,label:opened.label,targetId:opened.targetId,sessionId:opened.sessionId,agent:opened.agent})||opened.kind!=='workroom'||Object.keys(opened).some(k=>!['kind','label','targetId','sessionId','agent','eventId'].includes(k)))return fail();}
    if(s.recording!==undefined&&!validVoiceRecordStatus(s.recording))return fail();
    if(s.draft!==null){const d=s.draft;if(!object(d)||Object.keys(d).some(k=>!['id','text','label'].includes(k))||!id(d.id)||typeof d.label!=='string'||d.label.length>300)return fail();voiceText(d.text);}
  }
  if(object(x.session)&&x.session.provider===undefined)return {...x,session:{...x.session,provider:'openai'}} as VoiceResponse;
  return x as VoiceResponse;
}
