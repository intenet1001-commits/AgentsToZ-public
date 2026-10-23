import {describe,expect,test} from 'bun:test';
import {readFileSync} from 'node:fs';
import golden from './fixtures/conversation-target-golden.json';
import type {AiTerminalService} from '../src/aiTerminalService';
import {bindVoiceRuntime} from '../src/voiceRuntimeBinding';
import {
  conversationTargetDirectory,pageConversationTargets,resolveConversationTarget,textConversationTargets,voiceConversationTargets,
  type ConversationDirectoryEntry,type ConversationDirectoryRuntimeTarget,
} from '../src/conversationTargetDirectory';

const runtimeTargets=golden.runtimeTargets as ConversationDirectoryRuntimeTarget[];
const allIds=new Set(golden.ports.map(port=>port.id));
const textDirectory=()=>textConversationTargets(golden.ports,{opsProjectId:golden.opsProjectId,available:allIds});
const voiceDirectory=()=>voiceConversationTargets(golden.ports,runtimeTargets,{opsProjectId:golden.opsProjectId});

/** The real OPS voice binding; resolve_target_alias never touches a terminal. */
async function opsVoice(entries:ConversationDirectoryEntry[]){
  return bindVoiceRuntime({terminal:{} as AiTerminalService,targets:async()=>entries,target:async()=>({label:'unused',fingerprint:'unused'}),
    ops:()=>({fingerprint:'ops',projectId:golden.opsProjectId}),recall:()=>({}),projectRecall:async()=>({}),propose:async()=>({})},{kind:'ops'},{owner:'local',active:()=>true});
}

describe('conversation target directory (text and voice share one inventory)',()=>{
  test('identity comes from the registered row: name, aiName alias, bound OPS role and folder DEV role',()=>{
    const voice=voiceDirectory();
    const byId=new Map(voice.map(entry=>[entry.id,entry]));
    // 헤르메스 used to be named by its runtime label 'Claude Agent Config' in voice.
    expect(byId.get('4e1f7c2a-3333-4b4b-9c9c-000000000003')).toEqual({id:'4e1f7c2a-3333-4b4b-9c9c-000000000003',name:'헤르메스',aliases:['Claude Agent Config'],role:'managed',scope:'main'});
    // No stored role: the Control binding makes OPS, the folder leaf makes DEV (voice read only the stored field).
    expect(byId.get(golden.opsProjectId)).toMatchObject({name:'AgentsToZ-Control',role:'ops',scope:'main'});
    expect(byId.get(golden.opsProjectId)!.aliases).toBeUndefined();
    expect(byId.get('6f1d0a52-8d7e-4c5b-9a3f-1b2c3d4e5f60')).toMatchObject({name:'AgentsToZ_byCS',aliases:['AgentsToZ Port Manager'],role:'dev'});
    // A registered worktree keeps its registered name and inherits the family role.
    expect(byId.get('0b7a2c1e-2222-4a4a-8b8b-000000000002_wt_feature')).toMatchObject({name:'vibe2 (feature)',role:'managed',scope:'worktree'});
    // An unregistered Git worktree is named from the parent's registered name, not its aiName label.
    expect(byId.get('rwt_9a1b2c3d4e5f60718293a4b5c6d7e8f901234567890abcde')).toEqual({id:'rwt_9a1b2c3d4e5f60718293a4b5c6d7e8f901234567890abcde',name:'vibe2 · hotfix',aliases:['Vibe Coding Guide v2 · hotfix'],role:'managed',scope:'worktree'});
  });

  test('both surfaces list the same registered projects in the same order',()=>{
    const registered=(entries:ConversationDirectoryEntry[])=>entries.filter(entry=>allIds.has(entry.id));
    expect(registered(voiceDirectory())).toEqual(textDirectory());
    // The voice inventory additionally carries the unregistered worktree; text has no Git scan.
    expect(voiceDirectory().length).toBe(textDirectory().length+1);
  });

  for(const scenario of golden.cases)test(`golden «${scenario.alias}»: voice == text`,async()=>{
    const text=resolveConversationTarget(scenario.alias,textDirectory());
    const voice=await (await opsVoice(voiceDirectory())).run('resolve_target_alias',{alias:scenario.alias},'voice_request_fixture');
    expect(voice).toEqual(text);
    const {candidateNames,...expected}=scenario.expected as Record<string,unknown>&{candidateNames?:string[]};
    expect(text).toMatchObject(expected);
    if(candidateNames){
      if(text.resolved)throw new Error('expected a miss');
      expect(text.candidates.map(candidate=>candidate.name).sort()).toEqual([...candidateNames].sort());
      expect(text.candidates.some(candidate=>candidate.id.startsWith('rwt_')||candidate.id.endsWith('_wt_feature'))).toBe(false);
    }
  });

  test('the old voice inventory (runtime label as the name, stored role only) could not do this',()=>{
    const aiNames=new Map(golden.ports.map(port=>[port.id,(port as {aiName?:string}).aiName]));
    const old=runtimeTargets.map(target=>({id:target.targetId,name:target.label,aliases:aiNames.get(target.targetId)?[aiNames.get(target.targetId)!]:undefined,role:'unknown' as const,scope:target.scope}));
    expect(resolveConversationTarget('헤르메스 담당자',old).resolved).toBe(false);
    expect(resolveConversationTarget('아젠투지개발',old).resolved).toBe(false);
  });

  test('an ambiguous 아젠투지개발 returns only the DEV candidates on both surfaces',async()=>{
    const ports=[...golden.ports,{id:'7d7d7d7d-4444-4c4c-8d8d-000000000004',name:'AgentsToZ 검증 사본',role:'dev',folderPath:'/Users/fixture/clones/validation'}];
    const text=resolveConversationTarget('아젠투지개발',textConversationTargets(ports,{opsProjectId:golden.opsProjectId,available:new Set(ports.map(port=>port.id))}));
    const voice=await (await opsVoice(voiceConversationTargets(ports,[...runtimeTargets,{targetId:'7d7d7d7d-4444-4c4c-8d8d-000000000004',projectTargetId:'7d7d7d7d-4444-4c4c-8d8d-000000000004',label:'AgentsToZ 검증 사본',scope:'main',branch:null}],{opsProjectId:golden.opsProjectId}))).run('resolve_target_alias',{alias:'아젠투지개발'},'voice_request_fixture');
    expect(voice).toEqual(text);
    expect(text).toMatchObject({resolved:false,code:'TARGET_ALIAS_AMBIGUOUS'});
    if(text.resolved)throw new Error('expected ambiguity');
    expect(text.candidates.map(candidate=>candidate.id).sort()).toEqual(['6f1d0a52-8d7e-4c5b-9a3f-1b2c3d4e5f60','7d7d7d7d-4444-4c4c-8d8d-000000000004']);
  });

  test('a duplicated or missing registration is never offered, and text keeps only confirmed folders',()=>{
    const duplicated=[...golden.ports,{...golden.ports[2]!,name:'vibe copy'}];
    expect(conversationTargetDirectory({ports:duplicated}).some(entry=>entry.id===golden.ports[2]!.id)).toBe(false);
    const confirmed=textConversationTargets(golden.ports,{opsProjectId:golden.opsProjectId,available:new Set([golden.opsProjectId])});
    expect(confirmed.map(entry=>entry.id)).toEqual([golden.opsProjectId]);
    // Voice: a registered row without a runtime target (missing folder) does not exist.
    expect(voiceConversationTargets(golden.ports,runtimeTargets.filter(target=>target.targetId!=='4e1f7c2a-3333-4b4b-9c9c-000000000003'),{}).some(entry=>entry.name==='헤르메스')).toBe(false);
  });
});

describe('list_projects paging',()=>{
  const synthetic=(count:number)=>conversationTargetDirectory({ports:Array.from({length:count},(_,index)=>({id:`project-${String(index).padStart(4,'0')}-fixture`,name:`프로젝트 ${String(index).padStart(3,'0')} ${'가'.repeat(30)}`,aiName:`Synthetic Project ${index} ${'x'.repeat(60)}`,folderPath:`/Users/fixture/p${index}`}))});

  test('pages at most 40 rows, reports total and the next offset, and stays inside the byte budget',()=>{
    const entries=synthetic(150);
    const first=pageConversationTargets(entries,{});
    expect(first.total).toBe(150);expect(first.offset).toBe(0);
    expect(first.projects.length).toBeGreaterThan(0);expect(first.projects.length).toBeLessThanOrEqual(40);
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThan(16_000);
    let seen=first.projects.length,next=first.nextOffset;
    while(next!==null){const page=pageConversationTargets(entries,{offset:next});expect(page.offset).toBe(next);expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(16_000);seen+=page.projects.length;next=page.nextOffset;}
    expect(seen).toBe(150);
    expect(pageConversationTargets(entries,{offset:500})).toEqual({total:150,offset:500,nextOffset:null,projects:[]});
    const voicePages=[];let voiceOffset:number|null=0;
    while(voiceOffset!==null){const page:{projects:typeof entries;nextOffset:number|null}=pageConversationTargets(entries,{offset:voiceOffset,limit:12});expect(page.projects.length).toBeLessThanOrEqual(12);voicePages.push(...page.projects);voiceOffset=page.nextOffset;}
    expect(voicePages.map(entry=>entry.id)).toEqual(entries.map(entry=>entry.id));
  });

  test('query matches the registered name or an alias, ignoring case and spaces',()=>{
    const entries=voiceDirectory();
    expect(pageConversationTargets(entries,{query:'VIBE2'}).projects.map(entry=>entry.name).sort()).toEqual(['vibe2','vibe2 (feature)','vibe2 · hotfix'].sort());
    expect(pageConversationTargets(entries,{query:'claude agent'}).projects.map(entry=>entry.name)).toEqual(['헤르메스']);
    expect(pageConversationTargets(entries,{query:'헤 르메스'})).toMatchObject({total:1});
    expect(pageConversationTargets(entries,{query:'없는 이름'})).toEqual({total:0,offset:0,nextOffset:null,projects:[]});
    expect(pageConversationTargets(entries,{query:'ㅎㄹㅁㅅ'}).projects.map(entry=>entry.name)).toEqual(['헤르메스']);
    expect(pageConversationTargets(entries,{query:'gpfmaptm'}).projects.map(entry=>entry.name)).toEqual(['헤르메스']);
  });
});

test('api-server builds both the text resolve-target and the voice targets from this directory',()=>{
  const api=readFileSync(new URL('../api-server.ts',import.meta.url),'utf8');
  const resolveTarget=api.slice(api.indexOf("if(request.action==='resolve-target')"),api.indexOf("if (request.action === \"list-workspace-roots\")"));
  expect(resolveTarget).toContain('textConversationTargets(');
  expect(resolveTarget).toContain('resolveConversationTarget(');
  expect(resolveTarget).not.toContain('registeredProjectAliasMap');
  const voice=api.slice(api.indexOf('bind:(target,authority)=>bindVoiceRuntime({'),api.indexOf('const quickLabelsDirectory'));
  expect(voice).toContain('voiceConversationTargets(');
  expect(voice).not.toContain('registeredProjectAliasMap');
});
