/** Cross-device dialogue is addressed to one local OPS or registered project endpoint. */
/**
 * 2 adds the 30-day mutual pairing operations (`pair`, `pair-revoke`, `pairings`).
 * 3 adds the community: one standing group room per Control profile that each endpoint enters once
 *   and stays in until it leaves (`community-join`, `community-leave`, `community-status`). It
 *   replaces «who calls whom» — the pairwise operations stay for private one-to-one rooms.
 */
export const AGENT_DIALOGUE_CONTRACT_VERSION = 3;
export const AGENT_DIALOGUE_MAX_BODY_BYTES = 4_000;
export const AGENT_DIALOGUE_MAX_PEERS = 7;
export const AGENT_DIALOGUE_MAX_WAIT_MS = 30_000;

export type AgentDialogueTarget = {target:'ops';portId?:never} | {portId:string;target?:never};
export type AgentDialogueOperation = 'peers'|'create'|'invitations'|'join'|'invite'|'send'|'wait'|'leave'|'close'
  |'pair'|'pair-revoke'|'pairings'|'community-join'|'community-leave'|'community-status';
export type AgentDialogueMessageKind = 'question'|'answer'|'observation'|'build-receipt';
export interface AgentDialogueRequest {
  operation:AgentDialogueOperation;
  source:AgentDialogueTarget;
  requestId?:string;
  roomId?:string;
  participantId?:string;
  endpointIds?:string[];
  endpointId?:string;
  peerEndpointId?:string;
  toParticipantIds?:string[];
  kind?:AgentDialogueMessageKind;
  text?:string;
  afterSeq?:number;
  timeoutMs?:number;
}
export class AgentDialogueContractError extends Error {
  constructor(readonly code:string,message:string){super(message);this.name='AgentDialogueContractError';}
}
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
function fail(field:string):never{throw new AgentDialogueContractError('AGENT_DIALOGUE_INPUT_INVALID',`${field} 값이 올바르지 않습니다.`);}
function uuid(value:unknown,field:string):string{if(typeof value!=='string'||!UUID.test(value))fail(field);return value.toLowerCase();}
function uuids(value:unknown,field:string,max:number):string[]{
  if(!Array.isArray(value)||value.length<1||value.length>max)fail(field);
  const ids=value.map(item=>uuid(item,field));if(new Set(ids).size!==ids.length)fail(field);return ids;
}
function keys(value:Record<string,unknown>,allowed:string[]):void{if(Object.keys(value).some(key=>!allowed.includes(key)))fail('요청 필드');}
export function parseAgentDialogueTarget(value:unknown):AgentDialogueTarget{
  if(!object(value))fail('source');
  keys(value,['target','portId']);
  if(value.target==='ops'&&value.portId===undefined)return {target:'ops'};
  if(value.target===undefined&&typeof value.portId==='string'&&value.portId.trim()===value.portId&&value.portId.length>0&&value.portId.length<=200)return {portId:value.portId};
  return fail('source');
}
/** Reject unknown fields and silently coercible IDs before a request reaches the host. */
export function parseAgentDialogueRequest(raw:unknown):AgentDialogueRequest{
  if(!object(raw))fail('요청');
  const operation=raw.operation;
  if(!['peers','create','invitations','join','invite','send','wait','leave','close','pair','pair-revoke','pairings',
    'community-join','community-leave','community-status'].includes(String(operation)))fail('operation');
  const source=parseAgentDialogueTarget(raw.source);
  const base=['operation','source'];
  const common=['requestId','roomId','participantId'];
  const allowed:Record<AgentDialogueOperation,string[]>={
    peers:base,create:[...base,'endpointIds','requestId'],invitations:base,
    join:[...base,'roomId','requestId'],invite:[...base,...common,'endpointId'],
    send:[...base,...common,'kind','text','toParticipantIds'],wait:[...base,'roomId','participantId','afterSeq','timeoutMs'],
    leave:[...base,...common],close:[...base,...common],
    pair:[...base,'peerEndpointId','requestId'],'pair-revoke':[...base,'peerEndpointId','requestId'],pairings:base,
    'community-join':[...base,'requestId'],'community-leave':[...base,'requestId'],'community-status':base,
  };
  const action=operation as AgentDialogueOperation;keys(raw,allowed[action]);
  const out:AgentDialogueRequest={operation:action,source};
  if(!['peers','invitations','wait','pairings','community-status'].includes(action))out.requestId=uuid(raw.requestId,'requestId');
  if(!['peers','create','invitations','pair','pair-revoke','pairings',
    'community-join','community-leave','community-status'].includes(action))out.roomId=uuid(raw.roomId,'roomId');
  if(['invite','send','wait','leave','close'].includes(action))out.participantId=uuid(raw.participantId,'participantId');
  if(action==='create')out.endpointIds=uuids(raw.endpointIds,'endpointIds',AGENT_DIALOGUE_MAX_PEERS);
  if(action==='invite')out.endpointId=uuid(raw.endpointId,'endpointId');
  if(action==='pair'||action==='pair-revoke')out.peerEndpointId=uuid(raw.peerEndpointId,'peerEndpointId');
  if(action==='send'){
    if(!['question','answer','observation','build-receipt'].includes(String(raw.kind)))fail('kind');
    if(typeof raw.text!=='string'||!raw.text.trim()||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(raw.text))fail('text');
    const text=raw.text.replace(/\r\n?/g,'\n').trim();
    if(new TextEncoder().encode(text).length>AGENT_DIALOGUE_MAX_BODY_BYTES)fail('text');
    out.kind=raw.kind as AgentDialogueMessageKind;out.text=text;
    if(raw.toParticipantIds!==undefined)out.toParticipantIds=uuids(raw.toParticipantIds,'toParticipantIds',AGENT_DIALOGUE_MAX_PEERS);
  }
  if(action==='wait'){
    if(!Number.isSafeInteger(raw.afterSeq)||Number(raw.afterSeq)<0)fail('afterSeq');
    if(raw.timeoutMs!==undefined&&(!Number.isSafeInteger(raw.timeoutMs)||Number(raw.timeoutMs)<0||Number(raw.timeoutMs)>AGENT_DIALOGUE_MAX_WAIT_MS))fail('timeoutMs');
    out.afterSeq=raw.afterSeq as number;out.timeoutMs=raw.timeoutMs===undefined?0:raw.timeoutMs as number;
  }
  return out;
}
