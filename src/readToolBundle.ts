import {sha256} from '@noble/hashes/sha2.js';
import {PROJECT_STATE_LIMITS, utf8Bytes} from './projectStateBundle';
import type {SectionId, SourceAvailability, SourceFreshness} from './projectStateBundle';

/** Preparatory domain contract only. Nothing in this module admits or executes a read. */
export const READ_TOOL_OPERATIONS = Object.freeze([
  'project.git.read', 'workroom.status.read', 'tester.status.read',
  'tester.report.read', 'memory.reference.read',
] as const);
export type ReadToolOperation = typeof READ_TOOL_OPERATIONS[number];
export const READ_TOOL_LIMITS = Object.freeze({
  ...PROJECT_STATE_LIMITS, stages:8, dependencyDepth:3,
  activeBatchesPerTarget:1, activeBatchesPerHost:2, metadataBytes:16*1024,
});
export type TesterRunReference = Readonly<{stepId:string; field:'latest.runId'}>;
export type ReadToolInput =
  | Readonly<{operation:'project.git.read'; pathsLimit?:number}>
  | Readonly<{operation:'workroom.status.read'; sessionsLimit?:number}>
  | Readonly<{operation:'tester.status.read'}>
  | Readonly<{operation:'tester.report.read'; runId:string|TesterRunReference}>
  | Readonly<{operation:'memory.reference.read'; role:'dev'; query:string; limit?:number}>;
export type ResolvedReadToolInput = Exclude<ReadToolInput, {operation:'tester.report.read'}>
  | Readonly<{operation:'tester.report.read'; runId:string}>;
export type ReadStepCondition = 'always'|'on-current'|'on-report-present';
export interface ReadToolStep {
  readonly id:string; readonly input:ReadToolInput;
  readonly dependsOn:readonly string[]; readonly condition:ReadStepCondition;
}
export interface ReadToolPlan {readonly steps:readonly ReadToolStep[]}
export type ReadStepState = 'pending'|'running'|'completed'|'partial'|'failed'|'skipped'|'cancelled'|'unknown';
/** Bounded metadata provided by the future shared host, never raw result payloads. */
export interface ReadStepEvidence {
  readonly stepId:string; readonly operation:ReadToolOperation; readonly state:ReadStepState;
  readonly availability:SourceAvailability; readonly freshness:SourceFreshness;
  readonly latestRunId?:string;
  readonly reportRunId?:string;
}
export class ReadToolError extends Error {
  constructor(readonly code:string, message='조회 정의의 입력과 참조를 확인하세요.') {
    super(message); this.name='ReadToolError';
  }
}
const fail=(code='READ_TOOL_INPUT'):never=>{throw new ReadToolError(code);};
const forbiddenKeys=new Set(['__proto__','prototype','constructor','toJSON']);

/** Reject accessors, sparse/non-JSON graphs and oversized input before serialization.
 * This also makes the hashing/parser boundary safe for in-process callers, not only JSON HTTP. */
export function assertReadToolJson(value:unknown, maxBytes:number):void {
  let bytes=0, nodes=0;
  const ancestors=new Set<object>();
  const visit=(item:unknown,depth:number):void=>{
    if(++nodes>4096||depth>24)fail('READ_TOOL_LIMIT');
    if(item===null||typeof item==='boolean'){bytes+=5;}
    else if(typeof item==='number'){if(!Number.isFinite(item))fail();bytes+=24;}
    else if(typeof item==='string'){bytes+=utf8Bytes(item);}
    else if(typeof item==='object'){
      if(ancestors.has(item))fail();
      const array=Array.isArray(item),proto=Object.getPrototypeOf(item);
      if(array?proto!==Array.prototype:proto!==Object.prototype&&proto!==null)fail();
      if(array&&(item as unknown[]).length>4096)fail('READ_TOOL_LIMIT');
      const keys=Reflect.ownKeys(item);
      if(keys.length>4096)fail('READ_TOOL_LIMIT');
      if(array&&keys.length!==(item as unknown[]).length+1)fail();
      ancestors.add(item); bytes+=2;
      for(const key of keys){
        if(array&&key==='length')continue;
        if(typeof key!=='string')return fail();
        if(forbiddenKeys.has(key))return fail();
        const descriptor=Object.getOwnPropertyDescriptor(item,key)!;
        if(!descriptor.enumerable||!Object.hasOwn(descriptor,'value'))fail();
        if(array&&!/^(0|[1-9][0-9]*)$/.test(key))fail();
        bytes+=utf8Bytes(key)+4; visit(descriptor.value,depth+1);
        if(bytes>maxBytes)fail('READ_TOOL_LIMIT');
      }
      ancestors.delete(item);
    } else fail();
    if(bytes>maxBytes)fail('READ_TOOL_LIMIT');
  };
  visit(value,0);
  if(utf8Bytes(JSON.stringify(value))>maxBytes)fail('READ_TOOL_LIMIT');
}
export function readToolExactObject(value:unknown,keys:readonly string[]):Record<string,unknown> {
  if(!value||typeof value!=='object'||Array.isArray(value))return fail();
  const object=value as Record<string,unknown>;
  if(Object.keys(object).some(key=>!keys.includes(key)))return fail();
  return object;
}
export function readToolIdentifier(value:unknown):string {
  if(typeof value!=='string'||!/^[-A-Za-z0-9_][A-Za-z0-9._:-]{0,127}$/.test(value)||forbiddenKeys.has(value))return fail();
  return value;
}
export function testerRunId(value:unknown):string {
  if(typeof value!=='string'||!/^\d{8}T\d{6}Z-[a-f0-9]{8}$/.test(value))return fail('READ_TOOL_RUN_ID');
  return value;
}
/** Query text is data, never a path, URL, executable expression or credential channel. */
export function readToolQuery(value:unknown,maxLength=700):string {
  if(typeof value!=='string'||!value.trim()||value.length>maxLength||/[\u0000-\u001f\u007f]/u.test(value)||/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)
    ||/(?:[a-z][a-z0-9+.-]*:\/\/|(?:^|\s)[~\/]\S|[A-Za-z]:[\\/]|\\\\|`|\$\(|\$\{|\b(?:eval|exec)\s*\(|[;&|]{2}|\b(?:password|secret|token|api[_-]?key|authorization|credentials)\s*[:=]|\b(?:sk-(?:ant-)?|gh[pousr]_)[\w-]{12,}|-----BEGIN)/i.test(value))return fail('READ_TOOL_QUERY');
  return value.trim();
}
function integer(value:unknown,min:number,max:number):number {
  if(typeof value!=='number'||!Number.isInteger(value)||value<min||value>max)return fail();
  return value;
}
export function freezeReadToolValue<T>(value:T):T {
  if(value&&typeof value==='object'){
    for(const child of Object.values(value))freezeReadToolValue(child);
    Object.freeze(value);
  }
  return value;
}
export function readToolDigest(value:unknown):string {
  // Domain callers additionally use an exact parser before hashing. Keep this exported
  // shared helper inert even when accidentally given an unparsed in-process object.
  assertReadToolJson(value,READ_TOOL_LIMITS.metadataBytes);
  const canonical=(v:unknown):unknown=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'
    ?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,item])=>[k,canonical(item)])):v;
  return Array.from(sha256(new TextEncoder().encode(JSON.stringify(canonical(value)))),b=>b.toString(16).padStart(2,'0')).join('');
}
export function readToolSection(operation:ReadToolOperation):SectionId {
  switch(operation){
    case 'project.git.read':return 'git';
    case 'workroom.status.read':return 'workroom';
    case 'tester.status.read':case 'tester.report.read':return 'tester';
    case 'memory.reference.read':return 'memory';
  }
}
export function parseReadToolInput(value:unknown):ReadToolInput {
  assertReadToolJson(value,READ_TOOL_LIMITS.controlBytes);
  const raw=readToolExactObject(value,['operation','pathsLimit','sessionsLimit','runId','role','query','limit']);
  let result:ReadToolInput;
  switch(raw.operation){
    case 'project.git.read':
      readToolExactObject(raw,['operation','pathsLimit']);
      result={operation:raw.operation,...(raw.pathsLimit===undefined?{}:{pathsLimit:integer(raw.pathsLimit,0,20)})};break;
    case 'workroom.status.read':
      readToolExactObject(raw,['operation','sessionsLimit']);
      result={operation:raw.operation,...(raw.sessionsLimit===undefined?{}:{sessionsLimit:integer(raw.sessionsLimit,1,8)})};break;
    case 'tester.status.read':
      readToolExactObject(raw,['operation']);result={operation:raw.operation};break;
    case 'tester.report.read': {
      readToolExactObject(raw,['operation','runId']);
      const reference=typeof raw.runId==='string'?testerRunId(raw.runId):readToolExactObject(raw.runId,['stepId','field']);
      if(typeof reference!=='string'&&reference.field!=='latest.runId')return fail('READ_TOOL_REFERENCE');
      result={operation:raw.operation,runId:typeof reference==='string'?reference:{stepId:readToolIdentifier(reference.stepId),field:'latest.runId'}};break;
    }
    case 'memory.reference.read':
      readToolExactObject(raw,['operation','role','query','limit']);
      if(raw.role!=='dev')return fail();
      result={operation:raw.operation,role:'dev',query:readToolQuery(raw.query),...(raw.limit===undefined?{}:{limit:integer(raw.limit,1,3)})};break;
    default:return fail('READ_TOOL_OPERATION');
  }
  return freezeReadToolValue(result);
}
export function parseReadToolPlan(value:unknown):ReadToolPlan {
  assertReadToolJson(value,READ_TOOL_LIMITS.controlBytes);
  const raw=readToolExactObject(value,['steps']);
  if(!Array.isArray(raw.steps)||raw.steps.length<1||raw.steps.length>READ_TOOL_LIMITS.stages)return fail('READ_TOOL_STAGES');
  const previous=new Map<string,{step:ReadToolStep;depth:number}>();
  const steps=raw.steps.map((item):ReadToolStep=>{
    const row=readToolExactObject(item,['id','input','dependsOn','condition']);
    const id=readToolIdentifier(row.id),input=parseReadToolInput(row.input);
    if(previous.has(id))return fail('READ_TOOL_DUPLICATE');
    const dependencies=Object.hasOwn(row,'dependsOn')?row.dependsOn:[];
    if(!Array.isArray(dependencies)||dependencies.length>READ_TOOL_LIMITS.stages)return fail('READ_TOOL_DEPENDENCY');
    const dependsOn=dependencies.map(readToolIdentifier);
    if(new Set(dependsOn).size!==dependsOn.length||dependsOn.some(ref=>!previous.has(ref)))return fail('READ_TOOL_DEPENDENCY');
    const condition=Object.hasOwn(row,'condition')?row.condition:'always';
    if(!['always','on-current','on-report-present'].includes(condition as string)||(condition!=='always'&&!dependsOn.length))return fail('READ_TOOL_CONDITION');
    if(condition==='on-report-present'&&!dependsOn.some(ref=>previous.get(ref)!.step.input.operation==='tester.status.read'))return fail('READ_TOOL_CONDITION');
    if(input.operation==='tester.report.read'&&typeof input.runId!=='string'){
      if(!dependsOn.includes(input.runId.stepId)||previous.get(input.runId.stepId)?.step.input.operation!=='tester.status.read')return fail('READ_TOOL_REFERENCE');
    }
    const depth=1+Math.max(0,...dependsOn.map(ref=>previous.get(ref)!.depth));
    if(depth>READ_TOOL_LIMITS.dependencyDepth)return fail('READ_TOOL_DEPTH');
    const step={id,input,dependsOn,condition:condition as ReadStepCondition};previous.set(id,{step,depth});return step;
  });
  const plan={steps};
  if(utf8Bytes(JSON.stringify(plan))>READ_TOOL_LIMITS.controlBytes)return fail('READ_TOOL_LIMIT');
  return freezeReadToolValue(plan);
}
export function readToolPlanDigest(value:unknown):string {return readToolDigest(parseReadToolPlan(value));}
export function freezeReadToolPlan(value:unknown):Readonly<{plan:ReadToolPlan;digest:string}> {
  const plan=parseReadToolPlan(value);return Object.freeze({plan,digest:readToolDigest(plan)});
}
export function parseReadStepEvidence(value:unknown):readonly ReadStepEvidence[] {
  assertReadToolJson(value,READ_TOOL_LIMITS.metadataBytes);
  if(!Array.isArray(value)||value.length>READ_TOOL_LIMITS.stages)return fail('READ_TOOL_EVIDENCE');
  const seen=new Set<string>();
  const result=value.map(item=>{
    const row=readToolExactObject(item,['stepId','operation','state','availability','freshness','latestRunId','reportRunId']);
    const stepId=readToolIdentifier(row.stepId);
    if(seen.has(stepId)||!READ_TOOL_OPERATIONS.includes(row.operation as ReadToolOperation)||!['pending','running','completed','partial','failed','skipped','cancelled','unknown'].includes(row.state as string)
      ||!['ready','unconfigured','partial','unknown','unavailable'].includes(row.availability as string)
      ||!['current','stale','unknown'].includes(row.freshness as string))return fail('READ_TOOL_EVIDENCE');
    if(row.latestRunId!==undefined&&row.operation!=='tester.status.read'||row.reportRunId!==undefined&&row.operation!=='tester.report.read')return fail('READ_TOOL_EVIDENCE');
    seen.add(stepId);
    return {stepId,operation:row.operation as ReadToolOperation,state:row.state as ReadStepState,availability:row.availability as SourceAvailability,freshness:row.freshness as SourceFreshness,
      ...(row.latestRunId===undefined?{}:{latestRunId:testerRunId(row.latestRunId)}),...(row.reportRunId===undefined?{}:{reportRunId:testerRunId(row.reportRunId)})};
  });
  return freezeReadToolValue(result);
}
/** A pure eligibility decision, not a scheduler; callers supply a parsed step and same-run metadata. */
export function readStepEligibility(step:ReadToolStep,value:unknown):Readonly<{state:'run'|'wait'|'skip';reason:string}> {
  const evidence=parseReadStepEvidence(value),byId=new Map(evidence.map(row=>[row.stepId,row]));
  const deps=step.dependsOn.map(id=>byId.get(id));
  if(deps.some(row=>row&&!['pending','running'].includes(row.state)&&(row.state!=='completed'||row.availability!=='ready')))return Object.freeze({state:'skip',reason:'dependency-unavailable'});
  if(deps.some(row=>!row||row.state==='pending'||row.state==='running'))return Object.freeze({state:'wait',reason:'dependency-pending'});
  if(step.condition==='on-current'&&deps.some(row=>row!.freshness!=='current'))return Object.freeze({state:'skip',reason:'dependency-not-current'});
  if(step.condition==='on-report-present'&&!deps.some(row=>!!row!.latestRunId))return Object.freeze({state:'skip',reason:'report-absent'});
  return Object.freeze({state:'run',reason:'dependencies-satisfied'});
}
export function resolveReadToolInput(step:ReadToolStep,value:unknown):ResolvedReadToolInput|null {
  const evidence=parseReadStepEvidence(value);
  if(readStepEligibility(step,evidence).state!=='run')return null;
  if(step.input.operation!=='tester.report.read'||typeof step.input.runId==='string')return parseReadToolInput(step.input) as ResolvedReadToolInput;
  const reference=step.input.runId,runId=evidence.find(row=>row.stepId===reference.stepId&&row.operation==='tester.status.read')?.latestRunId;
  return runId?freezeReadToolValue({operation:'tester.report.read',runId:testerRunId(runId)}):null;
}
