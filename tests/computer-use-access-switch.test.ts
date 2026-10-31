/**
 * Computer use on/off: the person switches a scope on in the app, an AI connection asks with request-access and
 * Control still asks the person for each request. The AI names nothing (scope, label, permissions), cannot flip the
 * switch, and off ends every grant and waiting request. No connection is picked by the person.
 */
import {describe,expect,test} from 'bun:test';
import {generateKeyPairSync,sign} from 'node:crypto';
import {computerScopeApprovalBytes} from '../src/computerUseScopeApproval';
import {COMPUTER_USE_SCOPE_LIMITS,COMPUTER_USE_SCOPE_OPERATIONS,COMPUTER_USE_SCOPE_PERMISSIONS,parseComputerScopeAgentRequest} from '../src/computerUseScopeProtocol';
import {COMPUTER_USE_SCOPE_MCP_TOOL,computerUseScopeMcpRequest} from '../src/computerUseScopeMcp';
import {ComputerUseRecovery} from '../src/computerUseRecovery';
import {ComputerUseRuntime} from '../src/computerUseRuntime';
import type {ComputerCallerHost} from '../src/computerUseCallerHost';

const app={bundleId:'com.apple.calculator',teamId:'',codeHash:'ab'.repeat(20),pid:435,processStart:'123456'};
const desktop={kind:'desktop' as const},appScope={kind:'application' as const,application:app};
const owner={pid:912,start:'100001'};
const keys=()=>{const pair=generateKeyPairSync('ec',{namedCurve:'prime256v1'});const jwk=pair.publicKey.export({format:'jwk'});return {...pair,point:Buffer.concat([Buffer.from([4]),Buffer.from(jwk.x!,'base64url'),Buffer.from(jwk.y!,'base64url')])};};
const signed=(r:any,k:ReturnType<typeof keys>)=>{const payload={version:2 as const,approvalId:r.approvalId,scope:r.scope,permissions:[...COMPUTER_USE_SCOPE_PERMISSIONS],caller:r.caller,owner:r.owner,issuedAt:Date.now(),expiresAt:r.expiresAt};return {...payload,signature:sign('sha256',computerScopeApprovalBytes(payload),k.privateKey).toString('base64')};};
const tick=()=>new Promise(resolve=>setTimeout(resolve,5));

function fixture(host:ComputerCallerHost={state:'known',bundleIds:['com.stablyai.orca']}){
  const k=keys(),recovery=new ComputerUseRecovery(':memory:'),sent:any[]=[],requests:any[]=[];let clock=Date.now();
  const answers=new Map<string,'pending'|'approved'|'denied'>();
  // How Control answers: its Screen Recording switch, and whether a request is delivered, refused unsent or lost.
  const knobs={screenRecording:true,delivery:'ok' as 'ok'|'not-sent'|'answer-not-sent'|'unknown',attempts:0};
  const channel={available:true,dispose(){},retire(body:any){sent.push(body);},async request(body:any):Promise<any>{sent.push(body);
    if(body.operation==='status')return {success:true,protocolVersion:1,workerProtocol:2,backgroundOnly:true,accessibility:true,secureInput:false,operations:['capture','click']};
    if(body.operation==='scope-status')return {success:true,scopeProtocolVersion:2,operations:[...COMPUTER_USE_SCOPE_OPERATIONS],accessibility:true,screenRecording:knobs.screenRecording,secureInput:false,owner};
    if(body.operation==='scope-request-approval'){knobs.attempts++;
      if(knobs.delivery==='not-sent')throw Object.assign(Error('busy'),{notDispatched:true});
      if(knobs.delivery==='answer-not-sent')return {success:false,notDispatched:true,code:'native-busy'};
      if(knobs.delivery==='unknown')throw Error('connection lost');
      requests.push({...body,owner});answers.set(body.approvalId,'pending');return {success:true,state:'pending'};}
    if(body.operation==='scope-approval-status'){const state=answers.get(body.approvalId)??'unknown',r=requests.find(r=>r.approvalId===body.approvalId);
      return state==='approved'?{success:true,state,approval:signed(r,k),helperPublicKey:k.point.toString('base64')}:{success:true,state};}
    // Control opens a switched-on grant with its 30-day technical horizon (ControlLimits.scopeGrantMs), from its own clock.
    if(body.operation==='scope-open-grant')return {success:true,bound:true,grant:'b'.repeat(32),expiresAt:clock+COMPUTER_USE_SCOPE_LIMITS.grantMs,scopeProtocolVersion:2,operations:[...COMPUTER_USE_SCOPE_OPERATIONS],scope:body.scope,permissions:[...COMPUTER_USE_SCOPE_PERMISSIONS]};
    return {success:true};
  }};
  const runtime=new ComputerUseRuntime(channel,recovery,{now:()=>clock,callerHost:async()=>host});
  const answer=(state:'approved'|'denied',index=requests.length-1)=>answers.set(requests[index].approvalId,state);
  return {runtime,recovery,sent,requests,answer,knobs,advance:(ms:number)=>{clock+=ms;},close(){runtime.dispose();recovery.close();}};
}
const ask=(f:ReturnType<typeof fixture>,instance:string,client='claude-code')=>f.runtime.agent(instance,client,{operation:'scope-request-access'});
const status=(f:ReturnType<typeof fixture>,instance:string,client='claude-code')=>f.runtime.agent(instance,client,{operation:'scope-status'});
// The management status is a union across operations; these checks read its status fields.
const managed=(f:ReturnType<typeof fixture>):Promise<any>=>f.runtime.manage({operation:'status'});

describe('computer use switch',()=>{
  test('off by default: request-access is refused and Control receives no request',async()=>{
    const f=fixture();try{
      const first=await status(f,'1'.repeat(64));expect(first.access).toEqual({enabled:false});expect(first.guidance).toContain('꺼져 있습니다');
      await expect(ask(f,'1'.repeat(64))).rejects.toThrow('컴퓨터 유즈가 꺼져 있습니다');
      expect(f.requests).toHaveLength(0);
      expect((await managed(f)).access).toEqual({enabled:false});
    }finally{f.close();}
  });

  test('on: one Control request for the switched scope, labelled by the host; asking again does not send another',async()=>{
    const f=fixture();try{
      await f.runtime.manage({operation:'scope-access-set',enabled:true,scope:desktop});
      const conn=(await status(f,'2'.repeat(64))).connection;
      const asked=await ask(f,'2'.repeat(64));
      expect(asked.state).toBe('pending');expect(asked.guidance).toContain('승인 검토 열기');
      expect(f.requests).toHaveLength(1);
      expect(f.requests[0].scope).toEqual(desktop);
      // Who asks and from where come from the registered connection and its process ancestry, never from the body.
      expect(f.requests[0].label).toBe(`연결 ${conn.code.slice(0,8)} / claude-code · Orca · 전체 Mac`);
      expect(f.requests[0].caller.sessionId).toBe(conn.id);
      expect((await ask(f,'2'.repeat(64))).state).toBe('pending');
      expect(f.requests).toHaveLength(1);
      // The person approves in Control; the AI then reads its grant from status, and asking again says so.
      f.answer('approved');
      const ready=await status(f,'2'.repeat(64));expect(ready.grants).toHaveLength(1);expect(typeof ready.grants[0].grant).toBe('string');
      expect((await ask(f,'2'.repeat(64))).state).toBe('granted');
      expect(f.requests).toHaveLength(1);
    }finally{f.close();}
  });

  test('the AI names nothing and cannot flip the switch through its own path',async()=>{
    const f=fixture();try{
      for(const extra of [{scope:desktop},{label:'x'},{permissions:['screen']},{connectionId:'c'}]){
        expect(()=>parseComputerScopeAgentRequest({operation:'scope-request-access',...extra})).toThrow();
        expect(()=>computerUseScopeMcpRequest({operation:'request-access',...extra})).toThrow();
      }
      expect(computerUseScopeMcpRequest({operation:'request-access'})).toEqual({operation:'scope-request-access'});
      expect(COMPUTER_USE_SCOPE_MCP_TOOL.inputSchema.properties.operation.enum).toContain('request-access');
      await expect(f.runtime.agent('3'.repeat(64),'claude-code',{operation:'scope-access-set',enabled:true,scope:desktop})).rejects.toThrow();
      await expect(f.runtime.agent('3'.repeat(64),'claude-code',{operation:'scope-request-access',scope:desktop})).rejects.toThrow();
      expect((await managed(f)).access).toEqual({enabled:false});
      expect(f.requests).toHaveLength(0);
    }finally{f.close();}
  });

  test('one waiting request at a time, and a declined connection waits a minute before asking again',async()=>{
    const f=fixture();try{
      await f.runtime.manage({operation:'scope-access-set',enabled:true,scope:desktop});
      await ask(f,'4'.repeat(64),'claude-code');
      await expect(ask(f,'5'.repeat(64),'codex-mcp-client')).rejects.toThrow('대기 중');
      expect(f.requests).toHaveLength(1);
      f.answer('denied');
      await expect(ask(f,'4'.repeat(64),'claude-code')).rejects.toThrow('다시 요청하지 마세요');
      expect(f.requests).toHaveLength(1);
      // Another connection is not held back by the first one's interval.
      expect((await ask(f,'5'.repeat(64),'codex-mcp-client')).state).toBe('pending');
      expect(f.requests).toHaveLength(2);expect(f.requests[1].label).toContain('codex-mcp-client');
      f.answer('denied');f.advance(61_000);
      expect((await ask(f,'4'.repeat(64),'claude-code')).state).toBe('pending');
      expect(f.requests).toHaveLength(3);
    }finally{f.close();}
  });

  test('a refusal before the request leaves starts no interval: asking again gets the real reason or goes through',async()=>{
    const f=fixture();try{
      await f.runtime.manage({operation:'scope-access-set',enabled:true,scope:desktop});
      // A result the person has not checked yet.
      const row=f.recovery.beginScope({scope:desktop,operation:'scope-click',requestId:'request_rec_0001',sessionId:'person',lane:'connection'});
      await expect(ask(f,'c'.repeat(64))).rejects.toThrow('먼저 확인');
      f.recovery.reviewScope(row);
      expect((await ask(f,'c'.repeat(64))).state).toBe('pending');expect(f.requests).toHaveLength(1);
    }finally{f.close();}
    const g=fixture();try{
      await g.runtime.manage({operation:'scope-access-set',enabled:true,scope:desktop});
      // Control's Screen Recording is off: nothing reaches Control, and the person may switch it on and the AI ask at once.
      g.knobs.screenRecording=false;
      await expect(ask(g,'d'.repeat(64))).rejects.toThrow('화면 기록 권한');expect(g.knobs.attempts).toBe(0);
      g.knobs.screenRecording=true;
      // A request refused unsent (thrown or answered) was never shown either.
      g.knobs.delivery='not-sent';await expect(ask(g,'d'.repeat(64))).rejects.toThrow('전달이 미확인');
      g.knobs.delivery='answer-not-sent';await expect(ask(g,'d'.repeat(64))).rejects.toThrow('전달을 확인하지 못했습니다');
      g.knobs.delivery='ok';
      const asked=await ask(g,'d'.repeat(64));expect(asked.state).toBe('pending');expect(g.requests).toHaveLength(1);expect(g.knobs.attempts).toBe(3);
    }finally{g.close();}
    // An unread host for an app scope says so each time; it is never reported as a declined request.
    const h=fixture({state:'unknown',reason:'resolver-failed'});try{
      await h.runtime.manage({operation:'scope-access-set',enabled:true,scope:appScope});
      for(let i=0;i<2;i++)await expect(ask(h,'e'.repeat(64))).rejects.toThrow('확인하지 못해');
      expect(h.knobs.attempts).toBe(0);
    }finally{h.close();}
  });

  test('a request that may have reached Control keeps the interval, and two asks at once send one request',async()=>{
    const f=fixture();try{
      await f.runtime.manage({operation:'scope-access-set',enabled:true,scope:desktop});
      // Lost on the way: it may have reached Control, so it is never followed by a fresh request inside the interval.
      f.knobs.delivery='unknown';
      await expect(ask(f,'f'.repeat(64))).rejects.toThrow('전달이 미확인');
      f.knobs.delivery='ok';
      await expect(ask(f,'f'.repeat(64))).rejects.toThrow('다시 요청하지 마세요');
      expect(f.knobs.attempts).toBe(1);
      f.advance(61_000);
      expect((await ask(f,'f'.repeat(64))).state).toBe('pending');expect(f.knobs.attempts).toBe(2);
    }finally{f.close();}
    const g=fixture();try{
      await g.runtime.manage({operation:'scope-access-set',enabled:true,scope:desktop});
      await status(g,'0'.repeat(64));await status(g,'1'.repeat(64));
      const both=await Promise.allSettled([ask(g,'0'.repeat(64)),ask(g,'1'.repeat(64),'codex-mcp-client'),ask(g,'0'.repeat(64))]);
      expect(g.requests).toHaveLength(1);
      for(const r of both)if(r.status==='rejected')expect(String(r.reason)).not.toContain('다시 요청하지 마세요');
      expect(both.some(r=>r.status==='fulfilled'&&r.value.state==='pending')).toBe(true);
    }finally{g.close();}
  });

  test('while one AI holds control another is refused, and off ends grants and waiting requests at once',async()=>{
    const f=fixture();try{
      await f.runtime.manage({operation:'scope-access-set',enabled:true,scope:desktop});
      const holder=(await status(f,'6'.repeat(64))).connection;
      await ask(f,'6'.repeat(64));f.answer('approved');expect((await status(f,'6'.repeat(64))).grants).toHaveLength(1);
      await expect(ask(f,'7'.repeat(64),'codex-mcp-client')).rejects.toThrow('사용 중');
      const off:any=await f.runtime.manage({operation:'scope-access-set',enabled:false});expect(off.access).toEqual({enabled:false});
      await tick();
      expect((await status(f,'6'.repeat(64))).grants).toHaveLength(0);
      expect(f.sent.some(b=>b.operation==='scope-revoke-session'&&b.sessionId===holder.id)).toBe(true);
      // The connection itself stays: after the person switches on again, the same AI can ask (no interval carried over).
      await f.runtime.manage({operation:'scope-access-set',enabled:true,scope:desktop});
      expect((await ask(f,'6'.repeat(64))).state).toBe('pending');
      await f.runtime.manage({operation:'scope-access-set',enabled:false});await tick();
      expect((await managed(f)).scoped.pending).toHaveLength(0);
    }finally{f.close();}
  });

  test('an approval lasts until it is ended: no 10-minute or one-day end; a lapsed connection ends it',async()=>{
    const f=fixture();try{
      await f.runtime.manage({operation:'scope-access-set',enabled:true,scope:desktop});
      const conn=(await status(f,'b'.repeat(64))).connection;
      await ask(f,'b'.repeat(64));f.answer('approved');
      const granted=(await status(f,'b'.repeat(64))).grants;expect(granted).toHaveLength(1);
      // Without stepping, a 30-day setTimeout would fire at once (it overflows 32 bits) and end the grant here.
      await tick();expect((await managed(f)).scoped.grants).toHaveLength(1);
      // An AI that keeps its connection: a heartbeat a minute renews the 75 s lease for more than a day.
      for(let minute=0;minute<26*60;minute++){f.advance(60_000);await f.runtime.agent('b'.repeat(64),'claude-code',{operation:'heartbeat'});}
      f.runtime.reap();
      const later=await status(f,'b'.repeat(64));
      expect(later.connection.id).toBe(conn.id);expect(later.grants).toHaveLength(1);expect(later.grants[0].grant).toBe(granted[0].grant);
      expect(f.requests).toHaveLength(1);
      // The connection ends when its lease lapses, and the grant goes with it; Control is told.
      f.advance(76_000);f.runtime.reap();await tick();
      expect((await managed(f)).scoped.grants).toHaveLength(0);
      expect(f.sent.some(b=>b.operation==='scope-revoke-session'&&b.sessionId===conn.id)).toBe(true);
    }finally{f.close();}
  });

  test('a different scope ends what the old scope allowed; the same scope keeps it',async()=>{
    const f=fixture();try{
      await f.runtime.manage({operation:'scope-access-set',enabled:true,scope:desktop});
      await ask(f,'8'.repeat(64));f.answer('approved');expect((await status(f,'8'.repeat(64))).grants).toHaveLength(1);
      await f.runtime.manage({operation:'scope-access-set',enabled:true,scope:desktop});
      expect((await status(f,'8'.repeat(64))).grants).toHaveLength(1);
      await f.runtime.manage({operation:'scope-access-set',enabled:true,scope:appScope});await tick();
      expect((await status(f,'8'.repeat(64))).grants).toHaveLength(0);
      expect((await managed(f)).access).toEqual({enabled:true,scope:appScope});
      expect((await ask(f,'8'.repeat(64))).state).toBe('pending');
      expect(f.requests.at(-1).scope).toEqual(appScope);expect(f.requests.at(-1).label).toContain('com.apple.calculator');
    }finally{f.close();}
  });

  test('protected apps cannot be switched on, and an app scope never covers the asking AI\'s own host app',async()=>{
    const f=fixture({state:'known',bundleIds:['com.apple.calculator']});try{
      for(const bundleId of ['com.intenet.agentstozbycs','com.apple.systempreferences'])
        await expect(f.runtime.manage({operation:'scope-access-set',enabled:true,scope:{kind:'application',application:{...app,bundleId}}})).rejects.toThrow();
      expect((await managed(f)).access).toEqual({enabled:false});
      await expect(f.runtime.manage({operation:'scope-access-set',enabled:true})).rejects.toThrow();
      await expect(f.runtime.manage({operation:'scope-access-set',enabled:'yes',scope:desktop})).rejects.toThrow();
      await f.runtime.manage({operation:'scope-access-set',enabled:true,scope:appScope});
      // Refused before it leaves, so asking again names the same reason rather than a declined request.
      for(let i=0;i<2;i++)await expect(ask(f,'9'.repeat(64))).rejects.toThrow('자기 호스트');
      expect(f.requests).toHaveLength(0);expect(f.knobs.attempts).toBe(0);
    }finally{f.close();}
  });

  test('an unread host is named as such in the label and still needs the person',async()=>{
    const f=fixture({state:'unknown',reason:'resolver-failed'});try{
      await f.runtime.manage({operation:'scope-access-set',enabled:true,scope:desktop});
      await ask(f,'a'.repeat(64),'some-client');
      expect(f.requests[0].label).toContain('some-client · 실행 앱 미확인 · 전체 Mac');
    }finally{f.close();}
  });
});
