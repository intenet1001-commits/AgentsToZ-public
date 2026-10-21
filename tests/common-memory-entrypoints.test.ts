// T10: entry points into common memory — new-project linking, project-links by long-term memory, the follow-up poller,
// and the phone's record modes.
import {describe,expect,test} from 'bun:test';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MetaCommonMemoryStore} from '../src/metaCommonMemoryStore';
import {MetaCommonMemoryService} from '../src/metaCommonMemoryService';
import {MetaMemoryClientError} from '../src/metaCommonMemoryClient';
import {forgetProjectCommonMemoryLink,linkNewProjectCommonMemories,newProjectCommonMemoryRequestId,portalLocalCommonVisible,readProjectCommonMemoryLinks} from '../src/commonMemoryEntrypoints';
import {startCommonMemoryFollowupPolling,COMMON_MEMORY_FOLLOWUP_POLL_MS} from '../src/commonMemoryFollowupWatcher';
import {COMMON_MEMORY_REMOTE_FEATURE} from '../src/commonMemoryRequest';
import {META_MEMORY_REMOTE_FEATURE} from '../src/metaCommonMemoryRemoteProtocol';

const MEMORY='11111111-1111-4111-8111-111111111111',GROUP='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',GROUP2='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const group=(id:string)=>({id,revision:2,name:'공통',description:'',tags:[],categories:[],archived:false,entries:[],members:[]});
function metaRequester(onSave:(body:any)=>unknown,memberForm:string|null='memory'){
  const calls:any[]=[];
  return {calls,request:async(body:Record<string,any>)=>{calls.push(body);if(body.operation==='read')return {memory:group(body.memoryId),...(memberForm?{memberForm}:{})};if(body.operation==='save')return onSave(body);throw Error('unexpected '+body.operation);}};
}

describe('new project linking',()=>{
  test('a memory already in the cloud is linked by the memory form with a stable request id per group',async()=>{
    const {calls,request}=metaRequester(()=>({}));
    const results=await linkNewProjectCommonMemories({portId:'port-1',memoryId:MEMORY,groupIds:[GROUP,GROUP2,GROUP],memoryInCloud:true,request});
    expect(results).toEqual([{memoryId:GROUP,linked:true},{memoryId:GROUP2,linked:true}]);
    const saves=calls.filter(c=>c.operation==='save');
    expect(saves.map(c=>c.assignments)).toEqual([[{memoryId:MEMORY,mode:'include'}],[{memoryId:MEMORY,mode:'include'}]]);
    expect(saves.map(c=>c.requestId)).toEqual([newProjectCommonMemoryRequestId('port-1',GROUP,'memory'),newProjectCommonMemoryRequestId('port-1',GROUP2,'memory')]);
    // Linking the same project again replays the same ids.
    const again=metaRequester(()=>({}));await linkNewProjectCommonMemories({portId:'port-1',memoryId:MEMORY,groupIds:[GROUP],memoryInCloud:true,request:again.request});
    expect(again.calls.find(c=>c.operation==='save').requestId).toBe(saves[0].requestId);
  });
  test('an older service refusing the memory form in its parser gets exactly one project-card retry',async()=>{
    const {calls,request}=metaRequester(body=>{if('memoryId' in body.assignments[0])throw new MetaMemoryClientError('형식','META_MEMORY_INPUT_INVALID');return {};});
    expect(await linkNewProjectCommonMemories({portId:'port-1',memoryId:MEMORY,groupIds:[GROUP],memoryInCloud:true,request})).toEqual([{memoryId:GROUP,linked:true}]);
    const saves=calls.filter(c=>c.operation==='save');
    expect(saves.map(c=>c.assignments)).toEqual([[{memoryId:MEMORY,mode:'include'}],[{portId:'port-1',expectedMemoryId:MEMORY,mode:'include'}]]);
    expect(saves.map(c=>c.requestId)).toEqual([newProjectCommonMemoryRequestId('port-1',GROUP,'memory'),newProjectCommonMemoryRequestId('port-1',GROUP,'port')]);
  });
  test('a memory not yet in the cloud goes straight to the project-card form, and a refusal there is not retried',async()=>{
    const {calls,request}=metaRequester(()=>{throw new MetaMemoryClientError('형식','META_MEMORY_INPUT_INVALID');});
    expect((await linkNewProjectCommonMemories({portId:'port-1',memoryId:MEMORY,groupIds:[GROUP],memoryInCloud:false,request}))[0]!.linked).toBe(false);
    expect(calls.filter(c=>c.operation==='save').map(c=>c.assignments)).toEqual([[{portId:'port-1',expectedMemoryId:MEMORY,mode:'include'}]]);
  });
});

describe('new project linking against this Mac\'s real local store (unmigrated cloud)',()=>{
  test('a local group is linked by project card even after this flow pushed the long-term memory',async()=>{
    const root=mkdtempSync(join(tmpdir(),'new-project-link-'));
    try{
      const store=new MetaCommonMemoryStore(root);
      const service=new MetaCommonMemoryService(store,{projects:async()=>[{id:'port-1',name:'새 프로젝트',category:'NHCS',memoryId:MEMORY,state:'ready'}],prepareProject:async()=>{},cloud:async()=>({handled:false})});
      const created=await service.execute({operation:'save',expectedRevision:0,requestId:randomUUID(),name:'로컬 공통',description:'',tags:[],categories:[],assignments:[]});
      const calls:any[]=[];const request=async(body:Record<string,unknown>)=>{calls.push(body);try{return await service.execute(body);}catch(e:any){throw new MetaMemoryClientError(e.message,e.code);}};
      for(const memoryInCloud of [true,false]){
        expect(await linkNewProjectCommonMemories({portId:'port-1',memoryId:MEMORY,groupIds:[created.memory.id],memoryInCloud,request})).toEqual([{memoryId:created.memory.id,linked:true}]);
      }
      expect(calls.filter(c=>c.operation==='save').map(c=>c.assignments)).toEqual([[{portId:'port-1',expectedMemoryId:MEMORY,mode:'include'}]]);
      expect(store.read(created.memory.id).members.map((m:any)=>[m.memoryId,m.mode])).toEqual([[MEMORY,'include']]);
    }finally{rmSync(root,{recursive:true,force:true});}
  });
});

describe('project-links',()=>{
  test('asks by memoryId when known and never by project card',async()=>{
    const calls:any[]=[];const request=async(op:string,input:any)=>{calls.push([op,input]);return {memoryId:MEMORY,name:'원본',groups:[]};};
    await readProjectCommonMemoryLinks(request,{portId:'port-a',memoryId:MEMORY});
    expect(calls).toEqual([['project-links',{memoryId:MEMORY}]]);
  });
  test('the memoryId a project card resolved to is used on the next open; 다시 확인 resolves the card again',async()=>{
    const calls:any[]=[];const request=async(op:string,input:any)=>{calls.push(input);return {memoryId:MEMORY,name:'원본',groups:[]};};
    await readProjectCommonMemoryLinks(request,{portId:'port-b'});
    await readProjectCommonMemoryLinks(request,{portId:'port-b'});
    forgetProjectCommonMemoryLink('port-b');await readProjectCommonMemoryLinks(request,{portId:'port-b'});
    expect(calls).toEqual([{portId:'port-b'},{memoryId:MEMORY},{portId:'port-b'}]);
  });
  test('an older service refusing the memoryId form falls back to the project card once; other errors are not retried',async()=>{
    const calls:any[]=[];
    const old=async(op:string,input:any)=>{calls.push(input);if(input.memoryId)throw Object.assign(new Error('형식'),{code:'COMMON_MEMORY_INPUT_INVALID'});return {memoryId:MEMORY,name:'원본',groups:[]};};
    expect((await readProjectCommonMemoryLinks(old,{portId:'port-c',memoryId:MEMORY})).name).toBe('원본');
    expect(calls).toEqual([{memoryId:MEMORY},{portId:'port-c'}]);
    calls.length=0;
    const down=async(op:string,input:any)=>{calls.push(input);throw Object.assign(new Error('클라우드 없음'),{code:'COMMON_MEMORY_CLOUD_REQUIRED'});};
    await expect(readProjectCommonMemoryLinks(down,{portId:'port-c',memoryId:MEMORY})).rejects.toThrow('클라우드 없음');
    expect(calls).toEqual([{memoryId:MEMORY}]);
  });
});

describe('follow-up notice polling',()=>{
  function harness(hidden:boolean){
    let clock=0,reads=0;const intervals=new Map<number,()=>void>();let next=1;
    const poller=startCommonMemoryFollowupPolling({hidden,documentVisible:()=>true,now:()=>clock,
      read:async offset=>{reads++;return {updates:[],nextOffset:null,scopeId:'cloud'};},result:()=>{},error:()=>{},
      timers:{set:(run)=>{const id=next++;intervals.set(id,run);return id;},clear:id=>{intervals.delete(id as number);}}});
    const tick=async()=>{clock+=COMMON_MEMORY_FOLLOWUP_POLL_MS;for(const run of [...intervals.values()])run();await poller.check();};
    return {poller,tick,reads:()=>reads,timers:()=>intervals.size};
  }
  test('reads nothing and runs no timer while hidden; showing it again checks at once',async()=>{
    const h=harness(true);await h.poller.first;
    expect(h.timers()).toBe(0);await h.tick();await h.tick();expect(h.reads()).toBe(0);
    await h.poller.setHidden(false);expect(h.reads()).toBe(1);expect(h.timers()).toBe(1);
    await h.poller.setHidden(true);expect(h.timers()).toBe(0);await h.tick();expect(h.reads()).toBe(1);
    h.poller.stop();
  });
  test('a shown notice reads on start and once per interval',async()=>{
    const h=harness(false);await h.poller.first;expect(h.reads()).toBe(1);
    await h.tick();expect(h.reads()).toBe(2);
    h.poller.stop();await h.tick();expect(h.reads()).toBe(2);
  });
});

describe('phone record modes',()=>{
  test('이 Mac의 기억 hides only after a real cloud list answered with no local group left outside the cloud',()=>{
    const cloud=['workspace-v1',COMMON_MEMORY_REMOTE_FEATURE,META_MEMORY_REMOTE_FEATURE];
    // The flag alone is not proof: every Mac advertises it, also on an unmigrated cloud.
    expect(portalLocalCommonVisible(cloud)).toBe(true);expect(portalLocalCommonVisible(cloud,null)).toBe(true);
    expect(portalLocalCommonVisible(cloud,{ok:false,localPending:null})).toBe(true);
    // Local groups the cloud does not hold would be listed in 공통기억 but could not be opened there.
    expect(portalLocalCommonVisible(cloud,{ok:true,localPending:2})).toBe(true);
    // An older Mac that does not report the count keeps the tab.
    expect(portalLocalCommonVisible(cloud,{ok:true,localPending:null})).toBe(true);
    expect(portalLocalCommonVisible(cloud,{ok:true,localPending:0})).toBe(false);
    expect(portalLocalCommonVisible(['workspace-v1',COMMON_MEMORY_REMOTE_FEATURE],{ok:true,localPending:0})).toBe(false);
    expect(portalLocalCommonVisible(['workspace-v1',META_MEMORY_REMOTE_FEATURE],{ok:true,localPending:0})).toBe(true);
    expect(portalLocalCommonVisible(undefined)).toBe(true);
  });
  test('the portal feeds the panel\'s list result, per connection, into the decision',()=>{
    const portal=readFileSync(new URL('../src/remote-control-portal-main.tsx',import.meta.url),'utf8'),panel=readFileSync(new URL('../src/CommonMemoryPanel.tsx',import.meta.url),'utf8');
    expect(portal).toContain('portalLocalCommonVisible(status.supportedFeatures,cloudList?.key===workspaceConnectionKey?cloudList.state:null)');
    expect(portal).toContain('onCloudList={reportCloudList}');
    expect(panel).toContain("onCloudList?.({ok:false,localPending:null});throw e;");
    expect(panel).toContain("onCloudList?.({ok:true,localPending:typeof result.localPending==='number'?result.localPending:null});");
  });
  test('the create forms no longer render the goal picker; its export stays for the fixture and older screens',()=>{
    const app=readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8'),portal=readFileSync(new URL('../src/remote-control-portal-main.tsx',import.meta.url),'utf8');
    expect(app).not.toContain('ProjectCommonMemoryChoice');expect(portal).not.toContain('ProjectCommonMemoryChoice');
    expect(portal).not.toContain("action:'common-memory.bind'");
    expect(readFileSync(new URL('../src/CommonMemoryPanel.tsx',import.meta.url),'utf8')).toContain('export function ProjectCommonMemoryChoice');
  });
});
