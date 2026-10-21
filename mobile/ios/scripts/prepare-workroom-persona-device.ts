/** Installs only the existing disposable native test bundle, preserving all user apps and pairings. */
import {cpSync,mkdtempSync,readdirSync,readFileSync,writeFileSync,rmSync,mkdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
const [device,template,identity,hostFile='/private/tmp/workroom-persona-host.json']=process.argv.slice(2);
if(!device||!template||!identity)throw Error('Expected explicit device, isolated signed template, signing identity');
const root=resolve(import.meta.dir,'../../..'),bundle='com.intenet.agentstoz.workspacetest',temp=mkdtempSync('/private/tmp/workroom-native-persona-'),evidence=join(root,'mobile/ios/build/workroom-persona-device');mkdirSync(evidence,{recursive:true});
async function command(args:string[],timeout=120000){const p=Bun.spawn(args,{cwd:root,stdout:'pipe',stderr:'pipe'}),timer=setTimeout(()=>p.kill(),timeout);try{const [code,out,err]=await Promise.all([p.exited,new Response(p.stdout).text(),new Response(p.stderr).text()]);if(code)throw Error(args.slice(0,3).join(' ')+' failed: '+err.slice(-2000));return out.trim();}finally{clearTimeout(timer);}}
try{
 if(await command(['/usr/libexec/PlistBuddy','-c','Print CFBundleIdentifier',join(template,'Info.plist')])!==bundle)throw Error('Only the isolated workspacetest template is allowed');
 const host=JSON.parse(readFileSync(hostFile,'utf8')),app=join(temp,'WorkroomPersona.app');cpSync(template,app,{recursive:true});
 writeFileSync(join(app,'bootstrap.json'),JSON.stringify({pairingURL:host.url+'#pair='+'A'.repeat(43),sourceFingerprint:host.manifest.bundleHash,interactionMode:process.env.PERSONA_NATIVE_INTERACTIVE==='1'?'native-touch':'scripted'}),{mode:0o600});
 const sdk=await command(['xcrun','--sdk','iphoneos','--show-sdk-path']),core=join(root,'mobile/ios/AgentsToZCore/Sources/AgentsToZCore');
 await command(['xcrun','swiftc','-parse-as-library','-emit-library','-static','-emit-module','-module-name','AgentsToZCore','-target','arm64-apple-ios17.0','-sdk',sdk,...readdirSync(core).filter(n=>n.endsWith('.swift')).map(n=>join(core,n)),'-o',join(temp,'libAgentsToZCore.a'),'-emit-module-path',join(temp,'AgentsToZCore.swiftmodule')]);
 await command(['xcrun','swiftc','-parse-as-library','-target','arm64-apple-ios17.0','-sdk',sdk,'-I',temp,'-L',temp,'-lAgentsToZCore',join(root,'mobile/ios/App/PortalSchemeHandler.swift'),join(root,'mobile/ios/App/WorkroomStoreWipe.swift'),join(root,'mobile/ios/App/LANWorkroomView.swift'),join(import.meta.dir,'fixtures/WorkroomPersonaProbe.swift'),'-o',join(app,'AgentsToZMobile')]);
 writeFileSync(join(temp,'entitlements.plist'),await command(['codesign','-d','--entitlements',':-',template]),{mode:0o600});
 await command(['codesign','--force','--sign',identity,'--entitlements',join(temp,'entitlements.plist'),'--timestamp=none',app]);
 await command(['xcrun','devicectl','device','install','app','--device',device,app]);
 await command(['xcrun','devicectl','device','process','launch','--device',device,bundle]);
 writeFileSync('/private/tmp/workroom-persona-phone.json',JSON.stringify({device,bundleId:bundle,evidence,url:host.url,manifest:host.manifest}),{mode:0o600});
 console.log('Owned iPhone persona app ready; no production app was replaced.');
}finally{rmSync(temp,{recursive:true,force:true});}
