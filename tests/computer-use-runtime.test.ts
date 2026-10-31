import {describe,expect,test} from 'bun:test';
import {generateKeyPairSync,sign} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {ComputerUseRuntime} from '../src/computerUseRuntime';
import {ComputerUseRecovery} from '../src/computerUseRecovery';
import {computerApprovalBytes} from '../src/computerUseApproval';
import {RevokingComputerUseChannel,type ComputerUseNativeChannel} from '../src/computerUseNative';
import {handleComputerUse} from '../src/computerUseApi';
import {COMPUTER_USE_INSTANCE_HEADER} from '../src/computerUseConnectionProtocol';
import {COMPUTER_USE_MCP_TOOL,computerUseMcpRequest,computerUseMcpResult} from '../src/computerUseMcp';

const target={bundleId:'com.example.document',teamId:'A1B2C3D4E5',codeHash:'a'.repeat(40),pid:1234,processStart:'123456789',windowId:12};
const one='1'.repeat(64),two='2'.repeat(64);
/** Reply samples shared with the Swift checks (native/computer-use/Tests/ControlContract/requests.json). */
const replies=JSON.parse(readFileSync(join(import.meta.dir,'..','native','computer-use','Tests','ControlContract','requests.json'),'utf8')).replies;
/** `legacyControl`: a separately installed Control built before capture/click, which lists no `operations`. */
function fixture(options:{refuseApprovals?:number;legacyControl?:boolean}={}){
  let now=1_800_000_000_000,approved=false;
  const operations=options.legacyControl?{}:{operations:replies.status.operations};
  let nativeStatus:Record<string,unknown>={success:true,halted:false,protocolVersion:1,workerProtocol:2,backgroundOnly:true,accessibility:true,secureInput:false,...operations};
  let captureReply:Record<string,unknown>={success:true,halted:false,mediaType:'image/jpeg',data:'YWJj',width:500,height:250,windowWidth:1000,windowHeight:500};
  const keys=generateKeyPairSync('ec',{namedCurve:'P-256'}),jwk=keys.publicKey.export({format:'jwk'});
  const publicKey=Buffer.concat([Buffer.from([4]),Buffer.from(jwk.x!,'base64url'),Buffer.from(jwk.y!,'base64url')]);
  const requests=new Map<string,any>(),calls:Record<string,any>[]=[],nativeGrants=new Map<string,any>();
  let dropInput=false,rejectBind=false,nativeId=0,inputCalls=0,refuseApprovals=options.refuseApprovals??0;
  const gates=new Map<string,{entered:()=>void;wait:Promise<void>}>();
  const blockNext=(operation:string)=>{
    let release!:()=>void,entered!:()=>void;
    const ready=new Promise<void>(r=>{entered=r;}),wait=new Promise<void>(r=>{release=r;});
    gates.set(operation,{entered,wait});return {ready,release};
  };
  const channel:ComputerUseNativeChannel={available:true,dispose(){Object.assign(this,{available:false});},async request(body){
    if(!this.available)throw Object.assign(Error('closed'),{notDispatched:true});calls.push(body);
    const gate=gates.get(String(body.operation));if(gate){gates.delete(String(body.operation));gate.entered();await gate.wait;}
    switch(body.operation){
      case 'status':return nativeStatus;
      case 'request-approval':if(refuseApprovals-->0)throw Object.assign(Error('busy'),{notDispatched:true});requests.set(String(body.approvalId),body);return {success:true,state:'pending'};
      case 'approval-status':{
        const r=requests.get(String(body.approvalId));if(!r)return {success:true,state:'unknown'};
        if(!approved)return {success:true,state:'pending'};
        const approval={approvalId:r.approvalId,target:r.target,caller:{sessionId:r.caller.sessionId,lane:r.caller.lane},issuedAt:now,expiresAt:r.expiresAt};
        return {success:true,state:'approved',helperPublicKey:publicKey.toString('base64'),approval:{...approval,signature:sign('sha256',computerApprovalBytes(approval),{key:keys.privateKey,dsaEncoding:'der'}).toString('base64')}};
      }
      case 'open-grant':{
        if(rejectBind){rejectBind=false;return {success:false,notDispatched:true,code:'target-changed'};}
        const r=requests.get(String(body.approvalId));expect(body.caller).toEqual(r.caller);expect(body.target).toEqual(r.target);
        requests.delete(String(body.approvalId));const grant=(++nativeId).toString(16).padStart(32,'0');nativeGrants.set(grant,{caller:body.caller,expiresAt:now+600000});
        return {success:true,bound:true,grant,protocolVersion:2,expiresAt:now+600000,...operations};
      }
      case 'observe':if(!nativeGrants.has(String(body.grant)))return {success:false,halted:true,code:'grant-unknown'};expect(body.caller).toEqual(nativeGrants.get(String(body.grant)).caller);return {success:true,halted:false,snapshotId:'snapshot1',truncated:false,elements:[{id:'field1',role:'AXTextField',label:'own fixture',value:'',enabled:true,settable:true}]};
      case 'capture':return captureReply;
      case 'click':case 'press':case 'set-value':{
        expect(body.caller).toEqual(nativeGrants.get(String(body.grant)).caller);inputCalls++;
        if(dropInput)throw Error('fixture response lost');
        return {success:true,halted:false,outcome:{state:'confirmed_change'},humanStatePreserved:true};
      }
      case 'revoke':nativeGrants.delete(String(body.grant));return {success:true};
      case 'revoke-session':for(const[g,c]of nativeGrants)if(c.caller.sessionId===body.sessionId)nativeGrants.delete(g);return {success:true};
      default:throw Error('unexpected '+body.operation);
    }
  }};
  const recovery=new ComputerUseRecovery(':memory:',{now:()=>now}),runtime=new ComputerUseRuntime(channel,recovery,{now:()=>now});
  const register=async(instance=one)=>(await runtime.agent(instance,'codex',{operation:'status'}) as any).connection.id;
  const request=async(connectionId:string)=>runtime.manage({operation:'request-approval',connectionId,target,label:'fixture edit'});
  const grant=async(instance=one)=>{const id=await register(instance);await request(id);approved=true;return ((await runtime.agent(instance,'codex',{operation:'status'})) as any).grants[0];};
  return {runtime,recovery,channel,calls,register,request,grant,blockNext,setNativeStatus:(status:Record<string,unknown>)=>{nativeStatus=status;},setCapture:(reply:Record<string,unknown>)=>{captureReply=reply;},rejectNextBind:()=>{rejectBind=true;},helperRestart:()=>nativeGrants.clear(),helperPrune:()=>{for(const[id,g]of nativeGrants)if(g.expiresAt<=now)nativeGrants.delete(id);},approve:()=>{approved=true;},advance:(ms:number)=>{now+=ms;},drop:()=>{dropInput=true;},inputCalls:()=>inputCalls,close:()=>{runtime.dispose();recovery.close();}};
}

describe('native computer-use product runtime',()=>{
  test('capture binds a coordinate click to the observed image and preserves receipt identity',async()=>{
    const f=fixture();try {
      const g=await f.grant();const base={grant:g.grant,epoch:g.epoch};
      const obs=await f.runtime.agent(one,'codex',{...base,operation:'observe'}) as any;
      const click={...base,operation:'click',observationId:obs.observationId,requestId:'click_fixture_1',x:100,y:200};
      await expect(f.runtime.agent(one,'codex',click)).rejects.toThrow();
      const capture=await f.runtime.agent(one,'codex',{...base,operation:'capture',observationId:obs.observationId}) as any;
      expect(capture.image).toMatchObject({width:500,windowWidth:1000});
      const mcp=computerUseMcpResult(capture);
      expect(mcp.content[1]).toMatchObject({type:'image',data:'YWJj'});
      expect(JSON.stringify(mcp.structuredContent)).not.toContain('YWJj');
      await expect(f.runtime.agent(one,'codex',{...click,x:1000})).rejects.toThrow();
      expect((await f.runtime.agent(one,'codex',click) as any).receipt.state).toBe('confirmed');
      expect((await f.runtime.agent(one,'codex',click) as any).receipt.state).toBe('confirmed');
      expect(f.calls.filter(c=>c.operation==='click')).toHaveLength(1);
      expect(f.calls.find(c=>c.operation==='click')).toMatchObject({snapshotId:'snapshot1',x:100,y:200});
    } finally {f.close();}
  });
  test('capture cannot carry an approval and coordinates must be finite and nonnegative',()=>{
    const base={grant:'a'.repeat(64),epoch:1,observationId:'observation_1'};
    expect(()=>computerUseMcpRequest({...base,operation:'capture',screenAccessApproved:true})).toThrow();
    for(const x of [-1,Number.NaN,Infinity,100001])
      expect(()=>computerUseMcpRequest({...base,operation:'click',requestId:'request_1',x,y:1})).toThrow();
    expect(()=>computerUseMcpResult({success:true,image:{mediaType:'image/jpeg',data:'not-base64!'}})).toThrow();
  });
  test('agent status distinguishes a live app channel from native readiness and never approves control',async()=>{
    const f=fixture();try{
      const status=()=>f.runtime.agent(one,'codex',{operation:'status'}) as Promise<any>;
      const observe=async(result:Record<string,unknown>)=>{f.setNativeStatus(result);await f.runtime.manage({operation:'status'});return (await status()).native;};
      let result=await status();expect(result.available).toBe(true);expect(result.native).toEqual({state:'unknown'});expect(result.grants).toHaveLength(0);expect(f.calls).toHaveLength(0);
      const ready={success:true,protocolVersion:1,workerProtocol:2,backgroundOnly:true,accessibility:true,secureInput:false};
      expect(await observe(ready)).toMatchObject({state:'ready'});
      f.setNativeStatus({success:false,code:'signed-main-required',privateDetails:'must not escape'});
      await f.runtime.manage({operation:'status'});result=await status();expect(result.available).toBe(true);expect(result.native).toMatchObject({state:'unavailable',code:'signed-main-required'});expect(JSON.stringify(result.native)).not.toContain('privateDetails');
      expect(await observe({success:false,code:'untrusted-secret'})).not.toHaveProperty('code');
      expect(await observe({...ready,accessibility:false})).toMatchObject({state:'accessibility-required'});
      expect(await observe({...ready,secureInput:true})).toMatchObject({state:'secure-input'});
      expect(await observe({...ready,protocolVersion:9})).toMatchObject({state:'unknown'});
      expect(await observe({...ready,workerProtocol:1})).toMatchObject({state:'unknown'});
      expect(await observe({...ready,backgroundOnly:false})).toMatchObject({state:'unknown'});
      await observe(ready);f.advance(10001);expect((await status()).native).toEqual({state:'unknown'});
      expect(f.calls.every(c=>c.operation==='status')).toBe(true);expect(f.inputCalls()).toBe(0);
    }finally{f.close();}
  });
  test('agent status never adds a native call or disturbs an in-flight management request',async()=>{
    const f=fixture();try{
      await f.register();const gate=f.blockNext('status');const checking=f.runtime.manage({operation:'status'});await gate.ready;
      const concurrent=await f.runtime.agent(two,'codex',{operation:'status'}) as any;
      expect(concurrent.available).toBe(true);expect(concurrent.native).toEqual({state:'unknown'});expect(concurrent.grants).toHaveLength(0);expect(f.calls).toHaveLength(1);
      gate.release();await checking;expect((await f.runtime.agent(two,'codex',{operation:'status'}) as any).native).toMatchObject({state:'ready'});expect(f.calls).toHaveLength(1);expect(f.inputCalls()).toBe(0);
    }finally{f.close();}
  });
  test('no approval means no worker or input; the helper key is obtained only after its native approval',async()=>{
    const f=fixture();try{
      const id=await f.register();await f.request(id);
      const before=await f.runtime.agent(one,'codex',{operation:'status'}) as any;
      expect(before.grants).toHaveLength(0);expect(before.pending).toHaveLength(1);expect(f.calls.some(c=>c.operation==='open-grant')).toBe(false);
      f.approve();const after=await f.runtime.agent(one,'codex',{operation:'status'}) as any;
      expect(after.grants).toHaveLength(1);expect(after.grants[0].grant).toMatch(/^[a-f0-9]{64}$/);expect(f.inputCalls()).toBe(0);
      const management=await f.runtime.manage({operation:'status'}) as any;
      expect(management.grants[0].grant).toBeUndefined();expect(JSON.stringify(management)).not.toContain(after.grants[0].grant);
    }finally{f.close();}
  });
  test('even a leaked grant cannot be used by another connection or a caller in a request body',async()=>{
    const f=fixture();try{
      const g=await f.grant();await f.register(two);
      await expect(f.runtime.agent(two,'claude',{operation:'observe',grant:g.grant,epoch:g.epoch})).rejects.toThrow();
      await expect(f.runtime.agent(one,'codex',{operation:'observe',grant:g.grant,epoch:g.epoch,caller:{sessionId:g.caller.sessionId,lane:'connection'}})).rejects.toThrow();
      const observation=await f.runtime.agent(one,'codex',{operation:'observe',grant:g.grant,epoch:g.epoch}) as any;
      const input={operation:'set-value',grant:g.grant,epoch:g.epoch,requestId:'fixture_0001',observationId:observation.observationId,element:'field1',value:'한글 fixture'};
      const result=await f.runtime.agent(one,'codex',input) as any;
      expect(result.receipt.state).toBe('confirmed');expect(f.inputCalls()).toBe(1);expect(f.recovery.pending()).toHaveLength(0);
      const repeated=await f.runtime.agent(one,'codex',input) as any;expect(repeated.receipt.state).toBe('confirmed');expect(f.inputCalls()).toBe(1);
    }finally{f.close();}
  });
  test('a lost mutation reply stops the channel, keeps durable unknown, and refuses another grant for the app',async()=>{
    const f=fixture();try{
      const g=await f.grant(),observation=await f.runtime.agent(one,'codex',{operation:'observe',grant:g.grant,epoch:g.epoch}) as any;f.drop();
      const result=await f.runtime.agent(one,'codex',{operation:'press',grant:g.grant,epoch:g.epoch,requestId:'fixture_0002',observationId:observation.observationId,element:'field1'}) as any;
      expect(result.receipt.state).toBe('unknown');expect(f.inputCalls()).toBe(1);expect(f.channel.available).toBe(false);expect(f.recovery.pending()).toHaveLength(1);
      expect((await f.runtime.manage({operation:'status'}) as any).restartRequired).toBe(true);
      const status=await f.runtime.agent(one,'codex',{operation:'status'}) as any;
      expect(status.grants[0].halted).toBe(true);expect(status.grants[0].epoch).toBeGreaterThan(g.epoch);
      await expect(f.runtime.agent(one,'codex',{operation:'review-recovery',id:f.recovery.pending()[0]!.id,confirmed:true})).rejects.toThrow();
    }finally{f.close();}
  });
  test('an expired connection cannot revive its caller or grant; heartbeat never extends the native ten-minute grant',async()=>{
    const f=fixture();try{
      const g=await f.grant();f.advance(74000);await f.runtime.agent(one,'codex',{operation:'heartbeat'});
      f.advance(74000);expect((await f.runtime.agent(one,'codex',{operation:'status'}) as any).grants).toHaveLength(1);
      f.advance(76000);f.runtime.reap();await new Promise(r=>setImmediate(r));
      await expect(f.runtime.agent(one,'codex',{operation:'observe',grant:g.grant,epoch:g.epoch})).rejects.toThrow();
      const renewed=await f.runtime.agent(one,'codex',{operation:'status'}) as any;
      expect(renewed.grants).toHaveLength(0);expect(renewed.connection.id).not.toBe(g.caller.sessionId);
      expect(f.calls.some(c=>c.operation==='revoke-session'&&c.sessionId===g.caller.sessionId)).toBe(true);
    }finally{f.close();}
  });
  test('heartbeats preserve only the connection, never renew or recreate a ten-minute control grant',async()=>{
    const f=fixture();try{
      const grant=await f.grant();
      for(let index=0;index<8;index++){f.advance(74000);await f.runtime.agent(one,'codex',{operation:'heartbeat'});}
      expect((await f.runtime.agent(one,'codex',{operation:'status'}) as any).grants).toHaveLength(1);
      f.advance(10000);await f.runtime.agent(one,'codex',{operation:'heartbeat'});
      expect((await f.runtime.agent(one,'codex',{operation:'status'}) as any).grants).toHaveLength(0);
      await expect(f.runtime.agent(one,'codex',{operation:'observe',grant:grant.grant,epoch:grant.epoch})).rejects.toThrow();
      expect(f.calls.filter(c=>c.operation==='open-grant')).toHaveLength(1);
    }finally{f.close();}
  });
  test('an expired native grant or restarted helper does not close the shared link or prevent new approvals',async()=>{
    const f=fixture();try{
      const a=await f.grant();
      for(let i=0;i<15;i++){f.advance(20000);await f.runtime.agent(one,'codex',{operation:'heartbeat'});}
      const b=await f.grant(two);
      for(let i=0;i<15;i++){f.advance(20000);for(const id of [one,two])await f.runtime.agent(id,'codex',{operation:'heartbeat'});}
      f.helperPrune();
      expect((await f.runtime.agent(two,'codex',{operation:'status'}) as any).grants).toHaveLength(1);
      await new Promise(r=>setImmediate(r));
      expect(f.channel.available).toBe(true);
      expect((await f.runtime.agent(two,'codex',{operation:'observe',grant:b.grant,epoch:b.epoch}) as any).success).toBe(true);
      f.helperRestart();
      await expect(f.runtime.agent(two,'codex',{operation:'observe',grant:b.grant,epoch:b.epoch})).rejects.toThrow();
      await new Promise(r=>setImmediate(r));expect(f.channel.available).toBe(true);
      const newGrant=await f.grant();expect(newGrant.grant).not.toBe(a.grant);expect(f.inputCalls()).toBe(0);
    }finally{f.close();}
  });
  test('revocation during approval sync preserves the same signed approval until bind can be dispatched',async()=>{
    const f=fixture();try{
      await f.grant();const b=await f.register(two);await f.request(b);
      const statusGate=f.blockNext('approval-status'),revokeGate=f.blockNext('revoke');
      const checking=f.runtime.agent(two,'codex',{operation:'status'});await statusGate.ready;
      await f.runtime.agent(one,'codex',{operation:'disconnect'});statusGate.release();await revokeGate.ready;
      const waiting=await checking as any;
      expect(waiting.pending).toHaveLength(1);expect(waiting.grants).toHaveLength(0);
      expect(f.calls.filter(c=>c.operation==='open-grant')).toHaveLength(1);
      revokeGate.release();await new Promise(r=>setImmediate(r));
      const bound=await f.runtime.agent(two,'codex',{operation:'status'}) as any;
      expect(bound.pending).toHaveLength(0);expect(bound.grants).toHaveLength(1);
      expect(f.calls.filter(c=>c.operation==='request-approval')).toHaveLength(2);
      expect(f.calls.filter(c=>c.operation==='open-grant')).toHaveLength(2);expect(f.inputCalls()).toBe(0);
    }finally{f.close();}
  });
  test('a pre-dispatch approval refusal frees its nonce slot, and a disconnect during delivery creates no grant',async()=>{
    const f=fixture({refuseApprovals:9});try{
      const id=await f.register();
      for(let i=0;i<9;i++)await expect(f.request(id)).rejects.toThrow('전달이 미확인');
      const gate=f.blockNext('request-approval'),requesting=f.request(id).then(()=>null,error=>error as Error);await gate.ready;
      await f.runtime.agent(one,'codex',{operation:'disconnect'});gate.release();expect((await requesting)?.message).toContain('AI 연결이 끝나');
      await new Promise(r=>setImmediate(r));
      const status=await f.runtime.agent(one,'codex',{operation:'status'}) as any;
      expect(status.grants).toHaveLength(0);expect(status.pending).toHaveLength(0);
      expect(f.calls.filter(c=>c.operation==='open-grant')).toHaveLength(0);
    }finally{f.close();}
  });
  test('connection confirmation codes are host-issued and cannot be chosen through the instance or client label',async()=>{
    const f=fixture();try{
      const a=await f.runtime.agent(one,'codex',{operation:'status'}) as any;
      const b=await f.runtime.agent(two,'codex',{operation:'status'}) as any;
      expect(a.connection.code).toBe(a.connection.id.slice(4));
      expect(b.connection.code).toBe(b.connection.id.slice(4));
      expect(a.connection.code).not.toBe(b.connection.code);
      expect(a.connection.label).toBe('codex');expect(b.connection.label).toBe('codex');
      const management=await f.runtime.manage({operation:'status'}) as any;
      expect(management.connections.map((c:any)=>c.code)).toEqual([a.connection.code,b.connection.code]);
      await f.request(a.connection.id);
      expect(f.calls.find(c=>c.operation==='request-approval')!.label).toBe('연결 '+a.connection.code+' / fixture edit');
      expect(JSON.stringify(management)).not.toContain(one);expect(JSON.stringify(management)).not.toContain(two);
    }finally{f.close();}
  });
  test('a display name containing another connection code never changes the selected or native confirmation code',async()=>{
    const f=fixture();try{
      const victim=(await f.runtime.agent(one,'codex',{operation:'status'}) as any).connection;
      const attacker=(await f.runtime.agent(two,victim.code,{operation:'status'}) as any).connection;
      expect(attacker.label).toBe(victim.code);expect(attacker.code).not.toBe(victim.code);
      await f.request(attacker.id);
      const label=f.calls.find(c=>c.operation==='request-approval')!.label;
      expect(label).toBe('연결 '+attacker.code+' / fixture edit');expect(label).not.toContain(victim.code);
    }finally{f.close();}
  });
  test('a permanent pre-grant refusal is cancelled without closing another live grant or retrying approval',async()=>{
    const f=fixture();try{
      const a=await f.grant(),b=await f.register(two);await f.request(b);f.rejectNextBind();
      await expect(f.runtime.agent(two,'codex',{operation:'status'})).rejects.toThrow('대상 창 또는 접근성 권한');
      const status=await f.runtime.agent(two,'codex',{operation:'status'}) as any;
      expect(status.pending).toHaveLength(0);expect(status.grants).toHaveLength(0);expect(f.channel.available).toBe(true);
      expect(f.calls.filter(c=>c.operation==='open-grant')).toHaveLength(2);
      expect((await f.runtime.agent(one,'codex',{operation:'observe',grant:a.grant,epoch:a.epoch}) as any).success).toBe(true);
      expect(f.inputCalls()).toBe(0);
    }finally{f.close();}
  });
  test('HTTP authorization and body limits precede runtime creation, and a browser cannot call the agent endpoint',async()=>{
    let made=0;const f=fixture(),factory=()=>{made++;return f.runtime;};
    const post=(body:string,headers:Record<string,string>={})=>new Request('http://127.0.0.1/api/computer-use-agent',{method:'POST',headers:{'Content-Type':'application/json',[COMPUTER_USE_INSTANCE_HEADER]:one,...headers},body});
    try{
      expect((await handleComputerUse(post('{}'),factory,{agent:true,authorized:false})).status).toBe(403);
      expect((await handleComputerUse(post('{"operation":"status"}',{Origin:'http://localhost:9000'}),factory,{agent:true,authorized:true})).status).toBe(400);
      expect((await handleComputerUse(post('x'.repeat(16001)),factory,{agent:true,authorized:true})).status).toBe(400);expect(made).toBe(0);
      const result=await handleComputerUse(post('{"operation":"status"}'),factory,{agent:true,authorized:true});expect(result.status).toBe(200);expect(result.headers.get('cache-control')).toBe('private, no-store');
      for(const operation of ['catalog','open','review-recovery','request-approval','approve'])expect(()=>computerUseMcpRequest({operation})).toThrow();
    }finally{f.close();}
  });
});

describe('capture in flight, an older Control and the pixel-to-point rule',()=>{
  const begin=async(f:ReturnType<typeof fixture>)=>{
    const g=await f.grant(),base={grant:g.grant,epoch:g.epoch};
    return {g,base,obs:await f.runtime.agent(one,'codex',{...base,operation:'observe'}) as any};
  };
  const settle=(p:Promise<unknown>)=>p.then(r=>({r}),e=>({e:e as Error}));
  const ended='제어 허용이 끝났습니다';
  test('revoking the grant while the native capture is in flight returns no image; the native revoke follows the capture',async()=>{
    const f=fixture();try{
      const {g,base,obs}=await begin(f);
      const gate=f.blockNext('capture');
      const capturing=settle(f.runtime.agent(one,'codex',{...base,operation:'capture',observationId:obs.observationId}));
      await gate.ready;
      await f.runtime.manage({operation:'revoke',id:g.id});
      // Nothing is sent beside the open capture; only the bounded revocation waits for it.
      expect(f.calls.map(c=>c.operation)).not.toContain('revoke');
      gate.release();
      const out:any=await capturing;
      expect(out.r).toBeUndefined();expect(String(out.e?.message)).toContain(ended);
      await new Promise(r=>setImmediate(r));
      const ops=f.calls.map(c=>c.operation);
      expect(ops.lastIndexOf('revoke')).toBeGreaterThan(ops.indexOf('capture'));
      await expect(f.runtime.agent(one,'codex',{...base,operation:'click',observationId:obs.observationId,requestId:'click_after_revoke',x:1,y:1})).rejects.toThrow();
      expect(f.inputCalls()).toBe(0);expect(f.recovery.pending()).toHaveLength(0);
    }finally{f.close();}
  });
  test('handing control to the person during capture halts the grant and discards the image',async()=>{
    const f=fixture();try{
      const {base,obs}=await begin(f);
      const gate=f.blockNext('capture');
      const capturing=settle(f.runtime.agent(one,'codex',{...base,operation:'capture',observationId:obs.observationId}));
      await gate.ready;
      expect((await f.runtime.agent(one,'codex',{...base,operation:'request-human'}) as any).owner).toBe('human');
      gate.release();
      const out:any=await capturing;expect(out.r).toBeUndefined();expect(String(out.e?.message)).toContain(ended);
      await new Promise(r=>setImmediate(r));
      const ops=f.calls.map(c=>c.operation);expect(ops.lastIndexOf('revoke')).toBeGreaterThan(ops.indexOf('capture'));
      expect((await f.runtime.agent(one,'codex',{operation:'status'}) as any).grants[0]).toMatchObject({halted:true,haltReason:'agent-request'});
      expect(f.inputCalls()).toBe(0);
    }finally{f.close();}
  });
  test('a stop reported by Control with or without pixels never hands an image over',async()=>{
    for(const reply of [{success:false,halted:true,notDispatched:true,code:'worker-halted'},{...replies.capture,halted:true}]){
      const f=fixture();try{
        const {base,obs}=await begin(f);f.setCapture(reply);
        await expect(f.runtime.agent(one,'codex',{...base,operation:'capture',observationId:obs.observationId})).rejects.toThrow(ended);
        expect((await f.runtime.agent(one,'codex',{operation:'status'}) as any).grants[0]).toMatchObject({halted:true,haltReason:'worker-halted'});
        await expect(f.runtime.agent(one,'codex',{...base,operation:'click',observationId:obs.observationId,requestId:'click_after_stop',x:1,y:1})).rejects.toThrow();
        expect(f.inputCalls()).toBe(0);
      }finally{f.close();}
    }
  });
  test('a main app paired with an older Control never offers capture or click, and observe and press keep working',async()=>{
    const f=fixture({legacyControl:true});try{
      await f.runtime.manage({operation:'status'});
      expect((await f.runtime.agent(one,'codex',{operation:'status'}) as any).native).toMatchObject({state:'ready',capture:'control-update-required'});
      const {g,base,obs}=await begin(f);
      await expect(f.runtime.agent(one,'codex',{...base,operation:'capture',observationId:obs.observationId})).rejects.toThrow('control-update-required');
      await expect(f.runtime.agent(one,'codex',{...base,operation:'click',observationId:obs.observationId,requestId:'legacy_click_1',x:1,y:1})).rejects.toThrow('control-update-required');
      expect(f.calls.some(c=>c.operation==='capture'||c.operation==='click')).toBe(false);expect(f.recovery.pending()).toHaveLength(0);
      const pressed=await f.runtime.agent(one,'codex',{...base,operation:'press',requestId:'legacy_press_1',observationId:obs.observationId,element:'field1'}) as any;
      expect(pressed.receipt.state).toBe('confirmed');expect(f.inputCalls()).toBe(1);
      expect((await f.runtime.agent(one,'codex',{operation:'status'}) as any).grants.find((x:any)=>x.id===g.id)).toMatchObject({halted:false});
    }finally{f.close();}
    const current=fixture();try{
      await current.runtime.manage({operation:'status'});
      expect((await current.runtime.agent(one,'codex',{operation:'status'}) as any).native).toMatchObject({state:'ready',capture:'supported'});
      for(const operations of [undefined,'capture,click',['capture'],[...replies.status.operations,...Array(40).fill('x')]]){
        current.setNativeStatus({...replies.status,operations});await current.runtime.manage({operation:'status'});
        expect((await current.runtime.agent(one,'codex',{operation:'status'}) as any).native.capture).toBe('control-update-required');
      }
    }finally{current.close();}
  });
  test('an image pixel becomes a window point by windowWidth/width and reaches the native click unchanged; the far edge is outside',async()=>{
    const f=fixture();try{
      f.setCapture(replies.capture);
      const g=await f.grant(),base={grant:g.grant,epoch:g.epoch};
      const look=async()=>{
        const obs=await f.runtime.agent(one,'codex',{...base,operation:'observe'}) as any;
        return {obs,image:(await f.runtime.agent(one,'codex',{...base,operation:'capture',observationId:obs.observationId}) as any).image};
      };
      const point=(image:any,px:number,py:number)=>({x:px*image.windowWidth/image.width,y:py*image.windowHeight/image.height});
      const click=(obs:any,requestId:string,at:{x:number;y:number})=>f.runtime.agent(one,'codex',{...base,operation:'click',observationId:obs.observationId,requestId,...at}) as Promise<any>;
      let {obs,image}=await look();
      expect(image).toMatchObject({width:1280,height:800,windowWidth:2560,windowHeight:1600});
      expect(point(image,640,400)).toEqual({x:1280,y:800});
      expect((await click(obs,'pixel_click_1',point(image,640,400))).receipt.state).toBe('confirmed');
      expect(f.calls.filter(c=>c.operation==='click').at(-1)).toMatchObject({x:1280,y:800});
      ({obs,image}=await look());
      expect((await click(obs,'pixel_click_2',point(image,1279,799))).receipt.state).toBe('confirmed');
      expect(f.calls.filter(c=>c.operation==='click').at(-1)).toMatchObject({x:2558,y:1598});
      ({obs,image}=await look());
      for(const [px,py] of [[1280,0],[0,800]] as const)await expect(click(obs,`pixel_edge_${px}_${py}`,point(image,px,py))).rejects.toThrow('새로 관찰');
      expect(f.calls.filter(c=>c.operation==='click')).toHaveLength(2);expect(f.recovery.pending()).toHaveLength(0);
    }finally{f.close();}
  });
  test('the tool description keeps onboarding and safety guidance in a short text',()=>{
    const text=COMPUTER_USE_MCP_TOOL.description;
    for(const phrase of ['First call status','Tools and Settings → Computer Use','Touch ID','do not claim per-chat isolation',
      'screen images were approved','windowWidth/width','No global mouse','arbitrary keys','never replay an unknown action'])
      expect(text).toContain(phrase);
    expect(text.length).toBeLessThanOrEqual(1000);
  });
});

test('input never waits; revocations take priority, are bounded, and never replay an uncertain result',async()=>{
  let release!:(v:Record<string,unknown>)=>void;const calls:any[]=[];
  const raw:ComputerUseNativeChannel={available:true,dispose(){Object.assign(this,{available:false});},request:async body=>{calls.push(body);if(body.operation==='observe')return new Promise(r=>{release=r;});return {success:true};}};
  const channel=new RevokingComputerUseChannel(raw),inflight=channel.request({operation:'observe'});
  channel.retire({operation:'revoke',grant:'a'});channel.retire({operation:'revoke-session',sessionId:'s'});
  await expect(channel.request({operation:'press'})).rejects.toMatchObject({notDispatched:true});expect(calls).toHaveLength(1);
  release({success:true});await inflight;await new Promise(r=>setImmediate(r));
  expect(calls.map(c=>c.operation)).toEqual(['observe','revoke','revoke-session']);expect(channel.available).toBe(true);
  channel.retire({operation:'set-value',value:'never'});expect(channel.available).toBe(false);expect(calls).toHaveLength(3);
});

test('a status read waits a bounded time behind another request; input still never waits',async()=>{
  let release!:(v:Record<string,unknown>)=>void;const calls:string[]=[];
  const raw:ComputerUseNativeChannel={available:true,dispose(){},request:async body=>{calls.push(String(body.operation));if(body.operation==='observe')return new Promise(r=>{release=r;});return {success:true,operation:body.operation};}};
  const channel=new RevokingComputerUseChannel(raw,{steps:3,ms:5}),inflight=channel.request({operation:'observe'});
  const read=channel.request({operation:'scope-status'});
  await expect(channel.request({operation:'press'})).rejects.toMatchObject({notDispatched:true,code:'busy'});
  release({success:true});await inflight;
  expect(await read).toEqual({success:true,operation:'scope-status'});expect(calls).toEqual(['observe','scope-status']);
  // A read behind a request that does not end within the wait is refused without being sent.
  const stuck=channel.request({operation:'observe'});
  await expect(channel.request({operation:'status'})).rejects.toMatchObject({notDispatched:true,code:'busy'});
  expect(calls).toEqual(['observe','scope-status','observe']);release({success:true});await stuck;
});
