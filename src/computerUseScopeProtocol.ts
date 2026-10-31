/** The v2 broad-scope contract is deliberately separate from the existing exact-window v1 protocol. */
export const COMPUTER_USE_SCOPE_VERSION=2;
export const COMPUTER_USE_SCOPE_PERMISSIONS=['screen','pointer','keyboard'] as const;
export const COMPUTER_USE_SCOPE_OPERATIONS=['scope-status','scope-catalog','scope-request-approval','scope-approval-status','scope-open-grant','scope-observe','scope-capture','scope-click','scope-type-text','scope-key','scope-scroll','scope-drag','scope-focus-app','scope-receipt','scope-revoke','scope-revoke-session','scope-disconnect-owner'] as const;
export const COMPUTER_USE_SCOPE_KEYS=['Enter','Tab','Escape','Backspace','Delete','Space','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Home','End','PageUp','PageDown'] as const;
export const COMPUTER_USE_SCOPE_MODIFIERS=['cmd','ctrl','alt','shift'] as const;
/**
 * A v2 grant lasts until the person switches computer use off, the app or Control restarts, or the AI's connection
 * ends; mirrors native ControlLimits.scope*. `grantMs` (30 days) only bounds the opened grant's expiry and is never shown
 * as a countdown. The newest `receiptsKept` receipts are kept in full; every spent request ID stays refused, and after
 * `actionsPerGrant` actions the grant ends so the AI asks for a new approval.
 */
export const COMPUTER_USE_SCOPE_LIMITS={grantMs:2_592_000_000,receiptsKept:256,actionsPerGrant:100_000} as const;
export type ComputerUseScopeLimits={readonly grantMs:number;readonly receiptsKept:number;readonly actionsPerGrant:number};
export interface ComputerScopeApplication {bundleId:string;teamId:string;codeHash:string;pid:number;processStart:string}
export type ComputerUseScope={kind:'desktop'}|{kind:'application';application:ComputerScopeApplication};
const plain=(v:unknown):v is Record<string,any>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const exact=(v:Record<string,any>,keys:readonly string[])=>Object.keys(v).length===keys.length&&Object.keys(v).every(k=>keys.includes(k));
const token=(v:unknown,max=200)=>typeof v==='string'&&Buffer.byteLength(v)<=max&&/^[\x21-\x7e]+$/.test(v);
const requestId=(v:unknown)=>typeof v==='string'&&/^[A-Za-z0-9_-]{8,128}$/.test(v);
const coord=(v:unknown)=>typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=100000;
/**
 * Mirrors native ScopedProtectedTargets exactly (lower case); both must equal the `scope` section of
 * native/computer-use/Tests/ControlContract/protected-targets.json. Security surfaces also block capture and input
 * natively whenever one of their windows is visible.
 */
export const COMPUTER_USE_SCOPE_PROTECTED_BUNDLES:readonly string[]=['com.intenet.agentstozbycs','com.apple.systempreferences','com.apple.keychainaccess','com.apple.windowserver'];
export const COMPUTER_USE_SCOPE_SECURITY_SURFACES:readonly string[]=['com.apple.loginwindow','com.apple.passwords','com.apple.securityagent','com.apple.securityagenthelper.arm64','com.apple.securityagenthelper.x86_64','com.apple.authorizationhost',
  'com.apple.usernotificationcenter','com.apple.coreservices.uiagent','com.apple.localauthentication.uiagent','com.apple.localauthenticationremoteservice',
  'com.apple.certificateassistant','com.apple.escrowsecurityalert','com.apple.security.keychain-circle-notification'];
export const COMPUTER_USE_SCOPE_PROTECTED_PREFIXES:readonly string[]=['com.intenet.agentstozbycs.','com.apple.securityagent'];
/** Agent applications can be explicitly approved in v2; Control and OS security surfaces remain forbidden. */
export function protectedScopeBundle(bundleId:string){const b=bundleId.toLowerCase();return COMPUTER_USE_SCOPE_PROTECTED_BUNDLES.includes(b)||COMPUTER_USE_SCOPE_SECURITY_SURFACES.includes(b)||COMPUTER_USE_SCOPE_PROTECTED_PREFIXES.some(p=>b.startsWith(p));}
export function parseComputerScopeApplication(value:unknown):ComputerScopeApplication {
  if(!plain(value)||!exact(value,['bundleId','teamId','codeHash','pid','processStart'])||typeof value.bundleId!=='string'||! /^[A-Za-z0-9.-]{1,200}$/.test(value.bundleId)||protectedScopeBundle(value.bundleId)
    ||typeof value.teamId!=='string'||! /^(?:[A-Z0-9]{10})?$/.test(value.teamId)||typeof value.codeHash!=='string'||! /^[a-f0-9]{40,64}$/.test(value.codeHash)
    ||!Number.isSafeInteger(value.pid)||value.pid<1||value.pid>2147483647||typeof value.processStart!=='string'||! /^[1-9][0-9]{0,19}$/.test(value.processStart))throw Error('앱 범위를 확인하지 못했습니다.');
  return {bundleId:value.bundleId,teamId:value.teamId,codeHash:value.codeHash,pid:value.pid,processStart:value.processStart};
}
export function parseComputerUseScope(value:unknown):ComputerUseScope {
  if(!plain(value))throw Error('컴퓨터 제어 범위를 확인하세요.');
  if(value.kind==='desktop'&&exact(value,['kind']))return {kind:'desktop'};
  if(value.kind==='application'&&exact(value,['kind','application']))return {kind:'application',application:parseComputerScopeApplication(value.application)};
  throw Error('컴퓨터 제어 범위를 확인하세요.');
}
export function sameComputerUseScope(a:ComputerUseScope,b:ComputerUseScope){return JSON.stringify(parseComputerUseScope(a))===JSON.stringify(parseComputerUseScope(b));}
/** External agent requests are a closed shape. No scope, permission or caller can be supplied by an agent. */
/** The fields each agent operation takes besides operation/grant/epoch. Names the problem when a request is refused. */
const SCOPE_AGENT_FIELDS:Record<string,readonly string[]>={'scope-observe':[],'scope-request-human':[],'scope-receipt':['requestId'],
  'scope-capture':['observationId','displayId'],'scope-click':['observationId','displayId','requestId','x','y','button','clickCount'],
  'scope-type-text':['observationId','requestId','text'],'scope-key':['observationId','requestId','key','modifiers'],
  'scope-scroll':['observationId','displayId','requestId','x','y','deltaX','deltaY'],'scope-drag':['observationId','displayId','requestId','x','y','endX','endY'],
  'scope-focus-app':['observationId','requestId','applicationId']};
/** Which field is unexpected, missing or malformed. An AI added requestId to observe and only saw a generic refusal (1호, 2026-10-31). */
function scopeAgentProblem(value:Record<string,unknown>):string{
  const op=String(value.operation),name=op.replace(/^scope-/,'');
  if(op==='scope-status'||op==='scope-request-access')return `${name}에는 다른 항목을 넣지 않습니다`;
  const fields=Object.hasOwn(SCOPE_AGENT_FIELDS,op)?SCOPE_AGENT_FIELDS[op]:undefined;if(!fields)return `알 수 없는 동작 ${name.slice(0,40)}`;
  const allowed=new Set(['operation','grant','epoch',...fields]),keys=Object.keys(value);
  const extra=keys.filter(k=>!allowed.has(k)).map(k=>k.slice(0,40)),missing=[...allowed].filter(k=>!keys.includes(k));
  const parts=[extra.length?`넣지 않는 항목 ${extra.join(', ')}`:'',missing.length?`빠진 항목 ${missing.join(', ')}`:''].filter(Boolean);
  return `${name}: ${parts.length?parts.join(' · '):'값 형식을 확인하세요'} (받는 항목: ${['grant','epoch',...fields].join(', ')})`;
}
export function parseComputerScopeAgentRequest(value:unknown):Record<string,any> {
  const bad=():never=>{throw Error(plain(value)&&typeof value.operation==='string'?`컴퓨터 제어 요청이 올바르지 않습니다(${scopeAgentProblem(value)}).`:'컴퓨터 제어 요청이 올바르지 않습니다.');};
  if(!plain(value)||typeof value.operation!=='string')return bad();
  // request-access carries nothing: the scope is the person's switch and the label is made by the host.
  if(value.operation==='scope-status'||value.operation==='scope-request-access')return exact(value,['operation'])?{operation:value.operation}:bad();
  if(typeof value.grant!=='string'||! /^[a-f0-9]{64}$/.test(value.grant)||!Number.isSafeInteger(value.epoch)||value.epoch<1)return bad();
  const fields=Object.hasOwn(SCOPE_AGENT_FIELDS,value.operation)?SCOPE_AGENT_FIELDS[value.operation]:undefined;if(!fields)return bad();const shaped=exact(value,['operation','grant','epoch',...fields]);
  const obs=()=>token(value.observationId),rid=()=>requestId(value.requestId),display=()=>token(value.displayId),xy=()=>coord(value.x)&&coord(value.y);
  switch(value.operation){
    case 'scope-observe':case 'scope-request-human':if(!shaped)return bad();break;
    case 'scope-receipt':if(!shaped||!rid())return bad();break;
    case 'scope-capture':if(!shaped||!obs()||!display())return bad();break;
    case 'scope-click':if(!shaped||!obs()||!display()||!rid()||!xy()||!['left','right'].includes(value.button)||![1,2].includes(value.clickCount))return bad();break;
    case 'scope-type-text':if(!shaped||!obs()||!rid()||typeof value.text!=='string'||!value.text.length||Buffer.byteLength(value.text)>4000||value.text.includes('\0'))return bad();break;
    case 'scope-key':if(!shaped||!obs()||!rid()||typeof value.key!=='string'||!( /^[A-Za-z0-9]$/.test(value.key)||(COMPUTER_USE_SCOPE_KEYS as readonly string[]).includes(value.key))||!Array.isArray(value.modifiers)||value.modifiers.length>4||new Set(value.modifiers).size!==value.modifiers.length||value.modifiers.some((m:unknown)=>!(COMPUTER_USE_SCOPE_MODIFIERS as readonly unknown[]).includes(m)))return bad();break;
    case 'scope-scroll':if(!shaped||!obs()||!display()||!rid()||!xy()||![value.deltaX,value.deltaY].every(n=>Number.isInteger(n)&&Math.abs(n)<=1200))return bad();break;
    case 'scope-drag':if(!shaped||!obs()||!display()||!rid()||!xy()||!coord(value.endX)||!coord(value.endY))return bad();break;
    case 'scope-focus-app':if(!shaped||!obs()||!rid()||!token(value.applicationId))return bad();break;
    default:return bad();
  }
  return {...value};
}
