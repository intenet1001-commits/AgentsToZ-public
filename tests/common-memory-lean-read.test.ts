// A phone opening a knowledge group should not download this Mac's whole project inventory in `read`: the picker links
// by memoryId from the catalog and the inventory is only secondary text. A Mac with `lean-read` leaves it out when asked;
// the phone asks only on such a Mac and loads `projects` when the picker opens. Old phones (no flag) are unchanged.
import {afterEach,expect,test} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createCommonMemoryDispatch} from '../common-memory-dispatch';
import {createCommonMemoryService,clearCommonMemoryServiceCaches} from '../common-memory-server';
import {createCommonMemoryMigration} from '../common-memory-migration-server';
import {MetaCommonMemoryStore} from '../src/metaCommonMemoryStore';
import {MetaCommonMemoryRemoteHost} from '../src/metaCommonMemoryRemoteHost';
import {createMetaMemoryRemoteRequester} from '../src/metaCommonMemoryRemoteClient';
import {createMobileWorkspaceGateway} from '../src/mobileWorkspaceGateway';
import {createCommonMemoryClient} from '../src/commonMemoryClient';
import {parseMetaMemoryRequest} from '../src/metaCommonMemoryContract';
import {COMMON_MEMORY_HOST_CAPABILITIES} from '../src/commonMemoryCapabilities';
import {CommonCloud,A,B,C} from './fixtures/common-memory/cloud';

const SCOPE='d'.repeat(64),dirs:string[]=[],hosts:MetaCommonMemoryRemoteHost[]=[];
afterEach(()=>{clearCommonMemoryServiceCaches();for(const h of hosts.splice(0))h.dispose();dirs.splice(0).forEach(p=>rmSync(p,{recursive:true,force:true}));});

async function fixture(){
  const cloud:any=Object.assign(new CommonCloud(),{commonMemoryScope:SCOPE});
  // 103 registered projects, about the size of a real inventory.
  const projects:any[]=Array.from({length:103},(_,i)=>({id:'port-'+i,name:'프로젝트 '+i+' '+'x'.repeat(60),category:'',memoryId:[A,B,C][i]??crypto.randomUUID(),state:'ready',folderPath:'/Users/x/projects/project-'+i}));
  let inventoryReads=0;const projectsFn=async(_f?:boolean)=>{inventoryReads++;return projects;};
  const dir=mkdtempSync(join(tmpdir(),'cm-lean-'));dirs.push(dir);const store=new MetaCommonMemoryStore(dir);
  const service=createCommonMemoryService(()=>cloud);
  const d=createCommonMemoryDispatch({service,store,migration:createCommonMemoryMigration(store,service,projectsFn),projects:projectsFn,
    memoryCategory:async(id:string)=>projects.find(p=>p.memoryId===id)?.category??null,resolveProject:async(portId:any)=>{const p=projects.find(x=>x.id===portId);return {memoryId:p.memoryId,projectName:p.name};},
    client:()=>cloud,workspaceRoots:async()=>[],projectManager:{membersStatus:async()=>({ok:true})} as any,runInGroup:(_g:any,run:any)=>run(),bindProject:async()=>{throw Error('x');},
    remoteService:(a:any)=>createCommonMemoryService(()=>cloud,a)} as any);
  const saved=await d.dispatch('knowledge',{request:{operation:'save',requestId:crypto.randomUUID(),expectedRevision:0,name:'NHCS',description:'d',categories:[],assignments:[A,B,C].map(memoryId=>({memoryId,mode:'include'}))}}) as any;
  const phone=(rpcV2:boolean)=>{
    const host=new MetaCommonMemoryRemoteHost(async(owner:any,raw:any,active:any,_k:any,canAdd:any)=>(d as any).remote(owner,raw,active,canAdd));hosts.push(host);
    const gateway=createMobileWorkspaceGateway({terminal:async()=>{throw Error('t');},active:()=>true,resolve:async()=>[],consent:async()=>({targetIds:new Set<string>(),workspaceScopes:['common-memory.manage'],projectRoots:[],isActive:()=>true,requestOwner:'phone',executionAllowed:()=>false}) as any,perform:async()=>{throw Error('p');},commonMemory:(r:any,o:any,a:any,c:any)=>host.perform(o,r,a,'cloud',c)});
    let exchanges=0;
    const rpc=createMetaMemoryRemoteRequester(async(r:any)=>{exchanges++;return await gateway(r,[],'phone') as any;},'common-memory',{rpcV2});
    const client=createCommonMemoryClient((operation:any,input:any)=>rpc({operation,...(input===undefined?{}:{input})}));
    return {client,exchanges:()=>exchanges};
  };
  return {d,memoryId:saved.memory.id as string,phone,inventoryReads:()=>inventoryReads};
}

test('the host advertises lean-read and the parser keeps the flag (and only false)',()=>{
  expect(COMMON_MEMORY_HOST_CAPABILITIES).toContain('lean-read');
  expect(parseMetaMemoryRequest({operation:'read',memoryId:A,withProjects:false})).toEqual({operation:'read',memoryId:A,withProjects:false});
  expect(parseMetaMemoryRequest({operation:'read',memoryId:A,withProjects:true})).toEqual({operation:'read',memoryId:A});
  expect(parseMetaMemoryRequest({operation:'read',memoryId:A})).toEqual({operation:'read',memoryId:A});
});

test('a lean knowledge read leaves the inventory out without scanning it; a plain read is unchanged',async()=>{
  const f=await fixture();
  const before=f.inventoryReads();
  const lean=await f.d.dispatch('knowledge',{request:{operation:'read',memoryId:f.memoryId,withProjects:false}}) as any;
  expect(lean.projects).toBeUndefined();expect(lean.appliedProjectIds).toBeUndefined();
  expect(lean.memory.id).toBe(f.memoryId);expect(lean.memberForm).toBe('memory');expect(lean.storage).toBe('cloud');
  expect(f.inventoryReads()).toBe(before);
  const full=await f.d.dispatch('knowledge',{request:{operation:'read',memoryId:f.memoryId}}) as any;
  expect(full.projects).toHaveLength(103);expect(full.appliedProjectIds).toEqual(['port-0','port-1','port-2']);
});

test('phone group open: a lean read is one relay exchange on v2, the full read is three',async()=>{
  const f=await fixture();
  for(const [rpcV2,leanMax,fullMin] of [[true,1,3],[false,4,7]] as const){
    const p=f.phone(rpcV2);
    let at=p.exchanges();
    const lean=await p.client.request('knowledge',{request:{operation:'read',memoryId:f.memoryId,withProjects:false},scopeId:SCOPE}) as any;
    const leanExchanges=p.exchanges()-at;
    at=p.exchanges();
    const full=await p.client.request('knowledge',{request:{operation:'read',memoryId:f.memoryId},scopeId:SCOPE}) as any;
    const fullExchanges=p.exchanges()-at;
    expect(lean.projects).toBeUndefined();expect(full.projects).toHaveLength(103);
    expect(leanExchanges).toBeLessThanOrEqual(leanMax);expect(fullExchanges).toBeGreaterThanOrEqual(fullMin);
  }
});
