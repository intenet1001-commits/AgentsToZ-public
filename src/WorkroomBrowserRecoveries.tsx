import {useEffect,useState} from 'react';
import {ChevronDown,History} from 'lucide-react';
import type {Lang} from './i18n';
import type {BrowserRecoverySummary} from './workroomBrowserProtocol';
import type {WorkroomBrowserRequester} from './workroomBrowserClient';
import {workroomBrowserStageCopy} from './workroomBrowserStageCopy';
import {workroomBrowserUiCopy} from './workroomBrowserUiCopy';
import {browserRecoveryCard,fillBrowserText} from './workroomBrowserPresentation';
import './WorkroomBrowserFrameControl.css';
/** This project's saved browser tasks, newest first. Local metadata only: no address, title, input or grant. */
export function useBrowserRecoveries(request:WorkroomBrowserRequester,sessionId:string,targetId:string,enabled=true){
 const [result,setResult]=useState<{request:WorkroomBrowserRequester;sessionId:string;targetId:string;records:BrowserRecoverySummary[];failed:boolean}|null>(null);
 useEffect(()=>{if(!enabled)return;let active=true;
  const scope={request,sessionId,targetId};
  setResult({...scope,records:[],failed:false});
  void request({operation:'recoveries',sessionId,targetId}).then(r=>{if(active)setResult({...scope,records:[...r.recoveries??[]].sort((a,b)=>b.updatedAt-a.updatedAt),failed:false});})
   .catch(()=>{if(active)setResult({...scope,records:[],failed:true});});
  return()=>{active=false;};},[sessionId,targetId,request,enabled]);
 // The previous project's records are hidden on the very first render after a target/request changes, before effects.
 const current=enabled&&result?.request===request&&result.sessionId===sessionId&&result.targetId===targetId?result:null;
 return {records:current?.records??[],failed:current?.failed??false};
}
/** 「최근 작업」: one card per saved task, behind a header that opens them. Choosing one closes the list, so the native page
 *  below can show again. A card is titled by what the person saw (pageTitle, else host, else profile name), dated in
 *  the app language, and never prints which source enum it was. */
export function WorkroomBrowserRecoveries({sessionId,targetId,request,lang,onChoose,records:given,failed:givenFailed,now}:{sessionId:string;targetId:string;request:WorkroomBrowserRequester;lang:Lang;onChoose:(r:BrowserRecoverySummary)=>void;
 /** Already fetched (EmptyState shares one request with its chips); fetched here when absent. */
 records?:BrowserRecoverySummary[];failed?:boolean;now?:number}){
 const own=useBrowserRecoveries(request,sessionId,targetId,given===undefined);
 const records=given??own.records,failed=givenFailed??own.failed,stage=workroomBrowserStageCopy(lang),ui=workroomBrowserUiCopy(lang);
 // Nothing saved yet (or still loading): no empty header.
 if(!failed&&!records.length)return null;
 return <details className="wb-recent" data-testid="workroom-browser-recoveries">
  <summary className="wb-recent-summary" data-testid="workroom-browser-recoveries-toggle"><History size={16} aria-hidden="true"/><span className="wb-recent-heading">{ui.recoveries.title}</span>
   {records.length>0&&<span className="wb-recent-count">{records.length}</span>}<span className="wb-recent-more">{ui.recoveries.showAll}</span><ChevronDown className="wb-disclosure-chevron" size={14} aria-hidden="true"/></summary>
  <div className="wb-recent-list">
   {failed?<p className="wb-recent-note" role="status">{stage.unavailable}</p>:<ul>{records.map(r=>{
    const card=browserRecoveryCard(r,{now,lang});
    return <li key={r.id} className="wb-recent-card">
     <span className="wb-recent-monogram" aria-hidden="true">{card.monogram}</span>
     <span className="wb-recent-body"><span className="wb-recent-title" title={card.title}>{card.title}</span>
      <span className="wb-recent-meta"><span>{card.host||ui.owner[card.sourceKey]}</span><span aria-hidden="true">·</span><time dateTime={new Date(r.updatedAt).toISOString()} title={card.timeTitle}>{card.time}</time>
       {card.unknown>0&&<span className="wb-recent-chip">{fillBrowserText(ui.recoveries.unknownChip,{n:card.unknown})}</span>}</span></span>
     <button type="button" className="wb-control-btn" data-variant="ghost" data-testid="workroom-browser-recover" data-recovery-id={r.id} title={ui.recoveries.reopensTip}
      onClick={event=>{onChoose(r);const history=event.currentTarget.closest('details');if(history)history.open=false;}}><span>{ui.recoveries.resume}</span></button>
    </li>;})}</ul>}
   <p className="wb-recent-note">{stage.hint}</p>
  </div>
 </details>;
}
