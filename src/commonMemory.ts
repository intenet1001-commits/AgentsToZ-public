/** Portable goal-specific memory contracts. No filesystem, provider or device identity. */
import {commonMemoryDigest} from './commonMemoryCrypto';
import type {PortableCommonKnowledge,PortableCommonKnowledgeSummary} from './commonMemoryPortableTypes';
export const COMMON_MEMORY_VERSION = 1;
export const COMMON_MEMORY_LIMITS = {sources:16,items:500,evidencePerItem:16,bodyBytes:12_000,documentBytes:1_000_000,recallBytes:16_000} as const;
export class CommonMemoryError extends Error {
  constructor(readonly code:string,message:string,readonly status=409){super(message);this.name='CommonMemoryError';}
}
export type CommonMemoryGoal = {objective:string;include:string[];exclude:string[];conditions:string[];checks:string[];sdkModules?:string[]};
export type CommonMemoryEvidence = {memoryId:string;revisionId:string;entryId:string;contentHash:string;title:string;excerpt:string};
export type CommonMemoryItem = {id:string;title:string;rule:string;reason:string;conditions:string[];evidence:CommonMemoryEvidence[];goalVersion:number;state:'reviewed'|'needs-review'};
export type CommonMemorySourceHead = {memoryId:string;revisionId:string;contentHash:string};
export type CommonMemorySourceEntry = CommonMemoryEvidence & {section:string};
export type CommonMemoryPublication = {id:string;goalVersion:number;goal:CommonMemoryGoal;sourceHeads:CommonMemorySourceHead[];items:CommonMemoryItem[];publishedAt:string};
export type CommonMemory = {schemaVersion:1;id:string;name:string;goal:CommonMemoryGoal;goalConfigured?:boolean;portableKnowledge?:PortableCommonKnowledge;knowledgeSummary?:PortableCommonKnowledgeSummary;knowledgeSourceHeads?:CommonMemorySourceHead[];goalVersion:number;sourceMemoryIds:string[];items:CommonMemoryItem[];sourceHeads:CommonMemorySourceHead[];publication:CommonMemoryPublication|null;archived:boolean};
export type CommonMemorySelection = {groupId:string;revisionId:string;goalVersion:number;scopeId?:string};
export type CommonMemoryApplication = {id:string;groupId:string;revisionId:string;goalVersion:number;itemIds:string[];task:string;outcome:'observed'|'passed'|'failed'|'not-applied';evidence:string;checkId?:string;recordedAt:string};

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function commonMemoryId(value:unknown):string{if(typeof value!=='string'||!UUID.test(value))throw new CommonMemoryError('COMMON_MEMORY_INPUT_INVALID','기억 식별자가 올바르지 않습니다.',400);return value.toLowerCase();}
export function commonMemoryText(value:unknown,max=4000,required=true):string {
  if(typeof value!=='string'||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value))throw new CommonMemoryError('COMMON_MEMORY_INPUT_INVALID','텍스트 형식을 확인하세요.',400);
  const text=value.trim();if(required&&!text||new TextEncoder().encode(text).length>max)throw new CommonMemoryError('COMMON_MEMORY_INPUT_INVALID','내용이 비어 있거나 길이 한도를 넘습니다.',400);return text;
}
function memoryBody(value:unknown,max:number):string{commonMemoryText(value,max);if(new TextEncoder().encode(value as string).length>max)throw new CommonMemoryError('COMMON_MEMORY_BUDGET_EXCEEDED','기억 본문의 크기 한도를 넘습니다.');return value as string;}
function lines(value:unknown,max=32):string[]{if(!Array.isArray(value)||value.length>max)throw new CommonMemoryError('COMMON_MEMORY_INPUT_INVALID','목표의 범위·조건 목록을 확인하세요.',400);return [...new Set(value.map(v=>commonMemoryText(v,500)))];}
export function normalizeCommonMemoryGoal(value:unknown):CommonMemoryGoal{
  if(!value||typeof value!=='object'||Array.isArray(value))throw new CommonMemoryError('COMMON_MEMORY_INPUT_INVALID','공통기억 목표가 필요합니다.',400);
  const v=value as Record<string,unknown>,sdkModules=lines(v.sdkModules??[],16);
  if(sdkModules.some(key=>! /^[a-z0-9][a-z0-9_-]{0,63}$/.test(key)))throw new CommonMemoryError('COMMON_MEMORY_INPUT_INVALID','SDK 모듈 키 형식을 확인하세요.',400);
  const goal={objective:commonMemoryText(v.objective),include:lines(v.include??[]),exclude:lines(v.exclude??[]),conditions:lines(v.conditions??[]),checks:lines(v.checks??[]),sdkModules};
  if(new TextEncoder().encode(JSON.stringify(goal)).length>10_000)throw new CommonMemoryError('COMMON_MEMORY_BUDGET_EXCEEDED','목표의 범위가 너무 큽니다. 간결하게 정리하세요.',400);return goal;
}
export function commonMemorySourceIds(value:unknown,allowEmpty=false):string[]{if(!Array.isArray(value)||!allowEmpty&&!value.length||value.length>COMMON_MEMORY_LIMITS.sources)throw new CommonMemoryError('COMMON_MEMORY_INPUT_INVALID',`원본 기억을 1~${COMMON_MEMORY_LIMITS.sources}개 선택하세요.`,400);return [...new Set(value.map(commonMemoryId))].sort();}
export const commonMemoryHash=commonMemoryDigest;

export function createCommonMemory(input:{id?:string;name:string;goal:unknown;sourceMemoryIds:unknown}):CommonMemory{
  return {schemaVersion:1,id:commonMemoryId(input.id??crypto.randomUUID()),name:commonMemoryText(input.name,240),goal:normalizeCommonMemoryGoal(input.goal),goalVersion:1,sourceMemoryIds:commonMemorySourceIds(input.sourceMemoryIds),items:[],sourceHeads:[],publication:null,archived:false};
}
export function configureCommonMemory(current:CommonMemory,input:{name:string;goal:unknown;sourceMemoryIds:unknown}):CommonMemory {
  const goal=normalizeCommonMemoryGoal(input.goal),sourceMemoryIds=commonMemorySourceIds(input.sourceMemoryIds,!!current.portableKnowledge);
  const changed=JSON.stringify(goal)!==JSON.stringify(current.goal)||JSON.stringify(sourceMemoryIds)!==JSON.stringify(current.sourceMemoryIds);
  return {...current,name:commonMemoryText(input.name,240),goal,...(current.portableKnowledge?{goalConfigured:true}:{}),sourceMemoryIds,goalVersion:current.goalVersion+(changed?1:0),sourceHeads:changed?[]:current.sourceHeads,
    items:changed?current.items.map(item=>({...item,state:'needs-review' as const})):current.items};
}
export function commonMemorySourcesChanged(current:CommonMemory,heads:CommonMemorySourceHead[]):boolean {
  const key=(h:CommonMemorySourceHead)=>JSON.stringify([h.memoryId,h.revisionId,h.contentHash]);
  return heads.length!==current.sourceHeads.length||heads.some(h=>!current.sourceHeads.some(old=>key(old)===key(h)));
}
export function commonMemoryReady(current:CommonMemory,heads?:CommonMemorySourceHead[]):boolean {
  return current.goalConfigured!==false&&current.sourceMemoryIds.length>0&&!current.archived&&!!current.publication&&current.publication.goalVersion===current.goalVersion&&(!heads||!commonMemorySourcesChanged({...current,sourceHeads:current.publication.sourceHeads},heads));
}
export function refreshCommonMemorySources(current:CommonMemory,entries:CommonMemorySourceEntry[],heads:CommonMemorySourceHead[]):CommonMemory {
  return {...current,sourceHeads:heads,items:current.items.map(item=>{
    const evidence=item.evidence.map(e=>{const next=entries.find(n=>n.memoryId===e.memoryId&&n.entryId===e.entryId&&n.contentHash===e.contentHash);return next?{...e,revisionId:next.revisionId}:e;});
    const changed=evidence.some(e=>!heads.some(h=>h.memoryId===e.memoryId&&h.revisionId===e.revisionId));
    return {...item,evidence,state:changed?'needs-review':item.state};
  })};
}
export async function reviewCommonMemoryItem(current:CommonMemory,input:{sourceEntries:CommonMemorySourceEntry[];title?:string;rule?:string;reason:string;conditions:string[];itemId?:string},heads:CommonMemorySourceHead[]):Promise<CommonMemory>{
  if(current.archived)throw new CommonMemoryError('COMMON_MEMORY_ARCHIVED','보관된 공통기억은 수정할 수 없습니다.');
  if(!input.sourceEntries.length||input.sourceEntries.length>COMMON_MEMORY_LIMITS.evidencePerItem)throw new CommonMemoryError('COMMON_MEMORY_EVIDENCE_REQUIRED','검증된 원본 항목을 선택하세요.',400);
  // Existing curated entries use 32 hex characters; full document heads use 64.
  for(const e of input.sourceEntries){if(!current.sourceMemoryIds.includes(e.memoryId)||!heads.some(h=>h.memoryId===e.memoryId&&h.revisionId===e.revisionId)||! /^(?:[a-f0-9]{32}|[a-f0-9]{64})$/.test(e.contentHash))throw new CommonMemoryError('COMMON_MEMORY_SOURCE_CHANGED','목표의 원본과 현재 항목 버전을 다시 확인하세요.');}
  const base=input.sourceEntries[0]!,id=input.itemId??`cmi_${(await commonMemoryHash(`${current.id}:${base.memoryId}:${base.entryId}`)).slice(0,24)}`;
  if(input.itemId&&!current.items.some(item=>item.id===input.itemId))throw new CommonMemoryError('COMMON_MEMORY_ITEM_MISSING','수정할 항목을 다시 확인하세요.');
  const item:CommonMemoryItem={id,title:commonMemoryText(input.title??base.title,300),rule:memoryBody(input.rule??base.excerpt,COMMON_MEMORY_LIMITS.bodyBytes),reason:commonMemoryText(input.reason,2000),conditions:lines(input.conditions),evidence:input.sourceEntries.map(({section,...e})=>({...e,excerpt:memoryBody(e.excerpt,COMMON_MEMORY_LIMITS.bodyBytes)})),goalVersion:current.goalVersion,state:'reviewed'};
  const previous=current.items.find(i=>i.id===id);
  const remaining=current.items.filter(i=>i.id!==id);
  if(remaining.length>=COMMON_MEMORY_LIMITS.items)throw new CommonMemoryError('COMMON_MEMORY_BUDGET_EXCEEDED','공통기억 항목 한도에 도달했습니다.');
  // Source changes invalidate only dependent rules; goal/membership changes invalidate all.
  const affected=remaining.map(i=>i.evidence.some(e=>!heads.some(h=>h.memoryId===e.memoryId&&h.revisionId===e.revisionId))?{...i,state:'needs-review' as const}:i);
  return {...current,items:[...affected,item],sourceHeads:heads};
}
export function publishCommonMemory(current:CommonMemory,heads:CommonMemorySourceHead[]):CommonMemory {
  if(!current.sourceMemoryIds.length||!current.items.length||current.items.some(i=>i.state!=='reviewed'||i.goalVersion!==current.goalVersion)||commonMemorySourcesChanged(current,heads))throw new CommonMemoryError('COMMON_MEMORY_REVIEW_REQUIRED','현재 목표와 원본을 기준으로 항목을 검토한 뒤 게시하세요.');
  if(current.archived)throw new CommonMemoryError('COMMON_MEMORY_ARCHIVED','보관된 공통기억입니다.');
  const publication:CommonMemoryPublication={id:crypto.randomUUID(),goalVersion:current.goalVersion,goal:structuredClone(current.goal),sourceHeads:structuredClone(heads),items:structuredClone(current.items),publishedAt:new Date().toISOString()};
  const next={...current,publication};if(new TextEncoder().encode(JSON.stringify(next)).length>COMMON_MEMORY_LIMITS.documentBytes)throw new CommonMemoryError('COMMON_MEMORY_BUDGET_EXCEEDED','공통기억의 크기 한도를 넘습니다.');return next;
}

// Retrieval suggests candidates; an application or MCP conversation makes the goal-specific choice.
const TOPICS:Record<string,RegExp>={ios:/\b(ios|iphone|swift|swiftui|xcode)\b|아이폰|스위프트|네이티브/i,game:/\b(game|gaming|unity|unreal)\b|게임|운전|레이싱/i,web:/\b(web|react|next|browser|html)\b|웹|브라우저/i,performance:/\b(performance|latency|fps|memory)\b|성능|지연|프레임|메모리/i,security:/\b(security|auth|permission)\b|인증|권한|보안/i};
const topics=(text:string)=>Object.entries(TOPICS).filter(([,re])=>re.test(text)).map(([key])=>key);
export function recommendCommonMemories(groups:CommonMemory[],projectGoal:string,limit=8){
  const intent=commonMemoryText(projectGoal),wanted=topics(intent),tokens=[...new Set(intent.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu)??[])];
  return groups.filter(g=>commonMemoryReady(g)).map(g=>{
    const corpus=[g.name,g.goal.objective,...g.goal.include,...g.goal.conditions].join(' ').toLowerCase(),matches=wanted.filter(t=>topics(corpus).includes(t)),words=tokens.filter(t=>corpus.includes(t));
    const excluded=g.goal.exclude.filter(s=>s.length>=2&&intent.toLowerCase().includes(s.toLowerCase()));
    const score=matches.length*3+words.length-excluded.length*10;
    return {groupId:g.id,name:g.name,goal:g.goal,goalVersion:g.goalVersion,revisionId:g.publication!.id,score,reason:excluded.length?`제외 범위와 겹칩니다: ${excluded.join(', ')}`:`목표와 연결되는 주제: ${[...matches,...words].join(', ')}`,conditions:g.goal.conditions,method:'goal-metadata-retrieval' as const};
  }).filter(r=>r.score>0).sort((a,b)=>b.score-a.score||a.name.localeCompare(b.name)).slice(0,Math.max(1,Math.min(limit,20)));
}
export function recallCommonMemory(publication:CommonMemoryPublication,task:string,maxBytes=COMMON_MEMORY_LIMITS.recallBytes){
  const query=commonMemoryText(task),wanted=topics(query),tokens=query.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu)??[];
  const ranked=publication.items.map(item=>{const text=[item.title,item.rule,item.reason,...item.conditions].join(' ').toLowerCase();return {item,score:wanted.filter(t=>topics(text).includes(t)).length*3+tokens.filter(t=>text.includes(t)).length};}).filter(r=>r.score>0).sort((a,b)=>b.score-a.score);
  const output={revisionId:publication.id,goalVersion:publication.goalVersion,goal:publication.goal,items:[] as CommonMemoryItem[],bytes:0,verified:false as const};
  let bytes=new TextEncoder().encode(JSON.stringify(output)).length;
  for(const {item} of ranked){const size=new TextEncoder().encode(JSON.stringify(item)).length+1;if(bytes+size+16>maxBytes)continue;output.items.push(item);bytes+=size;}
  output.bytes=new TextEncoder().encode(JSON.stringify(output)).length;
  return output;
}
export function normalizeCommonMemoryApplication(value:unknown,publication:CommonMemoryPublication,groupId:string):CommonMemoryApplication{
  const v=value as Record<string,unknown>;
  if(!v||v.revisionId!==publication.id||v.goalVersion!==publication.goalVersion||!Array.isArray(v.itemIds)||!v.itemIds.length||v.itemIds.length>50||v.itemIds.some(id=>!publication.items.some(item=>item.id===id))||!['observed','passed','failed','not-applied'].includes(String(v.outcome)))throw new CommonMemoryError('COMMON_MEMORY_APPLICATION_INVALID','실제로 사용한 게시본·항목·결과를 확인하세요.',400);
  const checkId=v.checkId?commonMemoryText(v.checkId,300):undefined;
  if(v.outcome==='passed'&&!checkId)throw new CommonMemoryError('COMMON_MEMORY_CHECK_REQUIRED','통과 기록에는 실제 검사 식별자와 결과 근거가 필요합니다.',400);
  return {id:commonMemoryId(v.id??crypto.randomUUID()),groupId,revisionId:publication.id,goalVersion:publication.goalVersion,itemIds:[...new Set(v.itemIds as string[])],task:commonMemoryText(v.task),outcome:v.outcome as CommonMemoryApplication['outcome'],evidence:commonMemoryText(v.evidence,4000),...(checkId?{checkId}:{}),recordedAt:new Date().toISOString()};
}
