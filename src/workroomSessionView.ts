import {useEffect,useState} from 'react';
import {VOICE_AGENT_NAMES} from './voiceSessionProtocol';

/**
 * The phone's full-screen Workroom session view (2026-10-16, w7).
 *
 * On a phone the remote Workroom used to show the terminal as a card inside the page: the portal header, the Mac tabs,
 * the bottom tab bar and the voice dock left the terminal about a third of the screen. The Mac opens every Workroom in a
 * window of its own; the phone now does the same within the page — opening a session covers the whole screen, and
 * 「←」 (or the web portal's browser back — the iOS app's WKWebView has no back gesture) returns to the list. The panel
 * (`AiTerminalPanel`, `sessionFullscreen`) owns the view and its one history entry; the portal decides when the device is
 * a phone and keeps its own tab history from stacking on top of that entry (`withoutWorkroomSessionView`).
 */

/** A phone in either orientation, and touch tablets: the same media query the phone layout rules use (44px targets,
 *  16px inputs). A Mac — its app, its popout window, and a Mac driving another community device — never matches. */
export const WORKROOM_SESSION_FULLSCREEN_QUERY='(max-width: 640px), (pointer: coarse)';

/** The key the open session view adds to `history.state`. Its value is the panel instance's token. */
export const WORKROOM_SESSION_VIEW_STATE_KEY='workroomSessionView';

type HistoryState=Record<string,unknown>|null|undefined;
const record=(state:unknown):Record<string,unknown>=>state&&typeof state==='object'&&!Array.isArray(state)?state as Record<string,unknown>:{};

/** The tokens this load of the page gave its panels. An entry with any other token was left by an earlier load. */
const documentTokens=new Set<string>();

/** A panel instance's token for its view entries, remembered as this page's own. */
export function newWorkroomSessionViewToken():string{
 const token='wsv-'+(typeof crypto!=='undefined'&&typeof crypto.randomUUID==='function'?crypto.randomUUID():Math.random().toString(36).slice(2));
 documentTokens.add(token);
 return token;
}

/**
 * A view entry no panel of this page made: an earlier load left it — a reload with the view open, or iOS reloading a page
 * whose WebContent process it reclaimed. Its view is gone; the list it was opened from is the entry before it.
 */
export function isStaleWorkroomSessionViewState(state:unknown):boolean{
 const token=record(state)[WORKROOM_SESSION_VIEW_STATE_KEY];
 return typeof token==='string'&&!documentTokens.has(token);
}

/** Whether this history entry is a session view's entry (any panel's). */
export function isWorkroomSessionViewState(state:unknown):boolean{
 return typeof record(state)[WORKROOM_SESSION_VIEW_STATE_KEY]==='string';
}

/** Whether this history entry is the session view entry of this panel instance. */
export function isOwnWorkroomSessionViewState(state:unknown,token:string):boolean{
 return record(state)[WORKROOM_SESSION_VIEW_STATE_KEY]===token;
}

/** The entry the open view pushes: the page's state (its tab) plus this panel's token. */
export function withWorkroomSessionView(state:HistoryState|unknown,token:string):Record<string,unknown>{
 return {...record(state),[WORKROOM_SESSION_VIEW_STATE_KEY]:token};
}

/**
 * The 「새 작업」 sheet's entry (w11 review): like the view, the sheet is one full-screen layer, so the web portal's browser
 * back (an edge swipe in Safari) closes it instead of leaving 원격 작업. Its value is a token from the same registry, so an
 * entry an earlier load left is told apart the same way.
 */
export const WORKROOM_NEW_TASK_STATE_KEY='workroomNewTask';
export function isWorkroomNewTaskState(state:unknown):boolean{
 return typeof record(state)[WORKROOM_NEW_TASK_STATE_KEY]==='string';
}
export function isStaleWorkroomNewTaskState(state:unknown):boolean{
 const token=record(state)[WORKROOM_NEW_TASK_STATE_KEY];
 return typeof token==='string'&&!documentTokens.has(token);
}
export function withWorkroomNewTask(state:HistoryState|unknown,token:string):Record<string,unknown>{
 return {...record(state),[WORKROOM_NEW_TASK_STATE_KEY]:token};
}
export function withoutWorkroomNewTask(state:HistoryState|unknown):Record<string,unknown>{
 const {[WORKROOM_NEW_TASK_STATE_KEY]:_dropped,...rest}=record(state);
 return rest;
}

/**
 * The page's state without a session view entry (nor a 「새 작업」 sheet entry). The portal's tab navigation copies `history.state` into the entry it
 * pushes; copied as it was, a tab opened from the session view would carry the view's token, and the panel would read
 * that entry as its own and go back over the tab change.
 */
export function withoutWorkroomSessionView(state:HistoryState|unknown):Record<string,unknown>{
 const {[WORKROOM_SESSION_VIEW_STATE_KEY]:_dropped,[WORKROOM_NEW_TASK_STATE_KEY]:_sheet,...rest}=record(state);
 return rest;
}

/**
 * Escape from a hardware keyboard closes the view — but never while typing: the composer and the terminal send Escape to
 * the CLI (it stops a running turn), and a menu or a select handles its own Escape. Nor inside a dialog opened from the
 * view (「세션 종료」's): its Escape closes that dialog only (w7 review). `view` is the view itself, also a dialog.
 */
export function sessionViewEscapeCloses(event:{key:string;defaultPrevented:boolean;isComposing?:boolean},target:{closest?:(selector:string)=>unknown;tagName?:string}|null,view?:unknown):boolean{
 if(event.key!=='Escape'||event.defaultPrevented||event.isComposing)return false;
 if(!target)return true;
 const tag=(target.tagName??'').toUpperCase();
 if(tag==='TEXTAREA'||tag==='INPUT'||tag==='SELECT')return false;
 if(typeof target.closest!=='function')return true;
 if(target.closest('.xterm, [role="listbox"], [contenteditable="true"]'))return false;
 const dialog=target.closest('dialog, [role="dialog"], [role="alertdialog"]');
 return !dialog||dialog===view;
}

/**
 * Whether an on-screen keyboard takes part of the screen: the visual viewport, at its own zoom, is markedly shorter than
 * the layout viewport (iOS and Chrome on Android shrink only the visual one). A browser bar collapsing (~50–80px) or a
 * pinch zoom is not a keyboard.
 */
export function visualKeyboardOpen(layoutHeight:number,visualHeight:number,scale=1):boolean{
 if(!(layoutHeight>0)||!(visualHeight>0))return false;
 return layoutHeight-visualHeight*(scale>0?scale:1)>Math.max(120,layoutHeight*0.15);
}

/**
 * A voice call going on under the full-screen view (the voice dock is behind it, w7 review): who answers, or null. A voice
 * partner switch is one of the things that opens the view, so it opens over a live call.
 */
export function sessionViewVoiceCall(state:{phase:string;session?:{activeTarget?:{kind:string;label?:string;agent?:string}|null}|null}):{partner:string}|null{
 if(!['preparing','listening','review'].includes(state.phase))return null;
 const target=state.session?.activeTarget;
 if(!target||target.kind==='ops')return {partner:'총괄'};
 const agent=target.agent?VOICE_AGENT_NAMES[target.agent]??target.agent:'';
 return {partner:[target.label,agent].filter(Boolean).join(' · ')||'프로젝트 담당자'};
}

/** Whether this screen opens Workroom sessions full screen. Follows rotation and window resizes. */
export function useWorkroomSessionFullscreen():boolean{
 const query=()=>typeof window!=='undefined'&&typeof window.matchMedia==='function'?window.matchMedia(WORKROOM_SESSION_FULLSCREEN_QUERY):null;
 const [matches,setMatches]=useState(()=>!!query()?.matches);
 useEffect(()=>{
  const list=query();if(!list)return;
  const update=()=>setMatches(list.matches);update();
  if(typeof list.addEventListener==='function'){list.addEventListener('change',update);return()=>list.removeEventListener('change',update);}
  list.addListener?.(update);return()=>list.removeListener?.(update);
 },[]);
 return matches;
}

/**
 * Back where you were (w11, S4.2 + plan critique 17). The phone remembers the session it had open, per Mac (the panel's
 * `sessionScope` is the host id), so a reload — or iOS reloading a page whose WebContent process it reclaimed while the app
 * was in the background — reopens that session full screen when it is still running. localStorage with a TTL, not
 * sessionStorage: whether sessionStorage survives a reclaim reload is unverified. Closing the view forgets it.
 */
export const WORKROOM_OPEN_SESSION_TTL_MS=30*60_000;
type OpenSessionStorage={getItem(key:string):string|null;setItem(key:string,value:string):void;removeItem(key:string):void};
export const workroomOpenSessionKey=(scope:string)=>'agentstoz:workroom-open-session:v1:'+scope;
/** Writes (or refreshes) the record. Storage that refuses (blocked site data, quota) keeps nothing; it never throws. */
export function rememberOpenWorkroomSession(storage:OpenSessionStorage|null|undefined,scope:string,sessionId:string,now:number):void{
 if(!storage||!sessionId)return;
 try{storage.setItem(workroomOpenSessionKey(scope),JSON.stringify({id:sessionId,at:now}));}catch{/* nothing kept */}
}
export function forgetOpenWorkroomSession(storage:OpenSessionStorage|null|undefined,scope:string):void{
 if(!storage)return;
 try{storage.removeItem(workroomOpenSessionKey(scope));}catch{/* nothing to forget */}
}
/** The session to reopen, or null. A record past the TTL, from the future, or of another shape is removed. */
export function openWorkroomSessionToRestore(storage:OpenSessionStorage|null|undefined,scope:string,now:number):string|null{
 if(!storage)return null;
 let raw:string|null;try{raw=storage.getItem(workroomOpenSessionKey(scope));}catch{return null;}
 if(raw===null)return null;
 let value:unknown=null;try{value=JSON.parse(raw);}catch{/* corrupt */}
 const record=value&&typeof value==='object'&&!Array.isArray(value)?value as {id?:unknown;at?:unknown}:null;
 const id=typeof record?.id==='string'&&record.id?record.id:'';
 const at=typeof record?.at==='number'&&Number.isFinite(record.at)?record.at:NaN;
 // A minute of clock skew is tolerated; a record written later than that is not one this device wrote.
 if(!id||!(at<=now+60_000)||now-at>WORKROOM_OPEN_SESSION_TTL_MS){forgetOpenWorkroomSession(storage,scope);return null;}
 return id;
}
/**
 * While the view stays open its record is kept fresh (w11 review): the TTL counts from the last time the phone was watching
 * the session, not from when the view opened — a reload after watching a long run for more than 30 minutes in the
 * foreground (a Safari reload, WebKit reloading a page whose WebContent crashed) still reopens it. Called on each read of
 * the open session; writes at most once a minute. Returns whether it wrote.
 */
export const WORKROOM_OPEN_SESSION_REFRESH_MS=60_000;
export function refreshOpenWorkroomSession(storage:OpenSessionStorage|null|undefined,scope:string,sessionId:string,now:number):boolean{
 if(!storage||!sessionId)return false;
 let raw:string|null=null;try{raw=storage.getItem(workroomOpenSessionKey(scope));}catch{return false;}
 let value:unknown=null;try{value=raw===null?null:JSON.parse(raw);}catch{/* corrupt: rewritten below */}
 const record=value&&typeof value==='object'&&!Array.isArray(value)?value as {id?:unknown;at?:unknown}:null;
 const at=typeof record?.at==='number'&&Number.isFinite(record.at)?record.at:NaN;
 if(record?.id===sessionId&&at<=now&&now-at<WORKROOM_OPEN_SESSION_REFRESH_MS)return false;
 rememberOpenWorkroomSession(storage,scope,sessionId,now);return true;
}
/** This page's localStorage, or null where reading it throws (blocked site data). */
export function workroomOpenSessionStorage():OpenSessionStorage|null{
 try{return typeof window!=='undefined'?window.localStorage:null;}catch{return null;}
}
