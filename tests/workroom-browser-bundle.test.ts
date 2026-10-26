import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,readlinkSync,symlinkSync,existsSync,rmSync,readdirSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {stageWorkroomBrowserBundle} from '../stageWorkroomBrowserBundle';
function fixture(){
 const root=mkdtempSync(join(tmpdir(),'atz-browser-bundle-')),appBundlePath=join(root,'AgentsToZ_byCS.app'),cefPath=join(root,'cef'),helperPath=join(root,'helper');
 const put=(p:string,v:string)=>{mkdirSync(dirname(p),{recursive:true});writeFileSync(p,v);};
 put(join(appBundlePath,'Contents/Info.plist'),'<plist><dict><string>com.intenet.agentstozbycs</string><string>13.0</string></dict></plist>');put(join(appBundlePath,'Contents/MacOS/app'),'trusted host');put(join(appBundlePath,'Contents/Resources/provenance.json'),'published-source-proof');
 const sdk=join(cefPath,'156.0.7/cef_macos_aarch64'),framework=join(sdk,'Chromium Embedded Framework.framework');
 put(join(framework,'Chromium Embedded Framework'),'framework');put(join(framework,'Resources/Info.plist'),'<plist><string>156.0.7.0</string></plist>');symlinkSync('Chromium Embedded Framework',join(framework,'Binary'));put(join(sdk,'CREDITS.html'),'vendor notices');put(helperPath,'sandboxed helper');
 return {root,appBundlePath,cefPath,helperPath,version:'1000.0.0',framework};
}
test('the official bundle keeps trusted resources and provenance while staging all sandboxed Chromium helpers',()=>{
 const f=fixture();try{const before=readFileSync(join(f.appBundlePath,'Contents/Info.plist'),'utf8');const staged=stageWorkroomBrowserBundle(f);expect(staged.helperApps).toHaveLength(5);const identities=new Set<string>();for(const app of staged.helperApps){const info=readFileSync(join(app,'Contents/Info.plist'),'utf8');identities.add(info.match(/<key>CFBundleIdentifier<\/key><string>([^<]+)/)![1]!);expect(info).not.toContain('audio-input');const bin=readdirSync(join(app,'Contents/MacOS'));expect(readFileSync(join(app,'Contents/MacOS',bin[0]!), 'utf8')).toBe('sandboxed helper');}expect(identities.size).toBe(5);expect(readlinkSync(join(staged.frameworkPath,'Binary'))).toBe('Chromium Embedded Framework');expect(readFileSync(join(f.appBundlePath,'Contents/Resources/provenance.json'),'utf8')).toBe('published-source-proof');expect(readFileSync(join(f.appBundlePath,'Contents/Info.plist'),'utf8')).toBe(before);expect(readFileSync(join(f.appBundlePath,'Contents/Resources/Chromium-CREDITS.html'),'utf8')).toBe('vendor notices');}finally{rmSync(f.root,{recursive:true,force:true});}
});
test('missing or mismatched Chromium inputs fail before modifying an app',()=>{
 const f=fixture();try{writeFileSync(join(f.framework,'Resources/Info.plist'),'<plist><string>155.0.0.0</string></plist>');expect(()=>stageWorkroomBrowserBundle(f)).toThrow('SDK version');expect(existsSync(join(f.appBundlePath,'Contents/Frameworks'))).toBe(false);writeFileSync(join(f.framework,'Resources/Info.plist'),'<plist><string>156.0.7.0</string></plist>');rmSync(f.helperPath);expect(()=>stageWorkroomBrowserBundle(f)).toThrow('missing');expect(existsSync(join(f.appBundlePath,'Contents/Frameworks'))).toBe(false);}finally{rmSync(f.root,{recursive:true,force:true});}
});
test('an older macOS target cannot silently produce an embedded Chromium installation',()=>{
 const f=fixture();try{writeFileSync(join(f.appBundlePath,'Contents/Info.plist'),'<plist><string>com.intenet.agentstozbycs</string><string>10.13</string></plist>');expect(()=>stageWorkroomBrowserBundle(f)).toThrow('macOS 13');expect(existsSync(join(f.appBundlePath,'Contents/Frameworks'))).toBe(false);}finally{rmSync(f.root,{recursive:true,force:true});}
});
