import {lstatSync,readFileSync,renameSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {AI_TERMINAL_AGENTS,type AiTerminalAgent} from './aiTerminalProtocol';

/**
 * The AI (and surface) this device last opened 아젠투지 OPS with from 「아젠투지 설정」.
 *
 * The panel kept its choice only in React state, so after opening the OPS workroom with Antigravity
 * the voice host — which runs in the sidecar and cannot read the page — still started codex when it
 * needed an OPS workroom. A tiny per-device file in the app data directory is the least invasive
 * shared place: the panel writes it by opening OPS, voice reads it, and the panel restores its
 * selects from it. It is a preference, not an authority; a damaged file reads as «none».
 */
export const OPS_LAUNCH_PREFERENCE_FILE='ops-launch-preference.json';
export const OPS_LAUNCH_SURFACES=['app','workroom','orca-floating','orca-worktree'] as const;
export type OpsLaunchSurface=typeof OPS_LAUNCH_SURFACES[number];
export interface OpsLaunchPreference {agent:AiTerminalAgent;surface:OpsLaunchSurface;updatedAt:string}

function valid(agent:unknown,surface:unknown):agent is AiTerminalAgent{
  // agy+app is Antigravity.app (launch/focus only — it takes no folder); every AI × surface pair is valid.
  return AI_TERMINAL_AGENTS.includes(agent as AiTerminalAgent)&&OPS_LAUNCH_SURFACES.includes(surface as OpsLaunchSurface);
}

export function readOpsLaunchPreference(appDataDir:string):OpsLaunchPreference|null{
  try{
    const path=join(appDataDir,OPS_LAUNCH_PREFERENCE_FILE),stat=lstatSync(path);
    if(!stat.isFile()||stat.size>4096)return null;
    const value=JSON.parse(readFileSync(path,'utf8')) as Record<string,unknown>|null;
    if(!value||typeof value!=='object'||!valid(value.agent,value.surface))return null;
    return {agent:value.agent as AiTerminalAgent,surface:value.surface as OpsLaunchSurface,updatedAt:typeof value.updatedAt==='string'?value.updatedAt.slice(0,40):''};
  }catch{return null;}
}

export function writeOpsLaunchPreference(appDataDir:string,input:{agent:unknown;surface:unknown},now=new Date()):OpsLaunchPreference|null{
  if(!valid(input.agent,input.surface))return null;
  const value:OpsLaunchPreference={agent:input.agent,surface:input.surface as OpsLaunchSurface,updatedAt:now.toISOString()};
  const path=join(appDataDir,OPS_LAUNCH_PREFERENCE_FILE),temporary=`${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary,JSON.stringify(value),{mode:0o600});renameSync(temporary,path);
  return value;
}

/**
 * What a panel OPS open teaches: only a confirmed open that named an AI. A launch the host could not confirm
 * (`launchVerified:false`, e.g. Antigravity.app past its deadline) is not a choice the user saw work.
 */
export function opsLaunchPreferenceFromOpen(request:{action?:unknown;agent?:unknown;surface?:unknown},result:{performed?:unknown;launchVerified?:unknown}|null|undefined):{agent:AiTerminalAgent;surface:OpsLaunchSurface}|null{
  if(result?.performed!==true||result.launchVerified===false)return null;
  const surface=request.action==='start-workroom-session'?'workroom':request.action==='open-code-app'?(request.surface??'app'):null;
  return surface!==null&&valid(request.agent,surface)?{agent:request.agent,surface:surface as OpsLaunchSurface}:null;
}

/** Re-exported so the sidecar keeps one import site; the function itself is browser-safe. */
export {opsWorkroomAgentFrom} from './opsWorkroomAgent';
