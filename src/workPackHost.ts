import {randomUUID} from 'node:crypto';
import type {PromptGuideSnapshot} from './promptGuideStore';
import {assertReadToolJson,parseReadToolPlan,readToolExactObject,readToolIdentifier,type ReadToolOperation} from './readToolBundle';
import type {ReadToolBatchHost,ReadToolBatchResult} from './readToolBatchHost';
import {WorkPackError,evaluateWorkPackCompletion,inspectWorkPackDefinition,prepareWorkPack,reviewWorkPackDefinition,type WorkPackDefinition,type WorkPackGuideSource,type WorkPackInspection} from './workPack';
import {LOCAL_WORK_PACK_ACCOUNT,LOCAL_WORK_PACK_LIBRARY,localCommandSource} from './workPackGuideSource';
import type {WorkPackSourceReader,WorkPackStore} from './workPackStore';

/** The single optional pack input: the memory step's query, reviewed with its default. */
export const WORK_PACK_QUERY_INPUT='query';
const QUERY_MAX=300;
export interface WorkPackSummary {
 guideId:string;title:string;state:WorkPackInspection['state'];reason:string;definitionRevision:string;
 steps:{id:string;operation:ReadToolOperation}[];query?:{default?:string};
}
export interface WorkPackList {revision:string;packs:WorkPackSummary[];commands:{guideId:string;title:string}[]}
export interface WorkPackCompletion {complete:boolean;meaning:'read-completion-only';conditions:{stepId:string;kind:string;satisfied:boolean;reason:string}[]}
export type WorkPackRunResult=ReadToolBatchResult&{completion:WorkPackCompletion|null};
export interface WorkPackHostDependencies {
 store:Pick<WorkPackStore,'read'|'save'>;
 guides:{read():Promise<PromptGuideSnapshot>};
 reader:WorkPackSourceReader;
 batch:Pick<ReadToolBatchHost,'start'|'read'>;
}
const fail=(code:string):never=>{throw new WorkPackError(code);};
const local=(definition:WorkPackDefinition)=>definition.source.sourceLibraryId===LOCAL_WORK_PACK_LIBRARY&&definition.source.accountId===LOCAL_WORK_PACK_ACCOUNT;
const sourceRef=(source:WorkPackGuideSource)=>({sourceLibraryId:source.sourceLibraryId,accountId:source.accountId,libraryRevision:source.libraryRevision,guideId:source.guideId,commandBodyHash:source.commandBodyHash,sourceRevision:source.sourceRevision});
const code=(error:unknown)=>error&&typeof error==='object'&&'code'in error&&typeof error.code==='string'?error.code:'';

/** Work packs attach a reviewed read plan to one local 규격 명령. Running one is an ordinary
 * P2 batch on an exact existing DEV thread; no AI, test, memory write or send is started. */
export class WorkPackHost {
 constructor(readonly deps:WorkPackHostDependencies){}
 async list():Promise<WorkPackList> {
  const [snapshot,guides]=await Promise.all([this.deps.store.read(),this.deps.guides.read()]);
  const commands=guides.entries.filter(entry=>entry.kind==='command'&&localCommandSource(guides,entry).supported).slice(0,100).map(entry=>({guideId:entry.id,title:entry.title}));
  const packs=await Promise.all(snapshot.definitions.filter(local).map(async(definition):Promise<WorkPackSummary>=>{
   const current=await this.deps.reader(structuredClone(definition.source)),inspection=inspectWorkPackDefinition(definition,current);
   const binding=definition.inputBindings.find(row=>row.inputName===WORK_PACK_QUERY_INPUT),input=definition.inputs.find(row=>row.name===WORK_PACK_QUERY_INPUT);
   return {guideId:definition.source.guideId,title:guides.entries.find(entry=>entry.id===definition.source.guideId)?.title??'',state:inspection.state,reason:inspection.reason,
    definitionRevision:definition.definitionRevision,steps:definition.plan.steps.map(step=>({id:step.id,operation:step.input.operation})),
    ...(binding&&input?.type==='string'?{query:input.default===undefined?{}:{default:input.default}}:{})};
  }));
  return {revision:snapshot.revision,packs,commands};
 }
 /** An explicit save is the review: the definition is bound to the command's current body. */
 async save(input:unknown):Promise<WorkPackList> {
  assertReadToolJson(input,4096);
  const raw=readToolExactObject(input,['expectedRevision','guideId','plan','queryInput']),guideId=readToolIdentifier(raw.guideId);
  if(typeof raw.expectedRevision!=='string'||raw.queryInput!==undefined&&typeof raw.queryInput!=='boolean')return fail('WORK_PACK_INPUT');
  const plan=parseReadToolPlan(raw.plan),{source,existing}=await this.command(guideId);
  const memory=plan.steps.find(step=>step.input.operation==='memory.reference.read');
  const query=raw.queryInput===true&&memory?.input.operation==='memory.reference.read'?memory.input.query.slice(0,QUERY_MAX):undefined;
  // Conditional steps (a report only when one exists) are not required for completion.
  const conditions=plan.steps.filter(step=>step.condition==='always').map(step=>({kind:'step-completed',stepId:step.id}));
  const draft={schemaVersion:1,source:sourceRef(source),definitionRevision:'rev-'+randomUUID(),plan,conditions,
   inputs:query&&memory?[{name:WORK_PACK_QUERY_INPUT,type:'string',required:false,maxLength:QUERY_MAX,default:query}]:[],
   inputBindings:query&&memory?[{inputName:WORK_PACK_QUERY_INPUT,stepId:memory.id,field:'query'}]:[],review:{state:'draft'}};
  const reviewed=reviewWorkPackDefinition(draft,source);
  await this.deps.store.save({expectedRevision:raw.expectedRevision,expectedDefinitionRevision:existing?.definitionRevision??null,definition:JSON.parse(JSON.stringify(reviewed))});
  return this.list();
 }
 async disable(input:unknown):Promise<WorkPackList> {
  assertReadToolJson(input,1024);
  const raw=readToolExactObject(input,['expectedRevision','guideId']),guideId=readToolIdentifier(raw.guideId);
  if(typeof raw.expectedRevision!=='string')return fail('WORK_PACK_INPUT');
  const {source,existing}=await this.command(guideId);if(!existing)return fail('WORK_PACK_NOT_FOUND');
  const next={...JSON.parse(JSON.stringify(existing)),source:sourceRef(source),definitionRevision:'rev-'+randomUUID(),review:{state:'disabled'}};
  await this.deps.store.save({expectedRevision:raw.expectedRevision,expectedDefinitionRevision:existing.definitionRevision,definition:next});
  return this.list();
 }
 async run(owner:string,input:unknown,signal?:AbortSignal):Promise<WorkPackRunResult> {
  assertReadToolJson(input,4096);
  const raw=readToolExactObject(input,['targetId','threadId','requestId','guideId','values']);
  const ref={targetId:readToolIdentifier(raw.targetId),threadId:readToolIdentifier(raw.threadId),requestId:readToolIdentifier(raw.requestId)},guideId=readToolIdentifier(raw.guideId);
  // A known request ID only reads its original receipt: never prepared or started again.
  try{const existing=await this.deps.batch.read(owner,ref,signal);return {...existing,completion:await this.completion(guideId,existing)};}
  catch(error){if(code(error)!=='PROJECT_STATE_BATCH_UNAVAILABLE')throw error;}
  const {definition,current}=await this.reviewed(guideId),prepared=prepareWorkPack(definition,current,raw.values??{});
  const result=await this.deps.batch.start(owner,{...ref,plan:JSON.parse(JSON.stringify(prepared.plan))},signal);
  return {...result,completion:evaluate(definition,result)};
 }
 async read(owner:string,input:unknown,signal?:AbortSignal):Promise<WorkPackRunResult> {
  assertReadToolJson(input,1024);
  const raw=readToolExactObject(input,['targetId','threadId','requestId','guideId']);
  const result=await this.deps.batch.read(owner,{targetId:readToolIdentifier(raw.targetId),threadId:readToolIdentifier(raw.threadId),requestId:readToolIdentifier(raw.requestId)},signal);
  return {...result,completion:await this.completion(readToolIdentifier(raw.guideId),result)};
 }
 private async command(guideId:string){
  const [snapshot,guides]=await Promise.all([this.deps.store.read(),this.deps.guides.read()]);
  const entry=guides.entries.find(item=>item.id===guideId);
  if(!entry||entry.kind!=='command')return fail('WORK_PACK_SOURCE');
  const source=localCommandSource(guides,entry);if(!source.supported)return fail('WORK_PACK_SOURCE');
  return {source,existing:snapshot.definitions.find(definition=>local(definition)&&definition.source.guideId===guideId)??null};
 }
 private async reviewed(guideId:string){
  const definition=(await this.deps.store.read()).definitions.find(item=>local(item)&&item.source.guideId===guideId);
  if(!definition)return fail('WORK_PACK_NOT_FOUND');
  const current=await this.deps.reader(structuredClone(definition.source));
  if(inspectWorkPackDefinition(definition,current).state!=='reviewed')return fail('WORK_PACK_NOT_REVIEWED');
  return {definition,current};
 }
 private async completion(guideId:string,result:ReadToolBatchResult):Promise<WorkPackCompletion|null> {
  const definition=(await this.deps.store.read()).definitions.find(item=>local(item)&&item.source.guideId===guideId);
  return definition?evaluate(definition,result):null;
 }
}
function evaluate(definition:WorkPackDefinition,result:ReadToolBatchResult):WorkPackCompletion|null {
 const outputs=result.result?.outputs??[];
 const evidence=result.batch.stages.map(stage=>{const output=outputs.find(row=>row.stepId===stage.id);
  return {stepId:stage.id,operation:stage.operation,state:stage.state,availability:stage.availability??'unknown',freshness:stage.freshness??'unknown',
   ...(output?.latestRunId?{latestRunId:output.latestRunId}:{}),...(output?.reportRunId?{reportRunId:output.reportRunId}:{})};});
 // A receipt from another definition revision cannot be judged against this one.
 try{return JSON.parse(JSON.stringify(evaluateWorkPackCompletion(definition,evidence)));}catch{return null;}
}
