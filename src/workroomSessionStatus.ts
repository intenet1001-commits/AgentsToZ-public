/** Display evidence only. Never use terminal text to authorize or schedule a save. */
export function codexContextUsedFromFooter(lines:readonly string[]):number|null {
  for(const line of [...lines].reverse()){
    const match=/^\s*(\d{1,3})%\s+(?:context\s+)?left\s*$/.exec(line);
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
const id=(v:unknown)=>typeof v==='string'&&/^[A-Za-z0-9_-]{8,160}$/.test(v);
const date=(v:unknown)=>v===null||typeof v==='string'&&v.length<=40&&Number.isFinite(Date.parse(v));
export function validWorkroomSessionStatus(v:unknown):v is WorkroomSessionStatus {
  if(!v||typeof v!=='object'||Array.isArray(v))return false;
  const s=v as WorkroomSessionStatus,c=s.context,j=s.save;
  return Object.keys(s).every(k=>['sessionId','context','lastSavedAt','initialized','save'].includes(k))&&id(s.sessionId)&&date(s.lastSavedAt)&&typeof s.initialized==='boolean'
    &&!!c&&Object.keys(c).every(k=>['usedPercent','observedAt','source'].includes(k))&&(c.usedPercent===null||typeof c.usedPercent==='number'&&Number.isFinite(c.usedPercent)&&c.usedPercent>=0&&c.usedPercent<=100)&&date(c.observedAt)&&(c.source==='unavailable'?c.usedPercent===null&&c.observedAt===null:c.source==='claude-statusline'&&c.usedPercent!==null&&c.observedAt!==null)
    &&!!j&&Object.keys(j).every(k=>['requestId','state','localSaved','backupSaved','message'].includes(k))&&(j.requestId===null||id(j.requestId))&&typeof j.state==='string'&&j.state.length<=64&&typeof j.localSaved==='boolean'&&typeof j.backupSaved==='boolean'&&typeof j.message==='string'&&j.message.length<=500;
}

export function claudeWorkroomContext(session:{id:string;cwd:string;createdAt:string},snapshot:any,now=Date.now()):WorkroomSessionStatus['context'] {
 const p=snapshot?.contextWindow?.used_percentage,at=Date.parse(snapshot?.capturedAt);
 if(snapshot?.sessionId!==session.id||snapshot?.cwd!==session.cwd||typeof p!=='number'||!Number.isFinite(p)||p<0||p>100||!Number.isFinite(at)||at<Date.parse(session.createdAt)||at>now+5000)return {usedPercent:null,observedAt:null,source:'unavailable'};
 return {usedPercent:p,observedAt:snapshot.capturedAt,source:'claude-statusline'};
}
