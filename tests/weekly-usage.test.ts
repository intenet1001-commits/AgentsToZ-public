import {afterEach,expect,test} from 'bun:test';
import {chmodSync,existsSync,mkdtempSync,mkdirSync,readFileSync,readdirSync,statSync,writeFileSync,rmSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {WeeklyUsageHost,readWeeklyUsageRequest} from '../src/weeklyUsageHost';
import {normalizeWeeklyUsageRequest,weeklyBuckets,weeklyUsageState,type WeeklyUsage} from '../src/weeklyUsage';
const roots:string[]=[];afterEach(()=>{for(const r of roots.splice(0))rmSync(r,{recursive:true,force:true});});
test('only explicit weekly windows count; a context or five-hour percentage is never substituted',()=>{
 expect(weeklyBuckets('codex',{primary:{window_minutes:300,used_percent:80},secondary:{window_minutes:10080,used_percent:24}})[0]?.remainingPercent).toBe(76);
 expect(weeklyBuckets('claude',{five_hour:{used_percentage:20},context_window:{used_percentage:40}})).toEqual([]);
 expect(weeklyBuckets('claude',{seven_day:{used_percentage:0}})[0]?.remainingPercent).toBe(100);
 expect(weeklyBuckets('claude',{seven_day:{used_percentage:100}})[0]?.remainingPercent).toBe(0);
 expect(weeklyBuckets('claude',{seven_day:{used_percentage:101}})).toEqual([]);
 expect(weeklyBuckets('agy',{'gemini-weekly':{remaining_fraction:.9378},'claude-weekly':{remaining_fraction:.42},'gemini-five-hour':{remaining_fraction:.1},'bad-weekly':{remaining_amount:500},'off-weekly':{remaining_fraction:1,disabled:true}}).map(b=>b.remainingPercent)).toEqual([93.8,42]);
});
test('old or reset readings remain previous values; absence never means unused',()=>{
 const now=Date.now(),row:WeeklyUsage={provider:'claude',buckets:[],checkedAt:null,source:'unavailable',connected:true,canConnect:true};
 expect(weeklyUsageState(row,now)).toBe('waiting');
 row.buckets=[{label:'주간',remainingPercent:43,resetsAt:now/1000-1}];row.checkedAt=new Date(now).toISOString();expect(weeklyUsageState(row,now)).toBe('stale');expect(row.buckets[0]?.remainingPercent).toBe(43);
 row.buckets[0]!.resetsAt=null;row.checkedAt=new Date(now-16*60_000).toISOString();expect(weeklyUsageState(row,now)).toBe('stale');
});
test('local management requests have no arbitrary path, command, settings or provider',()=>{
 expect(normalizeWeeklyUsageRequest({operation:'status'})).toEqual({operation:'status'});
 for(const v of [{operation:'connect',provider:'codex'},{operation:'connect',provider:'claude',command:'anything'},{operation:'status',path:'/tmp'},{operation:'connect',provider:'agy',settings:{}}])expect(()=>normalizeWeeklyUsageRequest(v)).toThrow();
});
test('request bodies reject oversized, invalid UTF-8 and stalled input',async()=>{
 expect(await readWeeklyUsageRequest(new Request('http://localhost',{method:'POST',body:'{"operation":"status"}'}))).toEqual({operation:'status'});
 for(const body of [' '.repeat(1025),new Uint8Array([0xff])])await expect(readWeeklyUsageRequest(new Request('http://localhost',{method:'POST',body}))).rejects.toThrow();
 await expect(readWeeklyUsageRequest(new Request('http://localhost',{method:'POST',body:new ReadableStream({start(){}}),duplex:'half'} as RequestInit))).rejects.toThrow();
},10000);
function fixture(){
 const root=mkdtempSync(join(tmpdir(),"weekly quota's "));roots.push(root);const app=join(root,'app');mkdirSync(app,{mode:0o700});mkdirSync(join(root,'.claude'));mkdirSync(join(root,'.gemini'));mkdirSync(join(root,'.gemini','antigravity-cli'));
 const host=new WeeklyUsageHost({home:root,appDataDir:app,python:Bun.which('python3'),available:()=>true,codex:async()=>({rateLimits:{primary:{window_minutes:10080,used_percent:30}},checkedAt:new Date().toISOString()})});
 return {root,app,host,settings:join(root,'.claude','settings.json'),agy:join(root,'.gemini','antigravity-cli','settings.json')};
}
test.skipIf(process.platform==='win32'||!Bun.which('python3'))('connection preserves native output and all other settings; the cache contains only quota metadata',async()=>{
 const f=fixture();const original={env:{privateValue:'preserved'},statusLine:{type:'command',command:"printf 'original-line'",padding:2}};writeFileSync(f.settings,JSON.stringify(original));
 await f.host.perform({operation:'connect',provider:'claude'});await f.host.perform({operation:'connect',provider:'claude'});
 const config=JSON.parse(readFileSync(f.settings,'utf8'));expect(config.env).toEqual(original.env);expect(config.statusLine.padding).toBe(2);
 const input={rate_limits:{seven_day:{used_percentage:37,resets_at:Date.now()/1000+86400}},email:'private@example.invalid',transcript_path:'/private/transcript',token:'DO-NOT-STORE'};
 const p=Bun.spawn(['/bin/sh','-c',config.statusLine.command],{stdin:new Blob([JSON.stringify(input)]),stdout:'pipe',stderr:'pipe'});
 expect(await new Response(p.stdout).text()).toBe('original-line');expect(await p.exited).toBe(0);
 const cache=readFileSync(join(f.host.root,'claude.json'),'utf8');expect(cache).not.toMatch(/private@example|transcript|DO-NOT-STORE|privateValue/);
 const row=(await f.host.status())[0]!;expect(row.buckets[0]?.remainingPercent).toBe(63);
 const p2=Bun.spawn(['/bin/sh','-c',config.statusLine.command],{stdin:new Blob([JSON.stringify(input)]),stdout:'pipe',stderr:'pipe'});await p2.exited;expect(readFileSync(join(f.host.root,'claude.json'),'utf8')).toBe(cache);
 await f.host.perform({operation:'disconnect',provider:'claude'});expect(JSON.parse(readFileSync(f.settings,'utf8'))).toEqual(original);
});
test.skipIf(process.platform==='win32'||!Bun.which('python3'))('disabled native commands stay disabled; observed missing weekly data is distinct from no activity',async()=>{
 const f=fixture();writeFileSync(f.agy,JSON.stringify({statusLine:{type:'command',command:'exit 99',enabled:false}}));await f.host.perform({operation:'connect',provider:'agy'});
 const config=JSON.parse(readFileSync(f.agy,'utf8'));expect(config.statusLine.stack_with_default).toBe(true);
 const p=Bun.spawn(['/bin/sh','-c',config.statusLine.command],{stdin:new Blob([JSON.stringify({context_window:{used_percentage:3},quota:{'five-hour':{remaining_fraction:1}}})]),stdout:'pipe',stderr:'pipe'});expect(await p.exited).toBe(0);
 const row=(await f.host.status())[2]!;expect(row.checkedAt).not.toBeNull();expect(row.buckets).toEqual([]);expect(weeklyUsageState(row)).toBe('unavailable');
});
test.skipIf(process.platform==='win32'||!Bun.which('python3'))('Antigravity retains the built-in footer, captures each weekly pool and ignores context usage',async()=>{
 const f=fixture();writeFileSync(f.agy,JSON.stringify({model:'keep'}));await f.host.perform({operation:'connect',provider:'agy'});
 const config=JSON.parse(readFileSync(f.agy,'utf8'));expect(config.statusLine.stack_with_default).toBe(true);
 const p=Bun.spawn(['/bin/sh','-c',config.statusLine.command],{stdin:new Blob([JSON.stringify({context_window:{remaining_percentage:99},quota:{'gemini-weekly':{remaining_fraction:.81,reset_time:new Date(Date.now()+86400_000).toISOString()},'claude-weekly':{remaining_fraction:.22},'five-hour':{remaining_fraction:.4}}})]),stdout:'pipe',stderr:'pipe'});await p.exited;
 expect((await f.host.status())[2]?.buckets.map(b=>b.remainingPercent)).toEqual([81,22]);
 await f.host.perform({operation:'disconnect',provider:'agy'});expect(JSON.parse(readFileSync(f.agy,'utf8'))).toEqual({model:'keep'});
});
test.skipIf(process.platform==='win32'||!Bun.which('python3'))('disconnect preserves external edits and connection rejects symlinked settings',async()=>{
 const f=fixture();writeFileSync(f.settings,'{}');await f.host.perform({operation:'connect',provider:'claude'});writeFileSync(f.settings,JSON.stringify({statusLine:{command:'external-new'}}));
 await f.host.perform({operation:'disconnect',provider:'claude'});expect(JSON.parse(readFileSync(f.settings,'utf8')).statusLine.command).toBe('external-new');
 rmSync(f.settings);symlinkSync(join(f.root,'missing-settings'),f.settings);await expect(f.host.perform({operation:'connect',provider:'claude'})).rejects.toThrow();
});
test.skipIf(process.platform==='win32'||!Bun.which('python3'))('an interpreter change repairs the owned hook and an unavailable CLI still allows restoration',async()=>{
 const f=fixture(),original={statusLine:{type:'command',command:'printf original'}};writeFileSync(f.settings,JSON.stringify(original));
 await f.host.perform({operation:'connect',provider:'claude'});
 const changed=new WeeklyUsageHost({home:f.root,appDataDir:f.app,python:'/usr/bin/python3',available:()=>true,codex:async()=>({rateLimits:null})});
 await changed.perform({operation:'connect',provider:'claude'});
 expect(JSON.parse(readFileSync(f.settings,'utf8')).statusLine.command).toContain('/usr/bin/python3');
 const absent=new WeeklyUsageHost({home:f.root,appDataDir:f.app,python:null,available:()=>false,codex:async()=>({rateLimits:null})});
 expect((await absent.status())[0]?.connected).toBe(true);
 await absent.perform({operation:'disconnect',provider:'claude'});expect(JSON.parse(readFileSync(f.settings,'utf8'))).toEqual(original);
});
// v2: the same hook writes the Claude context snapshot the dock's 「최근 AI 세션」 reads (/api/context-usage). Before, nothing
// in the app wrote <appData>/context, so no Claude row — Workroom or Orca — could ever reach Compact·Clear (2026-10-31).
const SID='5f0c8a1e-2b3d-4c5e-8f60-718293a4b5c6',WORKROOM='0b1c2d3e-4f50-4a6b-9c7d-8e9fa0b1c2d3';
const claudePayload=(extra:Record<string,unknown>={})=>({session_id:SID,transcript_path:'/private/transcript.jsonl',cwd:'/Users/fixture/project',
 workspace:{current_dir:'/Users/fixture/project',project_dir:'/Users/fixture/project'},model:{id:'claude-fixture',display_name:'Fixture'},
 context_window:{context_window_size:200000,used_percentage:42.5,remaining_percentage:57.5,current_usage:{input_tokens:10,cache_creation_input_tokens:20,cache_read_input_tokens:30,output_tokens:5}},
 cost:{total_cost_usd:1.25},rate_limits:{seven_day:{used_percentage:37}},email:'private@example.invalid',...extra});
async function runHook(command:string,input:unknown,env:Record<string,string>={}){
 const base={...process.env};for(const k of Object.keys(base))if(/^(ORCA_|CMUX_|AGENTSTOZ_WORKROOM_|TERM_PROGRAM|CLAUDE_CODE_ENTRYPOINT)/.test(k))delete base[k];
 const p=Bun.spawn(['/bin/sh','-c',command],{stdin:new Blob([JSON.stringify(input)]),stdout:'pipe',stderr:'pipe',env:{...base,...env}});
 const [out,code]=await Promise.all([new Response(p.stdout).text(),p.exited]);return {out,code};
}
test.skipIf(process.platform==='win32'||!Bun.which('python3'))('the Claude hook writes the context snapshot the session list reads, with its terminal, and nothing private',async()=>{
 const f=fixture();writeFileSync(f.settings,JSON.stringify({statusLine:{type:'command',command:"printf 'original-line'"}}));
 await f.host.perform({operation:'connect',provider:'claude'});const command=JSON.parse(readFileSync(f.settings,'utf8')).statusLine.command;
 const ran=await runHook(command,claudePayload(),{TERM_PROGRAM:'Orca',TERM_PROGRAM_VERSION:'1.4.211',CLAUDE_CODE_ENTRYPOINT:'cli',ORCA_PANE_KEY:'tab-1:2',ORCA_WORKTREE_ID:'repo::/Users/fixture/project',ORCA_AGENT_HOOK_TOKEN:'DO-NOT-STORE'});
 expect(ran).toEqual({out:'original-line',code:0});
 const file=join(f.app,'context',SID+'.json'),raw=readFileSync(file,'utf8'),snap=JSON.parse(raw);
 expect(statSync(file).mode&0o777).toBe(0o600);expect(statSync(join(f.app,'context')).mode&0o777).toBe(0o700);
 // The exact fields api-server reads: sessionId/cwd/projectDir/model/contextWindow/cost/capturedAt/launchContext.
 expect(snap).toMatchObject({sessionId:SID,cwd:'/Users/fixture/project',projectDir:'/Users/fixture/project',model:{id:'claude-fixture',display_name:'Fixture'},
  contextWindow:{context_window_size:200000,used_percentage:42.5,remaining_percentage:57.5,current_usage:{input_tokens:10,cache_creation_input_tokens:20,cache_read_input_tokens:30}},cost:{total_cost_usd:1.25},
  launchContext:{orcaPaneKey:'tab-1:2',orcaWorktreeId:'repo::/Users/fixture/project',termProgram:'Orca',termProgramVersion:'1.4.211',claudeCodeEntrypoint:'cli'}});
 expect(Number.isFinite(Date.parse(snap.capturedAt))).toBe(true);
 expect(raw).not.toMatch(/transcript|private@example|DO-NOT-STORE|seven_day/);
 // The snapshot a Workroom reads for its own context %: same shape the panel accepts.
 const {claudeWorkroomContext}=await import('../src/workroomSessionStatus');
 expect(claudeWorkroomContext({id:SID,cwd:'/Users/fixture/project',createdAt:new Date(Date.now()-60_000).toISOString()},snap).usedPercent).toBe(42.5);
 // Unchanged readings within 15 s are not rewritten (the statusline renders often).
 const before=statSync(file).mtimeMs;await Bun.sleep(20);await runHook(command,claudePayload(),{TERM_PROGRAM:'Orca',TERM_PROGRAM_VERSION:'1.4.211',CLAUDE_CODE_ENTRYPOINT:'cli',ORCA_PANE_KEY:'tab-1:2',ORCA_WORKTREE_ID:'repo::/Users/fixture/project'});
 expect(statSync(file).mtimeMs).toBe(before);
 await runHook(command,claudePayload({context_window:{context_window_size:200000,used_percentage:60}}),{});
 expect(JSON.parse(readFileSync(file,'utf8')).contextWindow.used_percentage).toBe(60);
});
test.skipIf(process.platform==='win32'||!Bun.which('python3'))('a Workroom Claude names its Workroom and never the Orca pane it inherited from whatever opened the app',async()=>{
 const f=fixture();writeFileSync(f.settings,'{}');await f.host.perform({operation:'connect',provider:'claude'});
 const command=JSON.parse(readFileSync(f.settings,'utf8')).statusLine.command;
 expect((await runHook(command,claudePayload(),{AGENTSTOZ_WORKROOM_SESSION_ID:WORKROOM,ORCA_PANE_KEY:'tab-1:2',ORCA_WORKTREE_ID:'repo::/x',CMUX_WORKSPACE_ID:'w'})).code).toBe(0);
 expect(JSON.parse(readFileSync(join(f.app,'context',SID+'.json'),'utf8')).launchContext).toEqual({agentstozWorkroomSessionId:WORKROOM});
 // Not a session id the list can read: nothing written.
 await runHook(command,claudePayload({session_id:'../../escape'}));
 expect(readdirSync(join(f.app,'context')).filter(n=>!n.startsWith('.'))).toEqual([SID+'.json']);
});
test.skipIf(process.platform==='win32'||!Bun.which('python3')||process.getuid?.()===0)('an unwritable or unsafe context folder never breaks the statusline or the weekly reading',async()=>{
 for(const kind of ['readonly','file','symlink'] as const){
  const f=fixture();writeFileSync(f.settings,JSON.stringify({statusLine:{type:'command',command:"printf 'original-line'"}}));
  await f.host.perform({operation:'connect',provider:'claude'});const command=JSON.parse(readFileSync(f.settings,'utf8')).statusLine.command;
  const dir=join(f.app,'context');
  if(kind==='readonly')mkdirSync(dir,{mode:0o500});if(kind==='file')writeFileSync(dir,'not a folder');
  if(kind==='symlink'){const elsewhere=join(f.root,'elsewhere');mkdirSync(elsewhere,{mode:0o700});symlinkSync(elsewhere,dir);}
  try{
   expect(await runHook(command,claudePayload())).toEqual({out:'original-line',code:0});
   expect((await f.host.status())[0]?.buckets[0]?.remainingPercent).toBe(63);
   if(kind==='symlink')expect(readdirSync(join(f.root,'elsewhere'))).toEqual([]);
  }finally{if(kind==='readonly')chmodSync(dir,0o700);}
 }
});
test.skipIf(process.platform==='win32')('an unmodified older app hook is upgraded in place once; a hook the app did not write is left alone',async()=>{
 const {WEEKLY_USAGE_HOOK,RELEASED_WEEKLY_USAGE_HOOK_SHA256}=await import('../src/weeklyUsageHook');
 const sha=(text:string)=>new Bun.CryptoHasher('sha256').update(text).digest('hex');
 const v1=readFileSync(join(import.meta.dir,'fixtures','weekly-usage-hook-v1.py'),'utf8');
 expect(RELEASED_WEEKLY_USAGE_HOOK_SHA256).toContain(sha(v1));
 // Changing the hook without recording the previous hash would strand every connected Mac on the old one.
 expect(RELEASED_WEEKLY_USAGE_HOOK_SHA256).not.toContain(sha(WEEKLY_USAGE_HOOK));
 const f=fixture();mkdirSync(f.host.root,{mode:0o700});const path=join(f.host.root,'statusline-v1.py');
 writeFileSync(path,v1,{mode:0o600});await f.host.status();expect(readFileSync(path,'utf8')).toBe(WEEKLY_USAGE_HOOK);
 const settings=existsSync(f.settings);await f.host.status();expect(readFileSync(path,'utf8')).toBe(WEEKLY_USAGE_HOOK);expect(existsSync(f.settings)).toBe(settings);
 const g=fixture();mkdirSync(g.host.root,{mode:0o700});const edited=join(g.host.root,'statusline-v1.py');
 writeFileSync(edited,v1+'\n# person edit\n',{mode:0o600});g.host.upgradeHook();expect(readFileSync(edited,'utf8')).toBe(v1+'\n# person edit\n');
});
