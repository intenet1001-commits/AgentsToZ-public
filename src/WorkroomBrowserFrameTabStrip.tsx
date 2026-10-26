import {useEffect,useImperativeHandle,useLayoutEffect,useRef,useState,type KeyboardEvent as ReactKeyboardEvent,type Ref} from 'react';
import {Globe,LoaderCircle,Plus,X} from 'lucide-react';
import type {Lang} from './i18n';
import {BROWSER_TAB_LIMIT} from './workroomBrowserProtocol';
import {workroomBrowserTabsCopy} from './workroomBrowserTabsCopy';
import {workroomBrowserUiCopy} from './workroomBrowserUiCopy';
import {browserTabShortcutKey} from './workroomBrowserShortcuts';
import './WorkroomBrowserFrameBar.css';
/** One tab of this Workroom's browser, oldest first. */
export type WorkroomBrowserTab={
 /** The native tab name (built-in) or page id (My Chrome). Rendered as `data-tab`. */
 key:string;
 /** What the tab is called: the page title, else its host, else 「새 탭」. */
 title:string;
 host:string;
 /** The page address, shown in the tab's tooltip. */
 url?:string|null;
 /** The tab's page is loading (native tabs[].loading): a spinner replaces the monogram. */
 loading?:boolean;
 /** The AI works in this tab while it holds the page: a violet dot on the monogram. */
 aiActive?:boolean;
};
/** What the panel can ask of the strip: focus for entering the browser view, and the tab ⌘1–⌘6 names. */
export type WorkroomBrowserTabStripHandle={focusActive:()=>void;focusTab:(index:number)=>void};
export type WorkroomBrowserTabStripProps={
 tabs:WorkroomBrowserTab[];
 activeKey:string;
 onSelect:(key:string)=>void;
 /** Close (built-in) or remove from the task (My Chrome). A built-in tab is offered it while more than one tab is left. */
 onClose?:(key:string)=>void;
 /** The new-tab button (built-in), or the tab picker (My Chrome). */
 onAdd?:()=>void;
 /** Why the tabs cannot be chosen now (shown as the tooltip). */
 disabledReason?:string;
 /** Why no tab can be added now (shown as the Plus button's tooltip). */
 addDisabledReason?:string;
 source:'owned'|'chrome';
 lang:Lang;
 /** Tabs and their close buttons cannot be used now (a request runs, or the AI holds the page). */
 disabled?:boolean;
 addDisabled?:boolean;
 /** The page stage's id, for `aria-controls`. */
 controlsId?:string;
 handle?:Ref<WorkroomBrowserTabStripHandle>;
};
/** The first letter of the site, without a leading `www.`; none for a tab with no page yet. */
const monogram=(host:string)=>[...host.replace(/^www\./i,'')][0]?.toUpperCase()??'';
/** This Workroom's own tabs, one attached row above the browser bar. While the AI holds the browser it chooses among them
 *  and the person sees the one it uses; the row never wraps — past six narrow tabs it scrolls sideways. */
export function WorkroomBrowserFrameTabStrip({tabs,activeKey,onSelect,onClose,onAdd,disabledReason,addDisabledReason,source,lang,disabled=false,addDisabled=false,controlsId,handle}:WorkroomBrowserTabStripProps){
 const t=workroomBrowserTabsCopy(lang),ui=workroomBrowserUiCopy(lang).tabs,chrome=source==='chrome';
 const scroller=useRef<HTMLDivElement>(null),[fade,setFade]=useState(''),[focusedKey,setFocusedKey]=useState(activeKey);
 const buttons=()=>[...(scroller.current?.querySelectorAll<HTMLButtonElement>('[role=tab]')??[])];
 useImperativeHandle(handle,()=>({
  focusActive:()=>(buttons().find(b=>b.getAttribute('aria-selected')==='true')??buttons()[0])?.focus(),
  focusTab:index=>buttons()[index]?.focus(),
 }),[]);
 // The tab on screen is always in view, also after the strip narrows (browser view back to split). Only the strip
 // scrolls: scrollIntoView could move the panel, and the native page with it. Edges with tabs beyond them then fade.
 const fadeOf=(node:HTMLElement)=>[node.scrollLeft>1&&'start',node.scrollLeft+node.clientWidth<node.scrollWidth-1&&'end'].filter(Boolean).join(' ');
 const reveal=useRef(()=>{});
 reveal.current=()=>{
  const node=scroller.current,tab=node?.querySelector<HTMLElement>('[data-active]');if(!node)return;
  if(tab){const right=tab.offsetLeft+tab.offsetWidth;
   if(tab.offsetLeft<node.scrollLeft)node.scrollLeft=tab.offsetLeft;else if(right>node.scrollLeft+node.clientWidth)node.scrollLeft=right-node.clientWidth;}
  setFade(fadeOf(node));
 };
 useEffect(()=>{
  const node=scroller.current;if(!node)return;
  const scrolled=()=>setFade(fadeOf(node)),observer=new ResizeObserver(()=>reveal.current());
  observer.observe(node);node.addEventListener('scroll',scrolled,{passive:true});
  return()=>{observer.disconnect();node.removeEventListener('scroll',scrolled);};
 },[]);
 useLayoutEffect(()=>reveal.current(),[activeKey,tabs.length]);
 useEffect(()=>setFocusedKey(activeKey),[activeKey]);
 const closable=()=>!!onClose&&!disabled&&(chrome||tabs.length>1);
 const full=tabs.length>=BROWSER_TAB_LIMIT;
 const onKey=(event:ReactKeyboardEvent<HTMLButtonElement>,index:number,tab:WorkroomBrowserTab)=>{
  const list=buttons(),go=(to:number)=>{event.preventDefault();list[(to+list.length)%list.length]?.focus();};
  if(event.key==='ArrowRight')go(index+1);else if(event.key==='ArrowLeft')go(index-1);else if(event.key==='Home')go(0);else if(event.key==='End')go(list.length-1);
  else if((event.key==='Delete'||event.key==='Backspace')&&closable()){event.preventDefault();list[index+1===list.length?index-1:index+1]?.focus();onClose!(tab.key);}
 };
 const held=disabled?(disabledReason??ui.heldTip):undefined;
 const focusKey=tabs.some(tab=>tab.key===focusedKey)?focusedKey:tabs.some(tab=>tab.key===activeKey)?activeKey:tabs[0]?.key;
 const addLocked=disabled||addDisabled||full;
 return <div className={`wb-tabs${disabled?' wb-tabs--held':''}`} role="tablist" aria-label={t.tabLabel} data-testid={chrome?'workroom-browser-tab-set':'owned-browser-tabs'} data-source={source} title={held??(full?ui.limitTip:t.only)}>
  <div className="wb-tabs-scroll" ref={scroller} data-fade={fade||undefined}>
   {tabs.map((x,index)=>{const on=x.key===activeKey,key=browserTabShortcutKey(index),name=x.title||t.newTab;
    const tip=[name,x.url&&x.url!==name?x.url:'',held??(key?ui.jumpTip.replace('{key}',key):'')].filter(Boolean).join('\n');
    return <div key={x.key} className="wb-tab" role="presentation" data-active={on?'':undefined} data-testid={chrome?'workroom-browser-tab-item':'owned-browser-tab-item'} data-tab-key={x.key}>
     <button type="button" role="tab" className="wb-tab-main" aria-selected={on} aria-controls={controlsId} tabIndex={x.key===focusKey?0:-1} data-tab={x.key} data-testid={chrome?'workroom-browser-tab-show':'owned-browser-tab'} data-loading={x.loading?'':undefined} title={tip} disabled={disabled}
      onFocus={()=>setFocusedKey(x.key)} onClick={()=>onSelect(x.key)} onKeyDown={event=>onKey(event,index,x)} onMouseDown={event=>{if(event.button===1)event.preventDefault();}} onAuxClick={event=>{if(event.button===1&&closable()){event.preventDefault();onClose!(x.key);}}}>
      <span className="wb-tab-icon" aria-hidden="true">{x.loading?<LoaderCircle className="wb-spin" size={12} strokeWidth={2}/>:monogram(x.host)?<span className="wb-tab-monogram">{monogram(x.host)}</span>:<Globe size={12} strokeWidth={1.75}/>}{x.aiActive&&<span className="wb-tab-ai"/>}</span>
      <span className="wb-tab-title">{name}</span>
     </button>
     {onClose&&(chrome||tabs.length>1)&&<button type="button" className="wb-tab-close" data-testid={chrome?'workroom-browser-tab-release':'owned-browser-tab-close'} aria-label={`${chrome?t.release:t.closeTab}: ${name}`} title={chrome?t.releaseTabTip:t.closeTab} tabIndex={-1} disabled={disabled} onClick={()=>onClose(x.key)}><X size={14} strokeWidth={1.75} aria-hidden/></button>}
    </div>;})}
  </div>
  {onAdd&&<button type="button" className="wb-icon-btn wb-tab-add" data-testid={chrome?'workroom-browser-add-tab':'owned-browser-new-tab'} aria-label={chrome?t.add:t.newTab} title={held??(addDisabled||full?addDisabledReason??(full?ui.limitTip:chrome?t.add:t.newTab):chrome?t.add:ui.newTabTip)} disabled={addLocked} onClick={()=>onAdd()}><Plus size={16} strokeWidth={1.75} aria-hidden/></button>}
 </div>;
}
