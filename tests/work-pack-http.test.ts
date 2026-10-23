import {expect,test} from 'bun:test';
import {handleWorkPackRequest,WORK_PACKS_PATH} from '../src/workPackHttp';
import {handleReadToolBatchRequest} from '../src/readToolBatchHttp';
import {WorkPackError} from '../src/workPack';

const list={revision:'r1',packs:[],commands:[{guideId:'cmd-status',title:'개발 현황 조회'}]};
const post=(path:string,body:unknown,init:RequestInit={})=>new Request('http://127.0.0.1:3001'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:typeof body==='string'?body:JSON.stringify(body),...init});

test('management route is exact, bounded and answers fixed messages',async()=>{
 const calls:string[]=[];
 const host={list:async()=>{calls.push('list');return list;},save:async(input:unknown)=>{calls.push('save:'+JSON.stringify(input));return list;},disable:async()=>{throw new WorkPackError('WORK_PACK_NOT_FOUND');}};
 const ok=await handleWorkPackRequest(post(WORK_PACKS_PATH,{operation:'list'}),host);expect(ok.status).toBe(200);expect(await ok.json()).toEqual({success:true,...list});
 expect((await handleWorkPackRequest(post(WORK_PACKS_PATH,{operation:'save',guideId:'cmd-status',expectedRevision:'r1',plan:{steps:[]}}),host)).status).toBe(200);
 expect(calls[1]).toBe('save:{"guideId":"cmd-status","expectedRevision":"r1","plan":{"steps":[]}}');
 const missing=await handleWorkPackRequest(post(WORK_PACKS_PATH,{operation:'disable',guideId:'x',expectedRevision:'r1'}),host);
 expect(missing.status).toBe(409);expect((await missing.json()).error).toContain('저장된 작업 팩이 없습니다');
 for(const [request,status] of [
  [post(WORK_PACKS_PATH+'?x=1',{operation:'list'}),404],[post(WORK_PACKS_PATH+'/run',{operation:'list'}),404],
  [new Request('http://127.0.0.1:3001'+WORK_PACKS_PATH,{method:'GET'}),405],[post(WORK_PACKS_PATH,'x'.repeat(9000)),413],
  [post(WORK_PACKS_PATH,'{bad'),400],[post(WORK_PACKS_PATH,{operation:'list',extra:1}),400],[post(WORK_PACKS_PATH,{operation:'run'}),400],
 ] as const)expect((await handleWorkPackRequest(request,host)).status).toBe(status);
 expect(calls).toHaveLength(2);
});

test('pack.run shares the batch gate and exact keys; pack.read stays available when new runs are off',async()=>{
 const runs:unknown[]=[];const result={batch:{} as never,payload:'unavailable' as const,completion:null};
 const packs={run:async(_o:string,input:unknown)=>{runs.push(input);return result;},read:async(_o:string,input:unknown)=>{runs.push(input);return result;}};
 const host={start:async()=>result,read:async()=>result,cancel:async()=>result};
 const ref={targetId:'project-a',threadId:'thread-1',requestId:'request-1'};
 const call=(body:unknown,enabled:boolean)=>handleReadToolBatchRequest(post('/api/agent-runtime/project-state',body),host,'local',{},{enabled,packs});
 const gated=await call({operation:'pack.run',...ref,guideId:'cmd-status',values:{}},false);expect(gated.status).toBe(503);expect((await gated.json()).code).toBe('READ_TOOL_DISABLED');
 expect((await call({operation:'pack.read',...ref,guideId:'cmd-status'},false)).status).toBe(200);
 expect((await call({operation:'pack.run',...ref,guideId:'cmd-status',values:{query:'notes'}},true)).status).toBe(200);
 expect(runs).toEqual([{...ref,guideId:'cmd-status'},{...ref,guideId:'cmd-status',values:{query:'notes'}}]);
 for(const body of [{operation:'pack.run',...ref,guideId:'cmd-status',values:{},plan:{steps:[]}},{operation:'pack.read',...ref,guideId:'cmd-status',values:{}},{operation:'pack.run',...ref,values:{}}])
  expect((await call(body,true)).status).toBeGreaterThanOrEqual(400);
 // Without a packs host the operations do not exist.
 expect((await handleReadToolBatchRequest(post('/api/agent-runtime/project-state',{operation:'pack.read',...ref,guideId:'cmd-status'}),host,'local',{},{enabled:true})).status).toBe(400);
 expect(runs).toHaveLength(2);
});
