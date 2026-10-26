import {WorkroomBrowserError,type BrowserErrorCode} from './workroomBrowserErrorCodes';
/** Trusted Workroom management and a separately granted, bounded agent surface. No raw CDP. */
export const WORKROOM_BROWSER_PATH='/api/agent-runtime/workroom-browser';
export const WORKROOM_BROWSER_AGENT_PATH='/api/workroom-browser-agent';
export type BrowserOwner='human'|'observing'|'agent'|'taking'|'disconnected';
export type BrowserActionState='completed'|'unknown'|'rejected'|'reviewed';
export type BrowserReceipt={id:string;state:BrowserActionState;action?:'click'|'fill'|'select';target?:{role:string;name:string};at?:number};
/** Local UI activity only, never persisted or included in an agent response. Target names are capped at 80 characters. */
export type BrowserActivity=BrowserReceipt & {action:'click'|'fill'|'select';at:number};
/** Local UI only, never persisted or echoed to agents. The note is untrusted plain text, capped at 120 characters. */
export type BrowserWaiting={reason:'login'|'captcha'|'confirm'|'file'|'open-page';note?:string;url?:string;at:number};
export type BrowserPage={id:string;title:string;url:string};
/** One observed element. `selector` is its reference for this observation only (a key the host resolves to the node it
 * saw, never re-queried); `frame` names the frame it lives in (omitted for the main document); `shadow` marks an element
 * inside an open shadow root. A closed shadow root is never read: it is listed in `unobservable` instead. A list shows
 * its first 12 `options`; `moreOptions` counts the rest, which select still reaches by exact value or label. An option's
 * value and label are cut at 60 characters, and `truncated` marks one that was: select takes it by the text shown. */
export type BrowserElement={selector:string;role:string;name:string;frame?:string;shadow?:true;options?:{value:string;label:string;selected?:true;truncated?:true}[];moreOptions?:number};
/** A child frame observed through its own isolated world: same-origin frames in the page's session, cross-origin
 * frames through the page's own auto-attached iframe targets. `url` is origin and path only. */
export type BrowserFrameSummary={ref:string;url:string;title:string;text:string;crossOrigin:boolean;elements:number;truncated?:true};
/** What this observation could not read, said out loud instead of silently missing. */
export type BrowserUnobservable={kind:'closed-shadow-root'|'shadow-check-limit'|'frame-unavailable'|'frame-limit';frame:string;selector?:string;url?:string;count?:number};
export type BrowserScroll={x:number;y:number;width:number;height:number;viewportWidth:number;viewportHeight:number};
export type BrowserObservation={id:string;url:string;title:string;text:string;elements:BrowserElement[];frames?:BrowserFrameSummary[];unobservable?:BrowserUnobservable[];scroll?:BrowserScroll;truncated?:{elements?:true;text?:true};capturedAt:string;untrusted:true};
/** `page` is the active tab. `tabs` is this Workroom's own tab set (the active tab included): the only tabs any agent
 * operation can name. A person's other tabs and another Workroom's tabs are never in it. */
export type BrowserWorkspace={id:string;sessionId:string;targetId:string;profileId:string;profileName:string;source?:'owned'|'chrome';page:BrowserPage|null;tabs?:BrowserPage[];owner:BrowserOwner;epoch:number;observation:BrowserObservation|null;connection:'connected'|'disconnected';profileVerification:'user-confirmed'|'unverified';receipt?:BrowserReceipt;activity?:BrowserActivity[];waiting?:BrowserWaiting};
/** At most this many tabs in one Workroom's set. */
export const BROWSER_TAB_LIMIT=6;
export type BrowserRecoverySummary={id:string;sessionId:string;profileId:string;profileName:string;source:'owned'|'chrome';pageId:string|null;updatedAt:number;unknown:number};
export type WorkroomBrowserRequest=
 |{operation:'profiles'}
 |{operation:'recoveries';sessionId:string;targetId:string}
 |{operation:'connect';sessionId:string;targetId:string;profileId:string;recoveryId?:string}
 /** `profileKey` is the native profile the page runs in (the panel's request intent). */
 |{operation:'connect-owned';sessionId:string;targetId:string;port:number;pageId:string;recoveryId?:string;profileKey?:string}
 |{operation:'status'|'pages'|'take'|'resume'|'detach';workspaceId:string}
 /** A person picks a tab: one already in the set becomes active; `add` puts another one in the set; otherwise the set is
  * replaced by this tab. `release` takes a tab out of the set without closing it. */
 |{operation:'select';workspaceId:string;pageId:string;confirmProfile:true;add?:true}
 |{operation:'release';workspaceId:string;pageId:string}
 |{operation:'grant';workspaceId:string}
 |{operation:'settle';workspaceId:string;requestId:string};
/** Agent operations. click/fill/select change the page and carry a receipt under a unique requestId; an unknown outcome
 * is inspected, never sent again. observe/scroll/wait/screenshot/receipt carry none, and neither do tabs (this
 * Workroom's own tab set), switch-tab (another tab of that set becomes active and is observed), and request-human
 * (local waiting metadata only; the first request in an epoch wins, with no page action). */
export const BROWSER_AGENT_OPERATIONS=['observe','click','fill','select','scroll','wait','screenshot','receipt','tabs','switch-tab','request-human'] as const;
export type BrowserAgentOperation=typeof BROWSER_AGENT_OPERATIONS[number];
export type BrowserAgentRequest={workspaceId:string;grant:string;operation:BrowserAgentOperation;epoch:number;observationId?:string;requestId?:string;selector?:string;text?:string;frame?:string;value?:string;deltaX?:number;deltaY?:number;to?:'top'|'bottom';until?:'selector'|'text'|'navigation';timeoutMs?:number;tab?:string;reason?:BrowserWaiting['reason'];note?:string;url?:string};
/** A screenshot goes back to the caller only; the host keeps it in no workspace state, journal or file. */
export type BrowserScreenshot={mimeType:'image/jpeg';data:string;width:number;height:number};
export type BrowserWait={until:'selector'|'text'|'navigation';satisfied:boolean;elapsedMs:number};
export type WorkroomBrowserResult={success:true;profiles?:{id:string;profileName:string;accountLabel:string|null}[];workspace?:BrowserWorkspace;pages?:BrowserPage[];grant?:string;recoveries?:BrowserRecoverySummary[];screenshot?:BrowserScreenshot;waited?:BrowserWait}|{success:false;error:string;code:BrowserErrorCode};
export function workroomBrowserUrl(raw:string):URL {
 let url:URL;try{url=new URL(raw);}catch(e){throw new WorkroomBrowserError('invalid-address',e instanceof Error?e.message:String(e));}if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.href.length>4096)throw new WorkroomBrowserError('invalid-address','HTTP(S) page required.');return url;
}
export function parseWorkroomBrowserRequest(value:unknown):WorkroomBrowserRequest {
 if(!value||typeof value!=='object'||Array.isArray(value))throw new WorkroomBrowserError('generic','Invalid browser request.');
 const r=value as Record<string,unknown>,op=r.operation;
 const keys:Record<string,string[]>={profiles:[],recoveries:['sessionId','targetId'],connect:['sessionId','targetId','profileId','recoveryId'],'connect-owned':['sessionId','targetId','port','pageId','recoveryId','profileKey'],status:['workspaceId'],pages:['workspaceId'],take:['workspaceId'],resume:['workspaceId'],detach:['workspaceId'],select:['workspaceId','pageId','confirmProfile','add'],release:['workspaceId','pageId'],grant:['workspaceId'],settle:['workspaceId','requestId']};
 if(typeof op!=='string'||!keys[op]||Object.keys(r).some(k=>k!=='operation'&&!keys[op]!.includes(k)))throw new WorkroomBrowserError('generic','Unsupported browser operation.');
 for(const key of keys[op]!){if((key==='recoveryId'||key==='add'||key==='profileKey')&&r[key]===undefined)continue;if(key==='port'?typeof r[key]!=='number'||!Number.isInteger(r[key])||(r[key] as number)<1||(r[key] as number)>65535:key==='confirmProfile'||key==='add'?r[key]!==true:typeof r[key]!=='string'||!(r[key] as string).length||(r[key] as string).length>180)throw new WorkroomBrowserError('generic','Invalid browser binding.');}
 return r as WorkroomBrowserRequest;
}
/** The agent request's shape, before any binding is looked up. Every field is bounded; refs are opaque strings. */
export function parseBrowserAgentRequest(value:unknown):BrowserAgentRequest {
 if(!value||typeof value!=='object'||Array.isArray(value))throw new WorkroomBrowserError('generic','Invalid agent request.');
 const r=value as Record<string,unknown>;
 const allowed=['workspaceId','grant','operation','epoch','observationId','requestId','selector','text','frame','value','deltaX','deltaY','to','until','timeoutMs','tab','reason','note','url'];
 if(Object.keys(r).some(k=>!allowed.includes(k))||!(BROWSER_AGENT_OPERATIONS as readonly unknown[]).includes(r.operation)||typeof r.workspaceId!=='string'||typeof r.grant!=='string'||!Number.isSafeInteger(r.epoch))throw new WorkroomBrowserError('generic','Invalid agent request.');
 const string=(key:string,max:number)=>r[key]===undefined||typeof r[key]==='string'&&(r[key] as string).length<=max;
 const integer=(key:string,min:number,max:number)=>r[key]===undefined||Number.isSafeInteger(r[key])&&(r[key] as number)>=min&&(r[key] as number)<=max;
 if(!string('observationId',64)||!string('requestId',128)||!string('selector',1024)||!string('text',12000)||!string('value',1000)||!string('tab',180)
  ||r.frame!==undefined&&(typeof r.frame!=='string'||!/^(?:main|f[1-9]\d?)$/.test(r.frame))
  ||!integer('deltaX',-20000,20000)||!integer('deltaY',-20000,20000)||!integer('timeoutMs',100,10000)
  ||r.to!==undefined&&r.to!=='top'&&r.to!=='bottom'||r.until!==undefined&&!['selector','text','navigation'].includes(r.until as string))throw new WorkroomBrowserError('generic','Invalid agent request.');
 if(r.operation==='request-human'){
  if(!['login','captcha','confirm','file','open-page'].includes(r.reason as string)||!string('note',12000))throw new WorkroomBrowserError('generic','Invalid human request.');
  if(r.url!==undefined){
   if(r.reason!=='open-page'||typeof r.url!=='string')throw new WorkroomBrowserError('invalid-address','Only open-page may request an HTTP(S) address.');
   workroomBrowserUrl(r.url);
  }
  // Treat markup literally; collapse control characters and truncate before it reaches local UI state.
  return {...r,...(typeof r.note==='string'?{note:r.note.replace(/[\u0000-\u001f\u007f]/g,' ').slice(0,120)}:{})} as BrowserAgentRequest;
 }
 if(r.reason!==undefined||r.note!==undefined||r.url!==undefined)throw new WorkroomBrowserError('generic','Human request fields require request-human.');
 return r as BrowserAgentRequest;
}
