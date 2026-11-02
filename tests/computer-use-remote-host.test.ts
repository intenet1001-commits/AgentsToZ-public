/**
 * The receiving Mac of computer use between community Macs (WP3, src/computerUseRemoteHost.ts): its sessions, the ledger
 * kept per sending device and connection, the one execution lane, parts, budgets and the community notices. The sending
 * side here is a minimal driver over the real channel and reply parsers (what A's client does), so every answer is read
 * the way the other Mac reads it.
 */
import {PGlite} from '@electric-sql/pglite';
import {afterEach,describe,expect,test} from 'bun:test';
import {generateKeyPairSync,randomUUID,sign} from 'node:crypto';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AGENT_DIALOGUE_SQL} from '../src/agentDialogueSql';
import {AGENT_DIALOGUE_CONTROL_DETACHED,AgentDialogueHost} from '../src/agentDialogueHost';
import type {AgentDialogueTarget} from '../src/agentDialogueContract';
import {communityControlDetachable,createCommunityControlExecutor} from '../src/agentDialogueControl';
import {COMMUNITY_CONTROL_EXECUTE_TIMEOUT_MESSAGE} from '../src/opsRequestProtocol';
import {parseComputerUseRemoteReplyContent} from '../src/computerUseRemoteClient';
import {ComputerUseRemoteChannel,generateComputerUseRemoteKeyPair,joinComputerUseRemoteBox} from '../src/computerUseRemoteCrypto';
import {
  COMPUTER_USE_REMOTE_ENVELOPE_REFUSALS,
  COMPUTER_USE_REMOTE_LIMITS,
  classifyComputerUseRemoteRefusal,
  computerUseRemoteEnvelopeRefusal,
  computerUseRemoteNotRunMessage,
  computerUseRemotePartRequest,
  newComputerUseRemoteId,
  parseComputerUseRemoteReceiptAnswer,
  parseComputerUseRemoteReply,
  remoteReceiptVerdict,
  type ComputerUseRemoteEnvelopeRefusal,
  type ComputerUseRemotePlatform,
} from '../src/computerUseRemoteProtocol';
import {
  COMPUTER_USE_REMOTE_HOST_ID_CHANGED,
  COMPUTER_USE_REMOTE_HOST_SEAL_FAILED,
  COMPUTER_USE_REMOTE_HOST_SESSION_IDLE_MS,
  COMPUTER_USE_REMOTE_HOST_TICK_MS,
  ComputerUseRemoteHost,
  type ComputerUseRemoteHostLimits,
  type ComputerUseRemoteHostRuntime,
} from '../src/computerUseRemoteHost';
import {ComputerUseRuntime,computerUseRemoteSettingsMemory,type ComputerUseRemotePeer} from '../src/computerUseRuntime';
import {ComputerUseRecovery} from '../src/computerUseRecovery';
import {computerScopeApprovalBytes} from '../src/computerUseScopeApproval';
import {COMPUTER_USE_SCOPE_LIMITS,COMPUTER_USE_SCOPE_OPERATIONS,COMPUTER_USE_SCOPE_PERMISSIONS,type ComputerUseRemoteRefusalCode} from '../src/computerUseScopeProtocol';

const START=Date.parse('2026-11-01T00:00:00.000Z');
const GRANT='a'.repeat(64);
const click=(requestId:string,x=10)=>({operation:'scope-click',grant:GRANT,epoch:1,observationId:'obs-1',displayId:'d1',requestId,x,y:10,button:'left',clickCount:1});
const receiptOf=(requestId:string,extra:Record<string,unknown>={})=>({operation:'scope-receipt',requestId,...extra});
const sentence=(code:ComputerUseRemoteEnvelopeRefusal)=>computerUseRemoteEnvelopeRefusal(code).error;
const notRun=(reason:Parameters<typeof computerUseRemoteNotRunMessage>[0])=>({kind:'error',outcome:'not-run',code:'REMOTE_NOT_RUN',error:computerUseRemoteNotRunMessage(reason)});
async function waitFor(check:()=>boolean,label:string,ms=5_000){
  const until=Date.now()+ms;
  while(!check()){if(Date.now()>until)throw new Error(`timed out waiting for ${label}`);await Bun.sleep(2);}
}

// ── A fake runtime: what ComputerUseRuntime.remote answers, with holds to keep Control busy ────────────────────────────
type RuntimeCall={session:string;peer:ComputerUseRemotePeer;body:Record<string,unknown>;done:boolean};
function defaultAnswer(body:Record<string,unknown>):Record<string,any>{
  switch(body.operation){
    case 'heartbeat':return {success:true,active:true};
    case 'disconnect':return {success:true};
    case 'scope-status':return {success:true,grants:[],remote:{allowRemote:true,standing:true,appScope:false}};
    case 'scope-request-access':return {success:true,state:'granted'};
    case 'scope-observe':return {success:true,epoch:1,observationId:'obs-1',observation:{applications:[],displays:[],foreground:null}};
    case 'scope-receipt':throw new Error('이 요청의 영수증이 없습니다.');
    default:return {success:true,receipt:{requestId:String(body.requestId),state:'confirmed'}};
  }
}
class FakeRuntime implements ComputerUseRemoteHostRuntime {
  readonly calls:RuntimeCall[]=[];
  admit:(peer:{deviceId:string;instance:string})=>ComputerUseRemoteRefusalCode|null=()=>null;
  grants:{deviceId:string;deviceName:string}[]=[];
  answer:(body:Record<string,unknown>)=>Record<string,any>|Promise<Record<string,any>>=defaultAnswer;
  private readonly holds=new Map<string,Promise<void>[]>();
  /** The next call of this operation waits until the returned function is called (a busy Control). */
  hold(operation:string){
    let release!:()=>void;
    const gate=new Promise<void>(resolve=>{release=resolve;});
    this.holds.set(operation,[...this.holds.get(operation)??[],gate]);
    return release;
  }
  async remote(session:string,peer:ComputerUseRemotePeer,body:Record<string,unknown>){
    const call:RuntimeCall={session,peer:{...peer},body:structuredClone(body),done:false};
    this.calls.push(call);
    const gate=this.holds.get(String(body.operation))?.shift();
    try{if(gate)await gate;return await this.answer(body);}finally{call.done=true;}
  }
  remoteAdmission(peer:{deviceId:string;instance:string}){return this.admit(peer);}
  remoteGrants(){return this.grants;}
  count(operation:string){return this.calls.filter(call=>call.body.operation===operation).length;}
}

/** The mailbox's controlRespond, as the lane uses it: every answer per row is kept (a second one would be a bug). */
class Answers {
  readonly rows=new Map<string,Record<string,unknown>[]>();
  private readonly waiters=new Map<string,(response:Record<string,unknown>)=>void>();
  respond=async(controlId:string,response:Record<string,unknown>)=>{
    this.rows.set(controlId,[...this.rows.get(controlId)??[],response]);
    this.waiters.get(controlId)?.(response);this.waiters.delete(controlId);
    return {responded:true};
  };
  wait(controlId:string):Promise<Record<string,unknown>>{
    const first=this.rows.get(controlId)?.[0];
    return first?Promise.resolve(first):new Promise(resolve=>this.waiters.set(controlId,resolve));
  }
  count(controlId:string){return this.rows.get(controlId)?.length??0;}
}

const hosts:ComputerUseRemoteHost[]=[];
const temporary:string[]=[];
afterEach(()=>{for(const host of hosts.splice(0))host.dispose();for(const path of temporary.splice(0))rmSync(path,{recursive:true,force:true});});

interface SetupOptions {bundled?:boolean|(()=>boolean);platform?:string;limits?:Partial<ComputerUseRemoteHostLimits>;notice?:(text:string,requestId:string)=>Promise<unknown>;runtime?:ComputerUseRemoteHostRuntime}
function setup(options:SetupOptions={}){
  const clock={now:START};
  const fake=new FakeRuntime();
  const runtime=options.runtime??fake;
  const answers=new Answers();
  const notices:{text:string;requestId:string}[]=[];
  const self=randomUUID();
  const make=()=>{
    const host=new ComputerUseRemoteHost({runtime,respond:answers.respond,notice:options.notice??(async(text,requestId)=>{notices.push({text,requestId});}),
      selfDeviceId:()=>self,deviceName:()=>'3호 / 아젠투지(OPS)',bundled:options.bundled??true,platform:options.platform??'darwin',now:()=>clock.now,
      ...(options.limits?{limits:options.limits}:{})});
    hosts.push(host);return host;
  };
  const t={clock,runtime:fake,answers,notices,self,host:make(),restart(){t.host=make();return t.host;}};
  return t;
}
type Setup=ReturnType<typeof setup>;
type Answer=({ok:true;body:Record<string,unknown>}|{ok:false;error:string})&{detached:boolean;controlId:string};
type Content=ReturnType<typeof parseComputerUseRemoteReplyContent>|{refused:string;part?:true};
type Header={op:'call'|'heartbeat'|'disconnect';seq:number;sentAt:number};

/**
 * One AI connection of a sending Mac: its device (the mailbox's fromDeviceId), its connection tag, and one session at a
 * time. `transport` replaces the direct call of the host's executor (the real mailbox test).
 */
class Sender {
  session='';channel:ComputerUseRemoteChannel|null=null;seq=0;bootId='';
  transport:((request:Record<string,unknown>)=>Promise<Answer>)|null=null;
  constructor(readonly t:Setup,readonly deviceId:string=randomUUID(),readonly tag:string=newComputerUseRemoteId(),readonly name='1호 / 아젠투지(OPS)'){}
  async send(request:Record<string,unknown>,deviceId=this.deviceId):Promise<Answer>{
    if(this.transport)return this.transport(request);
    const controlId=randomUUID();
    let out:Awaited<ReturnType<ComputerUseRemoteHost['execute']>>;
    try{out=await this.t.host.execute(structuredClone(request),{deviceId,name:this.name,endpointId:randomUUID()},controlId);}
    catch(error){return {ok:false,error:(error as Error).message,detached:false,controlId};}
    if(out===AGENT_DIALOGUE_CONTROL_DETACHED)return {...(await this.t.answers.wait(controlId)) as {ok:true;body:Record<string,unknown>},detached:true,controlId};
    return {ok:true,body:out,detached:false,controlId};
  }
  async hello(options:{sentAt?:number;platform?:ComputerUseRemotePlatform;session?:string}={}):Promise<Answer>{
    const {keyPair,publicKey}=await generateComputerUseRemoteKeyPair();
    const session=options.session??newComputerUseRemoteId(),platform=options.platform??'darwin';
    const answer=await this.send({kind:'computer-use',v:1,op:'hello',session,seq:0,sentAt:options.sentAt??this.t.clock.now,pub:publicKey,instance:this.tag,platform});
    if(answer.ok){
      const body=parseComputerUseRemoteReply('hello',answer.body);
      this.channel=await ComputerUseRemoteChannel.establish({side:'sender',privateKey:keyPair.privateKey,peerPublicKey:body.pub,
        binding:{session,senderDeviceId:this.deviceId,receiverDeviceId:this.t.self,instance:this.tag,platform}});
      this.session=session;this.seq=0;this.bootId=body.bootId;
    }
    return answer;
  }
  async seal(meta:Record<string,unknown>,options:{op?:Header['op'];sentAt?:number}={}){
    const op=options.op??'call',seq=++this.seq,sentAt=options.sentAt??this.t.clock.now;
    const box=await this.channel!.sealRequest({op,seq,sentAt},meta);
    const envelope:Record<string,unknown>={kind:'computer-use',v:1,op,session:this.session,seq,sentAt,...(op==='call'?{}:{bg:1}),box};
    return {envelope,header:{op,seq,sentAt} as Header};
  }
  async open(header:Header,answer:Answer):Promise<Content>{
    if(!answer.ok)return {refused:answer.error};
    let box:string;
    if(header.op==='call'){
      const reply=parseComputerUseRemoteReply('call',answer.body);
      box=reply.box;
      if(reply.parts===2){
        const part=await this.send(computerUseRemotePartRequest({session:this.session,seq:header.seq},reply.ref,this.t.clock.now) as unknown as Record<string,unknown>);
        if(!part.ok)return {refused:part.error,part:true};
        box=joinComputerUseRemoteBox([reply.box,parseComputerUseRemoteReply('part',part.body).box]);
      }
    }else box=parseComputerUseRemoteReply(header.op,answer.body).box;
    const opened=await this.channel!.openReply(header,box);
    return parseComputerUseRemoteReplyContent(opened.meta,opened.attachment);
  }
  async call(meta:Record<string,unknown>,options:{op?:Header['op'];sentAt?:number}={}){
    const {envelope,header}=await this.seal(meta,options);
    const answer=await this.send(envelope);
    return {answer,header,content:await this.open(header,answer) as any};
  }
  /** The other Mac's raw receipt answer for an ID, as the MCP reads it. */
  async receipt(requestId:string,extra:Record<string,unknown>={}){
    const {content}=await this.call(receiptOf(requestId,extra));
    expect(content.kind).toBe('result');
    return content.result as Record<string,any>;
  }
}

describe('computer use from another Mac: the receiving host',()=>{
  test('hello answers its key and bootId without a runtime connection; the first call runs as the database\'s device and connection',async()=>{
    const t=setup();
    const a=new Sender(t,randomUUID().toUpperCase());
    const hello=await a.hello();
    expect(hello).toMatchObject({ok:true,detached:false,body:{v:1,bootId:t.host.bootId}});
    expect(Object.keys((hello as {body:Record<string,unknown>}).body).sort()).toEqual(['bootId','pub','v']);
    expect(t.runtime.calls).toHaveLength(0);
    const status=await a.call({operation:'scope-status',client:'codex-mcp-client',host:'Codex'});
    // A call is answered later by the lane, inside the box.
    expect(status.answer.detached).toBe(true);
    expect(status.content).toEqual({kind:'result',result:{success:true,grants:[],remote:{allowRemote:true,standing:true,appScope:false}}});
    expect(t.runtime.calls).toEqual([{session:a.session,body:{operation:'scope-status'},done:true,
      peer:{deviceId:a.deviceId.toLowerCase(),deviceName:'1호 / 아젠투지(OPS)',instance:a.tag,client:'codex-mcp-client',host:'Codex'}}]);
    // The labels came once; the session keeps them for every later call of its runtime connection.
    await a.call({operation:'scope-observe',grant:GRANT,epoch:1});
    expect(t.runtime.calls[1]!.peer).toMatchObject({client:'codex-mcp-client',host:'Codex'});
  });

  test('fixed refusals before anything is opened: not bundled, Windows, the person\'s switch, a blocked device or connection, a Windows sender',async()=>{
    for(const options of [{bundled:false},{platform:'win32'},{platform:'linux'}] as SetupOptions[]){
      const t=setup(options);const a=new Sender(t);
      expect(await a.hello()).toMatchObject({ok:false,error:sentence('REMOTE_UNSUPPORTED')});
      expect(classifyComputerUseRemoteRefusal(sentence('REMOTE_UNSUPPORTED'),{operation:'hello'})).toMatchObject({outcome:'not-run',code:'REMOTE_UNSUPPORTED'});
      expect(t.runtime.calls).toHaveLength(0);
    }
    const t=setup();
    expect(await new Sender(t).hello({platform:'win32'})).toMatchObject({ok:false,error:sentence('REMOTE_SENDER_UNSUPPORTED')});
    for(const code of ['REMOTE_BLOCKED_BY_PERSON','REMOTE_DEVICE_BLOCKED'] as const){
      t.runtime.admit=()=>code;
      expect(await new Sender(t).hello()).toMatchObject({ok:false,error:sentence(code)});
      expect(classifyComputerUseRemoteRefusal(sentence(code),{operation:'hello'})).toMatchObject({outcome:'not-run',code});
    }
    // Blocked while a session is open: the next call is refused before its box is opened, and its connection ends.
    t.runtime.admit=()=>null;
    const a=new Sender(t);
    await a.hello();
    await a.call({operation:'scope-status'});
    t.runtime.admit=peer=>peer.instance===a.tag?'REMOTE_DEVICE_BLOCKED':null;
    const blocked=await a.call(click('req-blocked-01'));
    expect(blocked.answer).toMatchObject({ok:false,error:sentence('REMOTE_DEVICE_BLOCKED')});
    expect(t.runtime.count('scope-click')).toBe(0);
    await waitFor(()=>t.runtime.count('disconnect')===1,'the runtime connection to end');
    t.runtime.admit=()=>null;
    expect((await a.call({operation:'scope-status'})).answer).toMatchObject({ok:false,error:sentence('REMOTE_SESSION_MISSING')});
    // Every envelope refusal is one of the fixed sentences the sender maps back to its code.
    for(const code of COMPUTER_USE_REMOTE_ENVELOPE_REFUSALS)expect(new Set(COMPUTER_USE_REMOTE_ENVELOPE_REFUSALS.map(sentence)).has(sentence(code))).toBe(true);
  });

  test('a lost or failing installed-main proof stops even an existing session before dispatch',async()=>{
    let ready=true;
    const t=setup({bundled:()=>{if(!ready)throw Error('peer vanished');return true;}});
    const a=new Sender(t);
    expect((await a.hello()).ok).toBe(true);
    expect((await a.call({operation:'scope-status'})).answer.ok).toBe(true);
    const before=t.runtime.calls.length;
    ready=false;
    expect((await a.call(click('req-proof-lost'))).answer).toMatchObject({ok:false,error:sentence('REMOTE_UNSUPPORTED')});
    expect(t.runtime.calls).toHaveLength(before);
    expect((await new Sender(t).hello())).toMatchObject({ok:false,error:sentence('REMOTE_UNSUPPORTED')});
  });

  test('RC-12: the host reads no environment variable — whether it receives is only what its caller injects',()=>{
    // Production wiring must supply a verified Main proof; this unit only checks the host reads no env itself.
    const source=readFileSync(join(import.meta.dir,'..','src','computerUseRemoteHost.ts'),'utf8')
      .replace(/\/\*[\s\S]*?\*\//g,'').replace(/\/\/.*$/gm,'');
    for(const read of ['process.env','Bun.env','import.meta.env','process[','globalThis.process'])expect(source).not.toContain(read);
  });

  test('four hellos a minute per device, four sessions per device and sixteen in all; a newer hello of a connection replaces its session',async()=>{
    const t=setup();
    const device=randomUUID();
    const first=new Sender(t,device);
    for(let i=0;i<4;i++)expect((await first.hello()).ok).toBe(true);
    // The fifth hello in the minute is refused, whatever it is for.
    expect(await first.hello()).toMatchObject({ok:false,error:sentence('REMOTE_RATE_LIMITED')});
    t.clock.now+=60_000;
    // Each hello replaced the one before (same connection): one session, and the old ones' runtime connections ended.
    const old=first.session;
    expect((await first.hello()).ok).toBe(true);
    const fresh=new Sender(t,device,first.tag);
    fresh.channel=first.channel;fresh.session=first.session;
    expect((await first.call({operation:'scope-status'})).content.kind).toBe('result');
    expect(t.runtime.calls.filter(call=>call.body.operation==='disconnect').map(call=>call.session)).toContain(old);
    // Four connections of one device at most.
    t.clock.now+=60_000;
    const others=[0,1,2].map(()=>new Sender(t,device));
    for(const other of others)expect((await other.hello()).ok).toBe(true);
    expect(await new Sender(t,device).hello()).toMatchObject({ok:false,error:sentence('REMOTE_RATE_LIMITED')});
    // Sixteen in all.
    for(let d=0;d<3;d++)for(let i=0;i<4;i++)expect((await new Sender(t,`${'0'.repeat(7)}${d}-0000-4000-8000-${String(i).padStart(12,'0')}`).hello()).ok).toBe(true);
    expect(await new Sender(t).hello()).toMatchObject({ok:false,error:sentence('REMOTE_RATE_LIMITED')});
    // An older hello of a connection does not end its newer session.
    t.clock.now+=60_000;
    const live=new Sender(t,device,others[0]!.tag);
    live.session=others[0]!.session;live.channel=others[0]!.channel;live.seq=others[0]!.seq;
    const stale=new Sender(t,device,others[0]!.tag);
    expect(await stale.hello({sentAt:t.clock.now-120_000})).toMatchObject({ok:false,error:sentence('REMOTE_RATE_LIMITED')});
    expect((await live.call({operation:'scope-status'})).content.kind).toBe('result');
  });

  test('seq and AAD: a replayed, reordered or moved box is refused before opening; a malformed frame that opened is answered in the box',async()=>{
    const t=setup();
    const a=new Sender(t),b=new Sender(t);
    await a.hello();await b.hello();
    const {envelope}=await a.seal({operation:'scope-status'});
    expect((await a.send(envelope)).ok).toBe(true);
    // The same row again, and an older seq: refused with the fixed sentence, nothing runs.
    expect(await a.send(envelope)).toMatchObject({ok:false,error:sentence('REMOTE_BAD_REQUEST')});
    const second=await a.seal({operation:'scope-status'}),third=await a.seal({operation:'scope-status'});
    expect((await a.send(third.envelope)).ok).toBe(true);
    expect(await a.send(second.envelope)).toMatchObject({ok:false,error:sentence('REMOTE_BAD_REQUEST')});
    expect(t.runtime.count('scope-status')).toBe(2);
    // A's box under B's session (another device): the AAD binds the devices, so it does not open — and B's counter stays.
    const moved=await a.seal({operation:'scope-status'});
    expect(await b.send({...moved.envelope,session:b.session,seq:1})).toMatchObject({ok:false,error:sentence('REMOTE_BAD_REQUEST')});
    expect(await a.send(moved.envelope,b.deviceId)).toMatchObject({ok:false,error:sentence('REMOTE_SESSION_MISSING')});
    expect((await b.call({operation:'scope-status'})).content.kind).toBe('result');
    // A frame that opened but is malformed (its seq is spent): the refusal is sealed, never plaintext.
    const channel=a.channel as unknown as {lastSealed:number;awaitReply(seq:number):void;encrypt(direction:string,header:Header,frame:Uint8Array):Promise<string>};
    const seq=++a.seq,header:Header={op:'call',seq,sentAt:t.clock.now};
    channel.lastSealed=seq;channel.awaitReply(seq);
    const box=await channel.encrypt('a2b',header,new Uint8Array([0,0,0,1,0x7b]));
    const malformed=await a.send({kind:'computer-use',v:1,op:'call',session:a.session,seq,sentAt:header.sentAt,box});
    expect(malformed).toMatchObject({ok:true,detached:false});
    expect(await a.open(header,malformed)).toEqual({kind:'error',outcome:'not-run',code:'REMOTE_BAD_REQUEST',error:sentence('REMOTE_BAD_REQUEST')});
    // An operation outside the closed list is refused inside the box too, naming nothing of what was sent.
    const unknown=await a.call({operation:'scope-type-secret',text:'SECRET-TEXT'});
    expect(unknown.answer.ok).toBe(true);
    expect(JSON.stringify(unknown.answer)).not.toContain('SECRET');
    expect(unknown.content).toMatchObject({kind:'error',outcome:'not-run',code:'REMOTE_BAD_REQUEST'});
  });

  test('the ledger is the device\'s and the connection\'s: another connection\'s same ID runs on its own and its receipt never leaks',async()=>{
    const t=setup();
    const device=randomUUID();
    const one=new Sender(t,device),two=new Sender(t,device),three=new Sender(t,device);
    for(const s of [one,two,three])await s.hello();
    expect((await one.call(click('req-shared-01'))).content).toEqual({kind:'result',result:{success:true,receipt:{requestId:'req-shared-01',state:'confirmed'}}});
    expect((await two.call(click('req-shared-01',20))).content.result.receipt).toEqual({requestId:'req-shared-01',state:'confirmed'});
    expect(t.runtime.count('scope-click')).toBe(2);
    // A third connection never sent it: unseen, not the others' receipt.
    expect((await three.receipt('req-shared-01')).receipt).toEqual({requestId:'req-shared-01',state:'unseen'});
    // Another device with the same connection tag is another ledger too.
    const elsewhere=new Sender(t,randomUUID(),one.tag);await elsewhere.hello();
    expect((await elsewhere.receipt('req-shared-01')).receipt.state).toBe('unseen');
    expect(await one.receipt('req-shared-01')).toEqual({success:true,bootId:t.host.bootId,evictedThroughSentAt:null,receipt:{requestId:'req-shared-01',state:'confirmed'}});
    // RC-8: the same key with other content is refused; the same content answers the stored receipt. Nothing runs again.
    expect((await one.call(click('req-shared-01',11))).content).toEqual({kind:'error',outcome:'not-run',code:'REMOTE_BAD_REQUEST',error:COMPUTER_USE_REMOTE_HOST_ID_CHANGED});
    expect((await one.call(click('req-shared-01'))).content).toEqual({kind:'result',result:{success:true,receipt:{requestId:'req-shared-01',state:'confirmed'}}});
    expect(t.runtime.count('scope-click')).toBe(2);
    // An input without a valid requestId is refused in the box, before the lane.
    expect((await one.call({...click('x'),requestId:'bad id'})).content).toMatchObject({kind:'error',outcome:'not-run',code:'REMOTE_BAD_REQUEST'});
  });

  test('over 1,024 entries the oldest settled are evicted and evictedThroughSentAt rises; queued and running entries stay',async()=>{
    const t=setup();
    const a=new Sender(t);await a.hello();
    const release=t.runtime.hold('scope-click');
    const sentAt=new Map<string,number>();
    const pending:Promise<unknown>[]=[];
    const send=async(index:number)=>{
      const id=`req-many-${String(index).padStart(5,'0')}`;
      t.clock.now+=1;sentAt.set(id,t.clock.now);
      return a.call(click(id));
    };
    // One running (Control busy) and three waiting: the device's four places in the lane.
    pending.push(send(0));
    await waitFor(()=>t.runtime.count('scope-click')===1,'the first click to start');
    for(let i=1;i<4;i++){pending.push(send(i));await waitFor(()=>(t.host as unknown as {lane:unknown[]}).lane.length===i+1,'the lane to fill');}
    // Then 1,026 more, each not run (busy) at once: 1,030 entries for this connection.
    for(let i=4;i<1030;i++)expect((await send(i)).content).toEqual(notRun('busy'));
    // The six oldest settled went; nothing waiting or running did.
    expect((await a.receipt('req-many-00000')).receipt.state).toBe('in-progress');
    expect((await a.receipt('req-many-00003')).receipt.state).toBe('in-progress');
    expect((await a.receipt('req-many-00010')).receipt).toEqual({requestId:'req-many-00010',state:'not-run',reason:'busy'});
    const evicted=await a.receipt('req-many-00004');
    expect(evicted.receipt.state).toBe('unseen');
    expect(evicted.evictedThroughSentAt).toBeGreaterThanOrEqual(sentAt.get('req-many-00009')!);
    // An unseen inside the evicted range is never read as "not run".
    expect(remoteReceiptVerdict({requestId:'req-many-00004',deviceId:'d',sentAt:sentAt.get('req-many-00004')!,bootId:t.host.bootId},evicted,t.clock.now))
      .toMatchObject({verdict:'unknown-final',why:'evicted-range'});
    release();
    await Promise.all(pending);
    expect((await a.receipt('req-many-00000')).receipt).toEqual({requestId:'req-many-00000',state:'confirmed'});
    expect((await a.receipt('req-many-00003')).receipt).toEqual({requestId:'req-many-00003',state:'confirmed'});
  },60_000);

  test('settled entries are kept 15 minutes; after that a receipt carries the evicted range',async()=>{
    const t=setup();
    const a=new Sender(t);await a.hello();
    const sentAt=t.clock.now;
    await a.call(click('req-kept-0001'));
    t.clock.now+=COMPUTER_USE_REMOTE_LIMITS.ledgerRetentionMs-1;
    expect((await a.receipt('req-kept-0001')).receipt.state).toBe('confirmed');
    t.clock.now+=1;
    const later=await a.receipt('req-kept-0001');
    expect(later).toMatchObject({receipt:{state:'unseen'},evictedThroughSentAt:sentAt});
    expect(remoteReceiptVerdict({requestId:'req-kept-0001',deviceId:'d',sentAt,bootId:t.host.bootId},later,t.clock.now).verdict).toBe('unknown-final');
  });

  test('an unseen ID leaves a tombstone: the original row arriving later is never run',async()=>{
    const t=setup();
    const device=randomUUID();
    const original=new Sender(t,device);await original.hello();
    // The same connection's newer session asks first (an older hello does not replace the original's session here).
    const asking=new Sender(t,device,original.tag);await asking.hello({sentAt:t.clock.now-1_000});
    const unseen=await asking.receipt('req-late-0001');
    expect(unseen).toEqual({success:true,bootId:t.host.bootId,evictedThroughSentAt:null,receipt:{requestId:'req-late-0001',state:'unseen'}});
    expect(remoteReceiptVerdict({requestId:'req-late-0001',deviceId:'d',sentAt:t.clock.now,bootId:t.host.bootId},unseen,t.clock.now))
      .toMatchObject({verdict:'not-run',reason:'unseen'});
    expect((await original.call(click('req-late-0001'))).content).toEqual(notRun('stale'));
    expect(t.runtime.count('scope-click')).toBe(0);
    expect((await asking.receipt('req-late-0001')).receipt.state).toBe('unseen');
  });

  test('a receipt answers in-progress, an actual receipt, not-run, evicted or unseen — always with bootId and evictedThroughSentAt',async()=>{
    const t=setup();
    const a=new Sender(t);await a.hello();
    const release=t.runtime.hold('scope-click');
    const running=a.call(click('req-state-run1'));
    await waitFor(()=>t.runtime.count('scope-click')===1,'the click to start');
    const states:Record<string,unknown>[]=[];
    states.push(await a.receipt('req-state-run1'));
    release();await running;
    states.push(await a.receipt('req-state-run1'));
    // A stale input is not run, and that is what its receipt says.
    expect((await a.call(click('req-state-old1'),{sentAt:t.clock.now-12_001})).content).toEqual(notRun('stale'));
    states.push(await a.receipt('req-state-old1'));
    // Not in the ledger: ScopeHost is asked for this session's grant; a spent ID it dropped is evicted.
    t.runtime.answer=body=>body.operation==='scope-receipt'?{success:true,receipt:{requestId:body.requestId,state:'evicted'},guidance:'이미 정리된 요청입니다.'}:defaultAnswer(body);
    states.push(await a.receipt('req-state-gone',{grant:GRANT,epoch:1}));
    expect(t.runtime.calls.at(-1)!.body).toEqual({operation:'scope-receipt',grant:GRANT,epoch:1,requestId:'req-state-gone'});
    t.runtime.answer=defaultAnswer;
    states.push(await a.receipt('req-state-none',{grant:GRANT,epoch:1}));
    expect(states.map(state=>(state.receipt as {state:string}).state)).toEqual(['in-progress','confirmed','not-run','evicted','unseen']);
    for(const state of states){
      expect(state).toMatchObject({success:true,bootId:t.host.bootId,evictedThroughSentAt:null});
      // Exactly the sender's closed shape.
      expect(parseComputerUseRemoteReceiptAnswer(state)).toEqual(state as any);
    }
    expect(states[2]!.receipt).toEqual({requestId:'req-state-old1',state:'not-run',reason:'stale'});
    expect(states[3]!.guidance).toBe('이미 정리된 요청입니다.');
  });

  test('after this Mac restarts (a new bootId) an old session\'s request is refused as session-missing before anything runs',async()=>{
    const t=setup();
    const a=new Sender(t);await a.hello();
    const firstBoot=t.host.bootId;
    t.restart();
    expect(t.host.bootId).not.toBe(firstBoot);
    expect(t.host.bootId).toMatch(/^[0-9a-f]{32}$/);
    const lost=await a.call(click('req-restart-1'));
    expect(lost.answer).toMatchObject({ok:false,error:sentence('REMOTE_SESSION_MISSING')});
    expect(classifyComputerUseRemoteRefusal(sentence('REMOTE_SESSION_MISSING'),{operation:'scope-click',requestId:'req-restart-1'})).toMatchObject({outcome:'not-run',code:'REMOTE_SESSION_MISSING'});
    expect(t.runtime.calls).toHaveLength(0);
    // The next hello is answered with the new boot.
    expect(await a.hello()).toMatchObject({ok:true,body:{bootId:t.host.bootId}});
  });

  test('RC-6 is judged when execution starts: the 12 s and 5 s boundaries run, beyond them not run, request-access included',async()=>{
    const t=setup();
    const a=new Sender(t);await a.hello();
    const now=()=>t.clock.now;
    expect((await a.call(click('req-edge-past'),{sentAt:now()-12_000})).content.result.receipt.state).toBe('confirmed');
    expect((await a.call(click('req-edge-pst2'),{sentAt:now()-12_001})).content).toEqual(notRun('stale'));
    expect((await a.call(click('req-edge-futr'),{sentAt:now()+5_000})).content.result.receipt.state).toBe('confirmed');
    expect((await a.call(click('req-edge-ftr2'),{sentAt:now()+5_001})).content).toEqual(notRun('clock'));
    expect((await a.call({operation:'scope-request-access'},{sentAt:now()-12_001})).content).toEqual(notRun('stale'));
    expect((await a.call({operation:'scope-request-human',grant:GRANT,epoch:1},{sentAt:now()+5_001})).content).toEqual(notRun('clock'));
    expect(t.runtime.count('scope-request-access')+t.runtime.count('scope-request-human')).toBe(0);
    // A read changes nothing: an old one still runs.
    expect((await a.call({operation:'scope-status'},{sentAt:now()-60_000})).content.kind).toBe('result');
    expect((await a.call({operation:'scope-request-access'},{sentAt:now()-12_000})).content.result.state).toBe('granted');
    // Fresh when it was taken, stale when its turn came: not run.
    const release=t.runtime.hold('scope-click');
    const first=a.call(click('req-turn-0001'));
    await waitFor(()=>t.runtime.count('scope-click')===3,'the first click to start');
    const second=a.call(click('req-turn-0002'));
    await waitFor(()=>(t.host as unknown as {lane:unknown[]}).lane.length===2,'the second click to wait');
    t.clock.now+=12_001;
    release();
    expect((await first).content.result.receipt.state).toBe('confirmed');
    expect((await second).content).toEqual(notRun('stale'));
    expect((await a.receipt('req-turn-0002')).receipt).toEqual({requestId:'req-turn-0002',state:'not-run',reason:'stale'});
    expect(t.runtime.count('scope-click')).toBe(3);
  });

  test('the lane: over its depth is not run (busy) at once; past 15 s a waiting item is not run and a running one hears the deadline, keeps going and settles',async()=>{
    const t=setup();
    const a=new Sender(t);await a.hello();
    const release=t.runtime.hold('scope-click');
    const lane=()=>(t.host as unknown as {lane:unknown[]}).lane.length;
    const held=[a.call(click('req-lane-0000'))];
    await waitFor(()=>t.runtime.count('scope-click')===1,'the first click to start');
    for(let i=1;i<4;i++){held.push(a.call(click(`req-lane-000${i}`)));await waitFor(()=>lane()===i+1,'the lane');}
    // Four per sending device.
    expect((await a.call(click('req-lane-0004'))).content).toEqual(notRun('busy'));
    // Eight for this Mac.
    const others=[new Sender(t),new Sender(t)];
    for(const other of others){await other.hello();for(let i=0;i<2;i++){held.push(other.call({operation:'scope-status'}));await waitFor(()=>lane()===held.length,'the lane');}}
    const third=new Sender(t);await third.hello();
    expect(lane()).toBe(8);
    expect((await third.call(click('req-lane-0099'))).content).toEqual(notRun('busy'));
    expect((await third.call({operation:'scope-observe',grant:GRANT,epoch:1})).content).toEqual(notRun('busy'));
    release();
    await Promise.all(held);
    expect(t.runtime.count('scope-click')).toBe(4);

    // The 15 s answer deadline (shortened here).
    const s=setup({limits:{receiverAnswerMs:150}});
    const b=new Sender(s);await b.hello();
    const hold=s.runtime.hold('scope-click');
    const slow=b.call(click('req-slow-0001'));
    await waitFor(()=>s.runtime.count('scope-click')===1,'the slow click to start');
    const waiting=b.call(click('req-wait-0001'));
    // Running: the deadline sentence (an open outcome for the sender); waiting: not run.
    const slowAnswer=await slow;
    expect(slowAnswer.answer).toMatchObject({ok:false,error:COMMUNITY_CONTROL_EXECUTE_TIMEOUT_MESSAGE});
    expect(classifyComputerUseRemoteRefusal(COMMUNITY_CONTROL_EXECUTE_TIMEOUT_MESSAGE,{operation:'scope-click',requestId:'req-slow-0001'}).outcome).toBe('unknown');
    expect((await waiting).content).toEqual(notRun('busy'));
    expect((await b.receipt('req-slow-0001')).receipt.state).toBe('in-progress');
    hold();
    await waitFor(()=>s.runtime.calls[0]!.done,'the slow click to end');
    await Bun.sleep(10);
    // It kept running and its ledger settled; its row was answered exactly once.
    expect((await b.receipt('req-slow-0001')).receipt).toEqual({requestId:'req-slow-0001',state:'confirmed'});
    expect(s.answers.count(slowAnswer.answer.controlId)).toBe(1);
    expect((await b.receipt('req-wait-0001')).receipt).toEqual({requestId:'req-wait-0001',state:'not-run',reason:'busy'});
    expect(s.runtime.count('scope-click')).toBe(1);
  });

  test('a runtime refusal is not run and stays in the box; the ledger names it',async()=>{
    const t=setup();
    const a=new Sender(t);await a.hello();
    t.runtime.answer=body=>{
      if(body.operation==='scope-click')throw Object.assign(new Error('다른 Mac의 AI는 그 Mac의 터미널·AI 앱·스크립트 도구·원격 데스크톱 앱에 입력하지 않습니다. (SECRET 11,22)'),{code:'REMOTE_LOOP_TARGET'});
      if(body.operation==='scope-request-access')throw Object.assign(new Error('그 Mac의 Control에서 사람이 상시 허용을 켜야 합니다.'),{code:'REMOTE_NEEDS_STANDING'});
      return defaultAnswer(body);
    };
    const refused=await a.call(click('req-refused-01'));
    expect(refused.answer.ok).toBe(true);
    expect(JSON.stringify(refused.answer)).not.toContain('SECRET');
    expect(refused.content).toMatchObject({kind:'error',outcome:'not-run',code:'REMOTE_LOOP_TARGET'});
    expect((await a.receipt('req-refused-01')).receipt).toEqual({requestId:'req-refused-01',state:'refused',reason:'remote-loop-target'});
    expect((await a.call({operation:'scope-request-access'})).content).toMatchObject({kind:'error',outcome:'not-run',code:'REMOTE_NEEDS_STANDING'});
    // The person blocks receiving while the session is open: the runtime refuses, the connection ends.
    t.runtime.answer=body=>{if(body.operation==='scope-click')throw Object.assign(new Error('그 Mac에서 다른 Mac의 AI를 막아 두었습니다(사람의 설정).'),{code:'REMOTE_BLOCKED_BY_PERSON'});return defaultAnswer(body);};
    expect((await a.call(click('req-refused-02'))).content).toMatchObject({kind:'error',outcome:'not-run',code:'REMOTE_BLOCKED_BY_PERSON'});
    expect((await a.call({operation:'scope-status'})).answer).toMatchObject({ok:false,error:sentence('REMOTE_SESSION_MISSING')});
    // An input whose answer carries no receipt is recorded as unknown, never as done or not run.
    const b=new Sender(t);await b.hello();
    t.runtime.answer=body=>body.operation==='scope-click'?{success:true}:defaultAnswer(body);
    await b.call(click('req-noreceipt'));
    expect((await b.receipt('req-noreceipt')).receipt).toEqual({requestId:'req-noreceipt',state:'unknown'});
  });

  test('heartbeat and disconnect are answered in the poll, sealed; a silent session is forgotten and its connection ended',async()=>{
    const t=setup();
    const a=new Sender(t);await a.hello();
    const beat=await a.call({},{op:'heartbeat'});
    expect(beat.answer).toMatchObject({ok:true,detached:false});
    expect(beat.content).toEqual({kind:'result',result:{success:true,active:true}});
    expect(t.runtime.calls.at(-1)).toMatchObject({session:a.session,body:{operation:'heartbeat'}});
    // A heartbeat box with content is refused inside the box.
    expect((await a.call({operation:'scope-click'},{op:'heartbeat'})).content).toMatchObject({kind:'error',code:'REMOTE_BAD_REQUEST'});
    const bye=await a.call({},{op:'disconnect'});
    expect(bye.content).toEqual({kind:'result',result:{success:true}});
    expect(t.runtime.calls.at(-1)).toMatchObject({session:a.session,body:{operation:'disconnect'}});
    expect((await a.call({operation:'scope-status'})).answer).toMatchObject({ok:false,error:sentence('REMOTE_SESSION_MISSING')});
    // Disconnect is taken even from a connection the person blocked meanwhile.
    const b=new Sender(t);await b.hello();
    t.runtime.admit=()=>'REMOTE_DEVICE_BLOCKED';
    expect((await b.call({},{op:'disconnect'})).content).toEqual({kind:'result',result:{success:true}});
    t.runtime.admit=()=>null;
    // Silence: forgotten after the idle time, and its runtime connection is ended.
    const c=new Sender(t);await c.hello();
    t.clock.now+=COMPUTER_USE_REMOTE_HOST_SESSION_IDLE_MS-1;await t.host.tick();
    expect((await c.call({operation:'scope-status'})).content.kind).toBe('result');
    t.clock.now+=COMPUTER_USE_REMOTE_HOST_SESSION_IDLE_MS;await t.host.tick();
    await waitFor(()=>t.runtime.calls.some(call=>call.session===c.session&&call.body.operation==='disconnect'),'the silent connection to end');
    expect((await c.call({operation:'scope-status'})).answer).toMatchObject({ok:false,error:sentence('REMOTE_SESSION_MISSING')});
  });

  test('a failed disconnect reports an unknown state without leaking the error or retrying the runtime',async()=>{
    for(const failure of ['throw','refuse','malformed'] as const){
      const t=setup();
      const a=new Sender(t);await a.hello();
      t.runtime.answer=body=>{
        if(body.operation!=='disconnect')return defaultAnswer(body);
        if(failure==='throw')throw new Error('private local path or secret');
        return failure==='refuse'?{success:false,error:'private local path or secret'}:{};
      };
      const bye=await a.call({},{op:'disconnect'});
      expect(bye.content).toEqual({kind:'error',outcome:'state-unknown',code:'REMOTE_DISCONNECT_UNKNOWN',
        error:'그 Mac의 연결 정리 결과를 확인하지 못했습니다. 자동으로 다시 보내지 않았습니다.'});
      expect(t.runtime.count('disconnect')).toBe(1);
      expect((await a.call({operation:'scope-status'})).answer).toMatchObject({ok:false,error:sentence('REMOTE_SESSION_MISSING')});
      expect(t.runtime.count('disconnect')).toBe(1);
    }
  });

  test('a long reply is split: the rest is served for 15 s only for its session, seq and ref; app names are trimmed under 60 KB',async()=>{
    const t=setup();
    const a=new Sender(t);await a.hello();
    const jpeg=new Uint8Array(200_000).map((_,i)=>(i*31+7)&255);
    const apps=Array.from({length:100},(_,i)=>({id:`app-${i}`,name:`${'🙂'.repeat(150)}${i}`,bundleId:`com.example.app${i}`}));
    t.runtime.answer=body=>body.operation==='scope-observe'?{success:true,epoch:1,observationId:'obs-9',
      observation:{applications:apps,displays:[{id:'d1',note:'x'.repeat(36_000)}],foreground:{applicationId:'app-7',bundleId:'com.example.app7',pid:9,processStart:'1'}},
      image:{mediaType:'image/jpeg',data:Buffer.from(jpeg).toString('base64'),width:1440,height:900}}:defaultAnswer(body);
    const {envelope,header}=await a.seal({operation:'scope-observe',grant:GRANT,epoch:1,capture:true});
    const answer=await a.send(envelope);
    expect(answer.ok).toBe(true);
    const reply=parseComputerUseRemoteReply('call',(answer as {body:Record<string,unknown>}).body);
    expect(reply.parts).toBe(2);
    const ref=(reply as {ref:string}).ref;
    // Only the exact (session, seq, ref) gets the rest.
    expect(await a.send(computerUseRemotePartRequest({session:a.session,seq:header.seq},newComputerUseRemoteId(),t.clock.now) as unknown as Record<string,unknown>))
      .toMatchObject({ok:false,error:sentence('REMOTE_PART_LOST')});
    const other=new Sender(t);await other.hello();
    expect(await other.send(computerUseRemotePartRequest({session:a.session,seq:header.seq},ref,t.clock.now) as unknown as Record<string,unknown>))
      .toMatchObject({ok:false,error:sentence('REMOTE_PART_LOST')});
    const content=await a.open(header,answer) as {kind:'result';result:Record<string,any>};
    expect(content.kind).toBe('result');
    expect(Buffer.from(content.result.image.data,'base64').equals(Buffer.from(jpeg))).toBe(true);
    // Names cut to 80 characters, then only the foreground app keeps its name.
    const shown=content.result.observation.applications as {id:string;name?:string}[];
    expect(shown).toHaveLength(100);
    expect(shown.find(app=>app.id==='app-7')!.name).toBe('🙂'.repeat(80));
    expect(shown.filter(app=>app.name!==undefined).map(app=>app.id)).toEqual(['app-7']);
    // Fewer names fit as they are, cut.
    t.runtime.answer=body=>body.operation==='scope-observe'?{success:true,epoch:1,observationId:'obs-8',
      observation:{applications:apps.slice(0,5),displays:[],foreground:null}}:defaultAnswer(body);
    const small=await a.call({operation:'scope-observe',grant:GRANT,epoch:1});
    expect(small.content.result.observation.applications.map((app:{name:string})=>Array.from(app.name).length)).toEqual([80,80,80,80,80]);
    // After 15 s the rest is gone.
    t.clock.now+=COMPUTER_USE_REMOTE_LIMITS.partCacheMs;
    expect(await a.send(computerUseRemotePartRequest({session:a.session,seq:header.seq},ref,t.clock.now) as unknown as Record<string,unknown>))
      .toMatchObject({ok:false,error:sentence('REMOTE_PART_LOST')});
  });

  test('the capture budget: 6 MB of sealed capture replies a minute per receiving Mac, then REMOTE_RATE_LIMITED in the box',async()=>{
    const t=setup();
    const a=new Sender(t);await a.hello();
    const jpeg=Buffer.from(new Uint8Array(150_000).map((_,i)=>(i*7)&255)).toString('base64');
    t.runtime.answer=body=>body.operation==='scope-capture'?{success:true,image:{mediaType:'image/jpeg',data:jpeg,width:1440,height:900}}:defaultAnswer(body);
    let used=0,captures=0;
    for(;;){
      const {envelope,header}=await a.seal({operation:'scope-capture',grant:GRANT,epoch:1,observationId:'obs-1',displayId:'d1'});
      const answer=await a.send(envelope);
      const reply=parseComputerUseRemoteReply('call',(answer as {body:Record<string,unknown>}).body);
      const content=await a.open(header,answer) as any;
      if(content.kind==='error'){
        expect(content).toMatchObject({kind:'error',outcome:'not-run',code:'REMOTE_RATE_LIMITED'});
        break;
      }
      captures+=1;
      used+=reply.parts===2?reply.box.length+computerUseRemoteBoxLength(content):reply.box.length;
      expect(captures).toBeLessThan(40);
    }
    expect(used).toBeGreaterThanOrEqual(COMPUTER_USE_REMOTE_LIMITS.captureBytesPerMinute);
    expect(t.runtime.count('scope-capture')).toBe(captures);
    // A minute later it goes again.
    t.clock.now+=60_000;
    expect((await a.call({operation:'scope-capture',grant:GRANT,epoch:1,observationId:'obs-1',displayId:'d1'})).content.kind).toBe('result');
  },60_000);

  test('notices: one when a remote grant opens and one when it stayed closed five minutes, grouped per sending device, content-free',async()=>{
    const t=setup();
    const a=new Sender(t);await a.hello();
    const name='1호 / 아젠투지(OPS)';
    t.runtime.grants=[{deviceId:a.deviceId,deviceName:'1호'}];
    await t.host.tick();
    expect(t.notices).toHaveLength(1);
    expect(t.notices[0]!.requestId).toMatch(/^cu-start-[0-9a-f]{32}$/);
    expect(t.notices[0]!.text).toStartWith('1호의 AI가 이 Mac(3호)의 컴퓨터 유즈를 시작했습니다 · 전체 Mac. 멈추려면 3호의 Control 막대 「중단」 또는 AgentsToZ 컴퓨터 유즈 패널을 쓰세요.');
    expect(t.notices[0]!.text).toContain('AI 컴퓨터 유즈 전체가 멈춥니다');
    // Two inputs while it is open.
    await a.call(click('req-notice-01',123));await a.call(click('req-notice-02',456));
    // Closed and reopened within five minutes: the same episode.
    t.runtime.grants=[];t.clock.now+=60_000;await t.host.tick();
    t.clock.now+=120_000;t.runtime.grants=[{deviceId:a.deviceId,deviceName:'1호'}];await t.host.tick();
    // Another device's grant is its own episode.
    const b=new Sender(t,randomUUID(),newComputerUseRemoteId(),'2호');await b.hello();
    t.runtime.grants=[{deviceId:a.deviceId,deviceName:'1호'},{deviceId:b.deviceId,deviceName:'2호'}];await t.host.tick();
    expect(t.notices.map(n=>n.text.slice(0,13))).toEqual(['1호의 AI가 이 Mac','2호의 AI가 이 Mac']);
    t.runtime.grants=[];t.clock.now+=60_000;await t.host.tick();
    const closedAt=t.clock.now;
    t.clock.now=closedAt+COMPUTER_USE_REMOTE_LIMITS.noticeGroupMs-1;await t.host.tick();
    expect(t.notices).toHaveLength(2);
    t.clock.now=closedAt+COMPUTER_USE_REMOTE_LIMITS.noticeGroupMs;await t.host.tick();
    expect(t.notices).toHaveLength(4);
    const ends=t.notices.slice(2).map(n=>n.text).sort();
    expect(ends).toEqual(['1호의 AI가 이 Mac(3호)에서 쓰던 컴퓨터 유즈가 끝났습니다(4분, 동작 2개).','2호의 AI가 이 Mac(3호)에서 쓰던 컴퓨터 유즈가 끝났습니다(1분, 동작 0개).']);
    expect(t.notices.slice(2).every(n=>/^cu-end-[0-9a-f]{32}$/.test(n.requestId))).toBe(true);
    // Nothing of what was done shows: no coordinates, request IDs or the sender's full name.
    for(const n of t.notices){for(const word of ['123','456','req-notice',name])expect(n.text).not.toContain(word);}
    await t.host.tick();
    expect(t.notices).toHaveLength(4);
  });

  test('a notice that could not be posted is tried again with the same ID, spaced in time: a burst of calls during an outage does not use it up',async()=>{
    // Every attempt is recorded, failed or not, so the IDs of the tries themselves are compared.
    let failing=true;const attempts:string[]=[];const posted:string[]=[];
    const t=setup({notice:async(_text,requestId)=>{attempts.push(requestId);if(failing)throw new Error('offline');posted.push(requestId);}});
    const a=new Sender(t);await a.hello();
    t.runtime.grants=[{deviceId:a.deviceId,deviceName:'1호'}];
    await t.host.tick();
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatch(/^cu-start-[0-9a-f]{32}$/);
    // Five calls in the same second: each ends with a pass over the notices, and none of them is another try.
    for(let i=0;i<5;i++)expect((await a.call({operation:'scope-status'})).content.kind).toBe('result');
    await t.host.tick();
    expect(attempts).toHaveLength(1);
    // One tick later it is tried again; then twice as long apart, at most a minute — for as long as the episode lasts.
    const at:number[]=[t.clock.now];
    for(let step=0;step<240;step++){
      t.clock.now+=COMPUTER_USE_REMOTE_HOST_TICK_MS;
      const before=attempts.length;
      await t.host.tick();
      if(attempts.length>before)at.push(t.clock.now);
    }
    expect(attempts.length).toBeGreaterThan(10);
    const gaps=at.slice(1).map((time,i)=>time-at[i]!);
    expect(gaps.slice(0,5)).toEqual([5_000,10_000,20_000,40_000,60_000]);
    expect(gaps.every(gap=>gap<=60_000)).toBe(true);
    expect(posted).toHaveLength(0);
    // Back online: the next try posts it — the same ID as every try before — and then nothing more.
    failing=false;
    t.clock.now+=60_000;await t.host.tick();
    expect(posted).toEqual([attempts[0]!]);
    expect(new Set(attempts)).toEqual(new Set([attempts[0]!]));
    const tried=attempts.length;
    t.clock.now+=60_000;await t.host.tick();
    expect(attempts).toHaveLength(tried);

    // The end notice: the same, under its own ID; while the outage lasts it is tried for 30 minutes, then left.
    failing=true;
    t.runtime.grants=[];await t.host.tick();
    t.clock.now+=COMPUTER_USE_REMOTE_LIMITS.noticeGroupMs;await t.host.tick();
    const ends=()=>attempts.filter(id=>id.startsWith('cu-end-'));
    expect(ends()).toHaveLength(1);
    expect(ends()[0]).toMatch(/^cu-end-[0-9a-f]{32}$/);
    for(let i=0;i<5;i++)await t.host.tick();
    expect(ends()).toHaveLength(1);
    for(let step=0;step<30*60_000/COMPUTER_USE_REMOTE_HOST_TICK_MS+24;step++){t.clock.now+=COMPUTER_USE_REMOTE_HOST_TICK_MS;await t.host.tick();}
    const endTries=ends().length;
    expect(endTries).toBeGreaterThan(10);
    expect(new Set(ends()).size).toBe(1);
    expect((t.host as unknown as {endings:unknown[]}).endings).toHaveLength(0);
    t.clock.now+=60_000;await t.host.tick();
    expect(ends()).toHaveLength(endTries);
    // A later outage that ends in time: the end notice goes out on a retry, once.
    const b=new Sender(t,randomUUID(),newComputerUseRemoteId(),'2호');await b.hello();
    failing=false;
    t.runtime.grants=[{deviceId:b.deviceId,deviceName:'2호'}];await t.host.tick();
    failing=true;
    t.runtime.grants=[];await t.host.tick();
    t.clock.now+=COMPUTER_USE_REMOTE_LIMITS.noticeGroupMs;await t.host.tick();
    failing=false;
    t.clock.now+=COMPUTER_USE_REMOTE_HOST_TICK_MS;await t.host.tick();
    const second=posted.filter(id=>id.startsWith('cu-end-'));
    expect(second).toHaveLength(1);
    expect(attempts.filter(id=>id===second[0])).toHaveLength(2);
  },30_000);

  test('ScopeHost\'s evicted for a spent ID is what the ledger keeps: the receipt and a repeat agree with the reply, and it is no action',async()=>{
    const t=setup();
    const a=new Sender(t);await a.hello();
    t.runtime.grants=[{deviceId:a.deviceId,deviceName:'1호'}];await t.host.tick();
    const guidance='이 요청 ID는 이미 사용됐고 결과가 정해졌습니다. 다시 보내지 말고 화면을 새로 관찰하세요.';
    t.runtime.answer=body=>body.operation==='scope-click'&&body.requestId==='req-spent-0001'
      ?{success:true,receipt:{requestId:body.requestId,state:'evicted'},guidance}:defaultAnswer(body);
    const sentAt=t.clock.now;
    const reply=await a.call(click('req-spent-0001'));
    expect(reply.content).toEqual({kind:'result',result:{success:true,receipt:{requestId:'req-spent-0001',state:'evicted'},guidance}});
    const receipt=await a.receipt('req-spent-0001');
    expect(receipt).toEqual({success:true,bootId:t.host.bootId,evictedThroughSentAt:null,receipt:{requestId:'req-spent-0001',state:'evicted'},guidance});
    expect(remoteReceiptVerdict({requestId:'req-spent-0001',deviceId:'d',sentAt,bootId:t.host.bootId},receipt,t.clock.now))
      .toMatchObject({verdict:'unknown-final',why:'evicted'});
    // The same row again answers the same, and nothing runs again.
    expect((await a.call(click('req-spent-0001'))).content).toEqual(reply.content);
    expect(t.runtime.count('scope-click')).toBe(1);
    // Only inputs that ran are counted in the end notice.
    await a.call(click('req-ran-00001'));
    t.runtime.grants=[];await t.host.tick();
    t.clock.now+=COMPUTER_USE_REMOTE_LIMITS.noticeGroupMs;await t.host.tick();
    expect(t.notices.at(-1)!.text).toEndWith('(1분, 동작 1개).');
  });

  test('dispose stops the lane: a waiting input never runs, is settled receiver-off and answered so in its box; a running one keeps its answer',async()=>{
    const t=setup();
    const a=new Sender(t);await a.hello();
    const lane=()=>(t.host as unknown as {lane:unknown[]}).lane.length;
    const release=t.runtime.hold('scope-click');
    const first=a.call(click('req-dispose-01'));
    await waitFor(()=>t.runtime.count('scope-click')===1,'the first click to start');
    const second=a.call(click('req-dispose-02'));
    await waitFor(()=>lane()===2,'the second click to wait');
    // Shutdown. Not awaited first: the waiting input is already out of the lane, so releasing Control cannot start it.
    const disposed=t.host.dispose();
    release();
    await disposed;
    expect((await second).content).toEqual(notRun('receiver-off'));
    expect((await first).content).toEqual({kind:'result',result:{success:true,receipt:{requestId:'req-dispose-01',state:'confirmed'}}});
    await Bun.sleep(10);
    expect(t.runtime.count('scope-click')).toBe(1);
    expect(lane()).toBe(0);
    // Each row was answered by the host exactly once (the mailbox's safety net has nothing left to say).
    expect(t.answers.count((await second).answer.controlId)).toBe(1);
    expect(t.answers.count((await first).answer.controlId)).toBe(1);
    // The ledger says the same as the answers.
    const ledger=[...(t.host as unknown as {ledgers:Map<string,{entries:Map<string,{state:string;receipt?:unknown}>}>}).ledgers.values()][0]!;
    expect(ledger.entries.get('req-dispose-02')).toMatchObject({state:'settled',receipt:{requestId:'req-dispose-02',state:'not-run',reason:'receiver-off'}});
    expect(ledger.entries.get('req-dispose-01')).toMatchObject({state:'settled',receipt:{requestId:'req-dispose-01',state:'confirmed'}});
    // A row after that is refused with the fixed sentence before anything is opened.
    expect((await a.call({operation:'scope-status'})).answer).toMatchObject({ok:false,error:sentence('REMOTE_UNSUPPORTED')});
    expect(t.runtime.count('scope-status')).toBe(0);
  });
});

/** The base64 length of a reply's second part, from what was opened (the test only needs the total size). */
function computerUseRemoteBoxLength(content:{result:Record<string,any>}){
  return Math.max(0,JSON.stringify(content.result).length-COMPUTER_USE_REMOTE_LIMITS.partMaxChars);
}

// ── The real mailbox ───────────────────────────────────────────────────────────────────────────────────────────────
describe('computer use from another Mac over the real mailbox',()=>{
  test('a terminal row in the same poll is answered while Control hangs, and nothing decrypted reaches the database in plaintext',async()=>{
    const db=new PGlite();
    try{
      await db.exec("create role anon; create role authenticated; create role service_role;create schema auth;create function auth.role() returns text language sql stable as $$ select current_setting('request.jwt.claim.role',true) $$;set request.jwt.claim.role='service_role';");
      await db.exec(AGENT_DIALOGUE_SQL);
      const profileId=randomUUID();
      const written:Record<string,unknown>[]=[];
      const makeHost=(deviceId:string)=>{
        const appDataDir=mkdtempSync(join(tmpdir(),'computer-use-remote-host-'));temporary.push(appDataDir);
        return new AgentDialogueHost({appDataDir,identity:()=>({profileId,deviceId}),secret:async()=>deviceId.replaceAll('-','').padEnd(44,'x'),
          resolveTarget:async(target:AgentDialogueTarget)=>'target' in target?{kind:'ops',displayName:`${deviceId.slice(0,4)} / 아젠투지(OPS)`}
            :{kind:'project',portId:target.portId,displayName:`${deviceId.slice(0,4)} ${target.portId}`,memoryId:'qq'},
          rpc:async(operation,p,d,secret,args)=>{
            if(operation==='control-respond')written.push(structuredClone(args.response as Record<string,unknown>));
            const {rows}=await db.query<{value:Record<string,any>}>('select public.portmgr_agent_dialogue_call($1,$2,$3,$4,$5::jsonb) as value',
              [operation,p,d,secret,JSON.stringify(args)]);
            return rows[0]!.value;
          }});
      };
      const aId=randomUUID(),bId=randomUUID();
      const one=makeHost(aId),three=makeHost(bId);
      const ops:AgentDialogueTarget={target:'ops'};
      for(const host of [one,three]){await host.enable(ops,true);await host.uiCommunity(ops,'join');}
      const target=(await one.controlDevices()).devices.find(device=>device.deviceId===bId)!.endpointId;
      // B: the community executor with this host behind its computer-use branch.
      const t=setup();
      t.clock.now=Date.now();
      const host=new ComputerUseRemoteHost({runtime:t.runtime,respond:(controlId,response)=>three.controlRespond(controlId,response),
        selfDeviceId:()=>bId,bundled:true,platform:'darwin',now:()=>t.clock.now});
      hosts.push(host);t.host=host;(t as {self:string}).self=bId;
      const terminal:Record<string,unknown>[]=[];
      const execute=createCommunityControlExecutor({terminal:async body=>{terminal.push(body);return {sessions:[]};},workspace:async()=>({}),
        projects:async()=>({projects:[],opsTargetId:null,deviceName:'3호'}),computerUse:(request,from,controlId)=>host.execute(request,from,controlId)});
      const poll=()=>three.controlPoll(execute,{detach:communityControlDetachable});
      // A: rows through the mailbox, one written before the next is started (so seqs reach B in order).
      let sent=0;
      const a=new Sender(t,aId);
      a.transport=async request=>{
        const response=await one.controlCall(target,request,8_000,{onSent:()=>{sent+=1;}});
        return {...response,detached:false,controlId:''} as Answer;
      };
      const written$=async(count:number)=>waitFor(()=>sent>=count,`row ${count} to be written`);
      const hello=a.hello();await written$(1);
      expect(await poll()).toEqual({handled:1});
      expect((await hello).ok).toBe(true);
      // Control is busy with the click; a terminal row, a call outside the closed list and a refused read wait behind it.
      const release=t.runtime.hold('scope-click');
      t.runtime.answer=body=>{
        if(body.operation==='scope-observe')throw new Error('컴퓨터 제어 요청이 올바르지 않습니다(observe: 넣지 않는 항목 SECRET_FIELD).');
        return defaultAnswer(body);
      };
      const clicked=a.call(click('req-mail-0001',777));await written$(2);
      const term=one.controlCall(target,{kind:'terminal',body:{operation:'list'}},8_000,{onSent:()=>{sent+=1;}});await written$(3);
      const outside=a.call({operation:'scope-type-secret',text:'SECRET_TEXT'});await written$(4);
      const observed=a.call({operation:'scope-observe',grant:GRANT,epoch:1,SECRET_FIELD:'SECRET_VALUE'});await written$(5);
      // One poll takes all four: the click is handed to the lane and the poll goes on.
      expect(await poll()).toEqual({handled:4});
      expect(await term).toEqual({ok:true,body:{result:{sessions:[]}}});
      expect(terminal).toEqual([{operation:'list'}]);
      expect(t.runtime.count('scope-click')).toBe(1);
      expect(t.runtime.calls.find(call=>call.body.operation==='scope-click')!.done).toBe(false);
      expect((await outside).content).toMatchObject({kind:'error',outcome:'not-run',code:'REMOTE_BAD_REQUEST'});
      release();
      expect((await clicked).content).toEqual({kind:'result',result:{success:true,receipt:{requestId:'req-mail-0001',state:'confirmed'}}});
      expect((await observed).content).toMatchObject({kind:'error',outcome:'not-run'});
      expect((await observed).content.error).toContain('SECRET_FIELD');
      // What reached the database: sealed boxes, and only fixed sentences in plaintext.
      // The hello (its key and boot only), the terminal list, and the three calls — each one a box.
      expect(written).toHaveLength(5);
      expect(written.filter(response=>response.ok===true&&typeof plainBody(response).box==='string')).toHaveLength(3);
      expect(written.map(response=>Object.keys(plainBody(response)).sort().join(','))).toEqual(
        expect.arrayContaining(['bootId,pub,v','result','box,parts,v']));
      for(const response of written){
        if(response.ok===false)expect([...COMPUTER_USE_REMOTE_ENVELOPE_REFUSALS.map(sentence),COMMUNITY_CONTROL_EXECUTE_TIMEOUT_MESSAGE,COMPUTER_USE_REMOTE_HOST_SEAL_FAILED]).toContain(String(response.error));
      }
      const text=JSON.stringify(written);
      for(const word of ['SECRET','777','req-mail','scope-click','scope-observe','observationId'])expect(text).not.toContain(word);
    }finally{await db.close();}
  },30_000);
});
const plainBody=(response:Record<string,unknown>)=>(response.body&&typeof response.body==='object'?response.body:{}) as Record<string,unknown>;

// ── The real runtime ───────────────────────────────────────────────────────────────────────────────────────────────
/** A fake Control with the standing allowance on (as tests/computer-use-standing-allowance.test.ts): it signs at once. */
function realRuntime(clock:{now:number}){
  const pair=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),jwk=pair.publicKey.export({format:'jwk'});
  const point=Buffer.concat([Buffer.from([4]),Buffer.from(jwk.x!,'base64url'),Buffer.from(jwk.y!,'base64url')]);
  const owner={pid:912,start:'100001'},requests:any[]=[],answers=new Map<string,string>();
  const control={grant:null as string|null,opened:0};
  const signed=(r:any)=>{const payload={version:2 as const,approvalId:r.approvalId,scope:r.scope,permissions:[...COMPUTER_USE_SCOPE_PERMISSIONS],caller:r.caller,owner:r.owner,issuedAt:clock.now,expiresAt:r.expiresAt};
    return {...payload,signature:sign('sha256',computerScopeApprovalBytes(payload),pair.privateKey).toString('base64')};};
  const channel={available:true,dispose(){},retire(body:any){if(body.operation==='scope-revoke'&&body.grant===control.grant)control.grant=null;},async request(body:any):Promise<any>{
    if(body.operation==='status')return {success:true,protocolVersion:1,workerProtocol:2,backgroundOnly:true,accessibility:true,secureInput:false,operations:['capture','click']};
    if(body.operation==='scope-status')return {success:true,scopeProtocolVersion:2,operations:[...COMPUTER_USE_SCOPE_OPERATIONS,'scope-standing-off'],accessibility:true,screenRecording:true,secureInput:false,owner,
      standing:{scope:{kind:'desktop'},since:1_793_400_000_000}};
    if(body.operation==='scope-revoke'){if(body.grant===control.grant)control.grant=null;return {success:true,revoked:true};}
    if(body.operation==='scope-revoke-session'){control.grant=null;return {success:true,revoked:true};}
    if(body.operation==='scope-request-approval'){requests.push({...body,owner});answers.set(body.approvalId,control.grant===null?'approved':'pending');return {success:true,state:answers.get(body.approvalId)};}
    if(body.operation==='scope-approval-status'){const state=answers.get(body.approvalId)??'unknown',r=requests.find(item=>item.approvalId===body.approvalId);
      return state==='approved'?{success:true,state,approval:signed(r),helperPublicKey:point.toString('base64')}:{success:true,state};}
    if(body.operation==='scope-open-grant'){if(control.grant!==null)return {success:false,notDispatched:true,code:'scope-conflict'};
      answers.set(body.approvalId,'consumed');control.grant=(++control.opened).toString(16).padStart(32,'0');
      return {success:true,bound:true,grant:control.grant,expiresAt:clock.now+COMPUTER_USE_SCOPE_LIMITS.grantMs,scopeProtocolVersion:2,operations:[...COMPUTER_USE_SCOPE_OPERATIONS],scope:body.scope,permissions:[...COMPUTER_USE_SCOPE_PERMISSIONS]};}
    return {success:true};
  }};
  const recovery=new ComputerUseRecovery(':memory:');
  const runtime=new ComputerUseRuntime(channel,recovery,{now:()=>clock.now,callerHost:async()=>({state:'known',bundleIds:['com.stablyai.orca']}),
    acceptRemote:true,remoteSettings:computerUseRemoteSettingsMemory(),remoteHumanInput:async()=>null,sleep:async ms=>{clock.now+=ms;}});
  return {runtime,requests,close(){runtime.dispose();recovery.close();}};
}

describe('computer use from another Mac with the real runtime',()=>{
  test('runtime admission rechecks the signed-main proof and closes on errors',async()=>{
    let proof=true;let failure=false;
    const recovery=new ComputerUseRecovery(':memory:');
    const runtime=new ComputerUseRuntime({available:false,request:async()=>({success:false}),dispose(){}},recovery,{
      acceptRemote:()=>{if(failure)throw Error('peer check failed');return proof;},remoteSettings:computerUseRemoteSettingsMemory()});
    const peer={deviceId:randomUUID(),instance:newComputerUseRemoteId()};
    try {
      expect(await runtime.remoteAdmission(peer)).toBeNull();
      proof=false;expect(await runtime.remoteAdmission(peer)).toBe('REMOTE_UNSUPPORTED');
      proof=true;failure=true;expect(await runtime.remoteAdmission(peer)).toBe('REMOTE_UNSUPPORTED');
      failure=false;expect(await runtime.remoteAdmission(peer)).toBeNull();
    } finally {runtime.dispose();recovery.close();}
  });

  test('request-access under the standing allowance opens a grant labelled from the first call box; the notices follow it',async()=>{
    const clock={now:START};
    const real=realRuntime(clock);
    try{
      const t=setup({runtime:real.runtime});
      t.clock.now=clock.now;
      const sync=()=>{clock.now=t.clock.now;};
      const a=new Sender(t);
      await a.hello();
      sync();
      const status=await a.call({operation:'scope-status',client:'codex-mcp-client',host:'Codex'});
      expect(status.content.result).toMatchObject({success:true,remote:{allowRemote:true,standing:true,appScope:false},connection:{scope:'remote-connection'}});
      const access=await a.call({operation:'scope-request-access'});
      expect(access.content.result.state).toBe('granted');
      expect(real.requests).toHaveLength(1);
      expect(real.requests[0].label).toMatch(new RegExp(`^원격 1호 \\(${a.deviceId.slice(0,4)}\\) / 연결 [0-9a-f]{8} / codex-mcp-client·Codex · 전체 Mac$`));
      expect(real.runtime.remoteGrants()).toHaveLength(1);
      await waitFor(()=>t.notices.length===1,'the start notice');
      expect(t.notices[0]!.text).toStartWith('1호의 AI가 이 Mac(3호)의 컴퓨터 유즈를 시작했습니다 · 전체 Mac.');
      // The AI ends its connection: the grant ends with it, and five minutes later the end notice.
      await a.call({},{op:'disconnect'});
      expect(real.runtime.remoteGrants()).toHaveLength(0);
      await t.host.tick();
      t.clock.now+=COMPUTER_USE_REMOTE_LIMITS.noticeGroupMs;sync();
      await t.host.tick();
      expect(t.notices).toHaveLength(2);
      expect(t.notices[1]!.text).toStartWith('1호의 AI가 이 Mac(3호)에서 쓰던 컴퓨터 유즈가 끝났습니다(');
      // Blocked from the panel: the next hello is refused with the fixed sentence.
      await real.runtime.manage({operation:'scope-remote-set',block:{deviceId:a.deviceId,connection:a.tag}});
      expect(await a.hello()).toMatchObject({ok:false,error:sentence('REMOTE_DEVICE_BLOCKED')});
      await real.runtime.manage({operation:'scope-remote-set',allowRemote:false});
      expect(await new Sender(t).hello()).toMatchObject({ok:false,error:sentence('REMOTE_BLOCKED_BY_PERSON')});
    }finally{real.close();}
  });
});
