import {
  assertReadToolJson, freezeReadToolValue, freezeReadToolPlan, parseReadStepEvidence,
  parseReadToolPlan, readToolDigest, readToolExactObject, readToolIdentifier, readToolQuery, resolveReadToolInput,
} from './readToolBundle';
import type {ReadToolPlan} from './readToolBundle';
import {utf8Bytes} from './projectStateBundle';

/** Pure, inactive preparation contracts. No guide body, target, authority, receipt or storage. */
export const WORK_PACK_LIMITS=Object.freeze({definitionBytes:16*1024,inputs:8,conditions:16,enumOptions:16,inputLength:700});
export interface WorkPackSourceReference {
  readonly sourceLibraryId:string; readonly accountId:string; readonly libraryRevision:string;
  readonly guideId:string; readonly commandBodyHash:string;
  /** Adapter-proven command incarnation/revision, NOT updatedAt or body hash alone.
   * Deletion/reimport must change it; an adapter unable to prove that is unsupported. */
  readonly sourceRevision:string;
}
/** Supplied by a future trusted local/shared guide adapter. Not client authority. */
export interface WorkPackGuideSource extends WorkPackSourceReference {
  readonly kind:'simple'|'command'|null; readonly presence:'present'|'deleted';
  readonly virtual:boolean; readonly provenance:'verified'|'unknown'|'reimported'; readonly supported:boolean;
}
type InputBase={readonly name:string;readonly required:boolean};
export type WorkPackInputSchema =
  | (InputBase & {readonly type:'string';readonly maxLength:number;readonly default?:string})
  | (InputBase & {readonly type:'enum';readonly options:readonly string[];readonly default?:string})
  | (InputBase & {readonly type:'boolean';readonly default?:boolean});
export interface WorkPackInputBinding {readonly inputName:string;readonly stepId:string;readonly field:'query'}
export interface WorkPackCompletionCondition {readonly kind:'step-completed'|'source-current'|'report-present';readonly stepId:string}
export type WorkPackReview = Readonly<{state:'draft'|'disabled'|'stale'|'orphan'}>|Readonly<{state:'reviewed';definitionDigest:string}>;
export interface WorkPackDefinition {
  readonly schemaVersion:1;readonly source:WorkPackSourceReference;readonly definitionRevision:string;
  readonly inputs:readonly WorkPackInputSchema[];readonly plan:ReadToolPlan;
  readonly inputBindings:readonly WorkPackInputBinding[];readonly conditions:readonly WorkPackCompletionCondition[];
  readonly review:WorkPackReview;
}
export class WorkPackError extends Error {
  constructor(readonly code:string,message='작업 팩의 원본과 검토 상태를 확인하세요.') {super(message);this.name='WorkPackError';}
}
const fail=(code='WORK_PACK_INPUT'):never=>{throw new WorkPackError(code);};
const sourceKeys=['sourceLibraryId','accountId','libraryRevision','guideId','commandBodyHash','sourceRevision'] as const;
const reservedNames=new Set(['target','targetid','projectid','path','url','shell','eval','code','credentials','role','grant','profile','account','accountid','deviceid','owner','principal','proto','constructor','prototype']);
function sourceReference(value:unknown):WorkPackSourceReference {
  const raw=readToolExactObject(value,sourceKeys);
  if(typeof raw.commandBodyHash!=='string'||!/^[a-f0-9]{64}$/.test(raw.commandBodyHash))return fail('WORK_PACK_SOURCE');
  return {sourceLibraryId:readToolIdentifier(raw.sourceLibraryId),accountId:readToolIdentifier(raw.accountId),
    libraryRevision:readToolIdentifier(raw.libraryRevision),guideId:readToolIdentifier(raw.guideId),
    commandBodyHash:raw.commandBodyHash,sourceRevision:readToolIdentifier(raw.sourceRevision)};
}
function guideSource(value:unknown):WorkPackGuideSource {
  assertReadToolJson(value,4096);
  const raw=readToolExactObject(value,[...sourceKeys,'kind','presence','virtual','provenance','supported']);
  if(!['simple','command',null].includes(raw.kind as 'simple'|'command'|null)||!['present','deleted'].includes(raw.presence as string)
    ||typeof raw.virtual!=='boolean'||typeof raw.supported!=='boolean'||!['verified','unknown','reimported'].includes(raw.provenance as string))return fail('WORK_PACK_SOURCE');
  const ref=sourceReference(Object.fromEntries(sourceKeys.map(key=>[key,raw[key]])));
  return {...ref,kind:raw.kind as WorkPackGuideSource['kind'],presence:raw.presence as WorkPackGuideSource['presence'],virtual:raw.virtual,
    provenance:raw.provenance as WorkPackGuideSource['provenance'],supported:raw.supported};
}
function parameterName(value:unknown):string {
  if(typeof value!=='string'||!/^[a-z][a-zA-Z0-9_]{0,31}$/.test(value)||reservedNames.has(value.replace(/_/g,'').toLowerCase()))return fail('WORK_PACK_PARAMETER');
  return value;
}
function parseInputSchema(value:unknown):WorkPackInputSchema {
  const raw=readToolExactObject(value,['name','type','required','maxLength','options','default']);
  const name=parameterName(raw.name);
  if(typeof raw.required!=='boolean')return fail();
  const base={name,required:raw.required};
  if(raw.type==='boolean'){
    readToolExactObject(raw,['name','type','required','default']);
    if(raw.default!==undefined&&typeof raw.default!=='boolean')return fail();
    return {...base,type:'boolean',...(raw.default===undefined?{}:{default:raw.default})};
  }
  if(raw.type==='string'){
    readToolExactObject(raw,['name','type','required','maxLength','default']);
    if(typeof raw.maxLength!=='number'||!Number.isInteger(raw.maxLength)||raw.maxLength<1||raw.maxLength>WORK_PACK_LIMITS.inputLength)return fail();
    return {...base,type:'string',maxLength:raw.maxLength,...(raw.default===undefined?{}:{default:readToolQuery(raw.default,raw.maxLength)})};
  }
  if(raw.type==='enum'){
    readToolExactObject(raw,['name','type','required','options','default']);
    if(!Array.isArray(raw.options)||raw.options.length<1||raw.options.length>WORK_PACK_LIMITS.enumOptions)return fail();
    const options=raw.options.map(option=>readToolQuery(option,120));
    if(new Set(options).size!==options.length||raw.default!==undefined&&!options.includes(raw.default as string))return fail();
    return {...base,type:'enum',options,...(raw.default===undefined?{}:{default:raw.default as string})};
  }
  return fail();
}
function definitionContent(definition:WorkPackDefinition):Omit<WorkPackDefinition,'review'> {
  const {review:_review,...content}=definition;return content;
}
export function parseWorkPackDefinition(value:unknown):WorkPackDefinition {
  assertReadToolJson(value,WORK_PACK_LIMITS.definitionBytes);
  const raw=readToolExactObject(value,['schemaVersion','source','definitionRevision','inputs','plan','inputBindings','conditions','review']);
  if(raw.schemaVersion!==1)return fail('WORK_PACK_SCHEMA_UNSUPPORTED');
  const source=sourceReference(raw.source),definitionRevision=readToolIdentifier(raw.definitionRevision),plan=parseReadToolPlan(raw.plan);
  if(!Array.isArray(raw.inputs)||raw.inputs.length>WORK_PACK_LIMITS.inputs)return fail('WORK_PACK_PARAMETER');
  const inputs=raw.inputs.map(parseInputSchema),inputMap=new Map(inputs.map(input=>[input.name,input]));
  if(inputs.length!==inputMap.size)return fail('WORK_PACK_PARAMETER');
  if(!Array.isArray(raw.inputBindings)||raw.inputBindings.length>8)return fail('WORK_PACK_BINDING');
  const boundSteps=new Set<string>();
  const inputBindings=raw.inputBindings.map((item:unknown)=>{
    const row=readToolExactObject(item,['inputName','stepId','field']),inputName=parameterName(row.inputName),stepId=readToolIdentifier(row.stepId);
    const schema=inputMap.get(inputName),step=plan.steps.find(step=>step.id===stepId);
    if(row.field!=='query'||!schema||schema.type==='boolean'||!step||step.input.operation!=='memory.reference.read'||boundSteps.has(stepId))return fail('WORK_PACK_BINDING');
    boundSteps.add(stepId);return {inputName,stepId,field:'query' as const};
  });
  if(!Array.isArray(raw.conditions)||raw.conditions.length<1||raw.conditions.length>WORK_PACK_LIMITS.conditions)return fail('WORK_PACK_CONDITION');
  const seen=new Set<string>();
  const conditions=raw.conditions.map((item):WorkPackCompletionCondition=>{
    const row=readToolExactObject(item,['kind','stepId']),stepId=readToolIdentifier(row.stepId),step=plan.steps.find(step=>step.id===stepId);
    if(!step||!['step-completed','source-current','report-present'].includes(row.kind as string))return fail('WORK_PACK_CONDITION');
    if(row.kind==='report-present'&&step.input.operation!=='tester.status.read'&&step.input.operation!=='tester.report.read')return fail('WORK_PACK_CONDITION');
    const key=`${row.kind}:${stepId}`;if(seen.has(key))return fail('WORK_PACK_CONDITION');seen.add(key);
    return {kind:row.kind as WorkPackCompletionCondition['kind'],stepId};
  });
  const reviewRaw=readToolExactObject(raw.review,['state','definitionDigest']);
  let review:WorkPackReview;
  if(reviewRaw.state==='reviewed'){
    if(typeof reviewRaw.definitionDigest!=='string'||!/^[a-f0-9]{64}$/.test(reviewRaw.definitionDigest))return fail('WORK_PACK_REVIEW');
    review={state:'reviewed',definitionDigest:reviewRaw.definitionDigest};
  } else {
    readToolExactObject(reviewRaw,['state']);
    if(!['draft','disabled','stale','orphan'].includes(reviewRaw.state as string))return fail('WORK_PACK_REVIEW');
    review={state:reviewRaw.state as 'draft'|'disabled'|'stale'|'orphan'};
  }
  const definition:WorkPackDefinition={schemaVersion:1,source,definitionRevision,inputs,plan,inputBindings,conditions,review};
  if(review.state==='reviewed'&&readToolDigest(definitionContent(definition))!==review.definitionDigest)return fail('WORK_PACK_REVIEW_DIGEST');
  if(utf8Bytes(JSON.stringify(definition))>WORK_PACK_LIMITS.definitionBytes)return fail('WORK_PACK_LIMIT');
  return freezeReadToolValue(definition);
}
export function workPackDefinitionDigest(value:unknown):string {return readToolDigest(definitionContent(parseWorkPackDefinition(value)));}
export type WorkPackInspection=Readonly<{state:'draft'|'reviewed'|'disabled'|'stale'|'orphan'|'unsupported';reason:string}>;
function inspect(definition:WorkPackDefinition,current:WorkPackGuideSource):WorkPackInspection {
  if(current.presence==='deleted'||definition.review.state==='orphan')return {state:'orphan',reason:'source-deleted'};
  if(!current.supported||current.virtual||current.provenance==='unknown')return {state:'unsupported',reason:'source-provenance-unavailable'};
  if(current.provenance==='reimported')return {state:'stale',reason:'source-reimported'};
  if(current.kind!=='command')return {state:'stale',reason:'source-kind-changed'};
  // Library-wide title/pin/reorder CAS changes are checked on save, not semantic changes.
  for(const key of ['sourceLibraryId','accountId','guideId','commandBodyHash','sourceRevision'] as const){
    if(definition.source[key]!==current[key])return {state:'stale',reason:`source-${key}-changed`};
  }
  return {state:definition.review.state,reason:definition.review.state==='reviewed'?'definition-reviewed':'definition-needs-review'};
}
export function inspectWorkPackDefinition(value:unknown,currentSource:unknown):WorkPackInspection {
  return Object.freeze(inspect(parseWorkPackDefinition(value),guideSource(currentSource)));
}
/** Records an explicit definition review only. A future caller must authenticate that review,
 * CAS the source/library/definition and preserve tombstones; this digest grants no execution rights. */
export function reviewWorkPackDefinition(value:unknown,currentSource:unknown):WorkPackDefinition {
  const definition=parseWorkPackDefinition(value),current=guideSource(currentSource),inspection=inspect(definition,current);
  if(['unsupported','orphan'].includes(inspection.state)||current.kind!=='command'||current.provenance!=='verified')return fail('WORK_PACK_SOURCE_REVIEW_REQUIRED');
  if(['sourceLibraryId','accountId','guideId','commandBodyHash','sourceRevision'].some(key=>definition.source[key as keyof WorkPackSourceReference]!==current[key as keyof WorkPackSourceReference]))return fail('WORK_PACK_SOURCE_REVIEW_REQUIRED');
  const next={...definition,source:sourceReference(Object.fromEntries(sourceKeys.map(key=>[key,current[key]])))};
  const digest=readToolDigest(definitionContent(next));
  return parseWorkPackDefinition({...next,review:{state:'reviewed',definitionDigest:digest}});
}
export interface PreparedWorkPack {
  readonly source:WorkPackSourceReference;readonly definitionRevision:string;readonly definitionDigest:string;
  readonly values:Readonly<Record<string,string|boolean>>;readonly plan:ReadToolPlan;readonly planDigest:string;
}
/** Preparation only: the shared host must later bind a fresh target, owner, grant and exact
 * existing DEV thread, recheck the source and admit the batch after the earlier phase gates. */
export function prepareWorkPack(value:unknown,currentSource:unknown,inputValues:unknown):PreparedWorkPack {
  const definition=parseWorkPackDefinition(value),current=guideSource(currentSource);
  if(inspect(definition,current).state!=='reviewed'||definition.review.state!=='reviewed')return fail('WORK_PACK_NOT_REVIEWED');
  assertReadToolJson(inputValues,4096);
  const raw=readToolExactObject(inputValues,definition.inputs.map(input=>input.name)),values:Record<string,string|boolean>={};
  for(const input of definition.inputs){
    const candidate=Object.hasOwn(raw,input.name)?raw[input.name]:input.default;
    if(candidate===undefined){if(input.required)return fail('WORK_PACK_PARAMETER_REQUIRED');continue;}
    if(input.type==='boolean'){
      if(typeof candidate!=='boolean')return fail('WORK_PACK_PARAMETER');values[input.name]=candidate;
    } else if(input.type==='enum'){
      if(typeof candidate!=='string'||!input.options.includes(candidate))return fail('WORK_PACK_PARAMETER');values[input.name]=candidate;
    } else values[input.name]=readToolQuery(candidate,input.maxLength);
  }
  const steps=definition.plan.steps.map(step=>{
    const binding=definition.inputBindings.find(binding=>binding.stepId===step.id);
    if(!binding)return step;
    const query=values[binding.inputName];
    // Optional missing values retain the reviewed static fallback; no interpolation/eval.
    if(query===undefined)return step;
    if(typeof query!=='string')return fail('WORK_PACK_BINDING');
    return {...step,input:{...step.input,query}};
  });
  const frozen=freezeReadToolPlan({steps});
  return freezeReadToolValue({source:sourceReference(Object.fromEntries(sourceKeys.map(key=>[key,current[key]]))),
    definitionRevision:definition.definitionRevision,definitionDigest:definition.review.definitionDigest,values,plan:frozen.plan,planDigest:frozen.digest});
}
export function evaluateWorkPackCompletion(value:unknown,outcomes:unknown):Readonly<{
  complete:boolean;meaning:'read-completion-only';conditions:readonly Readonly<{stepId:string;kind:WorkPackCompletionCondition['kind'];satisfied:boolean;reason:string}>[];
}> {
  const definition=parseWorkPackDefinition(value),evidence=parseReadStepEvidence(outcomes);
  if(evidence.some(row=>!definition.plan.steps.some(step=>step.id===row.stepId&&step.input.operation===row.operation)))return fail('WORK_PACK_EVIDENCE');
  for(const row of evidence){
    if(row.operation!=='tester.report.read'||!row.reportRunId)continue;
    const step=definition.plan.steps.find(step=>step.id===row.stepId)!;
    const input=resolveReadToolInput(step,evidence);
    if(input?.operation!=='tester.report.read'||input.runId!==row.reportRunId)return fail('WORK_PACK_EVIDENCE');
  }
  const conditions=definition.conditions.map(condition=>{
    const row=evidence.find(row=>row.stepId===condition.stepId);
    const ready=definition.review.state==='reviewed'&&row?.state==='completed'&&row.availability==='ready';
    const satisfied=!!ready&&(condition.kind==='step-completed'||condition.kind==='source-current'&&row!.freshness==='current'||condition.kind==='report-present'&&!!(row!.latestRunId||row!.reportRunId));
    return {...condition,satisfied,reason:satisfied?'read-condition-satisfied':'read-condition-unproven'};
  });
  return freezeReadToolValue({complete:conditions.every(condition=>condition.satisfied),meaning:'read-completion-only' as const,conditions});
}
