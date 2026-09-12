import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {initialWorkspaceTab} from '../src/workspaceNavigation';
import {normalizeMobileWorkspaceRequest,normalizeMobileWorkspaceResult,workspaceScope} from '../src/mobileWorkspaceProtocol';
import {createMobileWorkspaceGateway} from '../src/mobileWorkspaceGateway';
import {MobileWorkspaceJobs} from '../src/mobileWorkspaceJobs';
const request={operation:'workspace' as const,requestId:'request_1234',targetId:'control_1234',workspace:{action:'said.list' as const}};
test('legacy links select internal screens without carrying credentials',()=>{
 for(const [search,tab] of [['?tab=ports','projects'],['?tab=memories','records'],['?tab=said','records'],['?tab=bookmarks','bookmarks'],['','home']] as const)expect(initialWorkspaceTab(search!)).toBe(tab);
});
test('workspace input denies paths, extra fields and unsigned duty enable',()=>{
 expect(normalizeMobileWorkspaceRequest(request)).toEqual(request);
 for(const extra of [{folderPath:'/tmp'}, {sessionToken:'secret'}])expect(()=>normalizeMobileWorkspaceRequest({...request,...extra})).toThrow();
 expect(()=>normalizeMobileWorkspaceRequest({...request,workspace:{action:'duty.enable',connectionId:'connect_1234',revision:1,knowledgeRevision:2}})).toThrow();
 expect(()=>normalizeMobileWorkspaceRequest({...request,workspace:{action:'said.list',beforeSeq:'1e3'}})).toThrow();
 expect(()=>normalizeMobileWorkspaceResult({kind:'workspace',action:'said.list',records:[],serviceRole:'secret'})).toThrow();
 expect(workspaceScope('said.list')).toBe('records.read');expect(workspaceScope('memory.save')).toBe('memory.save');
});
test('terminal consent alone never opens records, and scope cannot open another target',async()=>{
 let calls=0,scopes:string[]=[],permitted=true,live=true;
 const gateway=createMobileWorkspaceGateway({terminal:async()=>({sessions:[]}),active:()=>live,resolve:async()=>[{controlId:'control_1234',runtimeTargetId:'runtime_1234'}],consent:async()=>({targetIds:new Set(permitted?['runtime_1234']:[]),workspaceScopes:scopes as ['records.read'],isActive:()=>live,requestOwner:'device_1234'}),perform:async()=>{calls++;return {kind:'workspace',action:'said.list',records:[]}}});
 await expect(gateway(request,[],'owner')).rejects.toThrow();expect(calls).toBe(0);
 scopes=['records.read'];permitted=false;await expect(gateway(request,[],'owner')).rejects.toThrow();expect(calls).toBe(0);
 permitted=true;await gateway(request,[],'owner');expect(calls).toBe(1);
 live=false;await expect(gateway(request,[],'owner')).rejects.toThrow();expect(calls).toBe(1);
});
test('revocation while reading withholds the response',async()=>{
 let live=true;
 const gateway=createMobileWorkspaceGateway({terminal:async()=>({sessions:[]}),active:()=>true,resolve:async()=>[{controlId:'control_1234',runtimeTargetId:'runtime_1234'}],consent:async()=>({targetIds:new Set(['runtime_1234']),workspaceScopes:['records.read'],isActive:()=>live,requestOwner:'owner'}),perform:async()=>{live=false;return {kind:'workspace',action:'said.list',records:[]}}});
 await expect(gateway(request,[],'owner')).rejects.toThrow('권한이 변경');
});
test('save admission survives retry and restart without a second AI run',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'mobile-workspace-'));let calls=0;let finish!:(v:any)=>void;
 try{
 const store=new MobileWorkspaceJobs(dir);const run=()=>{calls++;return new Promise<any>(r=>{finish=r})};
 expect((await store.start('owner','target','request_1234',run)).state).toBe('saving');
 expect((await store.start('owner','target','request_1234',run)).state).toBe('saving');expect(calls).toBe(1);
 expect(new MobileWorkspaceJobs(dir).status('owner','target').state).toBe('recovery-required');
 await expect(store.start('owner','different','request_1234',run)).rejects.toThrow();
 finish({state:'saved',localSaved:true,backupSaved:false,message:'로컬 저장 완료 · 백업 대기'});
 for(let i=0;i<20&&store.status('owner','target').state!=='saved';i++)await new Promise(r=>setTimeout(r,5));
 expect(store.status('owner','target').localSaved).toBe(true);
 await new MobileWorkspaceJobs(dir).start('owner','target','request_1234',run);expect(calls).toBe(1);
 expect(store.status('different','target').state).toBe('idle');
 }finally{rmSync(dir,{recursive:true,force:true})}
});
test('an admitted save finishes after the phone disconnects and is read after reconnect',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'mobile-disconnect-'));let connected=true,calls=0;let finish!:()=>void;
 try{
 const jobs=new MobileWorkspaceJobs(dir);
 const gateway=createMobileWorkspaceGateway({terminal:async()=>({sessions:[]}),active:()=>connected,resolve:async()=>[{controlId:'control_1234',runtimeTargetId:'runtime_1234'}],consent:async()=>({targetIds:new Set(['runtime_1234']),workspaceScopes:['memory.save'],isActive:()=>connected,requestOwner:'device'}),perform:async r=>({kind:'workspace',action:r.workspace.action,memory:await jobs.start('device','runtime_1234',r.requestId,async()=>{calls++;await new Promise<void>(resolve=>{finish=resolve});return {state:'saved',localSaved:true,backupSaved:false,message:'로컬 저장 완료'};})})});
 const save={...request,workspace:{action:'memory.save' as const}};
 await gateway(save,[],'owner');connected=false;finish();
 for(let i=0;i<20&&jobs.status('device','runtime_1234').state!=='saved';i++)await new Promise(r=>setTimeout(r,5));
 expect(jobs.status('device','runtime_1234').localSaved).toBe(true);
 connected=true;await gateway(save,[],'new-socket');expect(calls).toBe(1);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
