import {sha256} from '@noble/hashes/sha2.js';

/** Report admission only. No provider, runtime, filesystem, credentials, or clock calls. */
export const BENCHMARK_MAX_BYTES = 8 * 1024 * 1024;
export const BENCHMARK_MAX_CASES = 512;
export const BENCHMARK_MAX_TRIALS = 4096;
export const BENCHMARK_MIN_PAIRS = 30;
export const BENCHMARK_LATENCY_RATIO = 0.70;
type Side = 'candidate' | 'reference';
type Domain = 'voice' | 'remote';
export type BenchmarkVerdict = 'PASS' | 'FAIL' | 'BLOCKED' | 'NOT_RUN';
const sides = ['candidate','reference'] as const;
const voiceMetrics = ['response','interrupt','resume'] as const;
const remoteMetrics = ['workflow','wifi-change','lock-return','host-restart','sustained-1h'] as const;
type Metric = typeof voiceMetrics[number] | typeof remoteMetrics[number];
type Transport = 'webrtc' | 'websocket' | 'relay' | 'native';
interface Binding {version:string;artifactHash:string;sourceHash:string;settingsHash:string}
interface Conditions {
  workloadHash:string;contextHash:string;environmentHash:string;methodHash:string;clockHash:string;
  transport:Transport;condition:string;
}
interface BenchmarkCase {
  id:string;domain:Domain;language:'ko'|'en'|'mixed'|'none';inputHash:string;expectedFactsHash:string;
}
interface BenchmarkGroup extends Conditions {
  id:string;domain:Domain;metric:Metric;pairs:{id:string;caseId:string}[];
}
export interface BenchmarkProtocol {
  id:string;sealedAt:number;comparison:'native-product'|'cli-proxy';
  products:Record<Side,Binding>;cases:BenchmarkCase[];groups:BenchmarkGroup[];
}
export interface BenchmarkTrial extends Binding, Conditions {
  attemptId:string;pairId:string;groupId:string;caseId:string;side:Side;protocolHash:string;inputHash:string;
  startedAt:number;outcome:'ok'|'timeout'|'error';latencyMs:number|null;elapsedMs:number;
  effortCount:number;retryCount:number;manualCommit:boolean;cleanup:'confirmed'|'failed'|'unknown';
  semantics:{
    verdict:'correct'|'incorrect'|'unscored';source:'human'|'deterministic'|'self'|null;
    expectedFactsHash:string|null;evidenceHash:string|null;
  };
  violations:('wrong-target'|'negation-reversed'|'forbidden-action'|'duplicate-action'|'draft-lost'|'grant-bypass')[];
  proof:{
    surface:'agentstoz-native'|'codex-native'|'agentstoz-installed-api'|'codex-cli'|'provider-api'|'fixture';
    physicalDevice:boolean;physicalMicrophone:boolean;authenticated:boolean;taskStateObserved:boolean;captureHash:string|null;
  };
}
export interface BenchmarkManifest {schemaVersion:1;protocol:BenchmarkProtocol;trials:BenchmarkTrial[]}
interface Summary {p50:number;p95:number}
interface GroupEvaluation {
  id:string;domain:Domain;metric:Metric;condition:string;status:BenchmarkVerdict;reasons:string[];
  attempts:Record<Side,number>;failures:Record<Side,number>;missingAttempts:number;plannedPairs:number;admittedPairs:number;
  semanticResponses:Record<Side,number>;semanticErrors:Record<Side,number>;transportErrors:Record<Side,number>;
  latency:{candidate:Summary;reference:Summary;ratio:number}|null;
  effort:{candidateMedian:number;referenceMedian:number}|null;
}
export interface BenchmarkEvaluation {
  schemaVersion:1;evaluatedScope:'reported-evidence';productGoalVerified:false;
  protocolHash:string;comparison:BenchmarkProtocol['comparison'];status:BenchmarkVerdict;
  tracks:{voice:BenchmarkVerdict;remote:BenchmarkVerdict;learning:'NOT_RUN'};
  nativeProductGate:{status:BenchmarkVerdict;reason:string};
  voiceCorpus:Record<'ko'|'en'|'mixed',number>;groups:GroupEvaluation[];
}
export class BenchmarkInputError extends Error {
  constructor(){super('INVALID_BENCHMARK_INPUT');this.name='BenchmarkInputError';}
}
const invalid = ():never => {throw new BenchmarkInputError();};
function object(value:unknown, keys:readonly string[]):Record<string,any> {
  if(!value || typeof value!=='object' || Array.isArray(value))return invalid();
  const prototype=Object.getPrototypeOf(value);
  if(prototype!==Object.prototype&&prototype!==null||Object.getOwnPropertySymbols(value).length)return invalid();
  const actual=Object.getOwnPropertyNames(value);
  if(actual.length!==keys.length || actual.some(k=>!keys.includes(k)))return invalid();
  if(actual.some(k=>{const d=Object.getOwnPropertyDescriptor(value,k)!;return !d.enumerable||!('value' in d);}))return invalid();
  return value as Record<string,any>;
}
function values<T>(value:unknown, choices:readonly T[]):T {
  if(!choices.includes(value as T))return invalid();
  return value as T;
}
function id(value:unknown):string {
  if(typeof value!=='string'||!(/^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/).test(value))return invalid();
  return value;
}
function digest(value:unknown, nullable=false):void {
  if(nullable&&value===null)return;
  if(typeof value!=='string'||!(/^[a-f0-9]{64}$/).test(value))invalid();
}
function number(value:unknown, count=false, maximum=86_400_000):void {
  if(typeof value!=='number'||!Number.isFinite(value)||value<0||value>maximum||count&&!Number.isInteger(value))invalid();
}
function boolean(value:unknown):void {if(typeof value!=='boolean')invalid();}
function array(value:unknown, maximum:number):any[] {
  if(!Array.isArray(value)||value.length>maximum)return invalid();
  if(Object.getPrototypeOf(value)!==Array.prototype||Object.getOwnPropertySymbols(value).length||
    Object.getOwnPropertyNames(value).length!==value.length+1)return invalid();
  for(let i=0;i<value.length;i++){
    const d=Object.getOwnPropertyDescriptor(value,String(i));
    if(!d||!d.enumerable||!('value' in d))return invalid();
  }
  return value;
}
const bindingKeys=['version','artifactHash','sourceHash','settingsHash'] as const;
const conditionKeys=['workloadHash','contextHash','environmentHash','methodHash','clockHash','transport','condition'] as const;
function binding(value:unknown):void {
  const b=object(value,bindingKeys);
  if(typeof b.version!=='string'||!(/^[0-9][a-zA-Z0-9.+_-]{0,63}$/).test(b.version))invalid();
  for(const key of ['artifactHash','sourceHash','settingsHash'])digest(b[key]);
}
function conditions(value:Record<string,any>):void {
  for(const key of ['workloadHash','contextHash','environmentHash','methodHash','clockHash'])digest(value[key]);
  values(value.transport,['webrtc','websocket','relay','native']);id(value.condition);
}
function canonical(value:any):string {
  if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
  if(value!==null&&typeof value==='object')return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';
  return JSON.stringify(value);
}
/** Sort object keys; preserve array order (the corpus and alternating planned pair order). */
export function fingerprintBenchmarkProtocol(protocol:BenchmarkProtocol):string {
  return Array.from(sha256(new TextEncoder().encode(canonical(protocol))), b=>b.toString(16).padStart(2,'0')).join('');
}
export function parseBenchmarkManifest(input:unknown):BenchmarkManifest {
  let value=input;
  if(typeof input==='string') {
    if(new TextEncoder().encode(input).byteLength>BENCHMARK_MAX_BYTES)invalid();
    try{value=JSON.parse(input);}catch{invalid();}
  }
  const m=object(value,['schemaVersion','protocol','trials']);
  if(m.schemaVersion!==1)invalid();
  const p=object(m.protocol,['id','sealedAt','comparison','products','cases','groups']);
  id(p.id);number(p.sealedAt,true,Number.MAX_SAFE_INTEGER);values(p.comparison,['native-product','cli-proxy']);
  const products=object(p.products,sides);for(const side of sides)binding(products[side]);
  const cases=new Map<string,BenchmarkCase>(),voiceInputs=new Set<string>();
  for(const raw of array(p.cases,BENCHMARK_MAX_CASES)) {
    const c=object(raw,['id','domain','language','inputHash','expectedFactsHash']);
    id(c.id);values(c.domain,['voice','remote']);values(c.language,['ko','en','mixed','none']);digest(c.inputHash);digest(c.expectedFactsHash);
    if(cases.has(c.id)||c.domain==='voice'&&c.language==='none'||c.domain==='remote'&&c.language!=='none')invalid();
    if(c.domain==='voice'){if(voiceInputs.has(c.inputHash))invalid();voiceInputs.add(c.inputHash);}
    cases.set(c.id,c as BenchmarkCase);
  }
  const groups=new Map<string,BenchmarkGroup>(),pairs=new Map<string,{groupId:string;caseId:string}>();
  const groupConditions=new Set<string>();
  for(const raw of array(p.groups,32)) {
    const g=object(raw,['id','domain','metric',...conditionKeys,'pairs']);
    id(g.id);values(g.domain,['voice','remote']);
    values(g.metric,g.domain==='voice'?voiceMetrics:remoteMetrics);conditions(g);
    const key=g.domain+':'+g.metric+':'+g.condition;
    if(groups.has(g.id)||groupConditions.has(key))invalid();
    groupConditions.add(key);
    for(const rawPair of array(g.pairs,BENCHMARK_MAX_TRIALS/2)) {
      const pair=object(rawPair,['id','caseId']);id(pair.id);id(pair.caseId);
      if(pairs.has(pair.id)||!cases.has(pair.caseId)||cases.get(pair.caseId)!.domain!==g.domain)invalid();
      pairs.set(pair.id,{groupId:g.id,caseId:pair.caseId});
      if(pairs.size>BENCHMARK_MAX_TRIALS/2)invalid();
    }
    groups.set(g.id,g as BenchmarkGroup);
  }
  const attempts=new Set<string>(),pairSides=new Set<string>();
  for(const raw of array(m.trials,BENCHMARK_MAX_TRIALS)) {
    const t=object(raw,['attemptId','pairId','groupId','caseId','side','protocolHash','inputHash',...bindingKeys,
      ...conditionKeys,'startedAt','outcome','latencyMs','elapsedMs','effortCount','retryCount','manualCommit','cleanup','semantics','violations','proof']);
    for(const key of ['attemptId','pairId','groupId','caseId'])id(t[key]);
    values(t.side,sides);digest(t.protocolHash);digest(t.inputHash);
    binding(Object.fromEntries(bindingKeys.map(k=>[k,t[k]])));conditions(t);
    number(t.startedAt,true,Number.MAX_SAFE_INTEGER);number(t.elapsedMs);number(t.effortCount,true,10000);number(t.retryCount,true,10000);
    values(t.outcome,['ok','timeout','error']);if(t.latencyMs!==null)number(t.latencyMs);
    boolean(t.manualCommit);values(t.cleanup,['confirmed','failed','unknown']);
    const semantics=object(t.semantics,['verdict','source','expectedFactsHash','evidenceHash']);
    values(semantics.verdict,['correct','incorrect','unscored']);values(semantics.source,['human','deterministic','self',null]);
    digest(semantics.expectedFactsHash,true);digest(semantics.evidenceHash,true);
    const violations=new Set<string>();
    for(const v of array(t.violations,6)){
      values(v,['wrong-target','negation-reversed','forbidden-action','duplicate-action','draft-lost','grant-bypass']);
      if(violations.has(v))invalid();violations.add(v);
    }
    const proof=object(t.proof,['surface','physicalDevice','physicalMicrophone','authenticated','taskStateObserved','captureHash']);
    values(proof.surface,['agentstoz-native','codex-native','agentstoz-installed-api','codex-cli','provider-api','fixture']);
    for(const key of ['physicalDevice','physicalMicrophone','authenticated','taskStateObserved'])boolean(proof[key]);
    digest(proof.captureHash,true);
    const planned=pairs.get(t.pairId),pairSide=t.pairId+':'+t.side;
    if(!planned||planned.groupId!==t.groupId||planned.caseId!==t.caseId||attempts.has(t.attemptId)||pairSides.has(pairSide))invalid();
    attempts.add(t.attemptId);pairSides.add(pairSide);
  }
  // Copy only after validating the shallow, bounded shape. No arbitrary unknown values are retained.
  const serialized=JSON.stringify(value);
  if(new TextEncoder().encode(serialized).byteLength>BENCHMARK_MAX_BYTES)invalid();
  return JSON.parse(serialized) as BenchmarkManifest;
}
function summary(samples:number[]):Summary {
  const sorted=[...samples].sort((a,b)=>a-b),n=sorted.length,mid=Math.floor(n/2);
  return {p50:n%2?sorted[mid]!:(sorted[mid-1]!+sorted[mid]!)/2,p95:sorted[Math.ceil(0.95*n)-1]!};
}
function combine(statuses:BenchmarkVerdict[]):BenchmarkVerdict {
  if(statuses.includes('FAIL'))return 'FAIL';
  if(statuses.every(s=>s==='NOT_RUN'))return 'NOT_RUN';
  return statuses.every(s=>s==='PASS')?'PASS':'BLOCKED';
}
function failed(t:BenchmarkTrial):boolean {
  return t.outcome!=='ok'||t.semantics.verdict==='incorrect'||t.violations.length>0||t.cleanup==='failed';
}
function correct(t:BenchmarkTrial):boolean {return t.outcome==='ok'&&t.semantics.verdict==='correct'&&!failed(t);}
export function evaluateBenchmark(input:unknown):BenchmarkEvaluation {
  const {protocol:p,trials}=parseBenchmarkManifest(input),protocolHash=fingerprintBenchmarkProtocol(p);
  const cases=new Map(p.cases.map(c=>[c.id,c])),byPair=new Map<string,Partial<Record<Side,BenchmarkTrial>>>();
  for(const t of trials){const pair=byPair.get(t.pairId)??{};pair[t.side]=t;byPair.set(t.pairId,pair);}
  const corpus={ko:0,en:0,mixed:0},testedCases=new Set<string>();
  for(const g of p.groups.filter(g=>g.domain==='voice')) for(const pair of g.pairs) {
    const reported=byPair.get(pair.id);if(reported?.candidate&&reported.reference)testedCases.add(pair.caseId);
  }
  for(const caseId of testedCases){const c=cases.get(caseId)!;if(c.language!=='none')corpus[c.language]++;}
  const corpusComplete=Object.values(corpus).every(n=>n>=20);
  const evaluations:GroupEvaluation[]=p.groups.map(g=>{
    const rows=trials.filter(t=>t.groupId===g.id),attempts={candidate:0,reference:0},failures={candidate:0,reference:0};
    const semanticResponses={candidate:0,reference:0},semanticErrors={candidate:0,reference:0},transportErrors={candidate:0,reference:0};
    const admission=new Set<string>(),failReasons=new Set<string>();
    for(const t of rows){
      attempts[t.side]++;if(failed(t))failures[t.side]++;
      if(t.semantics.verdict!=='unscored'){semanticResponses[t.side]++;if(t.semantics.verdict==='incorrect')semanticErrors[t.side]++;}
      if(t.outcome!=='ok')transportErrors[t.side]++;
      if(t.side==='candidate'&&(t.violations.length||t.cleanup==='failed'))failReasons.add('UNSAFE_OUTCOME');
      if(t.protocolHash!==protocolHash||bindingKeys.some(k=>t[k]!==p.products[t.side][k]))admission.add('PROTOCOL_OR_BUILD_MISMATCH');
      if(conditionKeys.some(k=>t[k]!==g[k])||t.inputHash!==cases.get(t.caseId)!.inputHash)admission.add('CONDITION_OR_INPUT_MISMATCH');
      if(t.startedAt<p.sealedAt)admission.add('TRIAL_BEFORE_PROTOCOL');
      if(t.manualCommit)admission.add('MANUAL_COMMIT');
      if(t.cleanup!=='confirmed')admission.add('CLEANUP_UNCONFIRMED');
      if(t.proof.captureHash===null)admission.add('CAPTURE_MISSING');
      const expectedSurface=p.comparison==='native-product'
        ?t.side==='candidate'?'agentstoz-native':'codex-native'
        :t.side==='candidate'?'agentstoz-installed-api':'codex-cli';
      if(t.proof.surface!==expectedSurface)admission.add('SURFACE_MISMATCH');
      if(p.comparison==='native-product'&&(!t.proof.physicalDevice||g.domain==='voice'&&!t.proof.physicalMicrophone||
        !t.proof.authenticated||!t.proof.taskStateObserved))admission.add('NATIVE_PROOF_INCOMPLETE');
      // A channel failure cannot erase semantics already independently observed.
      if(t.outcome==='ok'||t.semantics.verdict!=='unscored'){
        if(!['human','deterministic'].includes(t.semantics.source??'')||t.semantics.verdict==='unscored'||!t.semantics.evidenceHash)admission.add('SEMANTICS_UNVERIFIED');
        if(t.semantics.expectedFactsHash!==cases.get(t.caseId)!.expectedFactsHash)admission.add('SEMANTICS_DIGEST_MISMATCH');
        if(t.outcome==='ok'&&g.metric!=='sustained-1h'&&(t.latencyMs===null||t.latencyMs>t.elapsedMs))admission.add('TIMING_UNCONFIRMED');
      }
    }
    let missingAttempts=0;
    const successful:{candidate:BenchmarkTrial;reference:BenchmarkTrial}[]=[];
    for(const [i,pair] of g.pairs.entries()){
      const a=byPair.get(pair.id)?.candidate,b=byPair.get(pair.id)?.reference;
      missingAttempts+=Number(!a)+Number(!b);
      if(!a||!b)continue;
      const before=i%2===0?a:b,after=i%2===0?b:a;
      if(after.startedAt<before.startedAt+before.elapsedMs||after.startedAt-before.startedAt>(g.metric==='sustained-1h'?7_200_000:600_000))
        admission.add('PAIRED_ORDER_OR_WINDOW_MISMATCH');
      if(correct(a)&&correct(b))successful.push({candidate:a,reference:b});
    }
    const e:GroupEvaluation={id:g.id,domain:g.domain,metric:g.metric,condition:g.condition,status:'NOT_RUN',reasons:[],
      attempts,failures,semanticResponses,semanticErrors,transportErrors,missingAttempts,
      plannedPairs:g.pairs.length,admittedPairs:0,latency:null,effort:null};
    if(!rows.length)return e;
    if(missingAttempts)admission.add('PLANNED_ATTEMPT_MISSING');
    if(g.domain==='voice'&&!corpusComplete)admission.add('LANGUAGE_CORPUS_INCOMPLETE');
    if(!admission.size){
      e.admittedPairs=successful.length;
      if(failures.candidate*attempts.reference>failures.reference*attempts.candidate)failReasons.add('FAILURE_RATE_REGRESSION');
      // Wrong answers cannot be traded against silence, nor vice versa.
      if(semanticErrors.candidate*semanticResponses.reference>semanticErrors.reference*semanticResponses.candidate)
        failReasons.add('SEMANTIC_ERROR_REGRESSION');
      if(transportErrors.candidate*attempts.reference>transportErrors.reference*attempts.candidate)
        failReasons.add('TRANSPORT_ERROR_REGRESSION');
      const candidateRetries=rows.filter(t=>t.side==='candidate').reduce((n,t)=>n+t.retryCount,0);
      const referenceRetries=rows.filter(t=>t.side==='reference').reduce((n,t)=>n+t.retryCount,0);
      if(candidateRetries>referenceRetries)failReasons.add('RETRY_REGRESSION');
      if(successful.length<(g.metric==='sustained-1h'?1:BENCHMARK_MIN_PAIRS))admission.add('INSUFFICIENT_PAIRS');
      else if(g.metric==='sustained-1h'){
        if(successful.some(pair=>sides.some(side=>pair[side].elapsedMs<3_600_000)))failReasons.add('SUSTAINED_DURATION_TOO_SHORT');
      } else {
        const candidate=summary(successful.map(pair=>pair.candidate.latencyMs!));
        const reference=summary(successful.map(pair=>pair.reference.latencyMs!));
        if(reference.p95===0){admission.add('REFERENCE_LATENCY_ZERO');}
        else {
        e.latency={candidate,reference,ratio:candidate.p95/reference.p95};
        if(g.metric==='workflow'){
          const a=summary(successful.map(pair=>pair.candidate.effortCount)).p50;
          const b=summary(successful.map(pair=>pair.reference.effortCount)).p50;
          e.effort={candidateMedian:a,referenceMedian:b};
          if(candidate.p95>=reference.p95||a>=b)failReasons.add('WORKFLOW_NOT_EASIER');
        }else if(candidate.p95>reference.p95*BENCHMARK_LATENCY_RATIO)failReasons.add('LATENCY_TARGET_MISSED');
        }
      }
    }
    e.reasons=[...failReasons,...admission];
    e.status=failReasons.size?'FAIL':admission.size?'BLOCKED':'PASS';
    return e;
  });
  // A caller cannot omit an entire required metric from its protocol and get an overall pass.
  for(const domain of ['voice','remote'] as const)for(const metric of domain==='voice'?voiceMetrics:remoteMetrics){
    if(!evaluations.some(g=>g.domain===domain&&g.metric===metric))evaluations.push({
      id:'missing_'+metric,domain,metric,condition:'required',status:'NOT_RUN',reasons:['METRIC_NOT_DECLARED'],
      attempts:{candidate:0,reference:0},failures:{candidate:0,reference:0},missingAttempts:0,
      semanticResponses:{candidate:0,reference:0},semanticErrors:{candidate:0,reference:0},transportErrors:{candidate:0,reference:0},
      plannedPairs:0,admittedPairs:0,latency:null,effort:null,
    });
  }
  const tracks={voice:combine(evaluations.filter(g=>g.domain==='voice').map(g=>g.status)),
    remote:combine(evaluations.filter(g=>g.domain==='remote').map(g=>g.status)),learning:'NOT_RUN' as const};
  const comparison=combine([tracks.voice,tracks.remote]);
  const nativeStatus:BenchmarkVerdict=comparison==='FAIL'?'FAIL':!trials.length?'NOT_RUN':
    p.comparison==='cli-proxy'||comparison!=='PASS'?'BLOCKED':'PASS';
  return {schemaVersion:1,evaluatedScope:'reported-evidence',productGoalVerified:false,protocolHash,comparison:p.comparison,
    status:nativeStatus,tracks,nativeProductGate:{status:nativeStatus,reason:p.comparison==='cli-proxy'?'CLI_PROXY_IS_NOT_NATIVE_PRODUCT':'REPORTED_CRITERIA_ONLY'},
    voiceCorpus:corpus,groups:evaluations};
}
