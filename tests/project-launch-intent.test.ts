import {expect,test} from 'bun:test';
import {createHash} from 'node:crypto';
import {createProjectCreationIntentStore,projectCreationIntentFingerprint} from '../src/projectLaunchIntent';
import {RemoteControlCore,REMOTE_CONTROL_PROTOCOL_VERSION,type RemoteControlActionRequest} from '../src/remoteControlCore';
import type {RemoteControlGateway} from '../src/remoteControlCore';
const input={hostId:'host-1',controllerId:'controller-1',workspaceRootId:'opaque-root-1',projectName:'비공개 프로젝트'};
function fixture(){const data=new Map<string,string>();let n=0;const storage={getItem:(key:string)=>data.get(key)??null,setItem:(key:string,value:string)=>{data.set(key,value);}};return{data,storage,make:()=>createProjectCreationIntentStore(storage,()=>`request-${++n}`)};}
test('LAN fingerprint matches SHA-256 for Unicode and multiple blocks without SubtleCrypto',()=>{
  for(const value of ['', 'abc',JSON.stringify(input),'한글🔎'.repeat(200)])expect(projectCreationIntentFingerprint(value)).toBe(createHash('sha256').update(value).digest('hex'));
});
test('uncertain creation reuses durable ID after client reload and scopes exact host/controller/root/name',()=>{
  const f=fixture(),first=f.make().reserve(input);
  expect(f.make().reserve(input)).toEqual(first);
  for(const key of ['hostId','controllerId','workspaceRootId','projectName'] as const)expect(f.make().reserve({...input,[key]:input[key]+'-other'}).actionId).not.toBe(first.actionId);
  const text=[...f.data.values()].join();for(const value of Object.values(input))expect(text).not.toContain(value);
  f.make().complete(first,'unrelated-result');expect(f.make().reserve(input)).toEqual(first);
  f.make().complete(first,first.actionId);expect(f.make().reserve(input).actionId).not.toBe(first.actionId);
});
test('deliberate draft edits retire only that intent and storage errors fail before dispatch',()=>{
  const f=fixture(),first=f.make().reserve(input),other=f.make().reserve({...input,hostId:'other'});
  f.make().discardChangedInput(input);expect(f.make().reserve(input).actionId).not.toBe(first.actionId);expect(f.make().reserve({...input,hostId:'other'})).toEqual(other);
  const failing=createProjectCreationIntentStore({getItem:()=>null,setItem:()=>{throw Error('quota');}},()=> 'request-new');expect(()=>failing.reserve(input)).toThrow('저장');
  f.data.set('agentstoz-project-create-intents-v1','bad');expect(()=>f.make().reserve(input)).toThrow('확인');
});
test('bounded unresolved intent registry never evicts an old uncertain request',()=>{
  const f=fixture();for(let i=0;i<32;i++)f.make().reserve({...input,projectName:'name-'+i});
  const first=f.make().reserve({...input,projectName:'name-0'});expect(()=>f.make().reserve({...input,projectName:'overflow'})).toThrow('미확정');expect(f.make().reserve({...input,projectName:'name-0'})).toEqual(first);
});
test('same pairing restores exact opaque project and workspace root across sidecar restart, another pairing differs',async()=>{
  const gateway:RemoteControlGateway={listRegisteredProjects:()=>[{internalId:'registered-project',name:'project',kind:'main',folderPath:'/fixture/project',command:null,port:null,status:'unknown',actions:['folder.open']}],executeRegisteredProjectAction:()=>{},listWorkspaceRoots:()=>[{internalId:'registered-root',name:'root'}]};
  const core=new RemoteControlCore(gateway,{hostName:'fixture'}),url=new URL(core.enable('http://192.168.1.20:43210').pairingUrl);
  const ready=await core.pair(new URLSearchParams(url.hash.slice(1)).get('pair')!);
  const rootsRequest=(token:string):RemoteControlActionRequest=>({type:'action.request',protocolVersion:REMOTE_CONTROL_PROTOCOL_VERSION,sessionToken:token,action:'workspace-roots.list',actionId:'roots'});
  const roots=await core.perform(rootsRequest(ready.sessionToken));
  const restarted=new RemoteControlCore(gateway,{hostName:'fixture'});restarted.enable('http://192.168.1.20:54321');restarted.restoreSessions(core.exportSessions());
  const restored=await restarted.restore(ready.sessionToken),restoredRoots=await restarted.perform(rootsRequest(ready.sessionToken));
  expect(restored.projects[0]?.controlId).toBe(ready.projects[0]?.controlId);expect(restoredRoots).toEqual(roots);
  const secondUrl=new URL(restarted.rotatePairing('http://192.168.1.20:54321').pairingUrl),other=await restarted.pair(new URLSearchParams(secondUrl.hash.slice(1)).get('pair')!);
  expect(other.projects[0]?.controlId).not.toBe(ready.projects[0]?.controlId);
  const otherRoots=await restarted.perform(rootsRequest(other.sessionToken));expect(otherRoots).not.toEqual(roots);
  if(roots.ok&&'workspaceRoots'in roots)expect(roots.workspaceRoots[0]?.controlId).not.toBe(ready.projects[0]?.controlId);
});
