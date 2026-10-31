import {ASSIST_SECRET_TEXT,assistAllowed,assistSignInPage,type AssistDestination} from './helpdeskAssistRecipes';
import type {AssistBrowser,AssistReceiptState} from './helpdeskAssistProtocol';
/** One observed element as a recipe sees it: an opaque reference for this observation, a role and an accessible name. */
export type AssistElement={ref:string;role:string;name:string};
export type AssistObservation={title:string;elements:AssistElement[];secret:boolean;truncated:boolean};
/** `agent`: the help holds the page. `human`: the person holds it (takeover, hand-off, or a navigation the host could not
 * confirm). `gone`: no page any more. */
export type AssistControl='agent'|'human'|'gone';
export type AssistDispatch={state:Extract<AssistReceiptState,'confirmed'|'dispatched-unverified'|'refused'|'unknown'>;note?:string};
export class AssistHumanControl extends Error {constructor(){super('사람이 브라우저를 조작하고 있습니다.');}}
export class AssistDriverUnavailable extends Error {}
/** The common contract of both browsers. A driver is fixed host code: no model ever supplies a script, selector syntax,
 * address or path to it. Addresses come from reviewed recipes; element references from the driver's own observation. */
export interface AssistBrowserDriver {
 readonly kind:AssistBrowser;
 ready():Promise<{available:boolean;reason?:string}>;
 /** Create or resume this run's own workspace (one TaskSpace / the helpdesk's own built-in tab). Never a person's tab. */
 attach(runId:string,link:{spaceId?:number}):Promise<{spaceId?:number}>;
 navigate(url:string,requestId:string):Promise<AssistDispatch>;
 /** The current address from browser state, without reading the document. Checked before every observation. */
 location():Promise<string|null>;
 /** Reads the page only when its current address is one of the step's reviewed destinations and not a sign-in page;
  * otherwise throws AssistHumanControl without reading anything. */
 observe(allow:readonly AssistDestination[]):Promise<AssistObservation>;
 click(ref:string,label:string,requestId:string):Promise<AssistDispatch>;
 /** Types a host-resolved value (an app name, the person's own email) into one observed text field. */
 fill(ref:string,label:string,value:string,requestId:string):Promise<AssistDispatch>;
 /** The person reviewed an unknown outcome; the driver's own ledger, if it keeps one, records that. */
 reviewed(requestId:string):Promise<void>;
 /** Stops whatever this driver is running right now (cancel, shutdown). Its outcome stays unknown and is kept so. */
 abort?():void;
 /** Who holds the page after a dispatch. A navigation that ended the lease continues only when `allowed(address)` holds
 * for the arrived address, judged before anything on the new page is read. */
 settle(allowed:(url:string)=>boolean):Promise<AssistControl>;
 handOff():Promise<void>;
 /** Only after the person pressed 이어서 진행. */
 takeBack():Promise<AssistControl>;
 finish():Promise<void>;
}
const ROLES=new Set(['button','link','a','combobox','listbox','option','menuitem','radio','checkbox','tab','switch','select','summary','textbox','input']);
const clean=(v:string)=>v.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g,' ').replace(/\s+/g,' ').trim();
/** Bounded, secret-checked elements only. The page's text is scanned here for secrets and then dropped: it never reaches a
 * model, a receipt or the store. A page that shows a secret yields no elements at all. */
export function sanitizeObservation(raw:{title?:string;text?:string;elements:{ref:string;role:string;name:string}[]},limit=60):AssistObservation{
 const text=String(raw.text??''),title=clean(String(raw.title??'')).slice(0,120);
 const secret=ASSIST_SECRET_TEXT.test(text)||ASSIST_SECRET_TEXT.test(title)||raw.elements.some(e=>ASSIST_SECRET_TEXT.test(e.name));
 if(secret)return {title:'',elements:[],secret:true,truncated:false};
 const elements:AssistElement[]=[];
 for(const e of raw.elements){
  const role=clean(String(e.role)).toLowerCase().slice(0,30);if(!ROLES.has(role)||typeof e.ref!=='string'||!e.ref||e.ref.length>1024)continue;
  elements.push({ref:e.ref,role:role==='a'?'link':role==='select'?'combobox':role,name:clean(String(e.name)).slice(0,80)});
  if(elements.length>=limit)break;
 }
 return {title,elements,secret:false,truncated:raw.elements.length>elements.length};
}
/** The same test every driver applies before it reads a page. */
export const assistReadable=(url:string|null|undefined,allow:readonly AssistDestination[]):url is string=>!!url&&assistAllowed(url,allow)&&!assistSignInPage(url);
