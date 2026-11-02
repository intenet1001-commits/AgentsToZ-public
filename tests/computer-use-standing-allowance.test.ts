/**
 * The standing allowance (상시 허용): the person turns it on once in AgentsToZ Control with Touch ID, and from then on
 * any AgentsToZ AI connection on this Mac gets a whole-Mac grant without being asked, across app restarts. Control alone
 * decides it (StandingAllowance.swift); these check what the main app does with it: the switch reads as on, desktop
 * requests open at once, the per-minute limit does not apply, an idle grant of another connection can be taken over,
 * an application scope still asks the person, and the person's off ends it in Control too.
 */
import {describe,expect,test} from 'bun:test';
import {generateKeyPairSync,sign} from 'node:crypto';
import {mkdtempSync,readFileSync,rmSync,statSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {computerScopeApprovalBytes} from '../src/computerUseScopeApproval';
import {COMPUTER_USE_REMOTE_REFUSALS,COMPUTER_USE_SCOPE_LIMITS,COMPUTER_USE_SCOPE_OPERATIONS,COMPUTER_USE_SCOPE_PERMISSIONS} from '../src/computerUseScopeProtocol';
import {ComputerUseRecovery} from '../src/computerUseRecovery';
import {ComputerUseRuntime,REMOTE_ACCESS_INTERVAL_MS,STANDING_IDLE_MS,computerUseRemoteSettingsFile,computerUseRemoteSettingsMemory,remoteAccessLabel,remoteDeviceName,type ComputerUseRemoteSettingsStore} from '../src/computerUseRuntime';

const app={bundleId:'com.apple.calculator',teamId:'',codeHash:'ab'.repeat(20),pid:435,processStart:'123456'};
const desktop={kind:'desktop' as const},appScope={kind:'application' as const,application:app};
const owner={pid:912,start:'100001'};
const keys=()=>{const pair=generateKeyPairSync('ec',{namedCurve:'prime256v1'});const jwk=pair.publicKey.export({format:'jwk'});return {...pair,point:Buffer.concat([Buffer.from([4]),Buffer.from(jwk.x!,'base64url'),Buffer.from(jwk.y!,'base64url')])};};
const signed=(r:any,k:ReturnType<typeof keys>,issuedAt:number)=>{const payload={version:2 as const,approvalId:r.approvalId,scope:r.scope,permissions:[...COMPUTER_USE_SCOPE_PERMISSIONS],caller:r.caller,owner:r.owner,issuedAt,expiresAt:r.expiresAt};return {...payload,signature:sign('sha256',computerScopeApprovalBytes(payload),k.privateKey).toString('base64')};};

/**
 * A fake Control with one v2 grant, approving a desktop request itself while `standing` is set (as Control does).
 * `signs:false` is a Control that cannot sign right now (locked); `secureInput` a password field in front.
 * Set on `control` during a test: `badKey` answers an approval with a helper key that does not verify, `v2:false` is a
 * Control without the v2 scope protocol, `expires` refuses a request's wait as approval-expired (an older Control process).
 * The runtime receives other Macs' AIs (`acceptRemote`, default on here) with `settings` (default in memory).
 */
function fixture(options:{standing?:number|null;standingOp?:boolean;signs?:boolean;secureInput?:boolean;acceptRemote?:boolean;settings?:ComputerUseRemoteSettingsStore}={}){
  const k=keys(),recovery=new ComputerUseRecovery(':memory:'),sent:any[]=[],requests:any[]=[],sleeps:number[]=[];let clock=Date.now();
  const control={standing:options.standing===undefined?1_793_400_000_000:options.standing as number|null,grant:null as null|string,opened:0,signs:options.signs!==false,secureInput:options.secureInput===true,
    badKey:false,v2:true,expires:false};
  const answers=new Map<string,'pending'|'approved'|'consumed'>();
  const approve=(id:string)=>{const r=requests.find(r=>r.approvalId===id);if(control.standing&&control.signs&&r&&r.scope.kind==='desktop'&&control.grant===null&&answers.get(id)==='pending')answers.set(id,'approved');};
  const operations=[...COMPUTER_USE_SCOPE_OPERATIONS,...(options.standingOp===false?[]:['scope-standing-off'])];
  const channel={available:true,dispose(){},retire(body:any){sent.push(body);if(body.operation==='scope-revoke'&&body.grant===control.grant)control.grant=null;},async request(body:any):Promise<any>{sent.push(body);
    if(body.operation==='status')return {success:true,protocolVersion:1,workerProtocol:2,backgroundOnly:true,accessibility:true,secureInput:false,operations:['capture','click']};
    if(body.operation==='scope-status')return {success:true,scopeProtocolVersion:control.v2?2:1,operations,accessibility:true,screenRecording:true,secureInput:control.secureInput,owner,
      ...(options.standingOp===false?{}:{standing:control.standing?{scope:{kind:'desktop'},since:control.standing}:null})};
    // The runtime's channel wrapper flushes queued revocations through request().
    if(body.operation==='scope-revoke'){if(body.grant===control.grant)control.grant=null;return {success:true,revoked:true};}
    if(body.operation==='scope-revoke-session'){control.grant=null;return {success:true,revoked:true};}
    if(body.operation==='scope-standing-off'){control.standing=null;control.grant=null;return {success:true,standing:null};}
    if(body.operation==='scope-request-approval'){if(control.expires)return {success:false,code:'approval-expired'};
      requests.push({...body,owner});answers.set(body.approvalId,'pending');approve(body.approvalId);return {success:true,state:answers.get(body.approvalId)};}
    if(body.operation==='scope-approval-status'){approve(body.approvalId);const state=answers.get(body.approvalId)??'unknown',r=requests.find(r=>r.approvalId===body.approvalId);
      return state==='approved'?{success:true,state,approval:signed(r,k,clock),helperPublicKey:control.badKey?'bad':k.point.toString('base64')}:{success:true,state};}
    if(body.operation==='scope-open-grant'){if(control.grant!==null)return {success:false,notDispatched:true,code:'scope-conflict'};
      answers.set(body.approvalId,'consumed');control.grant=(++control.opened).toString(16).padStart(32,'0');
      return {success:true,bound:true,grant:control.grant,expiresAt:clock+COMPUTER_USE_SCOPE_LIMITS.grantMs,scopeProtocolVersion:2,operations:[...COMPUTER_USE_SCOPE_OPERATIONS],scope:body.scope,permissions:[...COMPUTER_USE_SCOPE_PERMISSIONS]};}
    if(body.operation==='scope-observe')return {success:true,snapshotId:'snap-'+clock,scope:desktop,applications:[],displays:[],foreground:null};
    return {success:true};
  }};
  const runtime=new ComputerUseRuntime(channel,recovery,{now:()=>clock,callerHost:async()=>({state:'known',bundleIds:['com.stablyai.orca']}),
    acceptRemote:options.acceptRemote!==false,remoteSettings:options.settings??computerUseRemoteSettingsMemory(),remoteHumanInput:async()=>null,sleep:async ms=>{sleeps.push(ms);clock+=ms;}});
  return {runtime,control,sent,requests,answers,sleeps,recovery,now:()=>clock,advance:(ms:number)=>{clock+=ms;},close(){runtime.dispose();recovery.close();}};
}
type F=ReturnType<typeof fixture>;
const ask=(f:F,instance:string,client='codex-mcp-client')=>f.runtime.agent(instance,client,{operation:'scope-request-access'});
const status=(f:F,instance:string):Promise<any>=>f.runtime.agent(instance,'codex-mcp-client',{operation:'scope-status'});
const managed=(f:F):Promise<any>=>f.runtime.manage({operation:'status'});
const beat=(f:F,instance:string)=>f.runtime.agent(instance,'codex-mcp-client',{operation:'heartbeat'});
/** Time passes while the connections stay alive: their MCP processes renew the 75 s lease every 20 s. */
async function pass(f:F,ms:number,...alive:string[]){for(let left=ms;left>0;left-=20_000){f.advance(Math.min(20_000,left));for(const a of alive)await beat(f,a);}}

describe('computer use standing allowance',()=>{
  test('after a restart the switch reads as on for the whole Mac, and a desktop request opens without asking',async()=>{
    const f=fixture();try{
      // A new runtime is an app restart: its own switch is off, Control still holds the allowance.
      const before=await status(f,'1'.repeat(64));
      expect(before.access).toEqual({enabled:true,scope:desktop,standing:{since:1_793_400_000_000}});
      expect(before.guidance).toContain('상시 허용');
      const asked=await ask(f,'1'.repeat(64));
      expect(asked.state).toBe('granted');expect(asked.guidance).toContain('상시 허용으로 바로 허용');
      expect(f.requests).toHaveLength(1);expect(f.requests[0].scope).toEqual(desktop);
      const ready=await status(f,'1'.repeat(64));expect(ready.grants).toHaveLength(1);expect(typeof ready.grants[0].grant).toBe('string');
      expect((await managed(f)).access).toEqual({enabled:true,scope:desktop,standing:{since:1_793_400_000_000}});
    }finally{f.close();}
  });

  test('without it nothing changes: off by default, and the per-minute limit still applies',async()=>{
    const f=fixture({standing:null});try{
      expect((await status(f,'2'.repeat(64))).access).toEqual({enabled:false});
      await expect(ask(f,'2'.repeat(64))).rejects.toThrow('꺼져 있습니다');
      await f.runtime.manage({operation:'scope-access-set',enabled:true,scope:desktop});
      expect((await ask(f,'2'.repeat(64))).state).toBe('pending');
      expect(f.answers.get(f.requests[0].approvalId)).toBe('pending');
    }finally{f.close();}
  });

  test('an older Control without the allowance is read as off',async()=>{
    const f=fixture({standingOp:false});try{
      expect((await status(f,'3'.repeat(64))).access).toEqual({enabled:false});
      await expect(ask(f,'3'.repeat(64))).rejects.toThrow('꺼져 있습니다');
      // Off sends Control nothing it does not know.
      await f.runtime.manage({operation:'scope-access-set',enabled:true,scope:desktop});
      await f.runtime.manage({operation:'scope-access-set',enabled:false});
      expect(f.sent.some(b=>b.operation==='scope-standing-off')).toBe(false);
    }finally{f.close();}
  });

  test('a connection whose grant ended asks again at once: no minute to wait when nobody is asked',async()=>{
    const f=fixture();try{
      expect((await ask(f,'4'.repeat(64))).state).toBe('granted');
      const g=(await managed(f)).scoped.grants[0];
      await f.runtime.manage({operation:'scope-revoke',id:g.id});
      expect((await ask(f,'4'.repeat(64))).state).toBe('granted');
      expect(f.requests).toHaveLength(2);
    }finally{f.close();}
  });

  test('another connection takes over a grant left idle for two minutes, never one in use',async()=>{
    const f=fixture();try{
      const a='5'.repeat(64),b='6'.repeat(64);
      expect((await ask(f,a)).state).toBe('granted');
      const grant=(await status(f,a)).grants[0];
      await pass(f,STANDING_IDLE_MS-1_000,a);
      // In use: A observed a moment ago.
      await f.runtime.agent(a,'codex-mcp-client',{operation:'scope-observe',grant:grant.grant,epoch:grant.epoch});
      await pass(f,STANDING_IDLE_MS-1_000,a);
      await expect(ask(f,b)).rejects.toThrow('승인 요청을 Control에 보내지 않았습니다');
      expect(f.requests).toHaveLength(1);
      await pass(f,2_000,a,b);
      // Idle now: B takes over, A's grant is retired in Control and A sees it end.
      expect((await ask(f,b)).state).toBe('granted');
      expect(f.sent.some(x=>x.operation==='scope-revoke'&&x.grant==='1'.padStart(32,'0'))).toBe(true);
      expect((await status(f,a)).grants).toHaveLength(0);
      expect((await status(f,b)).grants).toHaveLength(1);
    }finally{f.close();}
  });

  test('a grant the person holds from the Control bar is never taken over',async()=>{
    const f=fixture();try{
      const a='7'.repeat(64),b='8'.repeat(64);
      expect((await ask(f,a)).state).toBe('granted');
      // The bar's 「직접 하기」: Control reports the person, and the host marks the grant theirs.
      const original=f.runtime['scope']['channel'].request.bind(f.runtime['scope']['channel']);
      f.runtime['scope']['channel'].request=async(body:any)=>{const r=await original(body);return body.operation==='scope-status'?{...r,control:'person'}:r;};
      await status(f,a);
      await pass(f,STANDING_IDLE_MS*3,a);
      await expect(ask(f,b)).rejects.toThrow('person-has-control');
      expect(f.requests).toHaveLength(1);
    }finally{f.close();}
  });

  test('an application scope still asks the person even while the allowance is on',async()=>{
    const f=fixture();try{
      await f.runtime.manage({operation:'scope-access-set',enabled:true,scope:appScope});
      const asked=await ask(f,'9'.repeat(64));
      expect(asked.state).toBe('pending');expect(asked.guidance).toContain('승인 검토 열기');
      expect(f.answers.get(f.requests[0].approvalId)).toBe('pending');
    }finally{f.close();}
  });

  test('the person switching computer use off ends the allowance in Control as well',async()=>{
    const f=fixture();try{
      expect((await ask(f,'a'.repeat(64))).state).toBe('granted');
      const off:any=await f.runtime.manage({operation:'scope-access-set',enabled:false});
      expect(off.access).toEqual({enabled:false});
      expect(f.sent.filter(b=>b.operation==='scope-standing-off')).toHaveLength(1);
      expect(f.control.standing).toBeNull();
      expect((await status(f,'a'.repeat(64))).grants).toHaveLength(0);
      await expect(ask(f,'a'.repeat(64))).rejects.toThrow('꺼져 있습니다');
    }finally{f.close();}
  });

  test('turned off in Control (its menu or 「중단」): the next request is refused',async()=>{
    const f=fixture();try{
      expect((await status(f,'b'.repeat(64))).access.enabled).toBe(true);
      f.control.standing=null;
      await expect(ask(f,'b'.repeat(64))).rejects.toThrow('꺼져 있습니다');
      expect(f.requests).toHaveLength(0);
    }finally{f.close();}
  });

  test('the AI cannot turn it on or off itself',async()=>{
    const f=fixture({standing:null});try{
      for(const op of ['scope-standing-on','scope-standing-off'])
        await expect(f.runtime.agent('c'.repeat(64),'codex-mcp-client',{operation:op})).rejects.toThrow();
      expect(f.sent.some(b=>String(b.operation).startsWith('scope-standing'))).toBe(false);
    }finally{f.close();}
  });
});

/**
 * AIs of other community Macs (docs/design/remote-computer-use-2026-11-01/DESIGN.md): the receiving Mac's runtime. The
 * receiving host opens the sealed box and calls runtime.remote(session, peer, body); these check what the runtime does
 * with it. The sending side, the mailbox and the crypto are not here.
 */
const DEVICE='3a9d0c1e-5b7f-4e2a-9c3d-1f2e3d4c5b6a',DEVICE2='7c1f2e3d-4b5a-4968-8776-5a4b3c2d1e0f';
const TAG_A='a'.repeat(32),TAG_B='b'.repeat(32),SESSION='1'.repeat(32);
type Peer={deviceId?:string;deviceName?:string;instance?:string;client?:string;host?:string};
const remoteCall=(f:F,body:Record<string,unknown>,peer:Peer={},session=SESSION):Promise<any>=>
  f.runtime.remote(session,{deviceId:DEVICE,deviceName:'1호 / 아젠투지(OPS)',instance:TAG_A,client:'codex-mcp-client',host:'Codex',...peer},body);
/** The refusal code (or the message of an error without one). */
const refusalOf=async(p:Promise<unknown>)=>{try{await p;}catch(error){return (error as {code?:string}).code??(error as Error).message;}return 'no refusal';};
const remoteRows=async(f:F):Promise<any[]>=>((await managed(f)).connections as any[]).filter(c=>c.scope==='remote-connection');

describe('computer use from another Mac: the receiving runtime',()=>{
  test('a busy remote request stays out of Control until the other AI has left the grant idle',async()=>{
    const f=fixture();try{
      const local='b'.repeat(64);
      expect((await ask(f,local)).state).toBe('granted');
      await expect(remoteCall(f,{operation:'scope-request-access'})).rejects.toThrow('승인 요청을 Control에 보내지 않았습니다');
      expect(f.requests).toHaveLength(1);
      expect(f.sent.filter(b=>b.operation==='scope-revoke')).toHaveLength(0);
      await pass(f,STANDING_IDLE_MS+1_000,local);
      expect((await remoteCall(f,{operation:'scope-request-access'})).state).toBe('granted');
      expect(f.requests).toHaveLength(2);
    }finally{f.close();}
  });
  test('another Mac learns that the person holds the current grant and sends no approval request',async()=>{
    const f=fixture();try{
      const local='a'.repeat(64);
      expect((await ask(f,local)).state).toBe('granted');
      const original=f.runtime['scope']['channel'].request.bind(f.runtime['scope']['channel']);
      f.runtime['scope']['channel'].request=async(body:any)=>{const r=await original(body);return body.operation==='scope-status'?{...r,control:'person'}:r;};
      await status(f,local);
      await pass(f,STANDING_IDLE_MS*3,local);
      await expect(remoteCall(f,{operation:'scope-request-access'})).rejects.toThrow('person-has-control');
      expect(f.requests).toHaveLength(1);
      expect(f.sent.filter(b=>b.operation==='scope-revoke')).toHaveLength(0);
    }finally{f.close();}
  });
  test('under the standing allowance a remote AI gets the whole Mac at once; without it nothing is asked and nothing waits',async()=>{
    const f=fixture();try{
      const before=await remoteCall(f,{operation:'scope-status'});
      expect(before.connection.scope).toBe('remote-connection');
      expect(before.remote).toEqual({allowRemote:true,standing:true,appScope:false});
      expect(before.grants).toHaveLength(0);expect(before.guidance).toContain('대기 없이');
      const asked=await remoteCall(f,{operation:'scope-request-access'});
      expect(asked.state).toBe('granted');expect(asked.guidance).toContain('그 Mac의 상시 허용으로 바로 허용');
      // RC-17 (D11): where remote use starts, the price of pointer input is said and background typing comes first.
      for(const text of [before.guidance,asked.guidance]){expect(text).toContain('human-takeover');expect(text).toContain('AI 컴퓨터 유즈 전체가 멈추');expect(text).toContain('배경 type-text·key');}
      expect(f.requests).toHaveLength(1);expect(f.requests[0].scope).toEqual(desktop);
      expect(f.requests[0].label).toMatch(/^원격 1호 \(3a9d\) \/ 연결 [0-9a-f]{8} \/ codex-mcp-client·Codex · 전체 Mac$/);
      expect(f.requests[0].caller.lane).toBe('remote');
      const ready=await remoteCall(f,{operation:'scope-status'});expect(ready.grants).toHaveLength(1);expect(typeof ready.grants[0].grant).toBe('string');
      const m=await managed(f);
      expect(m.remote).toEqual({accepting:true,allowRemote:true,blockedDevices:[],blockedConnections:[],noticeShown:false});
      const rows=m.connections.filter((c:any)=>c.scope==='remote-connection');
      expect(rows).toEqual([{id:expect.stringMatching(/^rcu_/),code:expect.any(String),label:'원격 1호 (3a9d)',scope:'remote-connection',expiresAt:expect.any(Number),
        remote:{deviceId:DEVICE,deviceName:'1호',deviceCode:'3a9d',connection:TAG_A}}]);
      expect(f.runtime.hasIncomingRemoteGrant()).toBe(true);
      expect(f.runtime.remoteGrants()).toEqual([{connectionId:rows[0].id,grantId:expect.any(String),deviceId:DEVICE,deviceName:'1호',deviceCode:'3a9d',connection:TAG_A,person:false}]);
      // Asking again while it holds the grant answers from that grant.
      expect((await remoteCall(f,{operation:'scope-request-access'})).state).toBe('granted');expect(f.requests).toHaveLength(1);
    }finally{f.close();}
    const off=fixture({standing:null});try{
      // D4: a Mac without the standing allowance never shows a request from another Mac, even with its switch on.
      await off.runtime.manage({operation:'scope-access-set',enabled:true,scope:desktop});
      expect(await refusalOf(remoteCall(off,{operation:'scope-request-access'}))).toBe('REMOTE_NEEDS_STANDING');
      expect(off.requests).toHaveLength(0);expect((await managed(off)).scoped.pending).toHaveLength(0);
      expect((await remoteCall(off,{operation:'scope-status'})).guidance).toBe(COMPUTER_USE_REMOTE_REFUSALS.REMOTE_NEEDS_STANDING);
      expect(off.runtime.hasIncomingRemoteGrant()).toBe(false);
    }finally{off.close();}
  });

  test('now or never: a request Control cannot sign at once is ended there too, and this Mac\'s own AI is not held up',async()=>{
    const f=fixture({signs:false});try{
      const refused=await remoteCall(f,{operation:'scope-request-access'}).catch(e=>e);
      expect(refused.code).toBe('REMOTE_PEER_NOT_READY');expect(refused.message).toContain('잠겨 있을 수 있습니다');expect(refused.message).toContain('취소');
      // Two grant reads about half a second apart, then the request is revoked in Control (RC-18).
      expect(f.requests).toHaveLength(1);expect(f.sleeps).toEqual([500]);
      const [row]=await remoteRows(f);
      expect(f.sent.filter(b=>b.operation==='scope-revoke-session').map(b=>b.sessionId)).toEqual([row.id]);
      const m=await managed(f);expect(m.scoped.pending).toHaveLength(0);expect(m.scoped.grants).toHaveLength(0);
      // Unlocked a moment later: nothing of the other Mac's opens by itself, and this Mac's AI asks at once.
      f.control.signs=true;
      expect((await ask(f,'1'.repeat(64))).state).toBe('granted');
      expect(f.requests).toHaveLength(2);
      expect((await managed(f)).scoped.grants.map((g:any)=>g.caller.sessionId)).not.toContain(row.id);
    }finally{f.close();}
  });

  test('one remote request-access per connection per 10 s, and a reason Control shows is named without sending anything',async()=>{
    const f=fixture({signs:false});try{
      expect(await refusalOf(remoteCall(f,{operation:'scope-request-access'}))).toBe('REMOTE_PEER_NOT_READY');
      expect(await refusalOf(remoteCall(f,{operation:'scope-request-access'}))).toBe('REMOTE_RATE_LIMITED');
      expect(f.requests).toHaveLength(1);
      f.advance(REMOTE_ACCESS_INTERVAL_MS);f.control.signs=true;
      expect((await remoteCall(f,{operation:'scope-request-access'})).state).toBe('granted');expect(f.requests).toHaveLength(2);
    }finally{f.close();}
    const s=fixture({secureInput:true});try{
      const refused=await remoteCall(s,{operation:'scope-request-access'}).catch(e=>e);
      expect(refused.code).toBe('REMOTE_PEER_NOT_READY');expect(refused.message).toContain('보안 입력');
      expect(s.requests).toHaveLength(0);
    }finally{s.close();}
  });

  test('another Mac\'s AI has the whole Mac only: no window, switch, approval or setting, and nothing while one application is switched on',async()=>{
    const f=fixture();try{
      for(const body of [{operation:'status'},{operation:'request-approval'},{operation:'observe',grant:'x'},{operation:'scope-access-set',enabled:true,scope:desktop},
        {operation:'scope-remote-set',allowRemote:true},{operation:'scope-request-approval'},{operation:'scope-review-recovery',id:'x',confirmed:true},{operation:'scope-standing-off'}])
        expect(await refusalOf(remoteCall(f,body))).toBe('REMOTE_OPERATION_REFUSED');
      expect(await remoteRows(f)).toHaveLength(0);expect(f.sent.some(b=>b.operation==='scope-standing-off')).toBe(false);
      for(const [session,peer] of [['short',{deviceId:DEVICE,deviceName:'1호',instance:TAG_A}],[SESSION,{deviceId:'not-a-uuid',deviceName:'1호',instance:TAG_A}],[SESSION,{deviceId:DEVICE,deviceName:'1호',instance:TAG_A,extra:1}]] as const)
        await expect(f.runtime.remote(session,peer,{operation:'scope-status'})).rejects.toThrow('원격 연결을 확인하지 못했습니다');
      expect((await remoteCall(f,{operation:'scope-request-access'})).state).toBe('granted');
      const [row]=await remoteRows(f);
      // The person's panel cannot hand another Mac's AI a window or one application either.
      expect(await refusalOf(f.runtime.manage({operation:'scope-request-approval',connectionId:row.id,scope:appScope,label:'x'}))).toBe('REMOTE_OPERATION_REFUSED');
      expect(await refusalOf(f.runtime.manage({operation:'request-approval',connectionId:row.id,target:{},label:'x'}))).toBe('REMOTE_OPERATION_REFUSED');
      // D6: the person switches on one application: what the other Mac's AI held ends, and it is refused until switched back.
      await f.runtime.manage({operation:'scope-access-set',enabled:true,scope:appScope});
      expect((await managed(f)).scoped.grants.filter((g:any)=>g.caller.sessionId===row.id)).toHaveLength(0);
      expect(f.sent.some(b=>b.operation==='scope-revoke-session'&&b.sessionId===row.id)).toBe(true);
      expect(await refusalOf(remoteCall(f,{operation:'scope-request-access'}))).toBe('REMOTE_APP_SCOPE_ACTIVE');
      expect(await refusalOf(remoteCall(f,{operation:'scope-observe',grant:'c'.repeat(64),epoch:1}))).toBe('REMOTE_APP_SCOPE_ACTIVE');
      const seen=await remoteCall(f,{operation:'scope-status'});
      expect(seen.remote.appScope).toBe(true);expect(seen.guidance).toBe(COMPUTER_USE_REMOTE_REFUSALS.REMOTE_APP_SCOPE_ACTIVE);expect(seen.grants).toHaveLength(0);
      // Which application this Mac's person allowed is not shown to the other Mac.
      expect(seen.access).toEqual({enabled:true,scope:{kind:'application'},standing:{since:1_793_400_000_000}});
      expect(JSON.stringify(seen)).not.toContain(appScope.application.bundleId);
    }finally{f.close();}
    // Only the bundled macOS sidecar receives (RC-12): anything else refuses before a connection exists.
    const closed=fixture({acceptRemote:false});try{
      expect(await refusalOf(remoteCall(closed,{operation:'scope-status'}))).toBe('REMOTE_UNSUPPORTED');
      expect(await remoteRows(closed)).toHaveLength(0);expect((await managed(closed)).remote.accepting).toBe(false);
    }finally{closed.close();}
  });

  test('at most 4 remote connections per device and 16 in all',async()=>{
    const f=fixture();try{
      const device=(d:number)=>`${d}a9d0c1e-5b7f-4e2a-9c3d-1f2e3d4c5b6a`;
      for(let i=0;i<4;i++)await remoteCall(f,{operation:'scope-status'},{deviceId:device(0)},i.toString(16).repeat(32));
      expect(await refusalOf(remoteCall(f,{operation:'scope-status'},{deviceId:device(0)},'e'.repeat(32)))).toBe('REMOTE_RATE_LIMITED');
      for(let d=1;d<4;d++)for(let i=0;i<4;i++)await remoteCall(f,{operation:'scope-status'},{deviceId:device(d)},i.toString(16).repeat(32));
      expect(await remoteRows(f)).toHaveLength(16);
      expect(await refusalOf(remoteCall(f,{operation:'scope-status'},{deviceId:device(4)},'0'.repeat(32)))).toBe('REMOTE_RATE_LIMITED');
      // A disconnect makes room again.
      await remoteCall(f,{operation:'disconnect'},{deviceId:device(0)},'0'.repeat(32));
      expect((await remoteCall(f,{operation:'scope-status'},{deviceId:device(0)},'e'.repeat(32))).connection.scope).toBe('remote-connection');
    }finally{f.close();}
  });

  test('the person\'s switches: receiving off, a device or one connection blocked end their grants at once and are kept in the file',async()=>{
    const dir=mkdtempSync(join(tmpdir(),'cu-remote-')),file=join(dir,'computer-use-remote.json');
    const f=fixture({settings:computerUseRemoteSettingsFile(file)});
    const set=(body:Record<string,unknown>):Promise<any>=>f.runtime.manage({operation:'scope-remote-set',...body});
    try{
      // No file yet: D1 — received.
      expect((await remoteCall(f,{operation:'scope-request-access'})).state).toBe('granted');
      // Two connections of 1호 and one of 2호; 「끊기」 on one blocks that connection for 30 minutes.
      await remoteCall(f,{operation:'scope-status'},{instance:TAG_B},'2'.repeat(32));
      await remoteCall(f,{operation:'scope-status'},{deviceId:DEVICE2,deviceName:'2호'},'3'.repeat(32));
      expect((await remoteCall(f,{operation:'scope-request-access'})).state).toBe('granted');
      const cut=await set({block:{deviceId:DEVICE,connection:TAG_A}});
      expect(cut.remote.blockedConnections).toEqual([{deviceId:DEVICE,instance:TAG_A,until:f.now()+30*60_000}]);
      const repeat=await set({block:{deviceId:DEVICE,connection:TAG_A,minutes:1}});
      expect(repeat.remote.blockedConnections).toEqual(cut.remote.blockedConnections);
      expect((await remoteRows(f)).map(r=>`${r.remote.deviceCode}:${r.remote.connection}`).sort()).toEqual([`3a9d:${TAG_B}`,`7c1f:${TAG_A}`]);
      expect((await managed(f)).scoped.grants).toHaveLength(0);
      expect(await refusalOf(remoteCall(f,{operation:'scope-status'}))).toBe('REMOTE_DEVICE_BLOCKED');
      // A new session of that connection is blocked too; 30 minutes later it is received again.
      expect(await refusalOf(remoteCall(f,{operation:'scope-status'},{},'4'.repeat(32)))).toBe('REMOTE_DEVICE_BLOCKED');
      f.advance(30*60_000);
      expect((await remoteCall(f,{operation:'scope-status'},{},'4'.repeat(32))).connection.scope).toBe('remote-connection');
      expect((await managed(f)).remote.blockedConnections).toEqual([]);
      // 「이 기기의 AI 막기」: every connection of 1호 ends and stays refused until the person unblocks it.
      await remoteCall(f,{operation:'scope-status'},{deviceId:DEVICE2,deviceName:'2호'},'3'.repeat(32));
      const blocked=await set({block:{deviceId:DEVICE}});
      expect(blocked.remote.blockedDevices).toEqual([{deviceId:DEVICE,name:'1호',since:f.now()}]);
      expect((await remoteRows(f)).map(r=>r.remote.deviceCode)).toEqual(['7c1f']);
      expect(await refusalOf(remoteCall(f,{operation:'scope-status'},{instance:TAG_B},'5'.repeat(32)))).toBe('REMOTE_DEVICE_BLOCKED');
      expect(await f.runtime.remoteAdmission({deviceId:DEVICE,instance:TAG_B})).toBe('REMOTE_DEVICE_BLOCKED');
      expect(await f.runtime.remoteAdmission({deviceId:DEVICE2.toUpperCase(),instance:TAG_B})).toBeNull();
      await set({noticeShown:true});
      // Kept across a restart: a new runtime reads the same file.
      const saved=JSON.parse(readFileSync(file,'utf8'));
      expect(saved).toEqual({schemaVersion:1,allowRemote:true,blockedDevices:[{deviceId:DEVICE,name:'1호',since:expect.any(Number)}],blockedConnections:[],noticeShown:true,changedAt:f.now()});
      const g=fixture({settings:computerUseRemoteSettingsFile(file)});try{
        expect((await managed(g)).remote).toEqual({accepting:true,allowRemote:true,blockedDevices:saved.blockedDevices,blockedConnections:[],noticeShown:true});
        expect(await refusalOf(remoteCall(g,{operation:'scope-status'}))).toBe('REMOTE_DEVICE_BLOCKED');
        await expect(g.runtime.manage({operation:'scope-remote-set',unblock:{deviceId:DEVICE}})).rejects.toThrow('이 버전에서는');
        expect(await refusalOf(remoteCall(g,{operation:'scope-status'}))).toBe('REMOTE_DEVICE_BLOCKED');
      }finally{g.close();}
      const off=await set({allowRemote:false});
      expect(off.remote.allowRemote).toBe(false);
      expect(await remoteRows(f)).toHaveLength(0);expect((await managed(f)).scoped.grants).toHaveLength(0);expect(f.runtime.hasIncomingRemoteGrant()).toBe(false);
      expect(await refusalOf(remoteCall(f,{operation:'scope-status'}))).toBe('REMOTE_BLOCKED_BY_PERSON');
      expect(await refusalOf(remoteCall(f,{operation:'heartbeat'}))).toBe('REMOTE_BLOCKED_BY_PERSON');
      expect(JSON.parse(readFileSync(file,'utf8')).allowRemote).toBe(false);expect(statSync(file).mode&0o777).toBe(0o600);
      await expect(set({allowRemote:true})).rejects.toThrow('이 버전에서는');
      await expect(set({allowRemote:true,block:{deviceId:DEVICE2}})).rejects.toThrow('이 버전에서는');
      expect((await managed(f)).remote.allowRemote).toBe(false);
      // This Mac's own AI is not affected.
      expect((await ask(f,'2'.repeat(64))).state).toBe('granted');
      // A file that cannot be read receives nothing until the person saves again.
      writeFileSync(file,'{"schemaVersion":1,"allowRemote":true');
      const h=fixture({settings:computerUseRemoteSettingsFile(file)});try{
        expect((await managed(h)).remote).toEqual({accepting:true,allowRemote:false,blockedDevices:[],blockedConnections:[],noticeShown:false,settingsUnreadable:true});
        expect(await refusalOf(remoteCall(h,{operation:'scope-status'},{deviceId:DEVICE2}))).toBe('REMOTE_BLOCKED_BY_PERSON');
        await expect(h.runtime.manage({operation:'scope-remote-set',allowRemote:true})).rejects.toThrow('이 버전에서는');
        expect(await refusalOf(remoteCall(h,{operation:'scope-status'},{deviceId:DEVICE2}))).toBe('REMOTE_BLOCKED_BY_PERSON');
      }finally{h.close();}
      for(const body of [{},{allowRemote:'yes'},{block:{deviceId:'nope'}},{block:{deviceId:DEVICE,minutes:5}},{block:{deviceId:DEVICE,connection:'xyz'}},{noticeShown:false},{surprise:true}])
        await expect(set(body)).rejects.toThrow();
    }finally{f.close();rmSync(dir,{recursive:true,force:true});}
  });

  test('a full connection block list never evicts a different active block',async()=>{
    const until=Date.now()+60*60_000;
    const blockedConnections=Array.from({length:256},(_,i)=>({deviceId:DEVICE,instance:i.toString(16).padStart(32,'0'),until}));
    const store=computerUseRemoteSettingsMemory({schemaVersion:1,allowRemote:true,blockedDevices:[],blockedConnections,noticeShown:false,changedAt:0});
    const f=fixture({settings:store});try{
      await expect(f.runtime.manage({operation:'scope-remote-set',block:{deviceId:DEVICE,connection:'f'.repeat(32)}})).rejects.toThrow('끊은 연결이');
      expect(store.read().settings.blockedConnections).toEqual(blockedConnections);
      const renewed=await f.runtime.manage({operation:'scope-remote-set',block:{deviceId:DEVICE,connection:blockedConnections[0]!.instance,minutes:1}}) as any;
      expect(renewed.remote.blockedConnections).toHaveLength(256);
      expect(renewed.remote.blockedConnections.find((b:any)=>b.instance===blockedConnections[0]!.instance).until).toBe(until);
    }finally{f.close();}
  });

  test('a remote connection lives by the 75 s lease; its heartbeat renews only that, so an idle remote grant is handed over after two minutes',async()=>{
    const f=fixture();try{
      // A heartbeat makes no connection.
      expect((await remoteCall(f,{operation:'heartbeat'})).active).toBe(false);expect(await remoteRows(f)).toHaveLength(0);
      expect((await remoteCall(f,{operation:'scope-request-access'})).state).toBe('granted');
      expect((await remoteCall(f,{operation:'heartbeat'})).active).toBe(true);
      // No call for 75 s (the sending Mac went away or stopped after 10 idle minutes): the lease and the grant end.
      f.advance(75_000);f.runtime.reap();
      expect(await remoteRows(f)).toHaveLength(0);expect((await managed(f)).scoped.grants).toHaveLength(0);
      expect(f.sent.some(b=>b.operation==='scope-revoke-session')).toBe(true);
      expect((await remoteCall(f,{operation:'heartbeat'})).active).toBe(false);
      // Heartbeats alone for two minutes: this Mac's AI takes the idle grant over (RC-9).
      const session='6'.repeat(32),local='7'.repeat(64);
      expect((await remoteCall(f,{operation:'scope-request-access'},{},session)).state).toBe('granted');
      await status(f,local);
      for(let left=STANDING_IDLE_MS;left>0;left-=20_000){f.advance(20_000);await remoteCall(f,{operation:'heartbeat'},{},session);await beat(f,local);}
      expect((await ask(f,local)).state).toBe('granted');
      expect((await remoteCall(f,{operation:'scope-status'},{},session)).grants).toHaveLength(0);
    }finally{f.close();}
    // A remote AI that keeps working is never taken over.
    const g=fixture();try{
      const session='8'.repeat(32),local='9'.repeat(64);
      expect((await remoteCall(g,{operation:'scope-request-access'},{},session)).state).toBe('granted');
      const {grant,epoch}=(await remoteCall(g,{operation:'scope-status'},{},session)).grants[0];
      await status(g,local);
      for(let left=STANDING_IDLE_MS*2;left>0;left-=20_000){g.advance(20_000);await remoteCall(g,{operation:'scope-observe',grant,epoch},{},session);await beat(g,local);}
      await expect(ask(g,local)).rejects.toThrow('2분 동안');
    }finally{g.close();}
  });

  test('now or never holds when a grant read throws: the request is ended here and in Control, and nothing waits for this Mac\'s AI',async()=>{
    // Control signs it, but its answer cannot be verified (a bad helper key): sync throws after the request reached Control.
    const f=fixture();try{
      f.control.badKey=true;
      const refused=await remoteCall(f,{operation:'scope-request-access'}).catch(e=>e);
      expect(refused.code).toBe('REMOTE_PEER_NOT_READY');expect(refused.message).toContain('범위 승인 공개키를 확인하지 못했습니다');expect(refused.message).toContain('취소');
      const [row]=await remoteRows(f);
      expect(f.requests).toHaveLength(1);expect(f.sent.filter(b=>b.operation==='scope-revoke-session').map(b=>b.sessionId)).toEqual([row.id]);
      const m=await managed(f);expect(m.scoped.pending).toHaveLength(0);expect(m.scoped.grants).toHaveLength(0);
      // This Mac's own AI is not held up by a leftover request (OTHER_PENDING).
      f.control.badKey=false;
      expect((await ask(f,'1'.repeat(64))).state).toBe('granted');
    }finally{f.close();}
  });

  test('a remote request that cannot succeed never ends this Mac\'s own AI\'s idle grant; one that can takes it over',async()=>{
    const f=fixture();try{
      const local='c'.repeat(64);
      expect((await ask(f,local)).state).toBe('granted');
      await pass(f,STANDING_IDLE_MS+1_000,local);
      // A password field in front: refused before the hand-over, so the local grant stays open in Control too.
      f.control.secureInput=true;
      const refused=await remoteCall(f,{operation:'scope-request-access'}).catch(e=>e);
      expect(refused.code).toBe('REMOTE_PEER_NOT_READY');expect(refused.message).toContain('보안 입력');
      expect((await status(f,local)).grants).toHaveLength(1);expect(f.sent.some(b=>b.operation==='scope-revoke')).toBe(false);expect(f.requests).toHaveLength(1);
      // Ready again (after the 10 s interval): the idle grant is handed over to the other Mac's AI.
      f.control.secureInput=false;await pass(f,REMOTE_ACCESS_INTERVAL_MS,local);
      expect((await remoteCall(f,{operation:'scope-request-access'})).state).toBe('granted');
      expect((await status(f,local)).grants).toHaveLength(0);expect(f.sent.some(b=>b.operation==='scope-revoke')).toBe(true);
    }finally{f.close();}
  });

  test('an outdated Control is named as control-update-required, apart from a Mac whose person has not turned the allowance on',async()=>{
    // A v2 Control from before the standing allowance sends no `standing` at all.
    const old=fixture({standingOp:false});try{
      const refused=await remoteCall(old,{operation:'scope-request-access'}).catch(e=>e);
      expect(refused.code).toBe('REMOTE_CONTROL_UPDATE_REQUIRED');expect(refused.message).toBe(COMPUTER_USE_REMOTE_REFUSALS.REMOTE_CONTROL_UPDATE_REQUIRED);
      expect(refused.message).toContain('control-update-required');expect(old.requests).toHaveLength(0);
      expect((await remoteCall(old,{operation:'scope-status'})).guidance).toBe(COMPUTER_USE_REMOTE_REFUSALS.REMOTE_CONTROL_UPDATE_REQUIRED);
    }finally{old.close();}
    // A Control without the v2 scope protocol.
    const v1=fixture();try{
      v1.control.v2=false;
      expect(await refusalOf(remoteCall(v1,{operation:'scope-request-access'}))).toBe('REMOTE_CONTROL_UPDATE_REQUIRED');expect(v1.requests).toHaveLength(0);
    }finally{v1.close();}
    // An older Control process that refuses the request's wait (approval-expired): named the same, and nothing waits.
    const expired=fixture();try{
      expired.control.expires=true;
      const refused=await remoteCall(expired,{operation:'scope-request-access'}).catch(e=>e);
      expect(refused.code).toBe('REMOTE_CONTROL_UPDATE_REQUIRED');expect(refused.message).toContain('취소');
      expect((await managed(expired)).scoped.pending).toHaveLength(0);
    }finally{expired.close();}
    // Turned off by the person (Control knows the allowance): that stays REMOTE_NEEDS_STANDING.
    const off=fixture({standing:null});try{
      expect(await refusalOf(remoteCall(off,{operation:'scope-request-access'}))).toBe('REMOTE_NEEDS_STANDING');
    }finally{off.close();}
  });

  test('the remote label: the device\'s own name without control, format or bidi characters, its code, at most 100 characters',()=>{
    const nasty='‮1호​\u0007⁦ Mac  / 아젠투지(OPS)';
    expect(remoteDeviceName(nasty)).toBe('1호 Mac');
    const label=remoteAccessLabel({deviceId:DEVICE,deviceName:nasty,client:'codex‏-mcp',host:'Co\u0000dex'},'0123456789abcdef');
    expect(label).toBe('원격 1호 Mac (3a9d) / 연결 01234567 / codex-mcp·Codex · 전체 Mac');
    expect(/[\p{Cc}\p{Cf}]/u.test(label)).toBe(false);
    expect(remoteAccessLabel({deviceId:DEVICE,deviceName:'​'},'0123456789abcdef')).toBe('원격 이름 없음 (3a9d) / 연결 01234567 · 전체 Mac');
    // Too long: the client and host give way first; the name is cut by whole characters, never half an emoji.
    const long=remoteAccessLabel({deviceId:DEVICE,deviceName:'😀'.repeat(40),client:'c'.repeat(200),host:'h'.repeat(200)},'0123456789abcdef');
    expect(long).toBe(`원격 ${'😀'.repeat(24)} (3a9d) / 연결 01234567 / ${'c'.repeat(16)} · 전체 Mac`);
    expect(long.length).toBeLessThanOrEqual(100);expect(/\p{Cs}/u.test(long)).toBe(false);
  });
});
