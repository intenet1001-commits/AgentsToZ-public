import {VOICE_EVAL_CORPUS, canonicalJson, corpusHash, sha256Hex, type VoiceEvalCorpus, type VoiceEvalLang} from './voiceEvalCorpus';
import type {RealtimeAudioOverrides} from './voiceRealtimeProvider';
import type {VoiceEvalVariant} from './voiceEvalSynth';

/**
 * Pre-registered Korean accuracy experiment over product audio conditions (offline planning and analysis only;
 * the live runner is scripts/voice-eval-live.ts). Pure and seeded.
 *
 * Design: every block = one (case, voice, variant, rep) and runs EVERY condition, so each case meets each
 * condition equally and comparisons are paired. Block order is shuffled by seed; inside blocks the order is
 * counterbalanced ABBA-style (block 2j+1 runs block 2j's order reversed). An A/A duplicate of the baseline
 * ("<baseline>~aa", identical settings) measures provider run-to-run variance.
 *
 * Invalid trials (condition not confirmed by the provider, provider error, never-run) stay in every denominator;
 * a trial invalid only on the candidate side counts as a candidate failure in the paired comparison.
 * decideExperiment() can only answer insufficient-evidence | no-change | candidate-for-physical-confirmation.
 * Nothing here can ship a default: a candidate still needs physical-microphone confirmation.
 */
export interface ExperimentCondition {id:string;audio:RealtimeAudioOverrides}
export interface ExperimentSpec {
  seed:number;caseIds:string[];reps:number;variants:readonly VoiceEvalVariant[];
  voices:Record<VoiceEvalLang,string[]>;baseline:string;conditions:ExperimentCondition[];aaControl?:boolean;
}
export interface PlannedTrial {
  trialId:string;position:number;blockId:string;caseId:string;lang:VoiceEvalLang;voice:string;variant:VoiceEvalVariant;rep:number;condition:string;
}
export interface ExperimentPlan {
  schema:'agentstoz-voice-experiment-v1';seed:number;corpusHash:string;baseline:string;aaCondition:string|null;
  conditions:ExperimentCondition[];gates:typeof EXPERIMENT_GATES;trials:PlannedTrial[];
}
export const EXPERIMENT_GATES = {
  minKoItems:20,minVoices:3,minValidKoPairs:120,minKoGainPp:10,alpha:0.05,nonInferiorityPp:-5,
} as const;
export function mulberry32(seed:number):()=>number {
  let a=seed>>>0;
  return ()=>{a=(a+0x6d2b79f5)>>>0;let t=a;t=Math.imul(t^(t>>>15),t|1);t^=t+Math.imul(t^(t>>>7),t|61);return ((t^(t>>>14))>>>0)/4294967296;};
}
function shuffle<T>(items:T[], rng:()=>number):T[] {
  const out=[...items];
  for(let i=out.length-1;i>0;i--){const j=Math.floor(rng()*(i+1));[out[i],out[j]]=[out[j]!,out[i]!];}
  return out;
}
export function buildExperimentPlan(spec:ExperimentSpec, corpus:VoiceEvalCorpus=VOICE_EVAL_CORPUS):ExperimentPlan {
  if(!Number.isSafeInteger(spec.seed)||!Number.isSafeInteger(spec.reps)||spec.reps<1)throw new Error('EXPERIMENT_SPEC_INVALID');
  const ids=new Set(spec.conditions.map(c=>c.id));
  if(ids.size!==spec.conditions.length||!ids.has(spec.baseline)||spec.conditions.length<2)throw new Error('EXPERIMENT_CONDITIONS_INVALID');
  const conditions=[...spec.conditions];
  const baseline=conditions.find(c=>c.id===spec.baseline)!,aaCondition=spec.aaControl===false?null:`${spec.baseline}~aa`;
  if(aaCondition)conditions.push({id:aaCondition,audio:structuredClone(baseline.audio)});
  const items=new Map(corpus.items.map(i=>[i.id,i]));
  const blocks:{caseId:string;lang:VoiceEvalLang;voice:string;variant:VoiceEvalVariant;rep:number}[]=[];
  for(const caseId of spec.caseIds){
    const item=items.get(caseId);if(!item)throw new Error('EXPERIMENT_CASE_UNKNOWN');
    for(const voice of spec.voices[item.lang])for(const variant of spec.variants)for(let rep=0;rep<spec.reps;rep++)
      blocks.push({caseId,lang:item.lang,voice,variant,rep});
  }
  const rng=mulberry32(spec.seed),order=shuffle(blocks,rng),trials:PlannedTrial[]=[];
  let forward:string[]=[];
  order.forEach((block,index)=>{
    if(index%2===0)forward=shuffle(conditions.map(c=>c.id),rng);
    const sequence=index%2===0?forward:[...forward].reverse(),blockId=`b${String(index).padStart(5,'0')}`;
    for(const condition of sequence)trials.push({trialId:`${blockId}-${condition}`,position:trials.length,blockId,...block,condition});
  });
  return {schema:'agentstoz-voice-experiment-v1',seed:spec.seed,corpusHash:corpusHash(corpus),baseline:spec.baseline,aaCondition,
    conditions,gates:EXPERIMENT_GATES,trials};
}
/** Pre-registration fingerprint: seed, conditions, gates, corpus and the exact run order. */
export const experimentPlanHash=(plan:ExperimentPlan)=>sha256Hex(canonicalJson(plan));

/**
 * Exact two-sided McNemar p-value: binomial test on the discordant pairs. Summed in log space: 2^-n underflows
 * to 0 in float64 above ~1074 discordant pairs, which would make every large pooled run look "significant".
 */
export function mcnemarExactP(b:number, c:number):number {
  const n=b+c;if(!n)return 1;
  const k=Math.min(b,c),logs:number[]=[];let log=-n*Math.LN2;
  for(let i=0;i<=k;i++){logs.push(log);log+=Math.log(n-i)-Math.log(i+1);}
  const max=Math.max(...logs);let sum=0;for(const l of logs)sum+=Math.exp(l-max);
  return Math.min(1,2*Math.exp(max)*sum);
}
export function wilsonInterval(successes:number, n:number, z=1.959963985):{estimate:number|null;low:number|null;high:number|null} {
  if(!n)return {estimate:null,low:null,high:null};
  const p=successes/n,d=1+z*z/n,center=(p+z*z/(2*n))/d,half=z*Math.sqrt(p*(1-p)/n+z*z/(4*n*n))/d;
  return {estimate:p,low:Math.max(0,center-half),high:Math.min(1,center+half)};
}
/** Paired difference of proportions (candidate − baseline) with a Wald interval over n paired trials. */
export function pairedDifferenceInterval(b:number, c:number, n:number, z=1.959963985):{estimate:number|null;low:number|null;high:number|null} {
  if(!n)return {estimate:null,low:null,high:null};
  const d=(c-b)/n,se=Math.sqrt(Math.max(0,b+c-(c-b)**2/n))/n;
  return {estimate:d,low:d-z*se,high:d+z*se};
}

export interface ExperimentTrialResult {trialId:string;verdict:string}
const success=(v:string)=>v==='correct'||v==='exact';
/**
 * validPairs: both sides valid. invalidPairs: either side invalid (reported). A pair invalid on the compared
 * condition only (candidateInvalidPairs) is still scored, as a failure of that condition: a candidate that stops
 * producing valid trials (provider error, VAD never starting) must be penalised, not filtered out of the
 * comparison. A pair invalid on the baseline side (baselineInvalidPairs, or both sides) is not scored — counting
 * it as a baseline failure would inflate the candidate's gain. b/c, p and the gain use validPairs+candidateInvalidPairs.
 */
interface PairCounts {validPairs:number;invalidPairs:number;candidateInvalidPairs:number;baselineInvalidPairs:number;b:number;c:number}
const scoredPairs=(p:PairCounts)=>p.validPairs+p.candidateInvalidPairs;
export interface LanguageAnalysis extends PairCounts {
  conditions:Record<string,{attempts:number;correct:number;invalid:number;accuracy:ReturnType<typeof wilsonInterval>}>;
  p:number;gain:ReturnType<typeof pairedDifferenceInterval>;distinctItems:number;voices:number;
  aa:PairCounts|null;
}
export interface ExperimentAnalysis {
  candidate:string;baseline:string;languages:Record<VoiceEvalLang,LanguageAnalysis>;noisy:PairCounts;
}
/** Results keyed by planned trial id; planned trials without a result count as invalid (never silently dropped). */
export function analyzeExperiment(plan:ExperimentPlan, results:ExperimentTrialResult[], candidate:string):ExperimentAnalysis {
  const planned=new Map(plan.trials.map(t=>[t.trialId,t]));
  if(!plan.conditions.some(c=>c.id===candidate)||candidate===plan.baseline)throw new Error('EXPERIMENT_CANDIDATE_INVALID');
  const verdicts=new Map<string,string>();
  for(const r of results){if(!planned.has(r.trialId)||verdicts.has(r.trialId))throw new Error('EXPERIMENT_RESULT_UNKNOWN');verdicts.set(r.trialId,r.verdict);}
  const verdict=(t:PlannedTrial)=>verdicts.get(t.trialId)??'invalid';
  const blocks=new Map<string,Map<string,PlannedTrial>>();
  for(const t of plan.trials){const m=blocks.get(t.blockId)??new Map();m.set(t.condition,t);blocks.set(t.blockId,m);}
  const empty=():PairCounts=>({validPairs:0,invalidPairs:0,candidateInvalidPairs:0,baselineInvalidPairs:0,b:0,c:0});
  const count=(acc:PairCounts,base:PlannedTrial|undefined,other:PlannedTrial|undefined)=>{
    if(!base||!other)return;
    const x=verdict(base),y=verdict(other);
    if(x==='invalid'||y==='invalid'){
      acc.invalidPairs++;
      if(x==='invalid'){if(y!=='invalid')acc.baselineInvalidPairs++;return;}
      acc.candidateInvalidPairs++;if(success(x))acc.b++;return;
    }
    acc.validPairs++;if(success(x)&&!success(y))acc.b++;if(!success(x)&&success(y))acc.c++;
  };
  const languages={} as Record<VoiceEvalLang,LanguageAnalysis>,noisy=empty();
  for(const lang of ['ko','en','mixed'] as const){
    const trials=plan.trials.filter(t=>t.lang===lang),pairs=empty(),aa=plan.aaCondition?empty():null;
    const items=new Set<string>(),voices=new Set<string>();
    for(const [,block] of blocks){
      const base=block.get(plan.baseline);if(!base||base.lang!==lang)continue;
      const before=pairs.validPairs;
      count(pairs,base,block.get(candidate));
      if(pairs.validPairs>before){items.add(base.caseId);voices.add(base.voice);}
      if(aa)count(aa,base,block.get(plan.aaCondition!));
      if(base.variant.startsWith('pink'))count(noisy,base,block.get(candidate));
    }
    const conditions:LanguageAnalysis['conditions']={};
    for(const c of plan.conditions){
      const rows=trials.filter(t=>t.condition===c.id),correct=rows.filter(t=>success(verdict(t))).length;
      conditions[c.id]={attempts:rows.length,correct,invalid:rows.filter(t=>verdict(t)==='invalid').length,accuracy:wilsonInterval(correct,rows.length)};
    }
    languages[lang]={...pairs,conditions,p:mcnemarExactP(pairs.b,pairs.c),gain:pairedDifferenceInterval(pairs.b,pairs.c,scoredPairs(pairs)),
      distinctItems:items.size,voices:voices.size,aa};
  }
  return {candidate,baseline:plan.baseline,languages,noisy};
}
export type ExperimentDecision = 'insufficient-evidence'|'no-change'|'candidate-for-physical-confirmation';
export function decideExperiment(analysis:ExperimentAnalysis):{decision:ExperimentDecision;reasons:string[]} {
  const g=EXPERIMENT_GATES,ko=analysis.languages.ko,insufficient:string[]=[],failed:string[]=[];
  if(ko.distinctItems<g.minKoItems)insufficient.push('TOO_FEW_KO_ITEMS');
  if(ko.voices<g.minVoices)insufficient.push('TOO_FEW_VOICES');
  if(ko.validPairs<g.minValidKoPairs)insufficient.push('TOO_FEW_VALID_KO_PAIRS');
  if(!ko.aa||!ko.aa.validPairs)insufficient.push('NO_AA_CONTROL');
  if(!analysis.languages.en.validPairs)insufficient.push('NO_EN_PAIRS');
  if(!analysis.languages.mixed.validPairs)insufficient.push('NO_MIXED_PAIRS');
  if(!analysis.noisy.validPairs)insufficient.push('NO_NOISY_SUBSET');
  if(insufficient.length)return {decision:'insufficient-evidence',reasons:insufficient};
  if((ko.gain.estimate??0)*100<g.minKoGainPp)failed.push('KO_GAIN_BELOW_THRESHOLD');
  if(ko.c<=ko.b||ko.p>=g.alpha)failed.push('KO_GAIN_NOT_SIGNIFICANT');
  for(const lang of ['en','mixed'] as const)
    if((analysis.languages[lang].gain.low??-1)*100<g.nonInferiorityPp)failed.push(`${lang.toUpperCase()}_NON_INFERIORITY_FAILED`);
  if(analysis.noisy.c<analysis.noisy.b)failed.push('NOISY_SUBSET_WORSE');
  // The candidate is invalid more often than the baseline (exact test on the one-sided invalid pairs).
  if(ko.candidateInvalidPairs>ko.baselineInvalidPairs&&mcnemarExactP(ko.baselineInvalidPairs,ko.candidateInvalidPairs)<g.alpha)
    failed.push('CANDIDATE_INVALID_RATE_HIGHER');
  const aaRate=(ko.aa!.b+ko.aa!.c)/scoredPairs(ko.aa!),abRate=(ko.b+ko.c)/scoredPairs(ko);
  if(!(aaRate<abRate))failed.push('AA_DISCORDANCE_NOT_BELOW_AB');
  return failed.length?{decision:'no-change',reasons:failed}:{decision:'candidate-for-physical-confirmation',reasons:[]};
}
