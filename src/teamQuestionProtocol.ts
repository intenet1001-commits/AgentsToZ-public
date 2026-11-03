/** Question data is untrusted display data. It is never a permission or OS approval. */
import {workroomScreenAwaitsAnswer} from './workroomRouteDelivery';

export const TEAM_QUESTION_PROTOCOL = 'agentstoz.team-question/v1' as const;
export const TEAM_QUESTION_LIMITS = {questions:3,options:12,textBytes:2_000,promptBytes:8_000,active:256,ageMs:30*60_000} as const;
export interface TeamQuestionBinding {
  teamId:string;memberId:string;executionId:string;
  /** Host hash of the exact session/target + host/runtime/process incarnation, never a display name. */
  generation:string;
}
export interface TeamQuestionItem {id:string;prompt:string;options:{id:string;label:string}[];allowText:boolean;multiple:boolean}
export interface TeamQuestionObservation {
  source:'provider'|'screen';sourceRevision:string;providerRequestId:string|null;
  intent:'task-question'|'human-handoff'|'unclassified';questions:TeamQuestionItem[];
}
export interface TeamQuestionNotice {binding:TeamQuestionBinding;sequence:number;available:boolean;observation:TeamQuestionObservation|null}
export interface TeamQuestionSnapshot {
  protocolVersion:typeof TEAM_QUESTION_PROTOCOL;binding:TeamQuestionBinding;questionId:string;revision:number;
  optionsHash:string;observedAt:number;expiresAt:number;observation:TeamQuestionObservation;
  submission:{supported:boolean;code:'READY'|'USER_ANSWER_SOURCE_UNAVAILABLE'|'QUESTION_SUBMISSION_UNSUPPORTED'|'QUESTION_JOURNAL_UNAVAILABLE'|'HUMAN_HANDOFF_REQUIRED'};
}
/** No text/origin/keys field: only a host-owned receipt of a real user's answer may name an answer. */
export interface TeamQuestionAnswerRequest {
  protocolVersion:typeof TEAM_QUESTION_PROTOCOL;requestId:string;binding:TeamQuestionBinding;
  questionId:string;expectedRevision:number;optionsHash:string;userAnswerRef:string;
}
export interface TeamQuestionAnswer {questionId:string;optionIds:string[];text:string|null}
export type TeamQuestionOutcome='reserved'|'submitted'|'confirmed'|'unknown'|'not-sent'|'unsupported'|'refused';
export interface TeamQuestionReceipt {
  protocolVersion:typeof TEAM_QUESTION_PROTOCOL;requestId:string;binding:TeamQuestionBinding;
  questionId:string;revision:number;optionsHash:string;answerDigest:string|null;outcome:TeamQuestionOutcome;code:string;
}
export class TeamQuestionError extends Error {constructor(readonly code:string){super(code);}}
export const questionFail=(code:string):never=>{throw new TeamQuestionError(code);};
const id=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
export const questionId=(v:unknown):v is string=>typeof v==='string'&&id.test(v);
export const questionHash=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{64}$/.test(v);
export function questionObject(value:unknown,keys:readonly string[]):Record<string,unknown>{
  if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))return questionFail('QUESTION_INVALID');
  const object=value as Record<string,unknown>;
  if(Object.keys(object).length!==keys.length||keys.some(k=>!Object.hasOwn(object,k)))return questionFail('QUESTION_INVALID');
  return object;
}
function text(v:unknown,max:number):v is string{return typeof v==='string'&&!!v.trim()&&new TextEncoder().encode(v).length<=max&&!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(v);}
export function normalizeTeamQuestionBinding(value:unknown):TeamQuestionBinding {
  const b=questionObject(value,['teamId','memberId','executionId','generation']);
  if(!questionId(b.teamId)||!questionId(b.memberId)||!questionId(b.executionId)||!questionHash(b.generation))return questionFail('QUESTION_INVALID');
  return {...b} as unknown as TeamQuestionBinding;
}
export const teamQuestionBindingBytes=(b:TeamQuestionBinding):string=>JSON.stringify([b.teamId,b.memberId,b.executionId,b.generation]);
export function normalizeTeamQuestionObservation(value:unknown):TeamQuestionObservation {
  const o=questionObject(value,['source','sourceRevision','providerRequestId','intent','questions']);
  if(!['provider','screen'].includes(String(o.source))||!questionId(o.sourceRevision)
    ||!(o.providerRequestId===null||questionId(o.providerRequestId))||o.source==='provider'&&o.providerRequestId===null
    ||!['task-question','human-handoff','unclassified'].includes(String(o.intent))
    ||!Array.isArray(o.questions)||!o.questions.length||o.questions.length>TEAM_QUESTION_LIMITS.questions)return questionFail('QUESTION_INVALID');
  const questions=o.questions.map(raw=>{
    const q=questionObject(raw,['id','prompt','options','allowText','multiple']);
    if(!questionId(q.id)||!text(q.prompt,TEAM_QUESTION_LIMITS.promptBytes)||typeof q.allowText!=='boolean'||typeof q.multiple!=='boolean'
      ||!Array.isArray(q.options)||q.options.length>TEAM_QUESTION_LIMITS.options)return questionFail('QUESTION_INVALID');
    const options=q.options.map(rawOption=>{const option=questionObject(rawOption,['id','label']);if(!questionId(option.id)||!text(option.label,500))return questionFail('QUESTION_INVALID');return {...option} as {id:string;label:string};});
    if(new Set(options.map(x=>x.id)).size!==options.length)return questionFail('QUESTION_INVALID');
    return {...q,options} as unknown as TeamQuestionItem;
  });
  if(new Set(questions.map(q=>q.id)).size!==questions.length)return questionFail('QUESTION_INVALID');
  return {...o,questions} as unknown as TeamQuestionObservation;
}
export function teamQuestionObservationBytes(o:TeamQuestionObservation):string {
  return JSON.stringify([o.source,o.sourceRevision,o.providerRequestId,o.intent,o.questions.map(q=>[q.id,q.prompt,q.options.map(x=>[x.id,x.label]),q.allowText,q.multiple])]);
}
export function normalizeTeamQuestionAnswerRequest(value:unknown):TeamQuestionAnswerRequest {
  const r=questionObject(value,['protocolVersion','requestId','binding','questionId','expectedRevision','optionsHash','userAnswerRef']);
  if(r.protocolVersion!==TEAM_QUESTION_PROTOCOL||!questionId(r.requestId)||!questionId(r.questionId)||!Number.isSafeInteger(r.expectedRevision)||(r.expectedRevision as number)<1||!questionHash(r.optionsHash)||!questionId(r.userAnswerRef))return questionFail('QUESTION_INVALID');
  return {...r,binding:normalizeTeamQuestionBinding(r.binding)} as unknown as TeamQuestionAnswerRequest;
}
export function normalizeTeamQuestionAnswers(value:unknown,questions:readonly TeamQuestionItem[]):TeamQuestionAnswer[]{
  if(!Array.isArray(value)||value.length!==questions.length)return questionFail('QUESTION_ANSWER_INVALID');
  const answers=value.map(raw=>questionObject(raw,['questionId','optionIds','text']));
  if(new Set(answers.map(a=>a.questionId)).size!==answers.length)return questionFail('QUESTION_ANSWER_INVALID');
  return questions.map(q=>{
    const a=answers.find(a=>a.questionId===q.id);
    if(!a||!Array.isArray(a.optionIds)||new Set(a.optionIds).size!==a.optionIds.length||!a.optionIds.every(id=>q.options.some(o=>o.id===id))||!q.multiple&&a.optionIds.length>1)return questionFail('QUESTION_ANSWER_INVALID');
    if(a.text===null ? !a.optionIds.length : !q.allowText||a.optionIds.length>0||!text(a.text,TEAM_QUESTION_LIMITS.textBytes))return questionFail('QUESTION_ANSWER_INVALID');
    // Canonical option order, independent of the order a UI happened to click them.
    const selected=a.optionIds as unknown[];
    return {questionId:q.id,optionIds:q.options.filter(o=>selected.includes(o.id)).map(o=>o.id),text:a.text as string|null};
  });
}
/** Observation only. No parser inference is allowed to authorize typing or a system approval. */
export function teamQuestionFromScreen(rows:readonly string[]|null|undefined):TeamQuestionObservation|null {
  if(!rows)return null;
  const lines=rows.slice(-64).map(row=>String(row).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').replace(/[│┃║╭╮╰╯─━═┌┐└┘├┤┬┴┼▌▐]/g,' ').trim()).filter(Boolean);
  const idle=lines.findLastIndex(line=>/^[>›»❯](?:$|\s+(?:ask codex to do anything|type your message|send a message)\b)/i.test(line));
  const live=lines.slice(idle+1),body=live.join('\n');
  const numbered=live.map(line=>/^(?:[❯›▸▶➤>]\s*)?(\d{1,2})[.)]\s*(.+)/.exec(line)).filter((x):x is RegExpExecArray=>!!x);
  const strong=/\benter to (?:select|submit|confirm|continue|proceed)\b|^AskUserQuestion\b/im.test(body);
  const typed=live.some(line=>/^(?:[❯›>]\s*)?(?:\d{1,2}[.)]\s*)?(?:Type something|Type your answer|Other[.…]*)\b/i.test(line));
  if(!workroomScreenAwaitsAnswer(rows)&&!(strong&&(numbered.length>1||typed)))return null;
  let prompt='';for(const line of live){if(new TextEncoder().encode(prompt+'\n'+line).length>TEAM_QUESTION_LIMITS.promptBytes)break;prompt+=(prompt?'\n':'')+line;}
  if(!prompt)return null;
  const unique=new Map<string,string>();for(const row of numbered)if(!unique.has(row[1]!)&&new TextEncoder().encode(row[2]!).length<=500)unique.set(row[1]!,row[2]!);
  return {source:'screen',sourceRevision:'observed-screen',providerRequestId:null,intent:'unclassified',questions:[{id:'observed',prompt,options:[...unique].slice(0,TEAM_QUESTION_LIMITS.options).map(([id,label])=>({id:`option_${id}`,label})),allowText:typed,multiple:false}]};
}
