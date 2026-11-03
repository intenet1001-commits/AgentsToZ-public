/** File-only handoff to an already-connected human-controlled CUA host.
 * This module neither provides a native adapter nor certifies a manual report as PASS. */
export interface DesktopOperativeConfig {schemaVersion:1;surfaceId:string;bundleId:string;platform:'darwin';maxTargets:number}
export interface DesktopOperativeScope {bundleId:string;appCommit:string;device:string;mode:'isolated'|'operational';scopeReference:string}
export interface DesktopOperativePlan {schemaVersion:1;runId:string;projectCommit:string;scope:DesktopOperativeScope;createdAt:number;expiresAt:number;maxTargets:number}
export interface DesktopEvidenceReference {path:string;sha256:string}
export interface DesktopOperativeInventory {id:string;role:'button'|'checkbox'|'menuitem'|'tab';label:string;evidence:DesktopEvidenceReference}
export interface DesktopOperativeAction {operationId:string;targetId:string;outcome:'observed'|'unknown'|'blocked';before:DesktopEvidenceReference;after:DesktopEvidenceReference;effect:{kind:'ui-change'|'navigation'|'backend-receipt'|'no-change';evidence:DesktopEvidenceReference}}
export interface DesktopManualReceipt {schemaVersion:1;runId:string;scope:DesktopOperativeScope;origin:'manual-cua-observation';observedAt:number;application:{bundleId:string;appCommit:string;infoSha256:string;cdHash:string};inventory:DesktopOperativeInventory[];actions:DesktopOperativeAction[]}
/** An interface for a future host binding; no implementation or registration factory is supplied here.
 * Only the existing connected host may execute its own documented CUA calls. JSON cannot become this port. */
export interface ConnectedDesktopObservationPort {
  observe(request:Readonly<{runId:string;scope:DesktopOperativeScope}>):Promise<unknown>;
  performReviewedAction(request:Readonly<{runId:string;operationId:string;targetId:string;scope:DesktopOperativeScope}>):Promise<unknown>;
}
export interface DesktopOperativeStatus {schemaVersion:1;state:'blocked'|'observed'|'unknown';bundleId:string;appCommit:string;device:string;mode:'isolated'|'operational';runId:string;inventory:number;clicked:number;effects:number;reason:'adapter-absent'|'manual-observations'|'unknown-effect';verdict:null}
const error=()=>new Error('DESKTOP_OPERATIVE_INVALID');
const exact=(v:unknown,keys:string[]):Record<string,unknown>=>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).sort().join('\0')!==[...keys].sort().join('\0'))throw error();return v as Record<string,unknown>;};
const text=(v:unknown,max=120):v is string=>typeof v==='string'&&!!v.trim()&&v===v.trim()&&new TextEncoder().encode(v).length<=max&&!/[\p{Cc}\p{Cf}]/u.test(v);
const hash=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const commit=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{40}$/.test(v);
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
const integer=(v:unknown,min:number,max:number):v is number=>Number.isSafeInteger(v)&&(v as number)>=min&&(v as number)<=max;
export function parseDesktopOperativeConfig(value:unknown):DesktopOperativeConfig{
  const v=exact(value,['schemaVersion','surfaceId','bundleId','platform','maxTargets']);
  if(v.schemaVersion!==1||typeof v.surfaceId!=='string'||!/^[a-z0-9][a-z0-9-]{0,63}$/.test(v.surfaceId)||!text(v.bundleId)||!/^[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)+$/.test(v.bundleId)||v.platform!=='darwin'||!integer(v.maxTargets,1,128))throw error();
  return v as unknown as DesktopOperativeConfig;
}
export function parseDesktopOperativeScope(value:unknown):DesktopOperativeScope{
  const v=exact(value,['bundleId','appCommit','device','mode','scopeReference']);
  if(!text(v.bundleId)||!commit(v.appCommit)||!text(v.device,80)||!['isolated','operational'].includes(v.mode as string)||!text(v.scopeReference,160))throw error();
  return v as unknown as DesktopOperativeScope;
}
const sameScope=(a:DesktopOperativeScope,b:DesktopOperativeScope)=>Object.keys(a).every(k=>a[k as keyof DesktopOperativeScope]===b[k as keyof DesktopOperativeScope]);
export function parseDesktopOperativePlan(value:unknown):DesktopOperativePlan{
  const v=exact(value,['schemaVersion','runId','projectCommit','scope','createdAt','expiresAt','maxTargets']);
  const scope=parseDesktopOperativeScope(v.scope);
  if(v.schemaVersion!==1||!uuid(v.runId)||!commit(v.projectCommit)||!integer(v.createdAt,1,Number.MAX_SAFE_INTEGER)||!integer(v.expiresAt,v.createdAt+1,v.createdAt+1_800_000)||!integer(v.maxTargets,1,128))throw error();
  return {...v,scope} as unknown as DesktopOperativePlan;
}
function reference(value:unknown):DesktopEvidenceReference{
  const v=exact(value,['path','sha256']);
  if(!text(v.path,400)||v.path.startsWith('/')||v.path.includes('\\')||v.path.split('/').some(x=>!x||x==='.'||x==='..')||!hash(v.sha256))throw error();
  return v as unknown as DesktopEvidenceReference;
}
/** Manual observations remain observations even when complete. They cannot populate the native PASS summary. */
export function parseDesktopManualReceipt(value:unknown,plan:DesktopOperativePlan,now:number):DesktopManualReceipt{
  const v=exact(value,['schemaVersion','runId','scope','origin','observedAt','application','inventory','actions']);
  const scope=parseDesktopOperativeScope(v.scope),app=exact(v.application,['bundleId','appCommit','infoSha256','cdHash']);
  if(v.schemaVersion!==1||v.runId!==plan.runId||!sameScope(scope,plan.scope)||v.origin!=='manual-cua-observation'||!integer(now,plan.createdAt,Number.MAX_SAFE_INTEGER)||!integer(v.observedAt,plan.createdAt,Math.min(now+5000,plan.expiresAt))
    ||app.bundleId!==scope.bundleId||app.appCommit!==scope.appCommit||!hash(app.infoSha256)||typeof app.cdHash!=='string'||!/^[a-f0-9]{40,64}$/.test(app.cdHash)
    ||!Array.isArray(v.inventory)||!v.inventory.length||v.inventory.length>plan.maxTargets||!Array.isArray(v.actions)||!v.actions.length||v.actions.length>v.inventory.length)throw error();
  const ids=new Set<string>(),operations=new Set<string>(),clicked=new Set<string>();
  const inventory=v.inventory.map(item=>{const x=exact(item,['id','role','label','evidence']);if(!text(x.id,80)||ids.has(x.id)||!['button','checkbox','menuitem','tab'].includes(x.role as string)||!text(x.label,240))throw error();ids.add(x.id);return {...x,evidence:reference(x.evidence)} as unknown as DesktopOperativeInventory;});
  let uncertain=false;
  const actions=v.actions.map(item=>{const x=exact(item,['operationId','targetId','outcome','before','after','effect']);const effect=exact(x.effect,['kind','evidence']);
    if(uncertain||!uuid(x.operationId)||operations.has(x.operationId)||typeof x.targetId!=='string'||!ids.has(x.targetId)||clicked.has(x.targetId)||!['observed','unknown','blocked'].includes(x.outcome as string)||!['ui-change','navigation','backend-receipt','no-change'].includes(effect.kind as string))throw error();
    operations.add(x.operationId);clicked.add(x.targetId);uncertain=x.outcome!=='observed';const before=reference(x.before),after=reference(x.after),effectEvidence=reference(effect.evidence);
    // A no-change record is useful diagnostic evidence, never a successful effect observation.
    if(x.outcome==='observed'&&(effect.kind==='no-change'||before.sha256===after.sha256))throw error();
    return {...x,before,after,effect:{...effect,evidence:effectEvidence}} as unknown as DesktopOperativeAction;
  });
  return {...v,scope,application:app,inventory,actions} as unknown as DesktopManualReceipt;
}
export function desktopOperativeStatus(plan:DesktopOperativePlan,receipt?:DesktopManualReceipt):DesktopOperativeStatus{
  const unknown=receipt?.actions.some(x=>x.outcome!=='observed')??false;
  return {schemaVersion:1,state:unknown?'unknown':receipt?'observed':'blocked',bundleId:plan.scope.bundleId,appCommit:plan.scope.appCommit,device:plan.scope.device,mode:plan.scope.mode,runId:plan.runId,
    inventory:receipt?.inventory.length??0,clicked:receipt?.actions.length??0,effects:receipt?.actions.filter(x=>x.outcome==='observed').length??0,reason:unknown?'unknown-effect':receipt?'manual-observations':'adapter-absent',verdict:null};
}
export function parseDesktopOperativeStatus(value:unknown,config:DesktopOperativeConfig):DesktopOperativeStatus{
  const v=exact(value,['schemaVersion','state','bundleId','appCommit','device','mode','runId','inventory','clicked','effects','reason','verdict']);
  if(v.schemaVersion!==1||v.bundleId!==config.bundleId||!commit(v.appCommit)||!text(v.device,80)||!['isolated','operational'].includes(v.mode as string)||!uuid(v.runId)||v.verdict!==null
    ||!integer(v.inventory,0,config.maxTargets)||!integer(v.clicked,0,v.inventory)||!integer(v.effects,0,v.clicked))throw error();
  if(v.state==='blocked'){if(v.reason!=='adapter-absent'||v.inventory!==0||v.clicked!==0||v.effects!==0)throw error();}
  else if(v.state==='observed'){if(v.reason!=='manual-observations'||!v.inventory||!v.clicked||v.effects!==v.clicked)throw error();}
  else if(v.state==='unknown'){if(v.reason!=='unknown-effect'||!v.inventory||!v.clicked||v.effects>=v.clicked)throw error();}
  else throw error();
  return v as unknown as DesktopOperativeStatus;
}
export function manualEvidenceReferences(receipt:DesktopManualReceipt):DesktopEvidenceReference[]{return [...receipt.inventory.map(x=>x.evidence),...receipt.actions.flatMap(x=>[x.before,x.after,x.effect.evidence])];}

/** Block only this unconnected preparation target; never regenerate an existing web baseline to prepare it. */
export function desktopOperativeBaselineBlocked(sweep:{surfaces:{id:string;baselinePresent:boolean}[];operative?:{state:string;surfaceId?:string}}):boolean{
  if(!sweep.operative)return false;
  if(sweep.operative.state==='invalid')return true;
  const missing=sweep.surfaces.filter(surface=>!surface.baselinePresent);
  return missing.length>0&&missing.every(surface=>surface.id===sweep.operative!.surfaceId);
}
