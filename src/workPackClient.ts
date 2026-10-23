import {promptGuideClient} from './promptGuideClient';
import {READ_TOOL_OPERATIONS,type ReadToolOperation} from './readToolBundle';

export type WorkPackState='draft'|'reviewed'|'disabled'|'stale'|'orphan'|'unsupported';
export interface WorkPackSummary {guideId:string;title:string;state:WorkPackState;reason:string;definitionRevision:string;steps:{id:string;operation:ReadToolOperation}[];query?:{default?:string}}
export interface WorkPackList {revision:string;packs:WorkPackSummary[];commands:{guideId:string;title:string}[]}
export interface WorkPackClient {
 list(signal?:AbortSignal):Promise<WorkPackList>;
 save(input:{expectedRevision:string;guideId:string;plan:unknown;queryInput?:boolean},signal?:AbortSignal):Promise<WorkPackList>;
 disable(input:{expectedRevision:string;guideId:string},signal?:AbortSignal):Promise<WorkPackList>;
}
const states=['draft','reviewed','disabled','stale','orphan','unsupported'];
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const exact=(v:Record<string,unknown>,keys:string[])=>Object.keys(v).every(k=>keys.includes(k));
const text=(v:unknown,max:number)=>typeof v==='string'&&v.length<=max;
const malformed=()=>new Error('WORK_PACKS_INVALID_RESPONSE');
export function normalizeWorkPackList(raw:unknown):WorkPackList {
 if(!object(raw)||raw.success!==true||!exact(raw,['success','revision','packs','commands'])||!text(raw.revision,128)||!Array.isArray(raw.packs)||raw.packs.length>100||!Array.isArray(raw.commands)||raw.commands.length>100)throw malformed();
 const commands=raw.commands.map(c=>{if(!object(c)||!exact(c,['guideId','title'])||!text(c.guideId,128)||!text(c.title,500))throw malformed();return {guideId:c.guideId as string,title:c.title as string};});
 const packs=raw.packs.map(p=>{
  if(!object(p)||!exact(p,['guideId','title','state','reason','definitionRevision','steps','query'])||!text(p.guideId,128)||!text(p.title,500)||!states.includes(String(p.state))||!text(p.reason,128)||!text(p.definitionRevision,128)||!Array.isArray(p.steps)||!p.steps.length||p.steps.length>8)throw malformed();
  const steps=p.steps.map(s=>{if(!object(s)||!exact(s,['id','operation'])||!text(s.id,128)||!READ_TOOL_OPERATIONS.includes(s.operation as ReadToolOperation))throw malformed();return {id:s.id as string,operation:s.operation as ReadToolOperation};});
  if(p.query!==undefined&&(!object(p.query)||!exact(p.query,['default'])||p.query.default!==undefined&&!text(p.query.default,300)))throw malformed();
  return {guideId:p.guideId as string,title:p.title as string,state:p.state as WorkPackState,reason:p.reason as string,definitionRevision:p.definitionRevision as string,steps,...(p.query?{query:p.query as {default?:string}}:{})};
 });
 return {revision:raw.revision as string,packs,commands};
}
export function createWorkPackClient(request:(body:Record<string,unknown>,signal?:AbortSignal)=>Promise<unknown>=(body,signal)=>promptGuideClient.workPacks(body,signal)):WorkPackClient {
 return {
  async list(signal){return normalizeWorkPackList(await request({operation:'list'},signal));},
  async save(input,signal){return normalizeWorkPackList(await request({operation:'save',...input},signal));},
  async disable(input,signal){return normalizeWorkPackList(await request({operation:'disable',...input},signal));},
 };
}
export const workPackClient=createWorkPackClient();
