import {cpSync,existsSync,mkdirSync,readFileSync,realpathSync,renameSync,rmSync,writeFileSync,chmodSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';

export const WORKROOM_CEF_VERSION='156.0.7';
const FRAMEWORK='Chromium Embedded Framework.framework';
const helpers=['Helper','Helper (GPU)','Helper (Renderer)','Helper (Plugin)','Helper (Alerts)'];
/** Stage only Chromium code in an already-built official app. Its Info.plist,
 * trusted UI, sidecars and release provenance remain owned by the Tauri build. */
export function stageWorkroomBrowserBundle(o:{appBundlePath:string;cefPath:string;helperPath:string;version:string}){
 if(!/^\d+\.\d+\.\d+$/.test(o.version))throw Error('Invalid browser helper version.');
 const sdk=join(o.cefPath,WORKROOM_CEF_VERSION,'cef_macos_aarch64'),framework=join(sdk,FRAMEWORK);
 for(const required of [join(o.appBundlePath,'Contents/MacOS/app'),join(framework,'Chromium Embedded Framework'),join(framework,'Resources/Info.plist'),join(sdk,'CREDITS.html'),o.helperPath])if(!existsSync(required))throw Error(`Required browser bundle input is missing: ${required}`);
 const vendor=readFileSync(join(framework,'Resources/Info.plist'),'utf8');if(!vendor.includes('<string>156.0.7.0</string>'))throw Error('Chromium SDK version does not match the compiled browser.');
 const appInfo=readFileSync(join(o.appBundlePath,'Contents/Info.plist'),'utf8');if(!appInfo.includes('<string>com.intenet.agentstozbycs</string>')||!appInfo.includes('<string>13.0</string>'))throw Error('Embedded Chromium requires the official app identity and macOS 13 minimum.');
 const dest=join(o.appBundlePath,'Contents/Frameworks');mkdirSync(dest,{recursive:true});const staging=join(dest,`.workroom-browser-stage-${randomUUID()}`);mkdirSync(staging);
 try{
  cpSync(realpathSync(framework),join(staging,FRAMEWORK),{recursive:true,dereference:false,verbatimSymlinks:true});
  for(const variant of helpers){const name=`app ${variant}`,contents=join(staging,`${name}.app/Contents`);mkdirSync(join(contents,'MacOS'),{recursive:true});cpSync(o.helperPath,join(contents,'MacOS',name));chmodSync(join(contents,'MacOS',name),0o755);
   const suffix=variant.toLowerCase().replace(/[^a-z]+/g,'-').replace(/-$/,'');
   writeFileSync(join(contents,'Info.plist'),`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>${name}</string>
<key>CFBundleIdentifier</key><string>com.intenet.agentstozbycs.browser.${suffix}</string>
<key>CFBundleName</key><string>${name}</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>${o.version}</string>
<key>CFBundleShortVersionString</key><string>${o.version}</string>
<key>LSMinimumSystemVersion</key><string>13.0</string>
<key>LSUIElement</key><true/>
<key>LSEnvironment</key><dict><key>MallocNanoZone</key><string>0</string></dict>
</dict></plist>`);
  }
  for(const name of [FRAMEWORK,...helpers.map(h=>`app ${h}.app`)]){rmSync(join(dest,name),{recursive:true,force:true});renameSync(join(staging,name),join(dest,name));}
  const resources=join(o.appBundlePath,'Contents/Resources');mkdirSync(resources,{recursive:true});cpSync(join(sdk,'CREDITS.html'),join(resources,'Chromium-CREDITS.html'));
  writeFileSync(join(resources,'workroom-browser.json'),JSON.stringify({schemaVersion:1,cef:WORKROOM_CEF_VERSION,architecture:'arm64',minimumSystemVersion:'13.0',sandbox:true},null,2));
  return {frameworkPath:join(dest,FRAMEWORK),helperApps:helpers.map(h=>join(dest,`app ${h}.app`))};
 }finally{rmSync(staging,{recursive:true,force:true});}
}
