import {claudeSnapshotUsedTokens,measuredContextPercent} from './contextUsageReading';
/** Display evidence only. Never use terminal text to authorize or schedule a save. */
export function codexContextUsedFromFooter(lines:readonly string[]):number|null {
  for(const line of [...lines].reverse()){
    const match=/^\s*(?:context\s+)?(\d{1,3})%\s+(?:context\s+)?left\s*$/i.exec(line);
    if(match){const remaining=Number(match[1]);return remaining<=100?100-remaining:null;}
  }
  return null;
}
export interface WorkroomSessionStatus {
  sessionId:string;
  context:{usedPercent:number|null;observedAt:string|null;source:'claude-statusline'|'unavailable'};
  lastSavedAt:string|null;
  initialized:boolean;
  save:{requestId:string|null;state:string;localSaved:boolean;backupSaved:boolean;message:string};
}
export interface WorkroomAutomaticSave {kind:'memory'|'recovery-fragment';savedAt:string;threshold:number|null;expiresAt:string|null}
const id=(v:unknown)=>typeof v==='string'&&/^[A-Za-z0-9_-]{8,160}$/.test(v);
const date=(v:unknown)=>v===null||typeof v==='string'&&v.length<=40&&Number.isFinite(Date.parse(v));
export function validWorkroomSessionStatus(v:unknown):v is WorkroomSessionStatus {
  if(!v||typeof v!=='object'||Array.isArray(v))return false;
  const s=v as WorkroomSessionStatus,c=s.context,j=s.save;
  return Object.keys(s).every(k=>['sessionId','context','lastSavedAt','initialized','save'].includes(k))&&id(s.sessionId)&&date(s.lastSavedAt)&&typeof s.initialized==='boolean'
    &&!!c&&Object.keys(c).every(k=>['usedPercent','observedAt','source'].includes(k))&&(c.usedPercent===null||typeof c.usedPercent==='number'&&Number.isFinite(c.usedPercent)&&c.usedPercent>=0&&c.usedPercent<=100)&&date(c.observedAt)&&(c.source==='unavailable'?c.usedPercent===null&&c.observedAt===null:c.source==='claude-statusline'&&c.usedPercent!==null&&c.observedAt!==null)
    &&!!j&&Object.keys(j).every(k=>['requestId','state','localSaved','backupSaved','message'].includes(k))&&(j.requestId===null||id(j.requestId))&&typeof j.state==='string'&&j.state.length<=64&&typeof j.localSaved==='boolean'&&typeof j.backupSaved==='boolean'&&typeof j.message==='string'&&j.message.length<=500;
}

/** Exact provider binding only. A neighbouring session in the same project is
 * never evidence that this conversation was saved. These are historical saves,
 * not permission to clear later work or a claim of full transcript coverage. */
export function workroomAutomaticSaves(input:{providerId:string|null;agent:string;projectId:string;
  checkpoints:readonly {sessionId:string;sourceAgent?:string;projectId:string|null;lastCheckpointAt:string|null;lastCheckpointThreshold:number|null}[];
  recoveries:readonly {sessionId:string;agent:string;createdAt:number;expiresAt:number}[]},now=Date.now()):WorkroomAutomaticSave[]{
  if(!input.providerId)return [];
  const results:WorkroomAutomaticSave[]=[];
  const c=input.checkpoints.find(c=>c.sessionId===input.providerId&&(c.sourceAgent??'codex')===input.agent&&c.projectId===input.projectId);
  const at=Date.parse(c?.lastCheckpointAt??'');
  if(c&&Number.isFinite(at)&&at<=now&&[50,70,75,90].includes(c.lastCheckpointThreshold!))results.push({kind:'memory',savedAt:c.lastCheckpointAt!,threshold:c.lastCheckpointThreshold,expiresAt:null});
  const r=input.recoveries.filter(r=>r.agent===input.agent&&r.sessionId===input.providerId&&r.createdAt<=now&&r.expiresAt>now).sort((a,b)=>b.createdAt-a.createdAt)[0];
  if(r)results.push({kind:'recovery-fragment',savedAt:new Date(r.createdAt).toISOString(),threshold:null,expiresAt:new Date(r.expiresAt).toISOString()});
  return results;
}
/** Keep the existing wire schema: older phones strictly reject extra fields.
 * Saving/error/recovery messages retain priority over historical notifications. */
export function withWorkroomAutomaticSaveMessage<T extends WorkroomSessionStatus['save']>(save:T,receipts:readonly WorkroomAutomaticSave[]):T {
  if(!['idle','saved','unchanged','backup-pending'].includes(save.state)||!receipts.length)return save;
  const messages=receipts.map(r=>r.kind==='memory'
    ?`컨텍스트 ${r.threshold}% 기준 자동 세션 기억 로컬 저장 · ${r.savedAt}`
    :`복구 조각 암호화 저장 · ${r.savedAt} · ${r.expiresAt}까지 보관 · 전체 대화·장기기억과 별도`);
  return {...save,message:[save.message.slice(0,150),...messages,'이후 변경은 별도입니다. 내용을 확인한 뒤 필요하면 직접 압축·초기화하세요.'].filter(Boolean).join(' · ').slice(0,500)};
}

export function claudeWorkroomContext(session:{id:string;cwd:string;createdAt:string},snapshot:any,now=Date.now()):WorkroomSessionStatus['context'] {
 const p=snapshot?.contextWindow?.used_percentage,at=Date.parse(snapshot?.capturedAt);
 // Claude reports 0 until its first reply after a start, resume or compaction: that is 「확인 불가」, not 0%.
 if(snapshot?.sessionId!==session.id||snapshot?.cwd!==session.cwd||typeof p!=='number'||!Number.isFinite(p)||p<0||p>100||!Number.isFinite(at)||at<Date.parse(session.createdAt)||at>now+5000
  ||measuredContextPercent({usedPercent:p,usedTokens:claudeSnapshotUsedTokens(snapshot?.contextWindow)})===null)return {usedPercent:null,observedAt:null,source:'unavailable'};
 return {usedPercent:p,observedAt:snapshot.capturedAt,source:'claude-statusline'};
}
