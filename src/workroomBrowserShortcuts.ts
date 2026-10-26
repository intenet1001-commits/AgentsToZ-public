import type {BrowserOwner} from './workroomBrowserProtocol';
import {BROWSER_TAB_LIMIT} from './workroomBrowserProtocol';

/**
 * The keyboard map of the Workroom browser (K3, 명세 「Keyboard and focus」). Pure: one event plus what is on screen in,
 * one decision out. No DOM, no React and no side effect — the panel runs the action and the unit tests fix the map.
 *
 * Two hard rules:
 * - **Keys that belong to macOS and to this app are never taken.** ⌘W is the default menu's Close Window equivalent and
 *   fires before any page sees it, ⌘Q/⌘H/⌘M are the system's, ⌘F is the app's find (App.tsx) and ⌘⇧V is VOC
 *   (src/vocShortcut.ts). Those come back as `ignore`, with no preventDefault, so the owner of the key still gets it.
 * - **Navigation and tabs need the person to own the page.** Only ⌘L works for every owner, because reading and copying
 *   the address is not driving the page.
 *
 * A key we do recognize is always consumed (`preventDefault`), even when it is blocked: in a Tauri window a stray ⌘R
 * would reload the whole app UI, and a blocked shortcut must not become that.
 */
export type BrowserShortcutAction=
  |{kind:'focus-omnibox'}
  |{kind:'reload'}
  |{kind:'back'}
  |{kind:'forward'}
  |{kind:'new-tab'}
  |{kind:'select-tab';index:number};

/** Why a recognized shortcut did nothing. */
export type BrowserShortcutBlock='owner'|'nav-unsupported'|'no-history'|'tab-limit'|'no-such-tab'|'no-page';
export type BrowserShortcutDecision=
  |{outcome:'run';action:BrowserShortcutAction;preventDefault:true}
  |{outcome:'blocked';action:BrowserShortcutAction;reason:BrowserShortcutBlock;preventDefault:true}
  |{outcome:'ignore';reason:'not-a-shortcut'|'reserved'};

/** The modifier-bearing fields this module reads; a real KeyboardEvent satisfies it. */
export interface BrowserKeyEvent {
  key:string;
  metaKey:boolean;
  ctrlKey?:boolean;
  shiftKey?:boolean;
  altKey?:boolean;
}

export interface BrowserShortcutContext {
  owner:BrowserOwner;
  connection?:'connected'|'disconnected';
  /** Focus is in a text field or a contenteditable element (the omnibox, the composer). */
  editing?:boolean;
  /** Native reports back/forward support (`pageStateFrom(status).supported`); without it there is no group to drive. */
  navSupported?:boolean;
  canGoBack?:boolean;
  canGoForward?:boolean;
  /** How many tabs this Workroom has attached. */
  tabCount?:number;
  hasPage?:boolean;
}

/** ⌘ chords this module must never return. The system or another part of the app owns each one. */
export const BROWSER_RESERVED_SHORTCUTS=[
  {key:'w',shift:false,reason:'macOS Close Window (no custom Tauri menu)'},
  {key:'q',shift:false,reason:'macOS Quit'},
  {key:'h',shift:false,reason:'macOS Hide'},
  {key:'m',shift:false,reason:'macOS Minimize'},
  {key:'f',shift:false,reason:'app find (App.tsx)'},
  {key:'v',shift:true,reason:'VOC (src/vocShortcut.ts)'},
] as const;

const metaOnly=(event:BrowserKeyEvent)=>event.metaKey&&!event.ctrlKey&&!event.altKey;

/** True for a chord this module leaves to its owner, so a caller can assert it is never swallowed. */
export function isReservedBrowserShortcut(event:BrowserKeyEvent):boolean{
  if(!metaOnly(event))return false;
  const key=event.key.toLowerCase();
  return BROWSER_RESERVED_SHORTCUTS.some(reserved=>reserved.key===key&&reserved.shift===!!event.shiftKey);
}

/**
 * The map. `⌘L` focuses and selects the address for any owner; `⌘R`, `⌘[`, `⌘]`, `⌘T` and `⌘1`–`⌘6` need a connected
 * person. A ⌘ chord is not text, so typing does not disable any of them — only a plain key is ignored outright.
 */
export function browserShortcut(event:BrowserKeyEvent,context:BrowserShortcutContext):BrowserShortcutDecision{
  if(!metaOnly(event))return {outcome:'ignore',reason:'not-a-shortcut'};
  if(isReservedBrowserShortcut(event))return {outcome:'ignore',reason:'reserved'};
  if(event.shiftKey)return {outcome:'ignore',reason:'not-a-shortcut'};
  const key=event.key.toLowerCase();
  const action=actionFor(key);
  if(!action)return {outcome:'ignore',reason:'not-a-shortcut'};
  const human=context.owner==='human'&&(context.connection??'connected')==='connected';
  // Reading the address is not driving the page: ⌘L belongs to the person at every moment.
  if(action.kind==='focus-omnibox')return {outcome:'run',action,preventDefault:true};
  const blocked=(reason:BrowserShortcutBlock):BrowserShortcutDecision=>({outcome:'blocked',action,reason,preventDefault:true});
  if(!human)return blocked('owner');
  const tabs=context.tabCount??0;
  switch(action.kind){
    case 'reload':return (context.hasPage??true)?{outcome:'run',action,preventDefault:true}:blocked('no-page');
    case 'back':case 'forward':
      if(!(context.navSupported??true))return blocked('nav-unsupported');
      if(action.kind==='back'?context.canGoBack===false:context.canGoForward===false)return blocked('no-history');
      return {outcome:'run',action,preventDefault:true};
    case 'new-tab':return tabs>=BROWSER_TAB_LIMIT?blocked('tab-limit'):{outcome:'run',action,preventDefault:true};
    case 'select-tab':return action.index<tabs?{outcome:'run',action,preventDefault:true}:blocked('no-such-tab');
  }
}

const actionFor=(key:string):BrowserShortcutAction|null=>{
  if(key==='l')return {kind:'focus-omnibox'};
  if(key==='r')return {kind:'reload'};
  if(key==='[')return {kind:'back'};
  if(key===']')return {kind:'forward'};
  if(key==='t')return {kind:'new-tab'};
  if(/^[1-6]$/.test(key))return {kind:'select-tab',index:Number(key)-1};
  return null;
};

/** The keycap a tooltip shows for a tab (명세: 「tabs.jumpTip `탭 전환 ({key})`」). */
export function browserTabShortcutKey(index:number):string|null{
  return index>=0&&index<BROWSER_TAB_LIMIT?`⌘${index+1}`:null;
}
