import {appLocale,readAppLanguage,type Lang} from './i18n';
import type {BrowserActivity,BrowserOwner,BrowserReceipt,BrowserWaiting} from './workroomBrowserProtocol';
import type {BrowserErrorCode} from './workroomBrowserErrorCodes';

/**
 * Pure decisions for the control bar, its messages and the activity drawer (K2·K3, 명세 「Control ownership and
 * handoff」·「Empty, error and recovery states」). No React, no host call and **no copy lookup**: every sentence is a key
 * of `workroomBrowserUiCopy(lang)` (A1) plus parameters, and a refusal is carried as its C1 code so A3's copy module can
 * render it without this module knowing it yet.
 *
 * Two product rules live here as decisions, not as component code:
 * - an action whose outcome is unknown is never sent again — an unknown receipt blocks the handoff verb and offers
 *   「직접 확인하기」 then 「확인했어요」, and no decision of this module is ever a resend;
 * - while the AI owns the page a person's controls are off — the omnibox, navigation, tabs and the page itself are
 *   enabled only for a connected human.
 */

/** Which side of the bar a tone paints. `ai` is the violet ownership tone. */
export type BrowserTone='neutral'|'ai'|'info'|'warn'|'danger';
/** The eight message kinds, highest priority first (명세 「Messages replace the state line in this priority order」). */
export const BROWSER_MESSAGE_PRIORITY=['error','transition','disconnected','popup','waiting','notice','blocked','owner'] as const;
export type BrowserMessageKind=typeof BROWSER_MESSAGE_PRIORITY[number];

/** A key of `workroomBrowserUiCopy(lang).owner` / `.bar`, `.waiting` or `.activity`. */
export type BrowserCopyKey=string;
export type BrowserParams=Readonly<Record<string,string|number>>;

export interface BrowserMessage {
  kind:BrowserMessageKind;
  tone:BrowserTone;
  /** Where the key lives, so the component reads one object: `copy[group][textKey]`. */
  group:'owner'|'waiting'|'activity';
  textKey:BrowserCopyKey;
  params?:BrowserParams;
  /** Present only for a refusal: C1's code, also the `data-error-code` attribute. Copy comes from A3, not from here. */
  errorCode?:BrowserErrorCode;
  role:'status'|'alert';
  dismissible:boolean;
}

/** What a button does. The component maps the action to its own handler; this module never calls anything. */
export type BrowserActionKind='handoff'|'take'|'reconnect'|'retry-grant'|'close-popup'|'settle'|'retry-connect'|'open-address';
export interface BrowserAction {
  action:BrowserActionKind;
  group:'owner'|'waiting'|'activity';
  labelKey:BrowserCopyKey;
  /** A verb nobody may press yet, with the reason in the detail and in `title`. */
  disabled:boolean;
  disabledReasonKey?:BrowserCopyKey;
  tone:BrowserTone;
  /** True only for the one primary verb; a secondary action is a ghost button. */
  primary:boolean;
}

export interface BrowserControlView {
  tone:BrowserTone;
  /** The state line: 「직접 사용 중」, 「AI가 사용 중」… Always a key, never a sentence. */
  labelKey:BrowserCopyKey;
  labelGroup:'owner';
  /** The dimmed detail beside the label (the last activity, or why the verb is off). The last activity also carries
   *  when it happened, and whether the page named its element (else the component says so instead of printing 「」). */
  detail:{group:'owner'|'activity';textKey:BrowserCopyKey;params?:BrowserParams;named?:boolean;time?:string;timeTitle?:string}|null;
  message:BrowserMessage;
  primary:BrowserAction|null;
  secondary:BrowserAction|null;
  /** The omnibox, navigation group, tab strip, new tab and close controls. */
  humanControlsEnabled:boolean;
  /** 「직접 하기」 is hidden while a person already owns the page, for both sources. */
  showTake:boolean;
  /** True while an unknown receipt is waiting to be checked: nothing may be re-sent until it is settled. */
  resendBlocked:boolean;
  activityCount:number;
}

export interface BrowserControlInput {
  owner:BrowserOwner;
  source:'owned'|'chrome';
  connection?:'connected'|'disconnected';
  profileVerification?:'user-confirmed'|'unverified';
  /** False before the first page: the handoff verb has nothing to hand over. */
  hasPage?:boolean;
  receipt?:Pick<BrowserReceipt,'state'|'action'|'target'|'id'>|null;
  waiting?:BrowserWaiting|null;
  /** A login popup is open; the host names its site when it knows it. */
  popup?:{open:boolean;host?:string|null}|null;
  /** A file picker or download the AI cannot do for the person. */
  fileNotice?:boolean;
  /** When the AI's click was blocked because a person was using the page; shown for 4 seconds. */
  blockedAt?:number|null;
  /** A refusal already classified by C1 (`classifyWorkroomBrowserError`). */
  errorCode?:BrowserErrorCode|null;
  /** The grant could not be made: the AI keeps the page without one, and nothing is retried automatically. */
  grantFailed?:boolean;
  /** The handoff message is in the composer and waiting to be sent. */
  handoffReady?:boolean;
  /** One of our own calls is in flight. */
  busy?:boolean;
  /** The connect (not a navigation) failed and may be finished again. */
  connectFailed?:boolean;
  activity?:readonly BrowserActivity[];
  now?:number;
  lang?:Lang;
}

/** How long a blocked-click hint stays up (명세: 「blocked-click hint for 4s」). */
export const BROWSER_BLOCKED_HINT_MS=4000;

const OWNER_LABEL:Readonly<Record<BrowserOwner,BrowserCopyKey>>={
  human:'human',observing:'observing',agent:'agent',taking:'taking',disconnected:'disconnectedOwned',
};
const OWNER_TONE:Readonly<Record<BrowserOwner,BrowserTone>>={
  human:'neutral',observing:'ai',agent:'ai',taking:'ai',disconnected:'danger',
};
const WAITING_KEY:Readonly<Record<BrowserWaiting['reason'],BrowserCopyKey>>={
  login:'login',captcha:'captcha',confirm:'confirm',file:'file','open-page':'openPage',
};

const disabledReason=(input:BrowserControlInput,unknownReceipt:boolean):BrowserCopyKey|undefined=>{
  if(input.busy)return 'disabledBusy';
  if(!(input.hasPage??true))return 'disabledNoPage';
  if(input.popup?.open)return 'disabledPopupOpen';
  if(input.source==='chrome'&&input.profileVerification==='unverified')return 'unverified';
  // An action whose result nobody has read yet: the person checks it before anything else is handed over.
  if(unknownReceipt)return 'disabledUnknownReceipt';
  return undefined;
};

/**
 * The whole bar as one decision. Deterministic: the same input always yields the same view, so the screen checks and
 * these unit tests fix the matrix of owner × source × message × receipt.
 */
export function browserControlView(input:BrowserControlInput):BrowserControlView{
  const connection=input.connection??'connected';
  const owner:BrowserOwner=connection==='disconnected'?'disconnected':input.owner;
  const unknownReceipt=input.receipt?.state==='unknown';
  const unverified=input.source==='chrome'&&input.profileVerification==='unverified'&&owner!=='disconnected';
  const humanControlsEnabled=owner==='human'&&connection==='connected';
  const showTake=owner==='agent'||owner==='taking'||owner==='observing';
  const reason=disabledReason(input,unknownReceipt);

  const take=(primary:boolean,disabled=owner==='taking'||!!input.busy):BrowserAction=>
    ({action:'take',group:'owner',labelKey:'takeOver',disabled,...(disabled?{disabledReasonKey:'disabledBusy' as const}:{}),tone:'neutral',primary});
  const handoff=(primary=true):BrowserAction=>
    ({action:'handoff',group:'owner',labelKey:'handToAi',disabled:!!reason||owner==='observing',
      ...(reason??owner==='observing'?{disabledReasonKey:reason??'disabledBusy' as const}:{}),tone:'ai',primary});

  let primary:BrowserAction|null;
  if(owner==='disconnected')primary={action:'reconnect',group:'owner',labelKey:'reconnect',disabled:!!input.busy,tone:'danger',primary:true};
  else if(owner==='agent'||owner==='taking')primary=take(true);
  else primary=handoff(true);
  let secondary:BrowserAction|null=null;

  // The state line, before any message replaces it.
  const labelKey=unverified?'unverified':OWNER_LABEL[owner]==='disconnectedOwned'&&input.source==='chrome'?'disconnectedChrome':OWNER_LABEL[owner];
  let tone:BrowserTone=unverified?'warn':OWNER_TONE[owner];
  let message:BrowserMessage={kind:'owner',tone,group:'owner',textKey:labelKey,role:'status',dismissible:false};
  const last=lastActivity(input.activity),lang=input.lang??readAppLanguage();
  let detail:BrowserControlView['detail']=owner==='agent'&&last?{group:'activity',textKey:receiptSentenceKey(last),params:{target:targetName(last),role:last.target?.role??''},
    named:!!targetName(last),time:browserRelativeTime(last.at,{now:input.now,lang}),timeTitle:browserAbsoluteTime(last.at,lang)}
    :reason?{group:'owner',textKey:reason}:null;

  // Priority, highest first. Each branch may also change the verbs, because what a person should press is part of the
  // same decision as what the bar says.
  if(input.errorCode){
    message={kind:'error',tone:'danger',group:'owner',textKey:'',errorCode:input.errorCode,role:'alert',dismissible:true};
    tone='danger';
    if(input.connectFailed)primary={action:'retry-connect',group:'owner',labelKey:'retryConnect',disabled:!!input.busy,tone:'danger',primary:true};
  }else if(input.grantFailed&&owner==='agent'){
    // The AI still holds the page, only without a grant. Nothing is retried on its own (P0 rule).
    message={kind:'error',tone:'warn',group:'owner',textKey:'grantFailed',role:'alert',dismissible:false};
    tone='warn';primary=take(true);
    secondary=owner==='agent'?{action:'retry-grant',group:'owner',labelKey:'retryGrant',disabled:!!reason,
      ...(reason?{disabledReasonKey:reason}:{}),tone:'warn',primary:false}:null;
  }else if(owner==='taking'||owner==='observing'){
    message={kind:'transition',tone:'ai',group:'owner',textKey:OWNER_LABEL[owner],role:'status',dismissible:false};
    tone='ai';
  }else if(owner==='disconnected'){
    message={kind:'disconnected',tone:'danger',group:'owner',textKey:input.source==='chrome'?'disconnectedChrome':'disconnectedOwned',role:'alert',dismissible:false};
    tone='danger';
  }else if(input.popup?.open){
    const host=(input.popup.host??'').trim();
    message={kind:'popup',tone:'warn',group:'owner',textKey:host?'popupOpen':'popupOpenGeneric',...(host?{params:{host}}:{}),role:'status',dismissible:false};
    tone='warn';
    secondary={action:'close-popup',group:'owner',labelKey:'closePopup',disabled:!!input.busy,tone:'warn',primary:false};
  }else if(input.waiting){
    // The AI asked for a person (C3). For 「페이지를 열어 달라」 the verb is 「직접 열기」: taking control, then a human navigation.
    const openPage=input.waiting.reason==='open-page';
    message={kind:'waiting',tone:'warn',group:'waiting',textKey:WAITING_KEY[input.waiting.reason],role:'status',dismissible:false};
    tone='warn';
    primary=openPage
      ?{action:'take',group:'waiting',labelKey:'openPageAction',disabled:!!input.busy,tone:'warn',primary:true}
      :take(true,!!input.busy);
  }else if(input.handoffReady){
    message={kind:'notice',tone:'info',group:'owner',textKey:'handoffReady',role:'status',dismissible:true};
    tone='info';
  }else if(input.fileNotice){
    message={kind:'notice',tone:'info',group:'owner',textKey:'fileNotice',role:'status',dismissible:true};
    tone='info';
  }else if(blockedVisible(input)){
    message={kind:'blocked',tone:'info',group:'owner',textKey:'blockedClick',role:'status',dismissible:true};
    tone='info';
  }

  if(!showTake&&primary?.action==='take'&&owner==='human')primary=handoff(true);
  if(message.kind!=='owner'&&detail?.group==='owner'&&detail.textKey===message.textKey)detail=null;
  return {tone,labelKey,labelGroup:'owner',detail,message,primary,secondary,humanControlsEnabled,showTake,resendBlocked:unknownReceipt,
    activityCount:input.activity?.length??0};
}

const blockedVisible=(input:BrowserControlInput):boolean=>{
  if(!input.blockedAt)return false;
  const now=input.now??Date.now();
  return now-input.blockedAt<BROWSER_BLOCKED_HINT_MS;
};

const lastActivity=(activity:readonly BrowserActivity[]|undefined):BrowserActivity|null=>
  activity&&activity.length?activity.reduce((latest,item)=>item.at>=latest.at?item:latest):null;

/** The name a sentence puts in 「…」. A missing name is localized from the role by the component, never a raw enum. */
export function targetName(receipt:Pick<BrowserReceipt,'target'>):string{
  return receipt.target?.name?.trim()||'';
}

/** Which `activity.*` sentence a receipt becomes. `reviewed` keeps the action's own sentence: it did happen. */
export function receiptSentenceKey(receipt:Pick<BrowserReceipt,'state'|'action'>):BrowserCopyKey{
  if(receipt.state==='unknown')return 'unknown';
  if(receipt.state==='rejected')return 'rejected';
  return receipt.action==='click'?'clickDone':receipt.action==='fill'?'fillDone':receipt.action==='select'?'selectDone':'done';
}

export interface BrowserActivityRow {
  id:string;
  /** Which 16px icon: MousePointerClick, TextCursorInput or ListChecks; `other` for a receipt that names no action. */
  icon:'click'|'fill'|'select'|'other';
  group:'activity';
  textKey:BrowserCopyKey;
  params:{target:string};
  /** Lookup-only role for an unnamed element; the component never prints this raw protocol value. */
  role:string;
  /** False when the page gave the element no name, so the component can avoid empty 「」 quotes. */
  named:boolean;
  tone:BrowserTone;
  /** `reviewed` rows already carry a person's 「확인했어요」. */
  reviewed:boolean;
  /** The workspace's current receipt: the row a person checks and settles. */
  current:boolean;
  /** For data attributes only; never rendered as text. */
  state:BrowserReceipt['state'];
  /** Empty when the time is not known. */
  time:string;
  timeTitle:string;
  at:number|null;
  actions:BrowserAction[];
}

type ActivityItem=Pick<BrowserReceipt,'id'|'state'|'action'|'target'>&{at?:number};

/**
 * The drawer, newest first. An unknown row is the only one with actions, and they are 「직접 확인하기」 then 「확인했어요」 —
 * never a resend of the action whose outcome nobody knows.
 *
 * With `owner` the actions follow who holds the page: while the AI does, 「직접 확인하기」 (take) comes first and
 * 「확인했어요」 waits, because the host settles only for a person; once a person holds it, only 「확인했어요」 is left —
 * 「직접 하기」 is never offered to someone who already has the page. With `receipt` the workspace's current receipt joins
 * the rows when the activity has no entry for it, and only that row can be settled.
 */
export function browserActivityRows(activity:readonly ActivityItem[]|undefined,options:{now?:number;lang?:Lang;owner?:BrowserOwner;receipt?:ActivityItem|null;busy?:boolean}={}):BrowserActivityRow[]{
  const lang=options.lang??readAppLanguage(),now=options.now??Date.now(),{owner,receipt}=options;
  const items=[...(activity??[])];
  if(receipt){
    const current=items.findIndex(item=>item.id===receipt.id);
    if(current<0)items.push(receipt);
    else items[current]={...items[current],...receipt};
  }
  const aiHolds=owner==='agent'||owner==='taking'||owner==='observing';
  const unknownActions=(item:ActivityItem):BrowserAction[]=>{
    if(receipt&&item.id!==receipt.id)return [];
    const busy=owner==='taking'||!!options.busy;
    const take:BrowserAction={action:'take',group:'activity',labelKey:'checkMyself',disabled:busy,...(busy?{disabledReasonKey:'disabledBusy'}:{}),tone:'warn',primary:true};
    const settle:BrowserAction={action:'settle',group:'activity',labelKey:'checkedIt',disabled:!!options.busy,
      ...(options.busy?{disabledReasonKey:'disabledBusy'}:{}),tone:'neutral',primary:false};
    if(owner===undefined)return [take,settle];
    // The host settles only for a person: while the AI holds the page the second step waits, saying why.
    if(aiHolds)return [take,{...settle,disabled:true,disabledReasonKey:'blockedClick'}];
    return [{...settle,primary:true}];
  };
  const order=(item:ActivityItem)=>item.at??Number.POSITIVE_INFINITY;
  return items.sort((a,b)=>order(b)-order(a)).map(item=>{
    const unknown=item.state==='unknown',name=targetName(item),at=typeof item.at==='number'&&Number.isFinite(item.at)?item.at:null;
    return {
      id:item.id,icon:item.action??'other',group:'activity' as const,textKey:receiptSentenceKey(item),
      params:{target:name},role:item.target?.role??'',named:!!name,
      tone:unknown?'warn':item.state==='rejected'?'info':'neutral',
      reviewed:item.state==='reviewed',current:!!receipt&&item.id===receipt.id,state:item.state,
      time:at===null?'':browserRelativeTime(at,{now,lang}),timeTitle:at===null?'':browserAbsoluteTime(at,lang),at,
      actions:unknown?unknownActions(item):[],
    };
  });
}

/** 「12초 전」, 「2시간 전」 — Intl in the app's language, seconds included (the bar shows a fresh action). */
export function browserRelativeTime(at:number,options:{now?:number;lang?:Lang}={}):string{
  const lang=options.lang??readAppLanguage(),now=options.now??Date.now();
  const seconds=Math.max(0,Math.round((now-at)/1000));
  const [amount,unit]:[number,Intl.RelativeTimeFormatUnit]=
    seconds<60?[seconds,'second']
    :seconds<3600?[Math.floor(seconds/60),'minute']
    :seconds<86400?[Math.floor(seconds/3600),'hour']
    :seconds<2592000?[Math.floor(seconds/86400),'day']
    :[Math.floor(seconds/2592000),'month'];
  return new Intl.RelativeTimeFormat(appLocale(lang),{numeric:'always'}).format(-amount,unit);
}

/** The exact time, for the `title` of a relative one (명세: 「the absolute Intl.DateTimeFormat value in title」). */
export function browserAbsoluteTime(at:number,lang:Lang=readAppLanguage()):string{
  return new Intl.DateTimeFormat(appLocale(lang),{dateStyle:'medium',timeStyle:'short'}).format(new Date(at));
}

export interface BrowserRecoveryCard {
  id:string;
  /** The 14px monogram: the first letter of what the card is titled. */
  monogram:string;
  /** pageTitle, else the host, else the profile name. The recovery store keeps no title or URL (local metadata only),
   *  so only a caller holding a live tab can pass them; a stored task falls back to its profile name. */
  title:string;
  host:string;
  time:string;
  timeTitle:string;
  /** 「확인할 결과 {n}건」 — only when the task left unknown outcomes behind. */
  unknown:number;
  /** The source enum is never printed; the card says which browser it was in words. */
  sourceKey:'sourceOwned'|'sourceChrome';
}

/** 「최근 작업」 cards. Pure: the component adds the History icon and the 「이어가기」 button. */
export function browserRecoveryCard(summary:{id:string;profileName:string;source:'owned'|'chrome';pageTitle?:string|null;pageUrl?:string|null;updatedAt:number;unknown:number},
  options:{now?:number;lang?:Lang}={}):BrowserRecoveryCard{
  const lang=options.lang??readAppLanguage();
  let host='';
  if(summary.pageUrl){try{host=new URL(summary.pageUrl).host;}catch{host='';}}
  const title=(summary.pageTitle??'').trim()||host||summary.profileName;
  return {id:summary.id,monogram:[...title][0]?.toUpperCase()??'?',title,host,
    time:browserRelativeTime(summary.updatedAt,{now:options.now,lang}),timeTitle:browserAbsoluteTime(summary.updatedAt,lang),
    unknown:Math.max(0,Math.trunc(summary.unknown)||0),sourceKey:summary.source==='chrome'?'sourceChrome':'sourceOwned'};
}

/** A copy sentence with its `{name}` parameters filled; an unknown parameter is left as written. */
export function fillBrowserText(text:string,params:BrowserParams={}):string{
  return text.replace(/\{(\w+)\}/g,(token,name:string)=>Object.hasOwn(params,name)?String(params[name]):token);
}

/** The first of `keys` that `group` has. Keys A1 is still adding fall back to the closest existing one, so a component
 *  never prints a key or an empty label while copy and code land in either order. */
export function pickBrowserText(group:object,...keys:string[]):string{
  const record=group as Readonly<Record<string,unknown>>;
  for(const key of keys){const value=record[key];if(typeof value==='string'&&value)return value;}
  return '';
}
