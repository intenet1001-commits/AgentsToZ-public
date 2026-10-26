import {WorkroomBrowserError,type BrowserErrorCode} from './workroomBrowserErrorCodes';
import {OWNED_BROWSER_SEARCH,normalizeOwnedBrowserAddress} from './workroomBrowserNavigation';

/**
 * Pure helpers for the browser bar's omnibox (K1, 명세 「Toolbar and omnibox」). No React, no copy lookup and no host
 * call: the toolbar renders what these decide, and the unit tests fix the decisions.
 *
 * The address-or-search rule is **not** re-implemented here. Every decision runs through
 * `normalizeOwnedBrowserAddress` (src/workroomBrowserNavigation.ts), so the field, Enter, the 「Google 검색」 hint and the
 * host can never disagree about what a typed line means.
 */
export const OMNIBOX_MAX_LENGTH=4096;

/** What the field is showing. `http-local` is a development server (loopback or a private network address). */
export type OmniboxKind='https'|'http-local'|'http-remote'|'search';
/** Which 16px leading glyph: Lock, Globe, ShieldAlert, Search. */
export type OmniboxIdentity='https'|'local'|'http'|'search';
/** A key of `workroomBrowserUiCopy(lang).toolbar`; the toolbar reads the sentence, this module never does. */
export type OmniboxIdentityTitleKey='identityHttps'|'identityLocal'|'identityPrivateNetwork'|'identityHttp'|'identitySearch';

/**
 * The blurred one-line display: the host is the strong part, the path and query are dimmed, and the scheme is hidden
 * (명세: 「host in var(--ink), path and query in var(--ink-3), scheme hidden」).
 * `text` is host + rest, which is also what a person sees as 「unchanged」 when the field is not focused.
 * `full` is what focus reveals and what Escape restores.
 */
export interface OmniboxDisplay {
  kind:OmniboxKind;
  identity:OmniboxIdentity;
  identityTitleKey:OmniboxIdentityTitleKey;
  /** Host and port, or the search term when the line is a search. */
  host:string;
  /** Path, query and hash — dimmed. Empty for a bare host and for a search. */
  rest:string;
  text:string;
  full:string;
  /** True while this line would open Google, so the bar shows the 「Google 검색」 chip. */
  search:boolean;
}

/** Loopback: this very Mac. The only case 「이 기기의 개발 서버」 is an honest title. */
const LOOPBACK=/^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\]|0\.0\.0\.0)$/i;
/** A development server on the local network: RFC1918 IPv4, link-local, CGNAT and a `.local` name. */
const PRIVATE_HOST=/^(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|169\.254(?:\.\d{1,3}){2}|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])(?:\.\d{1,3}){2}|[^.]+\.local)$/i;

/** Where an `http://` host sits: this Mac, the local network, or the public internet. */
export function omniboxHttpScope(hostname:string):'loopback'|'private'|'remote'{
  // URL.hostname keeps an IPv6 literal in brackets, which is how LOOPBACK spells [::1].
  if(LOOPBACK.test(hostname))return 'loopback';
  return PRIVATE_HOST.test(hostname)?'private':'remote';
}

const displayOf=(url:URL):{host:string;rest:string}=>{
  const rest=`${url.pathname==='/'?'':url.pathname}${url.search}${url.hash}`;
  return {host:url.host,rest};
};

/**
 * The display for a page URL (the field's blurred value). A line that is not an HTTP(S) URL is shown as typed with the
 * search glyph, because that is what pressing Enter would do with it.
 */
export function omniboxDisplay(value:string):OmniboxDisplay{
  const raw=value.trim();
  if(!raw)return {kind:'search',identity:'search',identityTitleKey:'identitySearch',host:'',rest:'',text:'',full:'',search:false};
  let url:URL|null=null;
  try{url=new URL(raw);}catch{url=null;}
  if(!url||!['http:','https:'].includes(url.protocol))return searchDisplay(raw);
  const {host,rest}=displayOf(url);
  if(url.protocol==='https:')return {kind:'https',identity:'https',identityTitleKey:'identityHttps',host,rest,text:host+rest,full:url.href,search:false};
  const scope=omniboxHttpScope(url.hostname);
  // A dev server stays calm (Globe), the public internet is warned about (ShieldAlert). A private network address is a
  // dev server too; its tooltip names the network rather than this Mac.
  return scope==='remote'
    ? {kind:'http-remote',identity:'http',identityTitleKey:'identityHttp',host,rest,text:host+rest,full:url.href,search:false}
    : {kind:'http-local',identity:'local',identityTitleKey:scope==='loopback'?'identityLocal':'identityPrivateNetwork',host,rest,text:host+rest,full:url.href,search:false};
}

const searchDisplay=(term:string):OmniboxDisplay=>
  ({kind:'search',identity:'search',identityTitleKey:'identitySearch',host:term,rest:'',text:term,full:term,search:true});

/** What a typed line means. `invalid` carries the same code the navigation module raises, never a raw message. */
export type OmniboxIntent=
  |{kind:'empty'}
  |{kind:'navigate';url:string;display:OmniboxDisplay}
  |{kind:'search';url:string;term:string;display:OmniboxDisplay}
  |{kind:'invalid';code:BrowserErrorCode};

/**
 * The one decision Enter, the trailing CornerDownLeft button and the 「Google 검색」 chip all read. A credentialled URL,
 * a control character, a non-HTTP scheme and anything over 4096 characters are refused here — the field never opens them.
 */
export function omniboxIntent(typed:string):OmniboxIntent{
  const value=typed.trim();
  if(!value)return {kind:'empty'};
  if(value.length>OMNIBOX_MAX_LENGTH)return {kind:'invalid',code:'invalid-address'};
  let href:string;
  try{href=normalizeOwnedBrowserAddress(value);}
  catch(error){return {kind:'invalid',code:error instanceof WorkroomBrowserError?error.code:'invalid-address'};}
  if(href.startsWith(OWNED_BROWSER_SEARCH))return {kind:'search',url:href,term:value,display:searchDisplay(value)};
  return {kind:'navigate',url:href,display:omniboxDisplay(href)};
}

/** Whether this line would open Google — the 「Google 검색」 chip, and nothing else, decides on this. */
export function omniboxSearchHint(typed:string):boolean{return omniboxIntent(typed).kind==='search';}

/**
 * Whether the text differs from the page it is showing, which is the only thing the trailing open button appears for.
 * Both what a person reads while blurred (host + path) and the full URL count as unchanged, and so does a line that
 * normalizes to the same page (`example.com` for `https://example.com/`).
 */
export function omniboxDirty(typed:string,pageUrl:string|null|undefined):boolean{
  const value=typed.trim(),page=(pageUrl??'').trim();
  if(!value)return !!page;
  if(!page)return true;
  const display=omniboxDisplay(page);
  if(value===page||value===display.text||value===display.full)return false;
  const intent=omniboxIntent(value);
  return !(intent.kind==='navigate'&&intent.url===display.full);
}

/** Escape puts this back in the field: the page's own full URL, or nothing when no page is open. */
export function omniboxRevert(pageUrl:string|null|undefined):string{
  const page=(pageUrl??'').trim();
  return page?omniboxDisplay(page).full:'';
}

/** While the field is neither focused nor dirty it follows the page (명세 「Follow the page」). */
export function omniboxFollowValue(input:{pageUrl:string|null|undefined;typed:string;focused:boolean}):string|null{
  if(input.focused||omniboxDirty(input.typed,input.pageUrl))return null;
  return omniboxRevert(input.pageUrl);
}

/** The field is read-only for every owner except a connected person; ⌘L still focuses it so the address can be copied. */
export function omniboxReadOnly(owner:string,connection:'connected'|'disconnected'='connected'):boolean{
  return !(owner==='human'&&connection==='connected');
}
