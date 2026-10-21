import type {VoiceTarget,VoiceMode} from './voiceSessionProtocol';
export interface VoiceHistoryIdentity {
  target:VoiceTarget;binding:string;memoryId:string|null;memoryScope?:'ops';
  /** Earlier scopes still accepted when reading (e.g. an OPS scope sealed before a folder rename). Never sealed. */
  formerBindings?:readonly string[];
}
export interface VoiceHistorySession {
  id:string;kind:'ops'|'workroom';label:string;
  /** The workroom target the session was bound to; null for 아젠투지 (OPS) voice. */
  targetId?:string|null;
  createdAt:string;endedAt:string|null;mode:VoiceMode;model:string;turnCount:number;reviewed:boolean;
  /** Ended with every committed transcript saved; false means some speech may be missing. */
  complete?:boolean;
}
/** One place sessions were recorded for: 'ops' (아젠투지) or a workroom target id. */
export interface VoiceHistoryScope {key:string;kind:'ops'|'workroom';label:string}
export interface VoiceHistoryPage {sessions:VoiceHistorySession[];nextBefore:string|null;
  /** Only on a first page: the recent scopes, for filter chips. */
  scopes?:VoiceHistoryScope[]}
export interface VoiceHistoryTurn {id:string;role:'user'|'assistant';recordedAt:string;text:string;continued:boolean}
export interface VoiceHistoryDetail {session:VoiceHistorySession;turn:VoiceHistoryTurn|null;nextCursor:string|null}
export interface VoiceRecordStatus {state:'off'|'saving'|'saved'|'failed';savedTurns:number;message:string}
export const VOICE_HISTORY_MAX_SCOPES=24;
const object=(v:unknown):v is Record<string,any>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const str=(v:unknown,n:number)=>typeof v==='string'&&v.length<=n;
const exact=(v:Record<string,any>,keys:string[])=>Object.keys(v).every(k=>keys.includes(k));
export function validVoiceHistorySession(s:unknown):s is VoiceHistorySession{return object(s)&&exact(s,['id','kind','label','targetId','createdAt','endedAt','mode','model','turnCount','reviewed','complete'])&&['ops','workroom'].includes(s.kind)&&str(s.id,160)&&str(s.label,300)&&(s.targetId===undefined||s.targetId===null||str(s.targetId,160))&&str(s.createdAt,40)&&(s.endedAt===null||str(s.endedAt,40))&&['dictation','conversation'].includes(s.mode)&&str(s.model,100)&&Number.isSafeInteger(s.turnCount)&&s.turnCount>=0&&typeof s.reviewed==='boolean'&&(s.complete===undefined||typeof s.complete==='boolean');}
function validVoiceHistoryScope(s:unknown):s is VoiceHistoryScope{return object(s)&&exact(s,['key','kind','label'])&&str(s.key,160)&&!!s.key&&['ops','workroom'].includes(s.kind)&&str(s.label,300);}
export function validVoiceHistoryPage(p:unknown):p is VoiceHistoryPage{return object(p)&&exact(p,['sessions','nextBefore','scopes'])&&Array.isArray(p.sessions)&&p.sessions.length<=20&&p.sessions.every(validVoiceHistorySession)&&(p.nextBefore===null||str(p.nextBefore,160))&&(p.scopes===undefined||Array.isArray(p.scopes)&&p.scopes.length<=VOICE_HISTORY_MAX_SCOPES&&p.scopes.every(validVoiceHistoryScope));}
export function validVoiceHistoryDetail(p:unknown):p is VoiceHistoryDetail{return object(p)&&exact(p,['session','turn','nextCursor'])&&validVoiceHistorySession(p.session)&&(p.nextCursor===null||str(p.nextCursor,60))&&(p.turn===null||object(p.turn)&&exact(p.turn,['id','role','recordedAt','text','continued'])&&str(p.turn.id,160)&&['user','assistant'].includes(p.turn.role)&&str(p.turn.recordedAt,40)&&str(p.turn.text,4000)&&typeof p.turn.continued==='boolean');}
export function validVoiceRecordStatus(v:unknown):v is VoiceRecordStatus{return object(v)&&exact(v,['state','savedTurns','message'])&&['off','saving','saved','failed'].includes(v.state)&&Number.isSafeInteger(v.savedTurns)&&v.savedTurns>=0&&str(v.message,500);}
