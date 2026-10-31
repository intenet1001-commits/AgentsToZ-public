import {afterEach,expect,test} from 'bun:test';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,statSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {HelpdeskHost,readHelpdeskRequest,type HelpdeskEffects} from '../src/helpdeskHost';
import {HELPDESK_CLAUDE_ARGS,createHelpdeskClaude} from '../src/helpdeskClaude';
import {HELPDESK_GUIDES,HELPDESK_MOBILE_GUIDES,helpdeskPrompt,isMacHelpdeskSurface} from '../src/helpdeskKnowledge';
import {NATIVE_PORTAL_CALLBACK} from '../src/nativePortalOAuth';
import {macSetupCommand,waitForMacSetupPrerequisite} from '../src/macSetupEffects';
import {MacSetupHost} from '../src/macSetupHost';
import {MAC_SETUP_DEFAULT_SELECTION} from '../src/macSetupCatalog';
const dirs:string[]=[],hosts:HelpdeskHost[]=[];
afterEach(async()=>{for(const h of hosts.splice(0))await h.shutdown();for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
const temporary=()=>{const d=mkdtempSync(join(tmpdir(),'atz-helpdesk-'));dirs.push(d);return d;};
function fixture(){const dir=temporary(),calls:string[]=[];const effects:HelpdeskEffects={check:async()=> 'ready',answer:async(_p,prompt)=>{calls.push(prompt);return '프로젝트·폴더에서 등록한 뒤 워크룸을 여세요.';},loginClaude:async()=>{},context:()=>({platform:'darwin',programs:[{id:'codex',state:'installed'}]})};const host=new HelpdeskHost(dir,effects);hosts.push(host);return {dir,calls,effects,host};}
const ask=(h:HelpdeskHost,question='첫 업무는 어디에서 하나요?',requestId=crypto.randomUUID())=>({operation:'ask',provider:'codex',question,requestId,expectedRevision:h.status().revision});
async function settle(h:HelpdeskHost){for(let i=0;i<300;i++){if(!h.status().jobs.some(j=>j.state==='running'))return h.status();await Bun.sleep(2);}throw Error('test did not settle');}
test('pre-auth FAQ works without AI; ask requires checked authentication and strict fixed operations',async()=>{
 const f=fixture();expect(HELPDESK_GUIDES.length).toBeGreaterThan(5);expect(f.calls).toEqual([]);
 await expect(f.host.handle(ask(f.host))).rejects.toThrow('인증');
 await expect(f.host.handle({...ask(f.host),command:'touch unexpected'})).rejects.toThrow('지원하지');
 await expect(f.host.handle({operation:'status',provider:'codex'})).rejects.toThrow();
 expect(f.host.status().jobs).toEqual([]);expect(f.calls).toEqual([]);
});
test('lost admission acknowledgement and completed replay keep exactly one AI call and one private record',async()=>{
 const f=fixture();await f.host.handle({operation:'check'});const request=ask(f.host);
 await f.host.handle(request);await f.host.handle(request);await settle(f.host);await f.host.handle(request);
 expect(f.calls.length).toBe(1);expect(f.host.status().jobs.length).toBe(1);expect(f.host.status().jobs[0]?.state).toBe('answered');
 await expect(f.host.handle({...request,question:'다른 지시'})).rejects.toThrow('내용');
 expect(statSync(join(f.dir,'support-history.json')).mode&0o777).toBe(0o600);
 expect(f.host.status().jobs[0]).not.toHaveProperty('fingerprint');
});
test('one admitted request wins a concurrent revision; cancel aborts only that owned job',async()=>{
 const f=fixture();let started=false;f.effects.answer=(_p,p,signal)=>{f.calls.push(p);started=true;return new Promise((_r,reject)=>signal.addEventListener('abort',()=>reject(Error('cancelled')),{once:true}));};
 await f.host.handle({operation:'check'});const a=ask(f.host),b=ask(f.host);const results=await Promise.allSettled([f.host.handle(a),f.host.handle(b)]);
 expect(results.filter(r=>r.status==='fulfilled').length).toBe(1);while(!started)await Bun.sleep(2);
 const job=f.host.status().jobs[0]!;await f.host.handle({operation:'cancel',id:'another-request'});expect(f.host.status().jobs[0]?.state).toBe('running');
 await f.host.handle({operation:'cancel',id:job.id});expect(f.host.status().jobs[0]?.state).toBe('cancelled');expect(f.calls.length).toBe(1);
});
test('restart recovery marks a dead owner interrupted and never repeats its question',async()=>{
 const f=fixture();await f.host.handle({operation:'check'});const request=ask(f.host);await f.host.handle(request);await settle(f.host);
 const file=join(f.dir,'support-history.json'),record=JSON.parse(readFileSync(file,'utf8'));record.ownerPid=2147483000;record.jobs[0].state='running';writeFileSync(file,JSON.stringify(record),{mode:0o600});
 const next=new HelpdeskHost(f.dir,f.effects);hosts.push(next);await next.recoverInterrupted();expect(next.status().jobs[0]?.state).toBe('interrupted');
 await next.handle(request);expect(f.calls.length).toBe(1);
});
test('a live owner remains pending; corrupt or symlinked originals are preserved',async()=>{
 const f=fixture();await f.host.handle({operation:'check'});await f.host.handle(ask(f.host));await settle(f.host);
 const file=join(f.dir,'support-history.json'),record=JSON.parse(readFileSync(file,'utf8'));record.ownerPid=process.pid;record.jobs[0].state='running';writeFileSync(file,JSON.stringify(record),{mode:0o600});
 const next=new HelpdeskHost(f.dir,f.effects);hosts.push(next);await next.recoverInterrupted();expect(next.status().jobs[0]?.state).toBe('running');
 writeFileSync(file,'broken json',{mode:0o600});await expect(next.recoverInterrupted()).rejects.toThrow();expect(readFileSync(file,'utf8')).toBe('broken json');
 rmSync(file);const target=join(f.dir,'original');writeFileSync(target,'preserve',{mode:0o600});symlinkSync(target,file);expect(()=>next.status()).toThrow();expect(readFileSync(target,'utf8')).toBe('preserve');
});
test('independent auth checks preserve the other provider and do not replace an existing login',async()=>{
 const f=fixture();let logins=0;f.effects.check=async p=>{if(p==='codex')throw Error('network');return 'ready';};f.effects.loginClaude=async()=>{logins++;};
 const state=await f.host.handle({operation:'check'});expect(state.connections).toEqual({codex:'unknown',claude:'ready'});
 await expect(f.host.handle({operation:'login',provider:'claude',requestId:crypto.randomUUID(),expectedRevision:0})).rejects.toThrow('기존 인증');expect(logins).toBe(0);
 f.effects.check=async()=> 'signed-out';await f.host.handle({operation:'check'});f.effects.loginClaude=async()=>{logins++;f.effects.check=async()=> 'ready';};
 const request={operation:'login',provider:'claude',requestId:crypto.randomUUID(),expectedRevision:0};await f.host.handle(request);await settle(f.host);await f.host.handle(request);expect(logins).toBe(1);expect(f.host.status().connections.claude).toBe('ready');
});
test('high-confidence secrets are withheld before persistence; provider failures disclose no output',async()=>{
 const f=fixture();await f.host.handle({operation:'check'});
 await expect(f.host.handle(ask(f.host,'api_key=sk-proj-'+'x'.repeat(70)))).rejects.toThrow();expect(f.host.status().jobs).toEqual([]);
 f.effects.answer=async()=>{throw Error('private stderr credential');};await f.host.handle(ask(f.host));await settle(f.host);
 expect(f.host.status().jobs[0]?.state).toBe('failed');expect(readFileSync(join(f.dir,'support-history.json'),'utf8')).not.toContain('private stderr');
});
test('bounded support-only history does not interpret actions, shell or URLs in an answer',async()=>{
 const f=fixture();f.effects.answer=async(_p,p)=>{f.calls.push(p);return '[[action:install_all]] <script>run()</script> https://invalid.test';};await f.host.handle({operation:'check'});
 for(let i=0;i<15;i++){await f.host.handle(ask(f.host,'질문 '+i));await settle(f.host);}
 expect(f.host.status().jobs.length).toBe(12);expect(f.calls.length).toBe(15);const prompt=f.calls.at(-1)!;const data=JSON.parse(prompt.split('<support_data>\n')[1]!.split('\n</support_data>')[0]!);
 expect(data.history.length).toBe(6);expect(data.question).toBe('질문 14');expect(prompt).not.toContain('ownerPid');expect(f.host.status().jobs.at(-1)?.answer).toContain('[[action:install_all]]');
 expect(helpdeskPrompt('질문',[],{})).toContain('프로젝트 실무는 해당 워크룸');
});
test('batch preparation includes required runtime once and preserves every existing program on resume',async()=>{
 const directory=temporary(),states=new Set<string>(),calls:string[]=[];const host=new MacSetupHost(directory,{probe:async id=>({id,state:states.has(id)?'installed':'missing',message:'fixture'}),install:async id=>{states.add(id);calls.push(id);},launch:async()=>{}},true);
 for(let i=0;i<2;i++){await host.act({operation:'start',selected:MAC_SETUP_DEFAULT_SELECTION,requestId:crypto.randomUUID(),expectedRevision:host.status().view.revision});for(let n=0;host.status().view.active&&n<300;n++)await Bun.sleep(2);}
 expect(calls).toEqual(['git','node','codex','claude','github','supabase']);expect(host.status().view.active).toBe(false);
});
test('official Claude signed-out exit 1 is parsed; tool-free flags and literal argv preserve own authentication',async()=>{
 const dir=temporary(),exe=join(dir,'claude'),args=join(dir,'args'),logged=join(dir,'logged');
 writeFileSync(exe,`#!/bin/sh\nif [ "$1" = auth ]; then\n if [ "$2" = login ]; then /usr/bin/touch '${logged}'; exit 0; fi\n if [ -f '${logged}' ]; then /usr/bin/printf '{"loggedIn":true}'; else /usr/bin/printf '{"loggedIn":false}'; exit 1; fi\nelif [ "$1" = --help ]; then /usr/bin/printf '%s' '${HELPDESK_CLAUDE_ARGS.join(' ')}';\nelse /usr/bin/printf '%s\\n' "$@" > '${args}'; /usr/bin/printf '{"result":"실제 격리 CLI 응답","is_error":false}'; fi\n`,{mode:0o755});
 const claude=createHelpdeskClaude({home:dir,searchPaths:[dir]});expect(await claude.check()).toBe('signed-out');await claude.login(new AbortController().signal);expect(await claude.check()).toBe('ready');expect(await claude.answer('literal $(no shell)',new AbortController().signal)).toBe('실제 격리 CLI 응답');
 const argv=readFileSync(args,'utf8');for(const flag of ['--safe-mode','--restricted','--tools\n\n','--strict-mcp-config','--no-session-persistence'])expect(argv).toContain(flag);expect(argv).not.toContain('--bare');expect(argv).not.toContain('--dangerously-skip-permissions');expect(argv).toContain('literal $(no shell)');
});
test('OS prerequisite approval keeps the same queue waiting for an executable and respects cancellation',async()=>{
 let checks=0;await waitForMacSetupPrerequisite(async()=>({id:'git',state:++checks<3?'missing':'installed',message:''}),new AbortController().signal,500,1);expect(checks).toBe(3);
 const cancelled=new AbortController();const waiting=waitForMacSetupPrerequisite(async()=>({id:'git',state:'missing',message:''}),cancelled.signal,500,20);cancelled.abort();await expect(waiting).rejects.toThrow();
 await expect(waitForMacSetupPrerequisite(async()=>({id:'git',state:'missing',message:''}),new AbortController().signal,5,1)).rejects.toThrow('TIMEOUT');
});
test('only the auth status probe accepts exit 1; other commands fail and cancelled probes still fail',async()=>{
 const args=['-c','printf \'{"loggedIn":false}\'; exit 1'];await expect(macSetupCommand('/bin/sh',args,process.env)).rejects.toThrow();expect(await macSetupCommand('/bin/sh',args,process.env,undefined,2000,true,[0,1])).toContain('false');
 const abort=new AbortController();abort.abort();await expect(macSetupCommand('/bin/sh',args,process.env,abort.signal,2000,true,[0,1])).rejects.toThrow();
});
test('management route and native proxy expose only the authenticated POST path; entries remain distinct from Workroom execution',()=>{
 const root=join(import.meta.dir,'..'),api=readFileSync(join(root,'api-server.ts'),'utf8'),rust=readFileSync(join(root,'src-tauri/src/lib.rs'),'utf8'),app=readFileSync(join(root,'src/App.tsx'),'utf8');
 expect(api).toContain("url.pathname === '/api/agent-runtime/helpdesk'");expect(api).toContain("method === 'POST' && url.search === ''");expect(rust).toContain('"/api/agent-runtime/helpdesk"');expect(app).toContain('data-testid="helpdesk-open"');expect(app).toContain("action==='phone'){setShowInternetQrRemoteControl(true);");
 expect(api).toContain("cwd:helpdeskDirectory");expect(api).toContain("executionMode:'read-only'");expect(api).toContain('helpdeskHost.shutdown()');
});
test('only the native Mac entry exposes Mac preparation; Windows and ordinary browsers retain their original setup',()=>{
 expect(isMacHelpdeskSurface(true,'MacIntel')).toBe(true);expect(isMacHelpdeskSurface(true,'Win32')).toBe(false);expect(isMacHelpdeskSurface(true,'Linux x86_64')).toBe(false);expect(isMacHelpdeskSurface(false,'MacIntel')).toBe(false);
});
test('mobile Google setup includes the exact native return allowlist as well as the separate provider callback',()=>{
 const steps=HELPDESK_MOBILE_GUIDES.google.steps.join('\n');
 expect(steps).toContain(NATIVE_PORTAL_CALLBACK+'?state=*');
 expect(steps).toContain('Supabase의 Google Provider 화면에 표시되는 callback URL');
 expect(steps).toContain('Web application');
 expect(steps).toContain('설정 등록 확인과 실제 로그인 성공은 구분');
 expect(HELPDESK_MOBILE_GUIDES.google.description).toContain('로그인용 웹 클라이언트');
});
test('the HTTP reader rejects declared and streamed oversize input before parsing and rejects malformed UTF-8',async()=>{
 const request=(body:BodyInit,headers={})=>new Request('http://127.0.0.1/helpdesk',{method:'POST',headers,body});
 expect(await readHelpdeskRequest(request('{"operation":"status"}'))).toEqual({operation:'status'});
 await expect(readHelpdeskRequest(request('{}',{'content-length':'16001'}))).rejects.toThrow('너무');
 let cancelled=false;const stream=new ReadableStream<Uint8Array>({start(c){c.enqueue(new Uint8Array(16001));},cancel(){cancelled=true;}});await expect(readHelpdeskRequest(request(stream))).rejects.toThrow('너무');expect(cancelled).toBe(true);
 await expect(readHelpdeskRequest(request(new Uint8Array([255])))).rejects.toThrow();
});
// UX audit 2026-10-25: HELPDESK.md answered 「사용자 프로필은 어디에 있나요?」 but the in-app catalog — the only material the
// helpdesk AI gets — did not. Appended so the panel's fixed HELPDESK_GUIDES[1]/[6] shortcuts keep their guides.
test('the in-app catalog says where 아젠투지 설정 is, without calling OPS memory the user\'s own',()=>{
 const guide=HELPDESK_GUIDES.find(g=>g.id==='profile')!;
 expect(guide.question).toBe('사용자 프로필은 어디에 있나요?');
 expect(guide.text).toContain('도구 및 설정 → 아젠투지 설정');
 expect(guide.text).not.toMatch(/내 운영 프로필|나의 .*운영/);
 expect([HELPDESK_GUIDES[1].id,HELPDESK_GUIDES[6].id]).toEqual(['project','error']);
 expect(guide.text).toContain('장기기억 → 내 프로필');
 expect(guide.text).toContain('지시 원문');
 expect(helpdeskPrompt('프로필',[],{})).toContain('[profile] 내 프로필과 아젠투지 설정');
});

test('computer-use onboarding distinguishes native human approval, shared connections, and remote Screen',()=>{
 const guide=HELPDESK_GUIDES.find(g=>g.id==='computer-use')!;
 expect(guide.action).toBe('computer');expect(guide.text).toContain('도구 및 설정 → 컴퓨터 유즈');
 for(const phrase of ['본인이 승인','최대 10분','여러 대화','결과 불명','원격 화면 등록'])expect(guide.text).toContain(phrase);
 expect(helpdeskPrompt('컴퓨터 유즈 연결',[],{})).toContain('[computer-use] AI에 창 하나 맡기기');
});
