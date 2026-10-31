import {expect,test} from 'bun:test';
import {createHash} from 'node:crypto';
import {assertComputerUseSigningProfile,readComputerUseSigningProfileMetadata,resolveControlSigningIdentityFingerprint,prepareControlSigningProfile} from '../scripts/computerUseSigningProfile';
import {CONTROL_TEAM_ID,CONTROL_BUNDLE_ID,controlEntitlements} from '../scripts/computerUseControlBundle';
const id=CONTROL_TEAM_ID+'.'+CONTROL_BUNDLE_ID;
const fingerprint=createHash('sha1').update(Buffer.from([0,1,2])).digest('hex').toUpperCase();
const other='A'.repeat(40);
const now=Date.parse('2026-10-27');
const profile=()=>({TeamIdentifier:[CONTROL_TEAM_ID],ProvisionsAllDevices:true,ExpirationDate:'2030-01-01T00:00:00Z',DeveloperCertificateSHA1:[fingerprint],Entitlements:{'com.apple.application-identifier':id,'com.apple.developer.team-identifier':CONTROL_TEAM_ID,'keychain-access-groups':[id]}});
test('Control requires a dedicated nonexpired Developer ID profile and its own keychain group',()=>{
  expect(assertComputerUseSigningProfile(profile(),fingerprint,now)).toMatchObject({bundleId:CONTROL_BUNDLE_ID,teamId:CONTROL_TEAM_ID});
  for(const change of [{TeamIdentifier:['DIFFERENT1']},{ProvisionsAllDevices:false},{ProvisionedDevices:['device']},{ExpirationDate:'2020-01-01'},{Entitlements:{...profile().Entitlements,'com.apple.application-identifier':CONTROL_TEAM_ID+'.com.intenet.agentstozbycs.screen'}},{Entitlements:{...profile().Entitlements,'keychain-access-groups':['DIFFERENT1.*']}},{Entitlements:{...profile().Entitlements,'keychain-access-groups':['*']}},{Entitlements:{...profile().Entitlements,'keychain-access-groups':[]}},{Entitlements:{...profile().Entitlements,'com.apple.security.get-task-allow':true}}])expect(()=>assertComputerUseSigningProfile({...profile(),...change},fingerprint,now)).toThrow();
});
test('certificate mismatch, missing certificates and malformed digests are rejected before signing',()=>{
  expect(()=>assertComputerUseSigningProfile(profile(),other,now)).toThrow('selected signing certificate is not included');
  for(const certs of [undefined,[],['123'],[fingerprint,'not-a-digest']])expect(()=>assertComputerUseSigningProfile({...profile(),DeveloperCertificateSHA1:certs},fingerprint,now)).toThrow('certificate metadata is invalid');
  expect(()=>assertComputerUseSigningProfile(profile(),'invalid',now)).toThrow('certificate metadata is invalid');
  expect(assertComputerUseSigningProfile({...profile(),DeveloperCertificateSHA1:[other,fingerprint]},fingerprint,now)).toMatchObject({teamId:CONTROL_TEAM_ID});
});
test('signing identity names resolve uniquely to an exact valid fingerprint',()=>{
  const listing=`  1) ${fingerprint} "Developer ID Application: Example (${CONTROL_TEAM_ID})"\n  2) ${other} "Apple Development: Example (${CONTROL_TEAM_ID})"\n     2 valid identities found`;
  expect(resolveControlSigningIdentityFingerprint(fingerprint.toLowerCase(),listing)).toBe(fingerprint);
  expect(resolveControlSigningIdentityFingerprint(`Developer ID Application: Example (${CONTROL_TEAM_ID})`,listing)).toBe(fingerprint);
  expect(()=>resolveControlSigningIdentityFingerprint('missing',listing)).toThrow('unavailable or ambiguous');
  expect(()=>resolveControlSigningIdentityFingerprint(`Developer ID Application: Example (${CONTROL_TEAM_ID})`,listing+`\n  3) ${other} "Developer ID Application: Example (${CONTROL_TEAM_ID})"`)).toThrow('unavailable or ambiguous');
});
test.skipIf(process.platform!=='darwin')('preflight binds the supplied profile bytes and uniquely selected identity',()=>{
  const raw=Buffer.from('a signed profile fixture');
  const xml=`<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>
    <key>TeamIdentifier</key><array><string>${CONTROL_TEAM_ID}</string></array>
    <key>ProvisionsAllDevices</key><true/><key>ExpirationDate</key><date>2030-01-01T00:00:00Z</date>
    <key>Entitlements</key><dict><key>com.apple.application-identifier</key><string>${id}</string>
      <key>com.apple.developer.team-identifier</key><string>${CONTROL_TEAM_ID}</string>
      <key>keychain-access-groups</key><array><string>${id}</string></array></dict>
    <key>DeveloperCertificates</key><array><data>AAEC</data></array></dict></plist>`;
  const seen:string[]=[];
  const deps={decode:(value:Buffer)=>{seen.push(value.toString());return xml;},listIdentities:()=>`  1) ${fingerprint} "Developer ID Application: Example (${CONTROL_TEAM_ID})"\n  2) ${other} "Another identity"`};
  const prepared=prepareControlSigningProfile(raw,`Developer ID Application: Example (${CONTROL_TEAM_ID})`,deps,now);
  raw.fill(0);
  expect(prepared.profileBytes.toString()).toBe('a signed profile fixture');
  expect(prepared.signingFingerprint).toBe(fingerprint);
  expect(seen).toEqual(['a signed profile fixture']);
  expect(()=>prepareControlSigningProfile(Buffer.from('fixture'),other,deps,now)).toThrow('selected signing certificate is not included');
  expect(()=>prepareControlSigningProfile(Buffer.from('fixture'),'',deps,now)).toThrow('exact Control signing identity');
});
test('the installed Developer ID profile team wildcard permits only the binary’s explicit approval group',()=>{
  const installed={...profile(),ExpirationDate:'2044-10-21T22:19:29Z',Entitlements:{...profile().Entitlements,'keychain-access-groups':[CONTROL_TEAM_ID+'.*']}};
  expect(assertComputerUseSigningProfile(installed,fingerprint,now)).toMatchObject({bundleId:CONTROL_BUNDLE_ID,teamId:CONTROL_TEAM_ID});
  const groups=controlEntitlements().match(/<key>keychain-access-groups<\/key>(<array>.*?<\/array>)/s)?.[1];
  expect(groups).toBe(`<array><string>${id}</string></array>`);
});
test.skipIf(process.platform!=='darwin')('Apple profile metadata and certificate hashes are read from a nonseekable stdin pipe without exposing certificate bytes',()=>{
  const xml=`<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>
    <key>TeamIdentifier</key><array><string>${CONTROL_TEAM_ID}</string></array>
    <key>ProvisionsAllDevices</key><true/><key>ExpirationDate</key><date>2030-01-01T00:00:00Z</date>
    <key>Entitlements</key><dict><key>com.apple.application-identifier</key><string>${id}</string>
      <key>com.apple.developer.team-identifier</key><string>${CONTROL_TEAM_ID}</string>
      <key>keychain-access-groups</key><array><string>${id}</string></array></dict>
    <key>DeveloperCertificates</key><array><data>AAEC</data></array></dict></plist>`;
  const metadata=readComputerUseSigningProfileMetadata(xml);
  expect(metadata).toEqual(profile());
  expect(assertComputerUseSigningProfile(metadata,fingerprint,now)).toMatchObject({bundleId:CONTROL_BUNDLE_ID});
  expect(JSON.stringify(metadata)).not.toContain('AAEC');
  expect(()=>readComputerUseSigningProfileMetadata(xml.replace('<data>AAEC</data>',''))).toThrow('certificate list');
  expect(()=>readComputerUseSigningProfileMetadata('invalid private input')).toThrow('Could not read the Control provisioning profile metadata');
});
