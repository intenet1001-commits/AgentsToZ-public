import {AppWindow,Chromium,Globe,History,LoaderCircle,Pencil,PlugZap,RotateCw,ShieldAlert,TriangleAlert,WifiOff,type LucideIcon} from 'lucide-react';
import type {Lang} from './i18n';
import type {BrowserRecoverySummary} from './workroomBrowserProtocol';
import type {WorkroomBrowserRequester} from './workroomBrowserClient';
import {workroomBrowserCopy} from './workroomBrowserCopy';
import {workroomBrowserStageCopy} from './workroomBrowserStageCopy';
import {workroomBrowserUiCopy} from './workroomBrowserUiCopy';
import {BROWSER_LOAD_ERROR_CODES,workroomBrowserPageErrorCopy,type BrowserLoadErrorCode} from './workroomBrowserErrorCopy';
import type {BrowserErrorCode} from './workroomBrowserErrorCodes';
import {browserRecoveryCard,fillBrowserText} from './workroomBrowserPresentation';
import {WorkroomBrowserRecoveries,useBrowserRecoveries} from './WorkroomBrowserRecoveries';
import {browserErrorSentence} from './WorkroomBrowserFrameControl';
import './WorkroomBrowserFrameControl.css';
/** Where the page goes: this Workroom's built-in browser, or a tab of the person's own Chrome. */
export type WorkroomBrowserSource='owned'|'chrome';
/** A page this project offers to open (C4: its registered localhost URLs). */
export type WorkroomBrowserSuggestion={label:string;url:string};
/** How many saved tasks the start card offers as chips; all of them are in 「최근 작업」. */
const RECENT_CHIPS=3;
export type EmptyStateProps={
 lang:Lang;
 sessionId:string;
 targetId:string;
 request:WorkroomBrowserRequester;
 source:WorkroomBrowserSource;
 /** The saved task chosen to continue, if any. */
 recovery:BrowserRecoverySummary|null;
 onChooseRecovery:(r:BrowserRecoverySummary)=>void;
 onChooseSource:(source:WorkroomBrowserSource)=>void;
 /** This project's pages, offered as chips on the start card (C4). */
 suggestions?:WorkroomBrowserSuggestion[];
 /** A suggestion was chosen: open it as a person's navigation. Without it the chips are shown but off. */
 onSuggestion?:(url:string)=>void;
 /** Whether this device can run the built-in browser; when it cannot, its choice is hidden. */
 ownedAvailable?:boolean;
 /** The built-in browser already shows a page (loading or connecting): only the source choice and saved tasks remain. */
 pageOpen?:boolean;
 /** The clock for relative times; tests pin it. */
 now?:number;
};
/** No browser connected yet. The built-in source gets a start card (what this browser is for, this project's pages and
 *  the latest saved tasks); both sources get the source choice, named by intent, and 「최근 작업」. */
export function EmptyState({lang,sessionId,targetId,request,source,recovery,onChooseRecovery,onChooseSource,suggestions=[],onSuggestion,ownedAvailable=true,pageOpen=false,now}:EmptyStateProps){
 const ui=workroomBrowserUiCopy(lang),{records,failed}=useBrowserRecoveries(request,sessionId,targetId);
 const start=source==='owned'&&ownedAvailable&&!pageOpen,recent=records.slice(0,RECENT_CHIPS);
 return <div className="wb-empty" data-testid="workroom-browser-empty" data-source={source}>
  {start&&<div className="wb-state-card wb-empty-start">
   <span className="wb-state-tile" aria-hidden="true"><Globe size={20}/></span>
   <h2 className="wb-state-title">{ui.empty.title}</h2>
   <p className="wb-state-body">{ui.empty.body}</p>
   {suggestions.length+recent.length>0&&<ul className="wb-empty-chips">
    {suggestions.map(s=><li key={s.url}><button type="button" className="wb-empty-chip" data-testid="workroom-browser-suggestion" data-url={s.url} title={s.url} disabled={!onSuggestion} onClick={()=>onSuggestion?.(s.url)}><Globe size={14} aria-hidden="true"/><span>{s.label}</span></button></li>)}
    {recent.map(r=>{const card=browserRecoveryCard(r,{now,lang});return <li key={r.id}><button type="button" className="wb-empty-chip" data-testid="workroom-browser-recent" data-recovery-id={r.id} aria-pressed={recovery?.id===r.id} title={`${ui.recoveries.reopensTip} · ${card.timeTitle}`} onClick={()=>onChooseRecovery(r)}>
     <History size={14} aria-hidden="true"/><span>{card.title}</span><span className="wb-empty-chip-meta">{card.time}</span></button></li>;})}
   </ul>}
  </div>}
  {/* The source, named by what the person wants: this task's own browser, or their signed-in Chrome. */}
  <div className="wb-source-switch" role="group" aria-label={workroomBrowserCopy(lang).title}>
   {ownedAvailable&&<button type="button" data-testid="workroom-browser-source-owned" aria-pressed={source==='owned'} onClick={()=>onChooseSource('owned')}><AppWindow size={14} aria-hidden="true"/><span>{ui.owner.sourceOwned}</span></button>}
   <button type="button" data-testid="workroom-browser-source-chrome" aria-pressed={source==='chrome'} title={ui.empty.useMyChrome} onClick={()=>onChooseSource('chrome')}><Chromium size={14} aria-hidden="true"/><span>{ui.owner.sourceChrome}</span></button>
  </div>
  <WorkroomBrowserRecoveries sessionId={sessionId} targetId={targetId} request={request} lang={lang} onChoose={onChooseRecovery} records={records} failed={failed} now={now}/>
  {recovery&&<p className="wb-empty-chosen" role="status" data-testid="workroom-browser-recovery-chosen"><History size={14} aria-hidden="true"/><span>{recovery.profileName}</span><span className="wb-empty-chosen-hint">{ui.recoveries.reopensTip}</span></p>}
 </div>;
}
export type UnavailableStateProps={
 lang:Lang;
 /** The 「내 Chrome 연결」 primary; without it the card only explains. */
 onConnectChrome?:()=>void;
};
/** The built-in browser cannot run here (not the macOS app, or no embedded browser). No build-flavour words. */
export function UnavailableState({lang,onConnectChrome}:UnavailableStateProps){
 const ui=workroomBrowserUiCopy(lang);
 return <div className="wb-state-card wb-unavailable" data-testid="owned-browser-unavailable" role="status">
  <span className="wb-state-tile" aria-hidden="true"><AppWindow size={20}/></span>
  <h2 className="wb-state-title">{ui.unavailable.title}</h2>
  <p className="wb-state-body">{ui.unavailable.body}</p>
  {onConnectChrome&&<div className="wb-state-actions"><button type="button" className="wb-control-btn" data-variant="human" data-testid="workroom-browser-connect-chrome" onClick={()=>onConnectChrome()}><Chromium size={16} aria-hidden="true"/><span>{ui.unavailable.connectMyChrome}</span></button></div>}
 </div>;
}
export type PageErrorCardProps={
 lang:Lang;
 host:string;
 /** A load-error or refusal code (C1 BROWSER_ERROR_CODES, C2b loadError). */
 code:string;
 /** 「다시 시도」: a reload, which is an explicit human navigation. */
 onRetry:()=>void;
 /** 「주소 수정」: focus the omnibox. */
 onEditAddress:()=>void;
};
const LOAD_ICON:Readonly<Record<BrowserLoadErrorCode,LucideIcon>>={'load-refused':PlugZap,'load-timeout':PlugZap,'load-name-not-resolved':TriangleAlert,'load-offline':WifiOff,'load-certificate':ShieldAlert};
const isLoadCode=(code:string):code is BrowserLoadErrorCode=>(BROWSER_LOAD_ERROR_CODES as readonly string[]).includes(code);
/** In place of a page that did not load (no document, a native load error): the host and cause, what to check, and the
 *  two ways on. K3 shows it while the native page is hidden. */
export function PageErrorCard({lang,host,code,onRetry,onEditAddress}:PageErrorCardProps){
 const copy=workroomBrowserPageErrorCopy(lang),card=isLoadCode(code)?copy.cards[code]:null,Icon=isLoadCode(code)?LOAD_ICON[code]:TriangleAlert;
 // Without a load code (a document that never came) the card names the host and says what happened in general terms.
 const title=host?fillBrowserText(card?.title??copy.title,{host}):workroomBrowserStageCopy(lang).noDocument;
 const cause=card?browserErrorSentence(lang,code as BrowserErrorCode,host):host?workroomBrowserStageCopy(lang).noDocument:'';
 return <div className="wb-state-card wb-page-error" data-testid="workroom-browser-page-error" role="alert" data-error-code={code}>
  <span className="wb-state-tile" data-tone="danger" aria-hidden="true"><Icon size={20}/></span>
  <h2 className="wb-state-title">{title}</h2>
  {cause&&cause!==title&&<p className="wb-state-body">{cause}</p>}
  <div className="wb-page-error-try"><h3>{copy.tryHeading}</h3><ul>{copy.tryList.map(item=><li key={item}>{item}</li>)}</ul></div>
  <div className="wb-state-actions">
   <button type="button" className="wb-control-btn" data-variant="ghost" data-testid="workroom-browser-page-edit" onClick={()=>onEditAddress()}><Pencil size={16} aria-hidden="true"/><span>{copy.editAddress}</span></button>
   <button type="button" className="wb-control-btn" data-variant="human" data-testid="workroom-browser-page-retry" onClick={()=>onRetry()}><RotateCw size={16} aria-hidden="true"/><span>{copy.retry}</span></button>
  </div>
 </div>;
}
export type PagePlaceholderProps={
 lang:Lang;
 title?:string;
 host?:string;
 loading?:boolean;
};
/** Under the native page, in its slot: shown whenever that page is hidden or not painted yet (a drag, a menu, first
 *  paint, re-showing after a collapse), so the stage never goes blank. Fills a positioned slot. */
export function PagePlaceholder({lang,title,host,loading=false}:PagePlaceholderProps){
 const shown=title?.trim()||host?.trim()||(loading?workroomBrowserUiCopy(lang).owner.stageLoading:'');
 return <div className="wb-placeholder" data-testid="workroom-browser-placeholder" aria-hidden="true">
  {loading&&<LoaderCircle className="wb-spin" size={12}/>}
  {shown&&<span className="wb-placeholder-title">{shown}</span>}
  {host&&shown!==host&&<span className="wb-placeholder-host">{host}</span>}
 </div>;
}
