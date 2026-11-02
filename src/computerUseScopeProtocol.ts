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
/**
 * Remote desktop clients (lower case; mirrored in native Control and the golden contract).
 * An AI typing or clicking
 * into one of these would act on another Mac as a person (DESIGN remote-computer-use RC-4). No AI on this Mac, local or
 * remote, sends input while one is in front or focuses one; a remote AI also sends no pointer input while one is running.
 * An accident guard, not a boundary: whole-Mac access can run code as this user anyway.
 * Provenance: only `com.apple.screensharing` was read from an installed bundle (plutil CFBundleIdentifier, 3호
 * 2026-11-01). Every other entry is the vendor's published identifier and is still OPEN for RC-4: confirm on 1호 and
 * 3호 with codesign/plutil before the live check (ARD, Jump Desktop viewer, TeamViewer, AnyDesk, Parsec, Microsoft
 * Remote Desktop / Windows App, RustDesk). 3호 has Jump Desktop Connect (`com.p5sys.jump.connect`): the receiving side,
 * not a client, so it is not listed.
 */
export const COMPUTER_USE_REMOTE_DESKTOP_CLIENTS:readonly string[]=['com.apple.screensharing','com.apple.remotedesktop','com.p5sys.jump.mac.viewer','com.p5sys.jump.mac.viewer.web',
  'com.teamviewer.teamviewer','com.philandro.anydesk','tv.parsec.www','com.microsoft.rdc.macos','com.microsoft.rdc.mac','com.carriez.rustdesk'];
/**
 * What an AI on another Mac never sends input into (D2): terminals and AI apps (including the agent apps AgentsToZ itself
 * drives: a prompt typed into one runs commands here), script and automation tools, IDEs with a built-in terminal. It is
 * the remote caller's "host" set (src/computerUseCallerHost.ts), refused while in front and as a focus-app target. An
 * accident guard only: a Finder double click on a `.command` file is not covered.
 * Read from installed bundles on 3호 (plutil, 2026-11-01): Terminal, Script Editor, Xcode, VS Code, Orca, Claude,
 * Hermes (`com.nousresearch.hermes`) and ChatGPT.app (which reports `com.openai.codex`). Antigravity
 * (`com.google.antigravity`, src/antigravityAppLaunch.ts), Atlas and cmux are from the one-window refused list verified
 * on a Mac on 2026-10-27 (src/computerUseProtocol.ts COMPUTER_USE_REFUSED_BUNDLES); the rest are published identifiers.
 */
export const COMPUTER_USE_REMOTE_CALLER_REFUSED:readonly string[]=['com.apple.terminal','com.googlecode.iterm2','dev.warp.warp-stable','dev.warp.warp-preview','com.mitchellh.ghostty','com.cmuxterm.app',
  'com.stablyai.orca','com.openai.codex','com.openai.chat','com.openai.atlas','com.anthropic.claudefordesktop','com.nousresearch.hermes','com.google.antigravity',
  'com.apple.scripteditor2','com.apple.automator','com.apple.shortcuts','com.apple.dt.xcode','com.microsoft.vscode','com.microsoft.vscodeinsiders','com.todesktop.230313mzl4w4u92'];
export function remoteDesktopClientBundle(bundleId:string|null|undefined){return !!bundleId&&COMPUTER_USE_REMOTE_DESKTOP_CLIENTS.includes(bundleId.toLowerCase());}
/**
 * The fixed sentences an AI on another Mac reads when this Mac refuses it (DESIGN §10). Phrased for that AI ("그 Mac" is
 * this one). Each carries its code so the receiving host can box `{error, code}` without matching text.
 */
export const COMPUTER_USE_REMOTE_REFUSALS={
  REMOTE_UNSUPPORTED:'그 기기에서는 컴퓨터 유즈를 받을 수 없습니다(macOS 설치 앱 + Control 필요).',
  REMOTE_BLOCKED_BY_PERSON:'그 Mac에서 다른 Mac의 AI를 막아 두었습니다(사람의 설정).',
  REMOTE_DEVICE_BLOCKED:'그 Mac의 사람이 이 기기(또는 이 연결)를 막았습니다.',
  REMOTE_NEEDS_STANDING:'그 Mac의 Control에서 사람이 상시 허용을 켜야 합니다(그 Mac 앞 또는 원격 데스크톱, 암호 가능).',
  REMOTE_APP_SCOPE_ACTIVE:'그 Mac은 지금 한 앱만 허용돼 있어 다른 Mac의 AI는 쓸 수 없습니다.',
  REMOTE_PEER_NOT_READY:'그 Mac이 지금 승인할 수 없는 상태입니다(잠김·보안 입력·권한 꺼짐일 수 있음). 원격 AI는 풀 수 없습니다.',
  // §10 `control-update-required`: told apart from a locked Mac and from a person who has not turned the allowance on.
  REMOTE_CONTROL_UPDATE_REQUIRED:'그 Mac의 AgentsToZ Control이 이전 버전이라 다른 Mac의 AI를 받을 수 없습니다(control-update-required). 그 Mac의 사람이 AgentsToZ Control을 최신으로 설치해야 합니다.',
  REMOTE_RECOVERY_REQUIRED:'그 Mac의 컴퓨터 유즈 패널에서 사람이 검토해야 다시 씁니다(그 Mac 앞·원격 데스크톱·Viewer). 그동안 그 Mac의 AI도 멈춥니다.',
  REMOTE_LOOP_TARGET:'다른 Mac의 AI는 그 Mac의 터미널·AI 앱·스크립트 도구·원격 데스크톱 앱에 입력하지 않습니다.',
  REMOTE_DESKTOP_CLIENT:'원격 데스크톱 앱에는 AI가 입력하지 않습니다(다른 기기로 사람처럼 들어가게 됩니다).',
  REMOTE_RATE_LIMITED:'요청이 많습니다. 잠시 뒤 하세요.',
  REMOTE_OPERATION_REFUSED:'다른 Mac의 AI는 그 Mac의 상시 허용 아래 전체 Mac 컴퓨터 유즈(computer_session)만 씁니다. 한 창·앱 범위·관리 동작은 그 Mac의 사람만 합니다.',
} as const;
export type ComputerUseRemoteRefusalCode=keyof typeof COMPUTER_USE_REMOTE_REFUSALS;
/** A refusal before anything reached Control. `detail` adds what this Mac knows (for example which permission is off). */
export function computerUseRemoteRefusal(code:ComputerUseRemoteRefusalCode,detail?:string):Error&{code:ComputerUseRemoteRefusalCode}{
  return Object.assign(Error(detail?`${COMPUTER_USE_REMOTE_REFUSALS[code]} ${detail}`:COMPUTER_USE_REMOTE_REFUSALS[code]),{code});
}
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
// observe may also take capture (and displayId with it): the same observation captured in one round trip.
const OBSERVE_OPTIONAL=['capture','displayId','maxBytes'];
const OPTIONAL:Record<string,readonly string[]>={'scope-observe':OBSERVE_OPTIONAL,'scope-capture':['maxBytes'],'scope-click':['axOnly']};
function scopeAgentProblem(value:Record<string,unknown>):string{
  const op=String(value.operation),name=op.replace(/^scope-/,'');
  if(op==='scope-status'||op==='scope-request-access')return `${name}에는 다른 항목을 넣지 않습니다`;
  const fields=Object.hasOwn(SCOPE_AGENT_FIELDS,op)?SCOPE_AGENT_FIELDS[op]:undefined;if(!fields)return `알 수 없는 동작 ${name.slice(0,40)}`;
  if(op==='scope-observe'&&'displayId'in value&&value.capture!==true)return `${name}: displayId는 capture:true와 함께만 넣습니다 (받는 항목: grant, epoch, capture, displayId)`;
  const optional=OPTIONAL[op]??[];
  const allowed=new Set(['operation','grant','epoch',...fields,...optional]),keys=Object.keys(value);
  const extra=keys.filter(k=>!allowed.has(k)).map(k=>k.slice(0,40)),missing=[...allowed].filter(k=>!keys.includes(k)&&!optional.includes(k));
  const parts=[extra.length?`넣지 않는 항목 ${extra.join(', ')}`:'',missing.length?`빠진 항목 ${missing.join(', ')}`:''].filter(Boolean);
  // The required fields keep their sentence (an AI reads it to correct itself); optional ones follow it.
  return `${name}: ${parts.length?parts.join(' · '):'값 형식을 확인하세요'} (받는 항목: ${['grant','epoch',...fields].join(', ')})${optional.length?` · 선택 항목: ${optional.join(', ')}`:''}`;
}
export function parseComputerScopeAgentRequest(value:unknown):Record<string,any> {
  const bad=():never=>{throw Error(plain(value)&&typeof value.operation==='string'?`컴퓨터 제어 요청이 올바르지 않습니다(${scopeAgentProblem(value)}).`:'컴퓨터 제어 요청이 올바르지 않습니다.');};
  if(!plain(value)||typeof value.operation!=='string')return bad();
  // request-access carries nothing: the scope is the person's switch and the label is made by the host.
  if(value.operation==='scope-status'||value.operation==='scope-request-access')return exact(value,['operation'])?{operation:value.operation}:bad();
  if(typeof value.grant!=='string'||! /^[a-f0-9]{64}$/.test(value.grant)||!Number.isSafeInteger(value.epoch)||value.epoch<1)return bad();
  const fields=Object.hasOwn(SCOPE_AGENT_FIELDS,value.operation)?SCOPE_AGENT_FIELDS[value.operation]:undefined;if(!fields)return bad();const shaped=exact(value,['operation','grant','epoch',...fields,...(OPTIONAL[value.operation]??[]).filter(k=>k in value)]);
  const bytes=()=>Number.isSafeInteger(value.maxBytes)&&value.maxBytes>=1024&&value.maxBytes<=240000;
  const obs=()=>token(value.observationId),rid=()=>requestId(value.requestId),display=()=>token(value.displayId),xy=()=>coord(value.x)&&coord(value.y);
  switch(value.operation){
    case 'scope-observe':{
      // capture:false is the plain observe; displayId only rides with capture:true.
      const withCapture=value.capture===true,keys=['operation','grant','epoch',...('capture'in value?['capture']:[]),...('displayId'in value?['displayId']:[]),...('maxBytes'in value?['maxBytes']:[])];
      if(!exact(value,keys)||'capture'in value&&typeof value.capture!=='boolean'||'displayId'in value&&(!withCapture||!display())||'maxBytes'in value&&(!withCapture||!bytes()))return bad();
      const {capture:_capture,displayId:_display,maxBytes:_maxBytes,...rest}=value;return withCapture?{...rest,capture:true,...('displayId'in value?{displayId:value.displayId}:{}),...('maxBytes'in value?{maxBytes:value.maxBytes}:{})}:rest;}
    case 'scope-request-human':if(!shaped)return bad();break;
    case 'scope-receipt':if(!shaped||!rid())return bad();break;
    case 'scope-capture':if(!shaped||!obs()||!display()||'maxBytes'in value&&!bytes())return bad();break;
    case 'scope-click':if(!shaped||!obs()||!display()||!rid()||!xy()||!['left','right'].includes(value.button)||![1,2].includes(value.clickCount)||'axOnly'in value&&(typeof value.axOnly!=='boolean'||value.axOnly&&(value.button!=='left'||value.clickCount!==1)))return bad();
      if(value.axOnly===false){const {axOnly:_axOnly,...rest}=value;return rest;}break;
    case 'scope-type-text':if(!shaped||!obs()||!rid()||typeof value.text!=='string'||!value.text.length||Buffer.byteLength(value.text)>4000||value.text.includes('\0'))return bad();break;
    case 'scope-key':if(!shaped||!obs()||!rid()||typeof value.key!=='string'||!( /^[A-Za-z0-9]$/.test(value.key)||(COMPUTER_USE_SCOPE_KEYS as readonly string[]).includes(value.key))||!Array.isArray(value.modifiers)||value.modifiers.length>4||new Set(value.modifiers).size!==value.modifiers.length||value.modifiers.some((m:unknown)=>!(COMPUTER_USE_SCOPE_MODIFIERS as readonly unknown[]).includes(m)))return bad();break;
    case 'scope-scroll':if(!shaped||!obs()||!display()||!rid()||!xy()||![value.deltaX,value.deltaY].every(n=>Number.isInteger(n)&&Math.abs(n)<=1200))return bad();break;
    case 'scope-drag':if(!shaped||!obs()||!display()||!rid()||!xy()||!coord(value.endX)||!coord(value.endY))return bad();break;
    case 'scope-focus-app':if(!shaped||!obs()||!rid()||!token(value.applicationId))return bad();break;
    default:return bad();
  }
  return {...value};
}
