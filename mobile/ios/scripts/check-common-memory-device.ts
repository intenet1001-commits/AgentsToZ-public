/** Real iPhone WKWebView of shipped cloud panels; isolated cloud and owned Git fixtures only.
 * `--compile-only` runs just the iPhone compile step: no fixture server, template, device or signing. */
import {networkInterfaces} from 'node:os';
import {mkdirSync,readFileSync,writeFileSync,cpSync,mkdtempSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {workroomFixtureCompileCommands,workroomFixtureSdk,workroomFixtureTarget} from './workroomFixtureCompile';
import {createHash} from 'node:crypto';
const root=resolve(import.meta.dir,'../../..');
async function command(args:string[],timeout=120_000){const p=Bun.spawn(args,{cwd:root,stdout:'pipe',stderr:'pipe'}),timer=setTimeout(()=>p.kill(),timeout);try{const [exit,out,err]=await Promise.all([p.exited,new Response(p.stdout).text(),new Response(p.stderr).text()]);if(exit)throw Error(args[0]+' failed: '+err.slice(-2000));return out.trim();}finally{clearTimeout(timer);}}
// The shared recipe (workroomFixtureCompile.ts): the same modules, App files and Swift 6 mode as check-workroom.ts.
async function compile(temp:string,app:string){
 const sdkPath=await command(['xcrun','--sdk',workroomFixtureSdk('device'),'--show-sdk-path']);
 for(const args of workroomFixtureCompileCommands({root,sdkPath,target:workroomFixtureTarget('device'),buildDir:temp,probe:'commonMemory',output:join(app,'AgentsToZMobile')}))await command(args,300_000);
}
if(process.argv[2]==='--compile-only'){
 const temp=mkdtempSync('/private/tmp/agentstoz-common-iphone-'),app=join(temp,'CompileOnly.app');
 try{mkdirSync(app);await compile(temp,app);console.log('Common-memory fixture compiled for iPhone; nothing installed.');}finally{rmSync(temp,{recursive:true,force:true});}
 process.exit(0);
}
const [device,template,identity]=process.argv.slice(2);
if(!device||!template||!identity)throw Error('Usage: bun mobile/ios/scripts/check-common-memory-device.ts <UDID> <isolated-workspacetest-template> <signing-identity> | --compile-only');
// Host fixture code loads only for a real run, never for --compile-only.
const {commonMemoryUiFixture}=await import('../../../tests/fixtures/common-memory/server');
const {isPrivateRemoteControlIpv4}=await import('../../../src/remoteControlLanServer');
const bundle='com.intenet.agentstoz.workspacetest',address=Object.values(networkInterfaces()).flat().find(r=>r&&!r.internal&&r.family==='IPv4'&&isPrivateRemoteControlIpv4(r.address))?.address;
if(!address)throw Error('Private LAN required; no public/wildcard fallback');
const temp=mkdtempSync('/private/tmp/agentstoz-common-iphone-'),evidence=join(root,'mobile/ios/build/common-memory-device-evidence');mkdirSync(evidence,{recursive:true});
const sourcePaths=['src/CommonMemoryPanel.tsx','src/MetaCommonMemoryPanel.tsx','src/CommonMemoryProjectsPanel.tsx','src/commonMemoryClient.ts','src/commonMemoryCrypto.ts','tests/fixtures/common-memory/panel.tsx','mobile/ios/scripts/fixtures/CommonMemoryProbe.swift'];
const sourceHashes=Object.fromEntries(sourcePaths.map(p=>[p,createHash('sha256').update(readFileSync(join(root,p))).digest('hex')]));
const fixture=await commonMemoryUiFixture(address),app=join(temp,'CommonMemoryFixture.app');let installed=false;
let stopRequested=false;process.once('SIGTERM',()=>{stopRequested=true;});process.once('SIGINT',()=>{stopRequested=true;});
try{
 if(await command(['/usr/libexec/PlistBuddy','-c','Print CFBundleIdentifier',join(template,'Info.plist')])!==bundle)throw Error('Refuses production/development/TestFlight app template');
 cpSync(template,app,{recursive:true});writeFileSync(join(app,'bootstrap.json'),JSON.stringify({pairingURL:fixture.url+'/remote/#pair='+'A'.repeat(43)}),{mode:0o600});
 await compile(temp,app);
 const entitlements=await command(['codesign','-d','--entitlements',':-',template]);writeFileSync(join(temp,'entitlements.plist'),entitlements,{mode:0o600});await command(['codesign','--force','--sign',identity,'--entitlements',join(temp,'entitlements.plist'),'--timestamp=none',app]);
 await command(['xcrun','devicectl','device','install','app','--device',device,app]);installed=true;await command(['xcrun','devicectl','device','process','launch','--device',device,bundle]);
 writeFileSync('/private/tmp/agentstoz-common-phone-fixture.json',JSON.stringify({bundleId:bundle,device,url:fixture.url,evidence}),{mode:0o600});console.log('Physical iPhone cloud-panel fixture ready; Appium uses the isolated test app.');
 let completed=false;
 for(let n=0;n<1200;n++){
  if(stopRequested)throw Error('Physical fixture stopped by its owner');
  await Bun.sleep(1000);
  try{await command(['xcrun','devicectl','device','copy','from','--device',device,'--domain-type','appDataContainer','--domain-identifier',bundle,'--source','Documents/common-result.json','--destination',join(evidence,'result.json')],10_000);}catch{continue;}
  const r=JSON.parse(readFileSync(join(evidence,'result.json'),'utf8'));if(r.failed)throw Error('Probe failed: '+r.error);if(r.done){completed=true;break;}
 }
 if(!completed)throw Error('Physical UI fixture timed out before Appium marked completion');
 for(const name of ['common-complete.png'])await command(['xcrun','devicectl','device','copy','from','--device',device,'--domain-type','appDataContainer','--domain-identifier',bundle,'--source','Documents/'+name,'--destination',join(evidence,name)],15_000);
 for(const p of sourcePaths)if(createHash('sha256').update(readFileSync(join(root,p))).digest('hex')!==sourceHashes[p])throw Error('Source changed during physical UI verification');
 const r=JSON.parse(readFileSync(join(evidence,'result.json'),'utf8'));writeFileSync(join(evidence,'result.json'),JSON.stringify({...r,actualIPhone:true,productionData:false,realSupabase:false,sourceHashes},null,2),{mode:0o600});console.log('Physical iPhone cloud-panel fixture completed.');
}finally{if(installed)await command(['xcrun','devicectl','device','uninstall','app','--device',device,bundle],30_000).catch(()=>{});fixture.stop();rmSync(temp,{recursive:true,force:true});}
