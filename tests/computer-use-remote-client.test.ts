import {PGlite} from '@electric-sql/pglite';
import {afterEach,expect,test} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {AGENT_DIALOGUE_SQL} from '../src/agentDialogueSql';
import {AGENT_DIALOGUE_CONTROL_DETACHED,AgentDialogueHost,type AgentDialogueControlCallOptions,type AgentDialogueControlDevice} from '../src/agentDialogueHost';
import type {AgentDialogueTarget} from '../src/agentDialogueContract';
import {COMMUNITY_CONTROL_EXECUTE_TIMEOUT_MESSAGE,OPS_REQUEST_LEGACY_UNSUPPORTED_MESSAGE} from '../src/opsRequestProtocol';
import {COMPUTER_USE_CLIENT_HEADER,COMPUTER_USE_INSTANCE_HEADER} from '../src/computerUseConnectionProtocol';
import {
  COMPUTER_USE_REMOTE_AGENT_PATH,
  COMPUTER_USE_REMOTE_MCP_ALIVE_MS,
  COMPUTER_USE_REMOTE_TICK_MS,
  ComputerUseRemoteClient,
  computerUseRemoteErrorFrame,
  computerUseRemoteReplyFrame,
  handleComputerUseRemote,
  parseComputerUseRemoteReplyContent,
  type ComputerUseRemoteClientLimits,
  type ComputerUseRemoteDialogue,
} from '../src/computerUseRemoteClient';
import {
  COMMUNITY_CONTROL_POLL_BUSY_MESSAGE,
  COMPUTER_USE_REMOTE_LIMITS,
  computerUseRemoteConnectionTag,
  computerUseRemoteEnvelopeRefusal,
  newComputerUseRemoteId,
  parseComputerUseRemoteCallMeta,
  parseComputerUseRemoteEnvelope,
  remoteReceiptVerdict,
} from '../src/computerUseRemoteProtocol';
import {ComputerUseRemoteChannel,computerUseRemoteCallReplyBody,generateComputerUseRemoteKeyPair} from '../src/computerUseRemoteCrypto';
import {ComputerUseMcpConnection} from '../src/computerUseMcp';

const temporary:string[]=[];
afterEach(()=>{for(const path of temporary.splice(0))rmSync(path,{recursive:true,force:true});});

const GRANT='a'.repeat(64);
const INSTANCE='1'.repeat(64);
const START=Date.parse('2026-11-01T00:00:00.000Z');
const click=(requestId:string)=>({operation:'scope-click',grant:GRANT,epoch:1,observationId:'obs-1',displayId:'d1',requestId,x:10,y:10,button:'left',clickCount:1});
const receiptOf=(requestId:string)=>({operation:'scope-receipt',grant:GRANT,epoch:1,requestId});
const timeoutError=()=>Object.assign(new Error('AGENT_DIALOGUE_CONTROL_TIMEOUT: 상대 기기가 제때 답하지 않았습니다. 요청이 실행됐는지는 알 수 없습니다.'),{code:'AGENT_DIALOGUE_CONTROL_TIMEOUT'});
async function waitFor(check:()=>boolean,label:string,ms=3_000){
  const until=Date.now()+ms;
  while(!check()){if(Date.now()>until)throw new Error(`timed out waiting for ${label}`);await Bun.sleep(5);}
}
/**
 * What the MCP process does with this route's receipt answer (WP5, src/computerUseMcp.ts `remoteReceipt`): it takes the
 * other Mac's raw fields and judges them against its own record of the input (its sentAt, and the bootId the input's own
 * answer carried). The route itself gives no verdict.
 */
function judge(answer:Record<string,unknown>,entry:{requestId:string;sentAt:number;bootId:unknown},now:number){
  const raw=answer.success===true?{success:true,bootId:answer.bootId,evictedThroughSentAt:answer.evictedThroughSentAt,receipt:answer.receipt,
    ...('owner' in answer?{owner:answer.owner}:{}),...('guidance' in answer?{guidance:answer.guidance}:{})}:undefined;
  return remoteReceiptVerdict({requestId:entry.requestId,deviceId:'d',sentAt:entry.sentAt,bootId:String(entry.bootId)},raw,now);
}
/** Background rows run on the link's queue after the request that started them returned: wait until every link is idle. */
const idle=(client:ComputerUseRemoteClient)=>()=>[...(client as unknown as {connections:Map<string,{links:Map<string,{busy:number}>}>}).connections.values()]
  .every(connection=>[...connection.links.values()].every(link=>link.busy===0));

/**
 * A receiving Mac as WP3 will be, reduced to what the sender can observe: the envelope parser, the receiver side of the
 * channel, a ledger keyed by (the mailbox's fromDeviceId, connection tag, requestId), and parts. Its answers go through
 * the same reply-frame helpers the sender reads.
 */
class FakeMac {
  bootId=newComputerUseRemoteId();
  readonly sessions=new Map<string,{channel:ComputerUseRemoteChannel;from:string;instance:string}>();
  readonly ledger=new Map<string,{requestId:string;state:string}>();
  readonly parts=new Map<string,string>();
  readonly log:{op:string;operation?:string;bg?:boolean;from:string;instance?:string;request?:Record<string,unknown>}[]=[];
  /** Overrides one call's reply frame (after the ledger is written for an input). */
  onCall?:(request:Record<string,unknown>)=>{meta:Record<string,unknown>;attachment:Uint8Array|null}|undefined;
  /** Refuses the next part request this many times. */
  losePart=0;
  image=new Uint8Array(0);
  constructor(readonly deviceId:string){}
  restart(){this.bootId=newComputerUseRemoteId();this.sessions.clear();this.ledger.clear();this.parts.clear();}
  ops(op:string,operation?:string){return this.log.filter(entry=>entry.op===op&&(operation===undefined||entry.operation===operation)).length;}
  async handle(request:Record<string,unknown>,from:{deviceId:string}):Promise<Record<string,unknown>>{
    let envelope:ReturnType<typeof parseComputerUseRemoteEnvelope>;
    try{envelope=parseComputerUseRemoteEnvelope(request);}catch{return computerUseRemoteEnvelopeRefusal('REMOTE_BAD_REQUEST');}
    if(envelope.op==='hello'){
      const {keyPair,publicKey}=await generateComputerUseRemoteKeyPair();
      const channel=await ComputerUseRemoteChannel.establish({side:'receiver',privateKey:keyPair.privateKey,peerPublicKey:envelope.pub,
        binding:{session:envelope.session,senderDeviceId:from.deviceId,receiverDeviceId:this.deviceId,instance:envelope.instance,platform:envelope.platform}});
      this.sessions.set(envelope.session,{channel,from:from.deviceId,instance:envelope.instance});
      this.log.push({op:'hello',from:from.deviceId,instance:envelope.instance});
      return {ok:true,body:{v:1,pub:publicKey,bootId:this.bootId}};
    }
    if(envelope.op==='part'){
      this.log.push({op:'part',from:from.deviceId});
      if(this.losePart>0){this.losePart-=1;return computerUseRemoteEnvelopeRefusal('REMOTE_PART_LOST');}
      const rest=this.parts.get(`${envelope.session}|${envelope.seq}|${envelope.ref}`);
      return rest?{ok:true,body:{v:1,box:rest}}:computerUseRemoteEnvelopeRefusal('REMOTE_PART_LOST');
    }
    const session=this.sessions.get(envelope.session);
    if(!session||session.from!==from.deviceId)return computerUseRemoteEnvelopeRefusal('REMOTE_SESSION_MISSING');
    const header={op:envelope.op,seq:envelope.seq,sentAt:envelope.sentAt} as const;
    const {meta}=await session.channel.openRequest(header,envelope.box);
    if(envelope.op!=='call'){
      this.log.push({op:envelope.op,bg:envelope.bg===1,from:from.deviceId,instance:session.instance});
      if(envelope.op==='disconnect')this.sessions.delete(envelope.session);
      return {ok:true,body:{v:1,box:await session.channel.sealReply(header,{})}};
    }
    const {request:call}=parseComputerUseRemoteCallMeta(meta);
    this.log.push({op:'call',operation:call.operation,from:from.deviceId,instance:session.instance,request:meta});
    const result=this.run(call,session);
    const frame=this.onCall?.(call)??computerUseRemoteReplyFrame(result);
    const box=await session.channel.sealReply(header,frame.meta,frame.attachment);
    const {body,rest}=computerUseRemoteCallReplyBody(box);
    if(rest&&body.parts===2)this.parts.set(`${envelope.session}|${envelope.seq}|${body.ref}`,rest);
    return {ok:true,body};
  }
  private run(call:Record<string,unknown>,session:{from:string;instance:string}):Record<string,unknown>{
    const key=`${session.from}|${session.instance}|${String(call.requestId)}`;
    switch(call.operation){
      case 'scope-status':return {success:true,grants:[{grant:GRANT,epoch:1}],remote:{allowRemote:true,standing:true,appScope:false}};
      case 'scope-observe':return {success:true,observationId:'obs-1',...(call.capture===true?{image:{mediaType:'image/jpeg',data:Buffer.from(this.image).toString('base64'),width:1440,height:900}}:{})};
      case 'scope-capture':return {success:true,image:{mediaType:'image/jpeg',data:Buffer.from(this.image).toString('base64')}};
      case 'scope-receipt':return {success:true,bootId:this.bootId,evictedThroughSentAt:null,
        receipt:this.ledger.get(key)??{requestId:String(call.requestId),state:'unseen'}};
      default:{
        const receipt={requestId:String(call.requestId),state:'confirmed'};
        this.ledger.set(key,receipt);
        return {success:true,receipt};
      }
    }
  }
}

/**
 * answer: B answers. drop: B never takes the row. lost: B ran it, the answer never arrives. late: B ran it, the answer
 * arrives after the deadline. busy: B's poll answered its budget sentence without running it. legacy: an AgentsToZ from
 * before this feature answered its unsupported-request sentence.
 */
type Delivery='answer'|'drop'|'lost'|'late'|'busy'|'legacy';
interface Row {controlId:string;source:string;target:string;request:Record<string,unknown>;at:number;response?:Record<string,unknown>;consumed?:boolean}
/** The community mailbox seen from A, with the rows it wrote. Time only moves when the test moves it. */
class FakeDialogue implements ComputerUseRemoteDialogue {
  readonly rows:Row[]=[];
  readonly resultCalls:{ids:string[];source:string}[]=[];
  current=randomUUID();
  readonly active=new Set<string>([this.current]);
  inside=true;
  devicesError:Error|null=null;
  delivery:(request:Record<string,unknown>)=>Delivery=()=>'answer';
  /** Runs inside controlCall before the source check: lets a test move this Mac's endpoint at the worst moment. */
  beforeSend?:(request:Record<string,unknown>)=>void;
  /** The database refuses before writing the row (a control-send refusal token). */
  refuse?:(request:Record<string,unknown>)=>Error|undefined;
  /** Moves the fake clock while a request is in the mailbox. */
  delayMs:(request:Record<string,unknown>)=>number=()=>0;
  readonly macs=new Map<string,{mac:FakeMac;endpointId:string;name:string}>();
  constructor(readonly self:string,readonly clock:{now:number}){}
  addMac(mac:FakeMac,name:string){const endpointId=randomUUID();this.macs.set(mac.deviceId,{mac,endpointId,name});return endpointId;}
  moveEndpoint(){this.current=randomUUID();this.active.add(this.current);return this.current;}
  sent(op?:string){return this.rows.filter(row=>op===undefined||row.request.op===op).length;}
  async controlDevices(){
    if(this.devicesError)throw this.devicesError;
    const devices:AgentDialogueControlDevice[]=this.inside?[...this.macs.values()].map(({mac,endpointId,name})=>({endpointId,deviceId:mac.deviceId,
      displayName:name,kind:'ops' as const,lastSeenAt:new Date(this.clock.now).toISOString()})):[];
    return {inside:this.inside,deviceId:this.self,devices};
  }
  async controlSource(){return this.inside?{deviceId:this.self,endpointId:this.current}:null;}
  async controlCall(target:string,request:Record<string,unknown>,_timeoutMs:number,options:AgentDialogueControlCallOptions){
    this.beforeSend?.(request);
    if(options.sourceEndpointId!==undefined&&options.sourceEndpointId!==this.current)
      throw Object.assign(new Error('이 기기의 커뮤니티 끝점이 바뀌어 보내지 않았습니다.'),{code:'AGENT_DIALOGUE_CONTROL_SOURCE_CHANGED'});
    const entry=[...this.macs.values()].find(item=>item.endpointId===target);
    if(!entry)throw Object.assign(new Error('AGENT_DIALOGUE_CONTROL_TARGET_UNAVAILABLE'),{code:'AGENT_DIALOGUE_REMOTE_FAILED'});
    const refused=this.refuse?.(request);
    if(refused)throw refused;
    const row:Row={controlId:randomUUID(),source:this.current,target,request:structuredClone(request),at:this.clock.now};
    this.rows.push(row);
    options.onSent?.({controlId:row.controlId,sourceEndpointId:row.source,targetDeviceId:entry.mac.deviceId});
    const delivery=this.delivery(request);
    this.clock.now+=this.delayMs(request);
    if(delivery==='drop')throw timeoutError();
    if(delivery==='busy'){row.consumed=true;return {ok:false,error:COMMUNITY_CONTROL_POLL_BUSY_MESSAGE};}
    if(delivery==='legacy'){row.consumed=true;return {ok:false,error:OPS_REQUEST_LEGACY_UNSUPPORTED_MESSAGE};}
    const response=await entry.mac.handle(structuredClone(request),{deviceId:this.self});
    if(delivery==='lost'){row.consumed=true;throw timeoutError();}
    if(delivery==='late'){row.response=response;throw timeoutError();}
    row.consumed=true;
    return response;
  }
  async controlResult(controlIds:readonly string[],sourceEndpointId:string){
    this.resultCalls.push({ids:[...controlIds],source:sourceEndpointId});
    if(!this.active.has(sourceEndpointId))throw Object.assign(new Error('그 요청을 보낸 끝점은 이 기기에서 더 이상 쓰지 않습니다.'),{code:'AGENT_DIALOGUE_SOURCE_UNAVAILABLE'});
    const mine=this.rows.filter(row=>controlIds.includes(row.controlId)&&row.source===sourceEndpointId);
    const results=mine.filter(row=>row.response&&!row.consumed).map(row=>{row.consumed=true;return {controlId:row.controlId,response:row.response!};});
    return {results,waiting:mine.filter(row=>!row.consumed&&!row.response).map(row=>row.controlId)};
  }
}

function setup(options:{limits?:Partial<ComputerUseRemoteClientLimits>;platform?:string;incomingRemoteGrant?:()=>boolean}={}){
  const clock={now:START};
  const self=randomUUID();
  const dialogue=new FakeDialogue(self,clock);
  const mac=new FakeMac(randomUUID());
  const endpointId=dialogue.addMac(mac,'아젠투지 3호 / 아젠투지(OPS)');
  // The client's 5 s tick, run by the test when it moves the clock (never by real time).
  const timer={callback:null as (()=>void)|null,ms:0,started:0,cleared:0};
  const timers={setInterval:(callback:()=>void,ms:number)=>{timer.callback=callback;timer.ms=ms;timer.started+=1;return timer.started;},
    clearInterval:()=>{timer.callback=null;timer.cleared+=1;}};
  const client=new ComputerUseRemoteClient({dialogue,now:()=>clock.now,platform:options.platform??'darwin',timers,
    ...(options.incomingRemoteGrant?{incomingRemoteGrant:options.incomingRemoteGrant}:{}),...(options.limits?{limits:options.limits}:{})});
  const caller={instance:INSTANCE,client:'claude-code',host:'Terminal'};
  const ask=(body:Record<string,unknown>,who:Record<string,unknown>=caller)=>client.agent(who as {instance:string},{device:mac.deviceId,...body});
  return {clock,self,dialogue,mac,endpointId,client,caller,ask,timer};
}

test('an input whose answer is lost is REMOTE_UNKNOWN_OUTCOME, is never resent, blocks further input, and its receipt settles it',async()=>{
  const {dialogue,mac,ask,clock}=setup();
  expect(await ask({operation:'scope-status'})).toMatchObject({success:true,device:mac.deviceId,deviceId:mac.deviceId,bootId:mac.bootId,grants:[{grant:GRANT}]});
  // The first call box carries the MCP client and host for the other Mac's label; later ones do not.
  expect(mac.log.find(entry=>entry.operation==='scope-status')?.request).toMatchObject({client:'claude-code',host:'Terminal'});
  dialogue.delivery=request=>request.op==='call'?'lost':'answer';
  const rowsBefore=dialogue.sent();
  const sentAt=clock.now;
  const lost=await ask(click('req-lost-1'));
  // The MCP keeps the device's boot with the open input: the answer carries it.
  expect(lost).toMatchObject({success:false,code:'REMOTE_UNKNOWN_OUTCOME',outcome:'unknown',state:'unknown',requestId:'req-lost-1',device:mac.deviceId,bootId:mac.bootId});
  // One row for the click: no automatic resend of any kind.
  expect(dialogue.sent()-rowsBefore).toBe(1);
  expect(mac.ops('call','scope-click')).toBe(1);
  expect(mac.log.find(entry=>entry.operation==='scope-click')?.request).not.toHaveProperty('client');
  dialogue.delivery=()=>'answer';
  // The device is blocked for input until the receipt settles it; nothing is sent for the refused input.
  const rowsBlocked=dialogue.sent();
  expect(await ask(click('req-next-2'))).toMatchObject({success:false,code:'REMOTE_BLOCKED_BY_UNKNOWN',outcome:'not-run'});
  expect(dialogue.sent()).toBe(rowsBlocked);
  // Reads still go.
  expect(await ask({operation:'scope-observe',grant:GRANT,epoch:1})).toMatchObject({success:true,observationId:'obs-1'});
  const settled=await ask(receiptOf('req-lost-1'));
  // The other Mac's own receipt answer, unjudged: the MCP settles it (WP5) and reads exactly these fields.
  expect(settled).toEqual({success:true,bootId:mac.bootId,evictedThroughSentAt:null,receipt:{requestId:'req-lost-1',state:'confirmed'},
    device:mac.deviceId,deviceId:mac.deviceId});
  expect(judge(settled,{requestId:'req-lost-1',sentAt,bootId:lost.bootId},clock.now)).toMatchObject({verdict:'receipt',receipt:{state:'confirmed'}});
  expect(mac.ops('call','scope-receipt')).toBe(1);
  // A positive answer is kept: the next receipt is answered from it, without another row.
  const rowsSettled=dialogue.sent();
  expect(await ask(receiptOf('req-lost-1'))).toEqual(settled);
  expect(dialogue.sent()).toBe(rowsSettled);
  expect(mac.ops('call','scope-click')).toBe(1);
  expect(await ask(click('req-next-2'))).toMatchObject({success:true,receipt:{requestId:'req-next-2',state:'confirmed'}});
});

test('a late answer is collected through the endpoint that sent it after this Mac changes endpoints',async()=>{
  const {dialogue,mac,ask,clock}=setup();
  await ask({operation:'scope-status'});
  const first=dialogue.current;
  dialogue.delivery=request=>request.op==='call'?'late':'answer';
  const sentAt=clock.now;
  const late=await ask(click('req-late-1'));
  expect(late).toMatchObject({code:'REMOTE_UNKNOWN_OUTCOME',state:'unknown',bootId:mac.bootId});
  dialogue.delivery=()=>'answer';
  const second=dialogue.moveEndpoint();
  const rows=dialogue.sent();
  const settled=await ask(receiptOf('req-late-1'));
  // Answered from the late answer itself (read from the first endpoint, no receipt row, no false unseen), in the shape of
  // the other Mac's receipt answer and with the boot that ran the click.
  expect(settled).toMatchObject({success:true,bootId:mac.bootId,evictedThroughSentAt:null,receipt:{requestId:'req-late-1',state:'confirmed'}});
  expect(judge(settled,{requestId:'req-late-1',sentAt,bootId:late.bootId},clock.now)).toMatchObject({verdict:'receipt'});
  expect(dialogue.resultCalls.at(-1)).toMatchObject({source:first});
  expect(dialogue.sent()).toBe(rows);
  expect(mac.ops('call','scope-receipt')).toBe(0);
  // The next call leaves the session pinned to the old endpoint and says hello from the new one.
  const hellos=mac.ops('hello');
  expect(await ask({operation:'scope-status'})).toMatchObject({success:true});
  await waitFor(()=>mac.ops('disconnect')===1,'the old session disconnect');
  expect(mac.ops('hello')).toBe(hellos+1);
  expect(dialogue.rows.filter(row=>row.request.op==='hello').at(-1)?.source).toBe(second);
  // An endpoint this Mac no longer publishes gives the late answer up to the receipt.
  dialogue.delivery=request=>request.op==='call'?'late':'answer';
  expect(await ask(click('req-late-2'))).toMatchObject({code:'REMOTE_UNKNOWN_OUTCOME'});
  dialogue.delivery=()=>'answer';
  dialogue.active.delete(second);dialogue.moveEndpoint();
  dialogue.rows.forEach(row=>{if(row.request.op==='call')row.consumed=true;});
  // Asked of the other Mac: its ledger has the click.
  expect(await ask(receiptOf('req-late-2'))).toMatchObject({success:true,bootId:mac.bootId,receipt:{requestId:'req-late-2',state:'confirmed'}});
  expect(mac.ops('call','scope-receipt')).toBe(1);
});

test('short of a whole call before sending, nothing is sent: REMOTE_SESSION_PENDING, and the input is not left open',async()=>{
  const {dialogue,mac,ask,clock}=setup();
  // The hello takes 25 s of the 40 s route budget: 15 s are left, less than a call's 20 s.
  dialogue.delayMs=request=>request.op==='hello'?25_000:0;
  const pending=await ask(click('req-pending-1'));
  expect(pending).toMatchObject({success:false,code:'REMOTE_SESSION_PENDING',outcome:'not-run',device:mac.deviceId});
  expect(dialogue.sent('hello')).toBe(1);
  expect(dialogue.sent('call')).toBe(0);
  expect(mac.ops('call')).toBe(0);
  dialogue.delayMs=()=>0;
  clock.now+=1_000;
  // Nothing open: the next input goes (on the session the hello made) and nothing was blocked.
  expect(await ask(click('req-after-2'))).toMatchObject({success:true,receipt:{requestId:'req-after-2',state:'confirmed'}});
  expect(dialogue.sent('hello')).toBe(1);
  // The endpoint moves between reading it and sending: the mailbox refuses before writing the row, so not run either.
  dialogue.beforeSend=request=>{if(request.op==='call'){dialogue.beforeSend=undefined;dialogue.moveEndpoint();}};
  const rows=dialogue.sent();
  const sentAt=clock.now;
  const moved=await ask(click('req-moved-3'));
  expect(moved).toMatchObject({success:false,code:'REMOTE_SESSION_PENDING',outcome:'not-run',device:mac.deviceId});
  expect(dialogue.sent()).toBe(rows);
  // Its receipt: the other Mac never saw it (unseen), which the MCP takes as not run — same boot, inside the window.
  const receipt=await ask(receiptOf('req-moved-3'));
  expect(receipt).toMatchObject({success:true,bootId:mac.bootId,evictedThroughSentAt:null,receipt:{requestId:'req-moved-3',state:'unseen'}});
  expect(judge(receipt,{requestId:'req-moved-3',sentAt,bootId:moved.bootId},clock.now)).toMatchObject({verdict:'not-run',reason:'unseen'});
  expect(await ask(click('req-after-4'))).toMatchObject({success:true});
});

test('heartbeats are forwarded every 25 s as background rows and stop after ten minutes without a call',async()=>{
  const {dialogue,mac,ask,client,clock,caller}=setup();
  await ask({operation:'scope-status'});
  const beat=()=>client.agent(caller,{operation:'heartbeat'});
  clock.now+=20_000;
  expect(await beat()).toEqual({success:true,forwarded:0});
  clock.now+=6_000;
  expect(await beat()).toEqual({success:true,forwarded:1});
  await waitFor(()=>mac.ops('heartbeat')===1&&idle(client)(),'the first heartbeat');
  const row=dialogue.rows.find(item=>item.request.op==='heartbeat')!;
  // Sealed, empty and marked background: the receiver must not count it as activity (RC-9).
  expect(row.request).toMatchObject({kind:'computer-use',op:'heartbeat',bg:1});
  expect(mac.log.find(entry=>entry.op==='heartbeat')).toMatchObject({bg:true});
  clock.now+=20_000;
  expect(await beat()).toEqual({success:true,forwarded:0});
  while(clock.now<START+600_000-25_000){
    clock.now+=25_000;
    expect((await beat()).forwarded).toBe(1);
    await waitFor(()=>mac.ops('heartbeat')===dialogue.sent('heartbeat')&&idle(client)(),'a heartbeat');
  }
  const forwarded=mac.ops('heartbeat');
  expect(forwarded).toBeGreaterThan(20);
  // Ten minutes after the last call: nothing more is forwarded, so B's lease ends on its own.
  clock.now=START+600_000;
  expect(await beat()).toEqual({success:true,forwarded:0});
  clock.now+=60_000;
  expect(await beat()).toEqual({success:true,forwarded:0});
  expect(dialogue.sent('heartbeat')).toBe(forwarded);
  // A new call resumes forwarding; a host tick forwards only while the MCP connection still beats.
  await ask({operation:'scope-status'});
  clock.now+=26_000;
  expect(client.forwardHeartbeats()).toBe(1);
  await waitFor(()=>mac.ops('heartbeat')===forwarded+1&&idle(client)(),'the resumed heartbeat');
  clock.now+=COMPUTER_USE_REMOTE_MCP_ALIVE_MS;
  expect(client.forwardHeartbeats()).toBe(0);
  // Closing the MCP connection sends a sealed disconnect.
  expect(await client.agent(caller,{operation:'disconnect'})).toEqual({success:true,closed:1});
  await waitFor(()=>mac.ops('disconnect')===1,'the disconnect');
  expect(dialogue.rows.find(item=>item.request.op==='disconnect')?.request).toMatchObject({bg:1});
});

test('an OPS worker and a Mac that another Mac is using cannot use a third Mac; receipts still settle',async()=>{
  let incoming=false;
  const {dialogue,mac,ask,caller}=setup({incomingRemoteGrant:()=>incoming});
  const worker={...caller,opsWorker:async()=>true};
  const refused=await ask({operation:'scope-status'},worker);
  expect(refused).toMatchObject({success:false,code:'REMOTE_CHAIN_DENIED',outcome:'not-run',device:mac.deviceId});
  expect(String(refused.error)).toContain('OPS 작업');
  expect(dialogue.sent()).toBe(0);
  // The hint is advisory: one that cannot be read does not block.
  expect(await ask({operation:'scope-status'},{...caller,opsWorker:async()=>{throw new Error('lookup failed');}})).toMatchObject({success:true});
  dialogue.delivery=request=>request.op==='call'?'lost':'answer';
  await ask(click('req-chain-1'));
  dialogue.delivery=()=>'answer';
  incoming=true;
  const rows=dialogue.sent();
  expect(await ask({operation:'scope-observe',grant:GRANT,epoch:1})).toMatchObject({success:false,code:'REMOTE_CHAIN_DENIED',outcome:'not-run'});
  expect(await ask(click('req-chain-2'))).toMatchObject({code:'REMOTE_CHAIN_DENIED'});
  expect(dialogue.sent()).toBe(rows);
  // A receipt only settles what was already sent, so neither guard holds it back.
  expect(await ask(receiptOf('req-chain-1'),worker)).toMatchObject({success:true,receipt:{requestId:'req-chain-1',state:'confirmed'}});
});

test('rows per device: 8 awaiting an answer, 24 unanswered in ten minutes, and an awaiting slot frees after 130 s',async()=>{
  const {dialogue,ask,clock}=setup();
  await ask({operation:'scope-status'});
  dialogue.delivery=request=>request.op==='call'?'drop':'answer';
  const observe=()=>ask({operation:'scope-observe',grant:GRANT,epoch:1});
  for(let index=0;index<8;index++)expect(await observe()).toMatchObject({success:false,outcome:'read',code:'REMOTE_NO_ANSWER'});
  let rows=dialogue.sent();
  expect(await observe()).toMatchObject({success:false,code:'REMOTE_RATE_LIMITED',outcome:'not-run'});
  expect(dialogue.sent()).toBe(rows);
  clock.now+=COMPUTER_USE_REMOTE_LIMITS.awaitingReleaseMs-1;
  expect(await observe()).toMatchObject({code:'REMOTE_RATE_LIMITED'});
  expect(dialogue.sent()).toBe(rows);
  clock.now+=1;
  // Freed after 130 s: rows go out again (here a new hello too, as the silent session went stale).
  expect(await observe()).toMatchObject({code:'REMOTE_NO_ANSWER'});
  expect(dialogue.sent('call')).toBeGreaterThan(9);
  for(let index=0;index<7;index++)await observe();
  clock.now+=COMPUTER_USE_REMOTE_LIMITS.awaitingReleaseMs;
  for(let index=0;index<8;index++)expect(await observe()).toMatchObject({code:'REMOTE_NO_ANSWER'});
  clock.now+=COMPUTER_USE_REMOTE_LIMITS.awaitingReleaseMs;
  // 24 rows without an answer in ten minutes: nothing more, although no row awaits any more.
  rows=dialogue.sent();
  expect(await observe()).toMatchObject({code:'REMOTE_RATE_LIMITED'});
  expect(dialogue.sent()).toBe(rows);
  clock.now=START+COMPUTER_USE_REMOTE_LIMITS.unansweredWindowMs;
  dialogue.delivery=()=>'answer';
  expect(await observe()).toMatchObject({success:true});
});

test('captures at most every 2 s per device, hellos at most 4 a minute, and a restarted Mac is not sent the input again',async()=>{
  const {dialogue,mac,ask,clock}=setup();
  mac.image=new Uint8Array(4_000).fill(9);mac.image.set([0xff,0xd8]);
  const captured=await ask({operation:'scope-observe',grant:GRANT,epoch:1,capture:true});
  expect(captured).toMatchObject({success:true,image:{mediaType:'image/jpeg',width:1440,data:Buffer.from(mac.image).toString('base64')}});
  const rows=dialogue.sent();
  expect(await ask({operation:'scope-capture',grant:GRANT,epoch:1,observationId:'obs-1',displayId:'d1'})).toMatchObject({code:'REMOTE_RATE_LIMITED',outcome:'not-run'});
  expect(dialogue.sent()).toBe(rows);
  // An observe without capture is not a capture.
  expect(await ask({operation:'scope-observe',grant:GRANT,epoch:1})).toMatchObject({success:true});
  clock.now+=COMPUTER_USE_REMOTE_LIMITS.captureIntervalMs;
  expect(await ask({operation:'scope-capture',grant:GRANT,epoch:1,observationId:'obs-1',displayId:'d1'})).toMatchObject({success:true});
  // Each restart of the other Mac costs a hello; the fifth within a minute is refused before any row.
  for(let index=0;index<3;index++){
    mac.restart();
    expect(await ask(click(`req-restart-${index}`))).toMatchObject({success:false,code:'REMOTE_SESSION_RESTARTED',outcome:'not-run'});
    expect(await ask({operation:'scope-status'})).toMatchObject({success:true});
  }
  expect(mac.ops('hello')).toBe(4);
  mac.restart();
  expect(await ask({operation:'scope-status'})).toMatchObject({code:'REMOTE_SESSION_RESTARTED'});
  const before=dialogue.sent();
  expect(await ask({operation:'scope-status'})).toMatchObject({success:false,code:'REMOTE_RATE_LIMITED',outcome:'not-run'});
  expect(dialogue.sent()).toBe(before);
  expect(mac.ops('call','scope-click')).toBe(0);
  clock.now+=60_000;
  expect(await ask({operation:'scope-status'})).toMatchObject({success:true});
});

test('a reply split in two parts is joined, and a lost part is fetched once more',async()=>{
  const {mac,ask,clock}=setup();
  mac.image=new Uint8Array(200_000).fill(7);mac.image.set([0xff,0xd8]);
  const whole=await ask({operation:'scope-observe',grant:GRANT,epoch:1,capture:true});
  expect(whole).toMatchObject({success:true,image:{mediaType:'image/jpeg'}});
  expect((whole.image as {data:string}).data).toBe(Buffer.from(mac.image).toString('base64'));
  expect(mac.ops('part')).toBe(1);
  clock.now+=COMPUTER_USE_REMOTE_LIMITS.captureIntervalMs;
  mac.losePart=1;
  expect(await ask({operation:'scope-observe',grant:GRANT,epoch:1,capture:true})).toMatchObject({success:true});
  expect(mac.ops('part')).toBe(3);
  clock.now+=COMPUTER_USE_REMOTE_LIMITS.captureIntervalMs;
  mac.losePart=2;
  expect(await ask({operation:'scope-observe',grant:GRANT,epoch:1,capture:true})).toMatchObject({success:false,code:'REMOTE_PART_LOST',outcome:'read'});
  expect(mac.ops('part')).toBe(5);
});

test('receipts: never another connection\'s, a restart of the other Mac closes open inputs here and to the MCP, and the window closes them too',async()=>{
  const {dialogue,mac,ask,client,clock}=setup();
  await ask({operation:'scope-status'});
  // A receipt is asked of the other Mac whether or not this route remembers the ID (it forgets when restarted; the MCP asks
  // only about IDs it sent). The other Mac keys its ledger by connection: another MCP connection's ID is never answered.
  expect(await ask(click('req-other-0'))).toMatchObject({success:true,receipt:{requestId:'req-other-0',state:'confirmed'}});
  const foreign=await client.agent({instance:'2'.repeat(64)},{device:mac.deviceId,...receiptOf('req-other-0')});
  expect(foreign).toMatchObject({success:true,device:mac.deviceId,bootId:mac.bootId,receipt:{requestId:'req-other-0',state:'unseen'}});
  expect(mac.log.filter(entry=>entry.operation==='scope-receipt').map(entry=>entry.instance)).toEqual([await computerUseRemoteConnectionTag('2'.repeat(64))]);
  // The other Mac restarted: its new bootId closes the open input of the old boot — here (input is not blocked any more)
  // and for the MCP (its record has the old boot, so the new boot's `unseen` is no evidence).
  dialogue.delivery=request=>request.op==='call'?'drop':'answer';
  const bootSentAt=clock.now;
  const dropped=await ask(click('req-boot-1'));
  expect(dropped).toMatchObject({code:'REMOTE_UNKNOWN_OUTCOME',bootId:mac.bootId});
  dialogue.delivery=()=>'answer';
  expect(await ask(click('req-boot-blocked'))).toMatchObject({code:'REMOTE_BLOCKED_BY_UNKNOWN'});
  const oldBoot=mac.bootId;
  mac.restart();
  expect(await ask({operation:'scope-status'})).toMatchObject({code:'REMOTE_SESSION_RESTARTED',bootId:oldBoot});
  expect(await ask({operation:'scope-status'})).toMatchObject({success:true,bootId:mac.bootId});
  const afterBoot=await ask(receiptOf('req-boot-1'));
  expect(afterBoot).toMatchObject({success:true,bootId:mac.bootId,receipt:{requestId:'req-boot-1',state:'unseen'}});
  expect(judge(afterBoot,{requestId:'req-boot-1',sentAt:bootSentAt,bootId:dropped.bootId},clock.now)).toMatchObject({verdict:'unknown-final',why:'boot-changed'});
  expect(await ask(click('req-boot-2'))).toMatchObject({success:true,receipt:{requestId:'req-boot-2',state:'confirmed'}});
  // An unseen answer is not-run only inside the window and the same boot: it also opens this route's gate.
  dialogue.delivery=request=>request.op==='call'?'drop':'answer';
  const unseenSentAt=clock.now;
  const unseen=await ask(click('req-unseen-2'));
  dialogue.delivery=()=>'answer';
  const unseenReceipt=await ask(receiptOf('req-unseen-2'));
  expect(unseenReceipt).toMatchObject({success:true,receipt:{state:'unseen'},bootId:mac.bootId,evictedThroughSentAt:null});
  expect(judge(unseenReceipt,{requestId:'req-unseen-2',sentAt:unseenSentAt,bootId:unseen.bootId},clock.now)).toMatchObject({verdict:'not-run',reason:'unseen'});
  expect(await ask(click('req-after-unseen'))).toMatchObject({success:true});
  // Past sentAt + 10 minutes the gate opens by itself; to the MCP the same answer is then unknown-final.
  dialogue.delivery=request=>request.op==='call'?'drop':'answer';
  const windowSentAt=clock.now;
  const windowed=await ask(click('req-window-3'));
  dialogue.delivery=()=>'answer';
  expect(await ask(click('req-window-blocked'))).toMatchObject({code:'REMOTE_BLOCKED_BY_UNKNOWN'});
  clock.now+=COMPUTER_USE_REMOTE_LIMITS.senderLedgerWindowMs;
  expect(await ask(click('req-window-4'))).toMatchObject({success:true});
  const late=await ask(receiptOf('req-window-3'));
  expect(judge(late,{requestId:'req-window-3',sentAt:windowSentAt,bootId:windowed.bootId},clock.now)).toMatchObject({verdict:'unknown-final',why:'window-passed'});
  // No input was ever sent twice.
  expect(mac.ops('call','scope-click')).toBe(4);
});

test('device discovery distinguishes membership, an empty community, listed devices, and a failed lookup without sending',async()=>{
  const {dialogue,mac,client,caller,self,timer}=setup();
  dialogue.inside=false;
  const outside=await client.agent(caller,{operation:'devices'});
  expect(outside).toMatchObject({success:true,inside:false,deviceId:self,self,devices:[]});
  expect(outside.guidance).toContain('이 Mac이 커뮤니티에 들어가 있지 않습니다');

  dialogue.inside=true;
  dialogue.macs.clear();
  const empty=await client.agent(caller,{operation:'devices'});
  expect(empty).toMatchObject({success:true,inside:true,deviceId:self,self,devices:[]});
  expect(empty.guidance).toContain('다른 기기가 아직 목록에 없습니다');
  expect(empty.guidance).toContain('같은 커뮤니티');
  expect(empty.guidance).toContain('devices로 다시 확인');
  expect(empty.guidance).toContain('이 Mac은 device 없이');

  const endpointId=dialogue.addMac(mac,'아젠투지 3호 / 아젠투지(OPS)');
  const listed=await client.agent(caller,{operation:'devices'});
  expect(listed).toMatchObject({success:true,inside:true,deviceId:self,self,
    devices:[{device:mac.deviceId,endpointId,remote:'unchecked',stale:false}]});
  expect(listed.guidance).toContain('그 Mac의 device 값을 계속 넣으세요');

  dialogue.devicesError=new Error('fetch failed');
  expect(await client.agent(caller,{operation:'devices'})).toMatchObject({success:false,code:'REMOTE_DEVICE_UNKNOWN',outcome:'not-run',
    error:'커뮤니티 기기 목록을 읽지 못해 보내지 않았습니다. 잠시 뒤 devices로 다시 확인하세요.'});
  expect(dialogue.sent()).toBe(0);
  expect(mac.log).toEqual([]);
  expect(timer.started).toBe(0);
});

test('device names: deviceId or endpointId, never this Mac; IDs and grants stay with the device they went to',async()=>{
  const {dialogue,mac,endpointId,client,caller,self}=setup();
  const other=new FakeMac(randomUUID());dialogue.addMac(other,'아젠투지 2호');
  const listed=await client.devices();
  // `deviceId` names this Mac (the MCP reads it to answer REMOTE_SELF), as `self` does.
  expect(listed).toMatchObject({success:true,inside:true,deviceId:self,self});
  expect(listed.devices).toEqual(expect.arrayContaining([expect.objectContaining({device:mac.deviceId,endpointId,remote:'unchecked',stale:false})]));
  // An endpointId names the same Mac; the echo is exactly what was asked.
  expect(await client.agent(caller,{device:endpointId,operation:'scope-status'})).toMatchObject({success:true,device:endpointId,deviceId:mac.deviceId});
  expect((await client.devices()).devices).toEqual(expect.arrayContaining([expect.objectContaining({device:mac.deviceId,remote:'ready'})]));
  expect(await client.agent(caller,{device:self,operation:'scope-status'})).toMatchObject({code:'REMOTE_SELF',outcome:'not-run'});
  expect(await client.agent(caller,{device:randomUUID(),operation:'scope-status'})).toMatchObject({code:'REMOTE_DEVICE_UNKNOWN'});
  // Refused before anything is sent, and still with the echo: the MCP believes "not run" only with it.
  expect(await client.agent(caller,{device:'not-a-device',operation:'scope-status'})).toEqual({success:false,code:'REMOTE_DEVICE_UNKNOWN',
    outcome:'not-run',error:expect.any(String),device:'not-a-device'});
  expect(await client.agent(caller,{device:mac.deviceId,operation:'scope-revoke'})).toMatchObject({success:false,code:'REMOTE_BAD_REQUEST',outcome:'not-run',device:mac.deviceId});
  expect(await client.agent(caller,{device:mac.deviceId,operation:'heartbeat'})).toMatchObject({success:false,code:'REMOTE_BAD_REQUEST',device:mac.deviceId});
  expect(await client.agent({instance:'nope'},{device:mac.deviceId,...click('req-instance-0')})).toMatchObject({success:false,code:'REMOTE_BAD_REQUEST',outcome:'not-run',device:mac.deviceId});
  await expect(client.agent(caller,{operation:'scope-status'})).rejects.toMatchObject({code:'REMOTE_DEVICE_UNKNOWN'});
  await expect(client.agent(caller,{operation:'devices',extra:1})).rejects.toMatchObject({code:'REMOTE_BAD_REQUEST'});
  await client.agent(caller,{device:mac.deviceId,...click('req-bound-1')});
  expect(await client.agent(caller,{device:other.deviceId,...click('req-bound-1')})).toMatchObject({code:'REMOTE_ID_BOUND_ELSEWHERE',outcome:'not-run'});
  expect(await client.agent(caller,{device:other.deviceId,...receiptOf('req-bound-1')})).toMatchObject({code:'REMOTE_ID_BOUND_ELSEWHERE'});
  expect(await client.agent(caller,{device:other.deviceId,operation:'scope-observe',grant:GRANT,epoch:1})).toMatchObject({code:'REMOTE_ID_BOUND_ELSEWHERE'});
  expect(other.log).toEqual([]);
  dialogue.inside=false;
  expect(await client.agent(caller,{device:mac.deviceId,operation:'scope-status'})).toMatchObject({code:'REMOTE_NOT_IN_COMMUNITY'});
  expect(await client.devices()).toMatchObject({success:true,inside:false,deviceId:self,devices:[]});
  dialogue.devicesError=Object.assign(new Error('AGENT_DIALOGUE_SHARED_PROFILE_REQUIRED'),{code:'AGENT_DIALOGUE_SHARED_PROFILE_REQUIRED'});
  expect(await client.agent(caller,{device:mac.deviceId,operation:'scope-status'})).toMatchObject({code:'REMOTE_PROFILE_REQUIRED'});
  expect(await client.devices()).toMatchObject({success:false,code:'REMOTE_PROFILE_REQUIRED'});
  dialogue.devicesError=new Error('fetch failed');
  expect(await client.agent(caller,{device:mac.deviceId,operation:'scope-status'})).toMatchObject({code:'REMOTE_DEVICE_UNKNOWN',outcome:'not-run'});
  // Only a Mac sends (D10).
  const windows=setup({platform:'win32'});
  expect(await windows.ask({operation:'scope-status'})).toMatchObject({code:'REMOTE_SENDER_UNSUPPORTED'});
  expect(windows.dialogue.sent()).toBe(0);
});

test('a boxed refusal keeps its outcome only when it is not-run; anything else is the worst the effect allows',async()=>{
  const {mac,ask}=setup();
  mac.onCall=request=>request.operation==='scope-request-access'
    ?{meta:computerUseRemoteErrorFrame(new Error('그 Mac의 Control에서 사람이 상시 허용을 켜야 합니다.'),'not-run','REMOTE_NEEDS_STANDING'),attachment:null}
    :request.operation==='scope-request-human'?{meta:{success:false,error:'처리하지 못했습니다.'},attachment:null}
    :request.operation==='scope-type-text'?{meta:{success:false,error:'타이핑 도중 실패했습니다.',outcome:'read'},attachment:null}
    :request.operation==='scope-key'?{meta:{success:true,receipt:{requestId:'someone-else',state:'confirmed'}},attachment:null}
    :undefined;
  expect(await ask({operation:'scope-request-access'})).toMatchObject({success:false,code:'REMOTE_NEEDS_STANDING',outcome:'not-run'});
  expect(await ask({operation:'scope-request-human',grant:GRANT,epoch:1})).toMatchObject({success:false,code:'REMOTE_STATE_UNKNOWN',outcome:'state-unknown'});
  expect(await ask({operation:'scope-type-text',grant:GRANT,epoch:1,observationId:'obs-1',requestId:'req-typed-1',text:'hi'}))
    .toMatchObject({success:false,code:'REMOTE_UNKNOWN_OUTCOME',outcome:'unknown',requestId:'req-typed-1',state:'unknown'});
  mac.onCall=undefined;
  expect(await ask(receiptOf('req-typed-1'))).toMatchObject({success:true,receipt:{requestId:'req-typed-1',state:'confirmed'}});
  mac.onCall=request=>request.operation==='scope-key'?{meta:{success:true,receipt:{requestId:'someone-else',state:'confirmed'}},attachment:null}:undefined;
  // A receipt for another requestId does not settle this one.
  expect(await ask({operation:'scope-key',grant:GRANT,epoch:1,observationId:'obs-1',requestId:'req-key-2',key:'a',modifiers:[]}))
    .toMatchObject({code:'REMOTE_UNKNOWN_OUTCOME',state:'unknown'});
  expect(await ask(click('req-click-3'))).toMatchObject({code:'REMOTE_BLOCKED_BY_UNKNOWN'});
});

test('reply frames carry the JPEG as bytes and refuse every other shape',()=>{
  const bytes=new Uint8Array(3_000).fill(5);
  const frame=computerUseRemoteReplyFrame({success:true,observationId:'o',image:{mediaType:'image/jpeg',data:Buffer.from(bytes).toString('base64'),width:4}});
  expect(frame.meta).toEqual({success:true,observationId:'o',image:{mediaType:'image/jpeg',width:4}});
  expect(frame.attachment).toEqual(bytes);
  expect(parseComputerUseRemoteReplyContent(frame.meta,frame.attachment)).toEqual({kind:'result',result:{success:true,observationId:'o',
    image:{mediaType:'image/jpeg',width:4,data:Buffer.from(bytes).toString('base64')}}});
  expect(computerUseRemoteReplyFrame({success:true,state:'ok'})).toEqual({meta:{success:true,state:'ok'},attachment:null});
  expect(()=>computerUseRemoteReplyFrame({success:true,image:{mediaType:'image/png',data:'AAAA'}})).toThrow();
  const error=computerUseRemoteErrorFrame(Object.assign(new Error('막혔습니다‮.'),{code:'REMOTE_RECOVERY_REQUIRED'}),'not-run');
  expect(error).toEqual({success:false,error:'막혔습니다.',outcome:'not-run',code:'REMOTE_RECOVERY_REQUIRED'});
  expect(parseComputerUseRemoteReplyContent(error,null)).toEqual({kind:'error',error:'막혔습니다.',code:'REMOTE_RECOVERY_REQUIRED',outcome:'not-run'});
  for(const [meta,attachment] of [
    [{success:true,image:{mediaType:'image/jpeg'}},null],
    [{success:true},bytes],
    [{success:true,image:{mediaType:'image/jpeg',data:'AAAA'}},bytes],
    [{success:false,error:'x',stack:'y'},null],
    [{success:false,error:'x',outcome:'maybe'},null],
    [{success:false,error:'x'},bytes],
    [{error:'x'},null],
    [[],null],
  ] as const)expect(()=>parseComputerUseRemoteReplyContent(meta,attachment as Uint8Array|null)).toThrow();
});

test('the loopback route takes only the authorized local JSON POST and answers with the device echo',async()=>{
  const {client,mac}=setup();
  const route=(init:RequestInit&{query?:string},authorized=true)=>handleComputerUseRemote(new Request(`http://127.0.0.1:3001${COMPUTER_USE_REMOTE_AGENT_PATH}${init.query??''}`,
    {method:'POST',...init,headers:{'content-type':'application/json',[COMPUTER_USE_INSTANCE_HEADER]:INSTANCE,[COMPUTER_USE_CLIENT_HEADER]:'codex',...(init.headers as Record<string,string>|undefined)}}),
  ()=>client,{authorized,host:async()=>'Ghostty'});
  expect((await route({body:'{}'},false)).status).toBe(403);
  expect((await route({body:JSON.stringify({operation:'devices'}),headers:{origin:'http://evil.example'}})).status).toBe(400);
  expect((await route({body:JSON.stringify({operation:'devices'}),query:'?x=1'})).status).toBe(400);
  expect((await route({body:'x'.repeat(16_001)})).status).toBe(400);
  // A refusal of a request naming a device is an answer with the echo, not a 400 without it.
  const badInstance=await route({body:JSON.stringify({device:mac.deviceId,operation:'scope-status'}),headers:{[COMPUTER_USE_INSTANCE_HEADER]:'nope'}});
  expect(badInstance.status).toBe(200);
  expect(await badInstance.json()).toMatchObject({success:false,code:'REMOTE_BAD_REQUEST',outcome:'not-run',device:mac.deviceId});
  const notUuid=await route({body:JSON.stringify({device:'B',...click('req-route-0')})});
  expect(notUuid.status).toBe(200);
  expect(await notUuid.json()).toMatchObject({success:false,code:'REMOTE_DEVICE_UNKNOWN',outcome:'not-run',device:'B'});
  const unreadable=await route({body:JSON.stringify([1])});
  expect(unreadable.status).toBe(400);
  const devices=await route({body:JSON.stringify({operation:'devices'})});
  expect(devices.status).toBe(200);
  expect(devices.headers.get('cache-control')).toBe('private, no-store');
  expect(await devices.json()).toMatchObject({success:true,inside:true,deviceId:expect.any(String)});
  const status=await route({body:JSON.stringify({device:mac.deviceId,operation:'scope-status'})});
  expect(await status.json()).toMatchObject({success:true,device:mac.deviceId,grants:[{grant:GRANT}]});
  expect(mac.log.find(entry=>entry.operation==='scope-status')?.request).toMatchObject({client:'codex',host:'Ghostty'});
  expect(mac.log.find(entry=>entry.op==='hello')?.instance).toBe(await computerUseRemoteConnectionTag(INSTANCE));
  expect(client.usage().sessions).toEqual([expect.objectContaining({deviceId:mac.deviceId,deviceName:'아젠투지 3호 / 아젠투지(OPS)',client:'codex',active:true})]);
  expect(client.closeDevice(mac.deviceId)).toBe(1);
  await waitFor(()=>mac.ops('disconnect')===1,'the panel disconnect');
  expect(client.usage().sessions).toEqual([]);
});

test('an older Mac answers hello with its unsupported sentence: REMOTE_HOST_OUTDATED, not run, and devices shows it outdated',async()=>{
  const {dialogue,mac,ask,client}=setup();
  dialogue.delivery=request=>request.op==='hello'?'legacy':'answer';
  const refused=await ask(click('req-old-mac-1'));
  expect(refused).toMatchObject({success:false,code:'REMOTE_HOST_OUTDATED',outcome:'not-run',device:mac.deviceId});
  expect(refused).not.toHaveProperty('state');
  // Not run, and nothing of the click was sent: no call row, and nothing waits for a receipt.
  expect(dialogue.sent('hello')).toBe(1);
  expect(dialogue.sent('call')).toBe(0);
  expect((await client.devices()).devices).toEqual([expect.objectContaining({device:mac.deviceId,remote:'outdated'})]);
  expect(await ask({operation:'scope-status'})).toMatchObject({code:'REMOTE_HOST_OUTDATED'});
  // Updated, it answers: nothing was left blocked by the refused click.
  dialogue.delivery=()=>'answer';
  expect(await ask(click('req-old-mac-2'))).toMatchObject({success:true,receipt:{requestId:'req-old-mac-2',state:'confirmed'}});
});

test('the other Mac\'s poll answering its busy sentence settles an input as not run: it does not block, and is never resent',async()=>{
  const {dialogue,mac,ask,clock}=setup();
  await ask({operation:'scope-status'});
  dialogue.delivery=request=>request.op==='call'?'busy':'answer';
  const sentAt=clock.now;
  const busy=await ask(click('req-busy-1'));
  expect(busy).toMatchObject({success:false,code:'REMOTE_NOT_RUN',outcome:'not-run',device:mac.deviceId,bootId:mac.bootId});
  expect(busy).not.toHaveProperty('state');
  expect(dialogue.sent('call')).toBe(2);
  expect(mac.ops('call','scope-click')).toBe(0);
  dialogue.delivery=()=>'answer';
  // The next input goes at once (not REMOTE_BLOCKED_BY_UNKNOWN); the busy one was sent exactly once.
  expect(await ask(click('req-busy-2'))).toMatchObject({success:true,receipt:{requestId:'req-busy-2',state:'confirmed'}});
  expect(dialogue.rows.filter(row=>row.request.op==='call').length).toBe(3);
  const receipt=await ask(receiptOf('req-busy-1'));
  expect(judge(receipt,{requestId:'req-busy-1',sentAt,bootId:busy.bootId},clock.now)).toMatchObject({verdict:'not-run'});
  expect(mac.ops('call','scope-click')).toBe(1);
});

test('the same requestId sent at once to two devices goes to one of them only, and an unknown outcome there blocks the next input',async()=>{
  const {dialogue,mac,client,caller}=setup();
  const other=new FakeMac(randomUUID());dialogue.addMac(other,'아젠투지 2호');
  const to=(device:string,body:Record<string,unknown>)=>client.agent(caller,{device,...body});
  await to(mac.deviceId,{operation:'scope-status'});await to(other.deviceId,{operation:'scope-status'});
  // Every call is lost: its outcome is unknown wherever it went.
  dialogue.delivery=request=>request.op==='call'?'lost':'answer';
  const [first,second]=await Promise.all([to(mac.deviceId,click('req-race-1')),to(other.deviceId,click('req-race-1'))]);
  const answers=[first,second];
  expect(answers.filter(answer=>answer.code==='REMOTE_UNKNOWN_OUTCOME')).toHaveLength(1);
  expect(answers.filter(answer=>answer.code==='REMOTE_ID_BOUND_ELSEWHERE'&&answer.outcome==='not-run')).toHaveLength(1);
  expect(mac.ops('call','scope-click')+other.ops('call','scope-click')).toBe(1);
  const sentTo=first.code==='REMOTE_UNKNOWN_OUTCOME'?mac:other;
  dialogue.delivery=()=>'answer';
  // While req-race-1's outcome there is unknown, nothing new goes to that device; its receipt is asked only there.
  expect(await to(sentTo.deviceId,click('req-race-2'))).toMatchObject({code:'REMOTE_BLOCKED_BY_UNKNOWN',outcome:'not-run'});
  const elsewhere=sentTo===mac?other:mac;
  expect(await to(elsewhere.deviceId,receiptOf('req-race-1'))).toMatchObject({code:'REMOTE_ID_BOUND_ELSEWHERE'});
  expect(mac.ops('call','scope-click')+other.ops('call','scope-click')).toBe(1);
  expect(await to(sentTo.deviceId,receiptOf('req-race-1'))).toMatchObject({success:true,receipt:{requestId:'req-race-1',state:'confirmed'}});
  expect(await to(sentTo.deviceId,click('req-race-2'))).toMatchObject({success:true});
});

test('heartbeats go out every 25-30 s on the client\'s own tick with the MCP beating every 20 s, and the tick stops with the last session',async()=>{
  const {dialogue,mac,ask,client,clock,caller,timer}=setup();
  expect(timer.callback).toBeNull();
  await ask({operation:'scope-status'});
  expect(timer.ms).toBe(COMPUTER_USE_REMOTE_TICK_MS);
  expect(timer.callback).not.toBeNull();
  const lastExchange=clock.now;
  // Five minutes: the MCP beats every 20 s, the tick runs every 5 s.
  for(let elapsed=COMPUTER_USE_REMOTE_TICK_MS;elapsed<=300_000;elapsed+=COMPUTER_USE_REMOTE_TICK_MS){
    clock.now=lastExchange+elapsed;
    if(elapsed%20_000===0)await client.agent(caller,{operation:'heartbeat'});
    timer.callback!();
    await waitFor(()=>mac.ops('heartbeat')===dialogue.sent('heartbeat')&&idle(client)(),'a heartbeat');
  }
  const times=dialogue.rows.filter(row=>row.request.op==='heartbeat').map(row=>row.at);
  expect(times.length).toBeGreaterThanOrEqual(10);
  // The first within 30 s of the last exchange, then every 25-30 s: three chances inside B's 75 s lease.
  expect(times[0]!-lastExchange).toBeLessThanOrEqual(30_000);
  for(let index=1;index<times.length;index++){
    const gap=times[index]!-times[index-1]!;
    expect(gap).toBeGreaterThanOrEqual(25_000);
    expect(gap).toBeLessThanOrEqual(30_000);
  }
  // No session left: the tick stops itself.
  expect(client.closeDevice(mac.deviceId)).toBe(1);
  await waitFor(()=>mac.ops('disconnect')===1&&idle(client)(),'the disconnect');
  timer.callback!();
  expect(timer.callback).toBeNull();
  expect(timer.cleared).toBe(1);
});

test('MCP connections that stopped beating are forgotten with their sessions, so they never use up the 64 places',async()=>{
  const {dialogue,mac,client,clock,timer}=setup({limits:{helloPerDevicePerMinute:1_000}});
  const instance=(index:number)=>index.toString(16).padStart(64,'0');
  // 64 MCP connections each open a session, then die without a disconnect (killed or crashed).
  for(let index=1;index<=64;index++)
    expect(await client.agent({instance:instance(index)},{device:mac.deviceId,operation:'scope-status'})).toMatchObject({success:true});
  expect(client.usage().sessions).toHaveLength(64);
  // Still alive: a 65th is refused (with the echo — not run).
  expect(await client.agent({instance:instance(65)},{device:mac.deviceId,operation:'scope-status'}))
    .toMatchObject({success:false,code:'REMOTE_RATE_LIMITED',outcome:'not-run',device:mac.deviceId});
  // One of them keeps beating; the rest fall silent.
  for(let step=0;step<3;step++){
    clock.now+=20_000;
    await client.agent({instance:instance(1)},{operation:'heartbeat'});
    await waitFor(idle(client),'heartbeats');
  }
  // Silent connections no longer show as in use, even before they are forgotten.
  expect(client.usage().sessions).toEqual([expect.objectContaining({deviceId:mac.deviceId})]);
  expect(dialogue.sent('disconnect')).toBe(0);
  timer.callback!();
  // Their sessions are closed with a best-effort disconnect each (some may be skipped by the per-device row limits:
  // B's lease ends those anyway), and the places are free again.
  await waitFor(()=>dialogue.sent('disconnect')>0,'disconnects');
  await Bun.sleep(100);
  expect(mac.ops('disconnect')).toBe(dialogue.sent('disconnect'));
  expect(dialogue.sent('disconnect')).toBeLessThanOrEqual(63);
  expect(await client.agent({instance:instance(65)},{device:mac.deviceId,operation:'scope-status'})).toMatchObject({success:true});
  expect(client.usage().sessions).toHaveLength(2);
});

test('the MCP client and host reach the other Mac even when the first call of a session was refused before its row was written',async()=>{
  const {dialogue,mac,ask}=setup();
  dialogue.refuse=request=>request.op==='call'?Object.assign(new Error('AGENT_DIALOGUE_CONTROL_BUSY'),{code:'AGENT_DIALOGUE_CONTROL_BUSY'}):undefined;
  expect(await ask({operation:'scope-status'})).toMatchObject({success:false,code:'REMOTE_RATE_LIMITED',outcome:'not-run',device:mac.deviceId});
  expect(dialogue.sent('call')).toBe(0);
  dialogue.refuse=undefined;
  expect(await ask({operation:'scope-status'})).toMatchObject({success:true});
  // Same session (one hello), and its first written call carries the labels; later ones do not.
  expect(mac.ops('hello')).toBe(1);
  expect(mac.log.find(entry=>entry.operation==='scope-status')?.request).toMatchObject({client:'claude-code',host:'Terminal'});
  await ask({operation:'scope-observe',grant:GRANT,epoch:1});
  expect(mac.log.find(entry=>entry.operation==='scope-observe')?.request).not.toHaveProperty('client');
});

// ── Two real hosts over the real mailbox SQL ─────────────────────────────────────────────────────────────────────────
async function twoMacs(){
  const db=new PGlite();
  await db.exec("create role anon; create role authenticated; create role service_role;create schema auth;create function auth.role() returns text language sql stable as $$ select current_setting('request.jwt.claim.role',true) $$;set request.jwt.claim.role='service_role';");
  await db.exec(AGENT_DIALOGUE_SQL);
  const profileId=randomUUID();
  const sends:{deviceId:string;source:string;op:unknown}[]=[];
  const makeHost=(deviceId:string)=>{
    const appDataDir=mkdtempSync(join(tmpdir(),'computer-use-remote-client-'));temporary.push(appDataDir);
    return new AgentDialogueHost({appDataDir,identity:()=>({profileId,deviceId}),secret:async()=>deviceId.replaceAll('-','').padEnd(44,'x'),
      resolveTarget:async(target:AgentDialogueTarget)=>'target' in target?{kind:'ops',displayName:`${deviceId.slice(0,4)} / 아젠투지(OPS)`}
        :{kind:'project',portId:target.portId,displayName:`${deviceId.slice(0,4)} ${target.portId}`,memoryId:'qq'},
      rpc:async(operation,p,d,secret,args)=>{
        if(operation==='control-send')sends.push({deviceId:d,source:String(args.sourceEndpointId),op:(args.request as Record<string,unknown>)?.op});
        const {rows}=await db.query<{value:Record<string,any>}>('select public.portmgr_agent_dialogue_call($1,$2,$3,$4,$5::jsonb) as value',
          [operation,p,d,secret,JSON.stringify(args)]);
        return rows[0]!.value;
      }});
  };
  const aId=randomUUID(),bId=randomUUID();
  const a=makeHost(aId),b=makeHost(bId);
  const ops:AgentDialogueTarget={target:'ops'},project:AgentDialogueTarget={portId:'project-a'};
  const aOps=await a.enable(ops,true);const aProject=await a.enable(project,true);await b.enable(ops,true);
  await a.uiCommunity(project,'join');await a.uiCommunity(ops,'join');await b.uiCommunity(ops,'join');
  const mac=new FakeMac(bId);
  /** How B answers a call row it detached: now, later (held), or with its lane's deadline sentence. */
  let detached:(controlId:string,response:Record<string,unknown>,request:Record<string,unknown>)=>Promise<void>|void=async(controlId,response)=>{await b.controlRespond(controlId,response);};
  let polling=true;
  const poller=(async()=>{while(polling){
    await b.controlPoll(async(request,from,controlId)=>{
      const response=await mac.handle(request,from);
      if(request.op==='call'){await detached(controlId,response,request);return AGENT_DIALOGUE_CONTROL_DETACHED;}
      if(response.ok!==true)throw new Error(String(response.error));
      return response.body as Record<string,unknown>;
    },{detach:request=>request.kind==='computer-use'&&request.op==='call'}).catch(()=>undefined);
    await Bun.sleep(20);
  }})();
  const limits={helloTimeoutMs:4_000,callTimeoutMs:1_500,partTimeoutMs:1_000,routeBudgetMs:9_000};
  const client=new ComputerUseRemoteClient({dialogue:a,platform:'darwin',limits});
  const ask=(body:Record<string,unknown>)=>client.agent({instance:INSTANCE},{device:bId,...body});
  return {db,a,b,mac,client,ask,sends,aOps,aProject,ops,
    setDetached:(next:typeof detached)=>{detached=next;},
    async close(){polling=false;await poller;await db.close();}};
}

test('two hosts: a click answered after the deadline settles from the late answer read through the endpoint that sent it',async()=>{
  const macs=await twoMacs();
  try{
    const {a,mac,ask,sends,aOps,aProject}=macs;
    expect(await ask({operation:'scope-status'})).toMatchObject({success:true,grants:[{grant:GRANT}]});
    expect(sends.filter(send=>send.op==='hello').map(send=>send.source)).toEqual([aOps.endpointId]);
    let held:{controlId:string;response:Record<string,unknown>}|null=null;
    macs.setDetached((controlId,response)=>{held={controlId,response};});
    const lost=await ask(click('req-two-hosts-1'));
    expect(lost).toMatchObject({success:false,code:'REMOTE_UNKNOWN_OUTCOME',state:'unknown',requestId:'req-two-hosts-1'});
    expect(sends.filter(send=>send.op==='call')).toHaveLength(2);
    expect(mac.ops('call','scope-click')).toBe(1);
    // This Mac's OPS endpoint leaves the community: the community endpoint is now the project one.
    await a.uiCommunity(macs.ops,'leave');
    expect((await a.controlSource())?.endpointId).toBe(aProject.endpointId);
    const answered=held as {controlId:string;response:Record<string,unknown>}|null;
    expect(answered).not.toBeNull();
    expect(await macs.b.controlRespond(answered!.controlId,answered!.response)).toEqual({responded:true});
    macs.setDetached(async(controlId,response)=>{await macs.b.controlRespond(controlId,response);});
    const settled=await ask(receiptOf('req-two-hosts-1'));
    expect(settled).toMatchObject({success:true,bootId:mac.bootId,evictedThroughSentAt:null,receipt:{requestId:'req-two-hosts-1',state:'confirmed'}});
    expect(settled).not.toHaveProperty('verdict');
    expect(mac.ops('call','scope-receipt')).toBe(0);
    expect(sends.filter(send=>send.op==='call')).toHaveLength(2);
    // The next call says hello from the project endpoint; the click was never sent twice.
    expect(await ask({operation:'scope-status'})).toMatchObject({success:true});
    expect(sends.filter(send=>send.op==='hello').map(send=>send.source)).toEqual([aOps.endpointId,aProject.endpointId]);
    expect(mac.ops('call','scope-click')).toBe(1);
  }finally{await macs.close();}
},30_000);

test('two hosts: after the endpoint changes, a receipt on a new session reads the real receipt from the ledger kept per device and connection',async()=>{
  const macs=await twoMacs();
  try{
    const {a,mac,ask,sends,aProject}=macs;
    await ask({operation:'scope-status'});
    // B's lane missed its deadline: it answered with the deadline sentence and ran the click anyway.
    macs.setDetached(async(controlId)=>{await macs.b.controlRespond(controlId,{ok:false,error:COMMUNITY_CONTROL_EXECUTE_TIMEOUT_MESSAGE});});
    expect(await ask(click('req-two-hosts-2'))).toMatchObject({success:false,code:'REMOTE_UNKNOWN_OUTCOME',state:'unknown'});
    macs.setDetached(async(controlId,response)=>{await macs.b.controlRespond(controlId,response);});
    expect(await ask(click('req-two-hosts-3'))).toMatchObject({code:'REMOTE_BLOCKED_BY_UNKNOWN'});
    await a.uiCommunity(macs.ops,'leave');
    const settled=await ask(receiptOf('req-two-hosts-2'));
    // Asked over a new session from the project endpoint; the ledger is the device's and the connection's, so no false unseen.
    expect(settled).toMatchObject({success:true,bootId:mac.bootId,receipt:{requestId:'req-two-hosts-2',state:'confirmed'}});
    expect(sends.filter(send=>send.op==='hello').at(-1)?.source).toBe(aProject.endpointId);
    expect(mac.ops('hello')).toBe(2);
    expect(mac.ops('call','scope-click')).toBe(1);
    expect(await ask(click('req-two-hosts-3'))).toMatchObject({success:true,receipt:{state:'confirmed'}});
  }finally{await macs.close();}
},30_000);

// ── WP5 ↔ WP4: the MCP process's connection over this route ───────────────────────────────────────────────────────────
/**
 * The MCP process's own connection (WP5, src/computerUseMcp.ts `ComputerUseMcpConnection`) driving this route through the
 * real loopback handler: its device directory, echo checks, unknown-outcome ledger and receipt verdicts read exactly
 * what this route answers. It runs once the branch carries WP5's remote transport; without it there is nothing to drive.
 */
type McpConnectionShape={session?(value:unknown):Promise<Record<string,any>>;openOutcomes?():unknown[];close():Promise<void>};
const McpConnection=ComputerUseMcpConnection as unknown as new(request:(body:Record<string,unknown>)=>Promise<Record<string,unknown>>,
  remote?:(body:Record<string,unknown>)=>Promise<{status:number;body:unknown}>,clock?:()=>number)=>McpConnectionShape;
const WP5_REMOTE=typeof (ComputerUseMcpConnection.prototype as {session?:unknown}).session==='function';

test.if(WP5_REMOTE)('WP5\'s MCP connection reads this route\'s answers: directory, echo, its ledger, and receipt verdicts from B\'s raw answer',async()=>{
  const {dialogue,mac,client,clock,self}=setup();
  const remote=async(body:Record<string,unknown>)=>{
    const response=await handleComputerUseRemote(new Request(`http://127.0.0.1:3001${COMPUTER_USE_REMOTE_AGENT_PATH}`,{method:'POST',
      headers:{'content-type':'application/json',[COMPUTER_USE_INSTANCE_HEADER]:INSTANCE,[COMPUTER_USE_CLIENT_HEADER]:'claude-code'},body:JSON.stringify(body)}),
    ()=>client,{authorized:true,host:async()=>'Terminal'});
    return {status:response.status,body:await response.json()};
  };
  const mcp=new McpConnection(async()=>{throw new Error('this Mac is not driven in this test');},remote,()=>clock.now);
  try{
    const device=mac.deviceId;
    const session=(value:Record<string,unknown>)=>mcp.session!(value);
    const input=(requestId:string)=>({...click(requestId),operation:'click',device});
    const receipt=(requestId:string)=>({...receiptOf(requestId),operation:'receipt',device});
    const clicks=()=>mac.ops('call','scope-click');
    // The directory names this Mac by `deviceId`: the MCP refuses it as a target without asking anyone.
    expect(await session({operation:'devices'})).toMatchObject({success:true,deviceId:self,devices:[expect.objectContaining({device})]});
    expect(await session({operation:'status',device:self})).toMatchObject({success:false,code:'REMOTE_SELF'});
    expect(await session({operation:'status',device})).toMatchObject({success:true,device,bootId:mac.bootId,grants:[{grant:GRANT}]});
    // 1. An input answered at once: its outcome is its receipt.
    expect(await session(input('req-wp5-1'))).toMatchObject({success:true,device,receipt:{requestId:'req-wp5-1',state:'confirmed'}});
    expect(clicks()).toBe(1);
    // 2. Never delivered: unknown to the MCP, which blocks the next input itself; B's `unseen` in the same boot settles it as not run.
    dialogue.delivery=request=>request.op==='call'?'drop':'answer';
    expect(await session(input('req-wp5-2'))).toMatchObject({success:false,code:'REMOTE_UNKNOWN_OUTCOME',outcome:'unknown',device,requestId:'req-wp5-2'});
    dialogue.delivery=()=>'answer';
    expect(mcp.openOutcomes!()).toEqual([expect.objectContaining({requestId:'req-wp5-2',device})]);
    expect(await session(input('req-wp5-3'))).toMatchObject({success:false,code:'REMOTE_BLOCKED_BY_UNKNOWN'});
    expect(await session(receipt('req-wp5-2'))).toMatchObject({success:true,device,receipt:{requestId:'req-wp5-2',state:'not-run',reason:'unseen'}});
    expect(mcp.openOutcomes!()).toEqual([]);
    expect(clicks()).toBe(1);
    // 3. Run by B but its answer lost: B's ledger answers the actual receipt; nothing was sent twice.
    dialogue.delivery=request=>request.op==='call'?'lost':'answer';
    expect(await session(input('req-wp5-4'))).toMatchObject({success:false,code:'REMOTE_UNKNOWN_OUTCOME',device});
    dialogue.delivery=()=>'answer';
    expect(await session(receipt('req-wp5-4'))).toMatchObject({success:true,device,receipt:{requestId:'req-wp5-4',state:'confirmed'}});
    expect(clicks()).toBe(2);
    // 4. B restarted after an undelivered input: the new boot's `unseen` is no evidence, so it is unknown-final, and settled.
    dialogue.delivery=request=>request.op==='call'?'drop':'answer';
    expect(await session(input('req-wp5-5'))).toMatchObject({code:'REMOTE_UNKNOWN_OUTCOME'});
    dialogue.delivery=()=>'answer';
    mac.restart();
    expect(await session({operation:'status',device})).toMatchObject({success:false,code:'REMOTE_SESSION_RESTARTED',device});
    expect(await session({operation:'status',device})).toMatchObject({success:true,device,bootId:mac.bootId});
    expect(await session(receipt('req-wp5-5'))).toMatchObject({success:true,device,receipt:{requestId:'req-wp5-5',state:'unknown-final',reason:'boot-changed'}});
    expect(mcp.openOutcomes!()).toEqual([]);
    // 5. The route kept the first input's receipt with the boot that ran it: asked after the restart (B forgot it), it is
    // still that receipt, not unknown-final.
    expect(await session(receipt('req-wp5-1'))).toMatchObject({success:true,device,receipt:{requestId:'req-wp5-1',state:'confirmed'}});
    expect(await session(input('req-wp5-6'))).toMatchObject({success:true,device,receipt:{requestId:'req-wp5-6',state:'confirmed'}});
    expect(clicks()).toBe(3);
  }finally{await mcp.close();}
});
