import {expect,test} from 'bun:test';
import {createECDH} from 'node:crypto';
import {chmodSync,cpSync,existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync,statSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {COMMUNITY_CONFIG_INFO_KEY} from '../scripts/communityBuildConfig';
import {assertIOSCommunityBuiltBundle,executeIOSCommunityBuild,iosCommunityBuildEnvironment,iosCommunityXcodeArguments,parseIOSCommunityBuildOptions,
  prepareIOSCommunityInfoPlist,readIOSBuildPlist,type IOSCommunityBuildDependencies} from '../mobile/ios/scripts/communityBuild';

const root=resolve(import.meta.dir,'..'),commit='a'.repeat(40),team='DA8QKAQ2C9',bundle='com.intenet.agentstoz.mobile.testflight';
const key=createECDH('prime256v1');key.setPrivateKey(Buffer.from('01'.padStart(64,'0'),'hex'));
const config={origin:'https://fixture.workers.dev',issuerPublicKey:key.getPublicKey().toString('base64url'),profileId:'11111111-1111-4111-8111-111111111111'};
const push='https://notify.example.test/functions/v1/screen-push';
function plist(path:string,value:unknown){const r=Bun.spawnSync(['plutil','-convert','xml1','-o',path,'--','-'],{stdin:Buffer.from(JSON.stringify(value)),stdout:'pipe',stderr:'pipe'});if(r.exitCode!==0)throw Error('fixture plist failed');}
function xml(value:unknown){const r=Bun.spawnSync(['plutil','-convert','xml1','-o','-','--','-'],{stdin:Buffer.from(JSON.stringify(value)),stdout:'pipe',stderr:'pipe'});if(r.exitCode!==0)throw Error('fixture XML failed');return r.stdout.toString();}
function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'agentstoz-ios-community-'));chmodSync(dir,0o700);
  for(const path of ['App/Info.plist','ShareExtension/Info.plist','AgentsToZMobile.xcodeproj/project.pbxproj']){
    const out=join(dir,'mobile/ios',path);mkdirSync(resolve(out,'..'),{recursive:true,mode:0o700});cpSync(join(root,'mobile/ios',path),out);
  }
  const input=join(dir,'public.json');writeFileSync(input,JSON.stringify(config),{mode:0o600});
  return {dir,input,args:['--community-config',input,'--team',team,'--bundle',bundle],close:()=>rmSync(dir,{recursive:true,force:true})};
}
function context(f:ReturnType<typeof fixture>,overrides:{tamper?:string;sourceChange?:boolean;signature?:string;aps?:string|null;profileAPS?:string|null}={}){
  const calls:{argv:readonly string[];env:Record<string,string>}[]=[];let sourceCalls=0,pushEnabled=false;
  const deps:IOSCommunityBuildDependencies={
    source:()=>({commit:overrides.sourceChange&&sourceCalls++>0?'b'.repeat(40):commit,version:2000}),
    team:(requested)=>{expect(requested).toBe(team);return team;},now:()=>new Date('2026-11-03T00:01:02Z'),
    env:{HOME:'/fixture-home',PATH:'/fixture-path',SCREEN_COMMUNITY_QA:'1',OTHER_SWIFT_FLAGS:'-DSCREEN_COMMUNITY_QA',XCODE_XCCONFIG_FILE:'/untrusted',AGENTSTOZ_COMMUNITY_ORIGIN:'https://other.workers.dev',AGENTSTOZ_SCREEN_PUSH_URL:'https://inherited.example.test'},
    async run(argv,{env}){
      calls.push({argv,env});
      if(argv[0]==='xcodebuild'){
        const get=(name:string)=>argv.find(x=>x.startsWith(name+'='))!.slice(name.length+1);
        pushEnabled=get('AGENTSTOZ_APP_ENTITLEMENTS').includes('.push.');
        const snapshot=get('AGENTSTOZ_APP_INFO_PLIST');expect(readIOSBuildPlist(snapshot)[COMMUNITY_CONFIG_INFO_KEY]).toEqual(config);
        const output=argv[argv.indexOf('-derivedDataPath')+1]!,app=join(output,'Build/Products/Debug-iphoneos/AgentsToZMobile.app');
        mkdirSync(join(app,'PlugIns/AgentsToZShare.appex'),{recursive:true});
        const info:Record<string,unknown>={...readIOSBuildPlist(snapshot),CFBundleIdentifier:bundle,CFBundlePackageType:'APPL',CFBundleVersion:'261103000102',CFBundleShortVersionString:'2000.0.0',AgentsToZSourceCommit:commit,AgentsToZReleaseChannel:'community-device-qa',AgentsToZAppGroup:`group.${bundle}`};
        if(overrides.tamper==='config')info[COMMUNITY_CONFIG_INFO_KEY]={...config,origin:'https://other.workers.dev'};
        if(overrides.tamper==='qa')Object.assign(info,{AgentsToZScreenCommunityQA:true});
        if(overrides.tamper==='push')info.AgentsToZScreenPushURL='https://substituted.example.test';
        plist(join(app,'Info.plist'),info);
        writeFileSync(join(app,'embedded.mobileprovision'),'software CMS fixture');
        plist(join(app,'PlugIns/AgentsToZShare.appex/Info.plist'),{...readIOSBuildPlist(join(f.dir,'mobile/ios/ShareExtension/Info.plist')),CFBundleIdentifier:bundle+(overrides.tamper==='share'?'':'.share'),CFBundlePackageType:'XPC!',CFBundleVersion:'261103000102',CFBundleShortVersionString:'2000.0.0',AgentsToZAppGroup:`group.${bundle}`});
      }
      if(argv.includes('--entitlements'))return xml({'com.apple.security.application-groups':[`group.${bundle}`],...(pushEnabled&&overrides.aps!==null?{'aps-environment':overrides.aps??'development'}:{})});
      if(argv[0]==='security')return xml({Entitlements:{'application-identifier':`${team}.${bundle}`,'get-task-allow':true,'com.apple.security.application-groups':[`group.${bundle}`],...(overrides.profileAPS!==null?{'aps-environment':overrides.profileAPS??'development'}:{})}});
      return argv.includes('--display')?(overrides.signature??`Authority=Apple Development: Fixture\nTeamIdentifier=${team}\n`):'';
    },
  };
  return {deps,calls};
}

test('iOS public config is explicit and bounded; unknown, QA, duplicate, malformed and linked inputs refuse',()=>{
  const f=fixture();try{
    expect(parseIOSCommunityBuildOptions(f.args).config).toEqual(config);
    for(const extra of [['--community-qa'],['--community-config',f.input],['--install'],['--archive'],['OTHER_SWIFT_FLAGS=-DSCREEN_COMMUNITY_QA']])expect(()=>parseIOSCommunityBuildOptions([...f.args,...extra])).toThrow();
    expect(()=>parseIOSCommunityBuildOptions([])).toThrow();
    expect(()=>parseIOSCommunityBuildOptions(['--community-config','relative.json'])).toThrow();
    for(const value of [{...config,secret:'no'},{...config,pushEndpoint:push},{...config,origin:config.origin+'/'},{...config,issuerPublicKey:'A'.repeat(87)}]){
      writeFileSync(f.input,JSON.stringify(value));expect(()=>parseIOSCommunityBuildOptions(f.args)).toThrow();
    }
    writeFileSync(f.input,'{"origin":"https://evil.workers.dev",'+JSON.stringify(config).slice(1));expect(()=>parseIOSCommunityBuildOptions(f.args)).toThrow();
    writeFileSync(f.input,' '.repeat(4097));expect(()=>parseIOSCommunityBuildOptions(f.args)).toThrow();
    writeFileSync(f.input,JSON.stringify(config));const link=join(f.dir,'linked.json');symlinkSync(f.input,link);expect(()=>parseIOSCommunityBuildOptions(['--community-config',link])).toThrow();
  }finally{f.close();}
});

test('the fresh main Info snapshot is sealed before signing and preserves source, privacy and Share metadata',()=>{
  const f=fixture();try{
    const source=join(f.dir,'mobile/ios/App/Info.plist'),share=join(f.dir,'mobile/ios/ShareExtension/Info.plist'),out=join(f.dir,'App-public.plist');
    const original=readFileSync(source),shareOriginal=readFileSync(share),base=readIOSBuildPlist(source);
    prepareIOSCommunityInfoPlist(source,out,config);const actual=readIOSBuildPlist(out);
    expect(actual).toEqual({...base,AgentsToZScreenPushURL:'',[COMMUNITY_CONFIG_INFO_KEY]:config});expect(readFileSync(source)).toEqual(original);expect(readFileSync(share)).toEqual(shareOriginal);
    expect(statSync(out).mode&0o777).toBe(0o600);expect(()=>prepareIOSCommunityInfoPlist(source,out,config)).toThrow();
    for(const flag of [COMMUNITY_CONFIG_INFO_KEY,'AgentsToZScreenCommunityQA','AgentsToZCommunityQA']){const p=join(f.dir,flag+'.plist');plist(p,{...base,[flag]:true});expect(()=>prepareIOSCommunityInfoPlist(p,p+'.out',config)).toThrow();}
    const linked=join(f.dir,'linked.plist');symlinkSync(source,linked);expect(()=>prepareIOSCommunityInfoPlist(linked,linked+'.out',config)).toThrow();
  }finally{f.close();}
});

test('only the main target reads the app-specific Info setting; Share signing and App Group stay independent',()=>{
  const project=readFileSync(join(root,'mobile/ios/AgentsToZMobile.xcodeproj/project.pbxproj'),'utf8');
  const main=project.split('\n').filter(x=>x.includes('INFOPLIST_FILE = "$(AGENTSTOZ_APP_INFO_PLIST)"'));
  expect(main.length).toBe(2);expect(main.every(x=>x.includes('AGENTSTOZ_APP_INFO_PLIST = App/Info.plist;'))).toBe(true);
  const share=project.split('\n').filter(x=>x.includes('INFOPLIST_FILE = ShareExtension/Info.plist;'));expect(share.length).toBe(2);
  expect(share.every(x=>!x.includes('AGENTSTOZ_APP_INFO_PLIST')&&x.includes('CODE_SIGN_ENTITLEMENTS = ShareExtension/ShareExtension.entitlements;'))).toBe(true);
  const args=iosCommunityXcodeArguments(root,'/fixture/out','/fixture/main.plist',bundle,team,commit,2000,'261103000102');
  expect(args).toContain('AGENTSTOZ_APP_INFO_PLIST=/fixture/main.plist');expect(args).toContain(`AGENTSTOZ_APP_BUNDLE_ID=${bundle}`);
  expect(args.some(x=>x.startsWith('INFOPLIST_FILE=')||x.startsWith('PRODUCT_BUNDLE_IDENTIFIER=')||x.startsWith('CODE_SIGN_ENTITLEMENTS='))).toBe(false);
  expect(args).not.toContain('-allowProvisioningUpdates');expect(args).not.toContain('archive');expect(args.at(-1)).toBe('build');
  expect(iosCommunityBuildEnvironment({HOME:'/home',PATH:'/bin',OTHER_SWIFT_FLAGS:'QA',SCREEN_COMMUNITY_QA:'1',XCODE_XCCONFIG_FILE:'override'})).toEqual({HOME:'/home',PATH:'/bin',LANG:'en_US.UTF-8',LC_ALL:'en_US.UTF-8'});
});

test('the build-only orchestrator feeds the sealed snapshot to Xcode, then checks identity and signature without install or upload',async()=>{
  const f=fixture();try{
    const c=context(f),receipt=await executeIOSCommunityBuild(f.dir,f.args,c.deps);
    expect(receipt).toMatchObject({signed:true,communitySealedBeforeSigning:true,developmentBuildOnly:true,officialRelease:false,testFlightReady:false,installed:false,launched:false,uploaded:false,community:config});
    expect(c.calls.map(x=>x.argv[0])).toEqual(['bun','xcodebuild','codesign','codesign','codesign']);
    expect(c.calls[0]!.argv).toContain('--env-file=/dev/null');expect(c.calls.every(x=>!('OTHER_SWIFT_FLAGS'in x.env)&&!('SCREEN_COMMUNITY_QA'in x.env)&&!('XCODE_XCCONFIG_FILE'in x.env)&&!('AGENTSTOZ_SCREEN_PUSH_URL'in x.env))).toBe(true);
    expect(c.calls.flatMap(x=>x.argv).some(x=>['install','launch','upload','devicectl','notarytool','-allowProvisioningUpdates'].includes(x))).toBe(false);
    const file=join(receipt.output,'community-device-build.receipt.json');expect(existsSync(file)).toBe(true);expect(statSync(file).mode&0o777).toBe(0o600);
    assertIOSCommunityBuiltBundle(receipt.app,parseIOSCommunityBuildOptions(f.args),commit,2000,'261103000102');
    expect(receipt.pushEndpoint).toBeNull();expect(receipt.pushEnvironment).toBeNull();
  }finally{f.close();}
});

test('explicit push is separate from community trust, sealed into only Main, and requires matching development APS signature and profile',async()=>{
  const f=fixture();try{
    const args=[...f.args,'--push-endpoint',push],c=context(f),receipt=await executeIOSCommunityBuild(f.dir,args,c.deps);
    expect(receipt.pushEndpoint).toBe(push);expect(receipt.pushEnvironment).toBe('development');expect(receipt.pushEntitlementVerified).toBe(true);
    expect(receipt.community).toEqual(config);expect(readIOSBuildPlist(join(receipt.app,'Info.plist')).AgentsToZScreenPushURL).toBe(push);
    expect(readIOSBuildPlist(join(receipt.app,'PlugIns/AgentsToZShare.appex/Info.plist')).AgentsToZScreenPushURL).toBeUndefined();
    expect(c.calls.find(c=>c.argv[0]==='xcodebuild')!.argv).toContain('AGENTSTOZ_APP_ENTITLEMENTS=App/AgentsToZMobile.push.entitlements');
    expect(c.calls.some(c=>c.argv[0]==='security'&&c.argv[1]==='cms')).toBe(true);
    for(const invalid of ['',push+'?token=hidden',push+'#x','http://notify.example.test','https://user:password@notify.example.test',' '+push])expect(()=>parseIOSCommunityBuildOptions([...f.args,'--push-endpoint',invalid])).toThrow();
    expect(()=>parseIOSCommunityBuildOptions([...args,'--push-endpoint',push])).toThrow();
  }finally{f.close();}
  for(const overrides of [{tamper:'push'},{aps:null},{aps:'production'},{profileAPS:null},{profileAPS:'production'}]){
    const f=fixture();try{const c=context(f,overrides),out=join(f.dir,'build');await expect(executeIOSCommunityBuild(f.dir,[...f.args,'--push-endpoint',push,'--output',out],c.deps)).rejects.toThrow();expect(existsSync(join(out,'community-device-build.receipt.json'))).toBe(false);}
    finally{f.close();}
  }
});

test('substituted config, Share identity, QA metadata, ad-hoc signing and a changed source never receive a success receipt',async()=>{
  for(const overrides of [{tamper:'config'},{tamper:'share'},{tamper:'qa'},{signature:`Signature=adhoc\nTeamIdentifier=${team}`},{signature:'Authority=Apple Development: Fixture\nTeamIdentifier=OTHER00000'},{sourceChange:true}]){
    const f=fixture();try{
      const output=join(f.dir,'build'),c=context(f,overrides);
      await expect(executeIOSCommunityBuild(f.dir,[...f.args,'--output',output],c.deps)).rejects.toThrow();
      expect(existsSync(join(output,'community-device-build.receipt.json'))).toBe(false);
    }finally{f.close();}
  }
});

test('an existing or linked build output refuses before any build command',async()=>{
  const f=fixture();try{
    const c=context(f);await expect(executeIOSCommunityBuild(f.dir,[...f.args,'--output',f.dir],c.deps)).rejects.toThrow();expect(c.calls.length).toBe(0);
    const actual=join(f.dir,'actual');mkdirSync(actual,{mode:0o700});const link=join(f.dir,'linked');symlinkSync(actual,link);const next=join(link,'new');
    await expect(executeIOSCommunityBuild(f.dir,[...f.args,'--output',next],c.deps)).rejects.toThrow();expect(c.calls.length).toBe(0);
  }finally{f.close();}
});
