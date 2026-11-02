import {constants, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, closeSync, fstatSync, readSync, realpathSync, writeFileSync} from 'node:fs';
import {basename, dirname, isAbsolute, join, resolve} from 'node:path';
import {COMMUNITY_CONFIG_INFO_KEY, readCommunityBuildConfig, serializeCommunityBuildConfig, type CommunityBuildConfig} from '../../../scripts/communityBuildConfig';
import {assertSealedCommunityBuildConfig, sealMainCommunityBuildConfig} from '../../../scripts/mainCommunityBuildConfig';
import {screenPushEndpoint} from '../../../scripts/screenPushEndpoint';

export type IOSCommunityBuildOptions = Readonly<{config:CommunityBuildConfig; team?:string; bundleId:string; output?:string;pushEndpoint?:string}>;
const bundles = new Set(['com.intenet.agentstoz.mobile', 'com.intenet.agentstoz.mobile.dev', 'com.intenet.agentstoz.mobile.testflight']);
function fail(code:string):never {throw Error(code);}

/** A build-only development artifact. This command has no install, launch, account-update or upload mode. */
export function parseIOSCommunityBuildOptions(args:readonly string[]):IOSCommunityBuildOptions {
  const values = new Map<string,string>();
  for (let i=0;i<args.length;i++) {
    const flag=args[i]!, value=args[++i];
    if (!['--community-config','--team','--bundle','--output','--push-endpoint'].includes(flag) || values.has(flag) || !value || value.startsWith('--')) fail('IOS_COMMUNITY_BUILD_OPTIONS');
    values.set(flag,value);
  }
  const input=values.get('--community-config');
  if (!input || !isAbsolute(input)) fail('IOS_COMMUNITY_CONFIG_REQUIRED');
  const team=values.get('--team'), bundleId=values.get('--bundle')??'com.intenet.agentstoz.mobile', output=values.get('--output');
  if (team!==undefined && !/^[A-Z0-9]{10}$/.test(team)) fail('IOS_COMMUNITY_TEAM');
  if (!bundles.has(bundleId)) fail('IOS_COMMUNITY_BUNDLE');
  if (output!==undefined && (!isAbsolute(output) || resolve(output)!==output || basename(output)==='.' || basename(output)==='..')) fail('IOS_COMMUNITY_OUTPUT');
  let pushEndpoint:string|undefined;
  if(values.has('--push-endpoint')){
    const value=values.get('--push-endpoint')!;
    try{const parsed=screenPushEndpoint(value);if(!parsed||parsed!==value)fail('IOS_COMMUNITY_PUSH_ENDPOINT');pushEndpoint=parsed;}
    catch{fail('IOS_COMMUNITY_PUSH_ENDPOINT');}
  }
  return Object.freeze({config:readCommunityBuildConfig(input),bundleId,...(team?{team}:{}),...(output?{output}:{}),...(pushEndpoint?{pushEndpoint}:{})});
}

/** Xcode receives no inherited Swift flags, signing overrides, community settings or runtime credentials. */
export function iosCommunityBuildEnvironment(inherited:NodeJS.ProcessEnv):Record<string,string> {
  const env:Record<string,string>={LANG:'en_US.UTF-8',LC_ALL:'en_US.UTF-8'};
  for (const key of ['HOME','PATH','TMPDIR','DEVELOPER_DIR','SDKROOT','CARGO_HOME','RUSTUP_HOME']) if (inherited[key]) env[key]=inherited[key]!;
  return env;
}

function readRegular(path:string):Buffer {
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try {
    const s=fstatSync(fd);if(!s.isFile()||s.size>1_048_576)fail('IOS_COMMUNITY_PLIST');
    const bytes=Buffer.alloc(1_048_577);let size=0;
    while(size<bytes.length){const n=readSync(fd,bytes,size,bytes.length-size,null);if(!n)break;size+=n;}
    if(size>1_048_576)fail('IOS_COMMUNITY_PLIST');return bytes.subarray(0,size);
  }
  finally {closeSync(fd);}
}

function plistFromBytes(bytes:Buffer):Record<string,unknown> {
  const result=Bun.spawnSync(['/usr/bin/plutil','-convert','json','-o','-','--','-'],{stdin:bytes,stdout:'pipe',stderr:'pipe'});
  if(result.exitCode!==0)fail('IOS_COMMUNITY_PLIST');
  const value:unknown=JSON.parse(result.stdout.toString());
  if(!value||typeof value!=='object'||Array.isArray(value))fail('IOS_COMMUNITY_PLIST');
  return value as Record<string,unknown>;
}
export function readIOSBuildPlist(path:string):Record<string,unknown> {return plistFromBytes(readRegular(path));}

/** Copy the original once; neither the checked-in plist nor a previously signed app is modified. */
export function prepareIOSCommunityInfoPlist(source:string,destination:string,config:CommunityBuildConfig,pushEndpoint?:string):void {
  if(!isAbsolute(source)||!isAbsolute(destination)||resolve(source)===resolve(destination)||existsSync(destination))fail('IOS_COMMUNITY_SNAPSHOT');
  const original=readRegular(source),info=plistFromBytes(original);
  if(Object.hasOwn(info,COMMUNITY_CONFIG_INFO_KEY)||Object.hasOwn(info,'AgentsToZScreenCommunityQA')||Object.hasOwn(info,'AgentsToZCommunityQA'))fail('IOS_COMMUNITY_QA_OR_SEALED_SOURCE');
  writeFileSync(destination,original,{mode:0o600,flag:'wx'});
  sealMainCommunityBuildConfig(destination,config);
  // Always resolve the original build-setting placeholder explicitly. Absent selection remains off.
  const selected=pushEndpoint===undefined?'':screenPushEndpoint(pushEndpoint);
  if(selected===null||pushEndpoint!==undefined&&selected!==pushEndpoint)fail('IOS_COMMUNITY_PUSH_ENDPOINT');
  const pushed=Bun.spawnSync(['/usr/bin/plutil',Object.hasOwn(info,'AgentsToZScreenPushURL')?'-replace':'-insert','AgentsToZScreenPushURL','-string',selected,destination],{stdin:'ignore',stdout:'pipe',stderr:'pipe'});
  if(pushed.exitCode!==0||readIOSBuildPlist(destination).AgentsToZScreenPushURL!==selected)fail('IOS_COMMUNITY_PUSH_SEAL');
  assertSealedCommunityBuildConfig(destination,config);
}

function privateDirectory(path:string):void {
  const s=lstatSync(path);
  if(!s.isDirectory()||s.isSymbolicLink()||(process.getuid&&s.uid!==process.getuid())||(s.mode&0o022)!==0)fail('IOS_COMMUNITY_OUTPUT');
}
function outputDirectory(root:string,requested?:string):string {
  if(requested){if(existsSync(requested))fail('IOS_COMMUNITY_OUTPUT_EXISTS');privateDirectory(dirname(requested));mkdirSync(requested,{mode:0o700});return realpathSync(requested);}
  const base=join(root,'mobile/ios/build/community-device-qa');mkdirSync(base,{recursive:true,mode:0o700});privateDirectory(base);
  return mkdtempSync(join(base,'run-'));
}

export function iosCommunityXcodeArguments(root:string,output:string,info:string,bundleId:string,team:string,source:string,version:number,buildId:string,pushEnabled=false):string[] {
  if(!bundles.has(bundleId)||!/^[A-Z0-9]{10}$/.test(team)||!/^[0-9a-f]{40}$/.test(source)||!Number.isSafeInteger(version)||version<1||!/^\d{12}$/.test(buildId))fail('IOS_COMMUNITY_BUILD_IDENTITY');
  return ['xcodebuild','-project',join(root,'mobile/ios/AgentsToZMobile.xcodeproj'),'-scheme','AgentsToZMobile',
    '-configuration','Debug','-destination','generic/platform=iOS','-derivedDataPath',join(output,'DerivedData'),
    '-disableAutomaticPackageResolution',`AGENTSTOZ_APP_INFO_PLIST=${info}`,`AGENTSTOZ_APP_BUNDLE_ID=${bundleId}`,
    `AGENTSTOZ_APP_ENTITLEMENTS=App/AgentsToZMobile${pushEnabled?'.push':''}.entitlements`,
    `DEVELOPMENT_TEAM=${team}`,'CODE_SIGN_STYLE=Automatic','CODE_SIGNING_ALLOWED=YES','CODE_SIGN_IDENTITY=Apple Development',
    'AGENTSTOZ_RELEASE_CHANNEL=community-device-qa',`AGENTSTOZ_SOURCE_COMMIT=${source}`,`MARKETING_VERSION=${version}.0.0`,
    `CURRENT_PROJECT_VERSION=${buildId}`,'build'];
}

/** Public signature/profile metadata only. A URL is not proof that APNs is available. */
export function assertIOSCommunityPushEntitlements(xml:string,bundleId:string,enabled:boolean):void {
  if(Buffer.byteLength(xml)>1_048_576)fail('IOS_COMMUNITY_PUSH_ENTITLEMENT');
  const matches=[...xml.matchAll(/<plist\b[^>]*>[\s\S]*?<\/plist>/g)];
  if(matches.length!==1)fail('IOS_COMMUNITY_PUSH_ENTITLEMENT');
  const info=plistFromBytes(Buffer.from(matches[0]![0]));
  if(JSON.stringify(info['com.apple.security.application-groups'])!==JSON.stringify([`group.${bundleId}`])
    ||enabled&&info['aps-environment']!=='development'||!enabled&&Object.hasOwn(info,'aps-environment'))fail('IOS_COMMUNITY_PUSH_ENTITLEMENT');
}
export function assertIOSCommunityPushProfile(xml:string,team:string,bundleId:string):void {
  if(Buffer.byteLength(xml)>1_048_576)fail('IOS_COMMUNITY_PUSH_PROFILE');
  const result=Bun.spawnSync(['/usr/bin/plutil','-extract','Entitlements','json','-o','-','--','-'],{stdin:Buffer.from(xml),stdout:'pipe',stderr:'pipe'});
  if(result.exitCode!==0)fail('IOS_COMMUNITY_PUSH_PROFILE');
  const info=JSON.parse(result.stdout.toString()) as Record<string,unknown>;
  if(!info||info['application-identifier']!==`${team}.${bundleId}`||info['get-task-allow']!==true||info['aps-environment']!=='development'
    ||JSON.stringify(info['com.apple.security.application-groups'])!==JSON.stringify([`group.${bundleId}`]))fail('IOS_COMMUNITY_PUSH_PROFILE');
}

export function assertIOSCommunityBuiltBundle(app:string,options:IOSCommunityBuildOptions,source:string,version:number,buildId:string):void {
  const infoPath=join(app,'Info.plist'),info=readIOSBuildPlist(infoPath),share=readIOSBuildPlist(join(app,'PlugIns/AgentsToZShare.appex/Info.plist'));
  assertSealedCommunityBuildConfig(infoPath,options.config);
  if(info.AgentsToZScreenPushURL!==(options.pushEndpoint??'')||Object.hasOwn(share,'AgentsToZScreenPushURL'))fail('IOS_COMMUNITY_PUSH_SEAL');
  for(const key of ['AgentsToZScreenCommunityQA','AgentsToZCommunityQA']) if(Object.hasOwn(info,key)||Object.hasOwn(share,key))fail('IOS_COMMUNITY_QA_BUNDLE');
  if(info.CFBundleIdentifier!==options.bundleId||info.CFBundlePackageType!=='APPL'||info.AgentsToZSourceCommit!==source
    ||info.AgentsToZReleaseChannel!=='community-device-qa'||info.CFBundleShortVersionString!==`${version}.0.0`||info.CFBundleVersion!==buildId
    ||info.AgentsToZAppGroup!==`group.${options.bundleId}`||share.CFBundleIdentifier!==`${options.bundleId}.share`
    ||share.CFBundlePackageType!=='XPC!'||share.AgentsToZAppGroup!==`group.${options.bundleId}`
    ||share.CFBundleShortVersionString!==`${version}.0.0`||share.CFBundleVersion!==buildId||Object.hasOwn(share,COMMUNITY_CONFIG_INFO_KEY))fail('IOS_COMMUNITY_BUNDLE_IDENTITY');
}

export interface IOSCommunityBuildDependencies {
  source():{commit:string;version:number};
  team(requested?:string):string;
  run(argv:readonly string[],context:{cwd:string;env:Record<string,string>;log?:string}):Promise<string>;
  now():Date;
  env:NodeJS.ProcessEnv;
}

export async function executeIOSCommunityBuild(root:string,args:readonly string[],deps:IOSCommunityBuildDependencies) {
  const options=parseIOSCommunityBuildOptions(args),source=deps.source();
  if(!/^[0-9a-f]{40}$/.test(source.commit)||!Number.isSafeInteger(source.version)||source.version<1)fail('IOS_COMMUNITY_SOURCE');
  const project=readRegular(join(root,'mobile/ios/AgentsToZMobile.xcodeproj/project.pbxproj')).toString();
  if(project.includes('SCREEN_COMMUNITY_QA')||!project.includes('INFOPLIST_FILE = "$(AGENTSTOZ_APP_INFO_PLIST)";'))fail('IOS_COMMUNITY_BUILD_CONFIGURATION');
  const team=deps.team(options.team),env=iosCommunityBuildEnvironment(deps.env),output=outputDirectory(root,options.output);
  const snapshot=join(output,'App-Info.public-community.plist');
  prepareIOSCommunityInfoPlist(join(root,'mobile/ios/App/Info.plist'),snapshot,options.config,options.pushEndpoint);
  const timestamp=deps.now();if(!Number.isFinite(timestamp.getTime()))fail('IOS_COMMUNITY_BUILD_TIME');
  const buildId=timestamp.toISOString().replace(/[-:T]/g,'').slice(2,14);
  await deps.run(['bun','--env-file=/dev/null',join(root,'mobile/ios/scripts/build-portal-web.ts')],{cwd:root,env,log:join(output,'portal-build.log')});
  const plan=iosCommunityXcodeArguments(root,output,snapshot,options.bundleId,team,source.commit,source.version,buildId,options.pushEndpoint!==undefined);
  await deps.run(plan,{cwd:root,env,log:join(output,'device-build.log')});
  const app=join(output,'DerivedData/Build/Products/Debug-iphoneos/AgentsToZMobile.app');
  assertIOSCommunityBuiltBundle(app,options,source.commit,source.version,buildId);
  await deps.run(['codesign','--verify','--deep','--strict',app],{cwd:root,env});
  const signature=await deps.run(['codesign','--display','--verbose=4',app],{cwd:root,env});
  if(!signature.split(/\r?\n/).includes(`TeamIdentifier=${team}`)||!/^Authority=Apple Development:/m.test(signature)||/^Signature=adhoc$/m.test(signature))fail('IOS_COMMUNITY_DEVELOPMENT_SIGNATURE');
  const entitlements=await deps.run(['codesign','--display','--entitlements','-','--xml',app],{cwd:root,env});
  assertIOSCommunityPushEntitlements(entitlements,options.bundleId,options.pushEndpoint!==undefined);
  if(options.pushEndpoint){
    const profile=join(app,'embedded.mobileprovision');readRegular(profile);
    assertIOSCommunityPushProfile(await deps.run(['security','cms','-D','-i',profile],{cwd:root,env}),team,options.bundleId);
  }
  // A failed or changed build cannot leave a success receipt. Recheck after public-signature verification.
  assertIOSCommunityBuiltBundle(app,options,source.commit,source.version,buildId);
  const current=deps.source();if(current.commit!==source.commit||current.version!==source.version)fail('IOS_COMMUNITY_SOURCE_CHANGED');
  const receipt=Object.freeze({app,output,sourceCommit:source.commit,version:`${source.version}.0.0`,buildId,bundleId:options.bundleId,team,
    community:JSON.parse(serializeCommunityBuildConfig(options.config)) as CommunityBuildConfig,pushEndpoint:options.pushEndpoint??null,
    pushEntitlementVerified:true,pushEnvironment:options.pushEndpoint?'development':null,
    signed:true,communitySealedBeforeSigning:true,developmentBuildOnly:true,officialRelease:false,testFlightReady:false,installed:false,launched:false,uploaded:false});
  writeFileSync(join(output,'community-device-build.receipt.json'),JSON.stringify(receipt,null,2)+'\n',{mode:0o600,flag:'wx'});
  return receipt;
}
