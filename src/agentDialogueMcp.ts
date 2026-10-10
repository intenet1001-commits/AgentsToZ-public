import {parseAgentDialogueRequest,type AgentDialogueRequest} from './agentDialogueContract';

const source={type:'object',properties:{target:{type:'string',enum:['ops']},portId:{type:'string',minLength:1,maxLength:200}},oneOf:[
  {required:['target'],not:{required:['portId']}},{required:['portId'],not:{required:['target']}}],additionalProperties:false};
const id={type:'string',format:'uuid'};
const base={source};
export const AGENT_DIALOGUE_MCP_TOOLS=[
  {name:'agentstoz_use_list_dialogue_peers',description:'List exact OPS/project endpoints on connected devices for this local OPS or project. Matching names or memories never auto-select a peer.',inputSchema:{type:'object',properties:base,required:['source'],additionalProperties:false}},
  {name:'agentstoz_use_create_dialogue',description:'Request a 2–8 endpoint room. The local app must approve this exact source and recipients before retrying the same requestId.',inputSchema:{type:'object',properties:{...base,endpointIds:{type:'array',items:id,minItems:1,maxItems:7},requestId:id},required:['source','endpointIds','requestId'],additionalProperties:false}},
  {name:'agentstoz_use_community_status',description:'Read this endpoint\'s standing community membership: the one group room of this Control profile, whether this endpoint is inside, and who else is. Devices that are inside talk to each other with no invitation and no per-message approval.',inputSchema:{type:'object',properties:base,required:['source'],additionalProperties:false}},
  {name:'agentstoz_use_enter_community',description:'Ask to enter the community. Entering publishes this endpoint into the standing group room, so the local app always approves it. Once inside, membership lasts until it leaves.',inputSchema:{type:'object',properties:{...base,requestId:id},required:['source','requestId'],additionalProperties:false}},
  {name:'agentstoz_use_pair_dialogue_peer',description:'Accept a 30-day mutual pairing with one exact peer endpoint. Both sides must accept; after that, rooms with that peer open without a per-room approval and its invitations are joined automatically. The local app approves every pairing. Keep requestId on retry.',inputSchema:{type:'object',properties:{...base,peerEndpointId:id,requestId:id},required:['source','peerEndpointId','requestId'],additionalProperties:false}},
  {name:'agentstoz_use_list_dialogue_pairings',description:'List this endpoint\'s pairings with their state (active, waiting-peer, expired) and expiry. A listed pairing is not proof that a message was read.',inputSchema:{type:'object',properties:base,required:['source'],additionalProperties:false}},
  {name:'agentstoz_use_revoke_dialogue_pairing',description:'End a pairing from either side at once. Rooms already open stay, but new ones ask for approval again.',inputSchema:{type:'object',properties:{...base,peerEndpointId:id,requestId:id},required:['source','peerEndpointId','requestId'],additionalProperties:false}},
  {name:'agentstoz_use_list_dialogue_invitations',description:'Read invitations addressed to this exact local OPS or project endpoint.',inputSchema:{type:'object',properties:base,required:['source'],additionalProperties:false}},
  {name:'agentstoz_use_join_dialogue',description:'Request to join an invitation. The local app must approve this exact endpoint and room.',inputSchema:{type:'object',properties:{...base,roomId:id,requestId:id},required:['source','roomId','requestId'],additionalProperties:false}},
  {name:'agentstoz_use_invite_dialogue_peer',description:'Invite one exact peer endpoint into a room you own. Keep requestId on retry.',inputSchema:{type:'object',properties:{...base,roomId:id,participantId:id,endpointId:id,requestId:id},required:['source','roomId','participantId','endpointId','requestId'],additionalProperties:false}},
  {name:'agentstoz_use_send_dialogue_message',description:'Send bounded untrusted text to joined peers. A send receipt confirms storage, not that another AI read or acted.',inputSchema:{type:'object',properties:{...base,roomId:id,participantId:id,requestId:id,kind:{type:'string',enum:['question','answer','observation','build-receipt']},text:{type:'string',minLength:1,maxLength:4000},toParticipantIds:{type:'array',items:id,minItems:1,maxItems:7}},required:['source','roomId','participantId','requestId','kind','text'],additionalProperties:false}},
  {name:'agentstoz_use_wait_dialogue_messages',description:'Read the next ordered messages for this exact participant; completed AI turns are not restarted automatically.',inputSchema:{type:'object',properties:{...base,roomId:id,participantId:id,afterSeq:{type:'integer',minimum:0},timeoutMs:{type:'integer',minimum:0,maximum:30000}},required:['source','roomId','participantId','afterSeq'],additionalProperties:false}},
  {name:'agentstoz_use_leave_dialogue',description:'Leave this room as the selected local OPS or project.',inputSchema:{type:'object',properties:{...base,roomId:id,participantId:id,requestId:id},required:['source','roomId','participantId','requestId'],additionalProperties:false}},
  {name:'agentstoz_use_close_dialogue',description:'Close a room owned by the selected local OPS or project.',inputSchema:{type:'object',properties:{...base,roomId:id,participantId:id,requestId:id},required:['source','roomId','participantId','requestId'],additionalProperties:false}},
] as const;
const actions:Record<string,AgentDialogueRequest['operation']>={
  agentstoz_use_list_dialogue_peers:'peers',agentstoz_use_create_dialogue:'create',
  agentstoz_use_list_dialogue_invitations:'invitations',agentstoz_use_join_dialogue:'join',
  agentstoz_use_invite_dialogue_peer:'invite',agentstoz_use_send_dialogue_message:'send',
  agentstoz_use_wait_dialogue_messages:'wait',agentstoz_use_leave_dialogue:'leave',agentstoz_use_close_dialogue:'close',
  agentstoz_use_pair_dialogue_peer:'pair',agentstoz_use_revoke_dialogue_pairing:'pair-revoke',
  agentstoz_use_list_dialogue_pairings:'pairings',
  agentstoz_use_community_status:'community-status',agentstoz_use_enter_community:'community-join',
};
export function isAgentDialogueMcpTool(name:unknown):name is keyof typeof actions{return typeof name==='string'&&Object.hasOwn(actions,name);}
export function agentDialogueMcpRequest(name:string,args:unknown):AgentDialogueRequest{
  if(!isAgentDialogueMcpTool(name)||!args||typeof args!=='object'||Array.isArray(args))throw Error('알 수 없는 대화 도구입니다.');
  return parseAgentDialogueRequest({operation:actions[name],...args});
}
