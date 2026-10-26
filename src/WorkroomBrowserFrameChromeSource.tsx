import {useEffect,useRef,useState} from 'react';
import {Check,ChevronRight,Copy,ExternalLink,Globe,Info,RotateCw} from 'lucide-react';
import type {Lang} from './i18n';
import {BROWSER_TAB_LIMIT,type BrowserPage,type BrowserWorkspace} from './workroomBrowserProtocol';
import {workroomBrowserCopy} from './workroomBrowserCopy';
import {workroomBrowserTabsCopy} from './workroomBrowserTabsCopy';
import {workroomBrowserUiCopy} from './workroomBrowserUiCopy';
import {WorkroomBrowserFrameTabStrip} from './WorkroomBrowserFrameTabStrip';
import './WorkroomBrowserFrameChromeSource.css';

/** A Chrome profile the person can connect, as the broker lists it. */
export type WorkroomBrowserChromeProfile={id:string;profileName:string;accountLabel:string|null};
/** Choosing a tab matters for My Chrome, and for a built-in browser only once its one page is gone. */
const picksTab=(w:BrowserWorkspace)=>w.source==='chrome'||!w.page;
/** The address a person opens in Chrome to turn remote debugging on. */
export const CHROME_DEBUG_ADDRESS='chrome://inspect/#remote-debugging';
/** The host of a page address, for a row's second line. An address that will not parse is shown as it is. */
export const pageHost=(url:string)=>{try{return new URL(url).host||url;}catch{return url;}};
/** The 14px monogram of a row: the first letter of the title, else of the host. */
export const pageMonogram=(page:Pick<BrowserPage,'title'|'url'>)=>
  ([...(page.title.trim()||pageHost(page.url))][0]??'?').toUpperCase();

export type ChromeSourceSetupProps={
 lang:Lang;
 profiles:WorkroomBrowserChromeProfile[];
 /** The chosen profile id, '' for none. */
 profile:string;
 onProfile:(id:string)=>void;
 busy:boolean;
 onConnect:()=>void;
};

/**
 * My Chrome chosen, nothing connected yet: a guided card in the page area — three numbered steps with the address to
 * open, then the profiles as a radio list and one primary verb. It replaces the settings form of a native select, a
 * paragraph of instructions and a half-disabled button (shots/29b).
 */
export function ChromeSourceSetup({lang,profiles,profile,onProfile,busy,onConnect}:ChromeSourceSetupProps){
 const m=workroomBrowserCopy(lang);
 const [copied,setCopied]=useState(false);
 const address=useRef<HTMLElement|null>(null);
 useEffect(()=>{if(!copied)return;const timer=setTimeout(()=>setCopied(false),2000);return ()=>clearTimeout(timer);},[copied]);
 // The clipboard needs a secure context and a permission; where it is refused, the address is selected instead so the
 // person can copy it with the keyboard. Neither path ever navigates or opens Chrome by itself.
 const copyAddress=async()=>{
  try{await navigator.clipboard.writeText(CHROME_DEBUG_ADDRESS);setCopied(true);return;}catch{/* fall through to selection */}
  const node=address.current;if(!node)return;
  try{
   const range=document.createRange();range.selectNodeContents(node);
   const selection=window.getSelection();selection?.removeAllRanges();selection?.addRange(range);
  }catch{/* Selecting is a convenience; the address is readable on screen either way. */}
 };
 return <section className="wb-chrome-card" data-testid="workroom-browser-chrome-setup">
  <h3 className="wb-chrome-card__title">{m.chromeSetupTitle}</h3>
  <ol className="wb-chrome-steps">
   <li><span className="wb-chrome-steps__n" aria-hidden="true">1</span>
    <div className="wb-chrome-steps__body"><p>{m.chromeStep1}</p>
     <div className="wb-chrome-address">
      <code ref={address} data-testid="workroom-browser-chrome-address">{CHROME_DEBUG_ADDRESS}</code>
      <button type="button" className="wb-chrome-ghost" data-testid="workroom-browser-copy-address" title={m.copyAddress} onClick={()=>void copyAddress()}>
       {copied?<Check size={14}/>:<Copy size={14}/>}<span>{m.copyAddress}</span>
      </button>
     </div>
    </div></li>
   <li><span className="wb-chrome-steps__n" aria-hidden="true">2</span><div className="wb-chrome-steps__body"><p>{m.chromeStep2}</p></div></li>
   <li><span className="wb-chrome-steps__n" aria-hidden="true">3</span><div className="wb-chrome-steps__body"><p>{m.chromeStep3}</p></div></li>
  </ol>
  <fieldset className="wb-chrome-profiles" data-testid="workroom-browser-chrome-profile">
   <legend>{m.profile}</legend>
   {profiles.map(item=><label key={item.id} className="wb-chrome-row" data-profile-id={item.id} data-selected={item.id===profile?'':undefined}>
    <input type="radio" name="workroom-browser-chrome-profile" value={item.id} checked={item.id===profile} disabled={busy} onChange={()=>onProfile(item.id)}/>
    <span className="wb-chrome-row__text"><span className="wb-chrome-row__title">{item.profileName}</span>
     {item.accountLabel&&<span className="wb-chrome-row__meta">{item.accountLabel}</span>}</span>
   </label>)}
  </fieldset>
  <div className="wb-chrome-actions">
   <button type="button" className="wb-chrome-primary" data-testid="workroom-browser-connect" disabled={busy||!profile} onClick={()=>onConnect()}>
    <ChevronRight size={16}/>{m.connect}
   </button>
  </div>
 </section>;
}

/** The one info line the control bar shows for My Chrome: logins are shared, so the same tab must not be driven twice. */
export function chromeSourceLoginNotice(lang:Lang):{tone:'info';text:string}{
 return {tone:'info',text:workroomBrowserCopy(lang).warning};
}

export type ChromeSourceStageProps={
 lang:Lang;
 source:'owned'|'chrome';
 /** The connected workspace, for 「{title} · {host}」. */
 workspace?:BrowserWorkspace|null;
 busy?:boolean;
 /** Bring the attached Chrome tab forward (the host's `take`). K3 passes it; without it the card is read-only. */
 onTake?:()=>void;
 /** The shared-login notice for the control bar, raised instead of printed as a paragraph (K3 wires it). */
 onBarMessage?:(message:{tone:'info';text:string}|null)=>void;
};

/**
 * My Chrome connected: the app draws no page for this source, so the stage says where the page actually is and offers
 * the one verb that helps — bringing that tab forward. The shared-login warning is raised to the control bar as a single
 * info message instead of the two paragraphs that used to sit above the slot (shots/31b, 32b).
 */
export function ChromeSourceStage({lang,source,workspace,busy=false,onTake,onBarMessage}:ChromeSourceStageProps){
 const chrome=source==='chrome';
 useEffect(()=>{
  if(!onBarMessage)return;
  onBarMessage(chrome?chromeSourceLoginNotice(lang):null);
  return ()=>onBarMessage(null);
 },[chrome,lang,onBarMessage]);
 if(!chrome)return null;
 const m=workroomBrowserCopy(lang),ui=workroomBrowserUiCopy(lang),page=workspace?.page??null;
 return <section className="wb-chrome-card wb-chrome-card--stage" data-testid="workroom-browser-chrome-elsewhere">
  <span className="wb-chrome-tile" aria-hidden="true"><Globe size={20}/></span>
  {/* No key says 「Chrome 창에서 열려 있습니다」 yet, so the source's own name titles the card and the sentence below
      says where the page is (reported to A1/A3 — see hermes-h1-report.md). */}
  <h3 className="wb-chrome-card__title">{ui.owner.sourceChrome}</h3>
  {page&&<p className="wb-chrome-card__meta" data-testid="workroom-browser-chrome-page">{page.title||pageHost(page.url)}<span aria-hidden="true"> · </span>{pageHost(page.url)}</p>}
  <p className="wb-chrome-card__body">{m.chromePageElsewhere}</p>
  {onTake&&<div className="wb-chrome-actions">
   <button type="button" className="wb-chrome-primary" data-testid="workroom-browser-show-in-chrome" disabled={busy||workspace?.connection!=='connected'} onClick={()=>onTake()}>
    <ExternalLink size={16}/>{m.showInChrome}
   </button>
  </div>}
  {/* Until K3 raises it to the bar, the shared-login fact stays visible here — as one line, never a paragraph. */}
  {!onBarMessage&&<p className="wb-chrome-note" role="status" data-testid="workroom-browser-chrome-warning"><Info size={14} aria-hidden="true"/>{m.warning}</p>}
 </section>;
}
/** K0's name for the connected card, still mounted by WorkroomBrowserFrame (K3 passes `onTake`/`onBarMessage`). */
export const ChromeSourceNotes=ChromeSourceStage;

export type ChromeSourceRefreshTabsProps={lang:Lang;workspace:BrowserWorkspace;busy:boolean;onRefresh:()=>void};
/** Asks Chrome for this profile's tabs again. A ghost button beside the picker card. */
export function ChromeSourceRefreshTabs({lang,workspace,busy,onRefresh}:ChromeSourceRefreshTabsProps){
 if(!picksTab(workspace))return null;
 return <div className="wb-chrome-actions wb-chrome-actions--inline">
  <button type="button" className="wb-chrome-ghost" data-testid="workroom-browser-refresh-tabs"
   disabled={busy||workspace.connection!=='connected'||workspace.owner!=='human'} onClick={()=>onRefresh()}>
   <RotateCw size={14} aria-hidden="true"/><span>{workroomBrowserCopy(lang).refresh}</span>
  </button>
 </div>;
}

export type ChromeSourceTabPickerProps={
 lang:Lang;
 workspace:BrowserWorkspace;
 /** The listed tabs (the last refresh). */
 pages:BrowserPage[];
 /** The chosen tab id, '' for none. */
 page:string;
 onPage:(id:string)=>void;
 confirmed:boolean;
 onConfirmed:(confirmed:boolean)=>void;
 busy:boolean;
 /** Attach the chosen tab (it becomes the one the AI works in). */
 onSelect:()=>void;
 /** Add the chosen tab to this Workroom's set, once a page is connected. */
 onAdd:()=>void;
};

/**
 * The person picks a tab from real rows — monogram, title and host — instead of a native select of 「title · url」
 * (shots/31b). The confirmation stays exactly one line and still gates the request: `confirmProfile:true` is sent only
 * after it is checked (unchanged contract). Also serves a built-in browser whose page is gone.
 */
export function ChromeSourceTabPicker({lang,workspace,pages,page,onPage,confirmed,onConfirmed,busy,onSelect,onAdd}:ChromeSourceTabPickerProps){
 if(workspace.owner!=='human'||!picksTab(workspace))return null;
 const m=workroomBrowserCopy(lang),t=workroomBrowserTabsCopy(lang),connected=workspace.connection==='connected';
 const attached=new Set((workspace.tabs??[]).map(tab=>tab.id));
 const adding=!!workspace.page;
 const full=(workspace.tabs?.length??0)>=BROWSER_TAB_LIMIT;
 const blocked=busy||!page||!confirmed||!connected||(adding&&(full||attached.has(page)));
 return <section className="wb-chrome-card" data-testid="workroom-browser-chrome-picker">
  <h3 className="wb-chrome-card__title">{m.tab}</h3>
  <ul className="wb-chrome-tabs" data-testid="workroom-browser-chrome-tab" aria-label={m.tab}>
   {pages.map(item=>{
    const on=item.id===page,already=attached.has(item.id);
    return <li key={item.id}>
     <label className="wb-chrome-row wb-chrome-row--tab" data-page-id={item.id} data-selected={on?'':undefined} data-attached={already?'':undefined}>
      <input type="radio" name="workroom-browser-chrome-tab" value={item.id} checked={on} disabled={busy||!connected} onChange={()=>onPage(item.id)}/>
      <span className="wb-chrome-mono" aria-hidden="true">{pageMonogram(item)}</span>
      <span className="wb-chrome-row__text">
       <span className="wb-chrome-row__title" title={item.url}>{item.title||pageHost(item.url)}</span>
       <span className="wb-chrome-row__meta">{pageHost(item.url)}{already?` · ${t.active}`:''}</span>
      </span>
     </label></li>;
   })}
  </ul>
  <label className="wb-chrome-confirm">
   <input type="checkbox" data-testid="workroom-browser-confirm" checked={confirmed} disabled={busy||!page} onChange={event=>onConfirmed(event.target.checked)}/>
   <span>{m.chromeConfirmProfile}</span>
  </label>
  <div className="wb-chrome-actions">
   {/* One primary verb. Before a page is attached it attaches; afterwards the same row adds the tab to this task. */}
   <button type="button" className="wb-chrome-primary" data-testid={adding?'workroom-browser-add-tab':'workroom-browser-select-tab'}
    disabled={blocked} onClick={()=>adding?onAdd():onSelect()}>
    <ChevronRight size={16}/>{adding?t.add:m.select}
   </button>
  </div>
 </section>;
}

export type ChromeSourceTabSetProps={
 lang:Lang;
 workspace:BrowserWorkspace;
 busy:boolean;
 /** Show this tab: it becomes the one the AI works in. */
 onShow:(pageId:string)=>void;
 /** Remove it from the task; it stays open in Chrome. */
 onRelease:(pageId:string)=>void;
 /** Open the tab picker card (the strip's + button). */
 onAdd?:()=>void;
};

/**
 * This Workroom's own Chrome tabs in the **shared** tab strip, so My Chrome and the built-in browser have one tab row.
 * X means 「작업에서 빼기」 — the Chrome tab stays open — and + opens the picker card.
 */
export function ChromeSourceTabSet({lang,workspace,busy,onShow,onRelease,onAdd}:ChromeSourceTabSetProps){
 if(workspace.source!=='chrome'||!workspace.tabs?.length)return null;
 const t=workroomBrowserTabsCopy(lang),locked=busy||workspace.connection!=='connected'||workspace.owner!=='human';
 const full=workspace.tabs.length>=BROWSER_TAB_LIMIT;
 const tabs=workspace.tabs.map(tab=>({key:tab.id,title:tab.title||pageHost(tab.url),host:pageHost(tab.url),url:tab.url,
  aiActive:tab.id===workspace.page?.id&&workspace.owner!=='human'}));
 return <div className="wb-chrome-strip" data-testid="workroom-browser-chrome-strip">
  <WorkroomBrowserFrameTabStrip tabs={tabs} activeKey={workspace.page?.id??''} source="chrome" lang={lang}
   onSelect={onShow} onClose={onRelease} {...(onAdd?{onAdd}:{})}
   disabled={locked} addDisabled={locked||full}
   {...(workspace.owner!=='human'?{disabledReason:t.heldByAiTip}:{})}
   {...(full?{addDisabledReason:t.limit}:{})}/>
 </div>;
}
