import {canonicalJson, sha256Hex} from './voiceEvalCorpus';
import {BENCHMARK_MIN_PAIRS, parseBenchmarkManifest, type BenchmarkProtocol} from './voiceRemoteBenchmark';

/**
 * Seals a BenchmarkProtocol from an operator spec and issues the paired run order. Pure: no clock (callers pass
 * `now`), no filesystem, no provider. The evaluator (voiceRemoteBenchmark.ts) stays the judge; this module only
 * produces input it will accept and refuses to hand out a step the evaluator would reject.
 *
 * Rules mirrored from the evaluator and BENCHMARK.md:
 *  - pair index i: candidate first when i is even, reference first when odd;
 *  - the second side starts at or after the first side ends, and at most 10 min (2 h for sustained-1h)
 *    after the first side started;
 *  - no trial before `sealedAt`; voice inputs are distinct audio.
 */
type Side = 'candidate'|'reference';
type Case = BenchmarkProtocol['cases'][number];
type Group = BenchmarkProtocol['groups'][number];
type Binding = BenchmarkProtocol['products'][Side];
export const BENCHMARK_REQUIRED_METRICS = [
  {domain:'voice',metric:'response'},{domain:'voice',metric:'interrupt'},{domain:'voice',metric:'resume'},
  {domain:'remote',metric:'workflow'},{domain:'remote',metric:'wifi-change'},{domain:'remote',metric:'lock-return'},
  {domain:'remote',metric:'host-restart'},{domain:'remote',metric:'sustained-1h'},
] as const satisfies readonly {domain:Group['domain'];metric:Group['metric']}[];
export const BENCHMARK_PAIR_WINDOW_MS = 600_000;
export const BENCHMARK_SUSTAINED_PAIR_WINDOW_MS = 7_200_000;

export interface BenchmarkGroupSpec {
  id?:string;domain:Group['domain'];metric:Group['metric'];condition:string;transport:Group['transport'];
  workloadHash:string;contextHash:string;environmentHash:string;methodHash:string;clockHash:string;
  /** Defaults to ceil(required / expectedPairSuccess); explicit values below the required count are refused. */
  plannedPairs?:number;
  /** Cases rotated through this group's pairs. Defaults to every case of the group's domain. */
  caseIds?:string[];
}
export interface BenchmarkProtocolSpec {
  id:string;sealedAt:number;comparison:BenchmarkProtocol['comparison'];products:Record<Side,Binding>;
  cases:Case[];groups:BenchmarkGroupSpec[];
  /**
   * Expected fraction of pairs in which both sides succeed (0 < x ≤ 1). Overbooking = 1/x: a failed pair still
   * counts in the failure denominator, so extra planned pairs are the only honest way to reach 30 good pairs.
   */
  expectedPairSuccess:number;
}
const fail=(code:string):never=>{throw new Error(code);};
const ID=/^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/;
export const requiredPairs=(metric:Group['metric'])=>metric==='sustained-1h'?1:BENCHMARK_MIN_PAIRS;
export const pairWindowMs=(metric:Group['metric'])=>metric==='sustained-1h'?BENCHMARK_SUSTAINED_PAIR_WINDOW_MS:BENCHMARK_PAIR_WINDOW_MS;
/** Interleave languages so a partially run group stays balanced: ko, en, mixed, ko, en, mixed, … */
function interleaved(cases:Case[]):Case[] {
  const byLang=new Map<string,Case[]>();
  for(const c of cases){const list=byLang.get(c.language)??[];list.push(c);byLang.set(c.language,list);}
  const lanes=[...byLang.values()],out:Case[]=[];
  for(let i=0;out.length<cases.length;i++)for(const lane of lanes)if(lane[i])out.push(lane[i]!);
  return out;
}
export function benchmarkSpecHash(spec:BenchmarkProtocolSpec):string {return sha256Hex(canonicalJson(spec));}
export function buildBenchmarkProtocol(spec:BenchmarkProtocolSpec):BenchmarkProtocol {
  if(!ID.test(spec.id))fail('BENCHMARK_SPEC_ID_INVALID');
  if(!Number.isSafeInteger(spec.sealedAt)||spec.sealedAt<0)fail('BENCHMARK_SPEC_SEALED_AT_INVALID');
  if(!(typeof spec.expectedPairSuccess==='number'&&spec.expectedPairSuccess>0&&spec.expectedPairSuccess<=1))fail('BENCHMARK_PAIR_SUCCESS_INVALID');
  const voiceInputs=new Set<string>(),cases=new Map<string,Case>();
  for(const c of spec.cases){
    if(cases.has(c.id))fail('BENCHMARK_CASE_DUPLICATE');
    if(c.domain==='voice'){if(voiceInputs.has(c.inputHash))fail('BENCHMARK_VOICE_INPUT_DUPLICATE');voiceInputs.add(c.inputHash);}
    cases.set(c.id,{id:c.id,domain:c.domain,language:c.language,inputHash:c.inputHash,expectedFactsHash:c.expectedFactsHash});
  }
  const groups:Group[]=spec.groups.map((g,index)=>{
    const required=requiredPairs(g.metric),computed=Math.ceil(required/spec.expectedPairSuccess);
    const pool=g.caseIds?g.caseIds.map(id=>cases.get(id)??fail('BENCHMARK_CASE_UNKNOWN')):interleaved([...cases.values()].filter(c=>c.domain===g.domain));
    if(!pool.length||pool.some(c=>c.domain!==g.domain))fail('BENCHMARK_GROUP_CASES_INVALID');
    let planned=g.plannedPairs??computed;
    if(!Number.isSafeInteger(planned)||planned<required)fail('BENCHMARK_PLANNED_PAIRS_TOO_FEW');
    // A voice group drawing on the whole corpus covers each case at least once (distinct-case gate).
    if(g.domain==='voice'&&!g.caseIds&&g.plannedPairs===undefined)planned=Math.max(planned,pool.length);
    const id=g.id??`g${index}_${g.domain}_${g.metric}_${g.condition}`.replace(/[^a-zA-Z0-9_-]/g,'_').slice(0,80);
    return {id,domain:g.domain,metric:g.metric,condition:g.condition,workloadHash:g.workloadHash,contextHash:g.contextHash,
      environmentHash:g.environmentHash,methodHash:g.methodHash,clockHash:g.clockHash,transport:g.transport,
      pairs:Array.from({length:planned},(_,i)=>({id:`p${index}_${i}`,caseId:pool[i%pool.length]!.id}))};
  });
  const protocol:BenchmarkProtocol={id:spec.id,sealedAt:spec.sealedAt,comparison:spec.comparison,
    products:{candidate:{...spec.products.candidate},reference:{...spec.products.reference}},
    cases:[...cases.values()],groups};
  // The evaluator's own validator is the final word on shape and budgets.
  parseBenchmarkManifest({schemaVersion:1,protocol,trials:[]});
  return protocol;
}

export interface ScheduledTrial {pairId:string;side:Side;startedAt:number;elapsedMs:number}
interface StepTarget {groupId:string;pairId:string;pairIndex:number;caseId:string;side:Side}
export type OperatorStep =
  |({kind:'run';earliestStartAt:number;latestStartAt:number|null}&StepTarget)
  |({kind:'wait';until:number;latestStartAt:number}&StepTarget)
  |{kind:'refused';reason:'BEFORE_SEAL'|'WINDOW_EXPIRED'|'ORDER_VIOLATED'|'UNKNOWN_TRIAL'|'DUPLICATE_TRIAL';pairId?:string}
  |{kind:'complete'};
/**
 * The next thing the operator may do, in protocol order. Refusals are final for the protocol: a broken pair cannot
 * be repaired by running it late, and a retry is a new planned pair in a new protocol (BENCHMARK.md).
 */
export function nextOperatorStep(protocol:BenchmarkProtocol, trials:readonly ScheduledTrial[], now:number):OperatorStep {
  if(now<protocol.sealedAt)return {kind:'refused',reason:'BEFORE_SEAL'};
  const where=new Map<string,{group:Group;index:number}>();
  for(const group of protocol.groups)group.pairs.forEach((pair,index)=>where.set(pair.id,{group,index}));
  const byPair=new Map<string,Partial<Record<Side,ScheduledTrial>>>();
  for(const t of trials){
    if(!where.has(t.pairId))return {kind:'refused',reason:'UNKNOWN_TRIAL',pairId:t.pairId};
    const pair=byPair.get(t.pairId)??{};
    if(pair[t.side])return {kind:'refused',reason:'DUPLICATE_TRIAL',pairId:t.pairId};
    pair[t.side]=t;byPair.set(t.pairId,pair);
  }
  for(const group of protocol.groups)for(const [index,pair] of group.pairs.entries()){
    const first:Side=index%2===0?'candidate':'reference',second:Side=first==='candidate'?'reference':'candidate';
    const done=byPair.get(pair.id)??{},target={groupId:group.id,pairId:pair.id,pairIndex:index,caseId:pair.caseId};
    const a=done[first],b=done[second],window=pairWindowMs(group.metric);
    if(!a&&b)return {kind:'refused',reason:'ORDER_VIOLATED',pairId:pair.id};
    if(!a)return {kind:'run',...target,side:first,earliestStartAt:protocol.sealedAt,latestStartAt:null};
    const earliest=a.startedAt+a.elapsedMs,latest=a.startedAt+window;
    if(b){
      if(b.startedAt<earliest||b.startedAt>latest)return {kind:'refused',reason:'ORDER_VIOLATED',pairId:pair.id};
      continue;
    }
    if(now>latest)return {kind:'refused',reason:'WINDOW_EXPIRED',pairId:pair.id};
    if(now<earliest)return {kind:'wait',...target,side:second,until:earliest,latestStartAt:latest};
    return {kind:'run',...target,side:second,earliestStartAt:earliest,latestStartAt:latest};
  }
  return {kind:'complete'};
}
