import {pickWeeklyLimit} from './workroomWeeklyLimit';
export const WEEKLY_USAGE_PATH='/api/agent-runtime/weekly-usage';
export type WeeklyProvider='claude'|'codex'|'agy';
export interface WeeklyBucket {label:string;remainingPercent:number;resetsAt:number|null}
export interface WeeklyUsage {provider:WeeklyProvider;buckets:WeeklyBucket[];checkedAt:string|null;source:'live'|'statusline'|'unavailable';connected:boolean;canConnect:boolean}
/** `alerts`: this Mac's 「휴대폰 알림」 switch (src/weeklyUsagePushHost.ts) — read it, or turn it on or off. */
export type WeeklyUsageRequest={operation:'status'}|{operation:'connect'|'disconnect';provider:'claude'|'agy'}|{operation:'alerts';enabled?:boolean};
export function normalizeWeeklyUsageRequest(v:unknown):WeeklyUsageRequest {
  if(!v||typeof v!=='object'||Array.isArray(v))throw Error('사용량 요청 형식이 올바르지 않습니다.');
  const r=v as Record<string,unknown>;
  if(r.operation==='status'&&Object.keys(r).length===1)return {operation:'status'};
  if(['connect','disconnect'].includes(r.operation as string)&&['claude','agy'].includes(r.provider as string)&&Object.keys(r).length===2)return r as WeeklyUsageRequest;
  if(r.operation==='alerts'&&Object.keys(r).length===1)return {operation:'alerts'};
  if(r.operation==='alerts'&&typeof r.enabled==='boolean'&&Object.keys(r).length===2)return {operation:'alerts',enabled:r.enabled};
  throw Error('지원하는 사용량 연결 동작만 요청할 수 있습니다.');
}
const finite=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v);
const reset=(v:unknown):number|null=>finite(v)&&v>0?v:typeof v==='string'&&Number.isFinite(Date.parse(v))?Date.parse(v)/1000:null;
/** Only explicit weekly fields; context %, five-hour quotas and absolute amounts are never a weekly %. */
export function weeklyBuckets(provider:WeeklyProvider,input:any):WeeklyBucket[]{
  if(provider==='codex') {const w=pickWeeklyLimit(input);return w?[{label:'주간',remainingPercent:w.remainingPercent,resetsAt:w.resetsAt}]:[];}
  if(provider==='claude') {const w=input?.seven_day;return finite(w?.used_percentage)&&w.used_percentage>=0&&w.used_percentage<=100?[{label:'주간',remainingPercent:Math.round((100-w.used_percentage)*10)/10,resetsAt:reset(w.resets_at)}]:[];}
  if(!input||typeof input!=='object'||Array.isArray(input))return [];
  return Object.entries(input).filter(([key,w]:[string,any])=>/(?:^|[-_])weekly(?:$|[-_])/i.test(key)&&w&&w.disabled!==true&&finite(w.remaining_fraction)&&w.remaining_fraction>=0&&w.remaining_fraction<=1).slice(0,8).map(([key,w]:[string,any])=>({label:/gemini/i.test(key)?'Gemini':/claude|gpt/i.test(key)?'Claude/GPT':'추가 한도',remainingPercent:Math.round(w.remaining_fraction*1000)/10,resetsAt:reset(w.reset_time)}));
}
export function weeklyUsageState(row:WeeklyUsage,now=Date.now()):'ready'|'stale'|'waiting'|'unavailable'{
  const at=Date.parse(row.checkedAt??'');
  if(!row.buckets.length||!Number.isFinite(at)||at>now+60_000)return row.connected&&!Number.isFinite(at)?'waiting':'unavailable';
  if(row.buckets.some(b=>b.resetsAt!==null&&b.resetsAt*1000<=now)||now-at>15*60_000)return 'stale';
  return 'ready';
}
export function normalizeWeeklyUsageItems(value:unknown):WeeklyUsage[]{
 if(!Array.isArray(value))return [];
 return (['claude','codex','agy'] as const).flatMap(provider=>{
  const row=value.find(v=>v&&v.provider===provider);if(!row)return [];
  const buckets=Array.isArray(row.buckets)?row.buckets.slice(0,8).filter((b:any)=>b&&['주간','Gemini','Claude/GPT','추가 한도'].includes(b.label)&&finite(b.remainingPercent)&&b.remainingPercent>=0&&b.remainingPercent<=100&&(b.resetsAt===null||finite(b.resetsAt)&&b.resetsAt>0)).map((b:any)=>({label:b.label,remainingPercent:b.remainingPercent,resetsAt:b.resetsAt})):[];
  return [{provider,buckets,checkedAt:typeof row.checkedAt==='string'&&row.checkedAt.length<80&&Number.isFinite(Date.parse(row.checkedAt))?row.checkedAt:null,source:['live','statusline'].includes(row.source)?row.source:'unavailable',connected:row.connected===true,canConnect:provider!=='codex'&&row.canConnect===true}];
 });
}
