import {expect,test} from 'bun:test';
import {loadRemoteCommunityProjectPages} from '../src/remoteCommunityProjectPages';
import {remoteCommunityProjects} from '../src/remoteCommunity';

const catalog={deviceName:'아젠투지3호',opsTargetId:null,projects:Array.from({length:41},(_,i)=>({targetId:`project_${i}`,label:`프로젝트 ${i}`}))};

test('loads all 41 device projects serially without a more-button click',async()=>{
  const requested:number[]=[],received:string[]=[];let pending=0;
  await loadRemoteCommunityProjectPages({startPage:0,isCurrent:()=>true,
    fetchPage:async page=>{expect(pending++).toBe(0);requested.push(page);await Promise.resolve();pending--;return remoteCommunityProjects(catalog,page);},
    onPage:value=>received.push(...value.projects.map(p=>p.targetId))});
  expect(requested).toEqual([0,1,2]);expect(received).toHaveLength(41);expect(new Set(received).size).toBe(41);
});

test('a failed later page preserves received pages and resumes at that page',async()=>{
  let pendingPage=0;const received:string[]=[],requested:number[]=[];
  const onPage=(value:ReturnType<typeof remoteCommunityProjects>)=>received.push(...value.projects.map(p=>p.targetId));
  await expect(loadRemoteCommunityProjectPages({startPage:0,isCurrent:()=>true,onPage,
    onRequest:page=>{pendingPage=page;},fetchPage:async page=>{if(page===1)throw Error('offline');return remoteCommunityProjects(catalog,page);}})).rejects.toThrow('offline');
  expect(received).toHaveLength(20);expect(pendingPage).toBe(1);
  await loadRemoteCommunityProjectPages({startPage:pendingPage,isCurrent:()=>true,onPage,
    fetchPage:async page=>{requested.push(page);return remoteCommunityProjects(catalog,page);}});
  expect(requested).toEqual([1,2]);expect(new Set(received).size).toBe(41);
});

test('drops a late response and stops paging when the device or host changes',async()=>{
  let current=true;const received:number[]=[];
  await loadRemoteCommunityProjectPages({startPage:0,isCurrent:()=>current,
    fetchPage:async page=>{current=false;return remoteCommunityProjects(catalog,page);},onPage:value=>received.push(value.page)});
  expect(received).toEqual([]);
});

test('rejects a repeated page instead of looping or presenting a complete catalog',async()=>{
  await expect(loadRemoteCommunityProjectPages({startPage:1,isCurrent:()=>true,
    fetchPage:async()=>remoteCommunityProjects(catalog,0),onPage:()=>{throw Error('must not publish');}})).rejects.toThrow('페이지');
});
