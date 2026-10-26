import {useEffect,useId,useRef,useState,type ReactNode} from 'react';
import {Activity,Bot,Check,ChevronDown,Code,Eye,Hand,Info,KeyRound,ListChecks,LoaderCircle,LogIn,MousePointerClick,Pencil,RotateCw,TextCursorInput,TriangleAlert,Unplug,X,type LucideIcon} from 'lucide-react';
import type {Lang} from './i18n';
import type {BrowserWorkspace,BrowserWaiting} from './workroomBrowserProtocol';
import {workroomBrowserCopy} from './workroomBrowserCopy';
import {workroomBrowserStageCopy} from './workroomBrowserStageCopy';
import {workroomBrowserUiCopy,type WorkroomBrowserUiCopy} from './workroomBrowserUiCopy';
import {workroomBrowserErrorCopy} from './workroomBrowserErrorCopy';
import {classifyWorkroomBrowserError,type BrowserErrorCode} from './workroomBrowserErrorCodes';
import {browserActivityRows,browserControlView,fillBrowserText,pickBrowserText,type BrowserAction,type BrowserActionKind,type BrowserActivityRow,type BrowserControlInput,type BrowserControlView,type BrowserMessageKind,type BrowserTone} from './workroomBrowserPresentation';
import type {WorkroomBrowserPageState} from './OwnedWorkroomBrowser';
import './WorkroomBrowserFrameControl.css';
/** Everything the control surface describes: whose page it is, and what the browser is doing. */
export type WorkroomBrowserControlState={
 /** The source chosen in this panel (for a connected workspace, its own source). */
 source:'owned'|'chrome';
 workspace:BrowserWorkspace;
 /** A request of the panel is in flight. */
 busy:boolean;
 /** The built-in browser's page state, lifted from OwnedWorkroomBrowser; null for My Chrome or before it reports.
  *  Its open login popups and file notice become the bar's messages. */
 page:WorkroomBrowserPageState|null;
};
/** What only the frame knows (K3), all optional: a classified refusal, the handoff sequence's outcome and native hints.
 *  The bar decides from these with `browserControlView`; it never infers ownership itself. */
export type WorkroomBrowserControlSignals={
 /** A refusal already classified (`classifyWorkroomBrowserError`): the danger message, worded by A3's copy. */
 errorCode?:BrowserErrorCode|null;
 /** The host a load-error sentence names. Defaults to the page's host. */
 errorHost?:string|null;
 /** The connect (not a navigation) failed: the bar offers to finish only the connect (`actions.retryConnect`). */
 connectFailed?:boolean;
 /** The grant could not be made after a handoff; the AI keeps the page, nothing retries by itself. */
 grantFailed?:boolean;
 /** The handoff is in the composer, waiting to be sent. */
 handoffReady?:boolean;
 /** When the native page last blocked a person's click while the AI held it (C2b blockedInputs); shown for 4s. */
 blockedAt?:number|null;
 /** The site of an open login popup (C2b names popups by host). */
 popupHost?:string|null;
 /** The AI waiting for a person (C3). Defaults to the workspace's own `waiting`. */
 waiting?:BrowserWaiting|null;
};
/** The verbs, each one request of the frame. The first five exist today; the rest are wired by K3 and the bar shows a
 *  verb only once its handler is there. Without `handoff`, 「AI에게 넘기기」 runs today's `resume` and the grant step
 *  stays a separate button. */
export type WorkroomBrowserControlHandlers={take:()=>void;resume:()=>void;detach:()=>void;settle:()=>void;grant:()=>void;
 /** The single 「AI에게 넘기기」: resume, wait for the observation, grant, then the composer. */
 handoff?:()=>void;
 /** 「다시 연결」 for a disconnected workspace. */
 reconnect?:()=>void;
 /** 「연결 다시 시도」: finish only the connect of an accepted request (the existing finish() path), never a navigation. */
 retryConnect?:()=>void;
 /** 「권한 다시 만들기」 after a failed grant. Defaults to `grant`. */
 retryGrant?:()=>void;
 /** 「로그인 창 닫기」 (close-popups). */
 closePopups?:()=>void;
 /** Focus the omnibox to fix the address. */
 openAddress?:()=>void;
 /** A dismissible message was closed: clear its signal. The bar also hides it locally until it changes. */
 dismiss?:(kind:BrowserMessageKind)=>void};
/** 브라우저 종료 asks first, inline in the bar (명세 「Ellipsis menu」): 「탭 N개를 모두 닫을까요?」 [취소] [모두 닫기]. */
export type WorkroomBrowserControlConfirm={kind:'close-all';count:number;onConfirm:()=>void;onCancel:()=>void};
/** An already-open confirmation must follow the current locks, just like the menu that opened it.
 *  Page loading/connecting can still be cancelled by closing; profile admission and another close cannot. */
function closeReason(state:WorkroomBrowserControlState):keyof WorkroomBrowserUiCopy['owner']|null{
 const {workspace,busy,page,source}=state;
 if(workspace.connection!=='connected'||workspace.owner==='disconnected')return source==='chrome'?'disconnectedChrome':'disconnectedOwned';
 if(busy||workspace.owner==='observing'||workspace.owner==='taking'||page?.phase==='profile'||page?.phase==='closing')return 'disabledBusy';
 return workspace.owner==='human'?null:'blockedClick';
}
export function browserControlCloseAction(state:WorkroomBrowserControlState,onConfirm:()=>void){
 return {reason:closeReason(state),onClick:()=>{if(closeReason(state)===null)onConfirm();}};
}
export type WorkroomBrowserControlProps={
 state:WorkroomBrowserControlState;
 lang:Lang;
 actions:WorkroomBrowserControlHandlers;
 /** My Chrome's parts, above the bar until the Chrome source moves into the page area (H1). */
 slots?:{notes?:ReactNode;tabActions?:ReactNode;picker?:ReactNode;tabSet?:ReactNode};
 signals?:WorkroomBrowserControlSignals;
 confirm?:WorkroomBrowserControlConfirm|null;
 /** The overflow menu carries 연결 해제 (K1): the bar then leaves it out. */
 hideDetach?:boolean;
 /** The clock for relative times; tests pin it. */
 now?:number;
};
const ACTION_ICON:Readonly<Record<BrowserActionKind,LucideIcon>>={handoff:Bot,take:Hand,reconnect:RotateCw,'retry-grant':KeyRound,'close-popup':X,settle:Check,'retry-connect':RotateCw,'open-address':Pencil};
const ROW_ICON:Readonly<Record<BrowserActivityRow['icon'],LucideIcon>>={click:MousePointerClick,fill:TextCursorInput,select:ListChecks,other:Bot};
/** How a verb is painted: one filled primary per state, the rest ghosts. */
function variantOf(action:BrowserAction):string{
 if(!action.primary)return action.tone==='warn'||action.tone==='danger'?`ghost-${action.tone}`:'ghost';
 return action.tone==='ai'?'ai':action.tone==='danger'?'danger':action.tone==='warn'?'warn':'human';
}
const hostOf=(url?:string|null)=>{try{return url?new URL(url).host:'';}catch{return '';}};
/** A refusal in the person's language: A3's sentence for its code, the generic one when it names a host nobody knows. */
export function browserErrorSentence(lang:Lang,code:BrowserErrorCode,host=''):string{
 const errors=workroomBrowserErrorCopy(lang),text=errors[code]??errors.generic;
 return text.includes('{host}')&&!host?errors.generic:fillBrowserText(text,{host});
}
/** The sentence a drawer row or the bar's detail says about one AI action. */
function activitySentence(ui:WorkroomBrowserUiCopy,textKey:string,target:string,named:boolean,role=''){
 const unnamed=role&&Object.hasOwn(ui.activity.roles,role)
  ?fillBrowserText(ui.activity.unnamedTarget,{role:ui.activity.roles[role as keyof typeof ui.activity.roles]})
  :ui.activity.unnamedElement;
 return fillBrowserText(pickBrowserText(ui.activity,textKey,'done'),{target:named?target:unnamed});
}
type Verb={action:BrowserAction;label:string;reason:string;onClick?:()=>void;testId:string};
function VerbButton({verb,busy}:{verb:Verb;busy?:boolean}){
 const {action}=verb,Icon=busy?LoaderCircle:ACTION_ICON[action.action];
 return <button type="button" className="wb-control-btn" data-variant={variantOf(action)} data-action={action.action} data-testid={verb.testId}
  disabled={action.disabled||!verb.onClick} title={action.disabled&&verb.reason?verb.reason:undefined} aria-busy={busy||undefined} onClick={()=>verb.onClick?.()}>
  <Icon className={busy?'wb-spin':undefined} size={16} aria-hidden="true"/><span>{verb.label}</span></button>;
}
/** Who holds the page and the verbs between the person and the AI, with what the AI saw and did.
 *  One 36px bar (state, one primary verb, an optional secondary) and the 「AI 활동」 drawer that grows upward from it. */
export function WorkroomBrowserFrameControl({state,lang,actions,slots,signals,confirm,hideDetach=false,now}:WorkroomBrowserControlProps){
 const {source,workspace,busy,page}=state,ui=workroomBrowserUiCopy(lang),legacy=workroomBrowserCopy(lang),stage=workroomBrowserStageCopy(lang);
 const at=now??Date.now(),drawerId=useId(),closeCancel=useRef<HTMLButtonElement>(null),confirming=!!confirm;
 const closeAction=confirm?browserControlCloseAction(state,confirm.onConfirm):null,closeExplanation=closeAction?.reason?ui.owner[closeAction.reason]:'';
 useEffect(()=>{if(confirming)closeCancel.current?.focus({preventScroll:true});},[confirming]);
 const input:BrowserControlInput={owner:workspace.owner,source,connection:workspace.connection,profileVerification:workspace.profileVerification,
  hasPage:!!workspace.page,receipt:workspace.receipt??null,waiting:signals?.waiting!==undefined?signals.waiting:workspace.waiting??null,
  popup:page&&page.popups>0?{open:true,host:signals?.popupHost??null}:null,fileNotice:!!page?.notice,busy,activity:workspace.activity,now:at,lang,
  errorCode:signals?.errorCode??null,connectFailed:!!signals?.connectFailed,grantFailed:!!signals?.grantFailed,handoffReady:!!signals?.handoffReady,blockedAt:signals?.blockedAt??null};
 // A dismissed message hides until it changes; the bar then reads as if that message were not there.
 const [dismissed,setDismissed]=useState('');
 const full=browserControlView(input),keyOf=(v:BrowserControlView)=>`${v.message.kind}:${v.message.textKey}:${v.message.errorCode??''}:${v.message.kind==='blocked'?input.blockedAt??'':''}:${signals?.errorHost??''}`;
 const fullKey=keyOf(full);
 useEffect(()=>{setDismissed('');},[fullKey]);
 const view=full.message.dismissible&&dismissed===keyOf(full)?browserControlView({...input,errorCode:null,connectFailed:false,handoffReady:false,fileNotice:false,blockedAt:null}):full;
 const owner=workspace.connection==='disconnected'?'disconnected':workspace.owner;
 const rows=browserActivityRows(workspace.activity,{now:at,lang,owner,receipt:workspace.receipt??null,busy});
 // An action whose result nobody knows opens the drawer once, so its sentence and 「직접 확인하기」 are in view.
 const unknownId=workspace.receipt?.state==='unknown'?workspace.receipt.id:'';
 const [open,setOpen]=useState(()=>!!unknownId),opened=useRef(unknownId);
 useEffect(()=>{if(unknownId&&opened.current!==unknownId){opened.current=unknownId;setOpen(true);}},[unknownId]);
 const handler:Readonly<Record<BrowserActionKind,(()=>void)|undefined>>={handoff:actions.handoff??actions.resume,take:actions.take,reconnect:actions.reconnect,
  'retry-grant':actions.retryGrant??actions.grant,'close-popup':actions.closePopups,settle:actions.settle,'retry-connect':actions.retryConnect,'open-address':actions.openAddress};
 const testId:Readonly<Record<BrowserActionKind,string>>={handoff:actions.handoff?'workroom-browser-handoff':'workroom-browser-resume',take:'workroom-browser-take',
  reconnect:'workroom-browser-reconnect','retry-grant':'workroom-browser-grant','close-popup':'workroom-browser-popups-close',settle:'workroom-browser-settle',
  'retry-connect':'owned-browser-retry-connect','open-address':'workroom-browser-edit-address'};
 const verb=(action:BrowserAction|null,overrideTestId?:string):Verb|null=>{
  if(!action||!handler[action.action])return null;
  const label=action.action==='retry-connect'?pickBrowserText(ui.owner,'retryConnect')||stage.retryConnect:pickBrowserText(ui[action.group],action.labelKey);
  return {action,label,reason:action.disabledReasonKey?pickBrowserText(ui.owner,action.disabledReasonKey):'',onClick:handler[action.action],testId:overrideTestId??testId[action.action]};
 };
 const primary=verb(view.primary),secondary=verb(view.secondary);
 // Today's two-step handoff: once the AI holds the page and has looked at it, its access goes into the composer by a
 // separate verb. It stays in the DOM, hidden and off, until it applies (kept for compatibility until C4).
 const grantUsable=!busy&&owner==='agent'&&!!workspace.observation&&!view.resendBlocked&&!input.popup?.open;
 const legacyGrant=!actions.handoff&&view.secondary?.action!=='retry-grant';
 // The state line, or the message that replaces it.
 const {message}=view,alert=message.role==='alert'&&!confirm,pageHost=hostOf(workspace.page?.url);
 const alertCode=alert?(message.errorCode??(message.kind==='disconnected'?source==='chrome'?'chrome-disconnected':'target-lost':'grant-unavailable')):undefined;
 let tone:BrowserTone=view.tone,lineText:string,detailText='',detailTitle='';
 if(confirm){tone='danger';lineText=fillBrowserText(ui.toolbar.closeAllConfirm,{n:confirm.count});}
 else if(message.kind==='owner'){
  lineText=pickBrowserText(ui.owner,view.labelKey);
  const d=view.detail;
  if(d){detailText=d.group==='activity'?activitySentence(ui,d.textKey,String(d.params?.target??''),d.named??true,String(d.params?.role??'')):pickBrowserText(ui[d.group],d.textKey);
   if(d.time){detailTitle=`${detailText} · ${d.timeTitle}`;detailText=`${detailText} · ${d.time}`;}}
 }else if(message.errorCode)lineText=browserErrorSentence(lang,message.errorCode,signals?.errorHost??pageHost);
 else lineText=fillBrowserText(pickBrowserText(ui[message.group],message.textKey),message.params);
 const LineIcon=confirm?TriangleAlert:message.kind==='owner'?null:message.kind==='transition'?LoaderCircle:message.kind==='popup'?LogIn:message.kind==='waiting'?Hand
  :message.kind==='disconnected'?Unplug:tone==='info'?Info:TriangleAlert;
 const dismiss=()=>{setDismissed(keyOf(full));actions.dismiss?.(full.message.kind);};
 const cancelClose=()=>{confirm?.onCancel();closeCancel.current?.closest('[data-testid=workroom-browser-panel]')?.querySelector<HTMLButtonElement>('[data-testid=workroom-browser-menu]')?.focus({preventScroll:true});};
 const hasDrawer=rows.length>0||!!workspace.observation||!!workspace.page,showToggle=rows.length>0||!!workspace.observation;
 const attention=rows.some(row=>row.current&&row.state==='unknown'),toggleText=rows.length?fillBrowserText(ui.activity.toggle,{n:rows.length}):ui.activity.title;
 const ids=rows.map(row=>row.id);
 const sourceParts=slots&&(slots.notes||slots.tabActions||slots.picker||slots.tabSet);
 return <div className="wb-control" data-testid="workroom-browser-control" data-tone={tone} data-kind={confirm?'confirm':message.kind} data-verification={workspace.profileVerification}
  data-workroom-local-escape={confirming?'':undefined} onKeyDown={event=>{if(!confirming||event.key!=='Escape'||event.nativeEvent.isComposing)return;event.preventDefault();event.stopPropagation();cancelClose();}}>
  {sourceParts&&<div className="wb-control-source">{slots.notes}{slots.tabActions&&<div className="wb-control-source-actions">{slots.tabActions}</div>}{slots.picker}{slots.tabSet}</div>}
  {hasDrawer&&<section id={drawerId} className="wb-activity" data-testid="workroom-browser-activity" aria-label={ui.activity.title} hidden={!open}>
   {rows.length?<ol className="wb-activity-rows">{rows.map(row=>{
    const RowIcon=ROW_ICON[row.icon],label=activitySentence(ui,row.textKey,row.params.target,row.named,row.role);
    return <li key={row.id} className="wb-activity-row" data-tone={row.tone} data-state={row.state} {...row.current?{'data-testid':'workroom-browser-receipt','data-receipt-state':row.state}:{}}>
     <RowIcon className="wb-activity-icon" size={16} aria-hidden="true"/>
     <div className="wb-activity-main"><span className="wb-activity-text">{label}</span>
      {row.reviewed&&<span className="wb-activity-badge"><Check size={12} aria-hidden="true"/>{pickBrowserText(ui.activity,'reviewed','checkedIt')}</span>}
      {row.actions.length>0&&<div className="wb-activity-actions">{row.actions.map(action=>{const v=verb(action,action.action==='take'?'workroom-browser-check':undefined);return v&&<VerbButton key={action.action} verb={v}/>;})}</div>}
     </div>
     {row.time&&<time className="wb-activity-time" dateTime={row.at===null?undefined:new Date(row.at).toISOString()} title={row.timeTitle}>{row.time}</time>}
    </li>;})}</ol>:<p className="wb-activity-empty">{ui.activity.empty}</p>}
   {workspace.observation&&<details className="wb-activity-disclosure" data-testid="workroom-browser-observation-details">
    <summary data-testid="workroom-browser-observation-toggle"><Eye size={14} aria-hidden="true"/><span>{ui.activity.seenByAi}</span><span className="wb-activity-caption">{ui.activity.untrustedNote}</span><ChevronDown className="wb-disclosure-chevron" size={14} aria-hidden="true"/></summary>
    <pre className="wb-activity-observation" data-testid="workroom-browser-observation">{workspace.observation.text}</pre></details>}
   {/* Request ids and the raw address, for whoever needs them; nothing else in the panel prints them. */}
   <details className="wb-activity-disclosure" data-testid="workroom-browser-technical">
    <summary><Code size={14} aria-hidden="true"/><span>{ui.activity.technicalDetails}</span><ChevronDown className="wb-disclosure-chevron" size={14} aria-hidden="true"/></summary>
    <div className="wb-activity-technical">{workspace.page&&<code className="workroom-browser-url" data-testid="workroom-browser-url">{workspace.page.url}</code>}{ids.map(id=><code key={id}>{id}</code>)}</div></details>
  </section>}
  <div className="wb-control-bar">
   <div className="wb-control-line" data-testid="workroom-browser-owner" role={alert?'alert':'status'} aria-live={alert?undefined:'polite'} data-error-code={alertCode} title={detailTitle||(detailText?`${lineText} · ${detailText}`:lineText)}>
    {LineIcon?<LineIcon className={LineIcon===LoaderCircle?'wb-control-glyph wb-spin':'wb-control-glyph'} size={16} aria-hidden="true"/>:<span className="wb-control-dot" aria-hidden="true"/>}
    <strong className="wb-control-label">{lineText}</strong>{detailText&&<span className="wb-control-detail">{detailText}</span>}
   </div>
   {message.dismissible&&!confirm&&<button type="button" className="wb-control-icon" data-testid="workroom-browser-dismiss" aria-label={pickBrowserText(ui.owner,'dismiss')||ui.toolbar.cancel} title={pickBrowserText(ui.owner,'dismiss')||ui.toolbar.cancel} onClick={dismiss}><X size={16} aria-hidden="true"/></button>}
   <div className="wb-control-actions">
    {confirm?<>
     <button type="button" ref={closeCancel} className="wb-control-btn" data-variant="ghost" data-testid="workroom-browser-close-all-cancel" onClick={cancelClose}><span>{ui.toolbar.cancel}</span></button>
     <button type="button" className="wb-control-btn" data-variant="danger" data-testid="workroom-browser-close-all-confirm" disabled={!!closeAction?.reason} title={closeExplanation||undefined} aria-describedby={closeExplanation?`${drawerId}-close-reason`:undefined} onClick={closeAction!.onClick}><X size={16} aria-hidden="true"/><span>{ui.toolbar.closeAll}</span></button>
     {closeExplanation&&<span className="wb-sr-only" id={`${drawerId}-close-reason`}>{closeExplanation}</span>}
    </>:<>
     {showToggle&&<button type="button" className="wb-control-btn wb-control-toggle" data-variant="ghost" data-testid="workroom-browser-activity-toggle" data-attention={attention||undefined} aria-expanded={open} aria-controls={drawerId} aria-label={toggleText} title={toggleText} onClick={()=>setOpen(value=>!value)}>
      {/* A narrow bar keeps the count and drops the words (the title and the accessible name keep them). */}
      <Activity size={16} aria-hidden="true"/><span className="wb-control-toggle-text">{toggleText}</span>{rows.length>0&&<span className="wb-control-toggle-count" aria-hidden="true">{rows.length}</span>}<ChevronDown className="wb-disclosure-chevron" size={14} aria-hidden="true"/></button>}
     {secondary&&<VerbButton verb={secondary}/>}
     {legacyGrant&&<button type="button" className="wb-control-btn" data-variant="ghost-ai" data-testid="workroom-browser-grant" hidden={!grantUsable} disabled={!grantUsable} onClick={()=>actions.grant()}><KeyRound size={16} aria-hidden="true"/><span>{legacy.grant}</span></button>}
     {primary&&<VerbButton verb={primary} busy={message.kind==='transition'||busy&&primary.action.disabled}/>}
     {!hideDetach&&<button type="button" className="wb-control-btn" data-variant="ghost-danger" data-icon-only={primary?'':undefined} data-testid="workroom-browser-detach" disabled={busy} aria-label={legacy.detach} title={legacy.detach} onClick={()=>actions.detach()}><Unplug size={16} aria-hidden="true"/><span>{legacy.detach}</span></button>}
    </>}
   </div>
  </div>
 </div>;
}
/** The panel's own messages under the bar: the last error and the last notice, in the bar's vocabulary. An error is
 *  never printed as it was thrown: it is classified to a code and worded by A3's copy; the raw text goes to the console. */
export function WorkroomBrowserControlMessages({lang,error,errorCode='',notice,host='',preserved=false}:{lang:Lang;error:string;
 /** The error's code (C1 classifyWorkroomBrowserError). Classified here from the message when empty. */
 errorCode?:string;notice:string;
 /** The host a load-error sentence names. */
 host?:string;
 /** The one-time 「접거나 터미널로 돌아가도…」 note (K3 shows it on the first collapse only). */
 preserved?:boolean}){
 const raw=error.replace(/^Error:\s*/,''),code=(errorCode||(raw?classifyWorkroomBrowserError(raw):'')) as BrowserErrorCode|'';
 useEffect(()=>{if(raw)console.warn('[workroom-browser]',raw);},[raw]);
 const preservedText=preserved?pickBrowserText(workroomBrowserUiCopy(lang).owner,'preservedOnce'):'';
 if(!error&&!notice&&!preservedText)return null;
 return <div className="wb-control-notes">
  {error&&code&&<p className="wb-control-note" data-tone="danger" role="alert" data-testid="workroom-browser-error" data-error-code={code}><TriangleAlert size={16} aria-hidden="true"/><span>{browserErrorSentence(lang,code,host)}</span></p>}
  {notice&&<p className="wb-control-note" data-tone="info" role="status" data-testid="workroom-browser-notice"><Info size={16} aria-hidden="true"/><span>{notice}</span></p>}
  {preservedText&&<p className="wb-control-note" data-tone="neutral" role="status" data-testid="workroom-browser-preserved"><Info size={16} aria-hidden="true"/><span>{preservedText}</span></p>}
 </div>;
}
