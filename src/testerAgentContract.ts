export const TESTER_ENDPOINT = '/api/agent-runtime/tester';
/**
 * `proposals`·`accept` 는 **자동 발견된 제안**을 다루는 두 동작이다(2026-10-06). 이것이 없던 동안
 * `scenarios discover` 가 만든 제안을 읽거나 받아들일 길이 **와이어에 아예 없었고**, 그래서 프로젝트별
 * 계층이 자동으로 자란다는 설계가 제안 단계에서 끊겨 있었다(실측: 12개 프로젝트에 제안이 쌓였는데
 * 시나리오가 된 프로젝트는 이 저장소 하나뿐).
 */
export const TESTER_OPERATIONS = ['status','ensure','plan','apply','start','read','cancel','handoff','proposals','accept'] as const;
export type TesterOperation = typeof TESTER_OPERATIONS[number];
export interface TesterTarget { portId: string; workspaceTargetId?: string }
/**
 * 페르소나 검사(러너 1.5.0 `personas run`)를 시작할 때 쓰는 예약 프로필 id. 프로젝트 manifest 에 같은 이름의
 * 진짜 프로필이 있으면 그 프로필이 이긴다(호스트가 start·launch 양쪽에서 같은 규칙으로 판정한다).
 */
export const TESTER_PERSONA_PROFILE = 'personas';
/** 탐색 결과의 분류. 페르소나 PASS/FAIL·검사 기록·통계에 절대 들어가지 않는다. */
export const TESTER_EXPLORATION_CLASS = 'exploratory/observed';
export interface TesterRequest extends TesterTarget {
  operation: TesterOperation;
  revision?: string; requestId?: string; profileId?: string; runId?: string;
  /** `explore` 는 페르소나 탐색 **초안**(브리프)이다 — 실행·전송·판정이 아니다. `personaId` 가 필요하다. */
  mode?: 'configure' | 'repair' | 'explore';
  personaId?: string;
  /** `accept` 가 받아들일 제안 id. `project.` 접두는 붙이지 않는다(러너가 붙인다). */
  scenarioId?: string;
}
export interface TesterCheck { id:string; state:string; durationSeconds?:number; reason?:string; output?:string; evidence?:string }
export interface TesterReport { runId:string; state:string; profile:string; startedAt:string; finishedAt?:string; sourceUnchanged?:boolean; checks:TesterCheck[]; source?:{commit?:string; fingerprint?:string}; limits?:string[] }
export interface TesterRun { id:string; state:string; profileId:string; createdAt:string; finishedAt?:string; message?:string; report?:TesterReport; origin:'app'|'local-cli' }
/** 러너의 페르소나 요약. `none`(카탈로그 없음)은 통과도 실패도 아니다. */
export interface TesterPersonaVerdict { id:string; verdict:'PASS'|'FAIL'|'BLOCKED'|string; contract:number; screen:number; /** 그 판정을 낸 실행(일부만 고른 실행이 있어 페르소나마다 다를 수 있다). */ runId?:string }
export interface TesterPersonaSummary {
  state:'none'|'invalid'|'ready'; catalog?:string|null; problem?:string; count?:number;
  personas?:{id:string; goal:string; contract:number; screen:number; explorable:boolean; observations:number}[];
  latest?:{runId:string; state:string; startedAt?:string; verdicts:TesterPersonaVerdict[]}|null;
}
export interface TesterStatus {
  installation:string; installedVersion?:string|null; availableVersion:string; configurationRevision:string;
  projectRevision?:string|null;
  profiles:{id:string; checks:string[]; configured:boolean}[]; defaultProfile:string|null;
  pythonVersion?:string; environmentReady:boolean; problem?:string;
  latest:TesterReport|null; latestRun?:TesterRun|null; active:TesterRun|null; freshness:string; instructionsConnected:boolean;
  memoryLinked:boolean; limitations:string[];
  targets:{id:string; label:string}[];
  /** 옛 앱 번들 러너(1.5.0 이전)는 이 칸을 주지 않는다 — 없음은 「카탈로그 없음」이 아니라 「모름」이다. */
  personas?:TesterPersonaSummary;
}
/** 자동 발견된 제안 하나. 받아들이기 전에는 어떤 프로필에서도 돌지 않는다. */
export interface TesterProposal { id:string; title:string; intent?:string; origin?:string; safety?:string; tags?:string[]; argv?:string[] }
export interface TesterGaps { uncoveredChanges?:string[]; untestedTestIdCount?:number; unreferencedTestFiles?:number; testFiles?:number }
/** 탐색 브리프의 꼬리표. 언제나 초안이고 판정이 없다. */
export interface TesterExploration { personaId:string; class:typeof TESTER_EXPLORATION_CLASS; draftOnly:true; verdict:null }
export interface TesterResult { exploration?:TesterExploration; status?:TesterStatus; ensure?:{outcome:'ready'|'installed'|'updated'|'skipped';installation:string;reason?:string;files?:string[];proposals?:string[]}; plan?:{revision:string; files:string[]; recovering:boolean}; applied?:boolean; run?:TesterRun; handoff?:string; files?:string[];
  proposals?:TesterProposal[]; gaps?:TesterGaps; accepted?:{id:string; path?:string} }
export class TesterError extends Error {
  constructor(readonly code:string, message:string, readonly status=409) { super(message); }
}
const fields:Record<TesterOperation,string[]> = {status:[],ensure:[],plan:[],apply:['revision'],start:['revision','requestId','profileId'],read:['runId'],cancel:['runId'],handoff:['mode','runId','personaId'],proposals:[],accept:['scenarioId']};
export function parseTesterRequest(input:unknown):TesterRequest {
  const r=input as TesterRequest;
  const bad=()=>{throw new TesterError('TESTER_REQUEST_INVALID','테스터 요청을 확인하세요.',400);};
  if(!r||typeof r!=='object'||Array.isArray(r)||!TESTER_OPERATIONS.includes(r.operation)) return bad();
  if(Object.keys(r).some(k=>!['operation','portId','workspaceTargetId',...fields[r.operation]].includes(k)))return bad();
  if(typeof r.portId!=='string'||!r.portId.trim()||r.portId.length>200||/[\x00-\x1f]/.test(r.portId))return bad();
  if(r.workspaceTargetId!==undefined&&(typeof r.workspaceTargetId!=='string'||!/^[-\w]{8,128}$/.test(r.workspaceTargetId)))return bad();
  if(['apply','start'].includes(r.operation)&&(typeof r.revision!=='string'||!/^[a-f0-9]{64}$/.test(r.revision)))return bad();
  if(r.operation==='start'&&(typeof r.profileId!=='string'||!/^[a-z0-9][a-z0-9-]{0,63}$/.test(r.profileId)||typeof r.requestId!=='string'||!/^test_\d{13}_[a-f0-9-]{36}$/.test(r.requestId)))return bad();
  if(['read','cancel'].includes(r.operation)&&r.runId===undefined)return bad();
  if(r.runId!==undefined&&(typeof r.runId!=='string'||!/^\d{8}T\d{6}Z-[a-f0-9]{8}$/.test(r.runId)))return bad();
  if(r.operation==='handoff'&&!['configure','repair','explore'].includes(r.mode!))return bad();
  // 탐색 초안은 페르소나 하나를 가리키고, 다른 실행 기록을 섞지 않는다.
  if(r.mode==='explore'&&(typeof r.personaId!=='string'||!/^[a-z0-9][a-z0-9-]{0,63}$/.test(r.personaId)||r.runId!==undefined))return bad();
  if(r.personaId!==undefined&&r.mode!=='explore')return bad();
  // 제안 id 는 러너가 만든 이름이다(`discover` 의 파일 이름) — 경로가 될 수 있는 글자는 받지 않는다.
  if(r.operation==='accept'&&(typeof r.scenarioId!=='string'||!/^[a-z0-9][a-z0-9.-]{0,79}$/.test(r.scenarioId)))return bad();
  return {...r};
}
export function testerRequestId():string {return `test_${Date.now()}_${crypto.randomUUID()}`;}
export const testerActive=(s:string)=>['queued','starting','running','canceling'].includes(s);
