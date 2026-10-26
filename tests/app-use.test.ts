import {afterEach,expect,test} from 'bun:test';
import {mkdtempSync,mkdirSync,readFileSync,realpathSync,rmSync,writeFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {AppUseConnector} from '../src/appUseConnector';
import {APP_USE_PYTHON_SDK} from '../src/appUsePythonSdk';
import {normalizeAppUseActions,type AppUseAction} from '../src/appUseCatalog';
import {prepareServiceUseWorkroom} from '../src/serviceUsePreparation';
import {ServiceUseHost,SERVICE_USE_ENVIRONMENT_PROBLEM,publicServiceUseStatus,serviceUseConnectProblem} from '../src/serviceUseHost';
import {WorkroomThreadStore} from '../src/workroomThreadStore';
import {ensureServiceMemory,migrateServiceMemoryToProject} from '../src/serviceMemory';
import {normalizeServiceUseCall,type ServiceUseCall} from '../src/serviceUseProtocol';

const roots:string[]=[],children:Bun.Subprocess[]=[];
afterEach(async()=>{for(const p of children.splice(0)){try{p.kill();}catch{}await p.exited;}for(const r of roots.splice(0))rmSync(r,{recursive:true,force:true});});
const keys={read:async()=>Buffer.alloc(32,7),create:async()=>Buffer.alloc(32,7)};
export const fixtureAction={id:'report.create',label:'보고서 만들기',effect:'write' as const,fields:[{key:'topic',label:'보고서 주제',type:'string' as const,required:true}]};
async function app(root:string,id:string,action:AppUseAction=fixtureAction){
  const home=join(root,id);mkdirSync(home);
  writeFileSync(join(home,'sdk.py'),APP_USE_PYTHON_SDK);
  const state=join(home,'scope.json');writeFileSync(state,JSON.stringify({principalId:'user-'+id,libraryId:'library-'+id,deviceId:'device-'+id}));
  const script=`from sdk import *
from pathlib import Path
root=Path(__file__).parent
def scope(): return json.loads((root/'scope.json').read_text())
def invoke(action,args,rid,active):
    active()
    file=root/'effects.json'
    rows=json.loads(file.read_text()) if file.exists() else []
    rows.append({'action':action,'arguments':args,'requestId':rid})
    file.write_text(json.dumps(rows))
    if args.get('topic')=='fail-after-write': raise RuntimeError('private/internal/path')
    if args.get('topic')=='finish-first':
        bridge.finish(rid,{'state':'completed','message':'Background result verified','operationId':rid})
        return {'state':'running','message':'Worker started','operationId':rid}
    return {'state':'completed','message':'App operation verified','operationId':rid}
bridge=AppUseBridge(${JSON.stringify(id)},str(root/'ledger.sqlite'),int(os.environ.get("FIXTURE_APP_PORT","0")),json.loads(${JSON.stringify(JSON.stringify([action]))}),scope,invoke)
server=bridge.server()
bridge.port=server.server_address[1]
print(json.dumps({'code':bridge.issue_code(),'port':bridge.port}),flush=True)
server.serve_forever()
`;
  writeFileSync(join(home,'app.py'),script);
  let child=Bun.spawn(['python3',join(home,'app.py')],{cwd:home,stdout:'pipe',stderr:'pipe'});children.push(child);
  const reader=child.stdout.getReader(),chunk=await Promise.race([reader.read(),new Promise<never>((_,reject)=>setTimeout(()=>reject(Error('app fixture did not start')),5000))]);
  if(chunk.done)throw Error(await new Response(child.stderr).text());
  const connection=JSON.parse(new TextDecoder().decode(chunk.value));reader.releaseLock();
  return {...connection,state,home,stop:async()=>{child.kill();await child.exited;},restart:async()=>{child.kill();await child.exited;child=Bun.spawn(['python3',join(home,'app.py')],{cwd:home,env:{...process.env,FIXTURE_APP_PORT:String(connection.port)},stdout:'pipe',stderr:'pipe'});children.push(child);const reader=child.stdout.getReader();const first=await reader.read();reader.releaseLock();if(first.done)throw Error(await new Response(child.stderr).text());},effects:()=>existsSync(join(home,'effects.json'))?JSON.parse(readFileSync(join(home,'effects.json'),'utf8')):[]};
}
async function fixture(){
  const root=realpathSync(mkdtempSync(join(tmpdir(),'app-use-')));roots.push(root);
  const vault=new WorkroomThreadStore(join(root,'vault'),keys),receipts=new WorkroomThreadStore(join(root,'receipts'),keys);
  let lose=false;const sends:string[]=[];
  const send=(async(url:any,init:any)=>{const response=await fetch(url,init);sends.push(String(url));if(lose&&String(url).endsWith('/execute')){await response.text();throw Error('lost response after app write');}return response;}) as typeof fetch;
  const connector=()=>new AppUseConnector(root,{vault,fetch:send});
  const projects=new Map<string,any>();
  for(const id of ['report-project','booking-project']){
    const canonicalPath=join(root,id+'-source');mkdirSync(canonicalPath);
    const memoryId='dev-'+id;projects.set(id,{projectId:id,projectName:id,memoryId,canonicalPath});
    ensureServiceMemory(root,{projectId:id,projectName:id,projectMemoryId:memoryId,canonicalPath,displayName:id});migrateServiceMemoryToProject(root,{projectId:id,projectMemoryId:memoryId});
  }
  const host=()=>new ServiceUseHost({appDataDir:root,receipts,resolve:async id=>projects.get(id),adapter:(id,key)=>connector().adapter(id,key)});
  const use=host();for(const id of projects.keys())await use.enable(id);
  const first=await app(root,'report-project'),second=await app(root,'booking-project',{...fixtureAction,id:'booking.lookup',label:'예약 확인',effect:'read'});
  return {root,vault,first,second,use,host,connector,sends,lose:()=>{lose=true;},recover:()=>{lose=false;}};
}
const call:ServiceUseCall={role:'use',serviceKey:'default',tool:'app.invoke',input:{actionId:'report.create',arguments:{topic:'Weekly report'}}};
test('Workroom preparation is project-bound, bounded and contains a runnable portable SDK without activating USE',()=>{
  const value=prepareServiceUseWorkroom({projectId:'registered-id',projectName:'My App',memoryId:'dev-memory',canonicalPath:'/private/source'},'보고서 작성');
  expect(value.projectId).toBe('registered-id');expect(value.prompt).toContain('ATZUSE1.');expect(value.prompt).toContain('AppUseBridge');expect(value.prompt).not.toContain('/private/source');
  expect(Buffer.byteLength(value.prompt)).toBeLessThan(24000);
  expect(()=>prepareServiceUseWorkroom({projectId:'x',projectName:'App',memoryId:'dev',canonicalPath:'/x'},'한'.repeat(1000))).toThrow('1,000');
});
test('unconnected discovery never creates a vault or starts an app',async()=>{
  const root=mkdtempSync(join(tmpdir(),'empty-use-'));roots.push(root);
  expect(await new AppUseConnector(root).adapter('project','default')).toBeUndefined();expect(existsSync(join(root,'app-use-connections'))).toBe(false);
});
test('two real local apps publish distinct catalogs and run only the selected project action',async()=>{
  const f=await fixture();
  await expect(f.connector().connect('report-project','default',f.first.code,false)).rejects.toThrow('동의');
  await expect(f.connector().connect('booking-project','default',f.first.code,true)).rejects.toThrow('프로젝트');
  await f.connector().connect('report-project','default',f.first.code,true);await f.connector().connect('booking-project','default',f.second.code,true);
  expect(readFileSync(f.vault.file).includes(Buffer.from(f.first.code))).toBe(false);
  expect((await f.use.status('report-project','local')).actions?.[0]?.id).toBe('report.create');
  expect((await f.use.status('booking-project','local')).actions?.[0]?.id).toBe('booking.lookup');
  const publicStatus=publicServiceUseStatus(await f.use.status('report-project','local'));
  expect(publicStatus.actions?.[0]?.id).toBe('report.create');expect(publicStatus.tools).toEqual(['app.invoke']);expect(JSON.stringify(publicStatus)).not.toContain(f.root);expect(publicStatus).not.toHaveProperty('serviceMemory');
  await expect(f.use.execute('booking-project','local','wrong-app-request',call,()=>true)).rejects.toThrow('허용');
  await expect(f.use.execute('report-project','local','wrong-input-request',{...call,input:{actionId:'report.create',arguments:{command:'rm -rf'}}},()=>true)).rejects.toThrow('허용');
  const result=await f.use.execute('report-project','local','original-request-id',call,()=>true);
  expect(result).toMatchObject({state:'completed',operationId:'original-request-id'});
  expect(await f.host().execute('report-project','local','original-request-id',call,()=>true)).toEqual(result);
  expect(await f.host().receipt('report-project','local','original-request-id',()=>true)).toEqual(result);
  expect(f.first.effects()).toHaveLength(1);expect(f.second.effects()).toHaveLength(0);
  expect((await f.host().status('report-project','other-user')).readiness).toMatchObject({executionReady:false,problem:'USE 실행은 지금 이 Mac에서만 할 수 있습니다. Mac의 작업 세션이나 커뮤니티에서 요청하세요.'});
},20000);
test('a lost acknowledgment survives host restart and queries the same app receipt without replay',async()=>{
  const f=await fixture();await f.connector().connect('report-project','default',f.first.code,true);f.lose();
  expect((await f.use.execute('report-project','local','lost-response-request',call,()=>true)).state).toBe('unknown');
  expect((await f.host().execute('report-project','local','lost-response-request',call,()=>true)).state).toBe('unknown');
  f.recover();expect((await f.host().receipt('report-project','local','lost-response-request',()=>true)).state).toBe('completed');
  expect(f.first.effects()).toHaveLength(1);expect(f.sends.filter(s=>s.endsWith('/execute'))).toHaveLength(1);
},20000);
test('an app error after an effect stays unknown and neither app nor host retries the write',async()=>{
  const f=await fixture();await f.connector().connect('report-project','default',f.first.code,true);
  const failed={...call,input:{actionId:'report.create',arguments:{topic:'fail-after-write'}}};
  const first=await f.use.execute('report-project','local','uncertain-app-request',failed,()=>true);
  expect(first.state).toBe('unknown');expect(JSON.stringify(first)).not.toContain('private/internal');
  await f.first.restart();
  expect((await f.host().receipt('report-project','local','uncertain-app-request',()=>true)).state).toBe('unknown');
  expect((await f.host().execute('report-project','local','uncertain-app-request',failed,()=>true)).state).toBe('unknown');expect(f.first.effects()).toHaveLength(1);
},20000);
test('a profile change and forged capability cannot authorize execution or expose raw connection errors',async()=>{
  const f=await fixture();await f.connector().connect('report-project','default',f.first.code,true);
  writeFileSync(f.first.state,JSON.stringify({principalId:'different-user',libraryId:'library-report-project',deviceId:'device-report-project'}));
  // The reference SDK refuses a changed profile outright (403): status keeps the generic line, never the raw error.
  expect((await f.use.status('report-project','local')).readiness).toMatchObject({executionReady:false,tools:'verified',problem:SERVICE_USE_ENVIRONMENT_PROBLEM});
  await expect(f.use.execute('report-project','local','changed-profile-request',call,()=>true)).rejects.toThrow();expect(f.first.effects()).toHaveLength(0);
  const forged=f.second.code.slice(0,-43)+'X'.repeat(43);
  await expect(f.connector().connect('booking-project','default',forged,true)).rejects.toThrow();
  expect(await f.connector().adapter('booking-project','default')).toBeUndefined();
},20000);
test('generic calls and catalogs reject nested arguments, excessive fields and unsupported schemas',()=>{
  expect(()=>normalizeServiceUseCall({...call,input:{actionId:'report.create',arguments:{nested:{shell:'command'}}}})).toThrow();
  expect(()=>normalizeServiceUseCall({...call,input:{actionId:'report.create',arguments:{topic:'x'},url:'https://example.test'}})).toThrow();
  expect(()=>normalizeAppUseActions([{...fixtureAction,fields:[{key:'source',label:'Source',type:'shell',required:true}]}])).toThrow();
  expect(()=>normalizeAppUseActions([fixtureAction,fixtureAction])).toThrow();
});

test('an early background completion is not overwritten by the worker-start acknowledgment',async()=>{
  const f=await fixture();await f.connector().connect('report-project','default',f.first.code,true);
  const asyncCall={...call,input:{actionId:'report.create',arguments:{topic:'finish-first'}}};
  const result=await f.use.execute('report-project','local','early-finish-request',asyncCall,()=>true);
  expect(result.state).toBe('completed');expect(result.message).toBe('Background result verified');expect(f.first.effects()).toHaveLength(1);
},20000);

test('a changed action list, a closed app and a code for another project get their own next step from the real connector',async()=>{
  const f=await fixture();
  const wrongProject=await f.connector().connect('booking-project','default',f.first.code,true).then(()=>null,e=>e);
  expect(serviceUseConnectProblem(wrongProject,'booking-project')).toBe('이 코드가 선택한 프로젝트와 맞지 않습니다. 위에서 프로젝트를 확인하거나 이 프로젝트의 앱에서 코드를 다시 발급하세요.');
  await f.connector().connect('report-project','default',f.first.code,true);
  // DEV changed the app's action list after USE was connected: the stored catalog no longer matches.
  const script=join(f.first.home,'app.py');writeFileSync(script,readFileSync(script,'utf8').replace('보고서 만들기','주간 보고서 만들기'));await f.first.restart();
  expect((await f.use.status('report-project','local')).readiness).toMatchObject({tools:'verified',environmentReady:false,problem:'앱의 동작 목록이나 사용자가 바뀌었습니다. 앱에서 연결 코드를 다시 발급해 Mac의 작업 세션 → USE 준비에 입력하세요.'});
  await f.first.stop();
  expect((await f.use.status('report-project','local')).readiness).toMatchObject({tools:'verified',environmentReady:false,problem:'report-project 앱이 응답하지 않습니다. 이 Mac에서 앱이 실행 중인지 확인한 뒤 다시 확인하세요.'});
  const closed=await f.connector().connect('report-project','default',f.first.code,true).then(()=>null,e=>e);
  expect(serviceUseConnectProblem(closed,'report-project')).toBe('코드를 발급한 앱이 이 Mac에서 실행 중인지 확인한 뒤 다시 연결하세요.');
},20000);
