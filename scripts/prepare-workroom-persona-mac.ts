/** Builds a disposable Mac WKWebView app; opening it is a separate native UI action. */
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
const root=resolve(import.meta.dir,'..'),state=process.argv[2];if(!state)throw Error('Expected an owned persona host state path');
const config=JSON.parse(readFileSync(state,'utf8')),url=new URL(config.macUrl);if(url.hostname!=='127.0.0.1'||url.port==='3001'||url.pathname!=='/remote/')throw Error('Only an isolated loopback fixture is allowed');
const temp=mkdtempSync('/private/tmp/workroom-persona-mac-'),app=join(temp,'AgentsToZ Workroom Persona.app'),contents=join(app,'Contents'),resources=join(contents,'Resources');mkdirSync(resources,{recursive:true});mkdirSync(join(contents,'MacOS'));
const processHandle=Bun.spawn(['xcrun','swiftc','-parse-as-library',join(root,'scripts/fixtures/WorkroomPersonaMac.swift'),'-o',join(contents,'MacOS/WorkroomPersonaMac')],{stdout:'pipe',stderr:'pipe'});
const [code,errors]=await Promise.all([processHandle.exited,new Response(processHandle.stderr).text()]);if(code)throw Error(errors);
writeFileSync(join(contents,'Info.plist'),'<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.intenet.agentstoz.persona.mac.fixture</string><key>CFBundleName</key><string>AgentsToZ Workroom Persona</string><key>CFBundleExecutable</key><string>WorkroomPersonaMac</string><key>CFBundlePackageType</key><string>APPL</string><key>NSAppTransportSecurity</key><dict><key>NSAllowsArbitraryLoadsInWebContent</key><true/></dict></dict></plist>');
writeFileSync(join(resources,'bootstrap.json'),JSON.stringify({url:config.macUrl,evidence:join(root,'mobile/ios/build/workroom-persona-device/mac'),sourceFingerprint:config.manifest.bundleHash}),{mode:0o600});
console.log(app);
