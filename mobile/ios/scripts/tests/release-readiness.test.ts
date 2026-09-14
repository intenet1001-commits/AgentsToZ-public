import {afterEach,expect,test} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,symlinkSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {assessUnsignedArchive,archiveApplicationPath,unsignedArchiveArguments,inspectUnsignedArchive,IOS_BUNDLE_ID,type ArchiveFacts} from '../ios-release-readiness';
const temporary:string[]=[];
afterEach(()=>{for(const path of temporary.splice(0))rmSync(path,{recursive:true,force:true})});
const facts=():ArchiveFacts=>({applicationPath:'Applications/AgentsToZMobile.app',archiveVersion:2,
 archiveBundleId:IOS_BUNDLE_ID,archiveMarketingVersion:'0.1.0',archiveBuildNumber:'1',bundleId:IOS_BUNDLE_ID,
 marketingVersion:'0.1.0',buildNumber:'1',executable:'AgentsToZMobile',packageType:'APPL',platform:'iphoneos',
 supportedPlatforms:['iPhoneOS'],minimumOS:'17.0',sdkName:'iphoneos26.5',hasIconName:false,hasCompiledAssets:false,
 hasPrivacyManifest:false,encryptionDeclaration:null,hasEmbeddedProvision:false,executablePresent:true,
 architectures:['arm64'],binaryPlatform:'IOS',signature:'unsigned'});

test('valid device rehearsal stays non-distributable and missing app resources are explicit gates',()=>{
 const result=assessUnsignedArchive(facts());
 expect(result.archiveValid).toBe(true);expect(result.failures).toEqual([]);
 expect(result.installable).toBe(false);expect(result.testFlightReady).toBe(false);expect(result.distributable).toBe(false);
 expect(result.releaseGates).toContain('APP_ICON_ASSET_MISSING');
 expect(result.releaseGates).toContain('REQUIRED_REASON_API_MANIFEST_ASSESSMENT_PENDING');
 expect(result.releaseGates).toContain('EXPORT_COMPLIANCE_DECLARATION_UNSET');
});
test('adding icon and privacy metadata cannot imply account, physical-device or TestFlight approval',()=>{
 const result=assessUnsignedArchive({...facts(),hasIconName:true,hasCompiledAssets:true,hasPrivacyManifest:true,encryptionDeclaration:false});
 expect(result.releaseGates).not.toContain('APP_ICON_ASSET_MISSING');
 expect(result.releaseGates).not.toContain('REQUIRED_REASON_API_MANIFEST_ASSESSMENT_PENDING');
 expect(result.releaseGates).not.toContain('EXPORT_COMPLIANCE_DECLARATION_UNSET');
 expect(result.releaseGates).toContain('APPLE_TEAM_AND_DISTRIBUTION_SIGNING_NOT_VERIFIED');
 expect(result.releaseGates).toContain('PHYSICAL_IPHONE_PERMISSIONS_AND_INSTALL_NOT_VERIFIED');
 expect(result.releaseGates).toContain('PRIVACY_POLICY_URL_AND_APP_ACCESS_NOT_VERIFIED');
 expect(result.testFlightReady).toBe(false);
});
test('simulator metadata and simulator Mach-O are both rejected even if an archive directory exists',()=>{
 expect(assessUnsignedArchive({...facts(),platform:'iphonesimulator',supportedPlatforms:['iPhoneSimulator']}).failures).toContain('DEVICE_ARCHIVE_REQUIRED');
 expect(assessUnsignedArchive({...facts(),binaryPlatform:'IOSSIMULATOR'}).failures).toContain('DEVICE_EXECUTABLE_REQUIRED');
 expect(assessUnsignedArchive({...facts(),architectures:['x86_64']}).archiveValid).toBe(false);
});
test('wrong bundle, stale manifest versions and missing executables fail the rehearsal',()=>{
 for(const patch of [{bundleId:'com.unrelated.app'},{archiveBuildNumber:'2'},{archiveMarketingVersion:'0.2.0'},
  {executablePresent:false},{signature:'unknown'},{signature:'signed'},{hasEmbeddedProvision:true}]){
  expect(assessUnsignedArchive({...facts(),...patch} as ArchiveFacts).archiveValid).toBe(false);
 }
});
test('archive path resolver rejects traversal and symbolic links without following another project',()=>{
 const dir=mkdtempSync(join(tmpdir(),'ios-archive-test-'));temporary.push(dir);
 const archive=join(dir,'fixture.xcarchive');const app=join(archive,'Products/Applications/AgentsToZMobile.app');mkdirSync(app,{recursive:true});
 expect(archiveApplicationPath(archive,'Applications/AgentsToZMobile.app')).toBe(app);
 for(const path of ['../../other.app','/Applications/AgentsToZMobile.app','Applications/../other.app','Applications/AgentsToZMobile.app/inside']){
  expect(()=>archiveApplicationPath(archive,path)).toThrow('ARCHIVE_APPLICATION_PATH_INVALID');
 }
 const outside=join(dir,'outside.app');mkdirSync(outside);writeFileSync(join(outside,'untouched'),'fixture');
 rmSync(app,{recursive:true});symlinkSync(outside,app);
 expect(()=>archiveApplicationPath(archive,'Applications/AgentsToZMobile.app')).toThrow('ARCHIVE_APPLICATION_PATH_UNSAFE');
 expect(readFileSync(join(outside,'untouched'),'utf8')).toBe('fixture');
});
test('rehearsal command suppresses signing and never performs account, export, upload or device actions',()=>{
 const args=unsignedArchiveArguments('/a project/p.xcodeproj','/private/job/a.xcarchive','/private/job/derived');
 expect(args).toContain('CODE_SIGNING_ALLOWED=NO');expect(args).toContain('CODE_SIGNING_REQUIRED=NO');expect(args).toContain('CODE_SIGN_IDENTITY=');
 expect(args.at(-1)).toBe('archive');expect(args[args.indexOf('-destination')+1]).toBe('generic/platform=iOS');
 expect(args.join(' ')).not.toMatch(/allowProvisioning|exportArchive|authenticationKey|DEVELOPMENT_TEAM|upload|devicectl/);
});
test('export remains a non-uploading review template with an unconfigured team',()=>{
 const template=readFileSync(resolve(import.meta.dir,'../ExportOptions.app-store-connect.plist.template'),'utf8');
 expect(template).toContain('<key>destination</key><string>export</string>');
 expect(template).toContain('REPLACE_WITH_APPROVED_APPLE_TEAM_ID');
 expect(template).not.toContain('<string>upload</string>');
});

test.skipIf(process.platform!=='darwin')('plausible plist labels cannot turn a non-Mach-O file into a device archive',()=>{
 const dir=mkdtempSync(join(tmpdir(),'ios-archive-parser-'));temporary.push(dir);
 const archive=join(dir,'fixture.xcarchive'),app=join(archive,'Products/Applications/AgentsToZMobile.app');mkdirSync(app,{recursive:true});
 const plist=(dictionary:string)=>'<?xml version="1.0"?><plist version="1.0"><dict>'+dictionary+'</dict></plist>';
 const strings=(values:Record<string,string>)=>Object.entries(values).map(([key,value])=>'<key>'+key+'</key><string>'+value+'</string>').join('');
 writeFileSync(join(archive,'Info.plist'),plist('<key>ArchiveVersion</key><integer>2</integer><key>ApplicationProperties</key><dict>'+strings({ApplicationPath:'Applications/AgentsToZMobile.app',CFBundleIdentifier:IOS_BUNDLE_ID,CFBundleShortVersionString:'0.1.0',CFBundleVersion:'1'})+'</dict>'));
 writeFileSync(join(app,'Info.plist'),plist(strings({CFBundleIdentifier:IOS_BUNDLE_ID,CFBundleShortVersionString:'0.1.0',CFBundleVersion:'1',CFBundleExecutable:'AgentsToZMobile',CFBundlePackageType:'APPL',DTPlatformName:'iphoneos',DTSDKName:'iphoneos26.5',MinimumOSVersion:'17.0'})+'<key>CFBundleSupportedPlatforms</key><array><string>iPhoneOS</string></array>'));
 writeFileSync(join(app,'AgentsToZMobile'),'this is a harmless fixture, not an executable');
 const result=inspectUnsignedArchive(archive);
 expect(result.archiveValid).toBe(false);expect(result.failures).toContain('DEVICE_EXECUTABLE_REQUIRED');expect(result.testFlightReady).toBe(false);
 writeFileSync(join(archive,'Info.plist'),'malformed-private-fixture-content');
 expect(()=>inspectUnsignedArchive(archive)).toThrow('ARCHIVE_PLIST_INVALID');
});
