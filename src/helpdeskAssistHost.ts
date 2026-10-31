import {createHash,randomUUID} from 'node:crypto';
import {AssistDriverUnavailable,AssistHumanControl,type AssistBrowserDriver,type AssistElement,type AssistObservation} from './helpdeskAssistBrowser';
import {plannerName,plannerPrompt,parsePlannerReply,plannerSupport,type AssistPlannerRunner} from './helpdeskAssistPlanner';
import {ASSIST_CHECK_IDS,ASSIST_TERMINAL,parseAssistRequest,type AssistAi,type AssistBrowser,type AssistCapabilities,type AssistCheck,type AssistCheckId,type AssistReceipt,type AssistRequest,type AssistRun,type AssistView,type AssistWaiting} from './helpdeskAssistProtocol';
import {assistAddress,assistAllowed,assistRecipe,assistSignInPage,googleProjectFromUrl,type AssistContext,type AssistRecipe,type AssistRecipeStep,type AssistTarget,type AssistValueSource} from './helpdeskAssistRecipes';
import {HelpdeskAssistStore,type AssistRecord} from './helpdeskAssistStore';
/** Actual results, each from its own source: a stored client, a finished official sign-in, a working CLI. */
export type AssistCheckResult={state:AssistCheck['state'];detail?:string;accountId?:string};
export type AssistVerifier=(id:AssistCheckId,run:Readonly<AssistRun>)=>Promise<AssistCheckResult>;
export type AssistHostDeps={store:HelpdeskAssistStore;drivers:Record<AssistBrowser,()=>AssistBrowserDriver>;verify:AssistVerifier;
 planner?:{claude?:AssistPlannerRunner;claudeState:()=>Promise<'ready'|'missing'|'signed-out'|'unknown'>};
 /** The person's own management of the built-in view (helpdesk's WorkroomBrowserHost instance). */
 browser?:(runId:string,value:Record<string,unknown>)=>Promise<unknown>;now?:()=>number;pid?:number;alive?:(pid:number)=>boolean;platform?:string};
/** Budgets of one run, said to the person when reached; nothing continues past them without a new start. */
export const ASSIST_LIMITS={actions:40,plannerCalls:12,minutes:30,heartbeatMs:60_000,misses:4};
type Runtime={driver:AssistBrowserDriver;epoch:number;busy:boolean;planner:AbortController|null};
const EMAIL=/[^\s@<>()]{1,64}@[^\s@<>()]{1,190}\.[^\s@<>()]{2,63}/g;
const shortName=(e:AssistElement)=>`${e.role} "${e.name.replace(EMAIL,'[이메일]').slice(0,60)}"`;
const isAlive=(pid:number)=>{try{process.kill(pid,0);return true;}catch(e:any){return e?.code==='EPERM';}};
/** 헬프데스크 도움받기 host. A run is created only by an explicit prepare and starts only by an explicit start with the
 * person's scope confirmed. Each advance does at most one browser action; take, pause and cancel discard any result that
 * arrives after them; restart interrupts rather than resumes. */
export class HelpdeskAssistHost {
 private runtimes=new Map<string,Runtime>();private capabilities:{at:number;value:AssistCapabilities}|null=null;
 /** Browser cleanup may finish after its control request. A new lease waits for the previous handoff/finish. */
 private cleanups=new Map<string,Promise<void>>();
 constructor(private deps:AssistHostDeps){this.recover();}
 private now(){return (this.deps.now??Date.now)();}
 private get pid(){return this.deps.pid??process.pid;}
 /** Runs this process does not own were interrupted by a restart. Grants and leases are never restored. */
 private recover(){
  for(const r of this.deps.store.all()){
   if(ASSIST_TERMINAL.includes(r.state)||['prepared','interrupted','needs-review'].includes(r.state))continue;
   // Another live process may still own it (a second app instance): leave it alone; a dead or absent owner was restarted.
   if(r.ownerPid===this.pid||r.ownerPid!==null&&(this.deps.alive??isAlive)(r.ownerPid))continue;
   try{this.deps.store.update(r.id,r.revision,c=>({...c,state:'interrupted',ownerPid:null,waiting:{reason:'review',note:'앱이 다시 시작돼 도움이 멈췄습니다. 브라우저 화면과 연결 상태를 확인한 뒤 새로 시작해 주세요. 자동으로 이어서 진행하지 않습니다.'}}));}catch{/* Another writer won; it is still reported as stored. */}
  }
 }
 private view(r:AssistRecord|null,capabilities:AssistCapabilities):AssistView{
  if(!r)return {revision:0,run:null,capabilities};
  const {requestId:_,fingerprint:__,ownerPid:___,cursor:____,lastSeen:_____,...run}=r;return {revision:r.revision,run:run as AssistRun,capabilities};
 }
 async caps(fresh=false):Promise<AssistCapabilities>{
  if(!fresh&&this.capabilities&&this.now()-this.capabilities.at<30_000)return this.capabilities.value;
  const drivers=await Promise.all((['ego','agentstoz'] as const).map(async browser=>{try{const d=this.deps.drivers[browser]();const r=await d.ready();return {browser,available:r.available,...(r.reason?{reason:r.reason}:{})};}catch(e){return {browser,available:false,reason:e instanceof AssistDriverUnavailable?e.message:'브라우저를 확인하지 못했습니다.'};}}));
  const claude=this.deps.planner?.claude?await this.deps.planner.claudeState().catch(()=>'unknown' as const):'missing' as const;
  const value:AssistCapabilities={drivers,planners:(['claude','codex','none'] as const).map(ai=>plannerSupport(ai,claude)),platform:(this.deps.platform??process.platform)==='darwin'?'mac':'other'};
  this.capabilities={at:this.now(),value};return value;
 }
 private record(id:string){const r=this.deps.store.get(id);if(!r)throw Error('도움받기 기록을 찾지 못했습니다.');return r;}
 private update(id:string,expected:number,fn:(r:AssistRecord)=>AssistRecord){return this.deps.store.update(id,expected,fn);}
 /** Re-reads and writes a result. A result that arrives after the run ended, or after the person moved it (`late`, given
  * the current record), keeps only the receipts and check evidence it adds: never the state, step, cursor or links. */
 private patch(id:string,fn:(r:AssistRecord)=>AssistRecord,late?:(current:AssistRecord)=>boolean){
  const r=this.record(id),n=fn(structuredClone(r));
  if(ASSIST_TERMINAL.includes(r.state)||late?.(r)){
   const known=new Set(r.receipts.map(x=>x.id)),added=n.receipts.filter(x=>!known.has(x.id));
   const checks=r.checks.map(x=>{const y=n.checks.find(k=>k.id===x.id);return y&&(y.at??0)>(x.at??0)?y:x;});
   if(!added.length&&JSON.stringify(checks)===JSON.stringify(r.checks))return r;
   return this.update(id,r.revision,c=>({...c,receipts:[...c.receipts,...added].slice(-64),checks}));
  }
  return this.update(id,r.revision,()=>n);
 }
 /** The binding of one piece of async work: the run's generation, step and state when it began. */
 private bind(r:AssistRecord){const g=r.generation,i=r.cursor.index,state=r.state;return (c:AssistRecord)=>c.generation!==g||c.cursor.index!==i||c.state!==state;}
 private context(r:AssistRun):AssistContext{return {projectId:r.links.projectId,decisions:r.decisions,email:r.intent.email};}
 private recipe(r:AssistRecord):AssistRecipe{const recipe=assistRecipe(r.intent);if(recipe.id!==r.recipeId||recipe.version!==r.recipeVersion)throw Error('도움 레시피가 바뀌었습니다. 새로 시작해 주세요.');return recipe;}
 /** An assisting run whose screen stopped asking (closed, hidden, asleep) pauses instead of acting unseen. */
 private heartbeat(r:AssistRecord){
  if(r.state!=='assisting'||this.now()-r.lastSeen<ASSIST_LIMITS.heartbeatMs)return r;
  const paused=this.update(r.id,r.revision,c=>({...c,generation:c.generation+1,state:'paused',waiting:{reason:'human-control',note:'도움받기 화면이 닫혀 있거나 응답이 없어 멈췄습니다. 화면을 확인하고 「이어서 진행」을 눌러 주세요.'}}));
  void this.handOff(r.id);return paused;
 }
 async handle(value:unknown):Promise<AssistView>{
  const q=parseAssistRequest(value);
  if(q.operation==='assist-capabilities')return this.view(null,await this.caps(true));
  if(q.operation==='assist-status'){let r=q.runId?this.deps.store.get(q.runId):this.deps.store.latest();if(r)r=this.heartbeat(r);return this.view(r,await this.caps());}
  if(q.operation==='assist-prepare')return this.view(this.prepare(q.requestId,q.intent),await this.caps());
  if(q.operation==='assist-browser'){const r=this.record(q.runId);if(r.browser!=='agentstoz'||ASSIST_TERMINAL.includes(r.state)||!this.deps.browser)throw Error('아젠투지브라우저로 진행 중인 도움이 아닙니다.');
   if(this.cleanups.has(r.id)&&!['status','take','detach'].includes(q.browser.operation))throw Error('이전 브라우저 조작을 정리하고 있습니다. 잠시 뒤 다시 진행해 주세요.');
   const result=await this.deps.browser(r.id,q.browser);return {...this.view(r,await this.caps()),browser:result} as AssistView;}
  return this.view(await this.mutate(q),await this.caps());
 }
 private prepare(requestId:string,intent:AssistRun['intent']):AssistRecord{
  const fingerprint=createHash('sha256').update(JSON.stringify(intent)).digest('hex');
  const same=this.deps.store.byRequest(requestId);if(same){if(same.fingerprint!==fingerprint)throw Error('같은 요청 ID를 다른 도움에 사용할 수 없습니다.');return same;}
  // Runs that were only prepared (nothing ran) close when newer ones replace them; nothing else is closed here.
  for(const old of this.deps.store.all().filter(x=>x.state==='prepared').slice(2))try{this.deps.store.update(old.id,old.revision,c=>({...c,state:'cancelled',generation:c.generation+1,message:'시작하지 않은 채 새 도움으로 바뀌었습니다.'}));}catch{/* Changed meanwhile. */}
  const recipe=assistRecipe(intent),now=this.now(),checks=new Set<AssistCheckId>(['browser']);for(const s of recipe.steps)if(s.check)checks.add(s.check);
  // Preparing only describes the scope: no browser, no AI, no check runs until the person starts.
  return this.deps.store.create({id:randomUUID(),requestId,fingerprint,revision:1,intent,recipeId:recipe.id,recipeVersion:recipe.version,support:recipe.support,state:'prepared',browser:null,ai:null,decisions:{},
   steps:recipe.steps.map(s=>({id:s.id,title:s.title,kind:s.kind,state:'pending',...(s.human??s.decision?.note?{human:s.human??s.decision!.note}:{})})),step:null,
   checks:ASSIST_CHECK_IDS.filter(id=>checks.has(id)).map(id=>({id,state:'unknown'})),receipts:[],links:{},budget:{actions:0,plannerCalls:0,startedAt:null},
   createdAt:now,updatedAt:now,origin:intent.origin,ownerPid:null,cursor:{index:0,navigated:false,target:0},lastSeen:now,generation:0});
 }
 private cleanup(id:string,action:()=>Promise<void>):Promise<void>{
  const pending=(this.cleanups.get(id)??Promise.resolve()).then(action).catch(()=>{});
  this.cleanups.set(id,pending);
  void pending.then(()=>{if(this.cleanups.get(id)===pending)this.cleanups.delete(id);});
  return pending;
 }
 private handOff(id:string):Promise<void>{
  const rt=this.runtimes.get(id);if(!rt)return this.cleanups.get(id)??Promise.resolve();
  this.stop(rt);rt.driver.abort?.();return this.cleanup(id,()=>rt.driver.handOff());
 }
 /** State is committed before releasing; pending handoff finishes before this run's final cleanup. */
 private async release(id:string){const rt=this.runtimes.get(id);if(!rt)return this.cleanups.get(id);
  this.stop(rt);this.runtimes.delete(id);rt.driver.abort?.();await this.cleanup(id,()=>rt.driver.finish());}
 private stop(rt:Runtime|undefined){if(!rt)return;rt.epoch++;rt.planner?.abort();rt.planner=null;}
 private async mutate(q:Exclude<AssistRequest,{operation:'assist-capabilities'|'assist-status'|'assist-prepare'|'assist-browser'}>):Promise<AssistRecord>{
  let r=this.record(q.runId);if(r.revision!==q.expectedRevision)throw Error('도움받기 상태가 바뀌었습니다. 최신 상태를 확인한 뒤 다시 요청하세요.');
  if(ASSIST_TERMINAL.includes(r.state))throw Error('이미 끝난 도움입니다. 필요하면 새로 시작해 주세요.');
  if(this.cleanups.has(r.id)&&q.operation!=='assist-cancel')throw Error('이전 브라우저 조작을 정리하고 있습니다. 잠시 뒤 다시 진행해 주세요.');
  const rt=this.runtimes.get(r.id);
  switch(q.operation){
   case 'assist-start':{
    if(r.state!=='prepared')throw Error('이미 시작한 도움입니다.');
    const caps=await this.caps(true),recipe=this.recipe(r),usesBrowser=recipe.steps.some(s=>s.kind==='browser');
    if(this.cleanups.size)throw Error('이전 브라우저 조작을 정리하고 있습니다. 잠시 뒤 다시 진행해 주세요.');
    const d=caps.drivers.find(x=>x.browser===q.browser);if(usesBrowser&&!d?.available)throw Error(d?.reason??'선택한 브라우저를 사용할 수 없습니다.');
    const p=caps.planners.find(x=>x.ai===q.ai);if(!p?.supported)throw Error(p?.reason??'선택한 도움 AI를 사용할 수 없습니다.');
    const decisions=q.decisions??{};if(decisions.project?.mode==='existing'&&r.intent.service!=='google-workspace')throw Error('이 도움에는 Google 프로젝트를 고르지 않습니다.');
    // One run holds a browser and the person's attention at a time.
    if(this.deps.store.all().some(x=>x.id!==r.id&&['assisting','waiting-human','paused','verifying','checking'].includes(x.state)))throw Error('다른 도움이 진행 중입니다. 그 도움을 끝낸 뒤 시작해 주세요.');
    const started=this.update(r.id,r.revision,c=>({...c,generation:c.generation+1,state:'assisting',browser:q.browser,ai:q.ai,decisions,ownerPid:this.pid,lastSeen:this.now(),budget:{actions:0,plannerCalls:0,startedAt:this.now()},
     links:{...c.links,...(decisions.project?.mode==='existing'?{projectId:decisions.project.id}:{})},step:c.steps[0]?.id??null,steps:c.steps.map((s,i)=>i===0?{...s,state:'active'}:s),cursor:{index:0,navigated:false,target:0}}));
    this.runtimes.set(r.id,{driver:this.deps.drivers[q.browser](),epoch:0,busy:false,planner:null});return started;
   }
   case 'assist-advance':return this.advance(r);
   case 'assist-pause':case 'assist-take':{
    if(!['assisting','waiting-human','checking','verifying'].includes(r.state))throw Error('지금은 멈출 진행이 없습니다.');
    // Commit revocation before awaiting browser cleanup: progress cannot win a CAS while handoff waits.
    this.update(r.id,r.revision,c=>({...c,generation:c.generation+1,state:'paused',waiting:q.operation==='assist-take'?{reason:'human-control',note:'직접 조작 중입니다. 마치면 「이어서 진행」을 눌러 주세요.'}:{reason:'human-control',note:'잠시 멈췄습니다. 준비되면 「이어서 진행」을 눌러 주세요.'}}));
    await this.handOff(r.id);return this.record(r.id);
   }
   case 'assist-resume':{
    if(!['paused','waiting-human','needs-review'].includes(r.state))throw Error('이어서 진행할 상태가 아닙니다.');
    if(r.receipts.some(x=>x.state==='unknown'))throw Error('결과를 알 수 없는 동작을 먼저 확인해 주세요.');
    if(!rt){if(r.browser&&this.recipe(r).steps.some(s=>s.kind==='browser'))this.runtimes.set(r.id,{driver:this.deps.drivers[r.browser](),epoch:0,busy:false,planner:null});}
    const own=this.runtimes.get(r.id);if(own){own.epoch++;const control=await own.driver.takeBack().catch(e=>e instanceof AssistDriverUnavailable?'gone' as const:'human' as const);
     if(control==='gone')return this.update(r.id,r.revision,c=>({...c,waiting:{reason:'human-control',note:'브라우저 작업 공간을 찾지 못했습니다. 브라우저를 다시 열고 「이어서 진행」을 눌러 주세요.'}}));}
    return this.update(r.id,r.revision,c=>{const {waiting:_,...rest}=c;return {...rest,generation:c.generation+1,state:'assisting',ownerPid:this.pid,lastSeen:this.now()};});
   }
   case 'assist-human-done':{
    if(!['waiting-human','paused'].includes(r.state))throw Error('지금은 직접 진행을 기다리지 않습니다.');
    if(r.receipts.some(x=>x.state==='unknown'))throw Error('결과를 알 수 없는 동작을 먼저 확인해 주세요.');
    const recipe=this.recipe(r),step=recipe.steps[r.cursor.index];let projectId=r.links.projectId;
    // The one value read back from the page: the project the person chose or created, from its address.
    const bound=this.bind(r);let tookBack=false;
    if(step?.id==='project'&&rt){
     // The page is the person's while they choose or create the project, and Ego refuses even an address read on a space
     // they hold. 이어서 진행 takes it back first, checks nobody moved the run meanwhile, and then reads the address only
     // (never the document or a capture). No project in a reviewed Console address gives the page back to the person.
     rt.epoch++;tookBack=true;const control=await rt.driver.takeBack().catch(e=>e instanceof AssistDriverUnavailable?'gone' as const:'human' as const);
     if(bound(this.record(r.id))){await rt.driver.handOff().catch(()=>{});throw Error('도움받기 상태가 바뀌었습니다. 최신 상태를 확인한 뒤 다시 요청하세요.');}
     const at=control==='gone'?null:await rt.driver.location().catch(()=>null);
     const found=at&&assistAllowed(at,step.allow)&&!assistSignInPage(at)?googleProjectFromUrl(at):null;if(found)projectId=found;
     if(!found){await rt.driver.handOff().catch(()=>{});tookBack=false;}
    }
    if(bound(this.record(r.id)))throw Error('도움받기 상태가 바뀌었습니다. 최신 상태를 확인한 뒤 다시 요청하세요.');
    if(step?.id==='project'&&!projectId)return this.update(r.id,r.revision,c=>({...c,generation:c.generation+1,state:'waiting-human',waiting:{reason:'decision',note:'사용할 프로젝트가 열린 화면을 확인하지 못했습니다. Console 상단에서 프로젝트를 고른 뒤 다시 눌러 주세요.'}}));
    if(step?.kind==='app'&&step.check){
     // An app step ends on its own result: a stored client or a finished sign-in, not on the person's word alone.
     const late=this.bind(r);const res=await this.deps.verify(step.check,r).catch(():AssistCheckResult=>({state:'failed',detail:'확인하지 못했습니다.'}));
     return this.patch(r.id,c=>{const n={...c,generation:c.generation+1,checks:this.setCheck(c.checks,step.check!,res),...(res.accountId?{links:{...c.links,accountId:res.accountId}}:{})};return res.state==='ok'?this.next(n,'human'):this.wait(n,{reason:step.app==='google-client'?'attach':'login',note:res.detail??'아직 확인되지 않았습니다. 앱 화면의 결과를 확인해 주세요.'});},late);
    }
    if(rt&&!tookBack){rt.epoch++;await rt.driver.takeBack().catch(()=>{});}
    return this.patch(r.id,c=>this.next({...c,generation:c.generation+1,links:{...c.links,...(projectId?{projectId}:{})},ownerPid:this.pid,lastSeen:this.now()},'human'),bound);
   }
   case 'assist-cancel':{
    this.update(r.id,r.revision,c=>{const {waiting:_,...rest}=c;return {...rest,generation:c.generation+1,state:'cancelled',ownerPid:null,message:'지원을 끝냈습니다. 브라우저에서 이미 저장한 설정은 그대로 남습니다.'};});
    await this.release(r.id);
    return this.record(r.id);
   }
   case 'assist-verify':return this.verifyConnection(r);
   case 'assist-link':{
    const step=this.recipe(r).steps[r.cursor.index];if(step?.kind!=='app'||!['google-login','cli-login','ai-login'].includes(step.app??''))throw Error('지금은 로그인 결과를 연결하는 단계가 아닙니다.');
    if(q.email&&r.intent.email&&q.email.toLowerCase()!==r.intent.email)throw Error('처음 정한 이메일과 다른 계정입니다. 범위를 다시 정하고 새로 시작해 주세요.');
    r=this.update(r.id,r.revision,c=>({...c,links:{...c.links,...(q.loginId?{loginId:q.loginId}:{}),...(q.accountId?{accountId:q.accountId}:{})}}));
    return q.accountId?this.checkStep(r):r;
   }
   case 'assist-settle':{
    const receipt=r.receipts.find(x=>x.id===q.receiptId);if(!receipt||receipt.state!=='unknown')throw Error('확인할 동작을 찾지 못했습니다.');
    if(r.state==='assisting')throw Error('먼저 「직접 하기」로 조작을 넘겨받아 화면을 확인해 주세요.');
    await rt?.driver.reviewed(receipt.id).catch(()=>{});
    return this.update(r.id,r.revision,c=>({...c,receipts:c.receipts.map(x=>x.id===receipt.id?{...x,state:'reviewed',note:'사람이 화면을 확인했습니다.'}:x)}));
   }
  }
 }
 /** The step is finished (by the help, the person, or because it was already in place); the next one becomes active. */
 private next(c:AssistRecord,how:'done'|'human'|'skipped'='done'):AssistRecord{
  const i=c.cursor.index,steps=c.steps.map((s,k)=>k===i?{...s,state:how}:k===i+1?{...s,state:'active' as const}:s);const {waiting:_,...rest}=c;
  return {...rest,state:'assisting',steps,step:steps[i+1]?.id??null,cursor:{index:i+1,navigated:false,target:0}};
 }
 private wait(c:AssistRecord,waiting:AssistWaiting,state:'waiting-human'|'paused'|'needs-review'='waiting-human'):AssistRecord{return {...c,state,waiting,steps:c.steps.map((s,k)=>k===c.cursor.index&&state==='waiting-human'?{...s,state:'human'}:s)};}
 private receipt(kind:AssistReceipt['kind'],stepId:string,state:AssistReceipt['state'],target?:string,note?:string):AssistReceipt{return {id:randomUUID(),stepId,kind,state,at:this.now(),...(target?{target:target.slice(0,90)}:{}),...(note?{note:note.slice(0,120)}:{})};}
 private budgetLeft(r:AssistRecord){return r.budget.actions<ASSIST_LIMITS.actions&&(!r.budget.startedAt||this.now()-r.budget.startedAt<ASSIST_LIMITS.minutes*60_000);}
 private async advance(r:AssistRecord):Promise<AssistRecord>{
  if(r.state!=='assisting')throw Error(r.state==='waiting-human'?'직접 진행할 차례입니다. 마치면 「이어서 진행」을 눌러 주세요.':'지금은 진행할 수 없습니다.');
  const recipe=this.recipe(r),step=recipe.steps[r.cursor.index];
  r=this.update(r.id,r.revision,c=>({...c,lastSeen:this.now()}));
  if(!step){this.update(r.id,r.revision,c=>({...c,generation:c.generation+1,state:'completed',step:null,ownerPid:null}));await this.release(r.id);return this.record(r.id);}
  const late=this.bind(r);
  if(step.kind==='check'){
   // Each result is written as evidence; the step advances only if nobody moved the run meanwhile.
   for(const id of r.checks.map(c=>c.id).filter(id=>id!=='browser')){const res=await this.deps.verify(id,r).catch(():AssistCheckResult=>({state:'unknown'}));const updated=this.patch(r.id,c=>({...c,checks:c.checks.map(x=>x.id===id?{...x,state:res.state==='ok'?'ok':'unknown',at:this.now(),...(res.detail?{detail:res.detail.slice(0,120)}:{})}:x)}),late);if(late(updated))return updated;}
   return this.patch(r.id,c=>this.next(c),late);
  }
  if(step.kind==='app'){
   if(step.check){const res=await this.deps.verify(step.check,r).catch(():AssistCheckResult=>({state:'unknown'}));if(res.state==='ok')return this.patch(r.id,c=>this.next({...c,checks:this.setCheck(c.checks,step.check!,res)},'skipped'),late);if(late(this.record(r.id)))return this.record(r.id);}
   const reason:AssistWaiting['reason']=step.app==='google-client'?'attach':step.app==='install'?'decision':'login';
   return this.update(r.id,r.revision,c=>this.wait(c,{reason,note:step.human??'앱 화면에서 직접 진행해 주세요.'}));
  }
  if(step.kind==='verify')return this.verifyConnection(r);
  if(step.kind==='return'){
   this.update(r.id,r.revision,c=>{const steps=c.steps.map((s,k)=>k===c.cursor.index?{...s,state:'done' as const}:s);const ok=c.checks.find(x=>x.id==='connection')?.state==='ok';
    return {...c,generation:c.generation+1,ownerPid:null,steps,step:null,state:ok||c.support==='entry'?'completed':'needs-review',...(ok||c.support==='entry'?{}:{waiting:{reason:'review',note:'실제 연결 확인이 끝나지 않았습니다. 연결 확인을 다시 실행하거나 원래 화면에서 확인해 주세요.'}})} as AssistRecord;});
   await this.release(r.id);return this.record(r.id);
  }
  return this.browserStep(r,recipe,step);
 }
 private setCheck(checks:AssistCheck[],id:AssistCheckId,res:AssistCheckResult){return checks.map(x=>x.id===id?{...x,state:res.state,at:this.now(),...(res.detail?{detail:res.detail.slice(0,120)}:{})}:x);}
 private async checkStep(r:AssistRecord):Promise<AssistRecord>{
  const step=this.recipe(r).steps[r.cursor.index];if(!step?.check)return r;const late=this.bind(r);
  const res=await this.deps.verify(step.check,r).catch(():AssistCheckResult=>({state:'failed',detail:'확인하지 못했습니다.'}));
  return this.patch(r.id,c=>{const n={...c,checks:this.setCheck(c.checks,step.check!,res),...(res.accountId?{links:{...c.links,accountId:res.accountId}}:{})};return res.state==='ok'&&c.cursor.index===r.cursor.index?this.next(n):n;},late);
 }
 /** Only the real check completes a run: a stored client or a finished sign-in alone does not. */
 private async verifyConnection(r:AssistRecord):Promise<AssistRecord>{
  r=this.update(r.id,r.revision,c=>({...c,state:'verifying'}));const late=this.bind(r);
  const res=await this.deps.verify('connection',r).catch(():AssistCheckResult=>({state:'failed',detail:'실제 연결을 확인하지 못했습니다.'}));
  return this.patch(r.id,c=>{
   const n={...c,checks:this.setCheck(c.checks,'connection',res)};const step=this.recipe(c).steps[c.cursor.index];
   if(res.state==='ok')return step?.kind==='verify'?this.next(n):{...n,state:'assisting'};
   return this.wait(n,{reason:'review',note:res.detail??'실제 연결을 확인하지 못했습니다. 인증·클라이언트·계정이 맞는지 확인하세요.'},'needs-review');
  },late);
 }
 private value(r:AssistRecord,source:AssistValueSource):string|null{
  if(source==='project-name')return r.decisions.project?.mode==='new'?r.decisions.project.name:null;
  if(source==='app-name')return r.decisions.appName??null;
  return r.intent.email??null;
 }
 /** Elements a target may act on: role and name match, never a stopBefore element, never anything secret. */
 private matches(r:AssistRecord,step:AssistRecipeStep,target:AssistTarget,o:AssistObservation){
  const value=target.value?this.value(r,target.value):null;if((target.action==='fill'||target.action==='choose')&&!value)return [];
  return o.elements.filter(e=>target.roles.includes(e.role)&&!step.stopBefore?.test(e.name)&&(target.action==='choose'?e.name.trim().toLowerCase()===value!.toLowerCase():target.name!.test(e.name.trim())));
 }
 private async browserStep(r:AssistRecord,recipe:AssistRecipe,step:AssistRecipeStep):Promise<AssistRecord>{
  const rt=this.runtimes.get(r.id);if(!rt)return this.update(r.id,r.revision,c=>this.wait(c,{reason:'review',note:'브라우저 연결이 없습니다. 「이어서 진행」으로 다시 연결해 주세요.'},'paused'));
  if(rt.busy)throw Error('이전 동작을 처리하는 중입니다.');
  if(!this.budgetLeft(r))return this.update(r.id,r.revision,c=>this.wait(c,{reason:'review',note:'이번 도움의 동작·시간 한도에 도달했습니다. 남은 단계는 직접 진행하거나 새로 시작해 주세요.'},'paused'));
  const ctx=this.context(r);
  if(step.needsProject&&!ctx.projectId)return this.update(r.id,r.revision,c=>this.wait(c,{reason:'decision',note:'사용할 Google 프로젝트를 먼저 정해야 합니다. 프로젝트 단계로 돌아가 고른 뒤 이어서 진행해 주세요.'}));
  rt.busy=true;const epoch=rt.epoch;
  // A result that arrives after take, pause or cancel keeps its receipt and nothing else.
  const bound=this.bind(r),late=()=>rt.epoch!==epoch||bound(this.record(r.id)),write=(fn:(c:AssistRecord)=>AssistRecord)=>this.patch(r.id,fn,c=>rt.epoch!==epoch||bound(c));
  try{
   const a=await rt.driver.attach(r.id,{...(r.links.spaceId?{spaceId:r.links.spaceId}:{})});
   if(a.spaceId&&a.spaceId!==r.links.spaceId||r.checks.find(x=>x.id==='browser')?.state!=='ok')r=write(c=>({...c,links:{...c.links,...(a.spaceId?{spaceId:a.spaceId}:{})},checks:this.setCheck(c.checks,'browser',{state:'ok',detail:c.browser==='ego'?'에고라이트 작업 공간':'아젠투지브라우저'})}));
   if(!r.cursor.navigated){
    const url=step.url?.(ctx);if(!url)return this.update(r.id,r.revision,c=>this.wait(c,{reason:'decision',note:'이 단계에서 열 주소를 정하지 못했습니다. 직접 진행해 주세요.'}));
    const out=await rt.driver.navigate(url,randomUUID());const receipt=this.receipt('navigate',step.id,out.state,assistAddress(url),out.note);
    return write(c=>({...c,receipts:[...c.receipts,receipt].slice(-64),budget:{...c.budget,actions:c.budget.actions+1},cursor:{...c.cursor,navigated:out.state==='confirmed'},
     ...(out.state==='unknown'?{state:'needs-review' as const,waiting:{reason:'review' as const,note:'페이지 이동 결과를 확인하지 못했습니다. 브라우저 화면을 확인해 주세요.'}}:{})}));
   }
   // The arrived address is judged before anything on the page is read.
   const at=await rt.driver.location();if(late())return this.record(r.id);
   if(!at||assistSignInPage(at)){await rt.driver.handOff().catch(()=>{});return write(c=>this.wait(c,{reason:'sign-in',note:'로그인·추가 인증 화면입니다. 직접 마친 뒤 「이어서 진행」을 눌러 주세요. 이 화면은 읽지 않습니다.'}));}
   if(!assistAllowed(at,step.allow)){await rt.driver.handOff().catch(()=>{});return write(c=>this.wait(c,{reason:'unexpected-page',note:'이 단계에서 예상한 화면이 아닙니다. 화면을 확인하고 직접 진행하거나 「이어서 진행」을 눌러 주세요.'}));}
   if(typeof step.done==='function'&&step.done({...ctx,url:at}))return write(c=>this.next(c));
   const control=await rt.driver.settle(url=>assistAllowed(url,step.allow)&&!assistSignInPage(url));
   if(control!=='agent'){await rt.driver.handOff().catch(()=>{});return write(c=>this.wait(c,{reason:'human-control',note:control==='gone'?'브라우저 작업 공간이 닫혔습니다. 다시 열고 「이어서 진행」을 눌러 주세요.':'직접 조작한 것으로 보여 멈췄습니다. 마치면 「이어서 진행」을 눌러 주세요.'},'paused'));}
   const o=await rt.driver.observe(step.allow??[]);if(late())return this.record(r.id);
   if(o.secret){await rt.driver.handOff().catch(()=>{});return write(c=>this.wait(c,{reason:'secret',note:'화면에 비밀값이 보여 읽기를 멈췄습니다. 직접 처리한 뒤 비밀값 창을 닫고 「이어서 진행」을 눌러 주세요.'}));}
   if(step.done&&typeof step.done!=='function'){const d=step.done;if(o.elements.some(e=>d.roles.includes(e.role)&&d.name.test(e.name.trim())))return write(c=>this.next(step.check?{...c,checks:this.setCheck(c.checks,step.check,{state:'ok',detail:'화면에서 사용 설정을 확인했습니다.'})}:c));}
   const targets=step.targets??[];
   let index=-1,found:AssistElement[]=[];
   for(let i=r.cursor.target;i<targets.length;i++){const t=targets[i]!;if(t.when&&!t.when(ctx))continue;const m=this.matches(r,step,t,o);if(m.length){index=i;found=m;break;}}
   if(index<0){
    const remaining=targets.slice(r.cursor.target).some(t=>!t.when||t.when(ctx));
    if(!remaining){await rt.driver.handOff().catch(()=>{});return write(c=>step.decision&&!step.decision.skip?.(ctx)?this.wait(c,{reason:step.decision.reason,note:step.decision.note}):this.next(c));}
    const misses=r.cursor.misses??0;
    if(misses+1>=ASSIST_LIMITS.misses){await rt.driver.handOff().catch(()=>{});return write(c=>this.wait(c,{reason:'unexpected-page',note:step.decision?.note??'다음에 누를 곳을 찾지 못했습니다. 직접 진행한 뒤 「이어서 진행」을 눌러 주세요.'}));}
    return write(c=>({...c,cursor:{...c.cursor,misses:misses+1}}));
   }
   let element=found[0]!;
   if(found.length>1){
    const runner=r.ai==='claude'?this.deps.planner?.claude:undefined;
    if(!runner||r.budget.plannerCalls>=ASSIST_LIMITS.plannerCalls){await rt.driver.handOff().catch(()=>{});return write(c=>this.wait(c,{reason:runner?'review':'no-planner',note:'비슷한 항목이 여러 개라 고르지 않았습니다. 직접 골라 진행한 뒤 「이어서 진행」을 눌러 주세요.'}));}
    rt.planner=new AbortController();let pick:{choice:number|null};
    try{pick=parsePlannerReply(await runner(plannerPrompt({step:step.title,goal:this.goal(targets[index]!),candidates:found}),rt.planner.signal),found.length);}catch{pick={choice:null};}finally{rt.planner=null;}
    r=write(c=>({...c,budget:{...c.budget,plannerCalls:c.budget.plannerCalls+1}}));if(late())return this.record(r.id);
    if(pick.choice===null){await rt.driver.handOff().catch(()=>{});return write(c=>this.wait(c,{reason:'ambiguous',note:'도움 AI가 확실한 항목을 고르지 못했습니다. 직접 골라 진행한 뒤 「이어서 진행」을 눌러 주세요.'}));}
    element=found[pick.choice]!;
   }
   const target=targets[index]!,id=randomUUID();
   const out=target.action==='fill'?await rt.driver.fill(element.ref,target.name?.source.slice(0,40)??'input',this.value(r,target.value!)!,id):await rt.driver.click(element.ref,plannerName(element.name).slice(0,40),id);
   const receipt={...this.receipt(target.action==='fill'?'fill':'click',step.id,out.state,`${target.action==='fill'?'입력':'클릭'} ${shortName(element)}`,out.note),id};
   return write(c=>{
    const base={...c,receipts:[...c.receipts,receipt].slice(-64),budget:{...c.budget,actions:c.budget.actions+1}};
    if(out.state==='unknown')return this.wait(base,{reason:'review',note:'동작 결과를 확인하지 못했습니다. 「직접 하기」로 화면을 확인하고 결과 확인을 눌러 주세요. 자동으로 다시 보내지 않습니다.'},'needs-review');
    if(out.state==='refused')return base;
    return {...base,cursor:{index:c.cursor.index,navigated:true,target:index+1}};
   });
  }catch(e){
   if(e instanceof AssistHumanControl){this.stop(rt);return write(c=>this.wait(c,{reason:'human-control',note:'브라우저 조작이 사람에게 있습니다. 마치면 「이어서 진행」을 눌러 주세요.'},'paused'));}
   if(e instanceof AssistDriverUnavailable)return write(c=>this.wait(c,{reason:'review',note:e.message},'paused'));
   return write(c=>this.wait(c,{reason:'review',note:'브라우저 동작을 확인하지 못했습니다. 화면을 확인하고 직접 진행하거나 「이어서 진행」을 눌러 주세요.'},'paused'));
  }finally{rt.busy=false;}
 }
 private goal(t:AssistTarget){return t.action==='fill'?'type the decided value into the right field':t.action==='choose'?'pick the person\'s own entry':`press the control named like ${t.name?.source.slice(0,40)}`;}
 /** The unfinished run that chose the built-in browser, if any: the only target that browser's view may belong to. */
 activeOwnedRun(){return this.deps.store.all().find(r=>r.browser==='agentstoz'&&!ASSIST_TERMINAL.includes(r.state)&&r.state!=='prepared')?.id??null;}
 shutdown(){for(const rt of this.runtimes.values()){this.stop(rt);rt.driver.abort?.();void rt.driver.handOff().catch(()=>{});}this.runtimes.clear();this.deps.store.close();}
}
export type {AssistAi};
