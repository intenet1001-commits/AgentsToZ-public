import type {TesterReport, TesterRun, TesterStatus} from './testerAgentContract';

export const MOBILE_TESTER_FEATURE = 'tester-v1';
export const MOBILE_TESTER_ACTIONS = ['tester.status', 'tester.start', 'tester.read', 'tester.cancel'] as const;
export type MobileTesterAction = typeof MOBILE_TESTER_ACTIONS[number];
export const TESTER_STATES = ['queued','starting','running','canceling','recovery-required','passed','failed','blocked','interrupted','skipped'] as const;
export type MobileTesterState = typeof TESTER_STATES[number];
export interface MobileTesterRun {
  id:string; state:MobileTesterState; profileId:string; createdAt:string; finishedAt?:string;
  origin:'app'|'local-cli'; sourceUnchanged?:boolean;
  checkCount:number; checks:{id:string; state:MobileTesterState; durationSeconds?:number}[];
}
export interface MobileTesterResult {
  installation?:'ready'|'absent'|'needs-attention'; environmentReady?:boolean;
  revision?:string; profiles?:{id:string; configured:boolean}[]; defaultProfile?:string|null;
  freshness?:'current'|'source-changed'|'unknown'; run?:MobileTesterRun|null;
  canRun:boolean; canCancel:boolean;
}
const record=(v:unknown):v is Record<string,any> => !!v&&typeof v==='object'&&!Array.isArray(v);
const only=(v:Record<string,any>,keys:string[])=>Object.keys(v).every(k=>keys.includes(k));
export const testerProfileId=(v:unknown):v is string=>typeof v==='string'&&/^[a-z0-9][a-z0-9-]{0,63}$/.test(v);
export const testerRunId=(v:unknown):v is string=>typeof v==='string'&&/^\d{8}T\d{6}Z-[a-f0-9]{8}$/.test(v);
const date=(v:unknown)=>typeof v==='string'&&v.length<=40&&Number.isFinite(Date.parse(v));
const state=(v:unknown):v is MobileTesterState=>TESTER_STATES.includes(v as MobileTesterState);
export function normalizeMobileTesterResult(v:unknown):MobileTesterResult {
  const fail=():never=>{throw new Error('모바일 테스트 응답을 확인하지 못했습니다.');};
  if(!record(v)||!only(v,['installation','environmentReady','revision','profiles','defaultProfile','freshness','run','canRun','canCancel'])||typeof v.canRun!=='boolean'||typeof v.canCancel!=='boolean')return fail();
  if(v.installation!==undefined&&!['ready','absent','needs-attention'].includes(v.installation)||v.environmentReady!==undefined&&typeof v.environmentReady!=='boolean'||v.revision!==undefined&&(typeof v.revision!=='string'||!/^([a-f0-9]{64})?$/.test(v.revision))||v.defaultProfile!==undefined&&v.defaultProfile!==null&&!testerProfileId(v.defaultProfile)||v.freshness!==undefined&&!['current','source-changed','unknown'].includes(v.freshness))return fail();
  if(v.profiles!==undefined&&(!Array.isArray(v.profiles)||v.profiles.length>16||v.profiles.some(p=>!record(p)||!only(p,['id','configured'])||!testerProfileId(p.id)||typeof p.configured!=='boolean')))return fail();
  const r=v.run;
  if(r!==undefined&&r!==null){
    if(!record(r)||!only(r,['id','state','profileId','createdAt','finishedAt','origin','sourceUnchanged','checkCount','checks'])||!testerRunId(r.id)||!state(r.state)||!testerProfileId(r.profileId)||!date(r.createdAt)||r.finishedAt!==undefined&&!date(r.finishedAt)||!['app','local-cli'].includes(r.origin)||r.sourceUnchanged!==undefined&&typeof r.sourceUnchanged!=='boolean'||!Number.isSafeInteger(r.checkCount)||r.checkCount<0||r.checkCount>96||!Array.isArray(r.checks)||r.checks.length>12||r.checks.length>r.checkCount)return fail();
    if(r.checks.some((c:unknown)=>!record(c)||!only(c,['id','state','durationSeconds'])||!testerProfileId(c.id)||!state(c.state)||c.durationSeconds!==undefined&&(typeof c.durationSeconds!=='number'||!Number.isFinite(c.durationSeconds)||c.durationSeconds<0)))return fail();
  }
  if(new TextEncoder().encode(JSON.stringify(v)).length>7000)return fail();
  return v as MobileTesterResult;
}
// Deliberately omit output, error text, argv, paths, memory and source hashes.
export function mobileTesterRun(run:TesterRun):MobileTesterRun {
  const checks=run.report?.checks??[];
  return {id:run.id,state:state(run.state)?run.state:'blocked',profileId:testerProfileId(run.profileId)?run.profileId:'unknown',createdAt:run.createdAt,
    ...(run.finishedAt?{finishedAt:run.finishedAt}:{}),origin:run.origin,
    ...(typeof run.report?.sourceUnchanged==='boolean'?{sourceUnchanged:run.report.sourceUnchanged}:{}),
    checkCount:Math.min(96,checks.length),checks:checks.slice(0,12).map((c,i)=>({id:testerProfileId(c.id)?c.id:`check-${i+1}`,state:state(c.state)?c.state:'blocked',...(c.durationSeconds===undefined?{}:{durationSeconds:c.durationSeconds})}))};
}
export function latestTesterRun(s:Pick<TesterStatus,'active'|'latestRun'|'latest'>):TesterRun|null {
  if(s.active)return s.active;
  const l:TesterReport|null=s.latest;
  if(s.latestRun&&(!l||s.latestRun.id===l.runId||Date.parse(s.latestRun.createdAt)>=Date.parse(l.startedAt)))return s.latestRun;
  return l?{id:l.runId,state:l.state,profileId:l.profile,createdAt:l.startedAt,finishedAt:l.finishedAt,origin:'local-cli',report:l}:null;
}
export const testerStateLabel:Record<MobileTesterState,string>={queued:'검사 대기',starting:'검사 준비 중',running:'검사 중',canceling:'취소 확인 중','recovery-required':'Mac에서 결과 확인 필요',passed:'선택한 검사 통과',failed:'검사 실패',blocked:'실행 조건 확인 필요',interrupted:'검사 중단',skipped:'생략'};
