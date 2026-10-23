import {AI_TERMINAL_AGENTS,type AiTerminalAgent} from './aiTerminalProtocol';
import {normalizeServiceUseCall,type ServiceUseCall} from './serviceUseProtocol';
import type {SectionId} from './projectStateBundle';
import {SERVICE_USE_ALL_TOOLS,type ServiceUseTool} from './serviceUseProtocol';
import {normalizeAppUseActions,type AppUseAction} from './appUseCatalog';

export const WORKROOM_THREADS_FEATURE='workroom-threads-v1';
export const WORKROOM_THREAD_ACTIONS=['workroom.threads.catalog','workroom.threads.list','workroom.threads.read','workroom.threads.create','workroom.threads.reply','workroom.threads.close'] as const;
export type WorkroomThreadAction=typeof WORKROOM_THREAD_ACTIONS[number];
export const isWorkroomThreadAction=(value:unknown):value is WorkroomThreadAction=>typeof value==='string'&&(WORKROOM_THREAD_ACTIONS as readonly string[]).includes(value);
export type WorkroomThreadState='starting'|'running'|'needs-answer'|'completed'|'failed'|'unknown'|'closed';
export interface WorkroomThreadParticipant {targetId:string;label:string;threadId:string;sessionId:string|null;agent:AiTerminalAgent;state:WorkroomThreadState;revision:number}
export interface WorkroomThreadSummary {
 id:string;title:string;agent:AiTerminalAgent;sessionId:string|null;state:WorkroomThreadState;revision:number;createdAt:string;updatedAt:string;participants?:WorkroomThreadParticipant[];execution?:{role:'use';serviceKey:string};
}
export interface WorkroomThreadMessage {
 id:string;seq:number;role:'user'|'assistant'|'system';kind:'request'|'reply'|'progress'|'question'|'result'|'notice';text:string;at:string;
 delivery:'recorded'|'written'|'unknown';targetId?:string;projectLabel?:string;
}
export interface ProjectStateAttachment {bundleId:string;sections:SectionId[];selectionHash:string}
export interface WorkroomThreadRequest {serviceKey?:string;threadId?:string;agent?:AiTerminalAgent;text?:string;expectedRevision?:number;beforeSeq?:number;beforeThreadId?:string;consent?:boolean;targetIds?:string[];recipientTargetId?:string;requireMultiProject?:true;use?:ServiceUseCall;projectState?:ProjectStateAttachment}
export interface WorkroomUseCatalog {tools:ServiceUseTool[];actions?:AppUseAction[];executionReady:boolean;problem:string|null}
export interface WorkroomThreadResult {catalog?:WorkroomUseCatalog;threads?:WorkroomThreadSummary[];thread?:WorkroomThreadSummary;messages?:WorkroomThreadMessage[];nextBefore?:number|null;nextThreadId?:string|null;refusal?:{requestId:string;message:string}}
/** Only raised before a task/answer intent is committed. Later failures must remain uncertain. */
export class WorkroomThreadAdmissionError extends Error {}
const fail=():never=>{throw Error('커뮤니티 작업 스레드 형식을 확인하세요.');};
export const threadId=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9_-]{8,128}$/.test(v);
const positive=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>0;
export function workroomThreadText(v:unknown):string {
 if(typeof v!=='string'||!v.trim()||/[\u0000-\u0008\u000b-\u001f\u007f]/u.test(v))return fail();
 const bytes=new TextEncoder().encode(v);if(bytes.length>6000||new TextDecoder('utf-8',{fatal:true}).decode(bytes)!==v)return fail();
 if(new TextEncoder().encode(JSON.stringify(v)).length>6100)throw Error('기호·줄바꿈이 많아 전송 한도를 넘었습니다. 본문을 줄여 다시 보내세요.');return v;
}
export function normalizeWorkroomThreadRequest(action:WorkroomThreadAction,value:unknown):WorkroomThreadRequest {
 if(!value||typeof value!=='object'||Array.isArray(value))return fail();const r=value as WorkroomThreadRequest;
 const fields:Record<WorkroomThreadAction,string[]>={'workroom.threads.catalog':['serviceKey'],'workroom.threads.list':['beforeThreadId','requireMultiProject'],'workroom.threads.read':['threadId','beforeSeq'],'workroom.threads.create':['agent','text','targetIds','use','projectState'],'workroom.threads.reply':['threadId','text','expectedRevision','recipientTargetId','use','projectState'],'workroom.threads.close':['threadId','expectedRevision','consent']};
 if(Object.keys(r).some(k=>!fields[action].includes(k)))return fail();
 if(r.serviceKey!==undefined&&(typeof r.serviceKey!=='string'||!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(r.serviceKey)))return fail();
 if(action!=='workroom.threads.catalog'&&action!=='workroom.threads.list'&&action!=='workroom.threads.create'&&!threadId(r.threadId))return fail();
 if(action==='workroom.threads.create'&&!(AI_TERMINAL_AGENTS as readonly unknown[]).includes(r.agent))return fail();
 if(action==='workroom.threads.create'||action==='workroom.threads.reply')workroomThreadText(r.text);
 if(action==='workroom.threads.close'&&(r.consent!==true||!positive(r.expectedRevision)))return fail();
 if(action==='workroom.threads.reply'&&!positive(r.expectedRevision))return fail();
 if(r.requireMultiProject!==undefined&&r.requireMultiProject!==true)return fail();
 if(r.targetIds!==undefined&&(!Array.isArray(r.targetIds)||r.targetIds.length<2||r.targetIds.length>8||new Set(r.targetIds).size!==r.targetIds.length||!r.targetIds.every(threadId)))return fail();
 if(r.recipientTargetId!==undefined&&!threadId(r.recipientTargetId))return fail();
 if(r.beforeThreadId!==undefined&&!threadId(r.beforeThreadId))return fail();
 if(r.beforeSeq!==undefined&&!positive(r.beforeSeq))return fail();
 if(r.projectState!==undefined){
  const p=r.projectState;
  if(!p||typeof p!=='object'||Array.isArray(p)||Object.keys(p).length!==3||Object.keys(p).some(k=>!['bundleId','sections','selectionHash'].includes(k))
   ||!threadId(p.bundleId)||typeof p.selectionHash!=='string'||!/^[a-f0-9]{64}$/.test(p.selectionHash)
   ||!Array.isArray(p.sections)||p.sections.length<1||p.sections.length>4||new Set(p.sections).size!==p.sections.length||p.sections.some(v=>!['git','workroom','tester','memory'].includes(v))
   ||r.use!==undefined||r.targetIds!==undefined)return fail();
 }
 if(r.use!==undefined){if(r.targetIds!==undefined||r.recipientTargetId!==undefined)return fail();return {...r,use:normalizeServiceUseCall(r.use)};}return {...r};
}
function summary(value:unknown):WorkroomThreadSummary {
 const r=value as WorkroomThreadSummary,keys=['id','title','agent','sessionId','state','revision','createdAt','updatedAt'];
 if(!r||typeof r!=='object'||Array.isArray(r)||keys.some(k=>!(k in r))||Object.keys(r).some(k=>![...keys,'participants','execution'].includes(k))||!threadId(r.id)||typeof r.title!=='string'||r.title.length>100
  ||!(AI_TERMINAL_AGENTS as readonly unknown[]).includes(r.agent)||r.sessionId!==null&&!threadId(r.sessionId)||!['starting','running','needs-answer','completed','failed','unknown','closed'].includes(r.state)||!positive(r.revision)
  ||![r.createdAt,r.updatedAt].every(v=>typeof v==='string'&&v.length<=32&&Number.isFinite(Date.parse(v))))return fail();
 if(r.execution!==undefined&&(!r.execution||Object.keys(r.execution).length!==2||r.execution.role!=='use'||typeof r.execution.serviceKey!=='string'||!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(r.execution.serviceKey)||r.sessionId!==null||r.participants!==undefined))return fail();
 if(r.participants!==undefined){if(!Array.isArray(r.participants)||r.participants.length<2||r.participants.length>8||new Set(r.participants.map(p=>p.targetId)).size!==r.participants.length)return fail();for(const p of r.participants){if(!p||Object.keys(p).length!==7||Object.keys(p).some(k=>!['targetId','label','threadId','sessionId','agent','state','revision'].includes(k))||!threadId(p.targetId)||!threadId(p.threadId)||typeof p.label!=='string'||p.label.length>100)return fail();summary({id:p.threadId,title:p.label,agent:p.agent,sessionId:p.sessionId,state:p.state,revision:p.revision,createdAt:r.createdAt,updatedAt:r.updatedAt});}}
 return {...r};
}
export function normalizeWorkroomThreadResult(value:unknown,action?:WorkroomThreadAction):WorkroomThreadResult {
 const r=value as WorkroomThreadResult;if(!r||typeof r!=='object'||Array.isArray(r)||Object.keys(r).some(k=>!['catalog','threads','thread','messages','nextBefore','nextThreadId','refusal'].includes(k)))return fail();
 if(r.catalog!==undefined){
  const c=r.catalog;
  if(!c||Object.keys(c).some(k=>!['tools','actions','executionReady','problem'].includes(k))||!Array.isArray(c.tools)||c.tools.length>7||c.tools.some(t=>!(SERVICE_USE_ALL_TOOLS as readonly string[]).includes(t))||typeof c.executionReady!=='boolean'||c.problem!==null&&(typeof c.problem!=='string'||c.problem.length>2000))return fail();
  if(c.actions!==undefined)normalizeAppUseActions(c.actions);
 }
 if(action==='workroom.threads.catalog'){if(!r.catalog||Object.keys(r).length!==1)return fail();return {catalog:r.catalog};}
 if(r.refusal&&(!threadId(r.refusal.requestId)||Object.keys(r.refusal).length!==2||Object.keys(r.refusal).some(k=>!['requestId','message'].includes(k))||typeof r.refusal.message!=='string'||r.refusal.message.length>500))return fail();
 if(r.threads!==undefined&&(!Array.isArray(r.threads)||r.threads.length>20))return fail();
 if(r.messages!==undefined&&(!Array.isArray(r.messages)||r.messages.length>20))return fail();
 if(r.nextThreadId!==undefined&&r.nextThreadId!==null&&!threadId(r.nextThreadId))return fail();
 if(r.nextBefore!==undefined&&r.nextBefore!==null&&!positive(r.nextBefore))return fail();
 const messages=r.messages?.map(m=>{
  if(!m||['id','seq','role','kind','text','at','delivery'].some(k=>!(k in m))||Object.keys(m).some(k=>!['id','seq','role','kind','text','at','delivery','targetId','projectLabel'].includes(k)))return fail();
  if(!threadId(m.id)||!positive(m.seq)||!['user','assistant','system'].includes(m.role)||!['request','reply','progress','question','result','notice'].includes(m.kind)||!['recorded','written','unknown'].includes(m.delivery)||typeof m.at!=='string'||!Number.isFinite(Date.parse(m.at)))return fail();if((m.targetId!==undefined||m.projectLabel!==undefined)&&(!threadId(m.targetId)||typeof m.projectLabel!=='string'||m.projectLabel.length>100))return fail();workroomThreadText(m.text);return {...m};
 });
 if(action==='workroom.threads.list'&&(r.threads===undefined||Object.keys(r).some(k=>!['threads','nextThreadId'].includes(k))))return fail();
 if(action&&action!=='workroom.threads.list'&&(!r.refusal&&(!r.thread||r.messages===undefined)||Object.keys(r).some(k=>!['thread','messages','nextBefore','refusal'].includes(k))))return fail();
 return {...r,...(r.threads?{threads:r.threads.map(summary)}:{}),...(r.thread?{thread:summary(r.thread)}:{}),...(messages?{messages}:{})};
}
export const workroomThreadStateLabel=(s:WorkroomThreadState)=>({'starting':'워크룸 여는 중','running':'작업 중','needs-answer':'답변 필요','completed':'완료','failed':'실패','unknown':'결과 확인 필요','closed':'종료 표시'}[s]);
