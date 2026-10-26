import {invoke} from '@tauri-apps/api/core';
import type {NativeStatus} from './OwnedWorkroomBrowser';
import type {WorkroomBrowserPhase} from './WorkroomBrowserFrameToolbar';
import type {BrowserOwner} from './workroomBrowserProtocol';

/** Trusted native UI operations only; these are never browser agent operations. */
export type NativeNavOperation='back'|'forward'|'reload'|'stop';
export type NativeLoadError={code:number;text:string;url:string};
/** C2b additions to view_status. All are absent on the installed v1263 native. */
export type NativeNavFields={title?:string;canGoBack?:boolean;canGoForward?:boolean;progress?:number;loadError?:NativeLoadError|null;blockedInputs?:number;focused?:boolean;consoleErrors?:number};
export type NativeNavStatus=NativeStatus & NativeNavFields;
export type NativePageState={supported:boolean;canBack:boolean;canForward:boolean;loading:boolean;progress:number|null;title:string;url:string;loadError:NativeLoadError|null;blockedInputs:number;focused:boolean};

const record=(value:unknown):Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
const counter=(value:unknown):number|undefined=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0?value:undefined;
/** Wrong types have the same meaning as an omitted field; never coerce page-supplied values. */
function navFields(status:unknown):NativeNavFields{
 const s=record(status),error=record(s.loadError);
 return {
  title:typeof s.title==='string'?s.title.replace(/[\u0000-\u001f\u007f-\u009f]/g,'').slice(0,300):undefined,
  canGoBack:typeof s.canGoBack==='boolean'?s.canGoBack:undefined,
  canGoForward:typeof s.canGoForward==='boolean'?s.canGoForward:undefined,
  progress:typeof s.progress==='number'&&Number.isFinite(s.progress)&&s.progress>=0&&s.progress<=1?s.progress:undefined,
  loadError:s.loadError===null?null:typeof error.code==='number'&&Number.isSafeInteger(error.code)&&typeof error.text==='string'&&typeof error.url==='string'?{code:error.code,text:error.text,url:error.url}:undefined,
  blockedInputs:counter(s.blockedInputs),
  focused:typeof s.focused==='boolean'?s.focused:undefined,
  consoleErrors:counter(s.consoleErrors),
 };
}

/** Same command and per-tab binding as OwnedWorkroomBrowser's navigate, sent exactly once.
 * The caller checks canRunNav (or canStopNav for Stop) immediately before sending; native also enforces ownership.
 * A rejection or unknown outcome propagates unchanged and is never retried here. */
export async function nativeNav(sessionId:string,tab:string,op:NativeNavOperation):Promise<NativeNavStatus>{
 if(!['back','forward','reload','stop'].includes(op))throw new TypeError('Unsupported native navigation operation.');
 const status=await invoke<NativeNavStatus>('workroom_browser_native',{sessionId,operation:op,tab});
 return {...status,...navFields(status)};
}

/** Feature-detect history booleans, including false/false on a new tab. Loading alone predates C2b.
 * consoleErrors stays optional status metadata; it is not part of the page-state projection. */
export function pageStateFrom(status:unknown):NativePageState{
 const s=record(status),nav=navFields(s);
 return {
  supported:nav.canGoBack!==undefined&&nav.canGoForward!==undefined,
  canBack:nav.canGoBack??false,canForward:nav.canGoForward??false,
  loading:s.loading===true,progress:nav.progress??null,
  title:nav.title??'',url:typeof s.url==='string'?s.url:'',loadError:nav.loadError??null,
  blockedInputs:nav.blockedInputs??0,focused:nav.focused??false,
 };
}

/** An unset phase means null/undefined, never an unrecognised or merely falsy phase. */
export function canRunNav(owner:BrowserOwner|null|undefined,phase?:WorkroomBrowserPhase):boolean{
 return owner==='human'&&(phase===null||phase===undefined);
}
/** The native navigation was accepted, but no broker connection is being admitted. A new human address or Stop
 * may end this tab's waiting generation; profile/renderer admission, connecting and closing stay serialized. */
export function canReplaceLoadingRequest(owner:BrowserOwner|null|undefined,phase?:WorkroomBrowserPhase):boolean{
 return owner==='human'&&(phase==='target'||phase==='loading');
}
export function canStopNav(owner:BrowserOwner|null|undefined,phase?:WorkroomBrowserPhase):boolean{
 return canRunNav(owner,phase)||canReplaceLoadingRequest(owner,phase);
}
