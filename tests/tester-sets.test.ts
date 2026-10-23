import {afterEach,expect,test} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,symlinkSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';import {tmpdir} from 'node:os';
import {TesterAgentHost} from '../src/testerAgentHost';
import {readProjectTesterSets} from '../src/testerSetsReader';
import {TesterSetsCache} from '../src/testerSetsCache';
import {parseTesterRequest,type TesterSets,type TesterResult} from '../src/testerAgentContract';
import {TESTER_MCP_TOOLS,testerMcpAction} from '../src/testerAgentMcp';
const roots:string[]=[],hosts:TesterAgentHost[]=[];
afterEach(async()=>{for(const h of hosts.splice(0)){await h.shutdown();h.store.close();}for(const r of roots.splice(0))rmSync(r,{recursive:true,force:true});});
function fixture(){const root=mkdtempSync(join(tmpdir(),'tester-sets-'));roots.push(root);mkdirSync(join(root,'.agentstoz/maintainer'),{recursive:true});const save=(path:string,value:unknown)=>writeFileSync(join(root,path),JSON.stringify(value));
 save('.agentstoz/maintainer.json',{schemaVersion:1,profiles:{quick:['core','pending']},checks:[{id:'core',argv:['echo','private-command'],covers:['첫 업무 조회'],env:{SECRET:'private-environment'}},{id:'pending',covers:['추가 업무']}]});
 save('.agentstoz/personas.json',{schemaVersion:1,personas:[{id:'employee',role:'증권사 직원',goal:'업무 조회',reason:'직원 업무 흐름',situation:'업무 시간',journey:['조회','확인'],successCriteria:['업무 표시'],tests:[{check:'core'}]},{id:'novice',goal:'게임 시작',tests:['feature.test.ts']}]});
 save('.agentstoz/maintainer/persona-evolution-v1.json',{schemaVersion:1,candidates:[{checkIds:[],profile:{role:'감독기관 검토자'}}]});
 for(const f of ['AGENTS.md','CLAUDE.md','GEMINI.md'])writeFileSync(join(root,f),'<!-- AgentsToZ tester:start -->\nshared\n<!-- AgentsToZ tester:end -->');
 return {root,save};}
test('project sets read registered configuration without Python/Git/tests/AI or leaking command fields',async()=>{
 const {root}=fixture();let pythonCalls=0;
 const host=new TesterAgentHost({directory:join(root,'data'),runner:resolve('scripts/agentstoz-maintainer.py'),python:()=>{pythonCalls++;throw Error('must not call Python');},resolveSets:async r=>{if(r.portId!=='registered')return null;return {root,label:'Fixture',targets:[]};},resolve:async()=>{throw Error('unregistered');},lease:async()=>{throw Error('must not mutate');}});hosts.push(host);
 const sets=(await host.perform({portId:'registered',operation:'sets'})).sets!;
 expect(pythonCalls).toBe(0);expect(sets.general.count).toBe(2);expect(sets.general.unconfigured).toBe(1);expect(sets.personas.count).toBe(2);
 expect(sets.personas.items[0]?.role).toBe('증권사 직원');expect(sets.personas.items[0]?.journey).toEqual(['조회','확인']);expect(sets.personas.needsChecks).toBe(1);
 expect(sets.agents.map(a=>a.id)).toEqual(['codex','claude','hermes','agy']);expect(sets.agents.every(a=>a.instructionsProvided)).toBe(true);
 const text=JSON.stringify(sets);for(const secret of [root,'private-command','private-environment','argv','env'])expect(text).not.toContain(secret);
 expect(readFileSync(join(root,'.agentstoz/personas.json'),'utf8')).toContain('employee');
 await expect(host.perform({portId:'unregistered',operation:'sets'})).rejects.toThrow('unregistered');
 await expect(host.perform({portId:'registered',operation:'sets'},{owner:'mobile',async authorize(){},executionAllowed:()=>true})).rejects.toThrow('모바일에서는');
});
test('invalid, absent, symlinked, oversized and duplicate configurations are distinguishable',async()=>{
 const {root,save}=fixture();const read=()=>readProjectTesterSets(root,(v,n)=>String(v??'').slice(0,n));
 save('.agentstoz/personas.json',{schemaVersion:1,personas:[{id:'no-tests',goal:'label',tests:[]}]});expect((await read()).personas.state).toBe('invalid');
 rmSync(join(root,'.agentstoz/personas.json'));expect((await read()).personas.state).toBe('none');
 save('.agentstoz/personas.json',{schemaVersion:1,personas:[{id:'ok',goal:'goal',tests:[{check:'core'}]}]});mkdirSync(join(root,'tests/personas'),{recursive:true});save('tests/personas/catalog.json',{schemaVersion:1,personas:[]});expect((await read()).personas.state).toBe('invalid');
 rmSync(join(root,'tests'),{recursive:true});save('.agentstoz/maintainer.json',{schemaVersion:2});expect((await read()).general.state).toBe('invalid');
 rmSync(join(root,'.agentstoz/maintainer.json'));expect((await read()).general.state).toBe('none');
 writeFileSync(join(root,'.agentstoz/maintainer.json'),'x'.repeat(512001));expect((await read()).general.problem).toContain('크기');
 rmSync(join(root,'.agentstoz/maintainer.json'));symlinkSync(join(root,'AGENTS.md'),join(root,'.agentstoz/maintainer.json'));expect((await read()).general.problem).toContain('심볼릭');
});
test('large user guides report their provided instructions without relaxing configuration or symlink limits',async()=>{
 const {root}=fixture();const read=()=>readProjectTesterSets(root,(v,n)=>String(v??'').slice(0,n));
 const guide=join(root,'CLAUDE.md'),original='한글 지침 보존\n'.repeat(28_000)+readFileSync(guide,'utf8');
 expect(Buffer.byteLength(original)).toBeGreaterThan(512_000);
 writeFileSync(guide,original);expect((await read()).agents.find(a=>a.id==='claude')?.instructionsProvided).toBe(true);
 expect(readFileSync(guide,'utf8')).toBe(original);
 writeFileSync(guide,'x'.repeat(1_000_001));expect((await read()).agents.find(a=>a.id==='claude')?.instructionsProvided).toBe(false);
 rmSync(guide);symlinkSync(join(root,'AGENTS.md'),guide);expect((await read()).agents.find(a=>a.id==='claude')?.instructionsProvided).toBe(false);
});
test('composition previews are bounded while preserving the total role count',async()=>{
 const {root,save}=fixture();save('.agentstoz/personas.json',{schemaVersion:1,personas:Array.from({length:100},(_,i)=>({id:'role-'+i,goal:'goal '+i,tests:[{check:'core'}]}))});
 const sets=await readProjectTesterSets(root,(v,n)=>String(v??'').slice(0,n));expect(sets.personas.count).toBe(100);expect(sets.personas.items).toHaveLength(64);expect(sets.personas.truncated).toBe(true);
});
test('the MCP exposes read-only sets and bounded semantic proposals without shell fields',()=>{
 expect(TESTER_MCP_TOOLS.map(t=>t.name)).toContain('agentstoz_use_get_tester_sets');expect(TESTER_MCP_TOOLS.map(t=>t.name)).toContain('agentstoz_use_propose_tester_persona');
 expect(testerMcpAction('agentstoz_use_get_tester_sets',{portId:'project'},'ops')?.tester).toEqual({operation:'sets',portId:'project'});
 const valid={operation:'persona-propose',portId:'project',revision:'a'.repeat(64),role:'게임 초보자',reason:'처음 사용',goal:'시작',situation:'첫 실행',journey:['시작'],successCriteria:['완료'],sourcePaths:['README.md'],checkIds:[]};
 expect(parseTesterRequest(valid).checkIds).toEqual([]);
 for(const patch of [{argv:['echo']},{sourcePaths:['../escape']},{sourcePaths:[]},{role:''},{journey:[]},{checkIds:['../command']}])expect(()=>parseTesterRequest({...valid,...patch})).toThrow();
});
const sets={revision:'a'.repeat(64)} as TesterSets;
const turn=()=>new Promise(resolve=>setTimeout(resolve,0));
test('visible-row reads deduplicate, limit concurrency and cancel queued hidden rows',async()=>{
 const waiting:{portId:string;resolve:(v:TesterResult)=>void}[]=[];
 const cache=new TesterSetsCache(req=>new Promise(resolve=>waiting.push({portId:req.portId,resolve})),()=>10000);
 const unsubscribe1=cache.watch({portId:'one'},()=>{}),unsubscribeDuplicate=cache.watch({portId:'one'},()=>{});
 const unsubscribe2=cache.watch({portId:'two'},()=>{}),unsubscribe3=cache.watch({portId:'hidden'},()=>{});cache.watch({portId:'four'},()=>{});
 expect(waiting.map(r=>r.portId)).toEqual(['one','two']);unsubscribe3();
 waiting[0]!.resolve({sets});await turn();expect(waiting.map(r=>r.portId)).toEqual(['one','two','four']);
 unsubscribe1();unsubscribeDuplicate();unsubscribe2();for(const r of waiting)r.resolve({sets});await turn();
});
test('refresh while an old response is pending discards it and fetches the latest revision',async()=>{
 const waiting:((v:TesterResult)=>void)[]=[],seen:string[]=[];
 const cache=new TesterSetsCache(()=>new Promise(resolve=>waiting.push(resolve)),()=>10000);
 cache.watch({portId:'one'},s=>{if(s.data)seen.push(s.data.revision);});cache.refresh({portId:'one'});
 waiting[0]!({sets:{...sets,revision:'old'}});await turn();expect(seen).toEqual([]);expect(waiting.length).toBe(2);
 waiting[1]!({sets:{...sets,revision:'new'}});await turn();expect(seen).toEqual(['new']);
});
test('cache admission remains bounded even if every row subscribes at once',async()=>{
 let busyErrors=0;const waiting:((v:TesterResult)=>void)[]=[];const cache=new TesterSetsCache(()=>new Promise(resolve=>waiting.push(resolve)));
 const subscriptions=Array.from({length:1000},(_,i)=>cache.watch({portId:'project-'+i},s=>{if(s.error)busyErrors++;}));
 expect(busyErrors).toBe(936);expect(waiting.length).toBe(2);for(const unsubscribe of subscriptions)unsubscribe();for(const done of waiting)done({sets});await turn();expect(waiting.length).toBe(2);
});
