import {existsSync, readFileSync} from 'node:fs';
import {resolve} from 'node:path';

const root = resolve(import.meta.dir, '../../..');
const selected = Bun.spawnSync(['xcode-select', '-p'], {stdout:'pipe',stderr:'pipe'});
const developerDir = process.env.DEVELOPER_DIR ?? new TextDecoder().decode(selected.stdout).trim();
const xcode = developerDir.endsWith('/Contents/Developer') && existsSync(resolve(developerDir,'Applications/Simulator.app'));
const sdk = xcode ? Bun.spawnSync(['xcrun','--sdk','iphoneos','--show-sdk-path'],{stdout:'pipe',stderr:'pipe'}) : null;
const project = resolve(root,'mobile/ios/AgentsToZMobile.xcodeproj/project.pbxproj');
const icon = resolve(root,'mobile/ios/App/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png');
const privacy = resolve(root,'mobile/ios/App/PrivacyInfo.xcprivacy');
const projectText = existsSync(project) ? readFileSync(project,'utf8') : '';
const iconBytes = existsSync(icon) ? readFileSync(icon) : null;
const appIconReady = Boolean(iconBytes
  && iconBytes.length > 25
  && iconBytes.readUInt32BE(16) === 1024
  && iconBytes.readUInt32BE(20) === 1024
  // PNG colour type 2 is true-colour RGB. App Store icons must not contain alpha.
  && iconBytes[25] === 2
  && projectText.includes('ASSETCATALOG_COMPILER_APPICON_NAME = AppIcon')
  && projectText.includes('path = Assets.xcassets'));
const privacyManifestReady = existsSync(privacy)
  && projectText.includes('path = PrivacyInfo.xcprivacy')
  && projectText.includes('C20000000000000000000004');
const result = {
  nativeProject: existsSync(project),
  fullXcode: xcode,
  iphoneSDK: sdk?.exitCode === 0,
  canBuildIOS: xcode && sdk?.exitCode === 0,
  appIconReady,
  privacyManifestReady,
  testFlightReady: false,
  remaining: [
    'iOS simulator and physical-device checks',
    ...(!appIconReady || !privacyManifestReady ? ['App Store icon and privacy resources'] : []),
    'App Store privacy answers and policy URL review',
    'Apple team/bundle registration and distribution provisioning',
    'signed archive validation and TestFlight upload',
  ],
};
console.log(JSON.stringify(result,null,2));
if(!result.canBuildIOS || !result.appIconReady || !result.privacyManifestReady)process.exitCode=2;
