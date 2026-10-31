import {randomUUID} from 'node:crypto';
import {AssistDriverUnavailable,AssistHumanControl,assistReadable,sanitizeObservation,type AssistBrowserDriver,type AssistControl,type AssistDispatch,type AssistObservation} from './helpdeskAssistBrowser';
import type {WorkroomBrowserHost} from './workroomBrowserHost';
import type {AssistDestination} from './helpdeskAssistRecipes';
import type {BrowserWorkspace} from './workroomBrowserProtocol';
/** The built-in browser's own view for the helpdesk: one native profile, no Workroom. Its host instance accepts this
 * session only while a run that chose this browser is active, and the run id is its target. */
export const HELPDESK_ASSIST_SESSION='helpdesk-assist-browser';
const fault=(e:unknown)=>e instanceof Error?e.message:String(e);
/** 아젠투지브라우저 driver. It holds the page only through the host's own lease (resume → grant), sees elements of the main
 * document only, and counts the person's trusted inputs across each of its steps: one input means the person holds it. */
export class OwnedAssistDriver implements AssistBrowserDriver {
 readonly kind='agentstoz' as const;private workspace:string|null=null;private runId='';private inputs=0;private grant:string|null=null;
 /** The observation the engine chose from: an action names its element by this observation only, or is refused. */
 private observed:{id:string;epoch:number;url:string;refs:Set<string>}|null=null;private baseline=false;
 constructor(private host:WorkroomBrowserHost){}
 async ready(){return process.platform==='darwin'?{available:true}:{available:false,reason:'아젠투지브라우저는 이 Mac 앱에서만 열 수 있습니다.'};}
 private state(){const id=this.workspace;const s=id?this.host.trustedState(id):null;if(!s||s.connection!=='connected'||s.targetId!==this.runId)return null;return s;}
 private live(){const s=this.state();if(!s)throw new AssistDriverUnavailable('아젠투지브라우저 화면이 닫혔습니다. 다시 열어 주세요.');return s;}
 /** Idempotent for the same run and workspace: the input baseline set at the first attach stays, so the person's input
  * since then still counts. Only takeBack (the person pressed 이어서 진행) moves the baseline. A different workspace (the
  * view was closed and opened again) is the person's doing: the help waits for them. */
 async attach(runId:string){
  const workspace=this.host.trustedWorkspace(HELPDESK_ASSIST_SESSION);
  if(this.workspace&&this.runId===runId&&this.baseline){
   if(workspace!==this.workspace){this.workspace=workspace;this.baseline=false;this.grant=null;this.observed=null;if(!this.state())throw new AssistDriverUnavailable('아젠투지브라우저 화면이 닫혔습니다. 다시 열어 주세요.');throw new AssistHumanControl();}
   this.live();return {};
  }
  this.runId=runId;this.workspace=workspace;
  const s=this.state();if(!s)throw new AssistDriverUnavailable('도움받기 화면의 아젠투지브라우저를 먼저 열어 주세요.');
  this.inputs=s.inputs;this.baseline=true;return {};
 }
 /** The person's input since this driver last held the page. */
 async navigate(url:string):Promise<AssistDispatch>{
  const s=this.live();if(s.inputs!==this.inputs)throw new AssistHumanControl();
  this.grant=null;this.observed=null;
  // The host checks the same epoch, input count and run again right before Page.navigate: a takeover that happened
  // while this waited in the queue refuses it.
  try{await this.host.navigateTrusted(this.workspace!,url,{epoch:s.epoch,inputs:s.inputs,targetId:this.runId});return {state:'confirmed'};}
  catch(e){return /changed|taken/i.test(fault(e))?{state:'refused',note:'사람이 조작해 이동하지 않았습니다.'}:{state:'unknown',note:'이동 결과를 확인하지 못했습니다.'};}
 }
 async location(){return this.live().url;}
 /** Holds the lease for one observation: resume (fresh observation, the person's earlier input forgotten) then grant.
  * Only on a reviewed, non-sign-in address, judged from the browser's own report before resume reads anything. */
 private async lease(allow:readonly AssistDestination[]){
  let s=this.live();if(s.inputs!==this.inputs)throw new AssistHumanControl();
  if(!assistReadable(s.url,allow))throw new AssistHumanControl();
  if(s.owner!=='agent'||!this.grant){
   this.grant=null;const url=s.url;const r=await this.host.perform({operation:'resume',workspaceId:this.workspace!});if(!r.success)throw Error('RESUME_FAILED');
   const g=await this.host.perform({operation:'grant',workspaceId:this.workspace!});if(!g.success||!g.grant)throw Error('GRANT_FAILED');this.grant=g.grant;
   s=this.live();if(s.inputs!==this.inputs||s.url!==url||s.owner!=='agent'){this.grant=null;throw new AssistHumanControl();}
  }
  return {grant:this.grant!,epoch:s.epoch};
 }
 private agentWorkspace(r:Awaited<ReturnType<WorkroomBrowserHost['agent']>>):BrowserWorkspace{if(!r.success||!r.workspace)throw Error('AGENT_FAILED');return r.workspace;}
 async observe(allow:readonly AssistDestination[]):Promise<AssistObservation>{
  this.observed=null;const {grant,epoch}=await this.lease(allow);
  const w=this.agentWorkspace(await this.host.agent({operation:'observe',workspaceId:this.workspace!,grant,epoch}));const o=w.observation;if(!o)throw Error('OBSERVE_FAILED');
  const now=this.live();if(now.epoch!==epoch||now.observationId!==o.id||!assistReadable(now.url,allow))throw new AssistHumanControl();
  this.observed={id:o.id,epoch,url:now.url,refs:new Set(o.elements.filter(e=>!e.frame).map(e=>e.selector))};
  // Frames are left out: a recipe acts on the page it reviewed, never on an embedded document.
  return sanitizeObservation({title:o.title,text:o.text+'\n'+(o.frames??[]).map(f=>f.text).join('\n'),elements:o.elements.filter(e=>!e.frame).map(e=>({ref:e.selector,role:e.role,name:e.name}))});
 }
 private async act(operation:'click'|'fill',ref:string,requestId:string,text?:string):Promise<AssistDispatch>{
  // Bound to the observation the element came from: no resume or fresh observation here, so a page that changed
  // since (another observation, a navigation, the person's input) refuses instead of acting on a different element.
  const seen=this.observed;this.observed=null;const s=this.live();
  if(s.inputs!==this.inputs)throw new AssistHumanControl();
  if(!seen||!seen.refs.has(ref)||!this.grant||s.owner!=='agent'||s.epoch!==seen.epoch||s.observationId!==seen.id||s.url!==seen.url)return {state:'refused',note:'페이지가 바뀌어 다시 확인해야 합니다.'};
  const lease={grant:this.grant,epoch:seen.epoch},observationId=seen.id;
  let error='';
  try{await this.host.agent({operation,workspaceId:this.workspace!,grant:lease.grant,epoch:lease.epoch,observationId,requestId,selector:ref,...(operation==='fill'?{text:text??''}:{})});}catch(e){error=fault(e);}
  // The host's own receipt says what happened: completed = the action ran in the page; unknown = it may have.
  const receipt=this.host.trustedState(this.workspace!)?.receipts[requestId];this.grant=null;
  if(receipt==='completed')return {state:'dispatched-unverified'};
  if(receipt==='unknown')return {state:'unknown',note:/Human takeover/i.test(error)?'사람이 조작을 넘겨받아 결과를 확인하지 못했습니다.':'동작 결과를 확인하지 못했습니다.'};
  return {state:'refused',note:'페이지가 바뀌어 동작하지 않았습니다.'};
 }
 click(ref:string,_label:string,requestId:string){return this.act('click',ref,requestId);}
 fill(ref:string,_label:string,value:string,requestId:string){return this.act('fill',ref,requestId,value);}
 async reviewed(requestId:string){
  if(!this.state())return;await this.host.perform({operation:'take',workspaceId:this.workspace!});
  await this.host.perform({operation:'settle',workspaceId:this.workspace!,requestId}).catch(()=>{});
 }
 async settle(allowed:(url:string)=>boolean):Promise<AssistControl>{
  const s=this.state();if(!s)return 'gone';if(s.inputs!==this.inputs)return 'human';
  if(Object.values(s.receipts).includes('unknown'))return 'human';
  // A navigation ended the lease; the help continues only on a reviewed address, judged before anything there is read.
  return s.url&&allowed(s.url)?'agent':'human';
 }
 async handOff(){this.grant=null;this.observed=null;if(this.state())await this.host.perform({operation:'take',workspaceId:this.workspace!}).catch(()=>{});}
 async takeBack():Promise<AssistControl>{if(!this.workspace||this.workspace!==this.host.trustedWorkspace(HELPDESK_ASSIST_SESSION))this.workspace=this.host.trustedWorkspace(HELPDESK_ASSIST_SESSION);const s=this.state();if(!s)return 'gone';this.inputs=s.inputs;this.baseline=true;this.grant=null;this.observed=null;return s.verified?'agent':'human';}
 async finish(){await this.handOff();this.workspace=null;this.baseline=false;}
}
export const assistRequestId=()=>randomUUID();
