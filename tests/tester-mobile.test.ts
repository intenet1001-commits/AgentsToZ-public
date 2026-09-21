import {test,expect} from 'bun:test';
import {normalizeMobileWorkspaceRequest,normalizeMobileWorkspaceResult,normalizeWorkspaceScopes,workspaceScope,type MobileWorkspaceRequest} from '../src/mobileWorkspaceProtocol';
import {createMobileWorkspaceGateway} from '../src/mobileWorkspaceGateway';
import {mobileTesterRun} from '../src/mobileTesterProtocol';
import {testerRequestId} from '../src/testerAgentContract';

const request:MobileWorkspaceRequest={operation:'workspace',requestId:'request_1234',targetId:'control_1234',workspace:{action:'tester.status'}};
test('tester protocol is explicit, bounded and strips private result fields',()=>{
 const start={...request,workspace:{action:'tester.start' as const,testRequestId:testerRequestId(),profileId:'quick',revisionHash:'a'.repeat(64)}};
 expect(normalizeMobileWorkspaceRequest(start)).toEqual(start);
 for(const workspace of [{...start.workspace,command:'echo secret'},{...start.workspace,testRequestId:'replay'},{action:'tester.read',runId:'../other'},{action:'tester.install'},{action:'tester.start',profileId:'quick'}])expect(()=>normalizeMobileWorkspaceRequest({...request,workspace})).toThrow();
 expect(()=>workspaceScope('unknown' as any)).toThrow();expect(workspaceScope('tester.cancel')).toBe('tester.run');
 expect(normalizeWorkspaceScopes(['records.read'])).toEqual(['records.read']);expect(()=>normalizeWorkspaceScopes(['tester.run'])).toThrow();
 const run=mobileTesterRun({id:'20260914T000000Z-1234abcd',state:'passed',profileId:'quick',createdAt:'2026-09-14T00:00:00Z',origin:'app',message:'/private/secret',report:{runId:'20260914T000000Z-1234abcd',state:'passed',profile:'quick',startedAt:'2026-09-14T00:00:00Z',checks:[{id:'core',state:'passed',reason:'/private/secret',output:'token and memory',evidence:'private evidence'}]}});
 expect(JSON.stringify(run)).not.toMatch(/secret|token|memory|evidence/);
 const result={kind:'workspace' as const,action:'tester.read' as const,tester:{canRun:false,canCancel:false,run}};
 expect(normalizeMobileWorkspaceResult(result)).toEqual(result);
 expect(()=>normalizeMobileWorkspaceResult({...result,tester:{...result.tester,output:'secret'}})).toThrow();
 expect(()=>normalizeMobileWorkspaceResult({...result,records:[]})).toThrow();
 expect(()=>normalizeMobileWorkspaceResult({...result,action:'memory.status'})).toThrow();
});
test('feature support, project and both tester scopes are required; read permission is never execution',async()=>{
 let scopes:any[]=[],permitted=true,active=true,supported=false,calls=0;
 const deps={testerSupported:supported,terminal:async()=>({sessions:[]}),active:()=>active,resolve:async()=>[{controlId:'control_1234',runtimeTargetId:'runtime_1234'}],consent:async()=>({targetIds:new Set(permitted?['runtime_1234']:[]),workspaceScopes:scopes,isActive:()=>active,executionAllowed:()=>active,requestOwner:'stable-phone'}),perform:async(r:MobileWorkspaceRequest,_t:string,_o:string,_a:()=>boolean,access:any)=>{calls++;return {kind:'workspace' as const,action:r.workspace.action,tester:{canRun:access.canRun,canCancel:false,run:null}};}};
 const gateway=createMobileWorkspaceGateway(deps);
 scopes=['tester.read','tester.run'];await expect(gateway(request,[],'socket')).rejects.toThrow('업데이트');
 deps.testerSupported=true;scopes=['records.read','memory.save'];await expect(gateway(request,[],'socket')).rejects.toThrow();
 scopes=['tester.read'];expect((await gateway(request,[],'socket') as any).tester.canRun).toBe(false);
 const start={...request,workspace:{action:'tester.start' as const,profileId:'quick',revisionHash:'a'.repeat(64),testRequestId:testerRequestId()}};
 await expect(gateway(start,[],'socket')).rejects.toThrow();expect(calls).toBe(1);
 scopes=['tester.run'];await expect(gateway(start,[],'socket')).rejects.toThrow();
 scopes=['tester.read','tester.run'];permitted=false;await expect(gateway(start,[],'socket')).rejects.toThrow();
 permitted=true;await gateway(start,[],'socket');expect(calls).toBe(2);
 active=false;await expect(gateway(request,[],'new-socket')).rejects.toThrow();
});
