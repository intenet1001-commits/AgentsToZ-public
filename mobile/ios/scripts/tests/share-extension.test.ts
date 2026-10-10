import {expect,test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';

// The share extension ("AgentsToZ VOC") is wired by hand into a hand-written project file.
// These checks read the committed sources only; they do not build or sign anything.
const ios=resolve(import.meta.dir,'../..');
const read=(path:string)=>readFileSync(resolve(ios,path),'utf8');
const project=read('AgentsToZMobile.xcodeproj/project.pbxproj');
const plist=(path:string)=>{
  const child=Bun.spawnSync(['plutil','-convert','json','-o','-',resolve(ios,path)],{stdout:'pipe',stderr:'pipe'});
  if(child.exitCode!==0)throw Error('plist unreadable: '+path);
  return JSON.parse(new TextDecoder().decode(child.stdout)) as Record<string,any>;
};
/** Every object in this project file sits on one line: `<ID> = { isa = …; };`. */
const object=(id:string)=>{
  const line=project.split('\n').find(row=>row.startsWith(id+' = {'));
  if(!line)throw Error('missing object '+id);
  return line;
};
const field=(line:string,name:string)=>line.match(new RegExp(`\\b${name} = (\\([^)]*\\)|"[^"]*"|[^;]+);`))?.[1];
const list=(value:string|undefined)=>(value??'').replace(/[()]/g,'').split(',').map(v=>v.trim()).filter(Boolean);
const targets=project.split('\n').filter(row=>row.includes('isa = PBXNativeTarget;'));
const target=(name:string)=>{
  const line=targets.find(row=>field(row,'name')===name);
  if(!line)throw Error('missing target '+name);
  return {id:line.slice(0,24),line};
};
const configs=(targetLine:string)=>list(field(object(field(targetLine,'buildConfigurationList')!),'buildConfigurations')).map(object);

test('the share extension is its own app-extension target, embedded in the app with a build dependency',()=>{
  const app=target('AgentsToZMobile'),share=target('AgentsToZShare');
  expect(field(share.line,'productType')).toBe('"com.apple.product-type.app-extension"');
  expect(object(field(share.line,'productReference')!)).toContain('path = AgentsToZShare.appex;');
  expect(list(field(object(field(project,'rootObject')??'244210E48437B6556980A702'),'targets'))).toContain(share.id);
  const embed=list(field(app.line,'buildPhases')).map(object).find(row=>row.includes('isa = PBXCopyFilesBuildPhase;'));
  expect(embed).toBeDefined();
  expect(field(embed!,'name')).toBe('"Embed Foundation Extensions"');
  expect(field(embed!,'dstSubfolderSpec')).toBe('13'); // PlugIns
  const embedded=list(field(embed!,'files')).map(object);
  expect(embedded.some(row=>field(row,'fileRef')===field(share.line,'productReference'))).toBe(true);
  const dependencies=list(field(app.line,'dependencies')).map(object);
  expect(dependencies.some(row=>field(row,'target')===share.id)).toBe(true);
  // The extension links the same Foundation-only core that owns the outbox format.
  expect(list(field(share.line,'packageProductDependencies')).map(object).every(row=>row.includes('productName = AgentsToZCore;'))).toBe(true);
});

test('the extension id and App Group follow the app bundle setting, so dev, UI-test and release never collide',()=>{
  const app=target('AgentsToZMobile'),share=target('AgentsToZShare');
  for(const config of configs(share.line)){
    expect(field(config,'PRODUCT_BUNDLE_IDENTIFIER')).toBe('"$(AGENTSTOZ_APP_BUNDLE_ID).share"');
    expect(field(config,'CODE_SIGN_ENTITLEMENTS')).toBe('ShareExtension/ShareExtension.entitlements');
    expect(field(config,'CODE_SIGN_STYLE')).toBe('Automatic');
    expect(field(config,'INFOPLIST_FILE')).toBe('ShareExtension/Info.plist');
    expect(field(config,'APPLICATION_EXTENSION_API_ONLY')).toBe('YES');
    // Same deployment target, team and versions as the app: inherited, never overridden here.
    for(const inherited of ['IPHONEOS_DEPLOYMENT_TARGET','DEVELOPMENT_TEAM','CURRENT_PROJECT_VERSION','MARKETING_VERSION','AGENTSTOZ_APP_BUNDLE_ID'])
      expect(field(config,inherited)).toBeUndefined();
  }
  for(const config of configs(app.line)){
    expect(field(config,'PRODUCT_BUNDLE_IDENTIFIER')).toBe('"$(AGENTSTOZ_APP_BUNDLE_ID)"');
    expect(field(config,'CODE_SIGN_ENTITLEMENTS')).toBe('App/AgentsToZMobile.entitlements');
  }
  for(const path of ['App/AgentsToZMobile.entitlements','ShareExtension/ShareExtension.entitlements'])
    expect(plist(path)['com.apple.security.application-groups']).toEqual(['group.$(AGENTSTOZ_APP_BUNDLE_ID)']);
  // Automatic signing only enables App Groups on the App ID when the target declares the capability.
  for(const id of [app.id,share.id])
    expect(project).toMatch(new RegExp(`${id} = \\{ SystemCapabilities = \\{ com\\.apple\\.ApplicationGroups\\.iOS = \\{ enabled = 1; \\}; \\}; \\};`));
  // Both bundles read the group name from their Info.plist; they must name the same one.
  expect(plist('App/Info.plist').AgentsToZAppGroup).toBe('group.$(AGENTSTOZ_APP_BUNDLE_ID)');
  expect(plist('ShareExtension/Info.plist').AgentsToZAppGroup).toBe('group.$(AGENTSTOZ_APP_BUNDLE_ID)');
  // A global PRODUCT_BUNDLE_IDENTIFIER would give the embedded extension the app's own id.
  const install=read('scripts/install-development.ts');
  expect(install).toContain('`AGENTSTOZ_APP_BUNDLE_ID=${bundleId}`');
  expect(install).not.toContain('`PRODUCT_BUNDLE_IDENTIFIER=');
});

test('the extension appears only for 1-5 images in the share sheet and is named AgentsToZ VOC',()=>{
  const info=plist('ShareExtension/Info.plist');
  expect(info.CFBundleDisplayName).toBe('AgentsToZ VOC');
  expect(info.NSExtension.NSExtensionPointIdentifier).toBe('com.apple.share-services');
  expect(info.NSExtension.NSExtensionPrincipalClass).toBe('$(PRODUCT_MODULE_NAME).ShareViewController');
  expect(info.NSExtension.NSExtensionAttributes.NSExtensionActivationRule).toEqual({NSExtensionActivationSupportsImageWithMaxCount:5});
  expect(plist('ShareExtension/PrivacyInfo.xcprivacy').NSPrivacyTracking).toBe(false);
  expect(project).toMatch(/path = ShareExtension; sourceTree = "<group>"; children = \([^)]*\);/);
});

test('the extension only files photos; it never sends them or opens the app',()=>{
  const source=read('ShareExtension/ShareViewController.swift');
  for(const forbidden of ['openURL','URLSession','import WebKit','.open(','selector(','responder'])
    expect(source).not.toContain(forbidden);
  expect(source).toContain('VocShareOutbox.shared()');
  expect(source).toContain('kCGImageSourceCreateThumbnailWithTransform');
});

test('the portal bridge is limited to portal pages and hands items over as JSON, one ack at a time',()=>{
  const view=read('App/LANWorkroomView.swift');
  const portalOnly=view.slice(view.indexOf('if origin.hasPrefix("https://") || bundled != nil {'));
  const block=portalOnly.slice(0,portalOnly.indexOf('\n        }\n'));
  expect(block).toContain(`name: "agentstozVocShare"`);
  expect(block).toContain(`Object.defineProperty(window,'agentstozNativeVocShare',{value:true,writable:false});`);
  expect(view.match(/agentstozNativeVocShare/g)).toHaveLength(1);
  expect(view).toContain(`new CustomEvent('agentstoz-voc-share',{detail:" + json + "})`);
  expect(view).toContain('message.frameInfo.isMainFrame, pageOriginMatches(message.frameInfo.securityOrigin)');
  expect(view).toContain('JSONSerialization.data(withJSONObject: detail)');
  expect(view).toContain('static let vocShareAckTimeout: Duration = .seconds(30)');
  const outbox=readFileSync(resolve(ios,'AgentsToZCore/Sources/AgentsToZCore/VocShareOutbox.swift'),'utf8');
  expect(outbox).toContain('["id": item.id, "createdAt": item.createdAt, "comment": item.comment, "images": images]');
  expect(outbox).toContain('["name": pair.entry.file, "mime": pair.entry.mime, "dataBase64": pair.data.base64EncodedString()]');
  expect(read('App/RemoteHomeView.swift')).toContain('Mac에 연결하면 VOC 작성 화면에 담깁니다.');
});

test('the Workroom fixture compiles the production bundled-portal scheme handler with its view',()=>{
  const fixture=read('scripts/check-workroom.ts');
  const compile=fixture.slice(fixture.indexOf("await command(['xcrun','swiftc','-parse-as-library','-target'"));
  expect(compile).toContain("join(root,'mobile/ios/App/PortalSchemeHandler.swift')");
  expect(compile.indexOf('PortalSchemeHandler.swift')).toBeLessThan(compile.indexOf('LANWorkroomView.swift'));
});
