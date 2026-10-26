import {useEffect,useMemo,useRef,useState,type KeyboardEvent as ReactKeyboardEvent,type Ref} from 'react';
import {ArrowLeft,ArrowRight,Check,Copy,CornerDownLeft,Ellipsis,ExternalLink,Globe,Lock,Power,RotateCw,Search,ShieldAlert,Unplug,X} from 'lucide-react';
import type {Lang} from './i18n';
import type {BrowserWorkspace} from './workroomBrowserProtocol';
import type {OwnedBrowserStage} from './workroomBrowserNavigation';
import {workroomBrowserCopy} from './workroomBrowserCopy';
import {workroomBrowserStageCopy} from './workroomBrowserStageCopy';
import {workroomBrowserUiCopy} from './workroomBrowserUiCopy';
import {OMNIBOX_MAX_LENGTH,omniboxDirty,omniboxDisplay,omniboxIntent,omniboxRevert,type OmniboxIdentity} from './workroomBrowserOmnibox';
import './WorkroomBrowserFrameBar.css';
/** The built-in browser's request stage, or an explicit close; null when no request runs. */
export type WorkroomBrowserPhase=OwnedBrowserStage|'closing'|null;
/** Back, forward, reload and stop of the tab on screen (C2a `pageStateFrom` and `canRunNav`). Rendered only when supported. */
export type WorkroomBrowserToolbarNav={supported:boolean;canBack:boolean;canForward:boolean;loading:boolean;disabled?:boolean;stopDisabled?:boolean;onBack:()=>void;onForward:()=>void;onReload:()=>void;onStop:()=>void};
/** The 2px progress edge: `value` 0–1 when native reports it, null for the indeterminate sweep. */
export type WorkroomBrowserToolbarProgress={active:boolean;value:number|null};
/** Who drives the page, as the pill at the bar's right end names it. `pending` pulses the dot (observing, taking);
 *  `tone` overrides the owner colour for a person-needed state (warn: waiting, popup) or a lost connection (danger). */
export type WorkroomBrowserOwnerPill={owner:BrowserWorkspace['owner'];label:string;title?:string;pending?:boolean;tone?:'warn'|'danger'};
/** The overflow menu's verbs. Each item shows only when its handler is given; closing every tab asks first. */
export type WorkroomBrowserToolbarMenu={onCopyAddress?:()=>void;onOpenExternally?:()=>void;onDetach?:()=>void;onCloseBrowser?:()=>void;tabCount?:number;
 /** A connected frame can put the close-all question in its control bar. Without it the toolbar asks inline. */
 onRequestCloseBrowser?:()=>void;
 /** Explicit action locks, including external disablement. Close can cancel a page load/connect; it cannot cancel
  *  profile admission, another close, or AI ownership. */
 detachDisabled?:boolean;closeDisabled?:boolean};
export type WorkroomBrowserToolbarProps={
 /** What the address field shows. */
 url:string;
 onUrlChange:(url:string)=>void;
 /** Enter, or the open button: open the address in the tab on screen. */
 onSubmit:(value:string)=>void;
 /** A request is in flight. Controls stay locked unless canReplaceLoad explicitly permits a new human address. */
 disabled:boolean;
 /** A human may replace or stop an accepted navigation while it waits for its target/document. */
 canReplaceLoad?:boolean;
 /** Someone other than the person holds the page: the field is read-only (still focusable, selectable and copyable). */
 readOnly:boolean;
 phase:WorkroomBrowserPhase;
 /** The address of the page on screen (native status url), '' or null before the first page. It decides whether the
  *  typed text is dirty, what Escape restores and what 「페이지 주소 복사」 copies. Undefined (no page known): any
  *  typed text counts as dirty and Escape restores what the field held when it was focused. */
 pageUrl?:string|null;
 nav?:WorkroomBrowserToolbarNav;
 /** Without it, a request stage (`phase`) shows the indeterminate sweep. */
 progress?:WorkroomBrowserToolbarProgress;
 ownerPill?:WorkroomBrowserOwnerPill;
 menu?:WorkroomBrowserToolbarMenu;
 inputRef?:Ref<HTMLInputElement>;
 lang:Lang;
 /** Opening also waits for this (the native layer has not answered whether it is available yet). */
 openDisabled?:boolean;
 /** 「브라우저 종료」, offered in the menu once a page is open. `menu.onCloseBrowser` takes its place when given. */
 closeBrowser?:{disabled:boolean;onClose:()=>void};
};
/** A page request may be ended by closing its generation. The omnibox's in-flight lock must not disable that exit.
 *  Callers use closeDisabled for an external close lock during a cancellable phase; disabled alone still locks an
 *  idle toolbar. OwnedWorkroomBrowser passes disabled=!!phase while reporting its explicit close lock separately. */
export function browserCloseDisabled({disabled,readOnly,phase,closeDisabled=false}:Pick<WorkroomBrowserToolbarProps,'disabled'|'readOnly'|'phase'>&{closeDisabled?:boolean}){
 const cancellable=phase==='navigating'||phase==='target'||phase==='loading'||phase==='connecting';
 return closeDisabled||readOnly||phase==='profile'||phase==='closing'||disabled&&!cancellable;
}
/** Escape stays local. During IME composition its default action belongs to the IME, so preserve the edit and focus.
 *  The omnibox's local-escape marker also keeps a native dialog cancel from closing the Workroom. */
export function handleBrowserAddressKey(event:Pick<ReactKeyboardEvent<HTMLInputElement>,'key'|'nativeEvent'|'preventDefault'|'stopPropagation'|'currentTarget'>&{keyCode?:number},revert:()=>void,composing=false){
 if(event.key==='Enter'&&(composing||event.nativeEvent.isComposing||event.keyCode===229)){event.preventDefault();event.stopPropagation();return;}
 if(event.key!=='Escape')return;
 event.stopPropagation();
 if(composing||event.nativeEvent.isComposing||event.keyCode===229)return;
 event.preventDefault();revert();event.currentTarget.blur();
}
const glyphs:Record<OmniboxIdentity,typeof Lock>={https:Lock,local:Globe,http:ShieldAlert,search:Search};
/** The page address with the blank page treated as none. */
const pageOf=(url:string|null|undefined)=>url&&url!=='about:blank'?url:'';
/** Copy text without a clipboard permission: the async API first, then the selection-based fallback. */
async function copyText(text:string){
 try{await navigator.clipboard.writeText(text);return true;}catch{/* Not granted here: fall back to a selection. */}
 const active=document.activeElement instanceof HTMLElement?document.activeElement:null;
 const area=document.createElement('textarea');area.value=text;area.setAttribute('readonly','');area.style.position='fixed';area.style.opacity='0';document.body.append(area);area.select();
 try{return document.execCommand('copy');}catch{return false;}finally{area.remove();active?.focus({preventScroll:true});}
}
function assignRef<T>(ref:Ref<T>|undefined,value:T|null){if(typeof ref==='function')ref(value);else if(ref)(ref as {current:T|null}).current=value;}
/** The browser bar: navigation, a host-first omnibox, who drives the page, an overflow menu and a 2px progress edge. */
export function WorkroomBrowserFrameToolbar({url,onUrlChange,onSubmit,disabled,canReplaceLoad=false,readOnly,phase,pageUrl,nav,progress,ownerPill,menu,inputRef,lang,openDisabled=false,closeBrowser}:WorkroomBrowserToolbarProps){
 const m=workroomBrowserCopy(lang),stage=workroomBrowserStageCopy(lang),ui=workroomBrowserUiCopy(lang),bar=ui.toolbar;
 const input=useRef<HTMLInputElement|null>(null),menuButton=useRef<HTMLButtonElement>(null),menuList=useRef<HTMLDivElement>(null),cancelButton=useRef<HTMLButtonElement>(null);
 const [focused,setFocused]=useState(false),[menuOpen,setMenuOpen]=useState(false),[confirming,setConfirming]=useState(false),[copied,setCopied]=useState(false);
 // What Escape restores when no page address is given: the field's value when the person entered it.
 const entered=useRef(url),selectOnUp=useRef(false),composing=useRef(false);
 const known=pageUrl!==undefined,page=pageOf(pageUrl);
 const typed=url.trim(),dirty=omniboxDirty(url,known?page:null),intent=useMemo(()=>omniboxIntent(url),[url]);
 const replaceable=canReplaceLoad&&!readOnly&&(phase==='target'||phase==='loading');
 const locked=readOnly||((disabled||!!phase)&&!replaceable);
 const navigationLocked=readOnly||disabled||!!phase||!!nav?.disabled;
 const stopLocked=readOnly||!!nav?.stopDisabled||(navigationLocked&&!replaceable);
 // The glyph says what Enter would do while the text is being edited, and what the page is otherwise.
 const editing=focused||(dirty&&!!typed);
 const shown=omniboxDisplay(url),identity:OmniboxIdentity=editing?(intent.kind==='navigate'?intent.display.identity:intent.kind==='empty'&&page?omniboxDisplay(page).identity:'search'):(typed?shown.identity:'search');
 const identityTitle=editing&&intent.kind!=='navigate'?bar.identitySearch:bar[(editing&&intent.kind==='navigate'?intent.display:shown).identityTitleKey];
 const Glyph=glyphs[identity];
 // Blurred, an address reads host first: the host strong, the path and query dimmed, the scheme hidden.
 const split=!focused&&shown.kind!=='search'&&!!typed;
 const showOpen=dirty&&!!typed&&!readOnly,searchHint=intent.kind==='search'&&(focused||dirty);
 // The edge sweeps through a request's stages unless native progress is given.
 const edge=progress??{active:!!phase&&phase!=='closing',value:null};
 const progressValue=typeof edge.value==='number'&&Number.isFinite(edge.value)?Math.max(0,Math.min(1,edge.value)):null;
 const determinate=edge.active&&progressValue!==null;
 const close=menu?.onCloseBrowser?{disabled:!!menu.closeDisabled,onClose:menu.onCloseBrowser}:closeBrowser;
 const closeLocked=browserCloseDisabled({disabled,readOnly,phase,closeDisabled:!!close?.disabled});
 const copyable=!!menu?.onCopyAddress||!!page;
 const items={copy:copyable,external:!!menu?.onOpenExternally,detach:!!menu?.onDetach,close:!!close};
 const hasMenu=items.copy||items.external||items.detach||items.close;
 // Without the tab count (today's call site) the question names no number rather than a wrong one.
 const question=menu?.tabCount?bar.closeAllConfirm.replace('{n}',String(menu.tabCount)):`${stage.closeBrowser}?`;
 useEffect(()=>{if(!close)setConfirming(false);},[!!close]);
 useEffect(()=>{if(!copied)return;const timer=setTimeout(()=>setCopied(false),2000);return()=>clearTimeout(timer);},[copied]);
 useEffect(()=>{if(confirming)cancelButton.current?.focus();},[confirming]);
 // The menu closes on any press outside it; it is short-lived because the native page hides while it is open.
 useEffect(()=>{
  if(!menuOpen)return;
  menuList.current?.querySelector<HTMLButtonElement>('[role=menuitem]:not(:disabled)')?.focus();
  const outside=(event:PointerEvent)=>{const target=event.target as Node;if(!menuList.current?.contains(target)&&!menuButton.current?.contains(target))setMenuOpen(false);};
  document.addEventListener('pointerdown',outside,true);return()=>document.removeEventListener('pointerdown',outside,true);
 },[menuOpen]);
 const revert=()=>{const value=known?omniboxRevert(page):entered.current;if(value!==url)onUrlChange(value);};
 const onFieldKey=(event:ReactKeyboardEvent<HTMLInputElement>)=>handleBrowserAddressKey(event,revert,composing.current);
 const closeMenu=(refocus:boolean)=>{setMenuOpen(false);if(refocus)menuButton.current?.focus();};
 const onMenuKey=(event:ReactKeyboardEvent<HTMLDivElement>)=>{
  const list=[...(menuList.current?.querySelectorAll<HTMLButtonElement>('[role=menuitem]:not(:disabled)')??[])],at=list.indexOf(document.activeElement as HTMLButtonElement);
  const move=(to:number)=>{event.preventDefault();list[(to+list.length)%list.length]?.focus();};
  if(event.key==='ArrowDown')move(at+1);else if(event.key==='ArrowUp')move(at<0?list.length-1:at-1);else if(event.key==='Home')move(0);else if(event.key==='End')move(list.length-1);
  else if(event.key==='Escape'){event.preventDefault();event.stopPropagation();closeMenu(true);}else if(event.key==='Tab')setMenuOpen(false);
 };
 const copyAddress=async()=>{closeMenu(true);if(menu?.onCopyAddress){menu.onCopyAddress();return;}if(page&&await copyText(page))setCopied(true);};
 const choose=(run:()=>void)=>{closeMenu(true);run();};
 const confirmClose=()=>{setConfirming(false);close?.onClose();};
 return <div className="wb-bar" data-testid="workroom-browser-bar">
  {nav?.supported&&!confirming&&<div className="wb-nav" role="group" aria-label={m.title}>
   <button type="button" className="wb-icon-btn" data-testid="workroom-browser-back" aria-label={bar.backLabel} title={bar.back} disabled={navigationLocked||!nav.canBack} onClick={()=>nav.onBack()}><ArrowLeft size={16} strokeWidth={1.75} aria-hidden/></button>
   <button type="button" className="wb-icon-btn wb-nav-forward" data-testid="workroom-browser-forward" aria-label={bar.forwardLabel} title={bar.forward} disabled={navigationLocked||!nav.canForward} onClick={()=>nav.onForward()}><ArrowRight size={16} strokeWidth={1.75} aria-hidden/></button>
   {nav.loading
    ?<button type="button" className="wb-icon-btn" data-testid="workroom-browser-stop" aria-label={bar.stop} title={bar.stop} disabled={stopLocked} onClick={()=>nav.onStop()}><X size={16} strokeWidth={1.75} aria-hidden/></button>
    :<button type="button" className="wb-icon-btn" data-testid="workroom-browser-reload" aria-label={bar.reloadLabel} title={bar.reload} disabled={navigationLocked} onClick={()=>nav.onReload()}><RotateCw size={16} strokeWidth={1.75} aria-hidden/></button>}
  </div>}
  {confirming&&close
   ?<div className="wb-confirm" role="group" aria-label={stage.closeBrowser} data-testid="workroom-browser-close-confirm-row" data-workroom-local-escape="" onKeyDown={event=>{if(event.key!=='Escape')return;event.preventDefault();event.stopPropagation();setConfirming(false);menuButton.current?.focus();}}>
    <span className="wb-confirm-text">{question}</span>
    <button type="button" ref={cancelButton} className="wb-text-btn" data-testid="workroom-browser-close-cancel" onClick={()=>{setConfirming(false);menuButton.current?.focus();}}>{bar.cancel}</button>
    <button type="button" className="wb-text-btn wb-text-btn--danger" data-testid="workroom-browser-close-confirm" disabled={closeLocked} onClick={confirmClose}>{bar.closeAll}</button>
   </div>
   :<form className="wb-omnibox" data-testid="workroom-browser-omnibox" data-identity={identity} data-dirty={dirty?'':undefined} data-readonly={locked?'':undefined} data-workroom-local-escape="" onSubmit={event=>{event.preventDefault();if(locked||openDisabled||composing.current)return;onSubmit(input.current?.value??url);input.current?.blur();}}>
    <span className="wb-omnibox-glyph" data-identity={identity} title={identityTitle}><Glyph size={16} strokeWidth={1.75} aria-hidden/></span>
    <span className="wb-omnibox-text">
     <input ref={node=>{input.current=node;assignRef(inputRef,node);}} className="wb-omnibox-input" data-split={split?'':undefined} aria-label={m.url} data-testid="owned-browser-address" placeholder={bar.addressPlaceholder} title={readOnly?bar.readOnlyTip:locked?ui.owner.disabledBusy:undefined}
      value={url} onChange={event=>onUrlChange(event.target.value)} readOnly={locked} aria-readonly={locked||undefined} maxLength={OMNIBOX_MAX_LENGTH} spellCheck={false} autoCapitalize="off" autoCorrect="off" autoComplete="off"
      onCompositionStart={()=>{composing.current=true;}} onCompositionEnd={()=>{composing.current=false;}}
      onKeyDown={onFieldKey} onMouseDown={event=>{selectOnUp.current=document.activeElement!==event.currentTarget;}} onMouseUp={event=>{if(selectOnUp.current)event.preventDefault();selectOnUp.current=false;}}
      onFocus={event=>{entered.current=url;setFocused(true);event.currentTarget.select();}} onBlur={()=>setFocused(false)}/>
     {split&&<span className="wb-omnibox-display" aria-hidden="true"><span className="wb-omnibox-host">{shown.host}</span>{shown.rest&&<span className="wb-omnibox-rest">{shown.rest}</span>}</span>}
    </span>
    {searchHint&&<span className="wb-omnibox-hint" data-testid="workroom-browser-search-hint">{bar.searchHint}</span>}
    {showOpen&&<button type="submit" className="wb-omnibox-go" data-testid="owned-browser-open" aria-label={bar.go} title={bar.go} disabled={locked||openDisabled}><CornerDownLeft size={14} strokeWidth={1.75} aria-hidden/></button>}
   </form>}
  {ownerPill&&<span className="wb-pill" data-testid="workroom-browser-owner-pill" data-owner={ownerPill.owner} data-tone={ownerPill.tone} data-pending={ownerPill.pending?'':undefined} title={ownerPill.title??ownerPill.label}><span className="wb-pill-dot" aria-hidden/><span className="wb-pill-label">{ownerPill.label}</span></span>}
  {copied&&<span className="wb-sr-only" role="status" data-testid="workroom-browser-copied">{bar.copied}</span>}
  {hasMenu&&<div className="wb-menu-anchor">
   <button type="button" ref={menuButton} className="wb-icon-btn" data-testid="workroom-browser-menu" aria-label={bar.more} title={copied?bar.copied:bar.more} aria-haspopup="menu" aria-expanded={menuOpen} onClick={()=>setMenuOpen(open=>!open)}>{copied?<Check size={16} strokeWidth={1.75} aria-hidden/>:<Ellipsis size={16} strokeWidth={1.75} aria-hidden/>}</button>
   {menuOpen&&<div className="wb-menu" role="menu" ref={menuList} aria-label={bar.more} data-workroom-local-escape="" onKeyDown={onMenuKey}>
    {items.copy&&<button type="button" role="menuitem" className="wb-menu-item" data-testid="workroom-browser-copy-url" onClick={()=>void copyAddress()}><Copy size={16} strokeWidth={1.75} aria-hidden/>{bar.copyUrl}</button>}
    {items.external&&<button type="button" role="menuitem" className="wb-menu-item" data-testid="workroom-browser-open-external" onClick={()=>choose(menu!.onOpenExternally!)}><ExternalLink size={16} strokeWidth={1.75} aria-hidden/>{bar.openExternal}</button>}
    {(items.copy||items.external)&&(items.detach||items.close)&&<div className="wb-menu-separator" role="separator"/>}
    {items.detach&&<button type="button" role="menuitem" className="wb-menu-item wb-menu-item--danger" data-testid="workroom-browser-menu-detach" disabled={menu!.detachDisabled} onClick={()=>choose(menu!.onDetach!)}><Unplug size={16} strokeWidth={1.75} aria-hidden/>{m.detach}</button>}
    {items.close&&<button type="button" role="menuitem" className="wb-menu-item wb-menu-item--danger" data-testid="owned-browser-close" disabled={closeLocked} onClick={()=>{setMenuOpen(false);if(menu?.onRequestCloseBrowser)menu.onRequestCloseBrowser();else setConfirming(true);}}><Power size={16} strokeWidth={1.75} aria-hidden/>{stage.closeBrowser}</button>}
   </div>}
  </div>}
  <div className="wb-progress" data-active={edge.active?'':undefined} data-determinate={determinate?'':undefined} aria-hidden={!edge.active||undefined}
   {...edge.active?{role:'progressbar','aria-label':ui.owner.stageLoading,...determinate?{'aria-valuemin':0,'aria-valuemax':100,'aria-valuenow':Math.round(progressValue!*100)}:{}}:{}}>
   <span className="wb-progress-fill" style={determinate?{transform:`scaleX(${progressValue})`}:undefined}/>
  </div>
 </div>;
}
