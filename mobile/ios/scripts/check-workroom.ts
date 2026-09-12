/** Actual iOS WKWebView + shipped Mac LAN page + real WS/PTY, on a disposable
 * simulator with fake registered targets/CLI only. No app data, API3001 or AI. */
import {mkdtempSync, mkdirSync, chmodSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, cpSync} from 'node:fs';
import {tmpdir, networkInterfaces, arch} from 'node:os';
import {resolve, join} from 'node:path';
import {createHash} from 'node:crypto';
import {RemoteControlLanServer, isPrivateRemoteControlIpv4} from '../../../src/remoteControlLanServer';
import {AiTerminalService} from '../../../src/aiTerminalService';
import {createAiTerminalRemoteGateway} from '../../../src/aiTerminalRemoteGateway';
const root = resolve(import.meta.dir,'../../..');
const temp = mkdtempSync(join(tmpdir(),'agentstoz-ios-workroom-')); chmodSync(temp,0o700);
const physicalDevice = process.argv[2] === '--device' ? process.argv[3] : undefined;
const signedTemplate = physicalDevice ? process.argv[4] : undefined;
const signingIdentity = physicalDevice ? process.argv[5] : undefined;
// Optional anonymous HTTPS smoke. Supply a personal deployment only via local
// environment; never commit the address or include it in evidence/log output.
const portalInput = process.env.AGENTSTOZ_IOS_PORTAL_URL;
let portalURL: string | undefined;
if (portalInput) {
 const parsed = new URL(portalInput);
 if(parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.port && parsed.port !== '443') || !['/','/remote/'].includes(parsed.pathname)) throw Error('Expected a plain HTTPS portal origin');
 portalURL = parsed.origin + '/remote/';
}
if(physicalDevice && (!signedTemplate || !existsSync(signedTemplate) || !signingIdentity)) throw Error('Physical fixture requires a signed isolated test app template');
const evidence = join(root,physicalDevice?'mobile/ios/build/workroom-device-evidence':'mobile/ios/build/workroom-evidence'); mkdirSync(evidence,{recursive:true});
const bundleId=physicalDevice?'com.intenet.agentstoz.workspacetest':'com.intenet.agentstoz.workroomfixture';
// Snapshot the exercised source before compilation, not after a concurrent edit.
const sourceHashes=Object.fromEntries(['mobile/ios/App/LANWorkroomView.swift','mobile/ios/AgentsToZCore/Sources/AgentsToZCore/WorkroomAddress.swift','mobile/ios/AgentsToZCore/Sources/AgentsToZCore/NativeOAuthRequest.swift','mobile/ios/scripts/fixtures/WorkroomProbe.swift','src/remoteControlMobilePage.ts'].map(path=>[path,createHash('sha256').update(readFileSync(join(root,path))).digest('hex')]));
let deviceInstalled=false;
let lastStage="startup";
const runStatus=(state:string)=>writeFileSync(join(evidence,'run-status.json'),JSON.stringify({state,stage:lastStage,at:new Date().toISOString(),actualIPhone:Boolean(physicalDevice),sources:sourceHashes},null,2)+'\n',{mode:0o600});
runStatus("running");
let simulator:string|undefined, server:RemoteControlLanServer|undefined, service:AiTerminalService|undefined;
let forbidden:ReturnType<typeof Bun.serve>|undefined, redirector:ReturnType<typeof Bun.serve>|undefined;
function check(value:unknown,label:string):asserts value {if(!value)throw Error(label);}
async function command(args:string[],timeoutMs=120_000) {
 const child=Bun.spawn(args,{cwd:root,stdin:'ignore',stdout:'pipe',stderr:'pipe'});
 const timer=setTimeout(()=>child.kill(),timeoutMs);
 try {const [code,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
  check(code===0,'Fixture command failed (exit '+code+'): '+args.slice(0,3).join(' ')+'\n'+err.slice(-6000));return out.trim();
 }finally{clearTimeout(timer)}
}
const request=(operation:'list')=>({requestId:crypto.randomUUID(),operation});
try {
 if(physicalDevice)check(await command(['/usr/libexec/PlistBuddy','-c','Print CFBundleIdentifier',join(signedTemplate!,'Info.plist')])===bundleId,'Physical fixture refuses a non-isolated bundle identifier');
 const address=Object.values(networkInterfaces()).flat().find(row=>row&&!row.internal&&row.family==='IPv4'&&isPrivateRemoteControlIpv4(row.address))?.address;
 check(address,'No private LAN interface; no public/wildcard fallback');
 const cli=join(temp,'fake-cli');writeFileSync(cli,'#!/bin/sh\nstty -echo\nprintf "REMOTE_READY\\n"\nwhile IFS= read -r line; do printf "RESULT:%s\\n" "$line"; done\n',{mode:0o700});
 service=new AiTerminalService({resolveTarget:async id=>{check(id==='fixture-runtime-A'||id==='fixture-runtime-B','Unknown fixture target');return{cwd:temp}},executable:()=>cli});
 let deviceGranted=false;
 const gateway=createAiTerminalRemoteGateway({service,active:()=>true,resolve:async bindings=>bindings.map(b=>({controlId:b.controlId,runtimeTargetId:b.target.internalId==='fixture-A'?'fixture-runtime-A':'fixture-runtime-B'})),
  consent:async()=>deviceGranted?{targetIds:new Set(['fixture-runtime-A','fixture-runtime-B']),isActive:()=>deviceGranted,requestOwner:'fixture-paired-device'}:null});
 const operations:{operation:string;agent?:string;target?:string}[]=[];
 server=new RemoteControlLanServer({bindAddress:address,hostName:'Isolated iOS fixture',gateway:{
  listRegisteredProjects:()=>['A','B'].map(suffix=>({internalId:'fixture-'+suffix,name:'Fixture project '+suffix,kind:'main' as const,status:'unknown' as const,port:null,command:null,folderPath:temp,actions:[]})),
  executeRegisteredProjectAction:()=>{throw Error('Project mutation forbidden')}, listWorkspaceRoots:()=>[],
 },terminalGateway:async(r,b,o)=>{operations.push({operation:r.operation,...('agent'in r?{agent:r.agent}:{}),...(r.targetId?{target:b.find(x=>x.controlId===r.targetId)?.target.internalId}:{})});return gateway(r,b,o)}});
 const started=server.start();
 let foreignRequests=0;
 forbidden=Bun.serve({hostname:address,port:0,fetch(){foreignRequests++;return new Response('forbidden')}});
 redirector=Bun.serve({hostname:address,port:0,fetch(){return Response.redirect(`http://${address}:${forbidden!.port}/remote/`,302)}});
 // The shipped LAN response must retain CSP and exact static-route containment.
 const page=await fetch(`http://${address}:${started.status.listener!.port}/remote/`);
 check(page.status===200&&page.headers.get('content-security-policy')?.includes("default-src 'none'"),'LAN CSP missing');
 const app=join(temp,'WorkroomFixture.app');
 if(signedTemplate)cpSync(signedTemplate,app,{recursive:true});else mkdirSync(app);
 writeFileSync(join(app,'bootstrap.json'),JSON.stringify({pairingURL:started.pairing.pairingUrl,foreignURL:`http://${address}:${forbidden.port}/remote/`,redirectQR:`http://${address}:${redirector.port}/remote/#pair=${"a".repeat(43)}`,...(portalURL?{portalURL}:{})}),{mode:0o600});
 const sdk=await command(['xcrun','--sdk',physicalDevice?'iphoneos':'iphonesimulator','--show-sdk-path']);
 const target=physicalDevice?'arm64-apple-ios17.0':(arch()==='arm64'?'arm64':'x86_64')+'-apple-ios17.0-simulator';
 const core=join(root,'mobile/ios/AgentsToZCore/Sources/AgentsToZCore');
 await command(['xcrun','swiftc','-parse-as-library','-emit-library','-static','-emit-module','-module-name','AgentsToZCore','-target',target,'-sdk',sdk,
  ...readdirSync(core).filter(n=>n.endsWith('.swift')).map(n=>join(core,n)),'-o',join(temp,'libAgentsToZCore.a'),'-emit-module-path',join(temp,'AgentsToZCore.swiftmodule')]);
 await command(['xcrun','swiftc','-parse-as-library','-target',target,'-sdk',sdk,'-I',temp,'-L',temp,'-lAgentsToZCore',
  join(root,'mobile/ios/App/LANWorkroomView.swift'),join(import.meta.dir,'fixtures/WorkroomProbe.swift'),'-o',join(app,physicalDevice?'AgentsToZMobile':'WorkroomFixture')]);
 if(physicalDevice){
  await command(['/usr/libexec/PlistBuddy','-c','Set CFBundleDisplayName AgentsToZ Test',join(app,'Info.plist')]);
  const entitlements=await command(['codesign','-d','--entitlements',':-',signedTemplate!]);
  const entitlementFile=join(temp,'entitlements.plist');writeFileSync(entitlementFile,entitlements);
  await command(['codesign','--force','--sign',signingIdentity!,'--entitlements',entitlementFile,'--timestamp=none',app]);
 }else{
  const plist=readFileSync(join(root,'mobile/ios/App/Info.plist'),'utf8').replaceAll('$(EXECUTABLE_NAME)','WorkroomFixture').replaceAll('$(PRODUCT_BUNDLE_IDENTIFIER)',bundleId).replaceAll('$(PRODUCT_NAME)','WorkroomFixture').replaceAll('$(MARKETING_VERSION)','0.1.0').replaceAll('$(CURRENT_PROJECT_VERSION)','1');
  writeFileSync(join(app,'Info.plist'),plist);
  await command(['codesign','--force','--sign','-','--timestamp=none',app]);
 }
 let phone:{name:string;identifier?:string}={name:'Physical iPhone'},runtime:{version:string;identifier?:string}={version:'device'};
 const docs=join(temp,'device-documents');mkdirSync(docs);
 let simulatorDocuments=docs;
 if(physicalDevice){
  await command(['xcrun','devicectl','device','install','app','--device',physicalDevice,app]);deviceInstalled=true;
 }else{
 const runtimes=JSON.parse(await command(['xcrun','simctl','list','runtimes','--json'])).runtimes;
 runtime=runtimes.filter((r:any)=>r.isAvailable&&r.identifier.includes('.iOS-')).at(-1);
 check(runtime,'No available iOS simulator runtime');
 const types=JSON.parse(await command(['xcrun','simctl','list','devicetypes','--json'])).devicetypes;
 phone=types.find((t:any)=>t.name==='iPhone 17 Pro')??types.find((t:any)=>t.name.startsWith('iPhone'));
 check(phone,'No available iPhone simulator type');
 simulator=await command(['xcrun','simctl','create','AgentsToZ Workroom Fixture '+crypto.randomUUID().slice(0,8),phone.identifier!,runtime.identifier!]);
 await command(['xcrun','simctl','boot',simulator]);
 console.log('Owned iOS simulator booting; no existing simulator will be modified');
 await command(['xcrun','simctl','bootstatus',simulator,'-b'],480_000);
 await command(['xcrun','simctl','install',simulator,app]);
 const container=await command(['xcrun','simctl','get_app_container',simulator,bundleId,'data']);
 simulatorDocuments=join(container,'Documents');mkdirSync(simulatorDocuments,{recursive:true});
 }
 const launch=async(id:string)=>physicalDevice?command(['xcrun','devicectl','device','process','launch','--device',physicalDevice,id]):command(['xcrun','simctl','launch',simulator!,id]);
 const answer=async(body:object)=>{const file=join(simulatorDocuments,'command.json');writeFileSync(file,JSON.stringify(body),{mode:0o600});if(physicalDevice)await command(['xcrun','devicectl','device','copy','to','--device',physicalDevice,'--domain-type','appDataContainer','--domain-identifier',bundleId,'--source',file,'--destination','Documents/command.json'])};
 await launch(bundleId);
 let previous='', complete=false;
 const deadline=Date.now()+200_000;
 while(Date.now()<deadline){
  await Bun.sleep(150);
  const file=join(simulatorDocuments,'result.json');
  if(physicalDevice){try{await command(['xcrun','devicectl','device','copy','from','--device',physicalDevice,'--domain-type','appDataContainer','--domain-identifier',bundleId,'--source','Documents/result.json','--destination',file],15_000)}catch{continue}}
  if(!existsSync(file))continue;
  let result:any;try{result=JSON.parse(readFileSync(file,'utf8'))}catch{continue}
  if(result.failed){
   const d=join(simulatorDocuments,'diagnostic.json'); if(existsSync(d))console.log('Fixed fixture diagnostics: '+readFileSync(d,'utf8'));
   const ownSessions=(await service.perform(request('list'))).sessions??[];
   const ownRead=ownSessions[0]?await service.perform({requestId:crypto.randomUUID(),operation:'read',sessionId:ownSessions[0].id,after:0}):null;
   console.log(JSON.stringify({fixtureInputRequests:operations.filter(r=>r.operation==='input').length,fixtureMacHasExpectedOutput:ownRead?.chunks?.some(c=>c.text.includes('RESULT:native-safe-fixture'))??false}));
  }
  check(!result.failed,'WKWebView fixture failed at '+result.stage);
  if(result.stage===previous)continue;previous=result.stage;lastStage=result.stage;
  console.log('WKWebView fixture: '+result.stage);
  if(result.stage==='grant-request'){
   check(server.status().sessions.length===1,'Expected one isolated LAN connection');
   deviceGranted=true;service.setRemoteAccess('lan:'+server.status().sessions[0]!.id,true);await answer({stage:'granted'});
  }else if(result.stage==='memory-draft-ready'){
   check(operations.filter(r=>r.operation==='start').length===1,'Double start escaped UI fence');
   check(operations.find(r=>r.operation==='start')?.target==='fixture-B','Selected project was not sent');
   check(operations.filter(r=>r.operation==='input').length===0,'Remember draft executed automatically');
   await answer({stage:'draft-checked'});
  }else if(result.stage==='visible-workroom'){
   check(operations.filter(r=>r.operation==='input').length===1,'Duplicate input escaped UI fence');
   check(operations.filter(r=>r.operation==='close').length===1,'Explicit stop did not deduplicate');
   check(foreignRequests===0,'Foreign document/popup escaped WKNavigationDelegate');
   if(!physicalDevice)await command(['xcrun','simctl','io',simulator!,'screenshot',join(evidence,'workroom.png')]);
   await launch('com.apple.Preferences');
   await Bun.sleep(800);
   await launch(bundleId);
   await answer({stage:'screenshot-taken'});
  }else if(result.stage==='resumed'){
   check(server.status().sessions.length===1,'Tab/background created an additional controller');
   const sessions=(await service.perform(request('list'))).sessions!;
   check(sessions.filter(s=>s.state==='running').length===1,'Background stopped the running fake AI');
   check(operations.filter(r=>r.operation==='close').length===1,'Background sent terminal close');
   check(operations.filter(r=>r.operation==='start').length===2,'Cold resume started another CLI');
   check(operations.filter(r=>r.operation==='input').length===1,'Cold resume replayed input');
   if(!physicalDevice)await command(['xcrun','simctl','io',simulator!,'screenshot',join(evidence,'resumed.png')]);
   await answer({stage:'disconnect-now'});
  }else if(result.stage==='client-disconnected'){
   for(let n=0;n<100&&server.status().sessions.length;n++)await Bun.sleep(50);
   check(server.status().sessions.length===0,'Native disconnect did not revoke host pairing');deviceGranted=false;
   await answer({stage:'fresh-qr',pairingURL:server.rotatePairing().pairingUrl});
  }else if(result.stage==='revoke-request'){
   check(server.status().sessions.length===1,'Expected one new fixture connection');
   server.revokeSession(server.status().sessions[0]!.id);await answer({stage:'revoked'});
  }else if(result.stage==='portal-visible'){
   if(!physicalDevice)await command(['xcrun','simctl','io',simulator!,'screenshot',join(evidence,'portal.png')]);
   await launch('com.apple.Preferences');await Bun.sleep(800);await launch(bundleId);
   await answer({stage:'portal-returned'});
  }else if(result.done){
   check(foreignRequests===0,'HTTP redirect contacted a different origin');
   complete=true;
   writeFileSync(join(evidence,'result.json'),JSON.stringify({...result,simulator:phone.name,runtime:runtime.version,
    actualIPhone:Boolean(physicalDevice),realAI:false,productionData:false,anonymousPortal:Boolean(portalURL),foreignRequests,operations,
    sources:sourceHashes},null,2)+'\n',{mode:0o600});
   break;
  }
 }
 check(complete,'WKWebView fixture timed out');
 runStatus('passed');
 console.log('Actual iOS WKWebView LAN/terminal/consent/draft/lifecycle checks passed');
}catch(error){
 runStatus('failed');
 if(simulator){try{await command(['xcrun','simctl','io',simulator,'screenshot',join(evidence,'failure.png')],15_000)}catch{}}
 throw error;
}finally{
 if(physicalDevice&&deviceInstalled){try{await command(['xcrun','devicectl','device','uninstall','app','--device',physicalDevice,bundleId],30_000)}catch{}}
 // Clean up only the simulator, listeners and fake PTYs created by this runner.
 if(simulator){try{await command(['xcrun','simctl','shutdown',simulator],30_000)}catch{}try{await command(['xcrun','simctl','delete',simulator],30_000)}catch{}}
 await server?.stop();await forbidden?.stop(true);await redirector?.stop(true);await service?.shutdown();rmSync(temp,{recursive:true,force:true});
}
