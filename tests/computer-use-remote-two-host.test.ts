/**
 * WP6: computer use between two community Macs end to end, each side wired the way api-server wires it
 * (src/computerUseRemoteSidecar.ts):
 *   A's MCP connection (src/computerUseMcp.ts) → A's loopback route → A's client → the mailbox (the real AGENT_DIALOGUE_SQL
 *   in PGlite) → B's poll → B's community executor → B's receiving host → B's real ComputerUseRuntime → a fake Control.
 * Identities are injected (no Supabase, no keychain, no portal file). Nothing reaches the network, this Mac's sidecar, its
 * Control or its desktop: the loopback route is called in process with a Request object for a `.test` host.
 */
import {PGlite} from '@electric-sql/pglite';
import {afterEach,describe,expect,test} from 'bun:test';
import {generateKeyPairSync,randomBytes,randomUUID,sign} from 'node:crypto';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AGENT_DIALOGUE_SQL} from '../src/agentDialogueSql';
import {AgentDialogueHost,AgentDialogueHostError,type AgentDialogueControlExecutor} from '../src/agentDialogueHost';
import type {AgentDialogueTarget} from '../src/agentDialogueContract';
import {createCommunityControlExecutor} from '../src/agentDialogueControl';
import {communityDeviceRef} from '../src/communityDeviceRef';
import {communityControlRouteFailure} from '../src/opsRequestDispatch';
import {COMMUNITY_CONTROL_EXECUTE_TIMEOUT_MESSAGE,COMMUNITY_CONTROL_RESPONSE_TOO_LARGE_MESSAGE,OPS_REQUEST_LEGACY_UNSUPPORTED_MESSAGE} from '../src/opsRequestProtocol';
import {COMPUTER_USE_CLIENT_HEADER,COMPUTER_USE_INSTANCE_HEADER} from '../src/computerUseConnectionProtocol';
import {COMPUTER_USE_REMOTE_AGENT_PATH} from '../src/computerUseRemoteClient';
import {ComputerUseMcpConnection,computerUseMcpResult} from '../src/computerUseMcp';
import {
  COMMUNITY_CONTROL_POLL_BUSY_MESSAGE,
  COMPUTER_USE_REMOTE_ENVELOPE_REFUSALS,
  COMPUTER_USE_REMOTE_LIMITS,
  computerUseRemoteEnvelopeRefusal,
  parseComputerUseRemoteEnvelope,
} from '../src/computerUseRemoteProtocol';
import {COMPUTER_USE_REMOTE_HOST_SEAL_FAILED} from '../src/computerUseRemoteHost';
import {
  COMMUNITY_CONTROL_COMPUTER_USE_REFUSAL,
  computerUseRemoteCallerHosts,
  computerUseRemoteHostLabel,
  computerUseRemoteReceives,
  computerUseRemotePanelLink,
  createComputerUseRemoteSidecar,
  refuseCommunityControlComputerUse,
  type ComputerUseRemoteSidecar,
  type ComputerUseRemoteSidecarRuntime,
} from '../src/computerUseRemoteSidecar';
import {ComputerUseRuntime,computerUseRemoteSettingsMemory} from '../src/computerUseRuntime';
import {ComputerUseRecovery} from '../src/computerUseRecovery';
import {computerScopeApprovalBytes} from '../src/computerUseScopeApproval';
import {COMPUTER_USE_SCOPE_LIMITS,COMPUTER_USE_SCOPE_OPERATIONS,COMPUTER_USE_SCOPE_PERMISSIONS} from '../src/computerUseScopeProtocol';

const OPS:AgentDialogueTarget={target:'ops'};
const PROJECT:AgentDialogueTarget={portId:'project-a'};
const INSTANCE_1='1a'.repeat(32),INSTANCE_2='2b'.repeat(32);
/** Shorter mailbox waits than production (20 s a call), long enough for PGlite under a loaded test run. */
const CLIENT_LIMITS={helloTimeoutMs:4_000,callTimeoutMs:2_500,partTimeoutMs:2_000,routeBudgetMs:12_000};
/** Coordinates and text that cannot appear inside base64 by chance ('.', '-', '_' and Hangul are not in its alphabet). */
const X=3217.0625,Y=1789.03125,TYPED='비밀-입력-SECRET_TYPED_TEXT';

async function waitFor(check:()=>boolean,label:string,ms=10_000){
  const until=Date.now()+ms;
  while(!check()){if(Date.now()>until)throw new Error(`timed out waiting for ${label}`);await Bun.sleep(5);}
}

// ── The screen B's Control reports: the largest observation and capture ScopeHost accepts ─────────────────────────
const APPS=Array.from({length:100},(_,i)=>{
  const tag=String(i).padStart(3,'0');
  return {id:`app-${tag}-`.padEnd(200,'i'),name:`앱${tag}`.padEnd(200,'가'),bundleId:`com.example.worst${tag}.`.padEnd(200,'b')};
});
const DISPLAYS=Array.from({length:16},(_,i)=>({id:`display-${String(i).padStart(2,'0')}-`.padEnd(200,'d'),originX:i*5120,originY:0,width:5120,height:2880,scale:2,rotation:0}));
const MAIN=DISPLAYS[0]!;
const FOREGROUND={applicationId:APPS[7]!.id,bundleId:APPS[7]!.bundleId,pid:4242,processStart:'1700000000'};
/** 240,000 bytes: exactly 320,000 base64 characters, the most a capture may carry. */
const JPEG=(()=>{const bytes=randomBytes(COMPUTER_USE_REMOTE_LIMITS.attachmentMaxBytes);bytes.set([0xff,0xd8,0xff,0xe0]);return bytes.toString('base64');})();
const INPUTS=new Set(['scope-click','scope-type-text','scope-key','scope-scroll','scope-drag','scope-focus-app']);

/** B's Control (the signed native helper) with its person's standing allowance on: it signs a whole-Mac request at once. */
class FakeControl {
  grant:string|null=null;
  readonly approvals:Record<string,any>[]=[];
  readonly inputs:{operation:string;requestId:string;sessionId:string;done:boolean;body:Record<string,any>}[]=[];
  private opened=0;private snapshots=0;
  private readonly answers=new Map<string,string>();
  private readonly holds=new Map<string,Promise<void>[]>();
  private readonly key=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
  private readonly point:string;
  private readonly owner={pid:912,start:'100001'};
  readonly channel:{available:boolean;dispose():void;retire(body:any):void;request(body:any):Promise<any>};
  constructor(){
    const jwk=this.key.publicKey.export({format:'jwk'});
    this.point=Buffer.concat([Buffer.from([4]),Buffer.from(jwk.x!,'base64url'),Buffer.from(jwk.y!,'base64url')]).toString('base64');
    this.channel={available:true,dispose(){},retire:body=>this.retire(body),request:body=>this.request(body)};
  }
  /** The next input of this operation waits until the returned function is called (a Control that is stuck). */
  hold(operation:string){
    let release!:()=>void;
    const gate=new Promise<void>(resolve=>{release=resolve;});
    this.holds.set(operation,[...this.holds.get(operation)??[],gate]);
    return release;
  }
  count(operation:string){return this.inputs.filter(input=>input.operation===operation).length;}
  private retire(body:any){if(body?.operation==='scope-revoke-session'||body?.operation==='scope-revoke'&&body.grant===this.grant)this.grant=null;}
  private signed(r:any){
    const payload={version:2 as const,approvalId:r.approvalId,scope:r.scope,permissions:[...COMPUTER_USE_SCOPE_PERMISSIONS],caller:r.caller,owner:r.owner,issuedAt:Date.now(),expiresAt:r.expiresAt};
    return {...payload,signature:sign('sha256',computerScopeApprovalBytes(payload),this.key.privateKey).toString('base64')};
  }
  private async request(body:any):Promise<any>{
    switch(body.operation){
      case 'status':return {success:true,protocolVersion:1,workerProtocol:2,backgroundOnly:true,accessibility:true,secureInput:false,operations:['capture','click']};
      case 'scope-status':return {success:true,scopeProtocolVersion:2,operations:[...COMPUTER_USE_SCOPE_OPERATIONS,'scope-standing-off'],accessibility:true,screenRecording:true,
        secureInput:false,owner:this.owner,standing:{scope:{kind:'desktop'},since:1_793_400_000_000}};
      case 'scope-revoke':case 'scope-revoke-session':this.retire(body);return {success:true,revoked:true};
      case 'scope-request-approval':
        this.approvals.push({...body,owner:this.owner});
        this.answers.set(body.approvalId,this.grant===null?'approved':'pending');
        return {success:true,state:this.answers.get(body.approvalId)};
      case 'scope-approval-status':{
        const state=this.answers.get(body.approvalId)??'unknown',r=this.approvals.find(item=>item.approvalId===body.approvalId);
        return state==='approved'?{success:true,state,approval:this.signed(r),helperPublicKey:this.point}:{success:true,state};
      }
      case 'scope-open-grant':
        if(this.grant!==null)return {success:false,notDispatched:true,code:'scope-conflict'};
        this.answers.set(body.approvalId,'consumed');this.grant=(++this.opened).toString(16).padStart(32,'0');
        return {success:true,bound:true,grant:this.grant,expiresAt:Date.now()+COMPUTER_USE_SCOPE_LIMITS.grantMs,scopeProtocolVersion:2,
          operations:[...COMPUTER_USE_SCOPE_OPERATIONS],scope:body.scope,permissions:[...COMPUTER_USE_SCOPE_PERMISSIONS]};
      case 'scope-observe':
        return {success:true,snapshotId:`snap-${++this.snapshots}`,scope:{kind:'desktop'},applications:APPS,displays:DISPLAYS,foreground:FOREGROUND};
      case 'scope-capture':{
        const display=DISPLAYS.find(item=>item.id===body.displayId)!;
        return {success:true,displayId:display.id,mediaType:'image/jpeg',data:JPEG,width:1280,height:1280,
          displayWidth:display.width,displayHeight:display.height,originX:display.originX,originY:display.originY};
      }
    }
    if(INPUTS.has(body.operation)){
      const input={operation:String(body.operation),requestId:String(body.requestId),sessionId:String(body.caller?.sessionId),done:false,body:structuredClone(body)};
      this.inputs.push(input);
      const gate=this.holds.get(body.operation)?.shift();
      try{if(gate)await gate;return {success:true,receipt:{requestId:body.requestId,state:'confirmed'}};}finally{input.done=true;}
    }
    return {success:true};
  }
}

// ── What the mailbox wrote ───────────────────────────────────────────────────────────────────────────────────────
interface Written {
  requests:{controlId:string|null;deviceId:string;source:string;request:Record<string,any>}[];
  responses:{controlId:string;deviceId:string;response:Record<string,any>}[];
  posts:{deviceId:string;kind:unknown;text:string}[];
  /** Answers collected (control-result): through which of the sender's endpoints, for which rows. */
  reads:{deviceId:string;source:string;controlIds:string[]}[];
}
const temporary:string[]=[];
const open:{close():Promise<void>}[]=[];
afterEach(async()=>{
  for(const item of open.splice(0).reverse())await item.close().catch(()=>undefined);
  for(const path of temporary.splice(0))rmSync(path,{recursive:true,force:true});
});

/** The receiving Mac's sidecar: its executor and poll exactly as api-server builds them, around the real runtime. */
class ReceivingMac {
  /** The Control app outlives the sidecar's restarts. */
  readonly control=new FakeControl();
  readonly terminal:Record<string,unknown>[]=[];
  sidecar!:ComputerUseRemoteSidecar;
  runtime:ComputerUseRuntime|null=null;
  runtimesCreated=0;
  /** An AgentsToZ from before this feature: its executor knows no computer-use kind. */
  legacy=false;
  private recovery!:ComputerUseRecovery;
  private execute!:AgentDialogueControlExecutor;
  private paused=false;private polling=true;private inFlight:Promise<unknown>=Promise.resolve();
  private readonly loop:Promise<void>;
  constructor(readonly dialogue:AgentDialogueHost,readonly deviceId:string,readonly name:string,private facts:{bundled:boolean;platform:string}){
    this.boot();
    this.loop=this.run();
  }
  /** A sidecar start: a new receiving host (a new bootId) over a new runtime, as api-server's module evaluation makes them. */
  private boot(){
    this.recovery=new ComputerUseRecovery(':memory:');
    this.runtime=null;
    const recovery=this.recovery,facts=this.facts;
    const create=()=>this.runtime??=(this.runtimesCreated+=1,new ComputerUseRuntime(this.control.channel,recovery,{
      callerHost:async()=>({state:'unknown',reason:'not-a-local-connection'}),
      acceptRemote:computerUseRemoteReceives({...facts,verifiedMain:true,executablePath:'/Applications/AgentsToZ_byCS.app/Contents/Resources/resources/agentstoz-api-sidecar'}),remoteSettings:computerUseRemoteSettingsMemory(),remoteHumanInput:async()=>null,sleep:async()=>{}}));
    this.sidecar=createComputerUseRemoteSidecar({dialogue:this.dialogue,runtime:create,existingRuntime:()=>this.runtime,
      selfDeviceId:()=>this.deviceId,deviceName:()=>this.name,bundled:facts.bundled,platform:facts.platform});
    this.execute=createCommunityControlExecutor({
      terminal:async body=>{
        this.terminal.push(body);
        // A terminal read larger than the mailbox takes: the table's own 262,144-byte check refuses its answer.
        return body.operation==='read'?{text:'x'.repeat(300_000)}:{sessions:[]};
      },
      workspace:async()=>({}),
      projects:async()=>({projects:[],opsTargetId:null,deviceName:this.name}),
      computerUse:this.sidecar.computerUse,
    });
  }
  private async run(){
    while(this.polling){
      if(!this.paused){
        // api-server: controlPoll((request,from,controlId)=>executeCommunityControl(request,from,controlId),computerUseRemote.pollOptions)
        const poll=this.dialogue.controlPoll((request,from,controlId)=>this.legacy
          ?(request.kind==='terminal'?this.execute(request,from,controlId):Promise.reject(new Error(OPS_REQUEST_LEGACY_UNSUPPORTED_MESSAGE)))
          :this.execute(request,from,controlId),this.sidecar.pollOptions).catch(()=>({handled:0}));
        this.inFlight=poll;
        await poll;
      }
      await Bun.sleep(15);
    }
  }
  /** B stops taking rows (it is busy, asleep or its network is gone). */
  async pause(){this.paused=true;await this.inFlight;}
  resume(){this.paused=false;}
  async restart(facts=this.facts){
    await this.pause();
    await this.sidecar.dispose();this.runtime?.dispose();this.recovery.close();
    this.facts=facts;this.boot();
    this.resume();
  }
  async close(){
    this.polling=false;await this.loop;
    await this.sidecar.dispose();this.runtime?.dispose();this.recovery.close();
  }
}

/** The sending Mac's sidecar and its loopback route, called as api-server calls it. */
class SendingMac {
  readonly sidecar:ComputerUseRemoteSidecar;
  /** RC-13: the calling AI is a Workroom working on another device's OPS task (api-server reads it from the caller hint). */
  opsWorker=false;
  /** RC-13: an AI of another Mac holds a grant on this one (this Mac's runtime, if it exists). */
  incoming:ComputerUseRemoteSidecarRuntime|null=null;
  hostReads=0;
  private readonly callerHost=computerUseRemoteCallerHosts(async()=>{this.hostReads+=1;return {state:'known',bundleIds:['com.apple.Terminal']};});
  constructor(readonly dialogue:AgentDialogueHost,readonly deviceId:string){
    this.sidecar=createComputerUseRemoteSidecar({dialogue,
      runtime:()=>{throw new Error('A is not used by another Mac in this test');},existingRuntime:()=>this.incoming,
      selfDeviceId:()=>deviceId,deviceName:()=>'1호',bundled:true,platform:'darwin',client:{limits:CLIENT_LIMITS}});
  }
  route(request:Request){
    return this.sidecar.route(request,{authorized:true,opsWorker:async()=>this.opsWorker,
      host:()=>this.callerHost(request.headers.get(COMPUTER_USE_INSTANCE_HEADER),null)});
  }
  /** One MCP process of this Mac (its 64-hex instance), driving the route like agentstoz-use-mcp-server does. */
  mcp(instance:string){
    const remote=async(body:Record<string,unknown>)=>{
      const response=await this.route(new Request(`http://agentstoz.test${COMPUTER_USE_REMOTE_AGENT_PATH}`,{method:'POST',
        headers:{'content-type':'application/json',[COMPUTER_USE_INSTANCE_HEADER]:instance,[COMPUTER_USE_CLIENT_HEADER]:'claude-code'},body:JSON.stringify(body)}));
      return {status:response.status,body:await response.json().catch(()=>null)};
    };
    const connection=new ComputerUseMcpConnection(async()=>{throw new Error('this Mac is not driven in this test');},remote);
    open.push({close:()=>connection.close()});
    return {session:(value:Record<string,unknown>)=>connection.session(value) as Promise<Record<string,any>>,openOutcomes:()=>connection.openOutcomes()};
  }
}

async function community(options:{receiver?:{bundled:boolean;platform:string}}={}){
  const db=new PGlite();
  await db.exec("create role anon; create role authenticated; create role service_role;create schema auth;create function auth.role() returns text language sql stable as $$ select current_setting('request.jwt.claim.role',true) $$;set request.jwt.claim.role='service_role';");
  await db.exec(AGENT_DIALOGUE_SQL);
  const profileId=randomUUID();
  const written:Written={requests:[],responses:[],posts:[],reads:[]};
  /** A's mailbox clock runs ahead by this much (its device-list cache is 5 s); the database keeps its own time. */
  const skew={a:0};
  const dialogue=(deviceId:string,name:string,now?:()=>number)=>{
    const appDataDir=mkdtempSync(join(tmpdir(),'computer-use-remote-two-host-'));temporary.push(appDataDir);
    return new AgentDialogueHost({appDataDir,identity:()=>({profileId,deviceId}),secret:async()=>deviceId.replaceAll('-','').padEnd(44,'x'),...(now?{now}:{}),
      resolveTarget:async(target:AgentDialogueTarget)=>'target' in target?{kind:'ops',displayName:`${name} / 아젠투지(OPS)`}
        :{kind:'project',portId:target.portId,displayName:`${name} ${target.portId}`,memoryId:'qq'},
      rpc:async(operation,p,d,secret,args)=>{
        // Everything written is kept as it was handed to the database, whether the database took it or not.
        const sent=operation==='control-send'?{controlId:null as string|null,deviceId:d,source:String(args.sourceEndpointId),request:structuredClone(args.request as Record<string,any>)}:null;
        if(sent)written.requests.push(sent);
        if(operation==='control-respond')written.responses.push({controlId:String(args.controlId),deviceId:d,response:structuredClone(args.response as Record<string,any>)});
        if(operation==='send')written.posts.push({deviceId:d,kind:args.kind,text:String(args.text)});
        if(operation==='control-result')written.reads.push({deviceId:d,source:String(args.sourceEndpointId),controlIds:[...args.controlIds as string[]]});
        const {rows}=await db.query<{value:Record<string,any>}>('select public.portmgr_agent_dialogue_call($1,$2,$3,$4,$5::jsonb) as value',
          [operation,p,d,secret,JSON.stringify(args)]);
        const value=rows[0]!.value;
        if(sent&&typeof value.controlId==='string')sent.controlId=value.controlId;
        return value;
      }});
  };
  const aId=randomUUID(),bId=randomUUID(),cId=randomUUID();
  const aDialogue=dialogue(aId,'1호',()=>Date.now()+skew.a),bDialogue=dialogue(bId,'3호'),cDialogue=dialogue(cId,'2호');
  const aOps=await aDialogue.enable(OPS,true),aProject=await aDialogue.enable(PROJECT,true);
  const bOps=await bDialogue.enable(OPS,true);await cDialogue.enable(OPS,true);
  await aDialogue.uiCommunity(PROJECT,'join');await aDialogue.uiCommunity(OPS,'join');
  await bDialogue.uiCommunity(OPS,'join');await cDialogue.uiCommunity(OPS,'join');
  const b=new ReceivingMac(bDialogue,bId,'3호',options.receiver??{bundled:true,platform:'darwin'});
  const a=new SendingMac(aDialogue,aId);
  const harness={db,written,skew,a,b,c:cDialogue,aId,bId,cId,aOps:aOps.endpointId,aProject:aProject.endpointId,bOps:bOps.endpointId,
    /** Rows of kind computer-use and the answers to them, as the database received them. */
    computerUse(){
      const ids=new Set(written.requests.filter(row=>row.request.kind==='computer-use'&&row.controlId).map(row=>row.controlId));
      return {requests:written.requests.filter(row=>row.request.kind==='computer-use'),responses:written.responses.filter(row=>ids.has(row.controlId))};
    },
    hellos(){return written.requests.filter(row=>row.request.kind==='computer-use'&&row.request.op==='hello');},
    /** Pending rows older than the inbox's 30 s window: B never takes them (it was away that long). */
    async expirePending(){await db.query("update public.portmgr_agent_dialogue_controls set created_at=created_at-interval '31 seconds' where state='pending'");},
    async close(){await b.close();a.sidecar.client.dispose();await db.close();},
  };
  open.push(harness);
  return harness;
}
type Community=Awaited<ReturnType<typeof community>>;

/** One grant on B for this MCP connection: status → request-access → status. */
async function granted(h:Community,ai:ReturnType<SendingMac['mcp']>){
  const device=h.bId;
  expect(await ai.session({operation:'status',device})).toMatchObject({success:true,device,grants:[],remote:{allowRemote:true,standing:true,appScope:false}});
  expect(await ai.session({operation:'request-access',device})).toMatchObject({success:true,device,state:'granted'});
  const status=await ai.session({operation:'status',device});
  expect(status.grants).toHaveLength(1);
  return {device,grant:String(status.grants[0].grant),epoch:Number(status.grants[0].epoch)};
}

/**
 * RC-5 and §8.1: the database sees sealed boxes and fixed sentences only. Every computer-use row parses as one closed
 * envelope; every answer is a box (or a hello's key and boot), or one of the fixed plaintext sentences.
 */
function expectSealed(h:Community,secrets:string[]){
  const {requests,responses}=h.computerUse();
  for(const row of requests)expect(()=>parseComputerUseRemoteEnvelope(row.request)).not.toThrow();
  const sentences=new Set<string>([...COMPUTER_USE_REMOTE_ENVELOPE_REFUSALS.map(code=>computerUseRemoteEnvelopeRefusal(code).error),
    COMMUNITY_CONTROL_EXECUTE_TIMEOUT_MESSAGE,COMPUTER_USE_REMOTE_HOST_SEAL_FAILED,COMMUNITY_CONTROL_POLL_BUSY_MESSAGE,
    COMMUNITY_CONTROL_RESPONSE_TOO_LARGE_MESSAGE,OPS_REQUEST_LEGACY_UNSUPPORTED_MESSAGE]);
  for(const {response} of responses){
    if(response.ok===true)expect(Object.keys(response.body).every(key=>['v','box','parts','ref','bootId','pub'].includes(key))).toBe(true);
    else expect(sentences.has(String(response.error))).toBe(true);
  }
  const text=JSON.stringify({requests,responses,posts:h.written.posts.map(post=>post.text)});
  expect(secrets.filter(secret=>text.includes(secret))).toEqual([]);
}
/** AI field names and operations: quoted or hyphenated, so a base64 box can never contain one by chance. */
const FIELD_NAMES=['"operation"','"grant"','"epoch"','"observationId"','"requestId"','"displayId"','"button"','"clickCount"','"text"','"x"','"y"',
  '"applications"','"displays"','"foreground"','"observation"','"image"','"receipt"','"client"','"host"',
  'scope-status','scope-request-access','scope-observe','scope-capture','scope-click','scope-type-text','scope-receipt'];

// ── 1. The whole path at the worst size ──────────────────────────────────────────────────────────────────────────
describe('computer use between two community Macs over the real mailbox',()=>{
  test('hello → status → request-access → observe+capture at the worst size → click → receipt; sealed rows; one community notice',async()=>{
    const h=await community();
    const ai=h.a.mcp(INSTANCE_1);
    const devices=await ai.session({operation:'devices'});
    expect(devices).toMatchObject({success:true,inside:true,deviceId:h.aId});
    expect(devices.devices).toEqual(expect.arrayContaining([expect.objectContaining({device:h.bId,endpointId:h.bOps,remote:'unchecked'})]));
    const {device,grant,epoch}=await granted(h,ai);
    // One hello, from A's community endpoint, answered with B's boot; the MCP keeps that boot with every answer.
    expect(h.hellos().map(row=>row.source)).toEqual([h.aOps]);
    expect((await ai.session({operation:'status',device})).bootId).toBe(h.b.sidecar.host.bootId);
    // Control was asked once, named as B labels a remote AI: device, its code, the connection, the MCP client and its host app.
    expect(h.b.control.approvals).toHaveLength(1);
    expect(h.b.control.approvals[0]!.label).toMatch(new RegExp(`^원격 1호 \\(${h.aId.slice(0,4)}\\) / 연결 [0-9a-f]{8} / claude-code·Terminal · 전체 Mac$`));
    expect(h.a.hostReads).toBe(1);
    expect(h.b.runtime!.remoteGrants()).toEqual([expect.objectContaining({deviceId:h.aId,deviceName:'1호'})]);

    // observe {capture:true}: 100 apps with 200-byte ids and bundle ids, 16 displays, and a 240,000-byte JPEG.
    const observed=await ai.session({operation:'observe',device,grant,epoch,capture:true});
    expect(observed).toMatchObject({success:true,device,epoch,observation:{scope:{kind:'desktop'},foreground:FOREGROUND},
      image:{mediaType:'image/jpeg',width:1280,height:1280,displayId:MAIN.id,displayWidth:5120,displayHeight:2880,originX:0,originY:0}});
    expect(observed.image.data).toBe(JPEG);
    expect(observed.observation.displays).toEqual(DISPLAYS);
    // Over 60 KB of names: the foreground app keeps its name cut to 80 characters, the others are left without one.
    const apps=observed.observation.applications as Record<string,unknown>[];
    expect(apps.map(app=>app.id)).toEqual(APPS.map(app=>app.id));
    expect(apps.filter(app=>'name' in app)).toEqual([{id:FOREGROUND.applicationId,name:Array.from(APPS[7]!.name).slice(0,80).join(''),bundleId:FOREGROUND.bundleId}]);
    // The AI gets the same bytes as an image block.
    expect(computerUseMcpResult(observed).content[1]).toEqual({type:'image',mimeType:'image/jpeg',data:JPEG});
    // It crossed the mailbox in two parts, each under the table's own octet_length(response::text) <= 262,144 check.
    const {requests,responses}=h.computerUse();
    expect(requests.filter(row=>row.request.op==='part')).toHaveLength(1);
    expect(responses.filter(row=>row.response.body?.parts===2)).toHaveLength(1);
    const sizes=await Promise.all(responses.map(async row=>Number((await h.db.query<{n:number}>('select octet_length($1::jsonb::text) as n',[JSON.stringify(row.response)])).rows[0]!.n)));
    expect(Math.max(...sizes)).toBeGreaterThan(200_000);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(COMPUTER_USE_REMOTE_LIMITS.mailboxResponseMaxBytes);
    // The same database refuses an answer over that check (a terminal read of 300,000 characters): the check is live here.
    expect(await h.c.controlCall(h.bOps,{kind:'terminal',body:{operation:'read',sessionId:'s1'}},8_000)).toEqual({ok:false,error:COMMUNITY_CONTROL_RESPONSE_TOO_LARGE_MESSAGE});

    // A left click at display points, its receipt in the answer.
    const click={operation:'click',device,grant,epoch,observationId:observed.observationId,displayId:MAIN.id,requestId:'req-wp6-click-0001',x:X,y:Y,button:'left',clickCount:1};
    expect(await ai.session(click)).toMatchObject({success:true,device,receipt:{requestId:'req-wp6-click-0001',state:'confirmed'}});
    expect(h.b.control.inputs).toHaveLength(1);
    expect(h.b.control.inputs[0]!.body).toMatchObject({operation:'scope-click',requestId:'req-wp6-click-0001',x:X,y:Y,button:'left',clickCount:1,displayId:MAIN.id});
    // Typing after a new observation.
    const again=await ai.session({operation:'observe',device,grant,epoch});
    expect(await ai.session({operation:'type-text',device,grant,epoch,observationId:again.observationId,requestId:'req-wp6-type-0001',text:TYPED}))
      .toMatchObject({success:true,device,receipt:{requestId:'req-wp6-type-0001',state:'confirmed'}});
    expect(h.b.control.inputs[1]!.body).toMatchObject({operation:'scope-type-text',text:TYPED});
    // The receipt: the click's own, from B's ledger; nothing ran twice.
    expect(await ai.session({operation:'receipt',device,grant,epoch,requestId:'req-wp6-click-0001'}))
      .toMatchObject({success:true,device,receipt:{requestId:'req-wp6-click-0001',state:'confirmed'}});
    expect(h.b.control.count('scope-click')).toBe(1);
    expect(ai.openOutcomes()).toEqual([]);

    // One content-free notice in the community room, posted by B.
    await waitFor(()=>h.written.posts.length>=1,'the community notice');
    await Bun.sleep(300);
    expect(h.written.posts).toHaveLength(1);
    expect(h.written.posts[0]).toMatchObject({deviceId:h.bId,kind:'observation'});
    expect(h.written.posts[0]!.text).toStartWith('1호의 AI가 이 Mac(3호)의 컴퓨터 유즈를 시작했습니다 · 전체 Mac.');

    expectSealed(h,[...FIELD_NAMES,String(X),String(Y),TYPED,'SECRET_TYPED_TEXT','req-wp6-',grant,JPEG.slice(4_000,4_064),JPEG.slice(-64),
      '앱007','가가가가','com.example.worst','display-00-','app-007-','claude-code','Terminal']);
  },60_000);

  // ── 2, 3, 5. Timeouts, late answers, an endpoint change, and a stuck Control ─────────────────────────────────────
  test('after a timeout the receipt settles: unseen in the same boot, or the actual receipt read through the endpoint that sent it; a stuck Control does not delay another device\'s terminal row',async()=>{
    const h=await community();
    const ai=h.a.mcp(INSTANCE_1);
    await ai.session({operation:'devices'});
    const {device,grant,epoch}=await granted(h,ai);
    const observe=async()=>String((await ai.session({operation:'observe',device,grant,epoch})).observationId);
    const type=(observationId:string,requestId:string)=>ai.session({operation:'type-text',device,grant,epoch,observationId,requestId,text:TYPED});
    const receipt=(requestId:string)=>ai.session({operation:'receipt',device,grant,epoch,requestId});

    // Unseen: B takes no row until this one is past the inbox's window; the receipt finds nothing in the same boot.
    let observationId=await observe();
    await h.b.pause();
    expect(await type(observationId,'req-wp6-unseen-01')).toMatchObject({success:false,code:'REMOTE_UNKNOWN_OUTCOME',outcome:'unknown',device,requestId:'req-wp6-unseen-01'});
    expect(ai.openOutcomes()).toEqual([expect.objectContaining({requestId:'req-wp6-unseen-01',device})]);
    // While it is open, the MCP sends no other input to that Mac.
    expect(await type(observationId,'req-wp6-unseen-02')).toMatchObject({success:false,code:'REMOTE_BLOCKED_BY_UNKNOWN'});
    await h.expirePending();
    h.b.resume();
    expect(await receipt('req-wp6-unseen-01')).toMatchObject({success:true,device,receipt:{requestId:'req-wp6-unseen-01',state:'not-run',reason:'unseen'}});
    expect(ai.openOutcomes()).toEqual([]);
    expect(h.b.control.count('scope-type-text')).toBe(0);
    // Settled as not run, the input was never sent again; a new one goes now.
    observationId=await observe();
    expect(await type(observationId,'req-wp6-typed-001')).toMatchObject({success:true,receipt:{state:'confirmed'}});
    expect(h.b.control.count('scope-type-text')).toBe(1);

    // A stuck Control: the input waits in B's lane, the poll goes on.
    observationId=await observe();
    const release=h.b.control.hold('scope-type-text');
    const stuck=type(observationId,'req-wp6-late-0001');
    await waitFor(()=>h.b.control.count('scope-type-text')===2,'the input to reach Control');
    const callsBefore=h.computerUse().requests.filter(row=>row.request.op==='call').length;
    // Another device's terminal row is answered at once.
    const started=Date.now();
    expect(await h.c.controlCall(h.bOps,{kind:'terminal',body:{operation:'list'}},8_000)).toEqual({ok:true,body:{result:{sessions:[]}}});
    // Answered while the input is still inside Control, well before A's own call wait ran out.
    expect(h.b.control.inputs.at(-1)!.done).toBe(false);
    expect(Date.now()-started).toBeLessThan(CLIENT_LIMITS.callTimeoutMs);
    expect(h.b.terminal).toEqual([{operation:'list'}]);
    // A's call deadline passes first: the outcome is open, and nothing is sent again.
    expect(await stuck).toMatchObject({success:false,code:'REMOTE_UNKNOWN_OUTCOME',outcome:'unknown',device,requestId:'req-wp6-late-0001'});
    // A's OPS endpoint leaves the community before the answer exists: A now sends from its project endpoint.
    await h.a.dialogue.uiCommunity(OPS,'leave');
    expect((await h.a.dialogue.controlSource())?.endpointId).toBe(h.aProject);
    const lateRow=h.computerUse().requests.filter(row=>row.request.op==='call').at(-1)!;
    expect(lateRow.source).toBe(h.aOps);
    release();
    await waitFor(()=>h.written.responses.some(row=>row.controlId===lateRow.controlId),'B to answer the late row');
    // The receipt is the actual one: the late answer, read through the OPS endpoint that sent the row; no row is sent for it.
    const rowsBefore=h.computerUse().requests.length;
    expect(await receipt('req-wp6-late-0001')).toMatchObject({success:true,device,receipt:{requestId:'req-wp6-late-0001',state:'confirmed'}});
    expect(h.computerUse().requests).toHaveLength(rowsBefore);
    expect(h.written.reads.some(read=>read.deviceId===h.aId&&read.source===h.aOps&&read.controlIds.includes(lateRow.controlId!))).toBe(true);
    expect(ai.openOutcomes()).toEqual([]);
    expect(h.b.control.count('scope-type-text')).toBe(2);
    expect(h.computerUse().requests.filter(row=>row.request.op==='call')).toHaveLength(callsBefore);
    // The next call says hello again from the project endpoint and works.
    expect(await ai.session({operation:'status',device})).toMatchObject({success:true,device,bootId:h.b.sidecar.host.bootId});
    expect(h.hellos().map(row=>row.source)).toEqual([h.aOps,h.aProject]);
    expectSealed(h,[...FIELD_NAMES,TYPED,'SECRET_TYPED_TEXT','req-wp6-',grant]);
  },60_000);

  // ── 3. Two MCP connections, one requestId ─────────────────────────────────────────────────────────────────────
  test('two MCP connections of one Mac use the same requestId on B without colliding: each runs once and each reads its own receipt',async()=>{
    const h=await community();
    const first=h.a.mcp(INSTANCE_1),second=h.a.mcp(INSTANCE_2);
    await first.session({operation:'devices'});await second.session({operation:'devices'});
    const one=await granted(h,first);
    const seen=await first.session({operation:'observe',device:one.device,grant:one.grant,epoch:one.epoch,capture:true});
    const capturedAt=Date.now();
    const click=(grant:string,epoch:number,observationId:string)=>({operation:'click',device:h.bId,grant,epoch,observationId,displayId:MAIN.id,
      requestId:'req-wp6-same-0001',x:X,y:Y,button:'left',clickCount:1});
    expect(await first.session(click(one.grant,one.epoch,seen.observationId))).toMatchObject({success:true,receipt:{requestId:'req-wp6-same-0001',state:'confirmed'}});
    // The first connection ends its sessions (what the MCP sends when it closes): B ends its grant.
    expect(await h.a.route(new Request(`http://agentstoz.test${COMPUTER_USE_REMOTE_AGENT_PATH}`,{method:'POST',
      headers:{'content-type':'application/json',[COMPUTER_USE_INSTANCE_HEADER]:INSTANCE_1},body:JSON.stringify({operation:'disconnect'})})).then(r=>r.json()))
      .toMatchObject({success:true,closed:1});
    await waitFor(()=>h.b.runtime!.remoteGrants().length===0&&h.b.control.grant===null,'B to end the first grant');
    // The second connection: its own grant, and the same requestId runs (B's ledger is per device and connection).
    const two=await granted(h,second);
    // This Mac captures one device at most every 2 s, whichever connection asks (§8.7).
    await Bun.sleep(Math.max(0,capturedAt+COMPUTER_USE_REMOTE_LIMITS.captureIntervalMs+100-Date.now()));
    const other=await second.session({operation:'observe',device:two.device,grant:two.grant,epoch:two.epoch,capture:true});
    expect(other).toMatchObject({success:true,image:{data:JPEG}});
    expect(await second.session(click(two.grant,two.epoch,other.observationId))).toMatchObject({success:true,receipt:{requestId:'req-wp6-same-0001',state:'confirmed'}});
    expect(h.b.control.inputs.map(input=>input.requestId)).toEqual(['req-wp6-same-0001','req-wp6-same-0001']);
    expect(new Set(h.b.control.inputs.map(input=>input.sessionId)).size).toBe(2);
    // Each connection's receipt is its own; the first one's is read again after its session ended (a new hello).
    expect(await second.session({operation:'receipt',device:h.bId,grant:two.grant,epoch:two.epoch,requestId:'req-wp6-same-0001'}))
      .toMatchObject({success:true,receipt:{requestId:'req-wp6-same-0001',state:'confirmed'}});
    expect(await first.session({operation:'receipt',device:h.bId,grant:one.grant,epoch:one.epoch,requestId:'req-wp6-same-0001'}))
      .toMatchObject({success:true,receipt:{requestId:'req-wp6-same-0001',state:'confirmed'}});
    expect(h.b.control.count('scope-click')).toBe(2);
    // Both connections' hellos name their own connection tag.
    expect(new Set(h.hellos().map(row=>row.request.instance)).size).toBe(2);
    // One device, one episode: still one notice.
    await waitFor(()=>h.written.posts.length>=1,'the community notice');
    expect(h.written.posts).toHaveLength(1);
    expectSealed(h,[...FIELD_NAMES,String(X),String(Y),'req-wp6-',one.grant,two.grant]);
  },60_000);

  // ── 4. B restarts, leaves, or is older ─────────────────────────────────────────────────────────────────────────
  test('B restarting makes an open input unknown-final; B leaving the community refuses the next request at once',async()=>{
    const h=await community();
    const ai=h.a.mcp(INSTANCE_1);
    await ai.session({operation:'devices'});
    const {device,grant,epoch}=await granted(h,ai);
    const observationId=String((await ai.session({operation:'observe',device,grant,epoch})).observationId);
    const bootBefore=h.b.sidecar.host.bootId;
    await h.b.pause();
    expect(await ai.session({operation:'type-text',device,grant,epoch,observationId,requestId:'req-wp6-boot-0001',text:TYPED}))
      .toMatchObject({success:false,code:'REMOTE_UNKNOWN_OUTCOME',outcome:'unknown'});
    await h.expirePending();
    await h.b.restart();
    expect(h.b.sidecar.host.bootId).not.toBe(bootBefore);
    // The first call meets the new boot: not run, and the next one works on a new session.
    expect(await ai.session({operation:'status',device})).toMatchObject({success:false,code:'REMOTE_SESSION_RESTARTED',outcome:'not-run',device});
    expect(await ai.session({operation:'status',device})).toMatchObject({success:true,device,bootId:h.b.sidecar.host.bootId,grants:[]});
    // `unseen` from another boot proves nothing: unknown-final, and the MCP stops waiting on it.
    expect(await ai.session({operation:'receipt',device,grant,epoch,requestId:'req-wp6-boot-0001'}))
      .toMatchObject({success:true,device,receipt:{requestId:'req-wp6-boot-0001',state:'unknown-final',reason:'boot-changed'}});
    expect(ai.openOutcomes()).toEqual([]);
    expect(h.b.control.count('scope-type-text')).toBe(0);

    // B leaves the community. A's device list still names it (read just now, kept 5 s): the database itself refuses the
    // next request at once, re-checking membership as it does for every row, and nothing waits.
    h.skew.a+=10_000;
    expect((await h.a.dialogue.controlDevices()).devices.some(row=>row.deviceId===h.bId)).toBe(true);
    await h.b.dialogue.uiCommunity(OPS,'leave');
    const rows=h.written.requests.length;
    const started=Date.now();
    expect(await ai.session({operation:'status',device})).toMatchObject({success:false,code:'REMOTE_NOT_IN_COMMUNITY',outcome:'not-run',device});
    expect(Date.now()-started).toBeLessThan(CLIENT_LIMITS.callTimeoutMs);
    expect(h.written.requests.slice(rows).every(row=>row.controlId===null)).toBe(true);
    // The directory no longer offers it.
    const devices=await ai.session({operation:'devices'});
    expect(devices.devices.some((row:{device:string})=>row.device===h.bId)).toBe(false);
    expectSealed(h,[...FIELD_NAMES,TYPED,'SECRET_TYPED_TEXT','req-wp6-',grant]);
  },60_000);

  test('an older B answers with its old sentence: REMOTE_HOST_OUTDATED; a B that is not the bundled macOS sidecar answers REMOTE_UNSUPPORTED and never makes its runtime',async()=>{
    const h=await community();
    const ai=h.a.mcp(INSTANCE_1);
    await ai.session({operation:'devices'});
    h.b.legacy=true;
    expect(await ai.session({operation:'status',device:h.bId})).toMatchObject({success:false,code:'REMOTE_HOST_OUTDATED',outcome:'not-run',device:h.bId});
    expect((await ai.session({operation:'devices'})).devices).toEqual(expect.arrayContaining([expect.objectContaining({device:h.bId,remote:'outdated'})]));
    h.b.legacy=false;
    // RC-12: receiving needs both facts; a development server (not bundled) and another platform say so, and nothing more.
    for(const facts of [{bundled:false,platform:'darwin'},{bundled:true,platform:'win32'}]){
      await h.b.restart(facts);
      expect(await ai.session({operation:'status',device:h.bId})).toMatchObject({success:false,code:'REMOTE_UNSUPPORTED',outcome:'not-run',device:h.bId});
    }
    expect(h.b.runtimesCreated).toBe(0);
    expect(h.b.control.approvals).toHaveLength(0);
    const installed={bundled:true,platform:'darwin',verifiedMain:true,executablePath:'/Applications/AgentsToZ_byCS.app/Contents/Resources/resources/agentstoz-api-sidecar'};
    expect(computerUseRemoteReceives(installed)).toBe(true);
    expect(computerUseRemoteReceives({...installed,verifiedMain:false})).toBe(false);
    expect(computerUseRemoteReceives({...installed,executablePath:'/tmp/agentstoz-api-sidecar'})).toBe(false);
    for(const facts of [{bundled:false,platform:'darwin'},{bundled:true,platform:'linux'},{bundled:true,platform:'win32'},{bundled:false,platform:'win32'}])
      expect(computerUseRemoteReceives({...installed,...facts})).toBe(false);
    expectSealed(h,[...FIELD_NAMES]);
  },60_000);

  // ── 8. The general call and phone forwarding ────────────────────────────────────────────────────────────────
  test('the general control call refuses the computer-use kind; phone forwarding and terminal rows are unchanged',async()=>{
    const h=await community();
    let refused:unknown;
    try{refuseCommunityControlComputerUse({kind:'computer-use',v:1,op:'hello'});}catch(error){refused=error;}
    expect(refused).toBeInstanceOf(AgentDialogueHostError);
    expect(communityControlRouteFailure(refused)).toEqual({status:400,body:{success:false,code:'AGENT_DIALOGUE_INPUT_INVALID',error:COMMUNITY_CONTROL_COMPUTER_USE_REFUSAL}});
    for(const request of [{kind:'terminal',body:{operation:'list'}},{kind:'projects'},{kind:'ops-request'}])
      expect(()=>refuseCommunityControlComputerUse(request)).not.toThrow();
    // A phone's terminal request forwarded through A reaches B's terminal as before; B's computer use is not involved.
    const answer=await h.a.dialogue.communityForward(communityDeviceRef(h.bOps),{kind:'terminal',body:{operation:'list'}},8_000);
    expect(answer).toEqual({ok:true,body:{result:{sessions:[]}}});
    expect(h.b.terminal).toEqual([{operation:'list'}]);
    expect(h.b.runtimesCreated).toBe(0);
    expect(h.computerUse().requests).toEqual([]);
  },60_000);
});

// ── The route's readings of its caller ──────────────────────────────────────────────────────────────────────────
describe('the sending route',()=>{
  test('an OPS worker and a Mac another Mac is using are refused before any row; the host label is read once per MCP instance',async()=>{
    const calls:string[]=[];
    const dialogue={
      controlDevices:async()=>{calls.push('devices');throw new Error('not reached');},
      controlSource:async()=>{calls.push('source');return null;},
      controlCall:async()=>{calls.push('call');throw new Error('not reached');},
      controlResult:async()=>{calls.push('result');throw new Error('not reached');},
      controlRespond:async()=>{calls.push('respond');return {responded:false};},
      communityNotice:async()=>{calls.push('notice');return {posted:false};},
    };
    let incoming=false;
    const runtime:ComputerUseRemoteSidecarRuntime={remote:async()=>({}),remoteAdmission:()=>null,remoteGrants:()=>[],hasIncomingRemoteGrant:()=>incoming};
    const sidecar=createComputerUseRemoteSidecar({dialogue,runtime:()=>runtime,existingRuntime:()=>runtime,selfDeviceId:()=>randomUUID(),bundled:true,platform:'darwin'});
    open.push({close:()=>sidecar.dispose()});
    const device=randomUUID();
    const ask=async(options:{opsWorker?:boolean})=>(await sidecar.route(new Request(`http://agentstoz.test${COMPUTER_USE_REMOTE_AGENT_PATH}`,{method:'POST',
      headers:{'content-type':'application/json',[COMPUTER_USE_INSTANCE_HEADER]:INSTANCE_1},body:JSON.stringify({device,operation:'scope-status'})}),
    {authorized:true,opsWorker:async()=>options.opsWorker===true})).json();
    expect(await ask({opsWorker:true})).toMatchObject({success:false,code:'REMOTE_CHAIN_DENIED',outcome:'not-run',device});
    incoming=true;
    expect(await ask({})).toMatchObject({success:false,code:'REMOTE_CHAIN_DENIED',outcome:'not-run',device});
    expect(calls).toEqual([]);
    // Unauthorized (no profile token, or an Origin): refused as the agent route refuses.
    expect((await sidecar.route(new Request(`http://agentstoz.test${COMPUTER_USE_REMOTE_AGENT_PATH}`,{method:'POST',headers:{'content-type':'application/json'},body:'{}'}),{authorized:false})).status).toBe(403);

    let reads=0;
    const hosts=computerUseRemoteCallerHosts(async()=>{reads+=1;return {state:'known',bundleIds:['com.stablyai.orca','com.apple.Terminal','com.vendor.Tool']};},2);
    expect(await hosts(INSTANCE_1,null)).toBe('Orca/Terminal/Tool');
    expect(await hosts(INSTANCE_1,{peerPort:5000})).toBe('Orca/Terminal/Tool');
    expect(reads).toBe(1);
    expect(await hosts('not-an-instance',null)).toBeNull();
    expect(await hosts(null,null)).toBeNull();
    expect(reads).toBe(1);
    await hosts(INSTANCE_2,null);await hosts('3c'.repeat(32),null);
    expect(reads).toBe(3);
    await hosts(INSTANCE_1,null);
    expect(reads).toBe(4);
    expect(computerUseRemoteHostLabel({state:'unknown',reason:'peer-missing'})).toBeNull();
    expect(computerUseRemoteHostLabel({state:'known',bundleIds:[]})).toBeNull();
    const failing=computerUseRemoteCallerHosts(async()=>{throw new Error('ps failed');});
    expect(await failing(INSTANCE_1,null)).toBeNull();
  });
});

// ── api-server wires exactly this ────────────────────────────────────────────────────────────────────────────────
describe('api-server wiring',()=>{
  const server=readFileSync(join(import.meta.dir,'..','api-server.ts'),'utf8');
  const sidecarSource=readFileSync(join(import.meta.dir,'..','src','computerUseRemoteSidecar.ts'),'utf8');
  const block=(start:string,end:string)=>{const from=server.indexOf(start);expect(from).toBeGreaterThan(-1);const to=server.indexOf(end,from+start.length);expect(to).toBeGreaterThan(from);return server.slice(from,to);};

  test('panel adapter reads live shared-profile state and delegates session actions',()=>{
    const closed:string[]=[];let profile:string|null=null;
    const client={usage:()=>({sessions:[{deviceId:'a',deviceName:'A',connection:'a',client:null,since:1,lastCallAt:2,active:true}]}),
      closeDevice:(deviceId:string)=>{closed.push(deviceId);return 1;}};
    const link=computerUseRemotePanelLink(client,{sharedProfileId:()=>profile});
    expect(link.profileReady()).toBe(false);profile='profile';expect(link.profileReady()).toBe(true);
    expect(link.usage().sessions[0]?.deviceName).toBe('A');expect(link.closeDevice('device')).toBe(1);expect(closed).toEqual(['device']);
  });

  test('receiving: bundled sidecar on macOS only, no environment switch; the executor, poll detach, notices and shutdown',()=>{
    expect(server).toContain("const IS_BUNDLED_API_SIDECAR = process.env.PORTMGR_BUNDLED_SIDECAR === '1';");
    expect(server).toContain("const COMPUTER_USE_REMOTE_RECEIVES=()=>computerUseRemoteReceives({bundled:IS_BUNDLED_API_SIDECAR,platform:process.platform,verifiedMain:inheritedComputerUseMainLink?.verifiedMain===true,executablePath:process.execPath});");
    expect(server).toContain("acceptRemote:COMPUTER_USE_REMOTE_RECEIVES,remoteSettings:computerUseRemoteSettingsFile(join(APP_DATA_DIR,'computer-use-remote.json'))");
    expect(server).toContain('remoteLink:()=>computerUseRemotePanelLink(computerUseRemote.client,controlProfileHost.store)');
    expect(server).not.toMatch(/process\.env\.[A-Z0-9_]*(COMPUTER_USE|REMOTE_COMPUTER|CU_REMOTE)/);
    expect(sidecarSource).not.toContain('process.env');
    const wiring=block('const computerUseRemote=createComputerUseRemoteSidecar({','});');
    for(const part of ['dialogue:agentDialogueHost','runtime:currentComputerUseRuntime','existingRuntime:()=>computerUseRuntime',
      'bundled:COMPUTER_USE_REMOTE_RECEIVES','platform:process.platform','readPortalJson(PORTAL_DATA_FILE).deviceId','RUNTIME_UUID_RE.test(deviceId)'])expect(wiring).toContain(part);
    // The same deviceId the mailbox identity uses (the inbox's to_device_id).
    expect(block('const agentDialogueHost = new AgentDialogueHost({','resolveTarget:')).toContain('deviceId:portal.deviceId');
    const executor=block('const executeCommunityControl=createCommunityControlExecutor({','\n});');
    expect(executor).toContain('computerUse:computerUseRemote.computerUse,');
    const poll=block('function scheduleCommunityControlPoll(','scheduleCommunityControlPoll(communityControlPollDelay(');
    expect(poll).toContain('agentDialogueHost.controlPoll((request,from,controlId)=>{');
    expect(poll).toContain('return executeCommunityControl(request,from,controlId);');
    expect(poll).toContain('},computerUseRemote.pollOptions);');
    const shutdown=block('function shutdownRemoteControlApi(','process.exit(exitCode);\n  })();');
    expect(shutdown).toContain('computerUseRemote.dispose(),');
  });

  test('sending: the remote route has the agent route\'s gate and feeds the OPS worker guard; the general call refuses computer use first',()=>{
    const route=block('if(url.pathname===COMPUTER_USE_REMOTE_AGENT_PATH)return computerUseRemote.route(req,{','});');
    expect(route).toContain('authorized:requestOrigin===null&&controlProfileHost.store.authorize(req.headers.get(CONTROL_PROFILE_HEADER)),');
    expect(server).toContain('if(url.pathname===COMPUTER_USE_AGENT_PATH)return handleComputerUse(req,currentComputerUseRuntime,{agent:true,authorized:requestOrigin===null&&controlProfileHost.store.authorize(req.headers.get(CONTROL_PROFILE_HEADER)),');
    expect(route).toContain('agentsToZUseCallerSession(parseWorkroomCallerHint(req.headers))?.id');
    expect(route).toContain('await opsRequestHost.workerSession(sessionId)');
    expect(route).toContain('computerUseRemoteCallerHost(req.headers.get(COMPUTER_USE_INSTANCE_HEADER),computerCallerOrigin(bunServer.requestIP(req)))');
    const call=block("if(url.pathname==='/api/agent-dialogue/control'&&req.method==='POST'){",'communityControlRouteFailure(error)');
    const refusal=call.indexOf('refuseCommunityControlComputerUse(body.request as Record<string,unknown>);');
    expect(refusal).toBeGreaterThan(-1);
    expect(refusal).toBeLessThan(call.indexOf('agentDialogueHost.controlCall(body.targetEndpointId'));
    // Phone forwarding wraps what the phone sent; it never builds a computer-use row.
    const forwards=server.split('\n').filter(line=>line.includes('agentDialogueHost.communityForward('));
    expect(forwards).toHaveLength(2);
    expect(forwards.every(line=>/communityForward\([^,]+,\{kind:'(terminal',body:request as unknown as Record<string,unknown>|projects')\}/.test(line))).toBe(true);
    expect(server).not.toMatch(/communityForward\([^)]*computer-use/);
  });
});
