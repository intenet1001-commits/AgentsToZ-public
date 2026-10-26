import {afterEach,beforeEach,expect,test} from 'bun:test';
import {checkUnsavedNow,clearSaveRun,pauseBackgroundCheck,publishUnsaved,resetUnsavedSessionMemoryForTest,saveTargets,unsavedCandidates,unsavedNoticeId} from '../src/unsavedSessionMemory';
import * as store from '../src/unsavedSessionMemory';
import type {ContextSession} from '../src/contextSessionMemoryPath';

// 「저장 안 된 작업」 in the dock (VOC 2026-10-24): which open sessions have unsaved project memory, and the
// one-click save that goes through them one at a time. Browser behaviour: scripts/check-voice-dock-sessions.ts.

const A='/p/app',B='/p/ops',C='/p/blog';
const session=(id:string,cwd:string,over:Partial<ContextSession>={}):ContextSession=>({sessionId:id,sourceAgent:'claude',cwd,projectDir:null,threadSource:null,threadTitle:null,projectHint:null,
  modelId:null,modelName:null,windowSize:null,usedPercent:40,remainingPercent:60,usedTokens:null,costUsd:null,ageMs:1000,state:'active',clientLabel:'Claude Code',
  surfaceKind:'terminal',surfaceLabel:'Terminal',surfaceDetail:null,surfacePresence:null,...over});

type Memory={exists:boolean;needs:boolean;autoBackup?:boolean};
let memory:Record<string,Memory>,sessions:ContextSession[],calls:{path:string;body?:any}[],saveReply:(folder:string)=>Promise<Response>;
let active=0,maxActive=0;
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
const realFetch=globalThis.fetch;
beforeEach(()=>{
  resetUnsavedSessionMemoryForTest();clearSaveRun();
  memory={[A]:{exists:true,needs:true},[B]:{exists:true,needs:false},[C]:{exists:true,needs:true,autoBackup:false}};
  sessions=[session('a',A),session('b',B,{sourceAgent:'codex'}),session('c',C)];
  calls=[];active=0;maxActive=0;
  saveReply=async folder=>{memory[folder]!.needs=false;return json({success:true,localSaved:true,remoteBackedUp:true});};
  globalThis.fetch=(async(input:RequestInfo|URL,init?:RequestInit)=>{
    const path=String(input).replace(/^https?:\/\/[^/]+/,''),body=init?.body?JSON.parse(String(init.body)):undefined;calls.push({path,body});
    if(path==='/api/context-usage')return json({sessions});
    if(path==='/api/ports')return json([{id:'p1',name:'앱',folderPath:A},{id:'p2',name:'운영',folderPath:B},{id:'p3',name:'블로그',folderPath:C}]);
    if(path==='/api/project-memory/detect'){const m=memory[body.folderPath];return json(m?{exists:m.exists,config:m.exists?{autoBackup:m.autoBackup!==false}:null,activity:{needsRemember:m.needs,lastRememberedAt:'2026-10-24T01:00:00.000Z'}}:{exists:false});}
    if(path==='/api/project-memory/session-end'){active+=1;maxActive=Math.max(maxActive,active);try{await new Promise(r=>setTimeout(r,5));return await saveReply(body.folderPath);}finally{active-=1;}}
    throw new Error('unexpected '+path);
  }) as typeof fetch;
});
afterEach(()=>{globalThis.fetch=realFetch;});
test('the background check finds open sessions whose memory has unsaved work, one entry per folder',async()=>{
  sessions.push(session('a-old',A,{ageMs:50_000,sourceAgent:'codex'}),session('stale',C,{state:'stale'}));
  await checkUnsavedNow(true);
  const {unsaved}=peek();
  expect(unsaved.map(u=>[u.folder,u.name,u.agent])).toEqual([[A,'앱','claude'],[C,'블로그','claude']]);
  // Each folder is probed once, one after another, and nothing is saved by looking.
  expect(calls.filter(c=>c.path==='/api/project-memory/detect').map(c=>c.body.folderPath)).toEqual([A,B,C]);
  expect(calls.some(c=>c.path==='/api/project-memory/session-end')).toBe(false);
});

test('candidates skip a Voice session before its project binding is confirmed, and stale or Codex thread folders',()=>{
  const voice=session('v',B,{sourceAgent:'codex',threadSource:'realtime_voice',projectHint:{path:B,name:'운영'} as any,voiceBindingState:'assigned-pending' as any});
  const rows=unsavedCandidates([voice,session('s',C,{state:'stale'}),session('a',A)],[]);
  expect(rows.map(r=>r.folder)).toEqual([A]);
});

test('while the session list is open it publishes instead, and the background check stands down',async()=>{
  const resume=pauseBackgroundCheck();
  await checkUnsavedNow(true);
  expect(calls.length).toBe(0);
  publishUnsaved([{folder:B,name:'운영',agent:'codex',lastRememberedAt:null}]);
  expect(peek().unsaved.map(u=>u.folder)).toEqual([B]);
  resume();await new Promise(r=>setTimeout(r,30));
  expect(calls.some(c=>c.path==='/api/context-usage')).toBe(true);
});

test('「모두 저장」 saves one project at a time with each session’s agent, keeping the preferred agent and backup setting',async()=>{
  await checkUnsavedNow(true);
  const targets=peek().unsaved.map(({folder,name,agent})=>({folder,name,agent}));
  const started=saveTargets(targets);
  expect(await saveTargets(targets)).toBe(false);// a second run in the same window waits for the first
  expect(await started).toBe(true);
  expect(maxActive).toBe(1);
  const saves=calls.filter(c=>c.path==='/api/project-memory/session-end').map(c=>c.body);
  expect(saves).toEqual([
    {folderPath:A,projectName:'앱',agent:'claude',autoBackup:true,preservePreferredAgent:true},
    {folderPath:C,projectName:'블로그',agent:'claude',autoBackup:false,preservePreferredAgent:true},
  ]);
  const run=peek().run!;
  expect(run.running).toBe(false);
  expect(run.items.map(i=>i.status)).toEqual(['saved','saved']);
  expect(run.items[0]!.message).toBe('저장 완료 · 로컬 기억과 Supabase 백업을 갱신했습니다.');
  expect(peek().unsaved).toEqual([]);
});

test('right before each save it re-checks: an already current project is skipped, not saved again',async()=>{
  memory[A]!.needs=false;
  await saveTargets([{folder:A,name:'앱',agent:'claude'}]);
  expect(calls.some(c=>c.path==='/api/project-memory/session-end')).toBe(false);
  expect(peek().run!.items[0]).toMatchObject({status:'skipped',message:'새로 저장할 활동이 없습니다 · 이미 최신 장기기억입니다.'});
});

test('no memory yet: only a registered project’s own row may start one',async()=>{
  memory[A]={exists:false,needs:false};
  await saveTargets([{folder:A,name:'앱',agent:'claude'}]);
  expect(peek().run!.items[0]!.status).toBe('skipped');
  expect(calls.some(c=>c.path==='/api/project-memory/session-end')).toBe(false);
  await saveTargets([{folder:A,name:'앱',agent:'claude',allowStart:true}]);
  expect(peek().run!.items[0]!.status).toBe('saved');
});

test('a busy host is skipped and stays unsaved; a conflict is a failure; the run goes on',async()=>{
  await checkUnsavedNow(true);
  saveReply=async folder=>folder===A?json({error:'다른 기억 저장이 실행 또는 대기 중입니다.',code:'MEMORY_SAVE_BUSY'},409)
    :json({success:false,localSaved:false,preflightConflict:true,backupError:'원격 리비전 r2'});
  await saveTargets([{folder:A,name:'앱',agent:'claude'},{folder:C,name:'블로그',agent:'claude'}]);
  const [busy,conflict]=peek().run!.items;
  expect(busy).toMatchObject({status:'skipped',message:'다른 기억 저장이 진행 중이라 시작하지 않았습니다 · 잠시 후 다시 저장하세요.'});
  expect(conflict).toMatchObject({status:'failed',message:'로컬·Supabase가 모두 바뀌어 저장하지 않았습니다 · 프로젝트 화면에서 검토하세요.'});
  expect(calls.filter(c=>c.path==='/api/project-memory/session-end').length).toBe(2);
});

test('an unknown outcome is never resent, and the rest of the run does not start behind it',async()=>{
  saveReply=async()=>{throw new TypeError('Failed to fetch');};
  await saveTargets([{folder:A,name:'앱',agent:'claude'},{folder:C,name:'블로그',agent:'claude'}]);
  expect(calls.filter(c=>c.path==='/api/project-memory/session-end').map(c=>c.body.folderPath)).toEqual([A]);
  expect(peek().run!.items.map(i=>i.status)).toEqual(['unknown','stopped']);
  expect(peek().run!.items[0]!.message).toMatch(/다시 보내지 않았습니다/);
});

test('a backup that failed after the local save still counts as saved, and says how to retry it',async()=>{
  saveReply=async()=>json({success:false,localSaved:true,remoteBackedUp:false,backupError:'네트워크'});
  await saveTargets([{folder:A,name:'앱',agent:'claude'}]);
  expect(peek().run!.items[0]).toMatchObject({status:'saved',message:'로컬에 저장했습니다 · Supabase 백업은 「동기화」로 다시 시도하세요 (네트워크)'});
});

test('the dismissal key ignores order and changes when the set or a last save changes',()=>{
  const a={folder:A,name:'앱',agent:'claude' as const,lastRememberedAt:'t1'},c={folder:C,name:'블로그',agent:'claude' as const,lastRememberedAt:'t2'};
  expect(unsavedNoticeId([a,c])).toBe(unsavedNoticeId([c,a]));
  expect(unsavedNoticeId([a])).not.toBe(unsavedNoticeId([a,c]));
  expect(unsavedNoticeId([{...a,lastRememberedAt:'t3'},c])).not.toBe(unsavedNoticeId([a,c]));
  expect(unsavedNoticeId([a,c]).length).toBeLessThan(64);
});

function peek(){return store.peekUnsavedSessionMemoryForTest();}
