// T3: project recall keyed by the long-term memoryId.
// - registeredMemoryCategory: a registered folder (main or worktree) is the only grant; a memoryId alone grants nothing.
// - projectMetaMemoryContextAsync: each known failure gets its own text in the existing `error` field.
// - recallProjectMemoryWithCommon: identity instead of the full detect, one document read, the reader called once (never
//   with includeCommon:false), output equal to the former composition.
// - prepareProjectMemoryUpdateWithCommon: one COMMON MEMORY block.
import {afterEach,describe,expect,spyOn,test} from 'bun:test';
import * as fs from 'node:fs';
import {mkdtempSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {MetaCommonMemoryStore} from '../src/metaCommonMemoryStore';
import {MetaCommonMemoryService} from '../src/metaCommonMemoryService';
import {MetaMemoryError,type MetaMemoryProject,type MetaMemoryRecall} from '../src/metaCommonMemoryContract';
import {CommonMemoryError} from '../src/commonMemory';
import {createProjectMemoryIdentityCache} from '../src/projectMemoryIdentityCache';
import {installProjectMetaMemoryReader,projectMetaMemoryContextAsync,registeredMemoryCategory,registeredMemoryLookup,type RegisteredMemoryFolder} from '../src/projectMetaMemoryContext';
import {detectProjectMemory,detectProjectMemoryIdentity,initializeProjectMemory,prepareProjectMemoryUpdateWithCommon,recallProjectMemory,recallProjectMemoryWithCommon} from '../project-memory-server';

const dirs:string[]=[];
afterEach(()=>{installProjectMetaMemoryReader(null);dirs.splice(0).forEach(p=>rmSync(p,{recursive:true,force:true}));});
const temp=(prefix:string)=>{const dir=realpathSync(mkdtempSync(join(tmpdir(),prefix)));dirs.push(dir);return dir;};
const git=(cwd:string,...args:string[])=>execFileSync('git',['-c','user.email=t@example.com','-c','user.name=t',...args],{cwd,stdio:'pipe'}).toString();
const memoryIdOf=(root:string)=>detectProjectMemory(root).config!.memoryId.toLowerCase();
const EMPTY_STATS={excerpts:0,claudeConsidered:0,claudeMatched:0,claudeUnreadable:0,claudeOwnershipRejected:0,codexConsidered:0,codexMatched:0,codexUnreadable:0,codexOwnedUnreadable:0};

/** A git project whose memory lives in the main checkout, a linked worktree, and an unrelated project. */
function family(){
  const main=temp('t3-main-');writeFileSync(join(main,'README.md'),'main\n');git(main,'init','-q','-b','main');git(main,'add','README.md');git(main,'commit','-q','-m','init');
  initializeProjectMemory({folderPath:main,projectName:'Main project',agent:'codex'});
  const wt=join(temp('t3-wt-'),'wt');git(main,'worktree','add','-q','-b','wt',wt);
  const other=temp('t3-other-');initializeProjectMemory({folderPath:other,projectName:'Other project',agent:'codex'});
  return {main,wt,other,mainId:memoryIdOf(main),otherId:memoryIdOf(other)};
}
/** The sidecar's reader composition (api-server.ts) over the real identity cache and a local common-memory store. */
async function sidecar(rows:RegisteredMemoryFolder[],f:ReturnType<typeof family>){
  const projects:MetaMemoryProject[]=[{id:'main',name:'Main',category:'NHCS',memoryId:f.mainId,state:'ready'},{id:'other',name:'Other',category:'X',memoryId:f.otherId,state:'ready'}];
  const store=new MetaCommonMemoryStore(temp('t3-store-')),svc=new MetaCommonMemoryService(store,{projects:async()=>projects,prepareProject:async()=>{throw Error('must not initialize');}});
  const group=async(name:string,body:string,opts:{members?:Array<[string,'include'|'exclude']>;categories?:string[]})=>{
    let memory=(await svc.execute({operation:'save',requestId:randomUUID(),expectedRevision:0,name,description:name,categories:opts.categories??[],assignments:(opts.members??[]).map(([id,mode])=>({portId:id,expectedMemoryId:projects.find(p=>p.id===id)!.memoryId,mode}))} as any)).memory;
    memory=(await svc.execute({operation:'save-entry',memoryId:memory.id,expectedRevision:memory.revision,requestId:randomUUID(),title:name,body} as any)).memory;return memory;
  };
  await group('본류 명시','배포 계약 본류 명시 규칙',{members:[['main','include']]});
  await group('NHCS 범주','배포 계약 NHCS 범주 규칙',{categories:['NHCS']});
  await group('타 명시','배포 계약 타 명시 규칙',{members:[['other','include']]});
  await group('X 범주','배포 계약 X 범주 규칙',{categories:['X']});
  const cache=createProjectMemoryIdentityCache({detect:detectProjectMemoryIdentity,ttlMs:5_000});
  let calls=0;
  installProjectMetaMemoryReader(async(memoryId,root,query)=>{
    calls++;const category=await registeredMemoryCategory(rows,memoryId,root,registeredMemoryLookup(paths=>cache.prepare(paths)));
    if(category===null)throw new MetaMemoryError('META_MEMORY_PROJECT_UNAVAILABLE','등록 프로젝트의 공통 기억 연결을 확인하세요.',409);
    return store.recall(memoryId,query,category);
  },true);
  return {calls:()=>calls};
}
const names=(r:MetaMemoryRecall|undefined)=>(r?.groups??[]).map(g=>g.name).sort();

describe('registered memory scope',()=>{
  // Setup creates two memory roots and a linked Git worktree before the recall assertions.
  test('only a worktree registered: the main checkout and the worktree both recall that memory with the row category',async()=>{
    const f=family();await sidecar([{folderPath:f.wt,category:'NHCS'}],f);
    for(const folder of [f.main,f.wt]){
      const r=await recallProjectMemoryWithCommon({folderPath:folder,query:'배포 계약',appDataDir:temp('t3-app-')});
      expect(r.commonMemory!.state).toBe('ready');expect(names(r.commonMemory)).toEqual(['NHCS 범주','본류 명시']);
    }
  },20_000);
  test('a memoryId registered nowhere gets nothing, even as an explicit include member (category-only too)',async()=>{
    const f=family();await sidecar([{folderPath:f.wt,category:'NHCS'}],f);
    const r=await recallProjectMemoryWithCommon({folderPath:f.other,query:'배포 계약',appDataDir:temp('t3-app-')});
    expect(r.commonMemory!.state).toBe('unavailable');expect(r.commonMemory!.groups).toEqual([]);expect(r.commonMemory!.hits).toEqual([]);
    expect(r.commonMemory!.error).toContain('등록된 프로젝트');
    // The project's own memory is still recalled.
    expect(r.memoryId.toLowerCase()).toBe(f.otherId);
  });
  test('a registered root matches by realpath without asking the identity cache',async()=>{
    const f=family();let prepared=0;
    const lookup=registeredMemoryLookup(async paths=>{prepared++;return {get:()=>null};});
    expect(await registeredMemoryCategory([{folderPath:f.other+'/',category:'X'}],f.otherId,f.other,lookup)).toBe('X');
    expect(prepared).toBe(0);
    expect(await registeredMemoryCategory([{folderPath:f.main,category:''}],f.otherId,f.other,lookup)).toBeNull();
    expect(prepared).toBe(1);
  });
  test('a registered worktreePath on a row also grants, case-insensitively; an unusable identity never does',async()=>{
    const f=family(),cache=createProjectMemoryIdentityCache({detect:detectProjectMemoryIdentity,ttlMs:5_000});
    const lookup=()=>registeredMemoryLookup(paths=>cache.prepare(paths));
    expect(await registeredMemoryCategory([{folderPath:'/nonexistent/x',worktreePath:f.wt,category:'W'}],f.mainId.toUpperCase(),null,lookup())).toBe('W');
    expect(await registeredMemoryCategory([{folderPath:'/nonexistent/x',category:'W'}],f.mainId,null,lookup())).toBeNull();
    expect(await registeredMemoryCategory([],f.mainId,f.main,lookup())).toBeNull();
    expect(await registeredMemoryCategory([{folderPath:f.wt}],'',null,lookup())).toBeNull();
  });
  test('identity staleness is bounded by the cache TTL',async()=>{
    const f=family();let now=0;
    const cache=createProjectMemoryIdentityCache({detect:detectProjectMemoryIdentity,ttlMs:5_000,now:()=>now});
    const rows=[{folderPath:f.other,category:'X'}],lookup=()=>registeredMemoryLookup(paths=>cache.prepare(paths));
    expect(await registeredMemoryCategory(rows,f.otherId,null,lookup())).toBe('X');
    const config=join(f.other,'.agent-memory/config.json'),next=randomUUID();
    fs.writeFileSync(config,fs.readFileSync(config,'utf8').replace(new RegExp(f.otherId,'i'),next));
    now=4_000;expect(await registeredMemoryCategory(rows,next,null,lookup())).toBeNull();
    now=5_001;expect(await registeredMemoryCategory(rows,next,null,lookup())).toBe('X');
    expect(await registeredMemoryCategory(rows,f.otherId,null,lookup())).toBeNull();
  });
});

describe('failure reasons',()=>{
  test('not registered, timeout, cloud unavailable, cloud required, scope changed and unknown each read differently',async()=>{
    const reasons:unknown[]=[new MetaMemoryError('META_MEMORY_PROJECT_UNAVAILABLE','x',409),new CommonMemoryError('COMMON_MEMORY_RECALL_TIMEOUT','x',504),new CommonMemoryError('COMMON_MEMORY_CLOUD_UNAVAILABLE','x',503),new CommonMemoryError('COMMON_MEMORY_CLOUD_REQUIRED','x'),new CommonMemoryError('COMMON_MEMORY_SCOPE_CHANGED','x'),new Error('disk')];
    const texts:string[]=[];
    for(const reason of reasons){installProjectMetaMemoryReader(async()=>{throw reason;},true);const r=await projectMetaMemoryContextAsync(randomUUID(),'/root','q');expect(r.state).toBe('unavailable');expect(Object.keys(r).sort()).toEqual(['error','groups','hits','state','truncated']);texts.push(r.error!);}
    expect(new Set(texts).size).toBe(reasons.length);
    expect(texts[1]).toContain('늦어');expect(texts[2]).toContain('연결하지 못했습니다');
    expect(texts[5]).toBe('연결된 클라우드 공통기억 조회를 완료하지 못했습니다. 전용 기억은 보존됩니다.');
  });
});

describe('recallProjectMemoryWithCommon',()=>{
  const project=()=>{const root=temp('t3-recall-');initializeProjectMemory({folderPath:root,projectName:'Recall fixture',agent:'codex'});return root;};
  const legacy=async(input:{folderPath:string;query:string;appDataDir:string})=>{const status=detectProjectMemory(input.folderPath),result=recallProjectMemory(input,status);return {...result,commonMemory:await projectMetaMemoryContextAsync(result.memoryId,status.projectRoot,input.query)};};
  const recall:MetaMemoryRecall={state:'ready',groups:[],hits:[],truncated:false};
  test('equals the former composition (fields and order) with a sync reader, an async reader and none',async()=>{
    const root=project(),app=temp('t3-app-'),input={folderPath:root,query:'장기기억',appDataDir:app};
    for(const install of [()=>installProjectMetaMemoryReader(null),()=>installProjectMetaMemoryReader(()=>recall),()=>installProjectMetaMemoryReader(async()=>recall,true)]){
      install();const before=await legacy(input),after=await recallProjectMemoryWithCommon(input);
      expect(after).toEqual(before);expect(Object.keys(after)).toEqual(Object.keys(before));
    }
  });
  test('reads the memory document once and calls the reader once',async()=>{
    const root=project(),memoryPath=resolve(detectProjectMemory(root).memoryPath!);let calls=0;
    installProjectMetaMemoryReader(()=>{calls++;return recall;});
    const spy=spyOn(fs,'readFileSync');
    try{
      await recallProjectMemoryWithCommon({folderPath:root,query:'장기기억',appDataDir:temp('t3-app-')});
      // The source (CORE.md or a single file) or a note body; the notes manifest is layout, not the document.
      const documentReads=spy.mock.calls.filter(([path])=>typeof path==='string'&&(resolve(path)===memoryPath||/\/\.agent-memory\/notes\/.+\.md$/.test(resolve(path)))).length;
      expect(documentReads).toBe(1);expect(calls).toBe(1);
      // The former composition (full detect, then recall) read it at least twice (3 here) and called the reader twice.
      spy.mockClear();calls=0;await legacy({folderPath:root,query:'장기기억',appDataDir:temp('t3-app-')});
      expect(spy.mock.calls.filter(([path])=>typeof path==='string'&&resolve(path)===memoryPath).length).toBeGreaterThanOrEqual(2);expect(calls).toBe(2);
    }finally{spy.mockRestore();}
  });
  test('includeCommon:false never calls the reader and returns no commonMemory',async()=>{
    const root=project();let calls=0;
    installProjectMetaMemoryReader(async()=>{calls++;return recall;},true);
    const r=await recallProjectMemoryWithCommon({folderPath:root,query:'장기기억',appDataDir:temp('t3-app-'),includeCommon:false});
    expect(calls).toBe(0);expect(r).not.toHaveProperty('commonMemory');expect(Array.isArray(r.hits)).toBe(true);
    installProjectMetaMemoryReader(()=>{calls++;return recall;});
    recallProjectMemory({folderPath:root,query:'장기기억',includeCommon:false});expect(calls).toBe(0);
  });
  test('an uninitialized folder still fails before any reader call',async()=>{
    const root=temp('t3-empty-');let calls=0;installProjectMetaMemoryReader(async()=>{calls++;return recall;},true);
    await expect(recallProjectMemoryWithCommon({folderPath:root,query:'q'})).rejects.toThrow('장기기억을 시작하세요');expect(calls).toBe(0);
  });
});

describe('session-save prompt',()=>{
  const count=(text:string,needle:string)=>text.split(needle).length-1;
  test('one COMMON MEMORY block with an async reader, whether it answers or fails',async()=>{
    const root=temp('t3-save-');initializeProjectMemory({folderPath:root,projectName:'Save fixture',agent:'codex'});
    const group={id:randomUUID(),name:'공유 규칙',revision:1,entries:[]} as any;
    installProjectMetaMemoryReader(async()=>({state:'ready',groups:[group],hits:[],truncated:false}),true);
    const ready=await prepareProjectMemoryUpdateWithCommon({folderPath:root},{text:'',stats:EMPTY_STATS});
    expect(count(ready.prompt,'COMMON MEMORY')).toBe(1);expect(ready.prompt).toContain('공유 규칙');expect(ready.prompt).not.toContain('META COMMON MEMORY');
    installProjectMetaMemoryReader(async()=>{throw new CommonMemoryError('COMMON_MEMORY_CLOUD_UNAVAILABLE','x',503);},true);
    const failed=await prepareProjectMemoryUpdateWithCommon({folderPath:root},{text:'',stats:EMPTY_STATS});
    expect(count(failed.prompt,'COMMON MEMORY')).toBe(1);expect(failed.prompt).toContain('COMMON MEMORY: unavailable');
    // Without the cloud reader the synchronous path is unchanged.
    installProjectMetaMemoryReader(null);
    const plain=await prepareProjectMemoryUpdateWithCommon({folderPath:root},{text:'',stats:EMPTY_STATS});
    expect(count(plain.prompt,'COMMON MEMORY')).toBe(0);
  });
});
