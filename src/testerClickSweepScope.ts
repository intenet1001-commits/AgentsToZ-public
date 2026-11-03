/** Consistency of a project-harness completion report, never proof of OS execution or authority. */
export function desktopSweepCompletionIsConsistent(value:unknown):boolean{
  if(!value||typeof value!=='object'||Array.isArray(value))return false;
  const v=value as Record<string,unknown>;
  if(typeof v.completed!=='boolean'||typeof v.passed!=='boolean'||typeof v.updated!=='boolean'||typeof v.state!=='string'||!['passed','failed','unavailable','unconfigured'].includes(v.state))return false;
  const count=(key:string,min=0)=>typeof v[key]==='number'&&Number.isInteger(v[key])&&(v[key] as number)>=min&&(v[key] as number)<=1_000_000;
  if(!count('elements')||!count('clicked')||!count('failures')||v.passed!==(v.state==='passed'))return false;
  if(v.completed)return ['passed','failed'].includes(v.state)&&count('elements',1)&&count('clicked',1)&&(v.passed?v.failures===0:(v.failures as number)>0);
  return v.state!=='passed'&&v.passed===false&&v.updated===false;
}
