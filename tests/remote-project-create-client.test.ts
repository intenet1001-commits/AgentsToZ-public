import {expect,test} from 'bun:test';
import vm from 'node:vm';
import {REMOTE_CONTROL_MOBILE_JS} from '../src/remoteControlMobilePage';

let random = 0;
/** Actual emitted LAN create callbacks under HTTP-like crypto (no subtle). */
function fixture(storage=new Map<string,string>()){
  const helpers=REMOTE_CONTROL_MOBILE_JS.slice(REMOTE_CONTROL_MOBILE_JS.indexOf('const projectIntentFingerprint ='),REMOTE_CONTROL_MOBILE_JS.indexOf('let lastActionName ='));
  const handlers=REMOTE_CONTROL_MOBILE_JS.slice(REMOTE_CONTROL_MOBILE_JS.indexOf('function projectCreateDraftChanged()'),REMOTE_CONTROL_MOBILE_JS.indexOf('function sendAction(action, controlId'));
  const start=REMOTE_CONTROL_MOBILE_JS.indexOf("if(lastActionCode==='project.create'&&message.project){");
  const end=REMOTE_CONTROL_MOBILE_JS.indexOf('    notify(lastActionCode',start);
  expect(helpers.length).toBeGreaterThan(100);expect(handlers).toContain('currentProjectCreateIntent.actionId');expect(end).toBeGreaterThan(start);
  const sent:any[]=[],errors:string[]=[];
  const nodes:any={'#create-root':{value:'R'.repeat(43)},'#create-name':{value:'비공개 프로젝트'},'#create-project':{},'#terminal-project':{dispatchEvent(){}}};
  for(const node of Object.values(nodes) as any[])node.addEventListener=(name:string,fn:any)=>{node[name]=fn;};
  const context=vm.createContext({TextEncoder,Uint8Array,Int32Array,DataView,Map,Set,JSON,Date,Error,
    crypto:{getRandomValues:(a:Uint8Array)=>{a.fill(++random);return a;}},
    location:{host:'192.168.1.20:54321'},localStorage:{getItem:(k:string)=>storage.get(k)??null,setItem:(k:string,v:string)=>{storage.set(k,v);}},
    document:{querySelector:(id:string)=>nodes[id]},socket:{readyState:1,send:(message:string)=>sent.push(JSON.parse(message))},WebSocket:{OPEN:1},
    sessionToken:'private-fixture-pairing-bearer',inFlight:false,workspaceRoots:[{controlId:'R'.repeat(43)}],projects:[],PROTOCOL_VERSION:7,lastActionCode:'',lastActionName:'',
    recordError:(_context:string,error:Error)=>errors.push(error.message),notify:()=>{},terminalReady:()=>{},showWorkspaceTab:()=>{},Event:class{constructor(readonly type:string){}},
  });
  vm.runInContext(`function setBusy(value){inFlight=value;} ${helpers} ${handlers} function received(message){${REMOTE_CONTROL_MOBILE_JS.slice(start,end)}}`,context);
  return{storage,sent,errors,click:()=>nodes['#create-project'].onclick(),release:()=>vm.runInContext('inFlight=false',context),success:(id:string)=>{(context as any).message={actionId:id,project:{controlId:'P'.repeat(43)}};vm.runInContext('received(message)',context);},name:(name:string)=>{nodes['#create-name'].value=name;nodes['#create-name'].input();}};
}
test('LAN click uses durable same intent after timeout/reload, clears matching success only and keeps bearer/name out of storage',()=>{
  const first=fixture();first.click();const id=first.sent[0].actionId;first.release();first.click();expect(first.sent[1].actionId).toBe(id);
  const reloaded=fixture(first.storage);reloaded.click();expect(reloaded.sent[0].actionId).toBe(id);
  reloaded.success('unmatched');reloaded.release();reloaded.click();expect(reloaded.sent[1].actionId).toBe(id);
  reloaded.success(id);reloaded.release();reloaded.click();expect(reloaded.sent[2].actionId).not.toBe(id);
  const serialized=[...first.storage.values()].join();expect(serialized).not.toContain('private-fixture-pairing-bearer');expect(serialized).not.toContain('비공개 프로젝트');expect(first.errors).toEqual([]);expect(reloaded.errors).toEqual([]);
});
test('LAN explicit draft change retires the old intent without clearing another pending result',()=>{
  const f=fixture();f.click();const id=f.sent[0].actionId;f.release();f.name('다른 프로젝트');f.click();expect(f.sent[1].actionId).not.toBe(id);f.release();f.name('비공개 프로젝트');f.click();expect(f.sent[2].actionId).not.toBe(id);
});
