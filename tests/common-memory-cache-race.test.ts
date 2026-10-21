// A member lookup or catalog page that is still in flight when a write lands must not put its pre-write answer back in the
// module cache: the next read (project reader, dispatch recall, MCP recall, project-links) would serve old membership for
// the whole TTL even though writes are documented to invalidate it.
import {afterEach,expect,test} from 'bun:test';
import {createCommonMemoryService,clearCommonMemoryServiceCaches} from '../common-memory-server';
import {CommonCloud,A} from './fixtures/common-memory/cloud';

afterEach(()=>clearCommonMemoryServiceCaches());

/** Holds every read of `table` (or RPC `name`) whose result arrives while `hold` is set until that promise resolves. */
const gated=(cloud:any)=>{
  const gate:{hold:Promise<void>|null;table:string|null;rpc:string|null}={hold:null,table:null,rpc:null};
  const from=cloud.from.bind(cloud),rpc=cloud.rpc.bind(cloud);
  const delay=(q:any,match:()=>boolean)=>{const then=q.then.bind(q);q.then=(ok:any,no:any)=>{const held=match()?gate.hold:null;return then((r:any)=>held?held.then(()=>r):r).then(ok,no);};return q;};
  cloud.from=(table:string)=>delay(from(table),()=>table===gate.table);
  cloud.rpc=(name:string,p:any)=>delay(rpc(name,p),()=>name===gate.rpc);
  return gate;
};
const scoped=()=>Object.assign(new CommonCloud(),{commonMemoryScope:'e'.repeat(64)}) as any;

test('a member lookup that started before a save does not cache the pre-save membership',async()=>{
  const cloud=scoped();cloud.source(A,'### x\n<!-- memory-entry-id:aaaaaaaaaaaaaaaaaaaaaaaa -->\nbody');
  const gate=gated(cloud),svc=createCommonMemoryService(()=>cloud);
  const created=await svc.knowledge({operation:'save',requestId:'r1',expectedRevision:0,name:'G',description:'G',tags:[],categories:[],assignments:[]},[]);
  let release!:()=>void;gate.hold=new Promise(r=>{release=r;});gate.table='portmgr_common_memories';
  const inflight=svc.knowledgeForMember(A);
  await new Promise(r=>setTimeout(r,20));
  gate.hold=null;
  await svc.knowledge({operation:'save',memoryId:created.state.id,requestId:'r2',expectedRevision:created.state.portableKnowledge!.current.revision,name:'G',description:'G',tags:[],categories:[],assignments:[{memoryId:A,mode:'include'}]},[],undefined,new Map([[A,'원본 A']]));
  release();
  expect((await inflight).groups.length).toBe(0); // it answered from before the save
  expect((await svc.knowledgeForMember(A)).groups.map(g=>g.groupId)).toEqual([created.state.id]);
  // The fresh answer is cached normally again.
  const reads=cloud.calls.length;
  expect((await svc.knowledgeForMember(A)).groups.length).toBe(1);
  expect(cloud.calls.length).toBe(reads);
});

test('a catalog page that started before a write is not cached for background walks',async()=>{
  const cloud=scoped();cloud.source(A,'### x\n<!-- memory-entry-id:aaaaaaaaaaaaaaaaaaaaaaaa -->\nbody');
  const gate=gated(cloud),svc=createCommonMemoryService(()=>cloud);
  let release!:()=>void;gate.hold=new Promise(r=>{release=r;});gate.rpc='portmgr_list_project_memory_head_page';
  const inflight=svc.catalogAll(1);
  await new Promise(r=>setTimeout(r,20));
  gate.hold=null;
  await svc.knowledge({operation:'save',requestId:'r3',expectedRevision:0,name:'G',description:'G',tags:[],categories:[],assignments:[]},[]);
  release();await inflight;
  const pages=()=>cloud.calls.filter((c:any)=>c.name==='portmgr_list_project_memory_head_page').length,before=pages();
  await svc.catalogAll(1);
  expect(pages()).toBe(before+1); // the stale page was dropped, so this walk reads again
  await svc.catalogAll(1);
  expect(pages()).toBe(before+1); // and that read is cached
});
