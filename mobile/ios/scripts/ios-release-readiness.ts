import {lstatSync, realpathSync, existsSync} from 'node:fs';
import {resolve, join, sep} from 'node:path';

export const IOS_BUNDLE_ID = 'com.intenet.agentstoz.mobile';
export interface ArchiveFacts {
  applicationPath: string;
  archiveVersion: unknown;
  archiveBundleId: unknown;
  archiveMarketingVersion: unknown;
  archiveBuildNumber: unknown;
  bundleId: unknown;
  marketingVersion: unknown;
  buildNumber: unknown;
  executable: unknown;
  packageType: unknown;
  platform: unknown;
  supportedPlatforms: unknown;
  minimumOS: unknown;
  sdkName: unknown;
  hasIconName: boolean;
  hasCompiledAssets: boolean;
  hasPrivacyManifest: boolean;
  encryptionDeclaration: unknown;
  hasEmbeddedProvision: boolean;
  executablePresent: boolean;
  architectures: string[];
  binaryPlatform: string;
  signature: 'unsigned' | 'signed' | 'unknown';
}

export function assessUnsignedArchive(facts: ArchiveFacts) {
  const failures: string[] = [];
  if(facts.archiveVersion !== 2) failures.push('ARCHIVE_FORMAT_UNEXPECTED');
  if(facts.bundleId !== IOS_BUNDLE_ID || facts.archiveBundleId !== facts.bundleId) failures.push('BUNDLE_ID_MISMATCH');
  if(typeof facts.marketingVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(facts.marketingVersion)
    || facts.archiveMarketingVersion !== facts.marketingVersion) failures.push('MARKETING_VERSION_INVALID');
  if(typeof facts.buildNumber !== 'string' || !/^\d+(\.\d+){0,2}$/.test(facts.buildNumber)
    || facts.archiveBuildNumber !== facts.buildNumber) failures.push('BUILD_NUMBER_INVALID');
  if(facts.platform !== 'iphoneos' || !Array.isArray(facts.supportedPlatforms)
    || facts.supportedPlatforms.length !== 1 || facts.supportedPlatforms[0] !== 'iPhoneOS') failures.push('DEVICE_ARCHIVE_REQUIRED');
  if(facts.architectures.length !== 1 || facts.architectures[0] !== 'arm64' || facts.binaryPlatform !== 'IOS') failures.push('DEVICE_EXECUTABLE_REQUIRED');
  if(facts.packageType !== 'APPL' || typeof facts.executable !== 'string'
    || !/^[A-Za-z0-9_-]+$/.test(facts.executable) || !facts.executablePresent) failures.push('APP_EXECUTABLE_MISSING');
  if(typeof facts.sdkName !== 'string' || !/^iphoneos\d+(\.\d+)*$/.test(facts.sdkName)) failures.push('IPHONE_SDK_UNVERIFIED');
  if(typeof facts.minimumOS !== 'string' || !/^\d+(\.\d+)*$/.test(facts.minimumOS)) failures.push('MINIMUM_OS_UNVERIFIED');
  if(facts.signature !== 'unsigned') failures.push('EXPECTED_UNSIGNED_ARCHIVE');
  if(facts.hasEmbeddedProvision) failures.push('UNEXPECTED_PROVISIONING_PROFILE');
  const releaseGates = [
    'UNSIGNED_NOT_INSTALLABLE_OR_DISTRIBUTABLE',
    'APPLE_TEAM_AND_DISTRIBUTION_SIGNING_NOT_VERIFIED',
    'APP_STORE_CONNECT_RECORD_AND_UNIQUE_BUILD_NOT_VERIFIED',
    'PHYSICAL_IPHONE_PERMISSIONS_AND_INSTALL_NOT_VERIFIED',
    'PRIVACY_POLICY_URL_AND_APP_ACCESS_NOT_VERIFIED',
    'APP_PRIVACY_AND_ENCRYPTION_CLASSIFICATION_NOT_APPROVED',
    'EXTERNAL_BETA_REVIEW_ACCESS_NOT_PREPARED',
  ];
  if(!facts.hasIconName || !facts.hasCompiledAssets) releaseGates.push('APP_ICON_ASSET_MISSING');
  if(!facts.hasPrivacyManifest) releaseGates.push('REQUIRED_REASON_API_MANIFEST_ASSESSMENT_PENDING');
  if(facts.encryptionDeclaration === null || facts.encryptionDeclaration === undefined) releaseGates.push('EXPORT_COMPLIANCE_DECLARATION_UNSET');
  return {
    purpose: 'unsigned-device-archive-rehearsal' as const,
    archiveValid: failures.length === 0, installable: false, testFlightReady: false, distributable: false,
    failures, releaseGates, facts,
  };
}

/** Rehearsal has no account, provisioning-update, export, upload or installation flags. */
export function unsignedArchiveArguments(project: string, archive: string, derived: string): string[] {
  return ['xcodebuild','-project',project,'-scheme','AgentsToZMobile','-configuration','Release',
    '-destination','generic/platform=iOS','-archivePath',archive,'-derivedDataPath',derived,
    'CODE_SIGNING_ALLOWED=NO','CODE_SIGNING_REQUIRED=NO','CODE_SIGN_IDENTITY=', 'archive'];
}

function regular(path: string) { return lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink(); }
function directory(path: string) { return lstatSync(path).isDirectory() && !lstatSync(path).isSymbolicLink(); }
export function archiveApplicationPath(archive: string, applicationPath: unknown): string {
  if(typeof applicationPath !== 'string' || !/^Applications\/[A-Za-z0-9_-]+\.app$/.test(applicationPath)) throw Error('ARCHIVE_APPLICATION_PATH_INVALID');
  const products = join(archive,'Products');
  const app = join(products,applicationPath);
  if(!directory(products) || !directory(join(products,'Applications')) || !directory(app)
    || !realpathSync(app).startsWith(realpathSync(products)+sep)) throw Error('ARCHIVE_APPLICATION_PATH_UNSAFE');
  return app;
}

function metadata(path: string, kind: 'archive' | 'app'): Record<string,unknown> {
  if(!regular(path)) throw Error('ARCHIVE_PLIST_UNSAFE');
  // Apple's binary archive plist may contain dates; Python's standard plistlib
  // reads that format without relying on third-party plist packages or credentials.
  const script = `import json,plistlib,sys\np=plistlib.load(open(sys.argv[1],'rb'))\na=p.get('ApplicationProperties',{})\nif sys.argv[2]=='archive':\n r={'applicationPath':a.get('ApplicationPath'),'archiveVersion':p.get('ArchiveVersion'),'archiveBundleId':a.get('CFBundleIdentifier'),'archiveMarketingVersion':a.get('CFBundleShortVersionString'),'archiveBuildNumber':a.get('CFBundleVersion')}\nelse:\n i=p.get('CFBundleIcons',{}).get('CFBundlePrimaryIcon',{})\n r={'bundleId':p.get('CFBundleIdentifier'),'marketingVersion':p.get('CFBundleShortVersionString'),'buildNumber':p.get('CFBundleVersion'),'executable':p.get('CFBundleExecutable'),'packageType':p.get('CFBundlePackageType'),'platform':p.get('DTPlatformName'),'supportedPlatforms':p.get('CFBundleSupportedPlatforms'),'minimumOS':p.get('MinimumOSVersion'),'sdkName':p.get('DTSDKName'),'hasIconName':bool(i.get('CFBundleIconName')),'encryptionDeclaration':p.get('ITSAppUsesNonExemptEncryption')}\nprint(json.dumps(r))`;
  const child = Bun.spawnSync(['python3','-c',script,path,kind],{stdout:'pipe',stderr:'pipe',timeout:10_000});
  if(child.exitCode !== 0) throw Error('ARCHIVE_PLIST_INVALID');
  try { return JSON.parse(new TextDecoder().decode(child.stdout)); } catch { throw Error('ARCHIVE_PLIST_INVALID'); }
}

export function inspectUnsignedArchive(archivePath: string) {
  const archive = resolve(archivePath);
  if(!archive.endsWith('.xcarchive') || !directory(archive)) throw Error('ARCHIVE_DIRECTORY_INVALID');
  const archiveInfo = metadata(join(archive,'Info.plist'),'archive');
  const app = archiveApplicationPath(archive,archiveInfo.applicationPath);
  const appInfo = metadata(join(app,'Info.plist'),'app');
  const executable = typeof appInfo.executable === 'string' && /^[A-Za-z0-9_-]+$/.test(appInfo.executable) ? join(app,appInfo.executable) : '';
  const executablePresent=Boolean(executable && existsSync(executable) && regular(executable));
  const arch=executablePresent?Bun.spawnSync(['xcrun','lipo','-archs',executable],{stdout:'pipe',stderr:'ignore',timeout:10_000}):null;
  const build=executablePresent?Bun.spawnSync(['xcrun','vtool','-show-build',executable],{stdout:'pipe',stderr:'ignore',timeout:10_000}):null;
  const architectures=arch?.exitCode===0?new TextDecoder().decode(arch.stdout).trim().split(/\s+/):[];
  const buildText=build?.exitCode===0?new TextDecoder().decode(build.stdout):'';
  const binaryPlatform=buildText.match(/\bplatform\s+(\w+)/)?.[1]??'unknown';
  const signing = Bun.spawnSync(['/usr/bin/codesign','--display','--verbose=2',app],{stdout:'pipe',stderr:'pipe',timeout:10_000,env:{...process.env,LC_ALL:'C'}});
  const signText = new TextDecoder().decode(signing.stderr);
  const signature = signing.exitCode === 0 ? 'signed' : /code object is not signed at all/.test(signText) ? 'unsigned' : 'unknown';
  const facts = {...archiveInfo,...appInfo,
    hasCompiledAssets:existsSync(join(app,'Assets.car')) && regular(join(app,'Assets.car')),
    hasPrivacyManifest:existsSync(join(app,'PrivacyInfo.xcprivacy')) && regular(join(app,'PrivacyInfo.xcprivacy')),
    hasEmbeddedProvision:existsSync(join(app,'embedded.mobileprovision')),
    executablePresent, architectures, binaryPlatform, signature,
  } as ArchiveFacts;
  return assessUnsignedArchive(facts);
}

export function sourceProvenance(root: string) {
  const head = Bun.spawnSync(['git','rev-parse','HEAD'],{cwd:root,stdout:'pipe',stderr:'ignore'});
  const status = Bun.spawnSync(['git','status','--porcelain','--','mobile/ios'],{cwd:root,stdout:'pipe',stderr:'ignore'});
  return {head:head.exitCode===0?new TextDecoder().decode(head.stdout).trim():null,
    iosSourceDirty:status.exitCode===0?status.stdout.length>0:null,
    officialRelease:false};
}
