import {describe,expect,test} from 'bun:test';
import {generateKeyPairSync,sign} from 'node:crypto';
import {mkdtempSync,readFileSync,rmSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ComputerCallerRegistry} from '../src/computerUseCaller';
import {ComputerScopeApprovalVerifier,computerScopeApprovalBytes} from '../src/computerUseScopeApproval';
import {COMPUTER_USE_SCOPE_LIMITS,COMPUTER_USE_SCOPE_OPERATIONS,COMPUTER_USE_SCOPE_PERMISSIONS,COMPUTER_USE_SCOPE_PROTECTED_BUNDLES,COMPUTER_USE_SCOPE_PROTECTED_PREFIXES,COMPUTER_USE_SCOPE_SECURITY_SURFACES,parseComputerUseScope,parseComputerScopeAgentRequest,protectedScopeBundle} from '../src/computerUseScopeProtocol';
import {COMPUTER_USE_LIMITS,COMPUTER_USE_REFUSED_BUNDLE_PREFIXES,COMPUTER_USE_REFUSED_BUNDLES,COMPUTER_USE_REFUSED_TEAMS,isRefusedComputerTarget} from '../src/computerUseProtocol';
import {ComputerUseRecovery} from '../src/computerUseRecovery';
import {ComputerUseRuntime} from '../src/computerUseRuntime';
import {ComputerUseScopeHost,scopeGuardSamples} from '../src/computerUseScopeHost';
import {handleComputerUse} from '../src/computerUseApi';
import {COMPUTER_USE_INSTANCE_HEADER,COMPUTER_USE_CLIENT_HEADER} from '../src/computerUseConnectionProtocol';
import {Database} from 'bun:sqlite';
import {callerAppPaths,callerHostOwns,computerCallerOrigin,createComputerCallerHostResolver,lsofPeerPids,outermostAppPath,psProcessTable,type ComputerCallerHost,type ComputerCallerOrigin} from '../src/computerUseCallerHost';

const app={bundleId:'com.stablyai.orca',teamId:'',codeHash:'ab'.repeat(20),pid:435,processStart:'123456'};
const appScope={kind:'application' as const,application:app},desktop={kind:'desktop' as const};
const owner={pid:912,start:'100001'},owner2={pid:913,start:'100002'};
// Desktop input and application scopes need a readable caller host; these fixtures run in a host that is not the target.
const elsewhere={callerHost:async():Promise<ComputerCallerHost>=>({state:'known',bundleIds:['com.openai.codex']})};
const caller=()=>{const registry=new ComputerCallerRegistry();const identity=registry.authenticate(registry.issue({sessionId:'mcp_test_session',lane:'connection'}))!;return {registry,identity};};
const keys=()=>{const pair=generateKeyPairSync('ec',{namedCurve:'prime256v1'});const jwk=pair.publicKey.export({format:'jwk'});return {...pair,point:Buffer.concat([Buffer.from([4]),Buffer.from(jwk.x!,'base64url'),Buffer.from(jwk.y!,'base64url')])};};
const signed=(r:any,k:ReturnType<typeof keys>,issuedAt=Date.now())=>{const payload={version:2 as const,approvalId:r.approvalId,scope:r.scope,permissions:[...COMPUTER_USE_SCOPE_PERMISSIONS],caller:r.caller,owner:r.owner,issuedAt,expiresAt:r.expiresAt};return {...payload,signature:sign('sha256',computerScopeApprovalBytes(payload),k.privateKey).toString('base64')};};

describe('scoped v2 closed parsing and signed consent',()=>{
  test('matches Swift desktop and application golden approval bytes',()=>{
    // Mirrors native/computer-use/Tests/ComputerUseControlCoreChecks/ScopeApprovalChecks.swift.
    const common={version:2 as const,approvalId:'a'.repeat(64),permissions:[...COMPUTER_USE_SCOPE_PERMISSIONS],caller:{sessionId:'session_1',lane:'leader',generation:'b'.repeat(32)},owner:{pid:42,start:'1000'},issuedAt:100000,expiresAt:160000};
    const expected=(kind:string,bundle:string,team:string,code:string,pid:string,start:string)=>['agentstoz-computer-use-scope/v2',`approval=${common.approvalId}`,`scope=${kind}`,`bundle=${bundle}`,`team=${team}`,`code=${code}`,`pid=${pid}`,`start=${start}`,'permissions=screen,pointer,keyboard','session=session_1','lane=leader',`generation=${common.caller.generation}`,'owner-pid=42','owner-start=1000','issued=100000','expires=160000'].join('\n')+'\n';
    const application={bundleId:'com.example.Test',teamId:'ABCDE12345',codeHash:'c'.repeat(40),pid:123,processStart:'456789'};
    expect(computerScopeApprovalBytes({...common,scope:desktop}).toString()).toBe(expected('desktop','-','-','-','-','-'));
    expect(computerScopeApprovalBytes({...common,scope:{kind:'application',application}}).toString()).toBe(expected('application',application.bundleId,application.teamId,application.codeHash,'123','456789'));
    expect(()=>computerScopeApprovalBytes({...common,scope:desktop,expiresAt:100000})).toThrow();
    expect(()=>computerScopeApprovalBytes({...common,scope:desktop,expiresAt:710001})).toThrow();
  });
  test('domain separated canonical bytes bind the real app, caller, owner, permissions and time',()=>{
    const c=caller(),k=keys(),v=new ComputerScopeApprovalVerifier(()=>100000),r=v.request(c.identity,appScope,'scope',owner);
    const a=signed(r,k,100000),bytes=computerScopeApprovalBytes(a).toString('utf8');
    expect(bytes).toBe(`agentstoz-computer-use-scope/v2\napproval=${r.approvalId}\nscope=application\nbundle=com.stablyai.orca\nteam=\ncode=${app.codeHash}\npid=435\nstart=123456\npermissions=screen,pointer,keyboard\nsession=mcp_test_session\nlane=connection\ngeneration=${r.caller.generation}\nowner-pid=912\nowner-start=100001\nissued=100000\nexpires=700000\n`);
    expect(v.verify(a,k.point).scope).toEqual(appScope);
    expect(()=>v.verify(a,keys().point)).toThrow();expect(()=>v.verify(true,k.point)).toThrow();
    for(const changed of [{...a,scope:desktop},{...a,permissions:['screen']},{...a,caller:{...a.caller,generation:'a'.repeat(32)}},{...a,owner:owner2},{...a,expiresAt:a.expiresAt+1},{...a,version:1}])expect(()=>v.verify(changed,k.point)).toThrow();
    v.redeem(r.approvalId);expect(()=>v.verify(a,k.point)).toThrow();
    let now=100000;const expiring=new ComputerScopeApprovalVerifier(()=>now),e=expiring.request(c.identity,desktop,'scope',owner),signedBeforeExpiry=signed(e,k,100000);
    now=e.expiresAt+1;expect(()=>expiring.verify(signedBeforeExpiry,k.point)).toThrow();
  });
  test('no fabricated desktop process or agent-provided permissions; agent and protected app differ',()=>{
    expect(parseComputerUseScope(desktop)).toEqual(desktop);expect(parseComputerUseScope(appScope)).toEqual(appScope);
    for(const bad of [{...desktop,pid:4},{kind:'application',application:{...app,windowId:4}},{kind:'application',application:{...app,bundleId:'com.apple.SecurityAgent'}},{kind:'application',application:{...app,bundleId:'com.intenet.agentstozbycs.control'}}])expect(()=>parseComputerUseScope(bad)).toThrow();
    const base={operation:'scope-observe',grant:'a'.repeat(64),epoch:1};expect(parseComputerScopeAgentRequest(base)).toEqual(base);
    for(const bad of [{...base,scope:desktop},{...base,caller:{sessionId:'s'}},{...base,permissions:['screen']},{...base,operation:'scope-request-approval'}])expect(()=>parseComputerScopeAgentRequest(bad)).toThrow();
    const action={grant:'a'.repeat(64),epoch:1,observationId:'observation_1',requestId:'request_action_1'};
    expect(parseComputerScopeAgentRequest({...action,operation:'scope-key',key:'Enter',modifiers:['cmd','shift']})).toMatchObject({key:'Enter'});
    for(const bad of [{...action,operation:'scope-key',key:'Enter',modifiers:['cmd','cmd']},{...action,operation:'scope-key',key:'F100',modifiers:[]},
      {...action,operation:'scope-type-text',text:''},{...action,operation:'scope-type-text',text:'x'.repeat(4001)},
      {...action,operation:'scope-click',displayId:'display_1',x:-1,y:0,button:'left',clickCount:1},
      {...action,operation:'scope-click',displayId:'display_1',x:0,y:0,button:'middle',clickCount:1},
      {...action,operation:'scope-drag',displayId:'display_1',x:1,y:1,endX:100001,endY:2},
      {...action,operation:'scope-scroll',displayId:'display_1',x:0,y:0,deltaX:1201,deltaY:0}])expect(()=>parseComputerScopeAgentRequest(bad)).toThrow();
  });
  test('protected targets equal the golden list the Swift checks also compare, in window and scope mode',()=>{
    const golden=JSON.parse(readFileSync(new URL('../native/computer-use/Tests/ControlContract/protected-targets.json',import.meta.url),'utf8'));
    const lower=(v:readonly string[])=>[...new Set(v.map(s=>s.toLowerCase()))].sort();
    const exactly=(actual:readonly string[],expected:string[])=>{expect(lower(actual).length).toBe(actual.length);expect(lower(expected).length).toBe(expected.length);expect(lower(actual)).toEqual(lower(expected));};
    exactly(COMPUTER_USE_SCOPE_PROTECTED_BUNDLES,golden.scope.bundles);exactly(COMPUTER_USE_SCOPE_SECURITY_SURFACES,golden.scope.securitySurfaces);
    exactly(COMPUTER_USE_SCOPE_PROTECTED_PREFIXES,golden.scope.prefixes);
    exactly(COMPUTER_USE_REFUSED_BUNDLES,golden.window.bundles);exactly(COMPUTER_USE_REFUSED_BUNDLE_PREFIXES,golden.window.prefixes);
    expect([...COMPUTER_USE_REFUSED_TEAMS].sort()).toEqual([...golden.window.teams].sort());
    for(const id of [...COMPUTER_USE_SCOPE_PROTECTED_BUNDLES,...COMPUTER_USE_SCOPE_SECURITY_SURFACES,...COMPUTER_USE_SCOPE_PROTECTED_PREFIXES])expect(id).toBe(id.toLowerCase());
    // The Swift sources hold the same literals; the Swift checks compare their parsed sets with the same file.
    const swift=(file:string)=>readFileSync(new URL(`../native/computer-use/Sources/ComputerUseControlCore/${file}`,import.meta.url),'utf8');
    const scopeSwift=swift('ScopedProtectedTargets.swift'),windowSwift=swift('ControlProtocol.swift');
    for(const id of [...golden.scope.bundles,...golden.scope.securitySurfaces,...golden.scope.prefixes])expect(scopeSwift).toContain(`"${id}"`);
    for(const id of [...COMPUTER_USE_REFUSED_BUNDLES,...COMPUTER_USE_REFUSED_BUNDLE_PREFIXES,...COMPUTER_USE_REFUSED_TEAMS])expect(windowSwift).toContain(`"${id}"`);
    // Window mode refuses everything the scope protects, and the scope applies all of its lists, case-insensitively.
    for(const id of [...golden.scope.bundles,...golden.scope.securitySurfaces]){
      expect(isRefusedComputerTarget({bundleId:id,teamId:''})).toBe(true);expect(protectedScopeBundle(id.toUpperCase())).toBe(true);
    }
    for(const prefix of golden.scope.prefixes){expect(protectedScopeBundle(prefix+'x')).toBe(true);expect(isRefusedComputerTarget({bundleId:prefix+'x',teamId:''})).toBe(true);}
    expect(protectedScopeBundle('com.stablyai.orca')).toBe(false);expect(protectedScopeBundle('com.apple.dock')).toBe(false);
    for(const bundleId of ['com.apple.UserNotificationCenter','com.apple.coreservices.uiagent','com.apple.LocalAuthentication.UIAgent','com.apple.authorizationhost','com.apple.WindowServer'])
      expect(()=>parseComputerUseScope({kind:'application',application:{...app,bundleId}})).toThrow();
  });
});

describe('durable cross-mode recovery',()=>{
  test('a future scoped ledger with unknown columns is preserved and never opened as current',()=>{
    const dir=mkdtempSync(join(tmpdir(),'scope-future-')),path=join(dir,'ledger.sqlite');const db=new Database(path,{create:true});
    db.exec(`CREATE TABLE computer_use_scope_actions(id TEXT PRIMARY KEY,scopeKind TEXT,bundleId TEXT,operation TEXT,requestId TEXT,sessionId TEXT,lane TEXT,state TEXT,createdAt INTEGER,reviewedAt INTEGER,futureValue TEXT);
      INSERT INTO computer_use_scope_actions VALUES('future','desktop',NULL,'scope-click','request_1','session_1','leader','unknown',1,NULL,'preserve');`);db.close();
    try{expect(()=>new ComputerUseRecovery(path)).toThrow('알 수 없는 범위 복구 기록');const check=new Database(path,{readonly:true});expect(check.query("SELECT futureValue FROM computer_use_scope_actions WHERE id='future'").get()).toEqual({futureValue:'preserve'});check.close();}
    finally{rmSync(dir,{recursive:true,force:true});}
  });
  test('scoped ledger persists only metadata, never input or screenshots',()=>{
    const dir=mkdtempSync(join(tmpdir(),'scope-private-')),path=join(dir,'ledger.sqlite');const r=new ComputerUseRecovery(path);
    try{r.beginScope({scope:desktop,operation:'scope-type-text',requestId:'request_123',sessionId:'mcp_test_session',lane:'connection',text:'private typed secret',image:'private screenshot bytes'} as any);r.close();
      const contents=readFileSync(path).toString('utf8');expect(contents).not.toContain('private typed secret');expect(contents).not.toContain('private screenshot bytes');expect(statSync(path).mode&0o777).toBe(0o600);
    }finally{try{r.close();}catch{}rmSync(dir,{recursive:true,force:true});}
  });
  test('desktop and app unknowns block overlapping v1/v2 atomically after reopen; unrelated app remains independent',()=>{
    const dir=mkdtempSync(join(tmpdir(),'scope-ledger-')),path=join(dir,'ledger.sqlite');const a=new ComputerUseRecovery(path),b=new ComputerUseRecovery(path);
    try{
      const old={bundleId:'com.stablyai.orca',windowId:12,operation:'press' as const,requestId:'request_old',sessionId:'mcp_test_session',lane:'connection'};
      const oldId=a.begin(old);expect(()=>b.beginScope({scope:desktop,operation:'scope-click',requestId:'request_new',sessionId:old.sessionId,lane:old.lane})).toThrow();
      const other={kind:'application' as const,application:{...app,bundleId:'com.example.Other'}};expect(b.unresolvedScope(other)).toBe(false);
      a.settle(oldId);const scoped=b.beginScope({scope:appScope,operation:'scope-key',requestId:'request_new',sessionId:old.sessionId,lane:old.lane});
      expect(()=>a.begin(old)).toThrow();expect(a.unresolvedScope(desktop)).toBe(true);expect(a.unresolvedScope(other)).toBe(false);
      b.close();const reopened=new ComputerUseRecovery(path);expect(reopened.pendingScope()[0]).toMatchObject({id:scoped,scopeKind:'application',bundleId:'com.stablyai.orca',state:'unknown'});
      expect(reopened.reviewScope(scoped)).toBe(true);expect(reopened.unresolvedScope(appScope)).toBe(false);
      const broad=reopened.beginScope({scope:desktop,operation:'scope-drag',requestId:'request_drag',sessionId:old.sessionId,lane:old.lane});
      expect(()=>a.begin({...old,bundleId:'com.example.Other'})).toThrow();expect(a.unresolvedScope(other)).toBe(true);
      reopened.close();const restarted=new ComputerUseRecovery(path);expect(restarted.pendingScope()).toMatchObject([{id:broad,scopeKind:'desktop',bundleId:null,state:'unknown'}]);expect(restarted.reviewScope(broad)).toBe(true);restarted.close();
    }finally{a.close();try{b.close();}catch{}rmSync(dir,{recursive:true,force:true});}
  });
});

describe('scoped authenticated runtime',()=>{
  test('observe exposes only bounded native refusal codes and preserves validation and halt boundaries',async()=>{
    const k=keys(),recovery=new ComputerUseRecovery(':memory:');let pending:any,approved=false,answer:any;
    const valid={success:true,snapshotId:'snap_1',scope:desktop,applications:[],displays:[],foreground:null};
    const channel={available:true,dispose(){},retire(_body:any){},async request(body:any):Promise<any>{
      if(body.operation==='scope-status')return {success:true,scopeProtocolVersion:2,operations:[...COMPUTER_USE_SCOPE_OPERATIONS],accessibility:true,screenRecording:true,secureInput:false,owner};
      if(body.operation==='scope-request-approval'){pending={...body,owner};return {success:true,state:'pending'};}
      if(body.operation==='scope-approval-status')return approved?{success:true,state:'approved',approval:signed(pending,k),helperPublicKey:k.point.toString('base64')}:{success:true,state:'pending'};
      if(body.operation==='scope-open-grant')return {success:true,bound:true,grant:'b'.repeat(32),expiresAt:Date.now()+590000,scopeProtocolVersion:2,operations:[...COMPUTER_USE_SCOPE_OPERATIONS],scope:body.scope,permissions:[...COMPUTER_USE_SCOPE_PERMISSIONS]};
      if(body.operation==='scope-observe')return answer;
      return {success:true};
    }};
    const runtime=new ComputerUseRuntime(channel,recovery),instance='8'.repeat(64);
    try{
      const initial=await runtime.agent(instance,'Codex',{operation:'scope-status'});
      await runtime.manage({operation:'scope-request-approval',connectionId:initial.connection.id,scope:desktop,label:'test'});approved=true;
      const ready=await runtime.agent(instance,'Codex',{operation:'scope-status'}),{grant,epoch}=ready.grants[0];
      const observe=()=>runtime.agent(instance,'Codex',{operation:'scope-observe',grant,epoch});
      answer=valid;const previous=await observe();
      for(const [code,shown] of [['human-active','human-active'],['scope-app-unverifiable','scope-app-unverifiable'],['private value /token','observe-failed'],['x'.repeat(61),'observe-failed'],[undefined,'observe-failed']] as const){
        answer={success:false,code,notDispatched:true,halted:false};await expect(observe()).rejects.toThrow(`화면 관찰을 확인하지 못했습니다: ${shown}`);
      }
      await expect(runtime.agent(instance,'Codex',{operation:'scope-capture',grant,epoch,observationId:previous.observationId,displayId:'display_1'})).rejects.toThrow('새로 관찰');
      answer={...valid,snapshotId:'invalid snapshot',code:'human-active'};await expect(observe()).rejects.toThrow('화면 관찰을 확인하지 못했습니다.');
      answer={...valid,scope:appScope};await expect(observe()).rejects.toThrow('화면 관찰을 확인하지 못했습니다.');
      answer={success:false,code:'human-active',notDispatched:true,halted:true};await expect(observe()).rejects.toThrow('제어가 중단됐습니다.');
      answer=valid;await expect(observe()).rejects.toThrow('제어 허용이 끝났습니다');
    }finally{runtime.dispose();recovery.close();}
  });
  test('an approval Control cannot open yet because of a passing secure state is kept and opened on the next read',async()=>{
    const k=keys(),recovery=new ComputerUseRecovery(':memory:');let pending:any,refusal:any={success:false,code:'secure-state-unavailable',notDispatched:true},opens=0;
    const channel={available:true,dispose(){},retire(_body:any){},async request(body:any):Promise<any>{
      if(body.operation==='scope-status')return {success:true,scopeProtocolVersion:2,operations:[...COMPUTER_USE_SCOPE_OPERATIONS],accessibility:true,screenRecording:true,secureInput:false,owner};
      if(body.operation==='scope-request-approval'){pending={...body,owner};return {success:true,state:'pending'};}
      if(body.operation==='scope-approval-status')return {success:true,state:'approved',approval:signed(pending,k),helperPublicKey:k.point.toString('base64')};
      if(body.operation==='scope-open-grant'){opens++;if(refusal)return refusal;return {success:true,bound:true,grant:'b'.repeat(32),expiresAt:Date.now()+590000,scopeProtocolVersion:2,operations:[...COMPUTER_USE_SCOPE_OPERATIONS],scope:body.scope,permissions:[...COMPUTER_USE_SCOPE_PERMISSIONS]};}
      return {success:true};
    }};
    const runtime=new ComputerUseRuntime(channel,recovery),instance='6'.repeat(64);
    try{
      const initial=await runtime.agent(instance,'Codex',{operation:'scope-status'});
      await runtime.manage({operation:'scope-request-approval',connectionId:initial.connection.id,scope:desktop,label:'test'});
      const waiting=await runtime.agent(instance,'Codex',{operation:'scope-status'});
      expect(opens).toBe(1);expect(waiting.grants).toEqual([]);expect(waiting.pending).toHaveLength(1);
      expect(((await runtime.manage({operation:'status'})) as any).scoped.pending).toHaveLength(1);
      refusal=null;const ready=await runtime.agent(instance,'Codex',{operation:'scope-status'});
      expect(ready.grants).toHaveLength(1);expect(ready.pending).toEqual([]);
    }finally{runtime.dispose();recovery.close();}
  });
  test('a Control refusal to open that is not passing ends the waiting request',async()=>{
    const k=keys(),recovery=new ComputerUseRecovery(':memory:');let pending:any;
    const channel={available:true,dispose(){},retire(_body:any){},async request(body:any):Promise<any>{
      if(body.operation==='scope-status')return {success:true,scopeProtocolVersion:2,operations:[...COMPUTER_USE_SCOPE_OPERATIONS],accessibility:true,screenRecording:true,secureInput:false,owner};
      if(body.operation==='scope-request-approval'){pending={...body,owner};return {success:true,state:'pending'};}
      if(body.operation==='scope-approval-status')return {success:true,state:'approved',approval:signed(pending,k),helperPublicKey:k.point.toString('base64')};
      if(body.operation==='scope-open-grant')return {success:false,code:'scope-conflict',notDispatched:true};
      return {success:true};
    }};
    const runtime=new ComputerUseRuntime(channel,recovery),instance='5'.repeat(64);
    try{
      const initial=await runtime.agent(instance,'Codex',{operation:'scope-status'});
      await runtime.manage({operation:'scope-request-approval',connectionId:initial.connection.id,scope:desktop,label:'test'});
      const ended=await runtime.agent(instance,'Codex',{operation:'scope-status'});
      expect(ended.grants).toEqual([]);expect(ended.pending).toEqual([]);
    }finally{runtime.dispose();recovery.close();}
  });
  test('permission revocation or secure input blocks a new scoped approval request',async()=>{
    const recovery=new ComputerUseRecovery(':memory:'),calls:string[]=[];let permissions={accessibility:true,screenRecording:true,secureInput:false};
    const channel={available:true,dispose(){},retire(_body:any){},async request(body:any):Promise<any>{calls.push(body.operation);return {success:true,scopeProtocolVersion:2,operations:[...COMPUTER_USE_SCOPE_OPERATIONS],...permissions,owner};}};
    const runtime=new ComputerUseRuntime(channel,recovery),instance='9'.repeat(64);try{const initial=await runtime.agent(instance,'Codex',{operation:'scope-status'}),connectionId=initial.connection.id;
      for(const state of [{accessibility:false,screenRecording:true,secureInput:false},{accessibility:true,screenRecording:false,secureInput:false},{accessibility:true,screenRecording:true,secureInput:true}]){
        permissions=state;await expect(runtime.manage({operation:'scope-request-approval',connectionId,scope:desktop,label:'test'})).rejects.toThrow('권한');
      }
      expect(calls.filter(operation=>operation==='scope-request-approval')).toHaveLength(0);
    }finally{runtime.dispose();recovery.close();}
  });
  test('management never reports expired permission/capability evidence as current',async()=>{
    let now=100000;const recovery=new ComputerUseRecovery(':memory:',{now:()=>now});const calls:string[]=[];
    const channel={available:true,dispose(){},retire(_body:any){},async request(body:any):Promise<any>{calls.push(body.operation);return body.operation==='scope-status'?{success:true,scopeProtocolVersion:2,operations:[...COMPUTER_USE_SCOPE_OPERATIONS],accessibility:true,screenRecording:true,secureInput:false,owner}:{success:true,protocolVersion:1,workerProtocol:2,backgroundOnly:true,accessibility:true,secureInput:false,operations:['capture','click']};}};
    const runtime=new ComputerUseRuntime(channel,recovery,{now:()=>now});try{
      const checked=await runtime.manage({operation:'scope-status'}) as any;expect(checked.scoped.native.success).toBe(true);
      expect((await runtime.manage({operation:'status'}) as any).scoped.native.success).toBe(true);now+=10001;
      expect((await runtime.manage({operation:'status'}) as any).scoped.native).toEqual({success:false,code:'scope-status-unchecked'});
      expect(calls.filter(operation=>operation==='scope-status')).toHaveLength(1);
    }finally{runtime.dispose();recovery.close();}
  });
  test('scope revocation while capture is in flight never releases the image',async()=>{
    const k=keys(),recovery=new ComputerUseRecovery(':memory:');let pending:any,approved=false,captureStarted!:()=>void,release!:()=>void;
    const started=new Promise<void>(resolve=>{captureStarted=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
    const channel={available:true,dispose(){},retire(_body:any){},async request(body:any):Promise<any>{
      if(body.operation==='scope-status')return {success:true,scopeProtocolVersion:2,operations:[...COMPUTER_USE_SCOPE_OPERATIONS],accessibility:true,screenRecording:true,secureInput:false,owner};
      if(body.operation==='scope-request-approval'){pending={...body,owner};return {success:true,state:'pending'};}
      if(body.operation==='scope-approval-status')return approved?{success:true,state:'approved',approval:signed(pending,k),helperPublicKey:k.point.toString('base64')}:{success:true,state:'pending'};
      if(body.operation==='scope-open-grant')return {success:true,bound:true,grant:'b'.repeat(32),expiresAt:Date.now()+590000,scopeProtocolVersion:2,operations:[...COMPUTER_USE_SCOPE_OPERATIONS],scope:body.scope,permissions:[...COMPUTER_USE_SCOPE_PERMISSIONS]};
      if(body.operation==='scope-observe')return {success:true,snapshotId:'snap_1',scope:desktop,applications:[],displays:[{id:'display_1',originX:0,originY:0,width:1280,height:720,scale:1,rotation:0}],foreground:null};
      if(body.operation==='scope-capture'){captureStarted();await gate;return {success:true,displayId:'display_1',mediaType:'image/jpeg',data:'/9j/2Q==',width:1280,height:720,displayWidth:1280,displayHeight:720,originX:0,originY:0};}
      return {success:true};
    }};
    const runtime=new ComputerUseRuntime(channel,recovery),instance='a'.repeat(64);
    try{const initial=await runtime.agent(instance,'Codex',{operation:'scope-status'});await runtime.manage({operation:'scope-request-approval',connectionId:initial.connection.id,scope:desktop,label:'test'});approved=true;
      const ready=await runtime.agent(instance,'Codex',{operation:'scope-status'}),{grant,epoch,id}=ready.grants[0];const obs=await runtime.agent(instance,'Codex',{operation:'scope-observe',grant,epoch});
      const capture=runtime.agent(instance,'Codex',{operation:'scope-capture',grant,epoch,observationId:obs.observationId,displayId:'display_1'});await started;
      await runtime.manage({operation:'scope-revoke',id});release();await expect(capture).rejects.toThrow('허용이 끝났습니다');
    }finally{release();runtime.dispose();recovery.close();}
  });
  test('old helpers never receive a broad approval request and v1 status stays usable',async()=>{
    const recovery=new ComputerUseRecovery(':memory:'),sent:string[]=[];
    const channel={available:true,dispose(){},retire(_body:any){},async request(body:any):Promise<any>{sent.push(body.operation);return body.operation==='status'?{success:true,protocolVersion:1,workerProtocol:2,backgroundOnly:true,accessibility:true,secureInput:false,operations:['capture','click']}:{success:false,code:'invalid-request',notDispatched:true};}};
    const runtime=new ComputerUseRuntime(channel,recovery);try{const instance='e'.repeat(64),status=await runtime.agent(instance,'Codex',{operation:'status'}),connection=status.connection.id;
      expect((await runtime.manage({operation:'status'}) as any).native.success).toBe(true);
      await expect(runtime.manage({operation:'scope-request-approval',connectionId:connection,scope:desktop,label:'test'})).rejects.toThrow('최신 Control');
      expect(sent).not.toContain('scope-request-approval');
    }finally{runtime.dispose();recovery.close();}
  });
  test('a Control that waits less than this host asks is named as outdated until another Control answers',async()=>{
    // 1호, 2026-10-31: main app 1619 with Control 1557 (120 s wait) refused the 10-minute request as approval-expired.
    const recovery=new ComputerUseRecovery(':memory:'),sent:string[]=[];let current=owner;
    const channel={available:true,dispose(){},retire(_body:any){},async request(body:any):Promise<any>{sent.push(body.operation);
      if(body.operation==='scope-status')return {success:true,scopeProtocolVersion:2,operations:[...COMPUTER_USE_SCOPE_OPERATIONS],accessibility:true,screenRecording:true,secureInput:false,owner:current};
      if(body.operation==='scope-request-approval')return current===owner?{success:false,code:'approval-expired',notDispatched:false,halted:false}:{success:true,state:'pending'};
      if(body.operation==='scope-approval-status')return {success:true,state:'pending'};
      return {success:false,code:'invalid-request',notDispatched:true};}};
    const runtime=new ComputerUseRuntime(channel,recovery);try{const instance='f'.repeat(64),initial=await runtime.agent(instance,'Codex',{operation:'scope-status'}),connectionId=initial.connection.id;
      await expect(runtime.manage({operation:'scope-request-approval',connectionId,scope:desktop,label:'test'})).rejects.toThrow('control-update-required');
      expect((await runtime.manage({operation:'status'}) as any).scoped.native.code).toBe('scope-update-required');
      // That Control process is not asked again; the person sees the update notice instead.
      const asked=sent.filter(operation=>operation==='scope-request-approval').length;
      await expect(runtime.manage({operation:'scope-request-approval',connectionId,scope:desktop,label:'test'})).rejects.toThrow('control-update-required');
      expect(sent.filter(operation=>operation==='scope-request-approval')).toHaveLength(asked);
      // A newly installed Control is another process and is asked as usual.
      current=owner2;
      expect((await runtime.manage({operation:'scope-request-approval',connectionId,scope:desktop,label:'test'}) as any).state).toBe('pending');
      expect((await runtime.manage({operation:'status'}) as any).scoped.native.success).toBe(true);
    }finally{runtime.dispose();recovery.close();}
  });
  test('another Control refusal names its code instead of an unexplained failure',async()=>{
    const recovery=new ComputerUseRecovery(':memory:');
    const channel={available:true,dispose(){},retire(_body:any){},async request(body:any):Promise<any>{
      if(body.operation==='scope-status')return {success:true,scopeProtocolVersion:2,operations:[...COMPUTER_USE_SCOPE_OPERATIONS],accessibility:true,screenRecording:true,secureInput:false,owner};
      if(body.operation==='scope-request-approval')return {success:false,code:'approval-limit',notDispatched:false,halted:false};
      return {success:false,code:'invalid-request',notDispatched:true};}};
    const runtime=new ComputerUseRuntime(channel,recovery);try{const instance='d'.repeat(64),initial=await runtime.agent(instance,'Codex',{operation:'scope-status'});
      await expect(runtime.manage({operation:'scope-request-approval',connectionId:initial.connection.id,scope:desktop,label:'test'})).rejects.toThrow('Control: approval-limit');
    }finally{runtime.dispose();recovery.close();}
  });
  test('the person holding the Mac from the Control bar refuses agent work without halting, and the bar alone hands it back',async()=>{
    const k=keys(),recovery=new ComputerUseRecovery(':memory:');let pending:any,approved=false,control:'agent'|'person'='agent',keys_=0,revoked=0,now=Date.now();
    const held={success:false,code:'person-has-control',notDispatched:true,halted:false};
    const channel={available:true,dispose(){},retire(_body:any){revoked++;},async request(body:any):Promise<any>{
      if(body.operation==='scope-status')return {success:true,scopeProtocolVersion:2,operations:[...COMPUTER_USE_SCOPE_OPERATIONS],accessibility:true,screenRecording:true,secureInput:false,owner,control:approved?control:null};
      if(body.operation==='scope-request-approval'){pending={...body,owner};return {success:true,state:'pending'};}
      if(body.operation==='scope-approval-status')return approved?{success:true,state:'approved',approval:signed(pending,k),helperPublicKey:k.point.toString('base64')}:{success:true,state:'pending'};
      if(body.operation==='scope-open-grant')return {success:true,bound:true,grant:'b'.repeat(32),expiresAt:Date.now()+590000,scopeProtocolVersion:2,operations:[...COMPUTER_USE_SCOPE_OPERATIONS],scope:body.scope,permissions:[...COMPUTER_USE_SCOPE_PERMISSIONS]};
      if(body.operation==='scope-observe')return control==='person'?held:{success:true,snapshotId:'snap_1',scope:desktop,applications:[],displays:[],foreground:null};
      if(body.operation==='scope-key'){if(control==='person')return held;keys_++;return {success:true,receipt:{requestId:body.requestId,state:'confirmed'}};}
      return {success:true};
    }};
    const runtime=new ComputerUseRuntime(channel,recovery,{...elsewhere,now:()=>now}),instance='7'.repeat(64);try{
      await runtime.manage({operation:'scope-access-set',enabled:true,scope:desktop});const initial=await runtime.agent(instance,'Codex',{operation:'scope-status'});await runtime.manage({operation:'scope-request-approval',connectionId:initial.connection.id,scope:desktop,label:'test'});approved=true;
      const ready=await runtime.agent(instance,'Codex',{operation:'scope-status'}),{grant,epoch}=ready.grants[0];expect(ready.grants[0].owner).toBe('agent');expect(ready.guidance).not.toContain('person-has-control');
      const obs=await runtime.agent(instance,'Codex',{operation:'scope-observe',grant,epoch});
      // 「직접 하기」 after the observation: the action is refused before dispatch, settled, and the grant stays open.
      control='person';const sent={operation:'scope-key',grant,epoch,observationId:obs.observationId,requestId:'request_key_held',key:'Enter',modifiers:[]};
      const refused=await runtime.agent(instance,'Codex',sent);
      expect(refused).toMatchObject({success:true,owner:'person',receipt:{state:'refused',reason:'person-has-control'}});expect(refused.guidance).toContain('request-access를 다시 하지 말고');
      expect(keys_).toBe(0);expect(recovery.pendingScope()).toHaveLength(0);expect(revoked).toBe(0);
      expect((await runtime.agent(instance,'Codex',sent)).receipt.reason).toBe('person-has-control');
      await expect(runtime.agent(instance,'Codex',{operation:'scope-observe',grant,epoch})).rejects.toThrow('person-has-control');
      now+=11000;const waiting=await runtime.agent(instance,'Codex',{operation:'scope-status'});
      expect(waiting.grants[0]).toMatchObject({owner:'person',halted:false,epoch});expect(waiting.guidance).toContain('「직접 하기」');
      expect((await runtime.manage({operation:'status'}) as any).scoped.grants[0].owner).toBe('person');
      // A new request-access is not how it comes back, and the old observation never revives.
      expect((await runtime.agent(instance,'Codex',{operation:'scope-request-access'})).state).toBe('granted');
      await expect(runtime.agent(instance,'Codex',{...sent,requestId:'request_key_old'})).rejects.toThrow('새로 관찰');
      // 「AI에게 넘기기」 on the bar: status shows the agent again and a new observation continues with the same epoch.
      control='agent';now+=11000;const back=await runtime.agent(instance,'Codex',{operation:'scope-status'});expect(back.grants[0].owner).toBe('agent');expect(back.guidance).not.toContain('person-has-control');
      const fresh=await runtime.agent(instance,'Codex',{operation:'scope-observe',grant,epoch});
      expect((await runtime.agent(instance,'Codex',{...sent,requestId:'request_key_back',observationId:fresh.observationId})).receipt.state).toBe('confirmed');expect(keys_).toBe(1);expect(revoked).toBe(0);
    }finally{runtime.dispose();recovery.close();}
  });
  test('known dispatch returns its receipt once and requires fresh observation; human takeover remains for review',async()=>{
    for(const [state,reason] of [['human-takeover','human-active'],['human-takeover','human-active-idle'],['human-takeover','human-active-events'],['human-takeover','private value /token'],['human-takeover','x'.repeat(61)],['dispatched-unverified',undefined],['confirmed',undefined]] as const){
      const k=keys(),recovery=new ComputerUseRecovery(':memory:');let pending:any,approved=false,count=0;
      const channel={available:true,dispose(){},retire(_body:any){},async request(body:any):Promise<any>{
        if(body.operation==='scope-status')return {success:true,scopeProtocolVersion:2,operations:[...COMPUTER_USE_SCOPE_OPERATIONS],accessibility:true,screenRecording:true,secureInput:false,owner};
        if(body.operation==='scope-request-approval'){pending={...body,owner};return {success:true,state:'pending'};}
        if(body.operation==='scope-approval-status')return approved?{success:true,state:'approved',approval:signed(pending,k),helperPublicKey:k.point.toString('base64')}:{success:true,state:'pending'};
        if(body.operation==='scope-open-grant')return {success:true,bound:true,grant:'b'.repeat(32),expiresAt:Date.now()+590000,scopeProtocolVersion:2,operations:[...COMPUTER_USE_SCOPE_OPERATIONS],scope:body.scope,permissions:[...COMPUTER_USE_SCOPE_PERMISSIONS]};
        if(body.operation==='scope-observe')return {success:true,snapshotId:'snap_1',scope:desktop,applications:[],displays:[],foreground:null};
        if(body.operation==='scope-key'){count++;return {success:true,receipt:{requestId:body.requestId,state,reason}};}
        return {success:true};
      }};
      const runtime=new ComputerUseRuntime(channel,recovery,elsewhere),instance='f'.repeat(64);try{
        const initial=await runtime.agent(instance,'Codex',{operation:'scope-status'});await runtime.manage({operation:'scope-request-approval',connectionId:initial.connection.id,scope:desktop,label:'test'});approved=true;
        const ready=await runtime.agent(instance,'Codex',{operation:'scope-status'}),{grant,epoch}=ready.grants[0];const obs=await runtime.agent(instance,'Codex',{operation:'scope-observe',grant,epoch});
        const sent={operation:'scope-key',grant,epoch,observationId:obs.observationId,requestId:'request_key_001',key:'Enter',modifiers:[]};const result=await runtime.agent(instance,'Codex',sent);
        expect(result.receipt.state).toBe(state);expect(recovery.pendingScope()).toHaveLength(state==='human-takeover'?1:0);expect(recovery.unresolvedScope(appScope)).toBe(state==='human-takeover');expect(count).toBe(1);
        expect(result.receipt.reason).toBe(['human-active','human-active-idle','human-active-events'].includes(reason as string)?reason:undefined);
        expect((await runtime.agent(instance,'Codex',{operation:'scope-receipt',grant,epoch,requestId:sent.requestId})).receipt).toEqual(result.receipt);
        if(state!=='human-takeover'){
          expect((await runtime.agent(instance,'Codex',sent)).receipt.state).toBe(state);
          await expect(runtime.agent(instance,'Codex',{...sent,key:'Tab'})).rejects.toThrow('내용이 달라졌습니다');
          await expect(runtime.agent(instance,'Codex',{...sent,requestId:'request_key_002'})).rejects.toThrow('새로 관찰');
          const fresh=await runtime.agent(instance,'Codex',{operation:'scope-observe',grant,epoch});
          expect((await runtime.agent(instance,'Codex',{...sent,requestId:'request_key_002',observationId:fresh.observationId})).receipt.state).toBe(state);expect(count).toBe(2);
        }else {await expect(runtime.agent(instance,'Codex',sent)).rejects.toThrow();expect(count).toBe(1);}
      }finally{runtime.dispose();recovery.close();}
    }
  });
  test('guard readings ride on the receipt only when content-free and never change state, review or replay',async()=>{
    const valid={before:{idleMs:5000,counters:{}},after:{idleMs:3,sincePostMs:2,counters:{leftMouseDown:1}},refusal:{idleMs:4,sincePostMs:3,counters:{leftMouseDown:1}}};
    const unread={after:{idleMs:5004,sincePostMs:-1,counters:null},refusal:{idleMs:-1,counters:{mouseMoved:99,keyDown:-1}}};
    expect(scopeGuardSamples(valid)).toEqual(valid);expect(scopeGuardSamples(unread)).toEqual(unread);
    expect(scopeGuardSamples(JSON.parse(JSON.stringify(valid)))).toEqual(valid);
    for(const bad of [undefined,null,[],{},'x',{before:{...valid.before,sincePostMs:1}},{after:{idleMs:3,counters:{}}},{after:valid.after,extra:valid.after},
      {before:{idleMs:600001,counters:{}}},{before:{idleMs:-2,counters:{}}},{before:{idleMs:1.5,counters:{}}},{before:{idleMs:'5',counters:{}}},{before:{idleMs:5}},
      {after:{idleMs:3,sincePostMs:60001,counters:{}}},{before:{idleMs:5,counters:{keyCode:1}}},{before:{idleMs:5,counters:{keyDown:0}}},
      {before:{idleMs:5,counters:{keyDown:100}}},{before:{idleMs:5,counters:{keyDown:-2}}},{before:{idleMs:5,counters:[1]}},
      {before:{idleMs:5,counters:{},text:'secret'}},JSON.parse('{"before":{"idleMs":5,"counters":{"__proto__":1}}}')])expect(scopeGuardSamples(bad)).toBeUndefined();
    for(const [state,samples,expected] of [['human-takeover',valid,valid],['dispatched-unverified',unread,unread],['refused',{refusal:{idleMs:375,counters:{}}},{refusal:{idleMs:375,counters:{}}}],
      ['human-takeover',{...valid,before:{idleMs:5000,counters:{},x:'/private'}},undefined],['dispatched-unverified',{after:{idleMs:3,counters:{}}},undefined]] as const){
      const k=keys(),recovery=new ComputerUseRecovery(':memory:');let pending:any,approved=false,count=0;
      const channel={available:true,dispose(){},retire(_body:any){},async request(body:any):Promise<any>{
        if(body.operation==='scope-status')return {success:true,scopeProtocolVersion:2,operations:[...COMPUTER_USE_SCOPE_OPERATIONS],accessibility:true,screenRecording:true,secureInput:false,owner};
        if(body.operation==='scope-request-approval'){pending={...body,owner};return {success:true,state:'pending'};}
        if(body.operation==='scope-approval-status')return approved?{success:true,state:'approved',approval:signed(pending,k),helperPublicKey:k.point.toString('base64')}:{success:true,state:'pending'};
        if(body.operation==='scope-open-grant')return {success:true,bound:true,grant:'b'.repeat(32),expiresAt:Date.now()+590000,scopeProtocolVersion:2,operations:[...COMPUTER_USE_SCOPE_OPERATIONS],scope:body.scope,permissions:[...COMPUTER_USE_SCOPE_PERMISSIONS]};
        if(body.operation==='scope-observe')return {success:true,snapshotId:'snap_1',scope:desktop,applications:[],displays:[],foreground:null};
        if(body.operation==='scope-key'){count++;return {success:true,receipt:{requestId:body.requestId,state,reason:state==='dispatched-unverified'?undefined:state==='refused'?'guard-refused':'human-active-idle',guardSamples:samples}};}
        return {success:true};
      }};
      const runtime=new ComputerUseRuntime(channel,recovery,elsewhere),instance='f'.repeat(64);try{
        const initial=await runtime.agent(instance,'Codex',{operation:'scope-status'});await runtime.manage({operation:'scope-request-approval',connectionId:initial.connection.id,scope:desktop,label:'test'});approved=true;
        const ready=await runtime.agent(instance,'Codex',{operation:'scope-status'}),{grant,epoch}=ready.grants[0];const obs=await runtime.agent(instance,'Codex',{operation:'scope-observe',grant,epoch});
        const sent={operation:'scope-key',grant,epoch,observationId:obs.observationId,requestId:'request_key_001',key:'Enter',modifiers:[]};const result=await runtime.agent(instance,'Codex',sent);
        expect(result.receipt.state).toBe(state);expect(result.receipt.guardSamples).toEqual(expected);
        expect(Object.keys(result.receipt).sort()).toEqual(['requestId','state',...(state==='dispatched-unverified'?[]:['reason']),...(expected?['guardSamples']:[])].sort());
        expect(result.owner).toBe(state==='human-takeover'?'human':undefined);expect(recovery.pendingScope()).toHaveLength(state==='human-takeover'?1:0);
        expect((await runtime.agent(instance,'Codex',{operation:'scope-receipt',grant,epoch,requestId:sent.requestId})).receipt).toEqual(result.receipt);
        if(state==='human-takeover')await expect(runtime.agent(instance,'Codex',sent)).rejects.toThrow();
        else expect((await runtime.agent(instance,'Codex',sent)).receipt).toEqual(result.receipt);
        expect(count).toBe(1);
      }finally{runtime.dispose();recovery.close();}
    }
  });
  test('a refusal names its native guard check beside the generic reason; nothing else about the receipt changes',async()=>{
    for(const [state,guardReason,expected] of [['refused','protected-overlay','protected-overlay'],['refused','target-changed','target-changed'],['refused','human-active','human-active'],
      ['refused','Protected Overlay',undefined],['refused','/private/path',undefined],['refused','x'.repeat(61),undefined],['refused',7,undefined],
      ['dispatched-unverified','protected-overlay',undefined],['confirmed','protected-overlay',undefined],['human-takeover','protected-overlay',undefined]] as const){
      const k=keys(),recovery=new ComputerUseRecovery(':memory:');let pending:any,approved=false,count=0;
      const channel={available:true,dispose(){},retire(_body:any){},async request(body:any):Promise<any>{
        if(body.operation==='scope-status')return {success:true,scopeProtocolVersion:2,operations:[...COMPUTER_USE_SCOPE_OPERATIONS],accessibility:true,screenRecording:true,secureInput:false,owner};
        if(body.operation==='scope-request-approval'){pending={...body,owner};return {success:true,state:'pending'};}
        if(body.operation==='scope-approval-status')return approved?{success:true,state:'approved',approval:signed(pending,k),helperPublicKey:k.point.toString('base64')}:{success:true,state:'pending'};
        if(body.operation==='scope-open-grant')return {success:true,bound:true,grant:'b'.repeat(32),expiresAt:Date.now()+590000,scopeProtocolVersion:2,operations:[...COMPUTER_USE_SCOPE_OPERATIONS],scope:body.scope,permissions:[...COMPUTER_USE_SCOPE_PERMISSIONS]};
        if(body.operation==='scope-observe')return {success:true,snapshotId:'snap_1',scope:desktop,applications:[],displays:[],foreground:null};
        if(body.operation==='scope-key'){count++;return {success:true,receipt:{requestId:body.requestId,state,...(state==='refused'?{reason:'guard-refused'}:state==='human-takeover'?{reason:'human-active'}:{}),guardReason}};}
        return {success:true};
      }};
      const runtime=new ComputerUseRuntime(channel,recovery,elsewhere),instance='f'.repeat(64);try{
        const initial=await runtime.agent(instance,'Codex',{operation:'scope-status'});await runtime.manage({operation:'scope-request-approval',connectionId:initial.connection.id,scope:desktop,label:'test'});approved=true;
        const ready=await runtime.agent(instance,'Codex',{operation:'scope-status'}),{grant,epoch}=ready.grants[0];const obs=await runtime.agent(instance,'Codex',{operation:'scope-observe',grant,epoch});
        const sent={operation:'scope-key',grant,epoch,observationId:obs.observationId,requestId:'request_key_001',key:'Enter',modifiers:[]};const result=await runtime.agent(instance,'Codex',sent);
        expect(result.receipt.state).toBe(state);expect(result.receipt.guardReason).toBe(expected);
        expect(result.receipt.reason).toBe(state==='refused'?'guard-refused':state==='human-takeover'?'human-active':undefined);
        expect(Object.keys(result.receipt).sort()).toEqual(['requestId','state',...(state==='refused'||state==='human-takeover'?['reason']:[]),...(expected?['guardReason']:[])].sort());
        // State, review row, halt and replay follow the state alone.
        expect(result.owner).toBe(state==='human-takeover'?'human':undefined);expect(recovery.pendingScope()).toHaveLength(state==='human-takeover'?1:0);
        expect((await runtime.agent(instance,'Codex',{operation:'scope-receipt',grant,epoch,requestId:sent.requestId})).receipt).toEqual(result.receipt);
        if(state==='human-takeover')await expect(runtime.agent(instance,'Codex',sent)).rejects.toThrow();
        else expect((await runtime.agent(instance,'Codex',sent)).receipt).toEqual(result.receipt);
        expect(count).toBe(1);
      }finally{runtime.dispose();recovery.close();}
    }
  });
  test('actual HTTP handler keeps management authorization and one signed grant on its originating MCP instance',async()=>{
    const k=keys(),recovery=new ComputerUseRecovery(':memory:');let pending:any,approved=false;let inputCount=0;
    const channel={available:true,dispose(){},retire(_body:any){},async request(body:any):Promise<any>{
      if(body.operation==='scope-status')return {success:true,scopeProtocolVersion:2,operations:[...COMPUTER_USE_SCOPE_OPERATIONS],accessibility:true,screenRecording:true,secureInput:false,owner};
      if(body.operation==='scope-request-approval'){pending={...body,owner};return {success:true,state:'pending'};}
      if(body.operation==='scope-approval-status')return approved?{success:true,state:'approved',approval:signed(pending,k),helperPublicKey:k.point.toString('base64')}:{success:true,state:'pending'};
      if(body.operation==='scope-open-grant')return {success:true,bound:true,grant:'b'.repeat(32),expiresAt:Date.now()+590000,scopeProtocolVersion:2,operations:[...COMPUTER_USE_SCOPE_OPERATIONS],scope:body.scope,permissions:[...COMPUTER_USE_SCOPE_PERMISSIONS]};
      if(body.operation==='scope-observe'){inputCount++;return {success:true,snapshotId:'snap_1',scope:desktop,applications:[],displays:[],foreground:null};}
      return {success:true};
    }};
    const runtime=new ComputerUseRuntime(channel,recovery);const request=async(body:any,agent:boolean,authorized:boolean,instance='c'.repeat(64))=>{
      const headers={'Content-Type':'application/json',[COMPUTER_USE_INSTANCE_HEADER]:instance,[COMPUTER_USE_CLIENT_HEADER]:'Codex'};
      const response=await handleComputerUse(new Request('http://127.0.0.1/test',{method:'POST',headers,body:JSON.stringify(body)}),()=>runtime,{agent,authorized});return {status:response.status,body:await response.json() as any};
    };
    try{
      const initial=await request({operation:'scope-status'},true,true);const connection=initial.body.connection.id;
      expect((await request({operation:'scope-request-approval',connectionId:connection,scope:desktop,label:'test'},false,false)).status).toBe(403);
      expect((await request({operation:'scope-request-approval',connectionId:connection,scope:desktop,label:'test'},true,true)).status).toBe(400);
      expect((await request({operation:'scope-request-approval',connectionId:connection,scope:desktop,label:'test'},false,true)).body.state).toBe('pending');
      approved=true;const accepted=await request({operation:'scope-status'},true,true);const {grant,epoch}=accepted.body.grants[0];
      expect((await request({operation:'scope-observe',grant,epoch},true,true,'d'.repeat(64))).status).toBe(400);expect(inputCount).toBe(0);
      const observed=await request({operation:'scope-observe',grant,epoch},true,true);expect(observed.body.observation.scope).toEqual(desktop);expect(inputCount).toBe(1);
    }finally{runtime.dispose();recovery.close();}
  });
  test('switched-on limits equal native ControlLimits; the window grant keeps its 10 minutes and 64 actions',()=>{
    const swift=readFileSync(new URL('../native/computer-use/Sources/ComputerUseControlCore/ControlProtocol.swift',import.meta.url),'utf8');
    const literal=(name:string)=>Number(swift.match(new RegExp(`static let ${name}(?:: Int64)? = ([0-9_]+)\\n`))?.[1]?.replaceAll('_',''));
    expect(literal('scopeGrantMs')).toBe(COMPUTER_USE_SCOPE_LIMITS.grantMs);expect<number>(COMPUTER_USE_SCOPE_LIMITS.grantMs).toBe(30*86_400_000);
    expect(literal('scopeReceiptsKept')).toBe(COMPUTER_USE_SCOPE_LIMITS.receiptsKept);expect(literal('scopeActionsPerGrant')).toBe(COMPUTER_USE_SCOPE_LIMITS.actionsPerGrant);
    expect(literal('grantMs')).toBe(600_000);expect(literal('receiptsPerGrant')).toBe(64);expect(COMPUTER_USE_LIMITS.lifetimeMs).toBe(600_000);
    // The signed approval's own window is still the request (10 min), never the grant's lifetime.
    const c=caller(),v=new ComputerScopeApprovalVerifier(()=>100000);expect(v.request(c.identity,desktop,'scope',owner).expiresAt).toBe(700000);
  });
  test('a switched-on grant has no 64-action cap; old receipts are dropped but their IDs never run again',async()=>{
    const k=keys(),recovery=new ComputerUseRecovery(':memory:');let pending:any,approved=false,count=0,snap=0;
    const channel={available:true,dispose(){},retire(_body:any){},async request(body:any):Promise<any>{
      if(body.operation==='scope-status')return {success:true,scopeProtocolVersion:2,operations:[...COMPUTER_USE_SCOPE_OPERATIONS],accessibility:true,screenRecording:true,secureInput:false,owner};
      if(body.operation==='scope-request-approval'){pending={...body,owner};return {success:true,state:'pending'};}
      if(body.operation==='scope-approval-status')return approved?{success:true,state:'approved',approval:signed(pending,k),helperPublicKey:k.point.toString('base64')}:{success:true,state:'pending'};
      if(body.operation==='scope-open-grant')return {success:true,bound:true,grant:'b'.repeat(32),expiresAt:Date.now()+COMPUTER_USE_SCOPE_LIMITS.grantMs,scopeProtocolVersion:2,operations:[...COMPUTER_USE_SCOPE_OPERATIONS],scope:body.scope,permissions:[...COMPUTER_USE_SCOPE_PERMISSIONS]};
      if(body.operation==='scope-observe')return {success:true,snapshotId:`snap_${++snap}`,scope:desktop,applications:[],displays:[],foreground:null};
      if(body.operation==='scope-key'){count++;return {success:true,receipt:{requestId:body.requestId,state:'confirmed'}};}
      return {success:true};
    }};
    const runtime=new ComputerUseRuntime(channel,recovery,elsewhere),instance='e'.repeat(64);try{
      const initial=await runtime.agent(instance,'Codex',{operation:'scope-status'});await runtime.manage({operation:'scope-request-approval',connectionId:initial.connection.id,scope:desktop,label:'test'});approved=true;
      const ready=await runtime.agent(instance,'Codex',{operation:'scope-status'}),{grant,epoch}=ready.grants[0];
      expect(ready.grants[0].expiresAt).toBeGreaterThan(Date.now()+29*86_400_000);
      const key=async(requestId:string)=>{const obs=await runtime.agent(instance,'Codex',{operation:'scope-observe',grant,epoch});return runtime.agent(instance,'Codex',{operation:'scope-key',grant,epoch,observationId:obs.observationId,requestId,key:'Enter',modifiers:[]});};
      const receipt=(requestId:string)=>runtime.agent(instance,'Codex',{operation:'scope-receipt',grant,epoch,requestId});
      const total=COMPUTER_USE_SCOPE_LIMITS.receiptsKept+20;
      for(let n=0;n<total;n++)expect((await key(`request_key_${n}`)).receipt.state).toBe('confirmed');
      expect(count).toBe(total);expect(total).toBeGreaterThan(64);
      expect((await receipt(`request_key_${total-1}`)).receipt).toEqual({requestId:`request_key_${total-1}`,state:'confirmed'});
      expect((await receipt('request_key_20')).receipt.state).toBe('confirmed');
      // A dropped receipt is never answered as absent: the AI must not read it as safe to send again.
      const old=await receipt('request_key_19');expect(old.receipt).toEqual({requestId:'request_key_19',state:'evicted'});expect(old.guidance).toContain('다시 보내지 말고');
      await expect(receipt('request_never_used')).rejects.toThrow('영수증이 없습니다');
      for(const reused of ['request_key_0','request_key_19']){
        const fresh=await runtime.agent(instance,'Codex',{operation:'scope-observe',grant,epoch}),before=count;
        const again=await runtime.agent(instance,'Codex',{operation:'scope-key',grant,epoch,observationId:fresh.observationId,requestId:reused,key:'Tab',modifiers:[]});
        expect(again.receipt).toEqual({requestId:reused,state:'evicted'});expect(count).toBe(before);
        // The refused reuse consumed nothing: the same observation still serves a new request.
        expect((await runtime.agent(instance,'Codex',{operation:'scope-key',grant,epoch,observationId:fresh.observationId,requestId:`${reused}_next`,key:'Tab',modifiers:[]})).receipt.state).toBe('confirmed');
      }
      expect(count).toBe(total+2);expect(recovery.pendingScope()).toHaveLength(0);
    }finally{runtime.dispose();recovery.close();}
  });
  test('after an approval\'s action bound the grant ends before dispatch, so the AI asks the person again',async()=>{
    const k=keys(),recovery=new ComputerUseRecovery(':memory:'),retired:any[]=[];let pending:any,count=0,snap=0;
    const channel={available:true,dispose(){},retire(body:any){retired.push(body);},async request(body:any):Promise<any>{
      if(body.operation==='scope-status')return {success:true,scopeProtocolVersion:2,operations:[...COMPUTER_USE_SCOPE_OPERATIONS],accessibility:true,screenRecording:true,secureInput:false,owner};
      if(body.operation==='scope-request-approval'){pending={...body,owner};return {success:true,state:'pending'};}
      if(body.operation==='scope-approval-status')return {success:true,state:'approved',approval:signed(pending,k),helperPublicKey:k.point.toString('base64')};
      if(body.operation==='scope-open-grant')return {success:true,bound:true,grant:'b'.repeat(32),expiresAt:Date.now()+COMPUTER_USE_SCOPE_LIMITS.grantMs,scopeProtocolVersion:2,operations:[...COMPUTER_USE_SCOPE_OPERATIONS],scope:body.scope,permissions:[...COMPUTER_USE_SCOPE_PERMISSIONS]};
      if(body.operation==='scope-observe')return {success:true,snapshotId:`snap_${++snap}`,scope:desktop,applications:[],displays:[],foreground:null};
      if(body.operation==='scope-key'){count++;return {success:true,receipt:{requestId:body.requestId,state:'confirmed'}};}
      return {success:true};
    }};
    // The real bound is 100,000 actions; a small one exercises the same path.
    const c=caller(),host=new ComputerUseScopeHost(channel as any,recovery,Date.now,elsewhere.callerHost,{grantMs:COMPUTER_USE_SCOPE_LIMITS.grantMs,receiptsKept:2,actionsPerGrant:3});
    try{
      await host.requestApproval(c.identity,'mcp_test_session',desktop,'test');
      const {grant,epoch}=(await host.agent(c.identity,{operation:'scope-status'})).grants[0];
      const key=async(requestId:string)=>{const obs=await host.agent(c.identity,{operation:'scope-observe',grant,epoch});return host.agent(c.identity,{operation:'scope-key',grant,epoch,observationId:obs.observationId,requestId,key:'Enter',modifiers:[]});};
      for(const n of [1,2,3])expect((await key(`request_key_00${n}`)).receipt.state).toBe('confirmed');
      expect((await host.agent(c.identity,{operation:'scope-receipt',grant,epoch,requestId:'request_key_001'})).receipt.state).toBe('evicted');
      expect((await host.agent(c.identity,{operation:'scope-receipt',grant,epoch,requestId:'request_key_002'})).receipt.state).toBe('confirmed');
      await expect(key('request_key_004')).rejects.toThrow('다시 승인을 요청하세요');
      expect(count).toBe(3);expect((await host.managementStatus()).grants).toHaveLength(0);
      expect(retired.some(b=>b.operation==='scope-revoke'&&b.grant==='b'.repeat(32))).toBe(true);
    }finally{host.dispose();recovery.close();}
  });
  test('one human approval binds same connection, observation and receipt; unknown blocks both modes',async()=>{
    const k=keys(),recovery=new ComputerUseRecovery(':memory:');let pending:any,approved=false,invalidApplication=true,captureOrigin=0,captureRefusal:string|undefined;const sent:string[]=[];
    const channel={available:true,dispose(){},retire(_body:any){},async request(body:any):Promise<any>{sent.push(body.operation);
      if(body.operation==='status')return {success:true,protocolVersion:1,workerProtocol:2,backgroundOnly:true,accessibility:true,secureInput:false,operations:['capture','click']};
      if(body.operation==='scope-status')return {success:true,scopeProtocolVersion:2,operations:[...COMPUTER_USE_SCOPE_OPERATIONS],accessibility:true,screenRecording:true,secureInput:false,owner};
      if(body.operation==='scope-request-approval'){pending={...body,owner};return {success:true,state:'pending'};}
      if(body.operation==='scope-approval-status')return approved?{success:true,state:'approved',approval:signed(pending,k),helperPublicKey:k.point.toString('base64')}:{success:true,state:'pending'};
      if(body.operation==='scope-open-grant')return {success:true,bound:true,grant:'b'.repeat(32),expiresAt:Date.now()+590000,scopeProtocolVersion:2,operations:[...COMPUTER_USE_SCOPE_OPERATIONS],scope:body.scope,permissions:[...COMPUTER_USE_SCOPE_PERMISSIONS]};
      if(body.operation==='scope-observe')return {success:true,snapshotId:'snap_1',scope:appScope,applications:[{id:'app_1',name:'Orca',bundleId:app.bundleId,...(invalidApplication?{path:'/private/secret'}:{})}],displays:[{id:'display_1',originX:-1600,originY:0,width:1600,height:900,scale:2,rotation:0}],foreground:{applicationId:'app_1',bundleId:app.bundleId,pid:app.pid,processStart:app.processStart}};
      if(body.operation==='scope-capture'&&captureRefusal!==undefined)return {success:false,code:captureRefusal,notDispatched:true,halted:false};
      if(body.operation==='scope-capture')return {success:true,displayId:'display_1',mediaType:'image/jpeg',data:'/9j/2Q==',width:1280,height:720,displayWidth:1600,displayHeight:900,originX:captureOrigin,originY:0};
      if(body.operation==='scope-click')return {success:false,halted:true,notDispatched:false};
      return {success:true};
    }};
    const runtime=new ComputerUseRuntime(channel,recovery,elsewhere),instance='c'.repeat(64),instance2='d'.repeat(64);
    try{
      const initial=await runtime.agent(instance,'Codex',{operation:'scope-status'});const connection=initial.connection.id;
      await expect(runtime.agent(instance,'Codex',{operation:'scope-request-approval',scope:desktop})).rejects.toThrow();
      const created=await runtime.manage({operation:'scope-request-approval',connectionId:connection,scope:appScope,label:'test'}) as any;expect(created.state).toBe('pending');
      approved=true;const status=await runtime.agent(instance,'Codex',{operation:'scope-status'});expect(status.grants).toHaveLength(1);const grant=status.grants[0].grant,epoch=status.grants[0].epoch;
      await expect(runtime.agent(instance2,'Other',{operation:'scope-observe',grant,epoch})).rejects.toThrow();
      await expect(runtime.agent(instance,'Codex',{operation:'scope-observe',grant,epoch})).rejects.toThrow('앱 정보를');invalidApplication=false;
      const stale=await runtime.agent(instance,'Codex',{operation:'scope-observe',grant,epoch});
      await expect(runtime.agent(instance,'Codex',{operation:'scope-capture',grant,epoch,observationId:stale.observationId,displayId:'display_1'})).rejects.toThrow('화면 구성이');
      await expect(runtime.agent(instance,'Codex',{operation:'scope-click',grant,epoch,observationId:stale.observationId,displayId:'display_1',requestId:'request_stale_1',x:1,y:1,button:'left',clickCount:1})).rejects.toThrow();
      expect(sent.filter(x=>x==='scope-click')).toHaveLength(0);captureOrigin=-1600;
      const observed=await runtime.agent(instance,'Codex',{operation:'scope-observe',grant,epoch});
      // A native refusal names its code (as v1 does) and, being undispatched, leaves the grant usable.
      for(const [code,shown] of [['scope-app-unverifiable','scope-app-unverifiable'],['Not A Code','capture-failed']]){captureRefusal=code;
        await expect(runtime.agent(instance,'Codex',{operation:'scope-capture',grant,epoch,observationId:observed.observationId,displayId:'display_1'})).rejects.toThrow(`화면을 읽지 못했습니다: ${shown}`);}
      captureRefusal=undefined;
      const capture=await runtime.agent(instance,'Codex',{operation:'scope-capture',grant,epoch,observationId:observed.observationId,displayId:'display_1'});expect(capture.image.originX).toBe(-1600);
      const answer=await runtime.agent(instance,'Codex',{operation:'scope-click',grant,epoch,observationId:observed.observationId,displayId:'display_1',requestId:'request_click_1',x:10,y:20,button:'left',clickCount:1});
      expect(answer.receipt.state).toBe('unknown');expect(recovery.pendingScope()).toHaveLength(1);
      expect(()=>recovery.begin({bundleId:app.bundleId,windowId:1,operation:'press',requestId:'request_old',sessionId:'mcp_test_session',lane:'connection'})).toThrow();
      expect(sent.filter(x=>x==='scope-click')).toHaveLength(1);
      expect((await runtime.agent(instance,'Codex',{operation:'scope-receipt',grant,epoch,requestId:'request_click_1'})).receipt.state).toBe('unknown');
    }finally{runtime.dispose();recovery.close();}
  });
});

describe('caller host: a connection never drives the app its own AI runs in',()=>{
  test('the host is read from the loopback peer process ancestry, outermost app, and anything unclear is unknown',async()=>{
    expect(computerCallerOrigin({address:'127.0.0.1',port:50123})).toEqual({peerPort:50123});
    expect(computerCallerOrigin({address:'192.168.0.5',port:50123})).toBeNull();expect(computerCallerOrigin(null)).toBeNull();
    expect(lsofPeerPids('p4242\nf12\np300\np300\n',4242)).toEqual([300]);
    const ps=['  300   200 /Users/me/.local/bin/claude','  200   150 /bin/zsh','  150     1 /Applications/Orca.app/Contents/Frameworks/Orca Helper.app/Contents/MacOS/Orca Helper'].join('\n'),table=psProcessTable(ps);
    expect(outermostAppPath('/Applications/Orca.app/Contents/Frameworks/Orca Helper.app/Contents/MacOS/Orca Helper')).toBe('/Applications/Orca.app');
    expect(outermostAppPath('claude')).toBeNull();
    expect(callerAppPaths(300,table)).toEqual(['/Applications/Orca.app']);
    expect(callerAppPaths(999,table)).toBeNull();
    expect(callerAppPaths(5,new Map([[5,{ppid:6,command:'/a'}],[6,{ppid:5,command:'/b'}]]))).toBeNull();
    const runs:string[][]=[];
    const run=async(file:string,args:readonly string[])=>{runs.push([file,...args]);
      if(file==='/usr/sbin/lsof')return 'p4242\np300\n';if(file==='/bin/ps')return ps;if(file==='/usr/bin/plutil')return 'com.stablyai.orca\n';throw Error('unexpected');};
    expect(await createComputerCallerHostResolver({run,ownPid:4242,platform:'darwin'})({peerPort:50123})).toEqual({state:'known',bundleIds:['com.stablyai.orca']});
    expect(runs[0]).toEqual(['/usr/sbin/lsof','-nP','-iTCP@127.0.0.1:50123','-sTCP:ESTABLISHED','-Fp']);
    expect(runs[2]).toEqual(['/usr/bin/plutil','-extract','CFBundleIdentifier','raw','-o','-','/Applications/Orca.app/Contents/Info.plist']);
    expect(await createComputerCallerHostResolver({run,ownPid:4242,platform:'darwin'})(null)).toEqual({state:'unknown',reason:'origin-missing'});
    expect(await createComputerCallerHostResolver({run:async()=>'p1\np2\n',ownPid:9,platform:'darwin'})({peerPort:1})).toEqual({state:'unknown',reason:'peer-ambiguous'});
    expect(await createComputerCallerHostResolver({run,ownPid:4242,platform:'win32'})({peerPort:1})).toEqual({state:'unknown',reason:'unsupported-platform'});
    expect(await createComputerCallerHostResolver({run:async(file,args)=>file==='/usr/bin/plutil'?'not a bundle!':run(file,args),ownPid:4242,platform:'darwin'})({peerPort:1})).toEqual({state:'unknown',reason:'bundle-unreadable'});
    expect(callerHostOwns({state:'known',bundleIds:['com.StablyAI.orca']},'com.stablyai.orca')).toBe(true);
    expect(callerHostOwns({state:'unknown',reason:'x'},'com.stablyai.orca')).toBe(false);
  });
  const codexApp={...app,bundleId:'com.openai.codex',pid:777,processStart:'777001'};
  function scoped(k:ReturnType<typeof keys>,scope:any){
    const state={pending:undefined as any,approved:false,sent:[] as string[],foreground:null as any};
    const channel={available:true,dispose(){},retire(_body:any){},async request(body:any):Promise<any>{state.sent.push(body.operation);
      if(body.operation==='scope-status')return {success:true,scopeProtocolVersion:2,operations:[...COMPUTER_USE_SCOPE_OPERATIONS],accessibility:true,screenRecording:true,secureInput:false,owner};
      if(body.operation==='scope-request-approval'){state.pending={...body,owner};return {success:true,state:'pending'};}
      if(body.operation==='scope-approval-status')return state.approved?{success:true,state:'approved',approval:signed(state.pending,k),helperPublicKey:k.point.toString('base64')}:{success:true,state:'pending'};
      if(body.operation==='scope-open-grant')return {success:true,bound:true,grant:'b'.repeat(32),expiresAt:Date.now()+590000,scopeProtocolVersion:2,operations:[...COMPUTER_USE_SCOPE_OPERATIONS],scope:body.scope,permissions:[...COMPUTER_USE_SCOPE_PERMISSIONS]};
      if(body.operation==='scope-observe')return {success:true,snapshotId:'snap_1',scope,displays:[{id:'display_1',originX:0,originY:0,width:100,height:100,scale:2,rotation:0}],foreground:state.foreground,
        applications:scope.kind==='application'?[{id:'app_1',name:'Orca',bundleId:app.bundleId}]:[{id:'app_1',name:'Orca',bundleId:app.bundleId},{id:'app_2',name:'Codex',bundleId:codexApp.bundleId}]};
      if(body.operation==='scope-capture')return {success:true,displayId:body.displayId,mediaType:'image/jpeg',data:'AAAA',width:200,height:200,displayWidth:100,displayHeight:100,originX:0,originY:0};
      if(['scope-click','scope-type-text','scope-key','scope-focus-app'].includes(body.operation))return {success:true,receipt:{requestId:body.requestId,state:'confirmed'}};
      return {success:true};
    }};
    return {state,channel};
  }
  test('the host is read once at registration from the server-side origin; an application scope on it never reaches Control',async()=>{
    const k=keys(),recovery=new ComputerUseRecovery(':memory:'),{state,channel}=scoped(k,appScope),origins:(ComputerCallerOrigin|null)[]=[];
    let host:ComputerCallerHost={state:'known',bundleIds:[codexApp.bundleId]};
    const runtime=new ComputerUseRuntime(channel,recovery,{callerHost:async origin=>{origins.push(origin);return host;}}),instance='1'.repeat(64);
    try{
      const initial=await runtime.agent(instance,'Codex',{operation:'scope-status'},{peerPort:50001});await runtime.agent(instance,'Codex',{operation:'scope-status'},{peerPort:50002});
      expect(origins).toEqual([{peerPort:50001}]);
      await expect(runtime.manage({operation:'scope-request-approval',connectionId:initial.connection.id,scope:{kind:'application',application:codexApp},label:'test'})).rejects.toThrow('자기 호스트');
      expect(state.sent).not.toContain('scope-request-approval');
      // Another app is fine; the host the connection registered with stays its host, a later answer does not move it.
      expect((await runtime.manage({operation:'scope-request-approval',connectionId:initial.connection.id,scope:appScope,label:'test'}) as any).state).toBe('pending');
      state.approved=true;state.foreground={applicationId:'app_1',bundleId:app.bundleId,pid:app.pid,processStart:app.processStart};
      const {grant,epoch}=(await runtime.agent(instance,'Codex',{operation:'scope-status'})).grants[0];
      host={state:'known',bundleIds:[app.bundleId]};
      expect((await runtime.agent(instance,'Codex',{operation:'scope-observe',grant,epoch})).observation.scope).toEqual(appScope);
      expect(origins).toHaveLength(1);
    }finally{runtime.dispose();recovery.close();}
    const unknownRecovery=new ComputerUseRecovery(':memory:'),unknown=new ComputerUseRuntime(scoped(k,appScope).channel,unknownRecovery);
    try{const initial=await unknown.agent('2'.repeat(64),'Codex',{operation:'scope-status'});
      await expect(unknown.manage({operation:'scope-request-approval',connectionId:initial.connection.id,scope:appScope,label:'test'})).rejects.toThrow('확인하지 못해');
    }finally{unknown.dispose();unknownRecovery.close();}
  });
  test('desktop input never focuses or types into the host, but the AI can focus another app to leave it; an unknown host may observe but never send input',async()=>{
    const k=keys(),recovery=new ComputerUseRecovery(':memory:'),{state,channel}=scoped(k,desktop);
    const runtime=new ComputerUseRuntime(channel,recovery,{callerHost:async()=>({state:'known',bundleIds:[codexApp.bundleId]})}),instance='3'.repeat(64);
    const input=['scope-click','scope-type-text','scope-key','scope-focus-app'];
    try{
      const initial=await runtime.agent(instance,'Codex',{operation:'scope-status'});await runtime.manage({operation:'scope-request-approval',connectionId:initial.connection.id,scope:desktop,label:'test'});state.approved=true;
      const {grant,epoch}=(await runtime.agent(instance,'Codex',{operation:'scope-status'})).grants[0];
      // The AI's own host is the foreground: nothing may be clicked, typed or keyed into it, and it cannot be refocused.
      state.foreground={applicationId:'app_2',bundleId:codexApp.bundleId,pid:codexApp.pid,processStart:codexApp.processStart};
      let obs=await runtime.agent(instance,'Codex',{operation:'scope-observe',grant,epoch});
      await runtime.agent(instance,'Codex',{operation:'scope-capture',grant,epoch,observationId:obs.observationId,displayId:'display_1'});
      const from={grant,epoch,observationId:obs.observationId};
      await expect(runtime.agent(instance,'Codex',{operation:'scope-click',...from,displayId:'display_1',requestId:'request_host_click',x:10,y:10,button:'left',clickCount:1})).rejects.toThrow('자기 호스트');
      await expect(runtime.agent(instance,'Codex',{operation:'scope-type-text',...from,requestId:'request_host_text',text:'hello'})).rejects.toThrow('자기 호스트');
      await expect(runtime.agent(instance,'Codex',{operation:'scope-key',...from,requestId:'request_host_key1',key:'Enter',modifiers:[]})).rejects.toThrow('자기 호스트');
      await expect(runtime.agent(instance,'Codex',{operation:'scope-focus-app',...from,requestId:'request_host_focus',applicationId:'app_2'})).rejects.toThrow('자기 호스트');
      expect(state.sent.filter(op=>input.includes(op))).toHaveLength(0);
      // Focusing another app is how the AI leaves its host; Control still judges the foreground and overlays itself.
      expect((await runtime.agent(instance,'Codex',{operation:'scope-focus-app',...from,requestId:'request_leave_host',applicationId:'app_1'})).receipt.state).toBe('confirmed');
      expect(state.sent.filter(op=>input.includes(op))).toEqual(['scope-focus-app']);
      // Away from the host, input works and focusing the host stays refused.
      state.foreground={applicationId:'app_1',bundleId:app.bundleId,pid:app.pid,processStart:app.processStart};
      obs=await runtime.agent(instance,'Codex',{operation:'scope-observe',grant,epoch});
      await expect(runtime.agent(instance,'Codex',{operation:'scope-focus-app',grant,epoch,observationId:obs.observationId,requestId:'request_host_focus2',applicationId:'app_2'})).rejects.toThrow('자기 호스트');
      expect((await runtime.agent(instance,'Codex',{operation:'scope-key',grant,epoch,observationId:obs.observationId,requestId:'request_other_key',key:'Enter',modifiers:[]})).receipt.state).toBe('confirmed');
      expect(state.sent.filter(op=>input.includes(op))).toEqual(['scope-focus-app','scope-key']);
    }finally{runtime.dispose();recovery.close();}
    const blind=scoped(k,desktop),blindRecovery=new ComputerUseRecovery(':memory:'),unknown=new ComputerUseRuntime(blind.channel,blindRecovery),other='4'.repeat(64);
    try{const initial=await unknown.agent(other,'Codex',{operation:'scope-status'});await unknown.manage({operation:'scope-request-approval',connectionId:initial.connection.id,scope:desktop,label:'test'});blind.state.approved=true;
      const {grant,epoch}=(await unknown.agent(other,'Codex',{operation:'scope-status'})).grants[0];const obs=await unknown.agent(other,'Codex',{operation:'scope-observe',grant,epoch});
      await expect(unknown.agent(other,'Codex',{operation:'scope-key',grant,epoch,observationId:obs.observationId,requestId:'request_blind_key',key:'Enter',modifiers:[]})).rejects.toThrow('확인하지 못해');
      expect(blind.state.sent).not.toContain('scope-key');
    }finally{unknown.dispose();blindRecovery.close();}
  });
  test('the HTTP handler passes only the server-side socket origin to the runtime',async()=>{
    const recovery=new ComputerUseRecovery(':memory:'),origins:(ComputerCallerOrigin|null)[]=[];
    const channel={available:true,dispose(){},retire(_body:any){},async request():Promise<any>{return {success:false,code:'invalid-request',notDispatched:true};}};
    const runtime=new ComputerUseRuntime(channel,recovery,{callerHost:async origin=>{origins.push(origin);return {state:'unknown',reason:'test'};}});
    try{
      const headers={'Content-Type':'application/json',[COMPUTER_USE_INSTANCE_HEADER]:'5'.repeat(64),[COMPUTER_USE_CLIENT_HEADER]:'Codex'};
      expect((await handleComputerUse(new Request('http://127.0.0.1/test',{method:'POST',headers,body:JSON.stringify({operation:'status'})}),()=>runtime,{agent:true,authorized:true,origin:{peerPort:50777}})).status).toBe(200);
      expect(origins).toEqual([{peerPort:50777}]);
    }finally{runtime.dispose();recovery.close();}
  });
});
