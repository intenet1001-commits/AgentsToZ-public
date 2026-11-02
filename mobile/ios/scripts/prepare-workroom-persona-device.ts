/** Installs only the existing disposable native test bundle, preserving all user apps and pairings.
 * `--compile-only` runs just the iPhone compile step (no template, device, host file or signing). */
import {cpSync,mkdtempSync,readFileSync,writeFileSync,rmSync,mkdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {workroomFixtureCompileCommands,workroomFixtureSdk,workroomFixtureTarget} from './workroomFixtureCompile';
const compileOnly=process.argv[2]==='--compile-only';
const [device,template,identity,hostFile='/private/tmp/workroom-persona-host.json']=compileOnly?[]:process.argv.slice(2);
if(!compileOnly&&(!device||!template||!identity))throw Error('Expected explicit device, isolated signed template, signing identity');
const root=resolve(import.meta.dir,'../../..'),bundle='com.intenet.agentstoz.workspacetest',temp=mkdtempSync('/private/tmp/workroom-native-persona-'),evidence=join(root,'mobile/ios/build/workroom-persona-device');
async function command(args:string[],timeout=120000){const p=Bun.spawn(args,{cwd:root,stdout:'pipe',stderr:'pipe'}),timer=setTimeout(()=>p.kill(),timeout);try{const [code,out,err]=await Promise.all([p.exited,new Response(p.stdout).text(),new Response(p.stderr).text()]);if(code)throw Error(args.slice(0,3).join(' ')+' failed: '+err.slice(-2000));return out.trim();}finally{clearTimeout(timer);}}
// The shared recipe (workroomFixtureCompile.ts): the same modules, App files and Swift 6 mode as check-workroom.ts.
async function compile(app:string){
 const sdkPath=await command(['xcrun','--sdk',workroomFixtureSdk('device'),'--show-sdk-path']);
 for(const args of workroomFixtureCompileCommands({root,sdkPath,target:workroomFixtureTarget('device'),buildDir:temp,probe:'persona',output:join(app,'AgentsToZMobile')}))await command(args,300000);
}
try{
 if(compileOnly){const app=join(temp,'CompileOnly.app');mkdirSync(app);await compile(app);console.log('Persona fixture compiled for iPhone; nothing installed.');}
 else{
 mkdirSync(evidence,{recursive:true});
 if(await command(['/usr/libexec/PlistBuddy','-c','Print CFBundleIdentifier',join(template!,'Info.plist')])!==bundle)throw Error('Only the isolated workspacetest template is allowed');
 const host=JSON.parse(readFileSync(hostFile,'utf8')),app=join(temp,'WorkroomPersona.app');cpSync(template!,app,{recursive:true});
 writeFileSync(join(app,'bootstrap.json'),JSON.stringify({pairingURL:host.url+'#pair='+'A'.repeat(43),sourceFingerprint:host.manifest.bundleHash,interactionMode:process.env.PERSONA_NATIVE_INTERACTIVE==='1'?'native-touch':'scripted'}),{mode:0o600});
 await compile(app);
 writeFileSync(join(temp,'entitlements.plist'),await command(['codesign','-d','--entitlements',':-',template!]),{mode:0o600});
 await command(['codesign','--force','--sign',identity!,'--entitlements',join(temp,'entitlements.plist'),'--timestamp=none',app]);
 await command(['xcrun','devicectl','device','install','app','--device',device!,app]);
 await command(['xcrun','devicectl','device','process','launch','--device',device!,bundle]);
 writeFileSync('/private/tmp/workroom-persona-phone.json',JSON.stringify({device,bundleId:bundle,evidence,url:host.url,manifest:host.manifest}),{mode:0o600});
 console.log('Owned iPhone persona app ready; no production app was replaced.');
 }
}finally{rmSync(temp,{recursive:true,force:true});}
