export const WORKROOM_SCHEDULE_PATH = '/api/agent-runtime/workroom-schedules';
export const WORKROOM_SCHEDULE_LIMITS = {schedules:32, runs:2048, promptBytes:4000, runsPerDay:8, lifetimeMs:30*86400_000} as const;
export type WorkroomScheduleMode = 'continue' | 'new-conversation';
export type WorkroomScheduleState = 'active' | 'paused' | 'stopped' | 'expired' | 'finished' | 'needs-human';
export type WorkroomScheduleRunState = 'dispatching' | 'submitted' | 'completed' | 'unknown' | 'failed' | 'reviewed';
/** Host-created identity. No local paths, credentials, terminal contents or inferred account defaults. */
export interface WorkroomScheduleBinding {
  sessionId:string; targetId:string; agent:string; model:string; accountId:string; identity:string; bypass:boolean;
}
export interface WorkroomSchedule {
  id:string; title:string; prompt:string; mode:WorkroomScheduleMode; binding:WorkroomScheduleBinding; intentHash:string;
  /** Last verified resumed terminal; the original binding remains the durable conversation lease. */
  currentSessionId?:string;
  /** Separate consent granted when the original binding has a verifiable recovery proof. */
  autoRestore?:true;
  state:WorkroomScheduleState; revision:number; consentRevision:number; createdAt:number; expiresAt:number;
  nextAt:number; intervalMs:number; maxRuns:number; runCount:number; retryAt:number; reason:string;
}
export interface WorkroomScheduleRun {
  id:string; scheduleId:string; leaseKey:string; consentRevision:number; state:WorkroomScheduleRunState;
  startedAt:number; updatedAt:number; sessionId:string; inputRevision?:number; reason:string;
}
export type WorkroomScheduleRequest =
  | {operation:'list'; sessionId:string}
  | {operation:'create'; id:string; sessionId:string; title:string; prompt:string; mode:WorkroomScheduleMode; nextAt:number; intervalMs:number; expiresAt:number; maxRuns:number; consent:true; autoRestore?:true}
  | {operation:'pause'|'resume'|'stop'; id:string; expectedRevision:number; consent?:true}
  | {operation:'run-now'; id:string; expectedRevision:number; requestId:string}
  | {operation:'review'; runId:string; confirmed:true};
const plain=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
export const scheduleId=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9_-]{8,128}$/.test(v);
export function parseWorkroomScheduleRequest(value:unknown,now=Date.now()):WorkroomScheduleRequest {
  if(!plain(value)||typeof value.operation!=='string')throw Error('예약 요청을 확인하세요.');
  const exact=(keys:string[])=>{if(Object.keys(value).some(k=>!keys.includes(k)))throw Error('지원하지 않는 예약 항목입니다.');};
  if(value.operation==='list'){
    exact(['operation','sessionId']);if(!scheduleId(value.sessionId))throw Error('워크룸을 선택하세요.');
  }else if(value.operation==='create'){
    exact(['operation','id','sessionId','title','prompt','mode','nextAt','intervalMs','expiresAt','maxRuns','consent','autoRestore']);
    if(!scheduleId(value.id)||!scheduleId(value.sessionId)||value.consent!==true)throw Error('이 워크룸 예약 실행에 동의해야 합니다.');
    if(typeof value.title!=='string'||!value.title.trim()||value.title.length>100||/[\x00-\x1f]/.test(value.title))throw Error('예약 이름은 100자 이내로 입력하세요.');
    if(typeof value.prompt!=='string'||!value.prompt.trim()||new TextEncoder().encode(value.prompt).length>WORKROOM_SCHEDULE_LIMITS.promptBytes
      ||/[\x00-\x08\x0b-\x1f\x7f]/.test(value.prompt)||/^[\s]*[/$!]/u.test(value.prompt))throw Error('예약할 작업 내용을 입력하세요. CLI 명령은 예약할 수 없습니다.');
    if(value.mode!=='continue'&&value.mode!=='new-conversation')throw Error('같은 대화 또는 새 대화를 선택하세요.');
    if(value.autoRestore!==undefined&&(value.autoRestore!==true||value.mode!=='continue'))throw Error('종료된 같은 대화의 자동 복원 동의를 확인하세요.');
    if(!Number.isSafeInteger(value.nextAt)||Number(value.nextAt)<now-60_000||Number(value.nextAt)>now+WORKROOM_SCHEDULE_LIMITS.lifetimeMs
      ||!Number.isSafeInteger(value.expiresAt)||Number(value.expiresAt)<=Math.max(now,Number(value.nextAt))||Number(value.expiresAt)>now+WORKROOM_SCHEDULE_LIMITS.lifetimeMs)throw Error('다음 실행과 종료 시각을 30일 이내로 설정하세요.');
    if(!Number.isSafeInteger(value.intervalMs)||value.intervalMs!==0&&(Number(value.intervalMs)<300_000||Number(value.intervalMs)>7*86400_000))throw Error('반복 간격은 5분 이상 7일 이하입니다.');
    if(!Number.isSafeInteger(value.maxRuns)||Number(value.maxRuns)<1||Number(value.maxRuns)>100||value.intervalMs===0&&value.maxRuns!==1)throw Error('실행 횟수는 1~100회로 설정하세요.');
  }else if(['pause','resume','stop','run-now'].includes(value.operation)){
    exact(value.operation==='run-now'?['operation','id','expectedRevision','requestId']:['operation','id','expectedRevision','consent']);
    if(!scheduleId(value.id)||!Number.isSafeInteger(value.expectedRevision)||Number(value.expectedRevision)<1)throw Error('예약 상태를 다시 확인하세요.');
    if(value.operation==='resume'&&value.consent!==true)throw Error('예약을 다시 켜려면 동의가 필요합니다.');
    if(value.operation==='run-now'&&!scheduleId(value.requestId))throw Error('실행 요청 번호를 확인하세요.');
    if(value.consent!==undefined&&value.consent!==true)throw Error('예약 동의를 확인하세요.');
  }else if(value.operation==='review'){
    exact(['operation','runId','confirmed']);if(!scheduleId(value.runId)||value.confirmed!==true)throw Error('실제 작업 결과를 먼저 확인하세요.');
  }else throw Error('지원하지 않는 예약 동작입니다.');
  return value as unknown as WorkroomScheduleRequest;
}
