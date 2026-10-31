/**
 * The standing allowance (상시 허용): the person turns it on once in AgentsToZ Control with Touch ID, and from then on
 * any AgentsToZ AI connection on this Mac gets a whole-Mac grant without being asked, across app restarts. Control alone
 * decides it (StandingAllowance.swift); these check what the main app does with it: the switch reads as on, desktop
 * requests open at once, the per-minute limit does not apply, an idle grant of another connection can be taken over,
 * an application scope still asks the person, and the person's off ends it in Control too.
 */
import {describe,expect,test} from 'bun:test';
import {generateKeyPairSync,sign} from 'node:crypto';
import {computerScopeApprovalBytes} from '../src/computerUseScopeApproval';
import {COMPUTER_USE_SCOPE_LIMITS,COMPUTER_USE_SCOPE_OPERATIONS,COMPUTER_USE_SCOPE_PERMISSIONS} from '../src/computerUseScopeProtocol';
import {ComputerUseRecovery} from '../src/computerUseRecovery';
import {ComputerUseRuntime,STANDING_IDLE_MS} from '../src/computerUseRuntime';

const app={bundleId:'com.apple.calculator',teamId:'',codeHash:'ab'.repeat(20),pid:435,processStart:'123456'};
const desktop={kind:'desktop' as const},appScope={kind:'application' as const,application:app};
const owner={pid:912,start:'100001'};
const keys=()=>{const pair=generateKeyPairSync('ec',{namedCurve:'prime256v1'});const jwk=pair.publicKey.export({format:'jwk'});return {...pair,point:Buffer.concat([Buffer.from([4]),Buffer.from(jwk.x!,'base64url'),Buffer.from(jwk.y!,'base64url')])};};
const signed=(r:any,k:ReturnType<typeof keys>,issuedAt:number)=>{const payload={version:2 as const,approvalId:r.approvalId,scope:r.scope,permissions:[...COMPUTER_USE_SCOPE_PERMISSIONS],caller:r.caller,owner:r.owner,issuedAt,expiresAt:r.expiresAt};return {...payload,signature:sign('sha256',computerScopeApprovalBytes(payload),k.privateKey).toString('base64')};};

/** A fake Control with one v2 grant, approving a desktop request itself while `standing` is set (as Control does). */
function fixture(options:{standing?:number|null;standingOp?:boolean}={}){
  const k=keys(),recovery=new ComputerUseRecovery(':memory:'),sent:any[]=[],requests:any[]=[];let clock=Date.now();
  const control={standing:options.standing===undefined?1_793_400_000_000:options.standing as number|null,grant:null as null|string,opened:0};
  const answers=new Map<string,'pending'|'approved'|'consumed'>();
  const approve=(id:string)=>{const r=requests.find(r=>r.approvalId===id);if(control.standing&&r&&r.scope.kind==='desktop'&&control.grant===null&&answers.get(id)==='pending')answers.set(id,'approved');};
  const operations=[...COMPUTER_USE_SCOPE_OPERATIONS,...(options.standingOp===false?[]:['scope-standing-off'])];
  const channel={available:true,dispose(){},retire(body:any){sent.push(body);if(body.operation==='scope-revoke'&&body.grant===control.grant)control.grant=null;},async request(body:any):Promise<any>{sent.push(body);
    if(body.operation==='status')return {success:true,protocolVersion:1,workerProtocol:2,backgroundOnly:true,accessibility:true,secureInput:false,operations:['capture','click']};
    if(body.operation==='scope-status')return {success:true,scopeProtocolVersion:2,operations,accessibility:true,screenRecording:true,secureInput:false,owner,
      ...(options.standingOp===false?{}:{standing:control.standing?{scope:{kind:'desktop'},since:control.standing}:null})};
    // The runtime's channel wrapper flushes queued revocations through request().
    if(body.operation==='scope-revoke'){if(body.grant===control.grant)control.grant=null;return {success:true,revoked:true};}
    if(body.operation==='scope-revoke-session'){control.grant=null;return {success:true,revoked:true};}
    if(body.operation==='scope-standing-off'){control.standing=null;control.grant=null;return {success:true,standing:null};}
    if(body.operation==='scope-request-approval'){requests.push({...body,owner});answers.set(body.approvalId,'pending');approve(body.approvalId);return {success:true,state:answers.get(body.approvalId)};}
    if(body.operation==='scope-approval-status'){approve(body.approvalId);const state=answers.get(body.approvalId)??'unknown',r=requests.find(r=>r.approvalId===body.approvalId);
      return state==='approved'?{success:true,state,approval:signed(r,k,clock),helperPublicKey:k.point.toString('base64')}:{success:true,state};}
    if(body.operation==='scope-open-grant'){if(control.grant!==null)return {success:false,notDispatched:true,code:'scope-conflict'};
      answers.set(body.approvalId,'consumed');control.grant=(++control.opened).toString(16).padStart(32,'0');
      return {success:true,bound:true,grant:control.grant,expiresAt:clock+COMPUTER_USE_SCOPE_LIMITS.grantMs,scopeProtocolVersion:2,operations:[...COMPUTER_USE_SCOPE_OPERATIONS],scope:body.scope,permissions:[...COMPUTER_USE_SCOPE_PERMISSIONS]};}
    if(body.operation==='scope-observe')return {success:true,snapshotId:'snap-'+clock,scope:desktop,applications:[],displays:[],foreground:null};
    return {success:true};
  }};
  const runtime=new ComputerUseRuntime(channel,recovery,{now:()=>clock,callerHost:async()=>({state:'known',bundleIds:['com.stablyai.orca']})});
  return {runtime,control,sent,requests,answers,advance:(ms:number)=>{clock+=ms;},close(){runtime.dispose();recovery.close();}};
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
      await expect(ask(f,b)).rejects.toThrow('2분 동안');
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
      await expect(ask(f,b)).rejects.toThrow('작업 중');
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
