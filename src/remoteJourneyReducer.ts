import {canonicalJson, sha256Hex} from './voiceEvalCorpus';
import type {CaptureRecord} from './voiceBenchmarkAssembler';
import type {BenchmarkTrial} from './voiceRemoteBenchmark';

/**
 * Candidate-side remote journey: a device harness writes an append-only event log, this module reduces it to the
 * numbers a remote BenchmarkTrial carries (latency, effort, retries, violations, observed task state). Pure: no
 * clock, filesystem, device or provider. The evaluator (voiceRemoteBenchmark.ts) stays the judge.
 *
 * Honest outputs:
 *  - latency is null whenever its clock is not fully observed (no answer, an answer past the deadline, a recovery
 *    metric without a recorded perturbation end or whose request was sent or answered before that end, sustained-1h)
 *    — never 0 and never typed in;
 *  - effort = taps + re-entries the human (or the harness on the human's behalf) had to make;
 *  - duplicate-action needs evidence of a second execution (two written receipts or two nonce answers), never a
 *    second tap alone — an idempotent replay that returns the same receipt is a retry, not a duplicate;
 *  - draft-lost needs the composer to lose an undelivered draft that never comes back (the legacy input path, a submit
 *    without a submission id, empties the composer itself — that clear is the send);
 *  - grant-bypass needs input sent while the grant was revoked that was nevertheless written or answered; without a
 *    submission id that evidence is attributed only when no earlier request is still unanswered (BYPASS_UNATTRIBUTABLE);
 *  - taskStateObserved is true only when a written receipt and the nonce answer were both seen.
 */
export const REMOTE_JOURNEY_METRICS = ['workflow','wifi-change','lock-return','host-restart','sustained-1h'] as const;
export type RemoteJourneyMetric = typeof REMOTE_JOURNEY_METRICS[number];
export const REMOTE_JOURNEY_MAX_EVENTS = 4096;
export const REMOTE_JOURNEY_MAX_BYTES = 2 * 1024 * 1024;
const MAX_SPAN_MS = 86_400_000;
const RECEIPT_STATES = ['prepared','write_started','written','unknown','rejected','held'] as const;
type ReceiptState = typeof RECEIPT_STATES[number];
type Cause = 'wifi'|'lock'|'host-restart';
export type RemoteJourneyEvent =
  |{t:number;kind:'tap';target:string}
  |{t:number;kind:'reentry';reason:'lock'|'relaunch'|'navigation'|'reconnect'}
  /** Observed composer content as a digest (never the text). `intentional` marks a deliberate rewrite. */
  |{t:number;kind:'draft';digest:string|null;intentional:boolean}
  |{t:number;kind:'submit';submissionId:string|null;draftDigest:string;targetId:string}
  |{t:number;kind:'receipt';submissionId:string|null;storeId:string|null;state:ReceiptState;targetId:string|null}
  /** The nonce answer seen on the terminal; `count` is how many answer markers were on screen at that moment. */
  |{t:number;kind:'answer';nonce:string;count:number}
  |{t:number;kind:'disconnect';cause:Cause|'other'}
  |{t:number;kind:'reconnect'}
  /** A human-performed perturbation (the harness prompts for it and records when the human says start/end). */
  |{t:number;kind:'perturb';phase:'start'|'end';cause:Cause}
  |{t:number;kind:'gate';grant:'revoked'|'granted'};
export interface RemoteJourneyLog {
  schemaVersion:1;metric:RemoteJourneyMetric;nonce:string;deadlineMs:number;events:RemoteJourneyEvent[];
}
type Violation = BenchmarkTrial['violations'][number];
export interface RemoteJourneyReduction {
  outcome:'ok'|'timeout'|'error';latencyMs:number|null;elapsedMs:number;startedAt:number;
  effortCount:number;retryCount:number;violations:Violation[];taskStateObserved:boolean;reasons:string[];
}
export class RemoteJourneyInputError extends Error {
  constructor(){super('INVALID_REMOTE_JOURNEY_LOG');this.name='RemoteJourneyInputError';}
}
const invalid=():never=>{throw new RemoteJourneyInputError();};
const ID=/^[A-Za-z0-9_-]{8,160}$/, TARGET=/^[A-Za-z0-9_.:-]{1,160}$/, NONCE=/^[A-Za-z0-9_-]{8,64}$/, DIGEST=/^[a-f0-9]{64}$/;
const EVENT_KEYS:Record<RemoteJourneyEvent['kind'],readonly string[]>={
  tap:['target'],reentry:['reason'],draft:['digest','intentional'],submit:['submissionId','draftDigest','targetId'],
  receipt:['submissionId','storeId','state','targetId'],answer:['nonce','count'],disconnect:['cause'],reconnect:[],
  perturb:['phase','cause'],gate:['grant'],
};
function plain(value:unknown, keys:readonly string[]):Record<string,unknown> {
  if(!value||typeof value!=='object'||Array.isArray(value))return invalid();
  const prototype=Object.getPrototypeOf(value);
  if(prototype!==Object.prototype&&prototype!==null)return invalid();
  const actual=Object.keys(value);
  if(actual.length!==keys.length||actual.some(k=>!keys.includes(k)))return invalid();
  return value as Record<string,unknown>;
}
const one=<T>(value:unknown, choices:readonly T[]):T=>choices.includes(value as T)?value as T:invalid();
const text=(value:unknown, pattern:RegExp, nullable=false):void=>{
  if(nullable&&value===null)return;
  if(typeof value!=='string'||!pattern.test(value))invalid();
};
function integer(value:unknown, min:number, max:number):number {
  if(typeof value!=='number'||!Number.isSafeInteger(value)||value<min||value>max)return invalid();
  return value;
}
function event(raw:unknown):RemoteJourneyEvent {
  if(!raw||typeof raw!=='object'||Array.isArray(raw))return invalid();
  const kind=one((raw as {kind?:unknown}).kind,Object.keys(EVENT_KEYS) as RemoteJourneyEvent['kind'][]);
  const e=plain(raw,['t','kind',...EVENT_KEYS[kind]]);
  integer(e.t,0,Number.MAX_SAFE_INTEGER);
  switch(kind){
    case 'tap':text(e.target,TARGET);break;
    case 'reentry':one(e.reason,['lock','relaunch','navigation','reconnect']);break;
    case 'draft':text(e.digest,DIGEST,true);if(typeof e.intentional!=='boolean')invalid();break;
    case 'submit':text(e.submissionId,ID,true);text(e.draftDigest,DIGEST);text(e.targetId,TARGET);break;
    case 'receipt':text(e.submissionId,ID,true);text(e.storeId,ID,true);one(e.state,RECEIPT_STATES);text(e.targetId,TARGET,true);break;
    case 'answer':text(e.nonce,NONCE);integer(e.count,1,1000);break;
    case 'disconnect':one(e.cause,['wifi','lock','host-restart','other']);break;
    case 'reconnect':break;
    case 'perturb':one(e.phase,['start','end']);one(e.cause,['wifi','lock','host-restart']);break;
    case 'gate':one(e.grant,['revoked','granted']);break;
  }
  return e as unknown as RemoteJourneyEvent;
}
/** Strict admission: exact keys per kind, bounded size, non-decreasing time, bounded span. Returns a detached copy. */
export function parseRemoteJourneyLog(input:unknown):RemoteJourneyLog {
  let value=input;
  if(typeof input==='string'){
    if(new TextEncoder().encode(input).byteLength>REMOTE_JOURNEY_MAX_BYTES)invalid();
    try{value=JSON.parse(input);}catch{invalid();}
  }
  const log=plain(value,['schemaVersion','metric','nonce','deadlineMs','events']);
  if(log.schemaVersion!==1)invalid();
  one(log.metric,REMOTE_JOURNEY_METRICS);text(log.nonce,NONCE);integer(log.deadlineMs,1,MAX_SPAN_MS);
  if(!Array.isArray(log.events)||log.events.length<1||log.events.length>REMOTE_JOURNEY_MAX_EVENTS)invalid();
  const events=(log.events as unknown[]).map(event);
  for(let i=1;i<events.length;i++)if(events[i]!.t<events[i-1]!.t)invalid();
  if(events.at(-1)!.t-events[0]!.t>MAX_SPAN_MS)invalid();
  return JSON.parse(JSON.stringify({...log,events})) as RemoteJourneyLog;
}
const VIOLATION_ORDER:readonly Violation[]=['wrong-target','negation-reversed','forbidden-action','duplicate-action','draft-lost','grant-bypass'];
const RECOVERY_CAUSE:Partial<Record<RemoteJourneyMetric,Cause>>={'wifi-change':'wifi','lock-return':'lock','host-restart':'host-restart'};
type Ev<K extends RemoteJourneyEvent['kind']>=Extract<RemoteJourneyEvent,{kind:K}>;
const of=<K extends RemoteJourneyEvent['kind']>(events:RemoteJourneyEvent[], kind:K)=>events.filter((e):e is Ev<K>=>e.kind===kind);

export function reduceRemoteJourney(input:unknown):RemoteJourneyReduction {
  const log=parseRemoteJourneyLog(input),events=log.events,reasons=new Set<string>(),violations=new Set<Violation>();
  const t0=events[0]!.t,deadlineAt=t0+log.deadlineMs;
  const submits=of(events,'submit'),receipts=of(events,'receipt'),firstSubmit=submits[0];
  const answers=of(events,'answer').filter(a=>a.nonce===log.nonce);
  if(!firstSubmit)reasons.add('NO_SUBMIT');
  if(answers.some(a=>!firstSubmit||a.t<firstSubmit.t))reasons.add('ANSWER_BEFORE_SUBMIT');
  const firstAnswer=firstSubmit?answers.find(a=>a.t>=firstSubmit.t&&a.t<=deadlineAt):undefined;
  const written=receipts.filter(r=>r.state==='written');
  const writtenIds=new Set(written.flatMap(r=>r.submissionId?[r.submissionId]:[]));
  const submitIds=new Set(submits.flatMap(s=>s.submissionId?[s.submissionId]:[]));
  if(receipts.some(r=>r.submissionId&&!submitIds.has(r.submissionId)))reasons.add('RECEIPT_WITHOUT_SUBMIT');
  /** Written (or, without a submission id, answered) — the request reached the CLI. */
  const reached=(s:Ev<'submit'>)=>s.submissionId?writtenIds.has(s.submissionId)
    :written.some(r=>r.submissionId===null&&r.t>=s.t)||answers.some(a=>a.t>=s.t);
  const delivered=(digest:string)=>submits.some(s=>s.draftDigest===digest&&reached(s));

  // duplicate-action: evidence of a second execution, not of a second tap.
  if(new Set(written.flatMap(r=>r.storeId?[r.storeId]:[])).size>1||writtenIds.size>1||answers.some(a=>a.count>1))
    violations.add('duplicate-action');
  // wrong-target: the host wrote the request somewhere other than where it was sent.
  for(const r of receipts){
    if(!r.submissionId||r.targetId===null)continue;
    const sent=submits.find(s=>s.submissionId===r.submissionId);
    if(sent&&sent.targetId!==r.targetId)violations.add('wrong-target');
  }
  // draft-lost: an undelivered draft left the composer and never came back. A submit without a submission id is the
  // panel's legacy input path (no terminal-submission-v1): it hands the text to the transport and empties the composer
  // itself, so clearing the very draft it sent — while that draft was on screen — is the send, not a loss.
  const drafts=of(events,'draft');
  let current:string|null=null,currentSince=t0;
  const handedOver=(digest:string,from:number,to:number)=>
    submits.some(s=>s.submissionId===null&&s.draftDigest===digest&&s.t>=from&&s.t<=to);
  drafts.forEach((d,i)=>{
    if(d.digest===current)return;
    const lost=current!==null&&!d.intentional&&!delivered(current)&&!handedOver(current,currentSince,d.t)
      &&!drafts.slice(i+1).some(later=>later.digest===current);
    if(lost)violations.add('draft-lost');
    current=d.digest;currentSince=d.t;
  });
  // grant-bypass: input sent while revoked that nevertheless reached the CLI. Without a submission id the evidence
  // (an answer, an id-less written receipt) is only this submit's while no earlier request is still unanswered;
  // otherwise it may be the earlier, pre-revoke request's, so nothing is attributed.
  let revoked=false,lastSubmitAt=-1,lastAnswerAt=-1;
  events.forEach((e,i)=>{
    if(e.kind==='gate')revoked=e.grant==='revoked';
    else if(e.kind==='answer'&&e.nonce===log.nonce)lastAnswerAt=i;
    else if(e.kind==='submit'){
      if(revoked&&reached(e)){
        if(e.submissionId===null&&lastSubmitAt>lastAnswerAt)reasons.add('BYPASS_UNATTRIBUTABLE');
        else violations.add('grant-bypass');
      }
      lastSubmitAt=i;
    }
  });
  const connections=events.filter(e=>e.kind==='disconnect'||e.kind==='reconnect');
  if(connections.at(-1)?.kind==='disconnect')reasons.add('UNRECOVERED_DISCONNECT');

  let latencyMs:number|null=null;
  if(firstAnswer&&log.metric==='workflow')latencyMs=firstAnswer.t-t0;
  else if(firstAnswer&&RECOVERY_CAUSE[log.metric]){
    // Recovery is measured on a request that is sent after the human confirms the perturbation is over. With one nonce
    // per journey, an answer to a request already in flight (or already answered) before that end is first seen right
    // after it — a ≈0 ms number that says nothing about recovery — so it gives no latency at all.
    const ends=of(events,'perturb').filter(p=>p.phase==='end'&&p.cause===RECOVERY_CAUSE[log.metric]);
    const end=ends.filter(p=>p.t<=firstAnswer.t).at(-1)??ends.at(-1);
    if(!end)reasons.add('PERTURBATION_END_MISSING');
    else if(answers.some(a=>a.t<end.t))reasons.add('ANSWER_BEFORE_RECOVERY');
    else if(submits.some(s=>s.t<end.t))reasons.add('SUBMIT_BEFORE_RECOVERY');
    else latencyMs=firstAnswer.t-end.t;
  }
  const lastReceipt=receipts.at(-1);
  const outcome=firstAnswer?'ok':lastReceipt?.state==='rejected'?'error':'timeout';
  return {
    outcome,latencyMs,elapsedMs:events.at(-1)!.t-t0,startedAt:t0,
    effortCount:events.filter(e=>e.kind==='tap'||e.kind==='reentry').length,
    retryCount:Math.max(0,submits.length-1),
    violations:VIOLATION_ORDER.filter(v=>violations.has(v)),
    taskStateObserved:outcome==='ok'&&written.length>0,
    reasons:[...reasons],
  };
}
/** Method and clock definitions, sealed into a remote group's methodHash/clockHash before any trial. */
export const remoteJourneyMethodHash=()=>sha256Hex(canonicalJson({schema:'agentstoz-remote-journey-method-v1',
  effort:'tap + reentry events',retry:'submit events after the first',
  duplicate:'more than one written receipt (store or submission) or a nonce answer count above one',
  draftLost:'an undelivered draft digest replaced without intent and never observed again; an id-less (legacy) submit of that digest while it was on screen hands it over',
  grantBypass:'a submit sent while revoked that was written or answered; id-less evidence only when no earlier request is unanswered',
  taskState:'written receipt and nonce answer both observed'}));
const CLOCKS:Record<RemoteJourneyMetric,{start:string;end:string}>={
  'workflow':{start:'first journey event',end:'first nonce answer within the deadline'},
  'wifi-change':{start:'last human-confirmed Wi-Fi perturbation end',end:'first nonce answer within the deadline to a request submitted after that end'},
  'lock-return':{start:'last human-confirmed lock perturbation end',end:'first nonce answer within the deadline to a request submitted after that end'},
  'host-restart':{start:'last human-confirmed host-restart perturbation end',end:'first nonce answer within the deadline to a request submitted after that end'},
  'sustained-1h':{start:'none (duration, not latency)',end:'none'},
};
export const remoteJourneyClockHash=(metric:RemoteJourneyMetric)=>sha256Hex(canonicalJson({schema:'agentstoz-remote-journey-clock-v1',
  clock:'harness wall clock (event t)',metric,...CLOCKS[metric]}));

/** Shape a reduction into the assembler's remote CaptureRecord. Authentication stays an explicit attestation. */
export function remoteJourneyCaptureRecord(reduction:RemoteJourneyReduction, meta:{
  attemptId:string;pairId:string;side:'candidate'|'reference';cleanup:CaptureRecord['cleanup'];captureHash:string|null;
  physicalDevice:boolean;authenticated:boolean;
}):CaptureRecord {
  return {
    attemptId:meta.attemptId,pairId:meta.pairId,side:meta.side,startedAt:reduction.startedAt,elapsedMs:reduction.elapsedMs,
    outcome:reduction.outcome,timing:null,latencyMs:reduction.latencyMs,effortCount:reduction.effortCount,
    retryCount:reduction.retryCount,manualCommit:false,cleanup:meta.cleanup,violations:[...reduction.violations],
    inputRoute:{kind:'none'},device:{physical:meta.physicalDevice},
    operator:{authenticated:meta.authenticated,taskStateObserved:reduction.taskStateObserved},captureHash:meta.captureHash,
  };
}
