import {afterEach,expect,test} from 'bun:test';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {AiTerminalService} from '../src/aiTerminalService';
import {bindVoiceRuntime,voiceOutput} from '../src/voiceRuntimeBinding';
const services:AiTerminalService[]=[],dirs:string[]=[];
afterEach(async()=>{await Promise.all(services.splice(0).map(s=>s.shutdown()));dirs.splice(0).forEach(d=>rmSync(d,{recursive:true,force:true}));});
const requestId=()=>crypto.randomUUID();
async function fixture(agent:'codex'|'claude'|'hermes'|'agy',longOutput=false){
 const dir=mkdtempSync(join(tmpdir(),'voice-runtime-'));dirs.push(dir);const exe=join(dir,'fixture-cli');writeFileSync(exe,'#!/bin/sh\nstty -echo\n'+(longOutput?'printf \"OLDEST_MARKER\\n\"\nprintf \"%10000s\\n\" padding\n':'')+'printf "READY\\n"\nwhile IFS= read -r line; do printf "GOT:%s\\n" "$line"; done\n',{mode:0o755});
 const service=new AiTerminalService({resolveTarget:async()=>({cwd:dir}),executable:()=>exe});services.push(service);
 const targetId='project_fixture';const session=(await service.perform({operation:'start',requestId:requestId(),targetId,agent,cols:80,rows:24})).session!;
 let active=true,identity='fixed',opsIdentity='ops-fixed';
 const deps={terminal:service,targets:async()=>[{id:targetId,name:'fixture',role:'managed' as const,scope:'main' as const},{id:'another_project',name:'other',role:'managed' as const,scope:'main' as const}],target:async()=>({label:'fixture',fingerprint:identity}),ops:()=>({fingerprint:opsIdentity,projectId:targetId}),recall:()=>({hits:[]}),projectRecall:async(id:string,query:string)=>({scope:'project',id,query,hits:[{title:'프로젝트 결정'}]}),propose:async()=>({state:'pending',saved:false})};
 const authority={owner:'local',active:()=>active};
 const binding=await bindVoiceRuntime(deps,{kind:'workroom',targetId,sessionId:session.id},authority);
 return {service,binding,deps,authority,session,targetId,revoke:()=>{active=false},retarget:()=>{identity='changed'},reattach:()=>{opsIdentity='changed'}};
}
for(const agent of ['codex','claude','hermes','agy'] as const)test(`${agent}: voice sends once to bound PTY and input revision blocks stale reviewed draft`,async()=>{
 const f=await fixture(agent);
 let ready=false;const deadline=Date.now()+3500;while(Date.now()<deadline){const r=await f.service.perform({operation:'read',requestId:requestId(),sessionId:f.session.id,after:0});if((r.chunks??[]).some(c=>c.text.includes('READY'))){ready=true;break;}await Bun.sleep(20);}
 expect(ready).toBe(true);
 const draft=await f.binding.review!('지시');await draft.send('첫 줄\n둘째 줄',requestId(),()=>true);
 let text='';for(let n=0;n<60&&!text.includes('GOT:첫 줄 둘째 줄');n++){const r=await f.service.perform({operation:'read',requestId:requestId(),sessionId:f.session.id,after:0});text=(r.chunks??[]).map(c=>c.text).join('');await Bun.sleep(10);}
 expect(text).toContain('GOT:첫 줄 둘째 줄');
 const observed:any=await draft.observe!();expect(observed.output).toContain('GOT:첫 줄 둘째 줄');expect(observed.output).not.toContain('READY');
 const repeated:any=await draft.observe!();expect(repeated.output).not.toContain('GOT:첫 줄 둘째 줄');
 const stale=await f.binding.review!('old');await f.service.perform({operation:'input',requestId:requestId(),sessionId:f.session.id,data:'new manual input\r'});
 await expect(stale.send('old',requestId(),()=>true)).rejects.toThrow('입력이 변경');
 expect(f.service.inspectSession(f.session.id,f.targetId).state).toBe('running');
});
test('review target remains fixed across OPS reattachment and project replacement',async()=>{
 const f=await fixture('codex');const b=await bindVoiceRuntime(f.deps,{kind:'ops'},f.authority);
 const draft=await b.reviewWorkroom!(f.targetId,f.session.id);f.retarget();await expect(draft.send('wrong',requestId(),()=>true)).rejects.toThrow();
 f.reattach();await expect(b.validate()).rejects.toThrow();
});
test('remote OPS tools cannot escape granted project or approve shared memory',async()=>{
 const f=await fixture('codex');const b=await bindVoiceRuntime(f.deps,{kind:'ops'},{owner:'remote-device',active:()=>true,allowedTargets:new Set([f.targetId])});
 expect(JSON.stringify(await b.context!())).not.toContain('another_project');
 // list_projects now answers one bounded page (total/offset/nextOffset) instead of a bare 64-row array.
 expect(await b.run('list_projects',{},requestId())).toEqual({total:1,offset:0,nextOffset:null,count:1,projects:[{id:f.targetId,name:'fixture',role:'managed',scope:'main'}]});
 expect(await b.run('resolve_target_alias',{alias:'프로젝트담당자 fixture'},requestId())).toMatchObject({kind:'project',projectId:f.targetId});
 await expect(b.reviewWorkroom!('another_project',f.session.id)).rejects.toThrow();
 await expect(b.run('propose_ops_memory',{title:'기억',body:'내용',evidence:'발언'},requestId())).rejects.toThrow();
 expect(b.tools.some(t=>t.name.includes('approve'))).toBe(false);
});
test('OPS keeps one voice binding while switching to a project delegate and back',async()=>{
 const f=await fixture('codex');const b=await bindVoiceRuntime(f.deps,{kind:'ops'},f.authority);
 expect(b.activeTarget!()).toEqual({kind:'ops',label:'AgentsToZ OPS'});
 // No AI named: the running workroom (codex) is reused.
 const connected:any=await b.run('connect_project_delegate',{targetId:f.targetId},requestId());
 expect(connected).toMatchObject({state:'delegate-connected',agent:'codex',reused:true});
 expect(b.activeTarget!()).toMatchObject({kind:'workroom',targetId:f.targetId,sessionId:f.session.id,agent:'codex'});
 // Naming another AI no longer silently lands on the running codex: it opens that AI's workroom.
 // (Deliberate change: this test used to assert agent 'codex' after asking for claude.)
 const claude:any=await b.run('connect_project_delegate',{targetId:f.targetId,agent:'claude'},requestId());
 expect(claude).toMatchObject({state:'delegate-connected',agent:'claude',reused:false});
 expect(claude.activeTarget.sessionId).not.toBe(f.session.id);
 expect(b.activeTarget!()).toMatchObject({kind:'workroom',targetId:f.targetId,sessionId:claude.activeTarget.sessionId,agent:'claude'});
 // Naming the AI that already runs reuses exactly that workroom.
 expect(await b.run('connect_project_delegate',{targetId:f.targetId,agent:'codex'},requestId())).toMatchObject({agent:'codex',reused:true,activeTarget:{sessionId:f.session.id}});
 await expect(b.run('connect_project_delegate',{targetId:f.targetId,agent:'gpt'},requestId())).rejects.toThrow('워크룸 AI');
 expect(await b.run('recall_project_memory',{query:'프로젝트 결정'},requestId())).toMatchObject({scope:'project',id:f.targetId});
 expect((await b.run('read_delegate_workroom',{},requestId()) as any).project).toBe('fixture');
 await b.run('return_to_ops',{},requestId());expect(b.activeTarget!()).toEqual({kind:'ops',label:'AgentsToZ OPS'});
 await expect(b.run('read_delegate_workroom',{},requestId())).rejects.toThrow('먼저 프로젝트 담당자');
});
test('OPS routes app MCP operations through the existing Control workroom review boundary',async()=>{
 const f=await fixture('codex');const b=await bindVoiceRuntime(f.deps,{kind:'ops'},f.authority);
 expect(b.tools.map(tool=>tool.name)).toContain('prepare_ops_instruction');
 const review=await b.reviewOps!();expect(review.label).toBe('fixture · codex');
 await review.send('새 프로젝트 abcde를 만들고 Git과 장기기억을 초기화해',requestId(),()=>true);
 let output='';for(let n=0;n<60&&!output.includes('abcde');n++){output=String((await review.observe!() as any).output);await Bun.sleep(10);}
 expect(output).toContain('새 프로젝트 abcde');
});
test('provider context strips terminal escapes and common credential forms',()=>{
 const result=voiceOutput('\x1b[31mhello\x1b[0m sk-'+ 'x'.repeat(30)+'\npassword=private');expect(result).toContain('hello');expect(result).not.toContain('\x1b');expect(result).not.toContain('private');expect(result).not.toContain('x'.repeat(30));
});

test('workroom context and default read use recent bound output with project identity',async()=>{
 const f=await fixture('claude',true);
 const end=Date.now()+3500;while(Date.now()<end){const r=await f.service.perform({operation:'read',requestId:requestId(),sessionId:f.session.id,after:0});if(f.service.inspectSession(f.session.id,f.targetId).outputCursor>8)break;await Bun.sleep(20);}
 await f.service.perform({operation:'input',requestId:requestId(),sessionId:f.session.id,data:'현재 로그인 오류를 수정 중\r'});
 let context:any;const deadline=Date.now()+3500;do {context=await (f.binding as any).context?.();if(context?.output?.includes('로그인 오류'))break;await Bun.sleep(20);}while(Date.now()<deadline);
 expect(context?.project).toBe('fixture');expect(context?.agent).toBe('claude');expect(context?.output).toContain('로그인 오류');expect(context?.output).not.toContain('OLDEST_MARKER');expect(context?.output.length).toBeLessThanOrEqual(6000);
 const latest:any=await f.binding.run('read_workroom',{},requestId());expect(latest.output).toContain('로그인 오류');expect(latest.completed).toBe(false);
 expect(f.binding.tools.some(tool=>tool.name==='recall_project_memory')).toBe(true);
 expect(await f.binding.run('recall_project_memory',{query:'프로젝트 결정'},requestId())).toMatchObject({scope:'project',id:f.targetId,query:'프로젝트 결정'});
 f.retarget();await expect((f.binding as any).context()).rejects.toThrow();
});

test('the bound Control workroom shares OPS recall/proposal without gaining cross-project workroom tools',async()=>{
 const f=await fixture('codex');let memory='same-ops',proposals=0;
 const deps={...f.deps,target:async()=>({label:'AgentsToZ-Control',fingerprint:'registered',opsMemoryFingerprint:memory}),recall:()=>({hits:[{body:'운영 결정'}]}),propose:async()=>{proposals++;return {state:'pending'};}};
 const b=await bindVoiceRuntime(deps,{kind:'workroom',targetId:f.targetId,sessionId:f.session.id},f.authority);
 expect(b.tools.some(t=>t.name==='recall_ops')).toBe(true);expect(b.tools.some(t=>t.name==='list_projects')).toBe(false);
 expect(b.tools.some(t=>t.name==='recall_project_memory')).toBe(true);
 expect(JSON.stringify(await b.context!())).toContain('same OPS operating memory');expect(await b.run('recall_ops',{query:'결정'},requestId())).toEqual({hits:[{body:'운영 결정'}]});
 await b.run('propose_ops_memory',{title:'운영 방침',body:'한 기억을 사용',evidence:'사용자 결정'},requestId());expect(proposals).toBe(1);
 memory='switched';await expect(b.run('recall_ops',{query:'결정'},requestId())).rejects.toThrow();
});

test('OPS list_projects pages the whole inventory by query/offset and the start context stays compact',async()=>{
 const f=await fixture('codex');
 const many=Array.from({length:150},(_,index)=>({id:`synthetic_project_${String(index).padStart(3,'0')}`,name:`프로젝트 ${String(index).padStart(3,'0')} ${'가'.repeat(40)}`,aliases:[`Synthetic ${index} ${'x'.repeat(80)}`],role:index===0?'ops' as const:index===1?'dev' as const:'managed' as const,scope:'main' as const}));
 const b=await bindVoiceRuntime({...f.deps,targets:async()=>[{id:f.targetId,name:'fixture',role:'managed' as const,scope:'main' as const},...many]},{kind:'ops'},f.authority);
 const first:any=await b.run('list_projects',{},requestId());
 expect(first.total).toBe(151);expect(first.projects.length).toBeLessThanOrEqual(40);expect(first.nextOffset).toBe(first.projects.length);
 expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThan(16_000);
 const next:any=await b.run('list_projects',{offset:first.nextOffset},requestId());expect(next.offset).toBe(first.nextOffset);expect(next.projects[0].id).not.toBe(first.projects[0].id);
 const searched:any=await b.run('list_projects',{query:'synthetic 149'},requestId());
 expect(searched).toMatchObject({total:1,query:'synthetic 149',projects:[{id:'synthetic_project_149'}]});
 await expect(b.run('list_projects',{query:'x',page:2},requestId())).rejects.toThrow('허용되지 않은');
 await expect(b.run('list_projects',{offset:-1},requestId())).rejects.toThrow();
 const context:any=await b.context!();const json=JSON.stringify(context);
 expect(Buffer.byteLength(json)).toBeLessThan(24_000);
 expect(context.projects).toBeUndefined();
 expect(context.counts).toMatchObject({projects:151,worktrees:0});
 expect(context.ops).toEqual([{id:'synthetic_project_000',name:many[0]!.name}]);expect(context.dev).toEqual([{id:'synthetic_project_001',name:many[1]!.name}]);
 expect(context.running).toEqual([{targetId:f.targetId,name:'fixture',agent:'codex',sessionId:f.session.id}]);
 expect(context.hint).toContain('list_projects');
});

test('OPS instructions reuse the running OPS workroom, else the saved OPS AI, else codex; a named AI wins',async()=>{
 // Running OPS workroom (codex): no AI named → reused as is.
 const f=await fixture('codex');let saved:'agy'|null='agy';
 const b=await bindVoiceRuntime({...f.deps,opsAgent:()=>saved},{kind:'ops'},f.authority);
 expect(await b.reviewOps!()).toMatchObject({label:'fixture · codex',agent:'codex',reused:true});
 // Named AI that is not running → that AI's workroom is opened, then reused.
 expect(await b.reviewOps!('claude')).toMatchObject({agent:'claude',reused:false});
 expect(await b.reviewOps!('claude')).toMatchObject({agent:'claude',reused:true});
 // Nothing running: the AI this device last opened OPS with, then codex.
 const idle=await fixture('codex');await idle.service.perform({operation:'close',requestId:requestId(),sessionId:idle.session.id});
 const fresh=await bindVoiceRuntime({...idle.deps,opsAgent:()=>saved},{kind:'ops'},idle.authority);
 expect(await fresh.reviewOps!()).toMatchObject({agent:'agy',reused:false});
 const other=await fixture('codex');await other.service.perform({operation:'close',requestId:requestId(),sessionId:other.session.id});saved=null;
 const plain=await bindVoiceRuntime({...other.deps,opsAgent:()=>saved},{kind:'ops'},other.authority);
 expect(await plain.reviewOps!()).toMatchObject({agent:'codex',reused:false});
});

test('OPS tools teach the spoken AI names and accept an AI for OPS instructions',async()=>{
 const f=await fixture('codex');const b=await bindVoiceRuntime(f.deps,{kind:'ops'},f.authority);
 const tool=(name:string)=>b.tools.find(t=>t.name===name)!;
 for(const name of ['connect_project_delegate','prepare_ops_instruction','start_workroom']){
  const agent=(tool(name).parameters as any).properties.agent;expect(agent.enum).toEqual(['codex','claude','hermes','agy']);
  expect(tool(name).description+agent.description).toContain('안티그래비티');
 }
 expect((tool('prepare_ops_instruction').parameters as any).required).toEqual(['text']);
 expect((tool('list_projects').parameters as any).required).toEqual([]);
 expect(tool('resolve_target_alias').description).toContain('바이브2');
});
