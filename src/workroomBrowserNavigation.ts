import type {BrowserRecoverySummary,BrowserWorkspace,WorkroomBrowserRequest} from './workroomBrowserProtocol';
import {WorkroomBrowserError,classifyWorkroomBrowserError} from './workroomBrowserErrorCodes';
export type NativeReadiness={targetProbes?:number;targetSends?:number;targetResults?:number;navigations?:number};
export type NativePageStatus={preparing?:boolean;targetId?:string|null;port?:number;url?:string|null;closed?:boolean;profileKey?:string;loading?:boolean;readiness?:NativeReadiness};
export type OwnedBrowserAction=(operation:'navigate'|'status'|'retarget',extra?:Record<string,unknown>)=>Promise<NativePageStatus>;
/** Where words typed in the address bar go, as in any browser's address bar. */
export const OWNED_BROWSER_SEARCH='https://www.google.com/search?q=';
/** A host the person could mean as an address: a dotted name ending in a letter label, an IPv4, or an IPv6 literal. */
const addressHost=(value:string)=>{
 const host=value.split(/[/?#]/,1)[0]!;
 // Credentials are refused below as an address, never searched.
 if(host.includes('@'))return true;
 const name=host.replace(/:\d+$/,'');
 return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(name)||/^\[[\da-f:.]+\]$/i.test(name)||/^[^.]+(?:\.[^.]+)*\.\p{L}[\p{L}\d-]*$/u.test(name);
};
/** Human address-bar input: HTTPS for domains, HTTP for local development hosts, a search for anything else typed.
 * Explicit origins remain unchanged; this never turns arbitrary schemes into web URLs. */
export function normalizeOwnedBrowserAddress(input:string){
 const value=input.trim();
 if(!value||value.length>4096||/[\u0000-\u001f\u007f]/.test(value))throw new WorkroomBrowserError('invalid-address','HTTP(S) address required.');
 const local=/^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?(?:[/?#]|$)/i.test(value);
 const hostPort=/^(?:localhost|[^/?#:@]+\.[^/?#:@]+):\d+(?:[/?#]|$)/i.test(value);
 const scheme=/^[a-z][a-z\d+.-]*:/i.test(value)&&!hostPort;
 // Words, not an address (「네이버」, 「react hooks」): search them. `https://네이버` would be a host that never resolves.
 if(!scheme&&!local&&!hostPort&&(/\s/.test(value)||!addressHost(value))){
  let search:string;try{search=OWNED_BROWSER_SEARCH+encodeURIComponent(value);}catch(e){throw new WorkroomBrowserError('invalid-address',e instanceof Error?e.message:String(e));}
  if(search.length>4096)throw new WorkroomBrowserError('invalid-address','HTTP(S) address required.');
  return new URL(search).href;
 }
 if(/[\s\\]/.test(value))throw new WorkroomBrowserError('invalid-address','HTTP(S) address required.');
 let parsed:URL;try{parsed=new URL(scheme?value:`${local?'http':'https'}://${value}`);}catch(e){throw new WorkroomBrowserError('invalid-address',e instanceof Error?e.message:String(e));}
 if(!['http:','https:'].includes(parsed.protocol)||parsed.username||parsed.password)throw new WorkroomBrowserError('invalid-address','HTTP(S) address required.');
 return parsed.href;
}
/** native/workroom-browser probes its own target at most this many times per round (no faster than twice a second). */
export const NATIVE_TARGET_PROBES=16;
/** A probe budget spent, or an engine that stopped loading, must stay that way this long before it counts. */
export const OWNED_SETTLE_MS=2000;
/** One human page request passes these stages in order. A later stage never repeats an earlier one's side effect:
 * the accepted navigation is sent once, and a slow document is `loading`, not a failure. */
export type OwnedBrowserStage='profile'|'navigating'|'target'|'loading'|'connecting';
export type OwnedPageState=
 |{kind:'ready';targetId:string;port:number;url:string}
 |{kind:'target'}          // navigation accepted; the exact target's discovery reply is still due
 |{kind:'target-lost'}     // every bounded probe went out and none answered with the target
 |{kind:'loading'}         // the target is known; Chromium is still loading its HTTP(S) document
 |{kind:'no-document'}     // the engine stopped loading and never committed an HTTP(S) document
 |{kind:'closed'}|{kind:'profile-changed'};
export type OwnedStartupFailure='renderer-timeout'|'target-lost'|'no-document'|'connect';
export type OwnedStartupResult=
 |{kind:'connected';workspace:BrowserWorkspace}
 |{kind:'ready'}           // the page is up; this Workroom was already connected
 |{kind:'ended'}           // its generation ended (closed, unmounted, other Workroom or profile): nothing is attached
 |{kind:'failed';failure:OwnedStartupFailure;error?:unknown};
export function classifyOwnedPage(s:NativePageStatus,profileKey:string):OwnedPageState{
 if(s.closed)return {kind:'closed'};
 if(s.profileKey!==undefined&&s.profileKey!==profileKey)return {kind:'profile-changed'};
 if(!s.targetId||!s.port)return (s.readiness?.targetProbes??0)>=NATIVE_TARGET_PROBES?{kind:'target-lost'}:{kind:'target'};
 if(s.url&&/^https?:\/\//.test(s.url))return {kind:'ready',targetId:s.targetId,port:s.port,url:s.url};
 return s.loading===false?{kind:'no-document'}:{kind:'loading'};
}
const pause=(ms:number)=>new Promise<void>(r=>setTimeout(r,ms));
/** Tauri rejects with a string; retain its exact message when crossing the startup boundary. */
const startupError=(e:unknown)=>e instanceof WorkroomBrowserError?e:new WorkroomBrowserError(classifyWorkroomBrowserError(e),e instanceof Error?e.message:typeof e==='string'?e:'Browser operation failed.');
type Clock={sleep?:(ms:number)=>Promise<void>;now?:()=>number};
/** A cold CEF renderer may not have a main frame yet. Until it does, `navigate` answers `preparing` without loading
 * anything, so asking again is safe; the first accepted call is the request's only navigation. */
export async function admitOwnedNavigation(action:OwnedBrowserAction,url:string,current:()=>boolean,{sleep=pause}:Clock={}){
 for(let i=0;i<100;i++){
  if(!current())return false;
  let status:NativePageStatus;try{status=await action('navigate',{url});}catch(e){throw startupError(e);}
  if(!status.preparing)return true;
  await sleep(100);
 }
 throw new WorkroomBrowserError('profile-timeout','Chromium renderer initialization timed out.');
}
/** After acceptance: wait for the exact target, then for its document. Nothing here navigates. A document keeps
 * loading for as long as Chromium loads it; only a spent probe budget or a load that ended without a document stops. */
export async function awaitOwnedPage(action:OwnedBrowserAction,profileKey:string,current:()=>boolean,onStage:(stage:'target'|'loading')=>void=()=>{},{sleep=pause,now=Date.now}:Clock={}):Promise<OwnedPageState|undefined>{
 let lostSince=0,idleSince=0;
 for(let polls=0;;polls++){
  if(!current())return;
  let status:NativePageStatus;try{status=await action('status');}catch(e){throw startupError(e);}
  const state=classifyOwnedPage(status,profileKey);
  if(!current())return;
  if(state.kind==='ready'||state.kind==='closed'||state.kind==='profile-changed')return state;
  const t=now();
  lostSince=state.kind==='target-lost'?lostSince||t:0;idleSince=state.kind==='no-document'?idleSince||t:0;
  if(lostSince&&t-lostSince>=OWNED_SETTLE_MS||idleSince&&t-idleSince>=OWNED_SETTLE_MS)return state;
  onStage(state.kind==='target'||state.kind==='target-lost'?'target':'loading');
  await sleep(polls<20?100:polls<60?250:1000);
 }
}
/** The whole start of one built-in page: navigation (only when `url` is given), target, document, then the broker.
 * `current` belongs to the request's own generation. Once it is over, nothing is attached: a connection that
 * arrives late is detached, never handed to another Workroom, a closed view or a changed profile. A retry passes
 * no `url`, so it finishes only the connect and never sends the accepted navigation again. */
export async function startOwnedBrowser(o:{action:OwnedBrowserAction;request:(r:WorkroomBrowserRequest)=>Promise<{workspace?:BrowserWorkspace}>;current:()=>boolean;sessionId:string;targetId:string;profileKey:string;recoveryId?:string;url?:string;connect:boolean|((pageId:string)=>boolean);onStage?:(stage:OwnedBrowserStage)=>void;onAccepted?:()=>void;clock?:Clock}):Promise<OwnedStartupResult>{
 const stage=o.onStage??(()=>{});
 if(o.url){
  stage('navigating');
  let admitted:boolean;
  try{admitted=await admitOwnedNavigation(o.action,o.url,o.current,o.clock);}catch(error){return o.current()?{kind:'failed',failure:'renderer-timeout',error:startupError(error)}:{kind:'ended'};}
  if(!admitted)return {kind:'ended'};
  // Accepted means Chromium loads it, even when this generation ended while the reply was on its way: the request is
  // still recorded, so reopening finishes its connect instead of leaving the page unconnected or navigating again.
  o.onAccepted?.();
  if(!o.current())return {kind:'ended'};
 }
 stage('target');
 let page:OwnedPageState|undefined;
 try{page=await awaitOwnedPage(o.action,o.profileKey,o.current,stage,o.clock);}catch(error){return o.current()?{kind:'failed',failure:'connect',error:startupError(error)}:{kind:'ended'};}
 if(!page||page.kind==='closed'||page.kind==='profile-changed')return {kind:'ended'};
 if(page.kind==='target-lost')return {kind:'failed',failure:'target-lost',error:new WorkroomBrowserError('target-lost','Native browser discovery failed.')};
 if(page.kind==='no-document')return {kind:'failed',failure:'no-document'};
 if(page.kind!=='ready')return {kind:'ended'};
 // A page already in this Workroom's tab set only navigated; a tab that is not in it yet connects to join it.
 if(!(typeof o.connect==='function'?o.connect(page.targetId):o.connect))return {kind:'ready'};
 stage('connecting');
 // An earlier generation's connect for this Workroom, and the detach of its late result, settle first. Otherwise the
 // host could hand this request that same binding just before the late detach removes it. Every tab of a Workroom
 // joins that one binding, so this stays per Workroom, not per tab.
 await settling.get(o.sessionId);
 if(!o.current())return {kind:'ended'};
 const attempt=(async():Promise<OwnedStartupResult>=>{
  let workspace:BrowserWorkspace|undefined;
  // The profile the page runs in goes with it: another tab of a Workroom restored from a saved task joins in that
  // task's profile even after the panel has forgotten the choice.
  try{workspace=(await o.request({operation:'connect-owned',sessionId:o.sessionId,targetId:o.targetId,port:page.port,pageId:page.targetId,...(o.recoveryId?{recoveryId:o.recoveryId}:{}),profileKey:o.profileKey})).workspace;}
  catch(error){return o.current()?{kind:'failed',failure:'connect',error:startupError(error)}:{kind:'ended'};}
  if(!workspace)return o.current()?{kind:'failed',failure:'connect',error:new WorkroomBrowserError('workspace-not-found','Browser workspace unavailable.')}:{kind:'ended'};
  const mine=workspace.sessionId===o.sessionId&&workspace.targetId===o.targetId,own=mine&&workspace.page?.id===page.targetId;
  // A late or foreign result is undone. A tab that joined this Workroom's binding next to its other tabs leaves only
  // its own page: detaching would take the sibling tabs with it.
  if(!own||!o.current()){
   const siblings=mine&&!!workspace.tabs?.some(t=>t.id!==page.targetId);
   const undo:WorkroomBrowserRequest|null=!siblings?{operation:'detach',workspaceId:workspace.id}:workspace.tabs!.some(t=>t.id===page.targetId)?{operation:'release',workspaceId:workspace.id,pageId:page.targetId}:null;
   if(undo)await o.request(undo).catch(()=>{});return o.current()?{kind:'failed',failure:'connect',error:new WorkroomBrowserError('workspace-changed','Browser session changed.')}:{kind:'ended'};}
  return {kind:'connected',workspace};
 })(),tracked=attempt.catch(()=>{});
 settling.set(o.sessionId,tracked);
 try{return await attempt;}finally{if(settling.get(o.sessionId)===tracked)settling.delete(o.sessionId);}
}
const settling=new Map<string,Promise<unknown>>();
/** One native view: a Workroom's first tab keeps the session's own key, another tab adds its name. Each tab's pending
 * connect is kept under this key, never shared with a sibling tab. */
export function ownedViewKey(sessionId:string,tab='main'){return tab==='main'?sessionId:`${sessionId}~${tab}`;}
/** Who a built-in page request belongs to: the native profile its page runs in and the saved task it reports to. */
export type OwnedRequestIntent={profileKey:string;recoveryId?:string};
/** A new request is for the chosen saved task. Without one it is this Workroom's own profile: the host labels a connect
 * without a saved task as that profile, so a saved task's page left open (detached, or after another Workroom was
 * shown) is never reused for it. Only a page this Workroom is still connected to keeps its profile, because then the
 * request just navigates that page and sends no connect. */
export function ownedRequestIntent({sessionId,recovery,workspace}:{sessionId:string;recovery:Pick<BrowserRecoverySummary,'id'|'profileId'|'source'>|null;workspace:Pick<BrowserWorkspace,'source'|'profileId'>|null}):OwnedRequestIntent{
 if(recovery?.source==='owned')return {profileKey:recovery.profileId.replace(/^owned:/,''),recoveryId:recovery.id};
 return {profileKey:workspace?.source==='owned'?workspace.profileId.replace(/^owned:/,''):sessionId};
}
/** Accepted requests whose connect has not finished, by native view (`ownedViewKey`: a Workroom session and its tab). Collapsing the browser unmounts its view and
 * ends that generation; reopening it finishes this connect without navigating again. Explicit close or a new request
 * replaces the entry. Like the panel's view cache, this is bounded and never a durable record. */
const accepted=new Map<string,OwnedRequestIntent>(),claims=new Map<string,number>();let lastClaim=0;
/** A new request claims its Workroom's pending connect before it navigates. Its navigation may be accepted after its
 * generation ended (collapsed mid-request); that acceptance is remembered only while the claim still stands. A close,
 * a changed choice or a newer request forgets it, so an older request's late acceptance never comes back. */
export function claimOwnedConnect(sessionId:string){forgetOwnedConnect(sessionId);claims.set(sessionId,++lastClaim);while(claims.size>8)claims.delete(claims.keys().next().value!);return lastClaim;}
export function rememberOwnedConnect(sessionId:string,intent:OwnedRequestIntent,claim:number){
 if(claims.get(sessionId)!==claim)return false;
 accepted.delete(sessionId);accepted.set(sessionId,intent);while(accepted.size>8)accepted.delete(accepted.keys().next().value!);return true;
}
export function pendingOwnedConnect(sessionId:string){return accepted.get(sessionId);}
export function forgetOwnedConnect(sessionId:string){accepted.delete(sessionId);claims.delete(sessionId);}
/** Every tab of one Workroom: a changed choice, another source or closing the whole browser forgets them all. */
export function forgetOwnedConnects(sessionId:string){for(const key of new Set([...accepted.keys(),...claims.keys()]))if(key===sessionId||key.startsWith(`${sessionId}~`))forgetOwnedConnect(key);}
