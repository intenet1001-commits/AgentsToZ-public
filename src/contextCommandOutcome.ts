import type {ContextCommand} from './contextSessionCommand';
import type {ContextSession} from './contextSessionMemoryPath';
import {measuredContextPercent} from './contextUsageReading';

/**
 * What became of a /compact or /clear the dock sent (VOC 2026-11-01: 「처리결과도 여기서 알아야 하는 거 아님? 처리되었으면
 * 컨텍스트가 줄어들 거니까」). The send receipt only proves the command was typed into the terminal. This watches the
 * rows the dock already reads every 5 s (`/api/context-usage`) for evidence that Claude processed it. It never sends
 * anything: an outcome it cannot confirm is reported as such, never resent.
 *
 * Evidence, newer than the button press:
 *  /compact — the transcript's compaction row (`lastCompaction`, tokens before → after; src/contextCommandEvidence.ts);
 *             else the session's context reading dropping; else its reading turning into 「not measured」, which is what
 *             Claude reports right after a compaction until its next reply (「요약된 것으로 보입니다」).
 *  /clear   — a new conversation captured in the same Workroom or Orca pane (`nextConversation`, or a listed row of the
 *             same Workroom).
 * No evidence by the deadline gives 「결과 확인 안 됨」 with the reason: compactions measured 61–135 s, so 5 min; a clear
 * is immediate, so 2 min. Stronger evidence arriving later (while the result is still shown) replaces a weaker answer.
 */
export type ContextCommandSurface='orca'|'workroom';
export type ContextCommandUnconfirmedReason='timeout'|'not-refreshed'|'no-reading'|'closed'|'missing';
export type ContextCommandOutcome=
  |{kind:'compacted';at:number;source:'record'|'reading'|'reset';fromPercent:number|null;toPercent:number|null;fromTokens?:number|null;toTokens?:number|null}
  |{kind:'cleared';at:number;fromPercent:number|null;toPercent:number|null;nextSessionId:string}
  |{kind:'unconfirmed';at:number;reason:ContextCommandUnconfirmedReason};
export interface ContextCommandTrack {
  id:string;
  sessionId:string;
  command:ContextCommand;
  surface:ContextCommandSurface;
  /** The button press, before the save·sync: evidence must be newer. */
  startedAt:number;
  /** The host confirmed the write: the wait is counted from here. */
  sentAt:number;
  /** The reading the person saw when pressing; null when it was not measured. */
  beforePercent:number|null;
  windowSize:number|null;
  workroomSessionId:string|null;
  outcome?:ContextCommandOutcome;
}
export type ContextCommandRow=Pick<ContextSession,'sessionId'|'usedPercent'|'usedTokens'|'windowSize'>
  &Partial<Pick<ContextSession,'capturedAt'|'surfacePresence'|'workroomSessionId'|'lastCompaction'|'nextConversation'>>;

export const CONTEXT_COMPACT_WAIT_MS=5*60_000;
export const CONTEXT_CLEAR_WAIT_MS=2*60_000;
/** A result stays on its row this long, then the row is an ordinary row again. */
export const CONTEXT_OUTCOME_VISIBLE_MS=10*60_000;
const TRACK_MAX_AGE_MS=6*60*60_000;
/** Claude reports whole percents: a smaller step is rounding, not a compaction. */
const DROP_POINTS=1;

const newer=(iso:string|null|undefined,ms:number)=>typeof iso==='string'&&Date.parse(iso)>ms;
const share=(tokens:number|null|undefined,windowSize:number|null|undefined)=>typeof tokens==='number'&&typeof windowSize==='number'&&windowSize>0?Math.min(100,tokens/windowSize*100):null;
const settled=(outcome?:ContextCommandOutcome)=>!!outcome&&(outcome.kind==='cleared'||outcome.kind==='compacted'&&outcome.source!=='reset');

function compactEvidence(track:ContextCommandTrack,row:ContextCommandRow|null,now:number):ContextCommandOutcome|null{
  const record=row?.lastCompaction;
  if(row&&record&&newer(record.at,track.startedAt)){
    const windowSize=row.windowSize??track.windowSize;
    return {kind:'compacted',at:now,source:'record',fromPercent:share(record.preTokens,windowSize)??track.beforePercent,
      toPercent:share(record.postTokens,windowSize),fromTokens:record.preTokens,toTokens:record.postTokens};
  }
  if(!row||!newer(row.capturedAt,track.startedAt)||track.beforePercent===null)return null;
  const reading=measuredContextPercent(row);
  if(reading!==null&&reading<=track.beforePercent-DROP_POINTS)return {kind:'compacted',at:now,source:'reading',fromPercent:track.beforePercent,toPercent:reading};
  // A reading of zero (not null): Claude reset its count, as it does right after a compaction.
  if(reading===null&&typeof row.usedPercent==='number')return {kind:'compacted',at:now,source:'reset',fromPercent:track.beforePercent,toPercent:null};
  return null;
}

function clearEvidence(track:ContextCommandTrack,row:ContextCommandRow|null,rows:readonly ContextCommandRow[],now:number):ContextCommandOutcome|null{
  const next=row?.nextConversation;
  const successor=next&&next.sessionId!==track.sessionId&&newer(next.capturedAt,track.startedAt)?next
    :track.workroomSessionId?rows.find(r=>r.sessionId!==track.sessionId&&r.workroomSessionId===track.workroomSessionId&&newer(r.capturedAt,track.startedAt))??null:null;
  return successor?{kind:'cleared',at:now,fromPercent:track.beforePercent,toPercent:measuredContextPercent(successor),nextSessionId:successor.sessionId}:null;
}

function unconfirmedReason(track:ContextCommandTrack,row:ContextCommandRow|null,now:number):ContextCommandUnconfirmedReason|null{
  // A closed compact target can show nothing more. A cleared conversation leaves its terminal by design, so a clear waits.
  if(track.command==='compact'&&row?.surfacePresence==='gone')return 'closed';
  if(now-track.sentAt<(track.command==='compact'?CONTEXT_COMPACT_WAIT_MS:CONTEXT_CLEAR_WAIT_MS))return null;
  if(!row)return 'missing';
  if(track.command==='clear')return row.surfacePresence==='gone'?'closed':'timeout';
  if(track.beforePercent===null&&measuredContextPercent(row)===null)return 'no-reading';
  return newer(row.capturedAt,track.startedAt)?'timeout':'not-refreshed';
}

/** One step on a fresh read of the session rows. Pure: the panel calls it on each successful 5 s poll. */
export function advanceContextCommandTrack(track:ContextCommandTrack,rows:readonly ContextCommandRow[],now:number):ContextCommandTrack{
  if(settled(track.outcome))return track;
  const row=rows.find(r=>r.sessionId===track.sessionId)??null;
  const found=track.command==='compact'?compactEvidence(track,row,now):clearEvidence(track,row,rows,now);
  // Settled evidence replaces anything; 「looks compacted」 replaces 「unconfirmed」 but not itself.
  if(found&&(settled(found)||!track.outcome||track.outcome.kind==='unconfirmed'))return {...track,outcome:found};
  if(track.outcome)return track;
  const reason=unconfirmedReason(track,row,now);
  return reason?{...track,outcome:{kind:'unconfirmed',at:now,reason}}:track;
}

export function startContextCommandTrack(input:{session:Pick<ContextSession,'sessionId'|'usedPercent'|'usedTokens'|'windowSize'>&{workroomSessionId?:string|null}|null;sessionId:string;command:ContextCommand;surface:ContextCommandSurface;startedAt:number;sentAt:number;workroomSessionId?:string|null;id?:string}):ContextCommandTrack{
  return {id:input.id??crypto.randomUUID(),sessionId:input.sessionId,command:input.command,surface:input.surface,startedAt:input.startedAt,sentAt:input.sentAt,
    beforePercent:input.session?measuredContextPercent(input.session):null,windowSize:input.session?.windowSize??null,
    workroomSessionId:input.workroomSessionId??input.session?.workroomSessionId??null};
}

/** A confirmed /clear is shown on the new conversation's row once that row is listed; everything else on its own row. */
export const contextCommandTrackHome=(track:ContextCommandTrack,listed:ReadonlySet<string>)=>
  track.outcome?.kind==='cleared'&&listed.has(track.outcome.nextSessionId)?track.outcome.nextSessionId:track.sessionId;

// ── Copy ──
const round=(n:number)=>n>=10||Number.isInteger(n)?Math.round(n):Math.round(n*10)/10;
const percent=(n:number)=>`${round(n)}%`;
const tokenCount=(n:number)=>n>=1e6?`${Math.round(n/1e5)/10}M`:n>=1e3?`${Math.round(n/100)/10}K`:String(Math.round(n));
const elapsed=(ms:number)=>{const s=Math.max(0,Math.floor(ms/1000)),m=Math.floor(s/60);return m?`${m}분${s%60?` ${s%60}초`:''}`:`${s}초`;};
const change=(from:number|null,to:number|null,later:string)=>from!==null&&to!==null?`컨텍스트 ${percent(from)} → ${percent(to)}`
  :from!==null?`컨텍스트 ${percent(from)} → ${later}`:to!==null?`컨텍스트 ${percent(to)}`:`컨텍스트는 ${later}`;
const minutes=(ms:number)=>`${ms/60_000}분`;
const REASON:Record<ContextCommand,Record<ContextCommandUnconfirmedReason,string>>={
  compact:{
    timeout:`${minutes(CONTEXT_COMPACT_WAIT_MS)} 안에 요약 기록도, 컨텍스트 감소도 보이지 않았습니다`,
    'not-refreshed':`${minutes(CONTEXT_COMPACT_WAIT_MS)} 동안 요약 기록이 없고 컨텍스트 측정값도 갱신되지 않았습니다`,
    'no-reading':'컨텍스트 측정값이 없고 요약 기록도 찾지 못했습니다',
    closed:'결과가 보이기 전에 세션 창이 닫혔습니다',
    missing:'결과가 보이기 전에 이 대화가 목록에서 사라졌습니다',
  },
  clear:{
    timeout:`${minutes(CONTEXT_CLEAR_WAIT_MS)} 안에 같은 창의 새 대화가 보이지 않았습니다`,
    'not-refreshed':`${minutes(CONTEXT_CLEAR_WAIT_MS)} 안에 같은 창의 새 대화가 보이지 않았습니다`,
    'no-reading':`${minutes(CONTEXT_CLEAR_WAIT_MS)} 안에 같은 창의 새 대화가 보이지 않았습니다`,
    closed:'이 대화는 창에서 빠졌지만 새 대화가 아직 보이지 않습니다(새 대화는 첫 응답 뒤에 나타날 수 있습니다)',
    missing:'이 대화는 목록에서 사라졌지만 새 대화가 아직 보이지 않습니다(새 대화는 첫 응답 뒤에 나타날 수 있습니다)',
  },
};

export interface ContextCommandOutcomeView {tone:'waiting'|'done'|'unconfirmed';text:string}
/** The row's line. `rows` lets a confirmed /clear show the new conversation's reading once it has one. */
export function contextCommandOutcomeView(track:ContextCommandTrack,now:number,rows:readonly ContextCommandRow[]=[]):ContextCommandOutcomeView{
  const outcome=track.outcome;
  if(!outcome)return {tone:'waiting',text:track.command==='compact'
    ?`요약 처리 중 — 컨텍스트 변화를 기다리는 중 · ${elapsed(now-track.sentAt)}`
    :`새 대화로 비우는 중 — 같은 창의 새 대화를 기다리는 중 · ${elapsed(now-track.sentAt)}`};
  if(outcome.kind==='compacted'){
    if(outcome.source==='reset')return {tone:'done',text:`요약된 것으로 보입니다 · ${change(outcome.fromPercent,null,'다음 응답 뒤 표시')} (Claude가 사용량 표시를 초기화했습니다)`};
    const tokens=typeof outcome.fromTokens==='number'&&typeof outcome.toTokens==='number'?` (${tokenCount(outcome.fromTokens)} → ${tokenCount(outcome.toTokens)} 토큰)`:'';
    return {tone:'done',text:`요약 완료 · ${change(outcome.fromPercent,outcome.toPercent,'다음 응답 뒤 표시')}${tokens}`};
  }
  if(outcome.kind==='cleared'){
    const next=rows.find(r=>r.sessionId===outcome.nextSessionId),latest=next?measuredContextPercent(next):null;
    return {tone:'done',text:`새 대화로 비움 · ${change(outcome.fromPercent,latest??outcome.toPercent,'첫 응답 뒤 표시')}`};
  }
  return {tone:'unconfirmed',text:`결과 확인 안 됨 · ${REASON[track.command][outcome.reason]}. ${track.surface==='orca'?'Orca':'워크룸'} 화면에서 확인하세요. 명령은 다시 보내지 않았습니다.`};
}

// ── Store: localStorage, shared by the dock windows (storage event), at most 16 ──
export const CONTEXT_COMMAND_TRACKS_KEY='agentstoz:context-command:outcome:v1';
const LIMIT=16,ID=/^[A-Za-z0-9_-]{8,160}$/;
const finite=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v);
const maybe=(v:unknown)=>v===null||finite(v);
function validOutcome(o:unknown):o is ContextCommandOutcome{
  if(!o||typeof o!=='object')return false;
  const r=o as Record<string,unknown>;
  if(!finite(r.at))return false;
  if(r.kind==='compacted')return ['record','reading','reset'].includes(r.source as string)&&maybe(r.fromPercent)&&maybe(r.toPercent)
    &&(r.fromTokens===undefined||maybe(r.fromTokens))&&(r.toTokens===undefined||maybe(r.toTokens));
  if(r.kind==='cleared')return maybe(r.fromPercent)&&maybe(r.toPercent)&&typeof r.nextSessionId==='string'&&ID.test(r.nextSessionId);
  return r.kind==='unconfirmed'&&['timeout','not-refreshed','no-reading','closed','missing'].includes(r.reason as string);
}
export function parseContextCommandTracks(raw:string|null):ContextCommandTrack[]{
  let value:unknown;
  try{value=JSON.parse(raw??'[]');}catch{return [];}
  if(!Array.isArray(value))return [];
  return value.filter((t):t is ContextCommandTrack=>!!t&&typeof t==='object'
    &&typeof t.id==='string'&&ID.test(t.id)&&typeof t.sessionId==='string'&&ID.test(t.sessionId)
    &&(t.command==='compact'||t.command==='clear')&&(t.surface==='orca'||t.surface==='workroom')
    &&finite(t.startedAt)&&finite(t.sentAt)&&maybe(t.beforePercent)&&maybe(t.windowSize)
    &&(t.workroomSessionId===null||typeof t.workroomSessionId==='string'&&ID.test(t.workroomSessionId))
    &&(t.outcome===undefined||validOutcome(t.outcome))).slice(-LIMIT);
}
export function readContextCommandTracks():ContextCommandTrack[]{
  try{return parseContextCommandTracks(localStorage.getItem(CONTEXT_COMMAND_TRACKS_KEY));}catch{return [];}
}
/** Losing this display state never affects a command; a failed write only means the result is not shown. */
export function writeContextCommandTracks(tracks:readonly ContextCommandTrack[]){
  try{localStorage.setItem(CONTEXT_COMMAND_TRACKS_KEY,JSON.stringify(tracks.slice(-LIMIT)));}catch{/* display only */}
}
/** A shown result leaves after CONTEXT_OUTCOME_VISIBLE_MS; anything sent more than 6 hours ago is dropped unshown. */
export const pruneContextCommandTracks=(tracks:readonly ContextCommandTrack[],now:number)=>tracks.filter(t=>
  now-t.sentAt<TRACK_MAX_AGE_MS&&(!t.outcome||now-t.outcome.at<CONTEXT_OUTCOME_VISIBLE_MS));
