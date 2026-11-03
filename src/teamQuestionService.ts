import {createHash,randomUUID} from 'node:crypto';
import {TEAM_QUESTION_PROTOCOL,TEAM_QUESTION_LIMITS,normalizeTeamQuestionBinding,normalizeTeamQuestionObservation,normalizeTeamQuestionAnswerRequest,normalizeTeamQuestionAnswers,teamQuestionBindingBytes,teamQuestionObservationBytes,questionFail,type TeamQuestionBinding,type TeamQuestionObservation,type TeamQuestionSnapshot,type TeamQuestionAnswer,type TeamQuestionReceipt} from './teamQuestionProtocol';
import type {TeamQuestionJournal} from './teamQuestionJournal';

const hash=(v:string)=>createHash('sha256').update(v).digest('hex');
const same=(a:TeamQuestionBinding,b:TeamQuestionBinding)=>teamQuestionBindingBytes(a)===teamQuestionBindingBytes(b);
/** Host-owned record from an actual UI/client response callback. Never construct this from an MCP origin/text field. */
export interface TeamQuestionUserAnswer {
  binding:TeamQuestionBinding;questionId:string;revision:number;optionsHash:string;recordedAt:number;expiresAt:number;answers:TeamQuestionAnswer[];
}
export interface TeamQuestionReadback {
  binding:TeamQuestionBinding;questionId:string;revision:number;optionsHash:string;answerDigest:string;
  /** Provider's semantic answer receipt, not accepted bytes or disappearance of a screen. */
  providerReceiptId:string;
}
export interface TeamQuestionServiceDeps {
  journal?:TeamQuestionJournal;current(binding:TeamQuestionBinding):boolean;now?:()=>number;createId?:()=>string;
  /** Absence is a real unsupported state. An AI-supplied assertion that it is the user is never a fallback. */
  userAnswers?:{resolve(ref:string):Promise<TeamQuestionUserAnswer|null>;current(ref:string):boolean};
  adapter?:{
    observe(binding:TeamQuestionBinding):Promise<TeamQuestionObservation|null>;
    submit(binding:TeamQuestionBinding,question:TeamQuestionSnapshot,answers:readonly TeamQuestionAnswer[],requestId:string,active:()=>boolean):Promise<'submitted'|'not-sent'|'unknown'>;
    readback(binding:TeamQuestionBinding,question:TeamQuestionSnapshot,requestId:string):Promise<TeamQuestionReadback|null>;
  };
}
export function teamQuestionGeneration(parts:readonly unknown[]):string{return hash(JSON.stringify(parts));}
export class TeamQuestionService {
  readonly #pending=new Map<string,TeamQuestionSnapshot>();
  readonly #listeners=new Set<()=>void>();
  readonly #now:()=>number;readonly #id:()=>string;
  constructor(readonly deps:TeamQuestionServiceDeps){this.#now=deps.now??Date.now;this.#id=deps.createId??randomUUID;}
  get submissionAvailable():boolean{return !!this.deps.journal&&!!this.deps.userAnswers&&!!this.deps.adapter;}
  subscribe(listener:()=>void):()=>void{this.#listeners.add(listener);return()=>this.#listeners.delete(listener);}
  #change():void{for(const listener of this.#listeners)try{listener();}catch{/* Observers cannot alter an answer receipt. */}}
  #key(binding:TeamQuestionBinding):string{return hash(teamQuestionBindingBytes(binding));}
  #live(binding:TeamQuestionBinding):TeamQuestionSnapshot|null{
    const key=this.#key(binding),q=this.#pending.get(key);
    if(!q)return null;
    if(!this.deps.current(binding)||q.expiresAt<=this.#now()){this.#pending.delete(key);this.#change();return null;}
    return q;
  }
  observe(rawBinding:TeamQuestionBinding,raw:TeamQuestionObservation|null):TeamQuestionSnapshot|null{
    const binding=normalizeTeamQuestionBinding(rawBinding),key=this.#key(binding);
    for(const pending of this.#pending.values())this.#live(pending.binding);
    if(!this.deps.current(binding))return questionFail('QUESTION_BINDING_STALE');
    const old=this.#live(binding);
    if(raw===null){if(this.#pending.delete(key))this.#change();return null;}
    const observation=normalizeTeamQuestionObservation(raw),optionsHash=hash(teamQuestionObservationBytes(observation));
    if(old&&old.optionsHash===optionsHash)return structuredClone(old);
    if(!old&&this.#pending.size>=TEAM_QUESTION_LIMITS.active)return questionFail('QUESTION_CAPACITY');
    const supported=!!this.deps.journal&&observation.source==='provider'&&observation.intent==='task-question'&&!!this.deps.userAnswers&&!!this.deps.adapter;
    const code=observation.intent!=='task-question'?'HUMAN_HANDOFF_REQUIRED':!this.deps.userAnswers?'USER_ANSWER_SOURCE_UNAVAILABLE':observation.source!=='provider'||!this.deps.adapter?'QUESTION_SUBMISSION_UNSUPPORTED':!this.deps.journal?'QUESTION_JOURNAL_UNAVAILABLE':'READY';
    const q:TeamQuestionSnapshot={protocolVersion:TEAM_QUESTION_PROTOCOL,binding,questionId:this.#id(),revision:(old?.revision??0)+1,optionsHash,observedAt:this.#now(),expiresAt:this.#now()+TEAM_QUESTION_LIMITS.ageMs,observation,submission:{supported,code}};
    this.#pending.set(key,q);this.#change();return structuredClone(q);
  }
  invalidate(binding:TeamQuestionBinding):void{if(this.#pending.delete(this.#key(normalizeTeamQuestionBinding(binding))))this.#change();}
  pending(binding:TeamQuestionBinding):TeamQuestionSnapshot|null{const q=this.#live(normalizeTeamQuestionBinding(binding));return q?structuredClone(q):null;}
  list(teamId:string):{questions:TeamQuestionSnapshot[];cursor:string}{
    const questions=[...this.#pending.values()].filter(q=>q.binding.teamId===teamId).map(q=>this.#live(q.binding)).filter((q):q is TeamQuestionSnapshot=>!!q).map(q=>structuredClone(q));
    questions.sort((a,b)=>a.binding.memberId.localeCompare(b.binding.memberId)||a.questionId.localeCompare(b.questionId));
    return {questions,cursor:hash(JSON.stringify(questions.map(q=>[q.binding,q.questionId,q.revision,q.optionsHash,q.expiresAt])))};
  }
  receipt(requestId:string,binding:TeamQuestionBinding):TeamQuestionReceipt|null{
    normalizeTeamQuestionBinding(binding);const r=this.deps.journal?.get(requestId)??null;if(r&&!same(r.binding,binding))return questionFail('QUESTION_RECEIPT_OWNER_MISMATCH');return r;
  }
  async answer(raw:unknown):Promise<TeamQuestionReceipt>{
    const r=normalizeTeamQuestionAnswerRequest(raw),old=this.receipt(r.requestId,r.binding);
    const fingerprint=hash(JSON.stringify([r.protocolVersion,r.requestId,r.binding.teamId,r.binding.memberId,r.binding.executionId,r.binding.generation,r.questionId,r.expectedRevision,r.optionsHash,r.userAnswerRef]));
    if(old){if(old.questionId!==r.questionId||old.revision!==r.expectedRevision||old.optionsHash!==r.optionsHash)return questionFail('QUESTION_REQUEST_CONFLICT');
      // reserve compares the entire original input fingerprint even after a crash; it never runs the effect again.
      return this.deps.journal!.reserve({receipt:{...old,outcome:'reserved',code:'RESERVED'},fingerprint,answerRefDigest:hash(r.userAnswerRef),bindingDigest:this.#key(r.binding),at:this.#now()}).receipt;
    }
    const q=this.#live(r.binding);if(!q||q.questionId!==r.questionId||q.revision!==r.expectedRevision||q.optionsHash!==r.optionsHash)return questionFail('QUESTION_STALE');
    let answers:TeamQuestionAnswer[]|null=null;let answerExpiresAt=0;
    if(q.submission.supported){
      const a=await this.deps.userAnswers!.resolve(r.userAnswerRef);
      if(this.#live(r.binding)!==q)return questionFail('QUESTION_STALE');
      if(!a||!same(normalizeTeamQuestionBinding(a.binding),r.binding)||a.questionId!==q.questionId||a.revision!==q.revision||a.optionsHash!==q.optionsHash||!Number.isSafeInteger(a.recordedAt)||a.recordedAt<q.observedAt||a.recordedAt>this.#now()+5000||!Number.isSafeInteger(a.expiresAt)||a.expiresAt<=this.#now()||a.expiresAt<=a.recordedAt||a.expiresAt>q.expiresAt)return questionFail('USER_ANSWER_UNVERIFIED');
      answerExpiresAt=a.expiresAt;answers=normalizeTeamQuestionAnswers(a.answers,q.observation.questions);
    }
    const receipt:TeamQuestionReceipt={protocolVersion:TEAM_QUESTION_PROTOCOL,requestId:r.requestId,binding:r.binding,questionId:q.questionId,revision:q.revision,optionsHash:q.optionsHash,answerDigest:answers?hash(JSON.stringify(answers)):null,outcome:'reserved',code:'RESERVED'};
    if(!this.deps.journal)return {...receipt,outcome:'unsupported',code:q.submission.code==='READY'?'QUESTION_JOURNAL_UNAVAILABLE':q.submission.code};
    const reserved=this.deps.journal.reserve({receipt,fingerprint,answerRefDigest:hash(r.userAnswerRef),bindingDigest:this.#key(r.binding),at:this.#now()});
    if(!reserved.created)return reserved.receipt;
    const settle=(outcome:TeamQuestionReceipt['outcome'],code:string)=>{const next={...receipt,outcome,code};this.deps.journal!.settle(r.requestId,next);return next;};
    if(!q.submission.supported||!answers)return settle('unsupported',q.submission.code);
    // Both asynchronous checks precede the write; a replacement question, session or expired user answer cannot inherit it.
    let current:TeamQuestionObservation|null;
    try{current=await this.deps.adapter!.observe(r.binding);}catch{return settle('not-sent','QUESTION_OBSERVATION_UNAVAILABLE');}
    if(this.#live(r.binding)!==q||this.#now()>=answerExpiresAt||!this.deps.userAnswers!.current(r.userAnswerRef)||!current||hash(teamQuestionObservationBytes(normalizeTeamQuestionObservation(current)))!==q.optionsHash)return settle('not-sent','QUESTION_STALE');
    try{
      const outcome=await this.deps.adapter!.submit(r.binding,structuredClone(q),answers,r.requestId,()=>this.#live(r.binding)===q&&this.#now()<answerExpiresAt&&this.deps.userAnswers!.current(r.userAnswerRef));
      if(outcome!=='submitted')return settle(outcome==='not-sent'?'not-sent':'unknown',outcome==='not-sent'?'QUESTION_NOT_SENT':'QUESTION_SUBMISSION_UNKNOWN');
      settle('submitted','READBACK_REQUIRED');
      const proof=await this.deps.adapter!.readback(r.binding,structuredClone(q),r.requestId);
      if(!proof||!same(proof.binding,r.binding)||proof.questionId!==q.questionId||proof.revision!==q.revision||proof.optionsHash!==q.optionsHash||proof.answerDigest!==receipt.answerDigest||!proof.providerReceiptId)return settle('unknown','QUESTION_READBACK_UNKNOWN');
      const confirmed=settle('confirmed','ANSWER_CONFIRMED');if(this.#pending.get(this.#key(r.binding))===q){this.#pending.delete(this.#key(r.binding));this.#change();}return confirmed;
    }catch{return settle('unknown','QUESTION_SUBMISSION_UNKNOWN');}
  }
}
