import type {CodexAutoRememberStatus} from './codexAutoRememberContract';
export interface AutomaticSaveNotice {id:string;project:string;agent:string;savedAt:string;kind:'memory'|'recovery-fragment';threshold:number|null;expiresAt:string|null}
const labels:Record<string,string>={codex:'Codex',claude:'Claude',hermes:'Hermes',agy:'Antigravity'};
const sevenDays=7*24*60*60*1000;
/** Only durable completion metadata creates a notice. A crossed usage fence,
 * `saving`, or an enabled setting cannot manufacture a success message. */
export function automaticSaveNotices(status:Pick<CodexAutoRememberStatus,'sessions'>&{recoveryCheckpoints?:unknown},now=Date.now()):AutomaticSaveNotice[]{
  const fresh=(date:unknown)=>typeof date==='string'&&Number.isFinite(Date.parse(date))&&Date.parse(date)<=now&&Date.parse(date)>now-sevenDays;
  const rows:AutomaticSaveNotice[]=[];
  for(const s of status.sessions.slice(0,24)){
    const agent=s.sourceAgent??'codex';
    if(!fresh(s.lastCheckpointAt)||![50,70,75,90].includes(s.lastCheckpointThreshold!)||!s.projectName||!['codex','claude'].includes(agent))continue;
    rows.push({id:`memory:${agent}:${s.sessionId}:${s.lastCheckpointAt}:${s.lastCheckpointThreshold}`,project:s.projectName.slice(0,160),agent:labels[agent]!,savedAt:s.lastCheckpointAt!,kind:'memory',threshold:s.lastCheckpointThreshold,expiresAt:null});
  }
  if(Array.isArray(status.recoveryCheckpoints))for(const r of status.recoveryCheckpoints.slice(0,12)){
    if(!r||typeof r!=='object'||typeof r.id!=='string'||!/^[a-f0-9]{64}$/.test(r.id)||typeof r.projectName!=='string'||!r.projectName||!Object.hasOwn(labels,r.agent)||!fresh(r.savedAt)||typeof r.expiresAt!=='string'||!Number.isFinite(Date.parse(r.expiresAt))||Date.parse(r.expiresAt)<=now)continue;
    rows.push({id:'recovery:'+r.id,project:r.projectName.slice(0,160),agent:labels[r.agent]!,savedAt:r.savedAt,kind:'recovery-fragment',threshold:null,expiresAt:r.expiresAt});
  }
  return rows.sort((a,b)=>Date.parse(b.savedAt)-Date.parse(a.savedAt)).slice(0,24);
}
