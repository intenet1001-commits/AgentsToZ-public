import {invoke} from '@tauri-apps/api/core';
import {isTauri} from './lib/env';
import {AiTerminalServerResponseError,type AiTerminalTransport} from './aiTerminalClient';
import {normalizeAiTerminalResponse} from './aiTerminalProtocol';
import type {WorkroomTransport} from './WorkroomSessionFooter';
import type {WorkroomMentionProject} from './workroomProjectMention';

/** Another community Mac this one can drive (src/agentDialogueHost.ts controlDevices). */
export interface CommunityControlDevice {endpointId:string;deviceId:string;displayName:string;kind:'ops'|'project';lastSeenAt:string|null}
export interface CommunityControlDevices {inside:boolean;deviceId:string;devices:CommunityControlDevice[];
  /** 이 기기 앞으로 와 있는 읽지 않은 커뮤니티 메시지. 기기 조회가 이미 부르는 status에서 덤으로 온다. */
  unread:number;lastMessageAt:string|null}
export interface CommunityRemoteProjects {projects:WorkroomMentionProject[];opsTargetId:string|null;deviceName:string}

/** Same authenticated channel as 「아젠투지 설정」, on its own route with room for terminal input. */
async function controlRequest(body:Record<string,unknown>):Promise<Record<string,any>>{
  if(isTauri()&&String(import.meta.env.DEV)!=='true'){
    const proxied=await invoke<{status:number;body:Record<string,any>}>('agent_dialogue_control_request',{body});
    const value=proxied?.body;
    if(!Number.isInteger(proxied?.status)||!value||proxied.status<200||proxied.status>=300||value.success!==true)
      throw new AiTerminalServerResponseError(value?.error??'다른 기기의 응답을 확인하지 못했습니다.');
    return value;
  }
  const response=await fetch(`${isTauri()?'http://127.0.0.1:3001':''}/api/agent-dialogue/control`,{
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(30_000),
  });
  const value=await response.json().catch(()=>null);
  if(!response.ok||value?.success!==true)throw new AiTerminalServerResponseError(value?.error??'다른 기기 제어 요청에 실패했습니다.');
  return value;
}

export async function listCommunityControlDevices():Promise<CommunityControlDevices>{
  const value=await controlRequest({operation:'devices'});
  const devices=(Array.isArray(value.devices)?value.devices:[]).filter((d:any)=>typeof d?.endpointId==='string'&&typeof d?.deviceId==='string')
    .map((d:any)=>({endpointId:d.endpointId,deviceId:d.deviceId,displayName:typeof d.displayName==='string'?d.displayName:d.deviceId,
      kind:d.kind==='project'?'project':'ops',lastSeenAt:typeof d.lastSeenAt==='string'?d.lastSeenAt:null}) as CommunityControlDevice);
  return {inside:value.inside===true,deviceId:String(value.deviceId??''),devices,
    unread:Number.isSafeInteger(value.unread)&&Number(value.unread)>0?Number(value.unread):0,
    lastMessageAt:typeof value.lastMessageAt==='string'?value.lastMessageAt:null};
}

/** The other Mac's answer: `{ok:true, body}` or `{ok:false, error}` (agentDialogueHost.controlPoll). */
async function callDevice(endpointId:string,request:Record<string,unknown>):Promise<Record<string,any>>{
  const {response}=await controlRequest({operation:'call',targetEndpointId:endpointId,request});
  if(!response||typeof response!=='object')throw new AiTerminalServerResponseError('다른 기기의 응답을 확인하지 못했습니다.');
  if(response.ok!==true)throw new AiTerminalServerResponseError(typeof response.error==='string'?response.error:'다른 기기에서 요청을 처리하지 못했습니다.');
  return response.body&&typeof response.body==='object'?response.body:{};
}

const safeId=(value:unknown)=>typeof value==='string'&&/^[A-Za-z0-9_-]{8,128}$/.test(value);
export async function loadCommunityRemoteProjects(endpointId:string):Promise<CommunityRemoteProjects>{
  const body=await callDevice(endpointId,{kind:'projects'});
  const projects=(Array.isArray(body.projects)?body.projects:[]).filter((p:any)=>safeId(p?.targetId)&&typeof p?.label==='string')
    .map((p:any)=>({targetId:p.targetId,label:String(p.label).replace(/[\u0000-\u001f\u007f]/g,' ').slice(0,120),
      ...(safeId(p.projectTargetId)?{projectTargetId:p.projectTargetId}:{}),
      ...(p.scope==='main'||p.scope==='worktree'?{scope:p.scope}:{}),worktreeCapable:p.worktreeCapable===true}));
  return {projects,opsTargetId:safeId(body.opsTargetId)?body.opsTargetId:null,
    deviceName:typeof body.deviceName==='string'&&body.deviceName.trim()?body.deviceName.trim().slice(0,60):'다른 기기'};
}

/** The Workroom screen's transports, pointed at another community Mac instead of this one. */
export function communityTerminalTransport(endpointId:string):AiTerminalTransport{
  return async request=>normalizeAiTerminalResponse((await callDevice(endpointId,{kind:'terminal',body:request})).result);
}
export function communityWorkroomTransport(endpointId:string):WorkroomTransport{
  return async request=>{
    const {normalizeMobileWorkspaceResult}=await import('./mobileWorkspaceProtocol');
    return normalizeMobileWorkspaceResult((await callDevice(endpointId,{kind:'terminal',body:request as unknown as Record<string,unknown>})).result);
  };
}
