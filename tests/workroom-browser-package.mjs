// Real compiled main app + pinned CEF: disposable layout and inside-out ad-hoc signing.
// Never launches the app, changes installed files or publishes this package.
import assert from 'node:assert/strict';
import {cpSync,mkdtempSync,mkdirSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';import{tmpdir}from'node:os';
import{stageWorkroomBrowserBundle}from'../stageWorkroomBrowserBundle.ts';
const project=resolve(import.meta.dir,'..'),source=join(project,'output/workroom-browser-native/app.app'),root=mkdtempSync(join(tmpdir(),'atz-browser-package-')),app=join(root,'AgentsToZ_byCS.app');
async function run(args){const p=Bun.spawn(args,{stdout:'pipe',stderr:'pipe'});const [code,stderr]=await Promise.all([p.exited,new Response(p.stderr).text()]);assert.equal(code,0,`${args.slice(0,5).join(' ')}: ${stderr}`);}
try{
 cpSync(source,app,{recursive:true,filter:p=>p!==join(source,'Contents/Frameworks')});
 const info=join(app,'Contents/Info.plist');await run(['/usr/bin/plutil','-replace','CFBundleIdentifier','-string','com.intenet.agentstozbycs',info]);await run(['/usr/bin/plutil','-replace','LSMinimumSystemVersion','-string','13.0',info]);
 // Model Tauri's existing GUI bundle signature before adding Chromium. The
 // local CEF smoke bundle starts with a linker signature, not a GUI app seal.
 await run(['/usr/bin/codesign','--force','--sign','-','--entitlements',join(project,'src-tauri/Voice.entitlements'),app]);
 const sdk=join(root,'cef/156.0.7/cef_macos_aarch64');mkdirSync(sdk,{recursive:true});cpSync(join(source,'Contents/Frameworks/Chromium Embedded Framework.framework'),join(sdk,'Chromium Embedded Framework.framework'),{recursive:true,dereference:false,verbatimSymlinks:true});cpSync(join(source,'Contents/Resources/Chromium-CREDITS.html'),join(sdk,'CREDITS.html'));
 const before=readFileSync(info,'utf8');const staged=stageWorkroomBrowserBundle({appBundlePath:app,cefPath:join(root,'cef'),helperPath:join(source,'Contents/Frameworks/app Helper.app/Contents/MacOS/app Helper'),version:'1000.0.0'});
 await run(['/usr/bin/codesign','--force','--deep','--sign','-',staged.frameworkPath]);for(const helper of staged.helperApps)await run(['/usr/bin/codesign','--force','--sign','-',helper]);
 await run(['/usr/bin/codesign','--force','--sign','-','--preserve-metadata=entitlements','--requirements','=designated => identifier "com.intenet.agentstozbycs"',app]);await run(['/usr/bin/codesign','--verify','--deep','--strict','--verbose=4',app]);assert.equal(readFileSync(info,'utf8'),before);
 const entitlement=app=>{const p=Bun.spawnSync(['/usr/bin/codesign','--display','--entitlements','-',app]);assert.equal(p.exitCode,0);return p.stdout.toString();};assert(entitlement(app).includes('com.apple.security.device.audio-input'),'GUI microphone entitlement was lost');for(const helper of staged.helperApps)assert(!entitlement(helper).includes('com.apple.security.device.audio-input'),'GUI privileges leaked into a browser helper');
 const report={passed:true,compiledMainApp:true,staged:true,helpers:5,deepSignatureVerified:true,installed:false,published:false};writeFileSync(join(project,'output/workroom-browser-package-proof.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{rmSync(root,{recursive:true,force:true});}
