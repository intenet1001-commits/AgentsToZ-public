import {afterEach,expect,test} from 'bun:test';
import {createHash,createHmac} from 'node:crypto';
import {existsSync,mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ShadowLoopUseConnector,SHADOWLOOP_USE_REVISION} from '../src/shadowLoopUseAdapter';
import {WorkroomThreadStore} from '../src/workroomThreadStore';
import {SERVICE_USE_TOOLS,type ServiceUseBinding} from '../src/serviceUseProtocol';
import {SERVICE_USE_ENVIRONMENT_PROBLEM,serviceUseConnectProblem,serviceUseEnvironmentProblem} from '../src/serviceUseHost';

const roots:string[]=[];afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
const installation='11111111-1111-4111-8111-111111111111',grant='22222222-2222-4222-8222-222222222222',secret='X'.repeat(43),code=`SLUSE1.${installation}.${grant}.${secret}`;
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const key=Buffer.from(hash(secret),'hex');
function fixture(){
 const root=mkdtempSync(join(tmpdir(),'shadowloop-adapter-'));roots.push(root);
 const vault=new WorkroomThreadStore(join(root,'vault'),{read:async()=>Buffer.alloc(32,7),create:async()=>Buffer.alloc(32,7)});
 const scope={principalId:'profile-one',libraryId:'library-one',deviceId:installation,installationId:installation,grantRevision:grant};
 const calls:{url:string;operation:string;body:any;headers:Headers}[]=[];
 let wrongProof=false,app='shadowloop',fail=false;
 const send=(async(url:string|URL|Request,init?:RequestInit)=>{
  const operation=String(url).split('/').at(-1)!,headers=new Headers(init?.headers),body=JSON.parse(String(init?.body));calls.push({url:String(url),operation,body,headers});
  expect(init?.redirect).toBe('error');expect(headers.has('authorization')).toBe(false);expect(JSON.stringify([...headers])).not.toContain(secret);expect(String(init?.body)).not.toContain(secret);
  const expected=createHmac('sha256',key).update(`SLUSE1\n${operation}\n${headers.get('x-shadowloop-use-time')}\n${headers.get('x-shadowloop-use-nonce')}\n${hash(String(init?.body))}`).digest('hex');
  expect(headers.get('x-shadowloop-use-signature')).toBe(expected);
  if(fail)throw Error('lost after admission');
  const payload=operation==='scope'?{app,definitionRevision:SHADOWLOOP_USE_REVISION,tools:SERVICE_USE_TOOLS,scope,phones:[{id:'approved-phone-13',name:'아이폰13'}]}:{outcome:{state:'completed',message:'Verified existing app receipt',operationId:body.requestId}};
  const text=JSON.stringify(payload),proof=createHmac('sha256',key).update(`reply\n${headers.get('x-shadowloop-use-nonce')}\n${hash(text)}`).digest('hex');
  return new Response(text,{headers:{'Content-Type':'application/json','x-shadowloop-use-proof':wrongProof?'0'.repeat(64):proof}});
 }) as typeof fetch;
 const connector=()=>new ShadowLoopUseConnector(root,{vault,fetch:send});
 return {root,vault,scope,calls,connector,wrongProof:()=>{wrongProof=true;},wrongApp:()=>{app='untrusted';},fail:()=>{fail=true;}};
}
test('unconfigured ShadowLoop discovery creates no vault, key or connection',async()=>{
 const root=mkdtempSync(join(tmpdir(),'shadowloop-empty-'));roots.push(root);
 const connector=new ShadowLoopUseConnector(root);
 expect(await connector.adapter('project','default')).toBeUndefined();expect(existsSync(join(root,'shadowloop-use-connection'))).toBe(false);
});
test('an explicit connection verifies the installed app and stores its capability encrypted',async()=>{
 const f=fixture();await expect(f.connector().connect('project',code,false)).rejects.toThrow();expect(f.calls).toHaveLength(0);
 await f.connector().connect('project',code,true);
 expect(readFileSync(f.vault.file).includes(Buffer.from(code))).toBe(false);
 const restarted=await f.connector().adapter('project','default');expect(restarted).toBeDefined();
 expect(await restarted!.scope('local')).toEqual(f.scope);
 expect(await restarted!.phoneTargets!('local')).toEqual([{id:'approved-phone-13',name:'아이폰13'}]);
 await expect(restarted!.phoneTargets!('remote-controller')).rejects.toThrow('로컬');
 await expect(restarted!.scope('remote-controller')).rejects.toThrow('로컬');
 expect(await f.connector().adapter('other-project','default')).toBeUndefined();
 expect(await f.connector().adapter('project','other-service')).toBeUndefined();
});
test('each call uses the fixed endpoint and signed exact body; receipt lookup cannot execute work',async()=>{
 const f=fixture();await f.connector().connect('project',code,true);const adapter=(await f.connector().adapter('project','default'))!;
 const binding:ServiceUseBinding={...f.scope,role:'use',projectId:'project',serviceKey:'default',serviceMemoryId:'use-memory',definitionRevision:SHADOWLOOP_USE_REVISION,allowedTools:[...SERVICE_USE_TOOLS]};
 const call={role:'use' as const,serviceKey:'default',tool:'materials.generate' as const,input:{text:'Hello from an isolated fixture.'}};
 await adapter.execute(call,'original-request',binding,()=>true);await adapter.receipt!('original-request',binding,()=>true);
 expect(f.calls.every(c=>c.url.startsWith('http://127.0.0.1:8127/api/service-use/'))).toBe(true);
 expect(f.calls.map(c=>c.operation)).toEqual(['scope','execute','receipt']);
 expect(f.calls[1]!.body).toEqual({call,requestId:'original-request',binding});
 expect(f.calls[2]!.body).toEqual({requestId:'original-request',binding});
});
test('a spoofed reply or wrong app cannot register a product adapter',async()=>{
 const f=fixture();f.wrongProof();await expect(f.connector().connect('project',code,true)).rejects.toThrow('서명');
 expect(await f.connector().adapter('project','default')).toBeUndefined();
 const other=fixture();other.wrongApp();await expect(other.connector().connect('project',code,true)).rejects.toThrow('계약');
});
test('a lost app response is never retried and an inactive caller cannot submit',async()=>{
 const f=fixture();await f.connector().connect('project',code,true);const adapter=(await f.connector().adapter('project','default'))!;
 const binding:ServiceUseBinding={...f.scope,role:'use',projectId:'project',serviceKey:'default',serviceMemoryId:'use-memory',definitionRevision:SHADOWLOOP_USE_REVISION,allowedTools:[...SERVICE_USE_TOOLS]};
 f.fail();const call={role:'use' as const,serviceKey:'default',tool:'materials.generate' as const,input:{text:'Hello'}};
 await expect(adapter.execute(call,'original-request',binding,()=>true)).rejects.toThrow('원래 요청');expect(f.calls.filter(c=>c.operation==='execute')).toHaveLength(1);
 await expect(adapter.execute(call,'inactive-request',binding,()=>false)).rejects.toThrow();expect(f.calls.filter(c=>c.operation==='execute')).toHaveLength(1);
});
test('ShadowLoop connection failures map to a next step, and other failures stay generic',async()=>{
 const f=fixture();await f.connector().connect('project',code,true);const adapter=(await f.connector().adapter('project','default'))!;
 const remote=await adapter.scope('remote-controller').then(()=>null,e=>e);
 expect(serviceUseEnvironmentProblem(remote,'ShadowLoop','device:host:controller')).toBe('USE 실행은 지금 이 Mac에서만 할 수 있습니다. Mac의 작업 세션이나 커뮤니티에서 요청하세요.');
 f.fail();const down=await adapter.scope('local').then(()=>null,e=>e);
 expect(serviceUseEnvironmentProblem(down,'ShadowLoop','local')).toBe('ShadowLoop 앱이 응답하지 않습니다. 이 Mac에서 앱이 실행 중인지 확인한 뒤 다시 확인하세요.');
 expect(serviceUseConnectProblem(await f.connector().connect('project',code,true).then(()=>null,e=>e),'Renamed')).toBe('ShadowLoop 앱이 이 Mac에서 실행 중인지 확인한 뒤 다시 연결하세요.');
 const other=fixture();other.wrongApp();
 expect(serviceUseEnvironmentProblem(await other.connector().connect('project',code,true).then(()=>null,e=>e),'ShadowLoop','local')).toBe(SERVICE_USE_ENVIRONMENT_PROBLEM);
});
