import {communityControlDetachable,type CommunityControlDetached,type CommunityControlFrom} from './agentDialogueControl';
import {AgentDialogueHostError} from './agentDialogueHost';
import type {ComputerCallerHost,ComputerCallerHostResolver,ComputerCallerOrigin} from './computerUseCallerHost';
import {
  ComputerUseRemoteClient,
  handleComputerUseRemote,
  type ComputerUseRemoteClientDependencies,
  type ComputerUseRemoteDialogue,
} from './computerUseRemoteClient';
import {ComputerUseRemoteHost,type ComputerUseRemoteHostDependencies,type ComputerUseRemoteHostRuntime} from './computerUseRemoteHost';
import {COMPUTER_USE_REMOTE_KIND} from './computerUseRemoteProtocol';
import type {ComputerUseRemoteLink} from './computerUseRuntime';
import type {ComputerUseCommunityIdentity} from './computerUseAuthenticatedHandshake';

/**
 * Computer use between community Macs, wired into one sidecar (WP6; docs/design/remote-computer-use-2026-11-01/DESIGN.md
 * §6, RC-12, RC-13, RC-14). api-server builds one of these over its community mailbox and its ComputerUseRuntime; the
 * two-host test (tests/computer-use-remote-two-host.test.ts) builds two over a PGlite mailbox, so the wiring under test is
 * the wiring that ships.
 *
 * - Receiving (B): the community executor's `computerUse` is `host.execute`, and the poll passes `pollOptions` so a
 *   detached call row is answered later through the mailbox's `controlRespond`. The host posts its notices with the
 *   mailbox's `communityNotice`. Production rechecks the installed executable and the signed Main peer before receiving.
 * - Sending (A): `route` is the loopback route COMPUTER_USE_REMOTE_AGENT_PATH over this sidecar's client.
 * - The runtime is created only when a row actually needs it (B), never just to read the chain guard (A).
 * - `dispose` stops the client's tick and answers inputs still waiting in B's lane as not run; call it before the mailbox
 *   stops.
 */

/** RC-12: require installed binary and the live audit-token-verified signed Main, as well as platform. */
export function computerUseRemoteReceives(facts:{bundled:boolean;platform:string;verifiedMain:boolean;executablePath:string}):boolean{
  return facts.bundled===true&&facts.platform==='darwin'&&facts.verifiedMain===true&&
    facts.executablePath==='/Applications/AgentsToZ_byCS.app/Contents/Resources/resources/agentstoz-api-sidecar';
}

/** RC-14: the app's general device-control call refuses the computer-use kind (it travels only on its own sealed route). */
export const COMMUNITY_CONTROL_COMPUTER_USE_REFUSAL='컴퓨터 유즈 요청은 이 경로로 보낼 수 없습니다. AI는 agentstoz_use_computer_session에 device를 넣어 씁니다.';
export function refuseCommunityControlComputerUse(request:Record<string,unknown>):void{
  if(request?.kind===COMPUTER_USE_REMOTE_KIND)
    throw new AgentDialogueHostError('AGENT_DIALOGUE_INPUT_INVALID',COMMUNITY_CONTROL_COMPUTER_USE_REFUSAL,400);
}

/** What the sidecar needs of ComputerUseRuntime (src/computerUseRuntime.ts). */
export interface ComputerUseRemoteSidecarRuntime extends ComputerUseRemoteHostRuntime {hasIncomingRemoteGrant():boolean}
export interface ComputerUseRemoteSidecarDependencies {
  identity?:ComputerUseCommunityIdentity;
  /** The community mailbox (AgentDialogueHost). */
  dialogue:ComputerUseRemoteDialogue&{
    controlRespond(controlId:string,response:Record<string,unknown>):Promise<unknown>;
    communityNotice(text:string,requestId:string):Promise<unknown>;
  };
  /** This Mac's runtime, created on first use. */
  runtime():ComputerUseRemoteSidecarRuntime;
  /** The runtime only if it already exists (nothing to hold a grant otherwise). */
  existingRuntime():ComputerUseRemoteSidecarRuntime|null;
  /** The community identity deviceId (the inbox's to_device_id), never an endpointId. */
  selfDeviceId():string|null|undefined;
  deviceName?():string|null|undefined;
  /** Live verified admission check in production; injectable in isolated tests. */
  bundled:boolean|(()=>boolean);
  /** process.platform. */
  platform:string;
  now?():number;
  /** Tests only: the receiving host's shorter bounds and timers. */
  host?:Pick<ComputerUseRemoteHostDependencies,'limits'|'timers'>;
  /** Tests only: the sending client's shorter waits and timer. */
  client?:Pick<ComputerUseRemoteClientDependencies,'limits'|'timers'>;
}
export interface ComputerUseRemoteSidecar {
  readonly host:ComputerUseRemoteHost;
  readonly client:ComputerUseRemoteClient;
  /** createCommunityControlExecutor's `computerUse`. */
  computerUse(request:Record<string,unknown>,from:CommunityControlFrom,controlId:string):Promise<Record<string,unknown>|CommunityControlDetached>;
  /** controlPoll's options: only a computer-use `call` row may be answered after the poll moved on. */
  readonly pollOptions:{detach:(request:Record<string,unknown>)=>boolean};
  /** `POST COMPUTER_USE_REMOTE_AGENT_PATH`: the caller's server-side readings come in `options`. */
  route(request:Request,options:{authorized:boolean;opsWorker?:()=>Promise<boolean>;host?:()=>Promise<string|null>}):Promise<Response>;
  dispose():Promise<void>;
}

export function createComputerUseRemoteSidecar(deps:ComputerUseRemoteSidecarDependencies):ComputerUseRemoteSidecar{
  const now=deps.now;
  const host=new ComputerUseRemoteHost({
    identity:deps.identity,
    runtime:{
      remote:(sessionKey,peer,body)=>deps.runtime().remote(sessionKey,peer,body),
      remoteAdmission:peer=>deps.runtime().remoteAdmission(peer),
      // The notices read who holds a grant; without a runtime nobody does.
      remoteGrants:()=>deps.existingRuntime()?.remoteGrants()??[],
    },
    respond:(controlId,response)=>deps.dialogue.controlRespond(controlId,response),
    notice:(text,requestId)=>deps.dialogue.communityNotice(text,requestId),
    selfDeviceId:deps.selfDeviceId,
    ...(deps.deviceName?{deviceName:deps.deviceName}:{}),
    bundled:deps.bundled,
    platform:deps.platform,
    ...(now?{now}:{}),
    ...deps.host,
  });
  const client=new ComputerUseRemoteClient({
    identity:deps.identity,
    dialogue:deps.dialogue,
    // RC-13 chain guard: read only from a runtime that exists; creating one would not add a grant.
    incomingRemoteGrant:()=>deps.existingRuntime()?.hasIncomingRemoteGrant()===true,
    platform:deps.platform,
    ...(now?{now}:{}),
    ...deps.client,
  });
  return {
    host,client,
    computerUse:(request,from,controlId)=>host.execute(request,from,controlId),
    pollOptions:{detach:communityControlDetachable},
    route:(request,options)=>handleComputerUseRemote(request,()=>client,options),
    async dispose(){client.dispose();await host.dispose();},
  };
}

/** Live panel adapter: resolve shared-folder state and the sending client's current sessions on every read. */
export function computerUseRemotePanelLink(client:Pick<ComputerUseRemoteClient,'usage'|'closeDevice'>, profile:{sharedProfileId():string|null}):ComputerUseRemoteLink{
  return {profileReady:()=>profile.sharedProfileId()!==null,usage:()=>client.usage(),closeDevice:deviceId=>client.closeDevice(deviceId)};
}

/**
 * The host app label B shows in its grant label (`… / 연결 <code> / client·host · 전체 Mac`): the apps the calling MCP
 * process runs in, read from its loopback socket's process ancestry like a local connection's (src/computerUseCallerHost.ts).
 * Display only — it authorizes nothing on either Mac. One reading per MCP instance (the process's 64-hex header), so the
 * process table is not read on every remote request; at most `max` instances are remembered.
 */
const HOST_NAMES:Record<string,string>={'com.intenet.agentstozbycs':'AgentsToZ','com.stablyai.orca':'Orca','com.openai.codex':'Codex','com.openai.chat':'ChatGPT',
  'com.anthropic.claudefordesktop':'Claude','com.apple.terminal':'Terminal','com.googlecode.iterm2':'iTerm','dev.warp.warp-stable':'Warp','com.mitchellh.ghostty':'Ghostty'};
const INSTANCE=/^[a-f0-9]{64}$/;
export function computerUseRemoteHostLabel(host:ComputerCallerHost):string|null{
  if(host.state!=='known'||!host.bundleIds.length)return null;
  return host.bundleIds.map(id=>HOST_NAMES[id.toLowerCase()]??id.split('.').filter(Boolean).at(-1)??id).join('/');
}
export function computerUseRemoteCallerHosts(resolve:ComputerCallerHostResolver,max=64){
  const cache=new Map<string,Promise<string|null>>();
  return (instance:unknown,origin:ComputerCallerOrigin|null):Promise<string|null>=>{
    if(typeof instance!=='string'||!INSTANCE.test(instance))return Promise.resolve(null);
    const known=cache.get(instance);
    if(known){cache.delete(instance);cache.set(instance,known);return known;}
    const label=Promise.resolve().then(()=>resolve(origin)).then(computerUseRemoteHostLabel,()=>null);
    cache.set(instance,label);
    while(cache.size>max)cache.delete(cache.keys().next().value as string);
    return label;
  };
}
