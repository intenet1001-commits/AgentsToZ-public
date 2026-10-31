import assert from 'node:assert/strict';import{mkdtemp,mkdir,writeFile,chmod,rm,copyFile,readFile}from'node:fs/promises';import{tmpdir}from'node:os';import{join,resolve}from'node:path';import{spawn}from'node:child_process';import{build}from'vite';import react from'@vitejs/plugin-react';
import{AiTerminalService}from'../src/aiTerminalService.ts';import{WorkroomBrowserHost}from'../src/workroomBrowserHost.ts';import{handleWorkroomBrowser}from'../src/workroomBrowserApi.ts';
import{WorkroomCdpTransport}from'../src/workroomCdpTransport.ts';import{WorkroomBrowserRecovery}from'../src/workroomBrowserRecovery.ts';
import{createHash}from'node:crypto';
import{WORKROOM_TEAM_PANEL_PATH,parseTeamPanelRequest}from'../src/workroomTeamPanel.ts';
const root=resolve(import.meta.dir,'..'),out=join(root,'output/workroom-browser-native-qa'),qa=join(root,'native/workroom-browser/qa');await mkdir(out,{recursive:true});
const executable=join(out,'bundle/app.app/Contents/MacOS/app'),sourceStamp=join(out,'native-source.json');
// The bundled UI contains the fixture and its production import graph. Hash every source file (including new,
// untracked sources), native/QA inputs and dependency manifests, rather than trusting an existing output directory.
async function nativeSourceFingerprint(){
 const listed=Bun.spawnSync(['git','ls-files','--cached','--others','--exclude-standard','-z','--','src','native/workroom-browser','src-tauri/src/workroom_browser.rs','src-tauri/icons/icon.png','tests/fixtures/workroom-browser-native.tsx','tests/fixtures/workroom-browser-native.html','tests/workroom-browser-native.mjs','package.json','bun.lock','bun.lockb','tsconfig.json'],{cwd:root,stdout:'pipe',stderr:'pipe'});
 assert.equal(listed.exitCode,0,'Native QA could not enumerate its source inputs');const files=[...new Set(listed.stdout.toString().split('\0').filter(Boolean))].sort();assert(files.includes('tests/fixtures/workroom-browser-native.tsx'),'Native QA fixture is missing from its source fingerprint');
 const hash=createHash('sha256');for(const file of files){const bytes=await readFile(join(root,file));hash.update(file+'\0'+bytes.length+'\0');hash.update(bytes);}return {hash:hash.digest('hex'),files:files.length};
}
const executableFingerprint=async()=>createHash('sha256').update(await readFile(executable)).digest('hex');
const sourceAtStart=await nativeSourceFingerprint();
const restoreDelayMs=Number(process.argv.find(arg=>arg.startsWith('--restore-delay-ms='))?.split('=')[1]??0);assert(Number.isInteger(restoreDelayMs)&&restoreDelayMs>=0&&restoreDelayMs<=20000,'restore-delay-ms must be0..20000');
const coldRuns=Number(process.argv.find(arg=>arg.startsWith('--cold-runs='))?.split('=')[1]??1);assert(Number.isInteger(coldRuns)&&coldRuns>=1&&coldRuns<=10,'cold-runs must be1..10');
// Each later launch is a fresh app process restoring the saved profile. `slow` delays every /restore by SLOW_MS to drive
// recovery while the document loads (modal, Workroom switch, collapse, close and reopen); `lost` drops the native
// target discovery replies until the fixture lets them through again.
const SLOW_MS=5000,EXPECTED_CHECKS={main:32,cold:2,slow:4,lost:2};
const freshStats=()=>({restoreHits:0,connects:0,navHits:0,postHits:0,teamPanelReads:0,crossOriginHits:0,coopHits:0,inspectorDetached:0,rendererGone:0,targetClosed:0,otherInspectorDetached:0,cdpClosed:0});
let coldLaunches=0,launchDelay=0,stats=freshStats();const processReports=[];await writeFile(join(out,'report.json'),JSON.stringify({passed:false,state:'running',restoreDelayMs}));
async function command(command,args,options={}){const p=Bun.spawn([command,...args],{cwd:root,env:{...process.env,...options.env},stdout:'inherit',stderr:'inherit'});assert.equal(await p.exited,0,`${command} failed`);}
if(process.argv.includes('--build')){
 await rm(sourceStamp,{force:true});
 await build({configFile:false,plugins:[react()],build:{target:'esnext',outDir:join(out,'ui'),emptyOutDir:true,rollupOptions:{input:join(root,'tests/fixtures/workroom-browser-native.html')}}});
 // Rollup preserves the project-relative HTML path; Tauri serves the resulting entry as index.html.
 await copyFile(join(out,'ui/tests/fixtures/workroom-browser-native.html'),join(out,'ui/index.html'));
 await mkdir(join(qa,'icons'),{recursive:true});await copyFile(join(root,'src-tauri/icons/icon.png'),join(qa,'icons/icon.png'));
 assert(process.env.CEF_PATH,'Set CEF_PATH to the downloaded CEF SDK cache before --build');const env={PATH:process.env.PATH,CEF_PATH:process.env.CEF_PATH};
 await command('cargo',['build','--locked','--manifest-path','native/workroom-browser/Cargo.toml','--bins'],{env});
 await command('cargo',['build','--locked','--manifest-path','native/workroom-browser/qa/Cargo.toml','--target-dir','experiments/owned-browser-native/target'],{env});
 await command(join(root,'native/workroom-browser/target/debug/bundle-workroom-browser'),['--qa'],{env});
 const builtSource=await nativeSourceFingerprint();assert.deepEqual(builtSource,sourceAtStart,'Native QA source changed during --build; freeze the source and rebuild');
 await writeFile(sourceStamp,JSON.stringify({schema:1,source:builtSource,executable:await executableFingerprint()}));
}
try{
 const stamp=JSON.parse(await readFile(sourceStamp,'utf8'));
 assert(stamp.schema===1&&stamp.source?.hash===sourceAtStart.hash&&stamp.source?.files===sourceAtStart.files,'Native QA source does not match the cached bundle; run bun tests/workroom-browser-native.mjs --build after source freeze');
 assert.equal(stamp.executable,await executableFingerprint(),'Native QA executable does not match its build receipt; run bun tests/workroom-browser-native.mjs --build');
}catch(error){const message=error?.code==='ENOENT'?'Native QA build receipt or executable is missing; run bun tests/workroom-browser-native.mjs --build':error.message;await writeFile(join(out,'report.json'),JSON.stringify({passed:false,state:'blocked',error:message}));throw Error(message);}
const refused=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response()});const refusedUrl=`http://127.0.0.1:${refused.port}/`;refused.stop(true);
const temp=await mkdtemp(join(tmpdir(),'atz-workroom-native-')),cli=join(temp,'fake-cli');await writeFile(cli,'#!/bin/sh\nstty -echo\nprintf "REAL_PTY_READY\\n"\nwhile IFS= read -r line; do printf "PTY_INPUT:%s\\n" "$line"; done\n');await chmod(cli,0o700);
const targetId='native_fixture_project',terminal=new AiTerminalService({resolveTarget:async id=>{assert.equal(id,targetId);return{cwd:temp};},executable:()=>cli,codexHookTrustSupported:async()=>false});
const started=await terminal.perform({operation:'start',targetId,agent:'codex',cols:90,rows:25,requestId:'native_fixture_launch'});const session=started.session;assert(session);
const sibling=(await terminal.perform({operation:'start',targetId,agent:'codex',cols:90,rows:25,requestId:'native_fixture_sibling'})).session;assert(sibling);
const recovery=new WorkroomBrowserRecovery(join(temp,'recovery.sqlite'));
const browser=new WorkroomBrowserHost({runningSession:id=>terminal.runningSession(id),profiles:()=>[],recovery,connect:async endpoint=>{
 const cdp=await WorkroomCdpTransport.connect(endpoint);
 // Passive QA evidence only: the installed disconnect's cause is not established. A real cross-site/COOP run
 // records fixed lifecycle counters, never CDP payloads, private addresses, access, or document contents.
 cdp.onEvent((method,params)=>{if(method==='Inspector.detached'){stats.inspectorDetached++;if(params.reason==='Render process gone.')stats.rendererGone++;else if(params.reason==='target_closed')stats.targetClosed++;else stats.otherInspectorDetached++;}});
 cdp.onClose(()=>{stats.cdpClosed++;});return cdp;
}});
// Observe the real UI's grant response only in this disposable host's private memory. The fixture never invents a
// grant, writes it into a textarea/storage, or reports it. One bounded entry follows the currently launched QA app.
let qaSessionId=session.id,qaBrowser={workspaceId:null,access:null,resume:0,grant:0};
const redact=value=>String(value).replace(/\b[a-f0-9]{64}\b/gi,'[redacted browser grant]');
// The fixture's geometry probes (qa_log) from an already redacted log: the last 24 lines, each bounded by the host.
const probesFrom=text=>[...text.matchAll(/ATZ_NATIVE_QA_PROBE:([^\n]+)/g)].slice(-24).map(([,line])=>{try{return JSON.parse(line);}catch{return {unparsed:line.slice(0,2000)};}});
const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(req){const path=new URL(req.url).pathname;
 // This isolated browser host creates no teams. Serve the real read contract instead of manufacturing an unrelated
 // route-refused error strip in the production Workroom, whose height is part of the native geometry assertions.
 if(path===WORKROOM_TEAM_PANEL_PATH){
  try{assert.equal(req.method,'POST');const request=parseTeamPanelRequest(await req.json());assert(terminal.runningSession(request.sessionId));stats.teamPanelReads++;return Response.json({teams:[]});}
  catch{return Response.json({error:'Invalid isolated team-panel read'},{status:400});}
 }
 if(path==='/fixture')return new Response('<!doctype html><title>Native fixture</title><h1>Native Workroom</h1><p id="ipc"></p><p id="state"></p><input id="draft"><output>Ready</output><button id="popup">Login popup</button><p id="popup-state"></p><input type="file" id="upload"><p id="upload-state"></p><a id="download" href="/download">Download</a><open-native></open-native><iframe id="native-frame" src="http://localhost:'+new URL(req.url).port+'/native-frame" width="260" height="90"></iframe><script>customElements.define("open-native",class extends HTMLElement{constructor(){super();this.attachShadow({mode:"open"}).innerHTML=\'<input id="shadow-field" aria-label="Shadow field">\';}});document.querySelector("#ipc").textContent=window.__TAURI_INTERNALS__?"BAD_TAURI_IPC":"NO_TAURI_IPC";const role=new URL(location.href).searchParams.get("role")||"one";document.cookie="atz-role="+role+";path=/";localStorage.setItem("atz-role",role);setInterval(()=>document.querySelector("#state").textContent="cookie="+document.cookie+" storage="+localStorage.getItem("atz-role"),100);document.querySelector("#popup").onclick=()=>window.open("/popup","fixture-login");addEventListener("message",e=>{if(e.origin===location.origin)document.querySelector("#popup-state").textContent=e.data});document.querySelector("#upload").onchange=async e=>{document.querySelector("#upload-state").textContent=await e.target.files[0].text()};document.querySelector("#draft").oninput=()=>document.querySelector("output").textContent=document.querySelector("#draft").value;</script>',{headers:{'Content-Type':'text/html','Content-Security-Policy':`default-src 'self'; script-src 'unsafe-inline'; frame-src http://localhost:${new URL(req.url).port}`}});
 // A second tab's page: nothing on it touches the profile's cookies or storage, which later checks read.
 if(path==='/nav-a'||path==='/nav-b'){stats.navHits++;return new Response('<!doctype html><title>'+path+'</title><h1>'+path+'</h1><button id="popup" onclick="window.open(\'/popup\',\'native-nav-popup\')">Popup</button><form method="POST" action="/nav-post"><button>Submit disposable form</button></form>',{headers:{'Content-Type':'text/html'}});}
 // Top-level sites, not just an OOP iframe. Both names resolve only to this disposable server; no Google,
 // personal profile or real account is used. COOP is an actual response policy, not a synthetic CDP event.
 if(path==='/nav-cross-origin'||path==='/nav-coop'){
  const coop=path==='/nav-coop';if(coop)stats.coopHits++;else stats.crossOriginHits++;
  const title=coop?'Native COOP fixture':'Native cross-origin fixture';
  return new Response('<!doctype html><meta charset="utf-8"><title>'+title+'</title><h1>'+title+'</h1><p>Disposable top-level navigation</p>',{headers:{'Content-Type':'text/html; charset=utf-8',...(coop?{'Cross-Origin-Opener-Policy':'same-origin'}:{})}});
 }
 if(path==='/nav-post'){stats.postHits++;return new Response('<!doctype html><title>POST result</title><h1>POST result</h1>',{headers:{'Content-Type':'text/html'}});}
 if(path==='/nav-slow'){await Bun.sleep(5000);return new Response('<title>Slow navigation</title>',{headers:{'Content-Type':'text/html'}});}
 if(path==='/native-tab')return new Response('<!doctype html><meta charset="utf-8"><title>Native tab two</title><h1>Native tab two</h1><input id="tab-field" aria-label="Tab field">',{headers:{'Content-Type':'text/html; charset=utf-8'}});
 // A cross-origin frame for the fixture page: localhost is another site than 127.0.0.1, so it runs out of process.
 if(path==='/native-frame')return new Response('<!doctype html><meta charset="utf-8"><p>Native cross frame</p><input id="frame-field" aria-label="Frame field"><output id="frame-out">frame:none</output><script>document.getElementById("frame-field").oninput=e=>{document.getElementById("frame-out").textContent="frame:"+e.target.value;};</script>',{headers:{'Content-Type':'text/html; charset=utf-8'}});
 if(path==='/api/agent-runtime/workroom-browser'){
  const body=await req.clone().json().catch(()=>null);if(body?.operation==='connect-owned')stats.connects++;
  const response=await handleWorkroomBrowser(req,browser),result=await response.clone().json().catch(()=>null),workspace=result?.workspace;
  if(workspace?.sessionId===qaSessionId||body?.workspaceId===qaBrowser.workspaceId){
   if(body.operation==='resume'||body.operation==='grant')qaBrowser[body.operation]++;
   if(workspace?.sessionId===qaSessionId)qaBrowser.workspaceId=workspace.id;
   if(body.operation==='grant'&&response.ok&&workspace?.sessionId===qaSessionId&&/^[a-f0-9]{64}$/.test(result.grant??''))qaBrowser.access={workspaceId:workspace.id,grant:result.grant,epoch:workspace.epoch};
   else if(response.ok&&(body.operation==='take'||body.operation==='detach'||workspace&&workspace.owner!=='agent'))qaBrowser.access=null;
  }
  return response;
 }
 if(path==='/qa-end-workroom'){await terminal.perform({operation:'close',sessionId:session.id,requestId:'native_fixture_close',memoryPolicy:'skip'});browser.reap();return Response.json({success:true});}
 if(path==='/popup')return new Response('<!doctype html><title>Fixture login popup</title><script>if(window.opener&&document.cookie.includes("atz-role=one"))window.opener.postMessage("popup-login-ok",location.origin)</script>',{headers:{'Content-Type':'text/html'}});
 if(path==='/restore'){stats.restoreHits++;if(launchDelay)await Bun.sleep(launchDelay);return new Response('<!doctype html><title>Restored fixture</title><h1>Read-only profile restore probe</h1>',{headers:{'Content-Type':'text/html'}});}
 if(path==='/download')return new Response('disposable-download-proof',{headers:{'Content-Disposition':'attachment; filename="download-probe.txt"','Content-Type':'application/octet-stream'}});
 if(path==='/qa-human'){
  const body=await req.json();if(body.operation==='stats')return Response.json(stats);if(body.operation==='download-status'){try{return Response.json({ready:(await readFile(join(temp,'cef/download-probe.txt'),'utf8'))==='disposable-download-proof'});}catch{return Response.json({ready:false});}}
  // Trusted QA IPC reads a response already issued to the production onHandoff callback. This route neither resumes
  // nor grants and is not exposed as browser page content. Reports below contain counts only, never this access.
  if(body.operation==='browser-access'||body.operation==='browser-state'){
   assert(req.method==='POST'&&!new URL(req.url).search&&!req.headers.has('origin')&&!req.headers.has('sec-fetch-site'),'Private response inspection requires native QA IPC');
   assert(body.sessionId===qaSessionId,'Only the current trusted QA session can inspect its private browser response');assert.deepEqual(Object.keys(body).sort(),['operation','sessionId']);
   let connected=false;if(qaBrowser.workspaceId){try{connected=(await browser.perform({operation:'status',workspaceId:qaBrowser.workspaceId})).workspace?.connection==='connected';}catch(e){assert.equal(e.code,'workspace-not-found');}}
   return Response.json({connected,resume:qaBrowser.resume,grant:qaBrowser.grant,...(body.operation==='browser-access'?{access:qaBrowser.access}:{})},{headers:{'Cache-Control':'private, no-store'}});
  }
  const allowed={post:'document.querySelector("form").requestSubmit()',popup:'document.querySelector("#popup").click()',upload:'document.querySelector("#upload").click()',download:'document.querySelector("#download").click()',state:'JSON.stringify({popup:document.querySelector("#popup-state")?.textContent,upload:document.querySelector("#upload-state")?.textContent,cookie:document.cookie,storage:localStorage.getItem("atz-role")})'};
  assert(Object.hasOwn(allowed,body.operation));assert(Number.isInteger(body.port)&&body.port>0&&body.port<65536);const version=await fetch(`http://127.0.0.1:${body.port}/json/version`).then(r=>r.json());const cdp=await WorkroomCdpTransport.connect(version.webSocketDebuggerUrl);
  try{const attached=await cdp.send('Target.attachToTarget',{targetId:body.pageId,flatten:true});const r=await cdp.send('Runtime.evaluate',{expression:allowed[body.operation],returnByValue:true,userGesture:true},attached.sessionId);return Response.json({value:r.result?.value??null});}finally{cdp.close();}
 }
 try{const body=await req.json();const result=path==='/qa-agent'?await browser.agent(body):await terminal.perform(body);const text=JSON.stringify(result);return new Response(text,{headers:{'Content-Type':'application/json','Content-Length':String(Buffer.byteLength(text))}});}catch(e){return Response.json({success:false,error:e.message},{status:400});}
}});
let child,log='',timer;
try{
 await mkdir(join(temp,'cef'),{mode:0o700});await writeFile(join(temp,'cef/upload-probe.txt'),'disposable-upload-proof');
 // Stay in the tester's process group so cancellation also contains CEF helpers.
 async function launch(mode){
  const restoreOnly=mode!=='main',activeSession=restoreOnly?(await terminal.perform({operation:'start',targetId,agent:'codex',cols:90,rows:25,requestId:`native_fixture_cold_launch_${++coldLaunches}`})).session:session;assert(activeSession);
  qaSessionId=activeSession.id;qaBrowser={workspaceId:null,access:null,resume:0,grant:0};
  launchDelay=mode==='cold'?restoreDelayMs:mode==='slow'?SLOW_MS:0;stats=freshStats();const started=Date.now();
  log='';child=spawn(executable,[],{detached:false,env:{...process.env,ATZ_QA_ROOT:join(temp,'cef'),ATZ_QA_PORT:String(server.port),...(mode==='lost'?{ATZ_QA_DROP_TARGET_SESSION:activeSession.id}:{}),ATZ_QA_CONTEXT:JSON.stringify({session:activeSession,sibling,fixtureUrl:`http://127.0.0.1:${server.port}/fixture`,refusedUrl,restoreOnly,mode,restoreDelayMs:launchDelay,restoreProfileKey:session.id})},stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',b=>{log=(log+b).slice(-256000);});child.stderr.on('data',b=>{log=(log+b).slice(-256000);});
  let code;
  try{code=await Promise.race([new Promise(r=>child.once('exit',r)),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Native Workroom QA timed out')),90000);})]);}
  catch(error){log=redact(log);await writeFile(join(out,restoreOnly?`${mode}-restart-${coldLaunches}.log`:'last-run.log'),log);processReports.push({mode,elapsedMs:Date.now()-started,stats:structuredClone(stats),error:redact(error),probes:probesFrom(log),logTail:log.slice(-6000)});throw error;}
  finally{clearTimeout(timer);}
  log=redact(log);await writeFile(join(out,restoreOnly?`${mode}-restart-${coldLaunches}.log`:'last-run.log'),log);if(mode==='cold')await writeFile(join(out,'cold-restart.log'),log);
  const match=log.match(/ATZ_WORKROOM_NATIVE_QA:(\{[^\n]+\})/);if(!match)processReports.push({mode,elapsedMs:Date.now()-started,stats:structuredClone(stats),exitCode:code,error:'The QA app exited without a report',probes:probesFrom(log),logTail:log.slice(-6000)});assert(match,log.slice(-6000));const report=JSON.parse(match[1]);processReports.push({mode,coldLaunch:restoreOnly?coldLaunches:0,elapsedMs:Date.now()-started,stats:structuredClone(stats),probes:probesFrom(log),...structuredClone(report)});assert.equal(code,0,log.slice(-5000));assert.equal(report.passed,true);if(mode==='main')assert(stats.teamPanelReads>0,'The production team strip did not reach its strict empty-ledger fixture');assert.equal(report.checks.length,EXPECTED_CHECKS[mode]);assert(log.includes('ATZ_WORKROOM_NATIVE_CLEAN_EXIT:0'),'CEF shutdown not confirmed');assert(!log.includes('Cannot create profile'),'CEF profile was not created');assert(log.includes('ATZ_BROWSER_CLOSE_PENDING:0'),'CEF views remained alive at shutdown');return report;
 }
 const report=await launch('main');for(const mode of [...Array(coldRuns).fill('cold'),'slow','lost']){const next=await launch(mode);report.checks.push(...next.checks);}
 assert.deepEqual(await nativeSourceFingerprint(),sourceAtStart,'Native QA source changed during execution; cached success cannot verify the changed source');
 try{await writeFile(join(out,'cef-last.log'),redact(await readFile(join(temp,'cef/cef.log'),'utf8')));}catch{/* CEF may emit only stderr. */}
 await writeFile(join(out,'report.json'),JSON.stringify({...report,coldRestart:true,coldRuns,restoreDelayMs,processReports,cleanExit:true,sourceVerified:true,installedAppChanged:false,realProviderInvoked:false},null,2));console.log(JSON.stringify(report));
}catch(error){await writeFile(join(out,'report.json'),JSON.stringify({passed:false,state:'failed',restoreDelayMs,processReports,error:redact(error).slice(0,2000)},null,2));throw Error(redact(error));}
finally{clearTimeout(timer);qaBrowser.access=null;if(child&&child.exitCode===null){child.kill('SIGTERM');}browser.dispose();recovery.close();await terminal.shutdown();server.stop(true);await rm(temp,{recursive:true,force:true});}
