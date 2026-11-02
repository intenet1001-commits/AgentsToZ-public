import {CommunityReceiveAuthorization} from './communityReceiveAuthorization';
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync,renameSync,statSync,unlinkSync,writeFileSync} from 'node:fs';
import {ComputerCallerRegistry,computerCallerGeneration,type AuthenticatedComputerCaller} from './computerUseCaller';
import {ComputerApprovalVerifier} from './computerUseApproval';
import {ComputerUseHost} from './computerUseHost';
import {nativeComputerWorker,RevokingComputerUseChannel,type ComputerUseNativeChannel} from './computerUseNative';
import type {ComputerUseRecovery} from './computerUseRecovery';
import {COMPUTER_USE_CONTROL_PROTOCOL,COMPUTER_USE_WORKER_PROTOCOL,controlAdvertisesScreen,parseComputerTarget} from './computerUseProtocol';
import {ComputerUseScopeHost} from './computerUseScopeHost';
import {remoteCallerHost,unknownCallerHost,type ComputerCallerHost,type ComputerCallerHostResolver,type ComputerCallerOrigin} from './computerUseCallerHost';
import {COMPUTER_USE_REMOTE_REFUSALS,COMPUTER_USE_SCOPE_LIMITS,computerUseRemoteRefusal,parseComputerUseScope,protectedScopeBundle,sameComputerUseScope,type ComputerUseRemoteRefusalCode,type ComputerUseScope} from './computerUseScopeProtocol';
import {noRemoteHumanInput,type RemoteHumanInputReader} from './computerUseRemoteHumanInput';


const LEASE_MS=75_000,MAX_CONNECTIONS=64,NATIVE_STATUS_CACHE_MS=10_000,ACCESS_REQUEST_INTERVAL_MS=60_000;
/** Under the standing allowance another connection may take over a grant left this long without a request. */
export const STANDING_IDLE_MS=120_000;
const STANDING_GRANTED='상시 허용으로 바로 허용됐습니다. status로 grant와 epoch를 받아 observe부터 시작하세요.';
const STANDING_PENDING='상시 허용이 켜져 있어 Control이 곧 허용합니다. 잠시 뒤 status로 grant를 확인하세요. 같은 요청을 다시 보내지 마세요.';
const ACCESS_OFF='컴퓨터 유즈가 꺼져 있습니다. 사람이 AgentsToZ의 도구 및 설정 → 컴퓨터 유즈에서 켜야 합니다. AI는 켜거나 승인할 수 없습니다.';
const ACCESS_PENDING='사람에게 AgentsToZ의 도구 및 설정 → 컴퓨터 유즈에서 「승인 검토 열기」를 누르고 Control에서 Touch ID로 승인해 달라고 알리세요. 승인되면 status로 grant와 epoch를 받습니다. 같은 요청을 다시 보내지 마세요.';
const HOST_NAMES:Record<string,string>={'com.intenet.agentstozbycs':'AgentsToZ','com.stablyai.orca':'Orca','com.openai.codex':'Codex','com.openai.chat':'ChatGPT',
  'com.anthropic.claudefordesktop':'Claude','com.apple.terminal':'Terminal','com.googlecode.iterm2':'iTerm','dev.warp.warp-stable':'Warp','com.mitchellh.ghostty':'Ghostty'};
/** The request's name in Control's review: who asks (MCP client name and the apps it runs in, read from its process
 *  ancestry) and the scope the person switched on. Built here, never from an AI body. */
function accessLabel(client:string,host:ComputerCallerHost,scope:ComputerUseScope){
  const where=host.state==='known'&&host.bundleIds.length?host.bundleIds.map(id=>HOST_NAMES[id.toLowerCase()]??id).join('/'):'실행 앱 미확인';
  return [client,where,scope.kind==='desktop'?'전체 Mac':scope.application.bundleId].join(' · ');
}
const NATIVE_STATUS_CODES=new Set(['signed-main-required','signed-main-link-required','signed-helper-required','helper-unavailable','invalid-native-response','native-outcome-unknown','unsupported-platform']);
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const plain=(v:unknown):v is Record<string,any>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const exact=(v:unknown,keys:string[]):v is Record<string,any>=>plain(v)&&Object.keys(v).length===keys.length&&Object.keys(v).every(k=>keys.includes(k));

// ---- Remote computer use: an AI on another community Mac (docs/design/remote-computer-use-2026-11-01/DESIGN.md) ----
/** Remote connections: 4 per sending device and 16 in all, inside the 64 connections (§8.7). */
const REMOTE_PER_DEVICE=4,REMOTE_TOTAL=16;
/** One remote request-access per connection per 10 s: nobody is asked, so no minute is needed (§8.7). */
export const REMOTE_ACCESS_INTERVAL_MS=10_000;
/** Request-access reads the grant twice, this far apart, before it cancels the request (RC-18: now or never). */
const REMOTE_GRANT_READ_GAP_MS=500;
/** The panel's 「끊기」 blocks that connection for 30 min by default; a person may choose 1 min to a day. */
const REMOTE_CONNECTION_BLOCK_MINUTES=30,REMOTE_BLOCK_MAX_MINUTES=1_440;
const REMOTE_BLOCKED_DEVICES_MAX=64,REMOTE_BLOCKED_CONNECTIONS_MAX=256,REMOTE_SETTINGS_FILE_MAX=256*1024;
/**
 * D11 (2026-11-01): another Mac's AI may use the real pointer as a local AI may; the price is said where it starts
 * (RC-17). A pointer action that ends unknown or as human-takeover halts all AI computer use on that Mac (its own AIs
 * too) until a person reviews it there (D5), so background typing and keys come first.
 */
const REMOTE_POINTER_RISK='포인터 동작(오른쪽·두 번 클릭, 스크롤, 끌기, 누를 요소가 없는 클릭)이 결과 불명이나 사람 개입(human-takeover)으로 끝나면 그 Mac의 사람이 검토할 때까지 그 Mac의 AI 컴퓨터 유즈 전체가 멈추니, 배경 type-text·key(Page Down 등)를 먼저 쓰세요.';
const REMOTE_GRANTED=`그 Mac의 상시 허용으로 바로 허용됐습니다. status로 grant와 epoch를 받아 observe {capture:true}부터 시작하세요. ${REMOTE_POINTER_RISK}`;
const REMOTE_READY=`그 Mac의 상시 허용 아래 전체 Mac만 씁니다. grant가 없으면 request-access를 한 번 보내세요. 바로 허용되지 않으면 대기 없이 취소되고 그 Mac의 사람에게 묻지 않습니다. ${REMOTE_POINTER_RISK}`;
const OTHER_IN_USE_STANDING='다른 AI 연결이 작업 중이라 승인 요청을 Control에 보내지 않았습니다. 그 연결이 2분 동안 아무 요청도 하지 않고 사람이 직접 하기 중이 아니면 넘겨받을 수 있습니다. 잠시 뒤 상태를 확인하고 request-access를 한 번 다시 보내세요.';
const OTHER_IN_USE_PERSON='Mac의 사람이 Control 막대에서 직접 하기 중입니다(person-has-control). 승인 요청을 다시 보내지 말고 사람이 다시 넘겨준 뒤 상태를 확인하세요.';
const OTHER_PENDING='다른 승인 요청이 Control에서 대기 중입니다. 그 요청이 끝난 뒤 다시 요청하세요.';
const DEVICE_ID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,CONNECTION_TAG=/^[a-f0-9]{32}$/;
/** Everything another Mac's AI can ask: the whole-Mac agent operations. No v1 window, switch, approval, review or setting (RC-3). */
const REMOTE_OPERATIONS=new Set(['scope-status','scope-request-access','scope-observe','scope-capture','scope-click','scope-type-text','scope-key','scope-scroll','scope-drag','scope-focus-app','scope-receipt','scope-request-human']);
/**
 * Who sends a remote call, as the receiving sidecar knows it: `deviceId` is the sending device the community mailbox
 * recorded (never the request body's), `deviceName` its self-chosen name there, `instance` the 32-hex connection tag of
 * its MCP connection. `client`/`host` (its MCP client and host app) are the sender's claims, for the label only.
 */
export interface ComputerUseRemotePeer {deviceId:string;deviceName:string;instance:string;client?:string;host?:string}
function parseRemotePeer(value:unknown):ComputerUseRemotePeer{
  const bad=()=>Error('원격 연결을 확인하지 못했습니다.');
  if(!plain(value)||Object.keys(value).some(k=>!['deviceId','deviceName','instance','client','host'].includes(k)))throw bad();
  const deviceId=typeof value.deviceId==='string'?value.deviceId.toLowerCase():'';
  if(!DEVICE_ID.test(deviceId)||typeof value.instance!=='string'||!CONNECTION_TAG.test(value.instance)||typeof value.deviceName!=='string'||value.deviceName.length>200)throw bad();
  for(const k of ['client','host'] as const)if(k in value&&(typeof value[k]!=='string'||value[k].length>200))throw bad();
  return {deviceId,deviceName:value.deviceName,instance:value.instance,...(typeof value.client==='string'?{client:value.client}:{}),...(typeof value.host==='string'?{host:value.host}:{})};
}
/**
 * Control refuses a label with a control or format character (Swift CharacterSet.controlCharacters is Cc + Cf), and a
 * bidi or zero-width character would make the name the person reads in Control differ from the one it is. Removed, with
 * line separators and lone surrogates; whitespace runs become one space; cut by code points (never half an emoji).
 */
const UNSAFE_LABEL_CHARACTERS=/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/gu,UNSAFE_LABEL_CHARACTER=/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;
function labelPart(value:unknown,max:number){
  if(typeof value!=='string')return '';
  const chars=Array.from(value.replace(UNSAFE_LABEL_CHARACTERS,'').replace(/\s+/g,' ').trim());
  return chars.slice(0,max).join('').trim();
}
/** The community endpoint name of a device's OPS profile is `<device> / 아젠투지(OPS)`: the device is the part a person knows. */
const withoutOpsSuffix=(name:string)=>name.replace(UNSAFE_LABEL_CHARACTERS,'').replace(/\s*\/\s*아젠투지\(OPS\)\s*$/,'');
/** The device name a remote connection shows: at most 24 characters of the sender's own name. */
export const remoteDeviceName=(name:unknown)=>labelPart(typeof name==='string'?withoutOpsSuffix(name):'',24)||'이름 없음';
/**
 * The remote grant's name in Control's bar and menu (「중단: …」) and in this Mac's panel (RC-10, §7.3):
 * `원격 <device ≤24> (<deviceId 4>) / 연결 <code 8> / <client ≤20>·<host ≤16> · 전체 Mac`, at most 100 UTF-16 units.
 * The client and host parts go first when it is too long; the device code and connection code always stay.
 */
export function remoteAccessLabel(peer:{deviceId:string;deviceName:string;client?:string;host?:string},connectionCode:string){
  const make=(name:string,who:string)=>`원격 ${name} (${peer.deviceId.slice(0,4)}) / 연결 ${connectionCode.slice(0,8)}${who?' / '+who:''} · 전체 Mac`;
  const name=Array.from(remoteDeviceName(peer.deviceName)),who=Array.from([labelPart(peer.client,20),labelPart(peer.host,16)].filter(Boolean).join('·'));
  while(make(name.join(''),who.join('')).length>100&&who.length)who.pop();
  while(make(name.join(''),who.join('')).length>100&&name.length>1)name.pop();
  return make(name.join('').trim(),who.join('').replace(/[·\s]+$/,''));
}
/**
 * Control too old for another Mac's AI (§10 control-update-required), from its last read: no v2 scope or a Control process
 * known to be older (`scope-update-required`), or a v2 Control that reports no standing allowance at all (one from before
 * 957aae76 sends no `standing`). Not the same as a person who has not turned the allowance on, nor as a locked Mac.
 */
function controlOutdated(native:Record<string,any>|undefined){return native?.success===true?!('standing'in native):native?.code==='scope-update-required';}
/** What a remote request-access can say about why this Mac cannot approve now (Control's last read). Null: nothing seen. */
function remoteNotReadyDetail(native:Record<string,any>|undefined):string|null{
  if(!native||native.success!==true)return '그 Mac의 Control 상태를 확인하지 못했습니다.';
  if(native.accessibility!==true)return '그 Mac의 Control 손쉬운 사용 권한이 꺼져 있습니다.';
  if(native.screenRecording!==true)return '그 Mac의 Control 화면 기록 권한이 꺼져 있습니다.';
  if(native.secureInput===true)return '그 Mac에서 보안 입력(암호 입력 등)이 진행 중입니다.';
  return null;
}
/** The refusal for a Control read that cannot approve a remote request now, or null: an outdated Control first. */
function remoteNativeRefusal(native:Record<string,any>|undefined){
  if(controlOutdated(native))return computerUseRemoteRefusal('REMOTE_CONTROL_UPDATE_REQUIRED');
  const detail=remoteNotReadyDetail(native);return detail?computerUseRemoteRefusal('REMOTE_PEER_NOT_READY',detail):null;
}

/**
 * The person's remote settings (`APP_DATA/computer-use-remote.json`, §8.6). Changed only by the management route
 * (`scope-remote-set`). Another process of this user can edit the file: that process already runs code here, so the
 * file is not a boundary (§9).
 */
export interface ComputerUseRemoteSettings {
  schemaVersion:1;allowRemote:boolean;blockedDevices:{deviceId:string;name:string;since:number}[];
  blockedConnections:{deviceId:string;instance:string;until:number}[];noticeShown:boolean;changedAt:number;
}
/** `unreadable`: a file that exists but cannot be read or is not this format — nothing is received until the person saves. */
export interface ComputerUseRemoteSettingsStore {read():{settings:ComputerUseRemoteSettings;unreadable:boolean};write(settings:ComputerUseRemoteSettings):void}
/** No file yet: D1 (2026-11-01) — a Mac whose Control has the standing allowance receives other community Macs' AIs. */
export const defaultComputerUseRemoteSettings=():ComputerUseRemoteSettings=>({schemaVersion:1,allowRemote:true,blockedDevices:[],blockedConnections:[],noticeShown:false,changedAt:0});
const closedRemoteSettings=():ComputerUseRemoteSettings=>({...defaultComputerUseRemoteSettings(),allowRemote:false});
export function parseComputerUseRemoteSettings(value:unknown):ComputerUseRemoteSettings|null{
  if(!exact(value,['schemaVersion','allowRemote','blockedDevices','blockedConnections','noticeShown','changedAt'])||value.schemaVersion!==1||typeof value.allowRemote!=='boolean'||typeof value.noticeShown!=='boolean'
    ||!Number.isSafeInteger(value.changedAt)||value.changedAt<0||!Array.isArray(value.blockedDevices)||value.blockedDevices.length>REMOTE_BLOCKED_DEVICES_MAX
    ||!Array.isArray(value.blockedConnections)||value.blockedConnections.length>REMOTE_BLOCKED_CONNECTIONS_MAX)return null;
  const devices:ComputerUseRemoteSettings['blockedDevices']=[],connections:ComputerUseRemoteSettings['blockedConnections']=[];
  for(const d of value.blockedDevices){
    if(!exact(d,['deviceId','name','since'])||typeof d.deviceId!=='string'||!DEVICE_ID.test(d.deviceId)||devices.some(x=>x.deviceId===d.deviceId)||typeof d.name!=='string'||d.name.length>64||UNSAFE_LABEL_CHARACTER.test(d.name)
      ||!Number.isSafeInteger(d.since)||d.since<0)return null;
    devices.push({deviceId:d.deviceId,name:d.name,since:d.since});
  }
  for(const b of value.blockedConnections){
    if(!exact(b,['deviceId','instance','until'])||typeof b.deviceId!=='string'||!DEVICE_ID.test(b.deviceId)||typeof b.instance!=='string'||!CONNECTION_TAG.test(b.instance)||!Number.isSafeInteger(b.until)||b.until<0)return null;
    connections.push({deviceId:b.deviceId,instance:b.instance,until:b.until});
  }
  return {schemaVersion:1,allowRemote:value.allowRemote,blockedDevices:devices,blockedConnections:connections,noticeShown:value.noticeShown,changedAt:value.changedAt};
}
/** The file store: a missing file is the default, anything unreadable receives nothing; written whole (temp → rename, 0600). */
export function computerUseRemoteSettingsFile(path:string):ComputerUseRemoteSettingsStore{
  return {
    read(){
      let text:string;
      try{const info=statSync(path);if(!info.isFile()||info.size>REMOTE_SETTINGS_FILE_MAX)return {settings:closedRemoteSettings(),unreadable:true};text=readFileSync(path,'utf8');}
      catch(error){return (error as NodeJS.ErrnoException)?.code==='ENOENT'?{settings:defaultComputerUseRemoteSettings(),unreadable:false}:{settings:closedRemoteSettings(),unreadable:true};}
      let value:unknown;try{value=JSON.parse(text);}catch{return {settings:closedRemoteSettings(),unreadable:true};}
      const settings=parseComputerUseRemoteSettings(value);return settings?{settings,unreadable:false}:{settings:closedRemoteSettings(),unreadable:true};
    },
    write(settings){
      const temp=`${path}.${process.pid}.${randomUUID()}.tmp`;
      try{writeFileSync(temp,JSON.stringify(settings,null,2)+'\n',{mode:0o600,flag:'wx'});renameSync(temp,path);}
      catch(error){try{unlinkSync(temp);}catch{}throw error;}
    },
  };
}
/** For tests and hosts without an app data folder: the same rules, kept in memory. */
export function computerUseRemoteSettingsMemory(initial:ComputerUseRemoteSettings|null=null):ComputerUseRemoteSettingsStore{
  let saved=initial?structuredClone(initial):null;
  return {read:()=>({settings:structuredClone(saved??defaultComputerUseRemoteSettings()),unreadable:false}),write:settings=>{saved=structuredClone(settings);}};
}

/**
 * What this Mac's panel shows around remote computer use that the runtime does not hold itself (§2, §6 WP7), given by
 * the sidecar: `profileReady` — the shared control-folder link the community mailbox needs (without it nothing of another
 * Mac reaches this Mac, so the panel says it cannot receive); `usage`/`closeDevice` — this Mac's own AIs on other Macs
 * (the sending client's 「사용 중」 and the panel's 「끊기」). Reads names, codes and times only; nothing secret.
 */
export interface ComputerUseRemoteLink {
  profileReady():boolean;
  usage():{sessions:readonly {deviceId:string;deviceName:string;connection:string;client:string|null;since:number;lastCallAt:number;active:boolean}[]};
  closeDevice(deviceId:string):number;
}
/** One open session of this Mac's AI on another Mac, as the management status carries it (normalized, at most 64). */
export interface ComputerUseOutgoingSession {deviceId:string;deviceName:string;connection:string;client:string;since:number;lastCallAt:number;active:boolean}
const OUTGOING_SESSIONS_MAX=64;
function outgoingSessions(link:ComputerUseRemoteLink):ComputerUseOutgoingSession[]{
  let sessions:readonly unknown[];try{const value=link.usage()?.sessions;sessions=Array.isArray(value)?value:[];}catch{return [];}
  const out:ComputerUseOutgoingSession[]=[];
  for(const s of sessions){
    if(!plain(s)||typeof s.deviceId!=='string'||!DEVICE_ID.test(s.deviceId.toLowerCase())||typeof s.connection!=='string'||!/^[a-f0-9]{1,32}$/.test(s.connection)
      ||!Number.isFinite(s.since)||!Number.isFinite(s.lastCallAt))continue;
    out.push({deviceId:s.deviceId.toLowerCase(),deviceName:remoteDeviceName(s.deviceName),connection:s.connection.slice(0,8),client:labelPart(s.client,20),
      since:s.since,lastCallAt:s.lastCallAt,active:s.active===true});
    if(out.length>=OUTGOING_SESSIONS_MAX)break;
  }
  return out;
}
/** `host`: the app this connection's AI runs in, read once from its process ancestry when it registers (never from a body).
 *  `remote`: set for a connection of an AI on another Mac; its host is that Mac's refused set, never read from a process. */
type RemoteIdentity={deviceId:string;deviceName:string;deviceCode:string;instance:string;client:string;host:string};
type Connection={id:string;code:string;label:string;credential:string;until:number;createdAt:number;grants:Map<string,{grant:string;epoch:number;expiresAt:number}>;host:Promise<ComputerCallerHost>;remote?:RemoteIdentity};
type Pending={connection:Connection;caller:AuthenticatedComputerCaller;generation:string;request:ReturnType<ComputerUseHost['requestApproval']>;label:string};
/**
 * A transport identifies an MCP connection, not an app's individual chat. No caller from a body or ancestry hint
 * authorizes input. Only Control's native human approval creates a grant; connections are bounded and short leased.
 */
export class ComputerUseRuntime {
  private registry:ComputerCallerRegistry;
  private host:ComputerUseHost;
  private approvals:ComputerApprovalVerifier;
  private connections=new Map<string,Connection>();
  private pending=new Map<string,Pending>();
  /**
   * The person's switch. While on, an AI connection may ask for exactly this scope and Control still asks the person
   * (Touch ID or password) for each request. Memory only: an app restart turns it off.
   */
  private access:{enabled:false}|{enabled:true;scope:ComputerUseScope}={enabled:false};
  /**
   * Control's standing allowance (상시 허용) as last read. The person turns it on in Control with Touch ID; it outlives
   * app and Control restarts. While on and the switch is off, the switch reads as on for the whole Mac and Control
   * approves desktop requests itself. Only Control decides it; this copy only shows it and skips the per-minute limit.
   */
  private standing:{since:number}|null=null;
  private accessAsked=new Map<string,number>();
  private accessRequesting=false;
  private publicKey?:Uint8Array;
  private syncing=false;
  private disposed=false;
  private nativeStatus?:{observedAt:number;value:Record<string,unknown>};
  private readonly startedAvailable:boolean;
  private now:()=>number;
  private readonly channel:ComputerUseNativeChannel;
  private readonly scope:ComputerUseScopeHost;
  private readonly callerHost?:ComputerCallerHostResolver;
  /** Whether this runtime receives AIs of other Macs at all: only the bundled macOS sidecar (RC-12). */
  private readonly acceptRemote:()=>boolean;
  private readonly remoteStore?:ComputerUseRemoteSettingsStore;
  private pendingReceiveChange?:{id:string;unblock?:string};
  private readonly receiveAuthorization?:CommunityReceiveAuthorization;
  private remoteState?:{settings:ComputerUseRemoteSettings;unreadable:boolean};
  private readonly remoteLink?:()=>ComputerUseRemoteLink|null;
  private readonly sleep:(ms:number)=>Promise<void>;
  /**
   * `callerHost` reads a new connection's host app (src/computerUseCallerHost.ts); without it every host is unknown.
   * `acceptRemote` (default off) lets `remote()` admit AIs of other Macs; it needs `remoteSettings`, the person's
   * file. `remoteHumanInput` reads whether a person controls this Mac through AgentsToZ Screen (SR-34) before any AI
   * input, whole-Mac scope and one window alike; the sidecar passes the real reader, and without one nothing is read
   * (as `callerHost`, so a test never depends on this Mac's Screen). `sleep` is the wait between a remote
   * request-access's two grant reads. `remoteLink` (read when the panel asks; may return null while the sidecar has none)
   * gives the panel the shared-folder link and this Mac's own sessions on other Macs; without it neither is shown.
   */
  constructor(channel:ComputerUseNativeChannel,private readonly recovery:ComputerUseRecovery,options:{now?:()=>number;callerHost?:ComputerCallerHostResolver;
    acceptRemote?:boolean|(()=>boolean);remoteSettings?:ComputerUseRemoteSettingsStore;remoteHumanInput?:RemoteHumanInputReader;sleep?:(ms:number)=>Promise<void>;
    remoteLink?:()=>ComputerUseRemoteLink|null;receiveAuthorization?:CommunityReceiveAuthorization}={}){
    if((options.acceptRemote===true||typeof options.acceptRemote==='function')&&!options.remoteSettings)throw Error('다른 Mac의 AI를 받으려면 원격 설정 저장소가 필요합니다.');
    this.acceptRemote=typeof options.acceptRemote==='function'?options.acceptRemote:()=>options.acceptRemote===true;this.remoteStore=options.remoteSettings;this.remoteLink=options.remoteLink;
    this.receiveAuthorization=options.receiveAuthorization;
    this.sleep=options.sleep??(ms=>new Promise(resolve=>setTimeout(resolve,ms)));
    this.callerHost=options.callerHost;
    this.startedAvailable=channel.available;this.channel=new RevokingComputerUseChannel(channel);
    // A connection ends by its 75 s lease (heartbeats renew it) or disconnect, not a day later: the credential lasts as
    // long as a switched-on v2 grant may (COMPUTER_USE_SCOPE_LIMITS.grantMs), so a long session is not cut silently.
    this.now=options.now??Date.now;this.registry=new ComputerCallerRegistry({now:this.now,limit:MAX_CONNECTIONS,lifetimeMs:COMPUTER_USE_SCOPE_LIMITS.grantMs});
    const approvals=this.approvals=new ComputerApprovalVerifier({now:this.now,helperPublicKey:()=>{
      if(!this.publicKey)throw Error('서명된 도우미 승인 키가 없습니다.');return this.publicKey;
    }});
    const remoteHumanInput=options.remoteHumanInput??noRemoteHumanInput;
    this.host=new ComputerUseHost({now:this.now,recovery,approvals,remoteHumanInput,createWorker:async context=>nativeComputerWorker(this.channel,context)});
    this.scope=new ComputerUseScopeHost(this.channel,recovery,this.now,
      async sessionId=>[...this.connections.values()].find(c=>c.id===sessionId)?.host??unknownCallerHost('connection-ended'),
      COMPUTER_USE_SCOPE_LIMITS,remoteHumanInput);
  }
  private touch(instance:unknown,label:unknown,create=true,origin:ComputerCallerOrigin|null=null):Connection{
    if(this.disposed||typeof instance!=='string'||!/^[a-f0-9]{64}$/.test(instance))throw Error('AI 연결을 확인하지 못했습니다.');
    this.reap();const key=hash(instance);let connection=this.connections.get(key);
    if(!connection){
      if(!create||this.connections.size>=MAX_CONNECTIONS)throw Error('AI 연결을 다시 열어 주세요.');
      const id='mcp_'+randomUUID();
      const name=typeof label==='string'?label.replace(/[^A-Za-z0-9 ._()+-]/g,'').trim().slice(0,40):'';
      // Read from the socket that registers the connection, so a later request cannot name a different host.
      const host=this.callerHost?this.callerHost(origin).catch(()=>unknownCallerHost('resolver-failed')):Promise.resolve(unknownCallerHost('resolver-missing'));
      connection={id,code:id.slice(4),label:name||'MCP',credential:this.registry.issue({sessionId:id,lane:'connection'}),until:this.now()+LEASE_MS,createdAt:this.now(),grants:new Map(),host};
      this.connections.set(key,connection);
    }
    connection.until=this.now()+LEASE_MS;return connection;
  }
  private caller(connection:Connection){
    const caller=this.registry.authenticate(connection.credential);if(!caller)throw Error('AI 연결이 끝났습니다.');return caller;
  }
  /** The switch as the person sees it: theirs, or the whole Mac while the standing allowance is on. */
  private effectiveAccess():{enabled:false}|{enabled:true;scope:ComputerUseScope}{return this.access.enabled?this.access:this.standing?{enabled:true,scope:{kind:'desktop'}}:{enabled:false};}
  private sameAccess(a:{enabled:boolean;scope?:ComputerUseScope},b:{enabled:boolean;scope?:ComputerUseScope}){return a.enabled===b.enabled&&(!a.enabled||!!a.scope&&!!b.scope&&sameComputerUseScope(a.scope,b.scope));}
  private publicAccess(){const access=this.effectiveAccess(),standing=this.standing?{standing:{since:this.standing.since}}:{};
    return access.enabled?{enabled:true,scope:structuredClone(access.scope),...standing}:{enabled:false,...standing};}
  /** Off ends every grant and waiting request of every connection (both modes); the connections themselves stay. */
  private turnAccessOff(){
    this.access={enabled:false};this.accessAsked.clear();
    // Retire only sessions that hold something: the channel has a bounded retirement queue (up to 64 connections).
    const v1=new Set([...this.host.list().map(g=>g.caller.sessionId),...[...this.pending.values()].map(p=>p.connection.id)]);
    for(const c of this.connections.values()){
      this.scope.endSession(c.id);
      if(v1.has(c.id)){this.host.endSession(c.id);this.channel.retire!({operation:'revoke-session',sessionId:c.id});}
    }
    for(const[id]of this.pending){this.pending.delete(id);this.approvals.cancel(id);}
  }
  /**
   * An AI asks for the scope the person switched on. It names nothing itself: scope comes from the switch, the label from
   * this connection's registered name and process ancestry. One waiting request at a time, one per connection per minute.
   */
  private async requestAccess(c:Connection):Promise<Record<string,any>>{
    // One request travels at a time, so a second ask cannot pass the checks below before the first is recorded.
    if(this.accessRequesting)throw Error('승인 요청을 Control에 보내는 중입니다. 잠시 뒤 status로 확인하고 같은 요청을 다시 보내지 마세요.');
    this.accessRequesting=true;
    try{
      this.standing=await this.scope.standing();
      const access=this.effectiveAccess();if(!access.enabled)throw Error(ACCESS_OFF);
      // Control approves only a desktop request by itself; an application scope still asks the person every time.
      const standing=!!this.standing&&access.scope.kind==='desktop';
      let scoped=await this.scope.managementStatus();
      if(scoped.grants.some(g=>!g.halted&&g.caller.sessionId===c.id&&sameComputerUseScope(g.scope,access.scope)))return {success:true,state:'granted',guidance:'이미 허용됐습니다. status로 grant와 epoch를 받으세요.'};
      const mine=scoped.pending.find(p=>p.connectionId===c.id);if(mine)return {success:true,state:'pending',expiresAt:mine.expiresAt,guidance:standing?STANDING_PENDING:ACCESS_PENDING};
      if(standing&&this.scope.yieldIdle(c.id,STANDING_IDLE_MS))scoped=await this.scope.managementStatus();
      if(scoped.grants.some(g=>!g.halted&&g.owner==='person'))throw Error(OTHER_IN_USE_PERSON);
      if(scoped.grants.some(g=>!g.halted)||this.host.list().some(g=>!g.halted))throw Error(standing
        ?OTHER_IN_USE_STANDING
        :'다른 AI 연결이 컴퓨터 유즈를 사용 중입니다. 사람이 그 허용을 끝낸 뒤 다시 요청하세요.');
      if(scoped.pending.length||this.pending.size)throw Error('다른 승인 요청이 Control에서 대기 중입니다. 그 요청이 끝난 뒤 다시 요청하세요.');
      // The limit keeps the person from being asked again and again; under the standing allowance nobody is asked.
      const last=this.accessAsked.get(c.id);
      if(!standing&&last!==undefined&&this.now()-last<ACCESS_REQUEST_INTERVAL_MS)throw Error('방금 보낸 승인 요청이 승인되지 않았습니다. 사람이 원한다고 할 때까지 다시 요청하지 마세요.');
      const label=('연결 '+c.code.slice(0,8)+' / '+accessLabel(c.label,await c.host,access.scope)).slice(0,100);
      if(!this.sameAccess(this.effectiveAccess(),access))throw Error(ACCESS_OFF);
      // The interval starts once the request may have reached Control, including an unknown delivery, so neither is
      // followed by a fresh request inside it. A refusal before it left (a recovery row, an unread or own host, missing
      // permissions, a request that was not sent) starts nothing: the person never saw it to decline.
      const result=await this.scope.requestApproval(this.caller(c),c.id,access.scope,label,()=>{this.accessAsked.set(c.id,this.now());});
      // Switched off or changed while the request travelled: end it again so nothing outlives the switch.
      if(!this.sameAccess(this.effectiveAccess(),access)){this.scope.endSession(c.id);throw Error(ACCESS_OFF);}
      if(standing){
        // Control approved it as it arrived (or will on the next read, once an ended grant is gone there): open it now.
        const now=await this.scope.managementStatus();
        if(now.grants.some(g=>!g.halted&&g.caller.sessionId===c.id&&sameComputerUseScope(g.scope,access.scope)))return {success:true,state:'granted',guidance:STANDING_GRANTED};
        return {...result,guidance:STANDING_PENDING};
      }
      return {...result,guidance:ACCESS_PENDING};
    }finally{this.accessRequesting=false;}
  }
  // ---- Remote ----
  private remoteSettings(){
    if(!this.remoteState){
      let state:{settings:ComputerUseRemoteSettings;unreadable:boolean};
      try{state=this.remoteStore?this.remoteStore.read():{settings:closedRemoteSettings(),unreadable:false};}catch{state={settings:closedRemoteSettings(),unreadable:true};}
      this.remoteState=state;
    }
    const now=this.now(),s=this.remoteState.settings;s.blockedConnections=s.blockedConnections.filter(b=>b.until>now);
    return this.remoteState;
  }
  /** Why a remote peer is not received right now (RC-2 ②③, RC-12), or null. Read on every remote call and heartbeat. */
  private remoteRefusalFor(peer:{deviceId:string;instance:string}):ComputerUseRemoteRefusalCode|null{
    if(this.disposed)return 'REMOTE_UNSUPPORTED';
    try{if(!this.acceptRemote())return 'REMOTE_UNSUPPORTED';}catch{return 'REMOTE_UNSUPPORTED';}
    const legacy=this.remoteSettings(),native=this.receiveAuthorization?.current();
    if(this.receiveAuthorization&&(!native||!native.authorized))return 'REMOTE_UNSUPPORTED';
    const settings=native?{allowRemote:native.policy.allowRemote,blockedDevices:native.policy.blockedDevices.map(deviceId=>({deviceId})),blockedConnections:native.policy.blockedConnections}:legacy.settings,unreadable=native?false:legacy.unreadable;
    if(unreadable||!settings.allowRemote)return 'REMOTE_BLOCKED_BY_PERSON';
    if(settings.blockedDevices.some(d=>d.deviceId===peer.deviceId)||settings.blockedConnections.some(b=>b.deviceId===peer.deviceId&&b.instance===peer.instance)||legacy.settings.blockedDevices.some(d=>d.deviceId===peer.deviceId)||legacy.settings.blockedConnections.some(b=>b.deviceId===peer.deviceId&&b.instance===peer.instance))return 'REMOTE_DEVICE_BLOCKED';
    return null;
  }
  /** For the receiving host's hello: the same admission as every call, without creating a connection (§7.2). */
  async remoteAdmission(peer:{deviceId:string;instance:string}):Promise<ComputerUseRemoteRefusalCode|null>{
    if(this.receiveAuthorization)await this.refreshReception();
    const deviceId=typeof peer?.deviceId==='string'?peer.deviceId.toLowerCase():'';
    if(!DEVICE_ID.test(deviceId)||typeof peer?.instance!=='string'||!CONNECTION_TAG.test(peer.instance))throw Error('원격 연결을 확인하지 못했습니다.');
    return this.remoteRefusalFor({deviceId,instance:peer.instance});
  }
  private async refreshReception(){
    const old=this.remoteSettings();
    try{
      await this.receiveAuthorization?.refresh(old.unreadable||!old.settings.allowRemote||old.settings.blockedDevices.length>0||old.settings.blockedConnections.length>0);
      const review=this.receiveAuthorization?.reviewState(),pending=this.pendingReceiveChange;
      if(pending&&review?.id===pending.id&&review.state==='approved'){
        const next=structuredClone(old.settings);
        if(pending.unblock){next.blockedDevices=next.blockedDevices.filter(d=>d.deviceId!==pending.unblock);next.blockedConnections=next.blockedConnections.filter(d=>d.deviceId!==pending.unblock);}
        this.remoteStore?.write(next);this.remoteState={settings:next,unreadable:false};this.pendingReceiveChange=undefined;
      }
    }
    catch{this.endRemote(()=>true);throw Error('현재 Native 공통 등록·수신 권한을 확인하지 못했습니다.');}
  }
  /** Ends remote connections (their grants and Control requests with them) that `match`; local AIs are not touched. */
  private endRemote(match:(remote:RemoteIdentity)=>boolean){
    for(const[key,c]of this.connections)if(c.remote&&match(c.remote)){this.connections.delete(key);this.end(c);}
  }
  private touchRemote(key:string,peer:ComputerUseRemotePeer):Connection{
    this.reap();let c=this.connections.get(key);
    if(!c){
      const remotes=[...this.connections.values()].filter(x=>x.remote);
      if(this.connections.size>=MAX_CONNECTIONS||remotes.length>=REMOTE_TOTAL||remotes.filter(x=>x.remote!.deviceId===peer.deviceId).length>=REMOTE_PER_DEVICE)throw computerUseRemoteRefusal('REMOTE_RATE_LIMITED');
      const nonce=randomUUID(),id=`rcu_${peer.deviceId}_${peer.instance}_${nonce}`,deviceName=remoteDeviceName(peer.deviceName);
      const remote:RemoteIdentity={deviceId:peer.deviceId,deviceName,deviceCode:peer.deviceId.slice(0,4),instance:peer.instance,client:labelPart(peer.client,20),host:labelPart(peer.host,16)};
      // Its host is not read from a process: what it may not type into is this Mac's refused set for remote AIs (D2).
      c={id,code:nonce,label:`원격 ${deviceName} (${remote.deviceCode})`,credential:this.registry.issue({sessionId:id,lane:'remote'}),until:this.now()+LEASE_MS,createdAt:this.now(),grants:new Map(),
        host:Promise.resolve(remoteCallerHost(peer.deviceId,deviceName)),remote};
      this.connections.set(key,c);
    }
    c.until=this.now()+LEASE_MS;return c;
  }
  private unresolvedDesktop(){try{return this.recovery.unresolvedScope({kind:'desktop'});}catch{return true;}}
  /**
   * A remote AI's request-access (§7.3): the whole Mac under this Mac's standing allowance only, and nobody is asked
   * (D4). Control signs it as it arrives or on the next status read; when it has not after two reads (about a second),
   * the request is ended here and in Control (scope-revoke-session) — no request of another Mac ever waits in Control to
   * be approved the moment it unlocks, and none keeps this Mac's own AI from asking (RC-18).
   */
  private async requestRemoteAccess(c:Connection):Promise<Record<string,any>>{
    if(this.accessRequesting)throw Error('승인 요청을 Control에 보내는 중입니다. 잠시 뒤 status로 확인하고 같은 요청을 다시 보내지 마세요.');
    this.accessRequesting=true;
    try{
      const mine=(s:{grants:{halted:boolean;caller:{sessionId:string};scope:ComputerUseScope}[]})=>s.grants.some(g=>!g.halted&&g.caller.sessionId===c.id&&g.scope.kind==='desktop');
      // Re-checked after every wait: the person may have blocked it or switched on an application scope meanwhile.
      const ended=()=>!this.remoteKeyOf(c)||!this.registry.authenticate(c.credential);
      const admitted=()=>{
        const code=this.remoteRefusalFor(c.remote!)??(this.access.enabled&&this.access.scope.kind==='application'?'REMOTE_APP_SCOPE_ACTIVE':null);
        if(code){this.drop(c);throw computerUseRemoteRefusal(code);}
        if(ended()){this.scope.endSession(c.id);throw Error('원격 AI 연결이 끝났습니다. status부터 다시 하세요.');}
      };
      let scoped=await this.scope.managementStatus();admitted();
      if(mine(scoped))return {success:true,state:'granted',guidance:REMOTE_GRANTED};
      const last=this.accessAsked.get(c.id);
      if(last!==undefined&&this.now()-last<REMOTE_ACCESS_INTERVAL_MS)throw computerUseRemoteRefusal('REMOTE_RATE_LIMITED');
      this.accessAsked.set(c.id,this.now());
      if(!this.channel.available)throw computerUseRemoteRefusal('REMOTE_UNSUPPORTED');
      if(this.unresolvedDesktop())throw computerUseRemoteRefusal('REMOTE_RECOVERY_REQUIRED');
      this.standing=await this.scope.standing();admitted();
      if(!this.standing){
        // Control did not answer, is too old, or its allowance is off: say which, so the other Mac can tell them apart.
        const native=(await this.scope.managementStatus()).native as Record<string,any>;
        throw remoteNativeRefusal(native)??computerUseRemoteRefusal('REMOTE_NEEDS_STANDING');
      }
      // Never one of its own (each ends at once below), but nothing of this connection may wait in Control.
      if(scoped.pending.some(p=>p.connectionId===c.id))this.scope.endSession(c.id);
      // Everything that can refuse comes before the idle hand-over, so a request that cannot succeed (Control not ready,
      // another request waiting, a one-window grant in use) never ends this Mac's own AI's idle grant.
      scoped=await this.scope.managementStatus();admitted();
      const blocked=remoteNativeRefusal(scoped.native as Record<string,any>);if(blocked)throw blocked;
      if(scoped.pending.length||this.pending.size)throw Error(OTHER_PENDING);
      if(this.host.list().some(g=>!g.halted))throw Error(OTHER_IN_USE_STANDING);
      this.scope.yieldIdle(c.id,STANDING_IDLE_MS);
      const holders=this.scope.grantHolders();
      if(holders.length)throw Error(holders.some(g=>g.person)?OTHER_IN_USE_PERSON:OTHER_IN_USE_STANDING);
      // From here a request may reach Control. Whatever fails — the request itself, or a grant read (sync can throw on an
      // answer it cannot verify) — ends it here and in Control (scope-revoke-session): nothing of another Mac waits (RC-18).
      const CANCELLED='대기 요청은 남기지 않고 취소했습니다.';
      try{
        try{await this.scope.requestApproval(this.caller(c),c.id,{kind:'desktop'},remoteAccessLabel(c.remote!,c.code));}
        catch(error){
          // A Control process found older just now (it refused the request's wait as approval-expired) is named as such.
          if(controlOutdated(this.scope.lastNative()))throw computerUseRemoteRefusal('REMOTE_CONTROL_UPDATE_REQUIRED',CANCELLED);
          throw computerUseRemoteRefusal('REMOTE_PEER_NOT_READY',`${error instanceof Error?error.message:''} ${CANCELLED}`.trim());
        }
        for(let read=0;read<2;read++){
          if(read)await this.sleep(REMOTE_GRANT_READ_GAP_MS);
          scoped=await this.scope.managementStatus();admitted();
          if(mine(scoped))return {success:true,state:'granted',guidance:REMOTE_GRANTED};
        }
      }catch(error){
        this.scope.endSession(c.id);
        // A refusal with its code (blocked meanwhile, not ready) or the connection ending stays as it is; anything else
        // (a grant read that threw: an approval answer it could not verify) did not open a grant and has no code of its own.
        if(typeof (error as {code?:unknown})?.code==='string'||ended())throw error;
        throw computerUseRemoteRefusal('REMOTE_PEER_NOT_READY',`${error instanceof Error?error.message:''} ${CANCELLED}`.trim());
      }
      this.scope.endSession(c.id);
      const native=scoped.native as Record<string,any>;
      throw controlOutdated(native)?computerUseRemoteRefusal('REMOTE_CONTROL_UPDATE_REQUIRED',CANCELLED)
        :computerUseRemoteRefusal('REMOTE_PEER_NOT_READY',`${remoteNotReadyDetail(native)??'잠겨 있을 수 있습니다.'} ${CANCELLED}`);
    }finally{this.accessRequesting=false;}
  }
  private remoteKeyOf(c:Connection){for(const[key,x]of this.connections)if(x===c)return key;return '';}
  /** Ends one connection now (its grants, Control requests and credential), as disconnect does. */
  private drop(c:Connection){const key=this.remoteKeyOf(c);if(key){this.connections.delete(key);this.end(c);}else this.scope.endSession(c.id);}
  /**
   * One call from an AI on another Mac, after the receiving host has opened its sealed box (RC-1). `sessionKey` is the
   * remote session (32 hex), `peer` who sent it as the mailbox recorded it. The connection is made on its first scope
   * call, never by a heartbeat; it lasts the same 75 s lease. Only the whole-Mac scope operations exist for it (RC-3).
   * A refusal before anything reached Control is an Error with a `code` from COMPUTER_USE_REMOTE_REFUSALS.
   */
  async remote(sessionKey:unknown,peerValue:unknown,body:unknown):Promise<Record<string,any>>{
    if(typeof sessionKey!=='string'||!CONNECTION_TAG.test(sessionKey))throw Error('원격 연결을 확인하지 못했습니다.');
    const peer=parseRemotePeer(peerValue);
    if(!plain(body)||typeof body.operation!=='string')throw Error('컴퓨터 유즈 요청을 확인하세요.');
    const key=hash(['remote',peer.deviceId,peer.instance,sessionKey].join('\0')),operation=body.operation;
    const endThis=()=>{const c=this.connections.get(key);if(c){this.connections.delete(key);this.end(c);}};
    if(operation==='disconnect'){if(!exact(body,['operation']))throw Error('연결 종료 요청을 확인하세요.');endThis();return {success:true};}
    if(this.receiveAuthorization)await this.refreshReception();
    const refused=this.remoteRefusalFor(peer);if(refused){endThis();throw computerUseRemoteRefusal(refused);}
    if(operation==='heartbeat'){
      // Renews the lease only: no connection is made, and no grant's last use moves (RC-9 — idle hand-over still works).
      if(!exact(body,['operation']))throw Error('잘못된 연결 확인입니다.');this.reap();
      const c=this.connections.get(key);if(!c)return {success:true,active:false};c.until=this.now()+LEASE_MS;return {success:true,active:true};
    }
    if(!REMOTE_OPERATIONS.has(operation))throw computerUseRemoteRefusal('REMOTE_OPERATION_REFUSED');
    const appScope=this.access.enabled&&this.access.scope.kind==='application';
    if(appScope&&operation!=='scope-status'){const c=this.connections.get(key);if(c)this.scope.endSession(c.id);throw computerUseRemoteRefusal('REMOTE_APP_SCOPE_ACTIVE');}
    const c=this.touchRemote(key,peer);
    if(operation==='scope-request-access'){
      if(!exact(body,['operation']))throw Error('승인 요청에는 범위·이름·권한을 넣을 수 없습니다.');
      return this.requestRemoteAccess(c);
    }
    const result=await this.scope.agent(this.caller(c),body);
    if(operation!=='scope-status')return result;
    this.standing=this.scope.knownStanding();
    // The switch's kind only: which application this Mac's person allowed its own AIs is not the other Mac's to read.
    const {scope:switched,...access}=this.publicAccess() as {scope?:ComputerUseScope;enabled:boolean;standing?:{since:number}};
    const outdated=!this.standing&&controlOutdated(result.native as Record<string,any>);
    return {...result,success:true,connection:{id:c.id,code:c.code,label:c.label,scope:'remote-connection'},available:this.channel.available,restartRequired:this.startedAvailable&&!this.channel.available,
      access:switched?{...access,scope:{kind:switched.kind}}:access,remote:{allowRemote:true,standing:!!this.standing,appScope},
      guidance:appScope?COMPUTER_USE_REMOTE_REFUSALS.REMOTE_APP_SCOPE_ACTIVE:outdated?COMPUTER_USE_REMOTE_REFUSALS.REMOTE_CONTROL_UPDATE_REQUIRED
        :!this.standing?COMPUTER_USE_REMOTE_REFUSALS.REMOTE_NEEDS_STANDING:typeof result.guidance==='string'?result.guidance:REMOTE_READY};
  }
  /** Open grants held by AIs of other Macs: for the receiving host's notices and the sending side's chain guard (RC-13). */
  remoteGrants(){
    const byId=new Map([...this.connections.values()].filter(c=>c.remote).map(c=>[c.id,c]));
    return this.scope.grantHolders().flatMap(g=>{const c=byId.get(g.sessionId);return c?[{connectionId:c.id,grantId:g.grantId,deviceId:c.remote!.deviceId,deviceName:c.remote!.deviceName,deviceCode:c.remote!.deviceCode,connection:c.remote!.instance,person:g.person}]:[];});
  }
  hasIncomingRemoteGrant(){return this.remoteGrants().length>0;}
  private remoteSummary(){
    const legacy=this.remoteSettings(),native=this.receiveAuthorization?.current(),link=this.link();
    const settings=native?{...legacy.settings,allowRemote:native.policy.allowRemote,blockedDevices:[...new Set([...native.policy.blockedDevices,...legacy.settings.blockedDevices.map(d=>d.deviceId)])].map(deviceId=>legacy.settings.blockedDevices.find(d=>d.deviceId===deviceId)??{deviceId,name:'기기',since:0}),blockedConnections:[...native.policy.blockedConnections,...legacy.settings.blockedConnections.filter(b=>!native.policy.blockedConnections.some(n=>n.deviceId===b.deviceId&&n.instance===b.instance))]}:legacy.settings,unreadable=this.receiveAuthorization?!native:legacy.unreadable;
    let accepting=false;try{accepting=this.acceptRemote()===true;}catch{}
    if(this.receiveAuthorization&&native?.authorized!==true)accepting=false;
    let profileReady:boolean|undefined;if(link)try{profileReady=link.profileReady()===true;}catch{profileReady=false;}
    return {accepting,...(this.receiveAuthorization?{restorationSupported:true,receptionReview:this.receiveAuthorization.reviewState(),nativeAuthorized:native?.authorized===true}:{}),allowRemote:settings.allowRemote,blockedDevices:structuredClone(settings.blockedDevices),blockedConnections:structuredClone(settings.blockedConnections),
      noticeShown:settings.noticeShown,...(unreadable?{settingsUnreadable:true}:{}),...(profileReady===undefined?{}:{profileReady})};
  }
  private link():ComputerUseRemoteLink|null{try{return this.remoteLink?.()??null;}catch{return null;}}
  /**
   * The person's remote switches from this Mac's panel (management route only). Turning receiving off or blocking ends
   * the matching remote connections at once, with their grants and anything they asked Control for (RC-10).
   * `block.connection` is a connection tag from the status rows: that connection is blocked for `minutes` (default 30);
   * without it the device stays blocked until the person unblocks it.
   */
  private async setRemote(body:Record<string,any>){
    const keys=Object.keys(body).filter(k=>k!=='operation');
    if(!keys.length||keys.some(k=>!['allowRemote','block','unblock','noticeShown'].includes(k)))throw Error('다른 Mac의 AI 설정 요청을 확인하세요.');
    if('allowRemote'in body&&typeof body.allowRemote!=='boolean')throw Error('다른 Mac의 AI 받기 설정을 확인하세요.');
    if('noticeShown'in body&&body.noticeShown!==true)throw Error('안내 확인 요청을 확인하세요.');
    // Until Control owns an authenticated, revision-bound commit, never expand permissions through this route.
    // Reject mixed requests too: no part may be reported as applied after an expansion was refused.
    if((body.allowRemote===true||'unblock'in body)&&!this.receiveAuthorization)throw Error('이 버전에서는 다른 Mac의 AI 받기를 켜거나 막기를 풀 수 없습니다. Control 인증 기능이 준비된 버전이 필요합니다.');
    let block:{deviceId:string;name:string;connection?:string;minutes:number}|undefined,unblock:string|undefined;
    if('block'in body){
      const b=body.block;
      if(!plain(b)||Object.keys(b).some(k=>!['deviceId','name','connection','minutes'].includes(k))||typeof b.deviceId!=='string'||!DEVICE_ID.test(b.deviceId.toLowerCase())
        ||'name'in b&&(typeof b.name!=='string'||b.name.length>200)||'connection'in b&&(typeof b.connection!=='string'||!CONNECTION_TAG.test(b.connection))
        ||'minutes'in b&&(!('connection'in b)||!Number.isSafeInteger(b.minutes)||b.minutes<1||b.minutes>REMOTE_BLOCK_MAX_MINUTES))throw Error('막을 기기나 연결을 확인하세요.');
      const deviceId=b.deviceId.toLowerCase(),live=[...this.connections.values()].find(c=>c.remote?.deviceId===deviceId);
      block={deviceId,name:typeof b.name==='string'?remoteDeviceName(b.name):live?.remote!.deviceName??'이름 없음',...(typeof b.connection==='string'?{connection:b.connection}:{}),minutes:typeof b.minutes==='number'?b.minutes:REMOTE_CONNECTION_BLOCK_MINUTES};
    }
    if('unblock'in body){
      if(!exact(body.unblock,['deviceId'])||typeof body.unblock.deviceId!=='string'||!DEVICE_ID.test(body.unblock.deviceId.toLowerCase()))throw Error('풀 기기를 확인하세요.');
      unblock=body.unblock.deviceId.toLowerCase();
    }
    if(this.receiveAuthorization){
      if(body.allowRemote===true||unblock){
        if(block||body.allowRemote===false)throw Error('복구와 차단은 별도로 확인하세요.');
        const review=await this.receiveAuthorization.review({...((body.allowRemote===true)?{allowRemote:true}:{}),...(unblock?{unblockDevices:[unblock]}:{})},this.remoteSettings().unreadable);
        if(review)this.pendingReceiveChange={id:review.id,...(unblock?{unblock}:{})};
        return {success:true,restorationPending:review?.state==='pending',guidance:'공통 권한관리에서 사람이 복구를 인증해야 적용됩니다. 평소 연결에는 인증을 다시 요구하지 않습니다.',remote:this.remoteSummary()};
      }
      if(body.allowRemote===false||block){
        this.endRemote(r=>body.allowRemote===false||r.deviceId===block?.deviceId&&(!block.connection||r.instance===block.connection));
        await this.receiveAuthorization.restrict({...((body.allowRemote===false)?{allowRemote:false}:{}),...(block?{block:{deviceId:block.deviceId,...(block.connection?{connection:block.connection,minutes:block.minutes}:{})}}:{})});
      }
    }
    const current=this.remoteSettings(),now=this.now(),next=structuredClone(current.settings);
    if(typeof body.allowRemote==='boolean')next.allowRemote=body.allowRemote;
    if(body.noticeShown===true)next.noticeShown=true;
    if(unblock){next.blockedDevices=next.blockedDevices.filter(d=>d.deviceId!==unblock);next.blockedConnections=next.blockedConnections.filter(b=>b.deviceId!==unblock);}
    if(block?.connection){
      const previous=next.blockedConnections.find(b=>b.deviceId===block!.deviceId&&b.instance===block!.connection);
      next.blockedConnections=next.blockedConnections.filter(b=>!(b.deviceId===block!.deviceId&&b.instance===block!.connection));
      if(next.blockedConnections.length>=REMOTE_BLOCKED_CONNECTIONS_MAX)throw Error(`끊은 연결이 ${REMOTE_BLOCKED_CONNECTIONS_MAX}개입니다. 기존 연결의 차단이 끝난 뒤 다시 시도하세요.`);
      next.blockedConnections.push({deviceId:block.deviceId,instance:block.connection,until:Math.max(previous?.until??0,now+block.minutes*60_000)});
    }else if(block&&!next.blockedDevices.some(d=>d.deviceId===block!.deviceId)){
      if(next.blockedDevices.length>=REMOTE_BLOCKED_DEVICES_MAX)throw Error(`막은 기기가 ${REMOTE_BLOCKED_DEVICES_MAX}대입니다. 필요 없는 막기를 먼저 푸세요.`);
      next.blockedDevices.push({deviceId:block.deviceId,name:block.name,since:now});
    }
    next.changedAt=now;
    // A stricter setting holds in memory even if the file cannot be written; a looser one waits for the file.
    const stricter=next.allowRemote===false&&current.settings.allowRemote||!!block,looser=next.allowRemote&&!current.settings.allowRemote||!!unblock||current.unreadable;
    let saved=true;
    try{this.remoteStore?.write(next);}catch{saved=false;}
    if(saved||stricter&&!looser){
      this.remoteState={settings:next,unreadable:saved?false:current.unreadable};
      if(!next.allowRemote)this.endRemote(()=>true);
      if(block)this.endRemote(r=>r.deviceId===block!.deviceId&&(!block!.connection||r.instance===block!.connection));
    }
    if(!saved)throw Error(stricter&&!looser?'설정을 파일에 저장하지 못했습니다. 지금은 적용됐지만 앱을 다시 시작하면 이전 설정으로 돌아갈 수 있습니다.':'설정을 파일에 저장하지 못해 바꾸지 않았습니다.');
    return {success:true,remote:this.remoteSummary()};
  }
  private end(connection:Connection){
    this.accessAsked.delete(connection.id);
    this.registry.retire(connection.id);this.host.endSession(connection.id);
    this.scope.endSession(connection.id);
    for(const[id,p]of this.pending)if(p.connection===connection)this.pending.delete(id);
    this.channel.retire!({operation:'revoke-session',sessionId:connection.id});
  }
  reap(){for(const[key,c]of this.connections)if(c.until<=this.now()||!this.registry.authenticate(c.credential)) {this.connections.delete(key);this.end(c);}}
  private async syncApprovals(){
    if(this.syncing||!this.channel.available)return;this.syncing=true;
    try{for(const[id,p]of this.pending){
      if(p.connection.until<=this.now()||computerCallerGeneration(p.caller)!==p.generation){this.pending.delete(id);continue;}
      const result=await this.channel.request({operation:'approval-status',approvalId:id,caller:{...p.request.caller,generation:p.generation}});
      if(!this.pending.has(id)||computerCallerGeneration(p.caller)!==p.generation)continue;
      if(result.success!==true||['denied','cancelled','expired','unknown','consumed'].includes(result.state)||p.request.expiresAt<=this.now()){
        this.pending.delete(id);this.approvals.cancel(id);continue;
      }
      if(result.state!=='approved')continue;
      if(typeof result.helperPublicKey!=='string'||!/^[A-Za-z0-9+/]{87}=$/.test(result.helperPublicKey))throw Error('승인 공개키를 확인하지 못했습니다.');
      const key=Buffer.from(result.helperPublicKey,'base64');if(key.length!==65||key[0]!==4)throw Error('승인 공개키가 올바르지 않습니다.');
      this.publicKey=key;
      // The host verifies nonce, exact target/caller/generation/expiry and signature before opening the native grant.
      let opened:Awaited<ReturnType<ComputerUseHost['grant']>>;
      try{opened=await this.host.grant(result.approval);}
      catch(error){
        // No request reached Control: retain the same native approval for the next status read. Never create a
        // replacement approval, queue input or repeat a bind whose delivery could have happened.
        if((error as {notDispatched?:boolean})?.notDispatched===true)continue;
        this.pending.delete(id);this.approvals.cancel(id);throw error;
      }
      this.pending.delete(id);
      if(computerCallerGeneration(p.caller)!==p.generation){this.host.revoke(opened.id);continue;}
      p.connection.grants.set(opened.id,{grant:opened.grant,epoch:opened.epoch,expiresAt:opened.expiresAt});
    }}finally{this.syncing=false;}
  }
  private ownGrants(connection:Connection){
    const current=this.host.list().filter(g=>g.caller.sessionId===connection.id);
    for(const[id]of connection.grants)if(!current.some(g=>g.id===id))connection.grants.delete(id);
    return current.map(g=>({...g,grant:connection.grants.get(g.id)?.grant}));
  }
  private rememberNativeStatus(result:Record<string,any>){
    let value:Record<string,unknown>;
    if(result.success===true&&result.protocolVersion===COMPUTER_USE_CONTROL_PROTOCOL&&result.workerProtocol===COMPUTER_USE_WORKER_PROTOCOL&&result.backgroundOnly===true&&typeof result.accessibility==='boolean'&&typeof result.secureInput==='boolean'){
      // `capture` says whether this Control can take capture/click at all; permissions are still checked per request.
      value={state:!result.accessibility?'accessibility-required':result.secureInput?'secure-input':'ready',
        capture:controlAdvertisesScreen(result)?'supported':'control-update-required'};
    }else if(result.success===false){
      value={state:'unavailable',...(typeof result.code==='string'&&NATIVE_STATUS_CODES.has(result.code)?{code:result.code}:{})};
    }else value={state:'unknown'};
    this.nativeStatus={observedAt:this.now(),value};
  }
  private cachedNativeStatus(){
    if(!this.channel.available)return {state:'unavailable'};
    const cached=this.nativeStatus,age=cached?this.now()-cached.observedAt:-1;
    return cached&&age>=0&&age<=NATIVE_STATUS_CACHE_MS?{...cached.value,observedAt:cached.observedAt}:{state:'unknown'};
  }
  async agent(instance:unknown,label:unknown,body:unknown,origin:ComputerCallerOrigin|null=null){
    if(!plain(body)||typeof body.operation!=='string')throw Error('컴퓨터 유즈 요청을 확인하세요.');
    if(body.operation==='disconnect'){
      if(!exact(body,['operation'])||typeof instance!=='string'||!/^[a-f0-9]{64}$/.test(instance))throw Error('연결 종료 요청을 확인하세요.');
      const c=this.connections.get(hash(instance));if(c){this.connections.delete(hash(instance));this.end(c);}return {success:true};
    }
    const fresh=typeof instance==='string'&&!this.connections.has(hash(instance));
    const connection=this.touch(instance,label,body.operation!=='heartbeat',origin);
    // The registering request waits for its host read, so the socket it is read from is still this caller's.
    if(fresh)await connection.host;
    if(body.operation==='heartbeat'){if(!exact(body,['operation']))throw Error('잘못된 연결 확인입니다.');return {success:true};}
    if(body.operation==='status'){
      if(!exact(body,['operation']))throw Error('상태 요청을 확인하세요.');if(this.receiveAuthorization)try{await this.refreshReception();}catch{}await this.syncApprovals();
      // Do not add an RPC on this shared channel: a slow helper status can occupy it or retire
      // live grants. Only reuse a recent result from the existing management status request.
      const native=this.cachedNativeStatus();
      return {success:true,connection:{id:connection.id,code:connection.code,label:connection.label,scope:'mcp-connection'},available:this.channel.available,restartRequired:this.startedAvailable&&!this.channel.available,
        native,
        grants:this.ownGrants(connection),pending:[...this.pending.values()].filter(p=>p.connection===connection).map(p=>({expiresAt:p.request.expiresAt})),
        guidance:'available은 앱 연결 상태입니다. native는 관리 화면이 최근 확인한 Control 상태이며 확인 전이거나 오래되면 unknown입니다. 창 조작에는 이 AI 연결의 별도 승인이 필요합니다. AgentsToZ의 도구 및 설정 → 컴퓨터 유즈에서 연결과 창을 선택하고 Control 앱에서 승인하세요. 연결은 개별 대화와 다를 수 있습니다. native.capture가 control-update-required이면 Control을 업데이트하기 전에는 capture/click을 쓸 수 없습니다.'};
    }
    if(body.operation==='scope-request-access'){
      if(!exact(body,['operation']))throw Error('승인 요청에는 범위·이름·권한을 넣을 수 없습니다.');
      return this.requestAccess(connection);
    }
    if(body.operation.startsWith('scope-')){
      const caller=this.caller(connection),result=await this.scope.agent(caller,body);
      if(body.operation!=='scope-status')return result;
      // The status just read Control (at most 10 s old): after an app restart the standing allowance is how it is on.
      this.standing=this.scope.knownStanding();const on=this.effectiveAccess().enabled;
      return {...result,success:true,connection:{id:connection.id,code:connection.code,label:connection.label,scope:'mcp-connection'},available:this.channel.available,restartRequired:this.startedAvailable&&!this.channel.available,
        // The host's own word (the person holds the Mac from the Control bar) comes before the request-access hint.
        access:this.publicAccess(),guidance:on&&typeof result.guidance==='string'?result.guidance:on?(this.standing?'grant가 없으면 request-access를 한 번 보내세요. 상시 허용이 켜져 있어 사람의 승인 없이 바로 허용됩니다.':'grant가 없으면 request-access를 한 번 보내 승인을 요청하세요. 범위는 사람이 켠 설정을 따릅니다.'):ACCESS_OFF};
    }
    return this.host.agent(this.caller(connection),body);
  }
  async manage(body:unknown){
    if(!plain(body)||typeof body.operation!=='string')throw Error('컴퓨터 유즈 관리 요청을 확인하세요.');this.reap();
    switch(body.operation){
      case 'status':{
        if(!exact(body,['operation']))throw Error('상태 요청을 확인하세요.');if(this.receiveAuthorization)try{await this.refreshReception();}catch{}await this.syncApprovals();
        let native:Record<string,any>;try{native=await this.channel.request({operation:'status'});this.rememberNativeStatus(native);}catch{native={success:false,code:'helper-unavailable'};this.nativeStatus=undefined;}
        const scoped=await this.scope.managementStatus();
        // The last Control status read (the panel's capability check, an AI's status or request): no extra round trip here.
        this.standing=this.scope.knownStanding();const link=this.link();
        return {success:true,native,access:this.publicAccess(),available:this.channel.available,restartRequired:this.startedAvailable&&!this.channel.available,connections:[...this.connections.values()].map(c=>({id:c.id,code:c.code,label:c.label,scope:c.remote?'remote-connection':'mcp-connection',expiresAt:c.until,
            // A remote row: which device (its own name, 4-character code) and which of its connections (the tag 「끊기」 blocks).
            ...(c.remote?{remote:{deviceId:c.remote.deviceId,deviceName:c.remote.deviceName,deviceCode:c.remote.deviceCode,connection:c.remote.instance}}:{})})),
          grants:this.host.list(),pending:[...this.pending.values()].map(p=>({approvalId:p.request.approvalId,connectionId:p.connection.id,label:p.label,target:p.request.target,expiresAt:p.request.expiresAt})),recovery:this.recovery.pending(),scoped,
          remote:this.remoteSummary(),
          // 「이 Mac의 AI가 다른 Mac을 사용 중」: only when the sidecar gives the link (an older host shows nothing).
          ...(link?{outgoing:outgoingSessions(link)}:{})};
      }
      case 'scope-remote-outgoing-close':{
        // The panel's 「끊기」 for this Mac's own AIs on another Mac: their sessions end (a best-effort sealed disconnect);
        // the next call of such an AI says hello again. Management route only — an AI cannot reach it.
        if(!exact(body,['operation','deviceId'])||typeof body.deviceId!=='string'||!DEVICE_ID.test(body.deviceId.toLowerCase()))throw Error('끊을 기기를 확인하세요.');
        const link=this.link();if(!link)throw Error('다른 Mac 연결 정보를 읽지 못했습니다. 상태를 다시 확인하세요.');
        return {success:true,closed:link.closeDevice(body.deviceId.toLowerCase())};
      }
      case 'scope-request-approval':{
        if(!exact(body,['operation','connectionId','scope','label']))throw Error('허용할 AI 연결과 범위를 선택하세요.');
        const c=[...this.connections.values()].find(c=>c.id===body.connectionId);if(!c)throw Error('해당 AI 연결이 끝났습니다. AI에서 상태를 다시 확인하세요.');
        if(c.remote)throw computerUseRemoteRefusal('REMOTE_OPERATION_REFUSED');
        if(typeof body.label!=='string'||!body.label.trim()||body.label.length>100||/[\u0000-\u001f\u007f]/.test(body.label))throw Error('맡길 작업 이름을 확인하세요.');
        return this.scope.requestApproval(this.caller(c),c.id,body.scope,('연결 '+c.code+' / '+body.label.trim()).slice(0,100));
      }
      case 'scope-access-set':{
        // Off also ends Control's standing allowance: the person's off means no AI asks or acts without them again.
        if(exact(body,['operation','enabled'])&&body.enabled===false){this.turnAccessOff();await this.scope.standingOff();this.standing=await this.scope.standing();return {success:true,access:this.publicAccess()};}
        if(!exact(body,['operation','enabled','scope'])||body.enabled!==true)throw Error('컴퓨터 유즈 켜기 요청을 확인하세요.');
        const scope=parseComputerUseScope(body.scope);
        if(scope.kind==='application'&&protectedScopeBundle(scope.application.bundleId))throw Error('이 앱은 컴퓨터 유즈 대상이 될 수 없습니다.');
        // A different scope first ends what the old one allowed, so no grant outlives the scope the person now sees.
        if(this.access.enabled&&sameComputerUseScope(this.access.scope,scope))return {success:true,access:this.publicAccess()};
        if(this.access.enabled)this.turnAccessOff();
        // An application scope is for this Mac's own AIs only (D6): what another Mac's AI holds under the standing allowance ends.
        if(scope.kind==='application')for(const c of this.connections.values())if(c.remote)this.scope.endSession(c.id);
        this.accessAsked.clear();this.access={enabled:true,scope};return {success:true,access:this.publicAccess()};
      }
      case 'scope-remote-set':return this.setRemote(body);
      case 'scope-status':{
        if(!exact(body,['operation']))throw Error('상태 요청을 확인하세요.');const scoped=await this.scope.refreshCapability();this.standing=this.scope.knownStanding();
        return {success:true,scoped,access:this.publicAccess()};}
      case 'scope-revoke':
        if(!exact(body,['operation','id'])||typeof body.id!=='string')throw Error('종료할 범위 허용을 확인하세요.');return this.scope.revoke(body.id);
      case 'scope-review-recovery':
        if(!exact(body,['operation','id','confirmed'])||body.confirmed!==true||typeof body.id!=='string')throw Error('현재 상태를 직접 확인한 뒤 검토를 완료하세요.');return {success:true,reviewed:this.recovery.reviewScope(body.id)};
      case 'request-approval':{
        if(!exact(body,['operation','connectionId','target','label']))throw Error('허용할 AI 연결과 창을 선택하세요.');
        const c=[...this.connections.values()].find(c=>c.id===body.connectionId);if(!c)throw Error('해당 AI 연결이 끝났습니다. AI에서 상태를 다시 확인하세요.');
        if(c.remote)throw computerUseRemoteRefusal('REMOTE_OPERATION_REFUSED');
        if(!this.channel.available)throw Error('서명된 컴퓨터 유즈 도우미 연결을 준비하세요.');
        const caller=this.caller(c),generation=computerCallerGeneration(caller)!;
        if(typeof body.label!=='string'||!body.label.trim()||body.label.length>100||/[\u0000-\u001f\u007f]/.test(body.label))throw Error('맡길 작업 이름을 확인하세요.');
        // The client-supplied display name never becomes a native confirmation code or approval label.
        const label=('연결 '+c.code+' / '+body.label.trim()).slice(0,100);
        const request=this.host.requestApproval(caller,parseComputerTarget(body.target),label);
        this.pending.set(request.approvalId,{connection:c,caller,generation,request,label});
        let result:Record<string,any>;
        try{result=await this.channel.request({...request,operation:'request-approval',caller:{...request.caller,generation},label});}
        catch(error){
          if((error as {notDispatched?:boolean})?.notDispatched===true){this.pending.delete(request.approvalId);this.approvals.cancel(request.approvalId);}
          throw Error('승인 요청의 전달이 미확인입니다. 대기 상태를 확인하고 새 요청으로 자동 재전송하지 마세요.');
        }
        if(computerCallerGeneration(caller)!==generation||!this.pending.has(request.approvalId))throw Error('AI 연결이 끝나 승인 요청을 취소했습니다.');
        if(result.success!==true){if(result.notDispatched===true){this.pending.delete(request.approvalId);this.approvals.cancel(request.approvalId);}throw Error('승인 요청의 전달을 확인하지 못했습니다. 대기 상태를 확인하고 새 요청으로 자동 재전송하지 마세요.');}
        return {success:true,approvalId:request.approvalId,state:'pending',expiresAt:request.expiresAt};
      }
      case 'revoke':
        if(!exact(body,['operation','id'])||typeof body.id!=='string')throw Error('종료할 허용을 확인하세요.');return this.host.revoke(body.id);
      case 'disconnect':{
        if(!exact(body,['operation','connectionId']))throw Error('종료할 AI 연결을 확인하세요.');
        for(const[key,c]of this.connections)if(c.id===body.connectionId){this.connections.delete(key);this.end(c);}return {success:true};
      }
      case 'review-recovery':
        if(!exact(body,['operation','id','confirmed'])||body.confirmed!==true||typeof body.id!=='string')throw Error('앱의 현재 상태를 직접 확인한 뒤 검토를 완료하세요.');
        return {success:true,reviewed:this.recovery.review(body.id)};
      default:throw Error('지원하지 않는 컴퓨터 유즈 관리 요청입니다.');
    }
  }
  dispose(){if(this.disposed)return;this.disposed=true;for(const c of this.connections.values())this.end(c);this.connections.clear();this.host.dispose();this.scope.dispose();this.pending.clear();this.publicKey=undefined;this.channel.dispose();}
}
