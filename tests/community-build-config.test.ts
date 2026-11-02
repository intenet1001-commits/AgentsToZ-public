import {afterAll,beforeAll,describe,expect,test} from 'bun:test';
import {mkdirSync,mkdtempSync,readFileSync,rmSync,symlinkSync,writeFileSync,copyFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {COMMUNITY_CONFIG_INFO_KEY,communityBuildConfigPlistEntry,parseCommunityBuildConfig,readCommunityBuildConfig,serializeCommunityBuildConfig} from '../scripts/communityBuildConfig';
import {parseViewerBuildOptions} from '../scripts/build-viewer-app';
import {controlBuildInfoPlist,parseControlBuildArgs} from '../scripts/build-computer-use-control-app';

const ROOT=resolve(import.meta.dir,'..');
const good={origin:'https://fixture.workers.dev',issuerPublicKey:'BBBrsAeK5pOokQ3HXnIBqqMzAhWIGKtuS6LZnsyhNn_W8xzzKVd7sTG1tTBYTuIlm6QVkBS9O5faAJmz1Tesvu8',profileId:'51c574e8-2109-4065-92e0-66523c206fe8'};
const invalid:unknown[]=[null,[],{},true,{...good,secret:'fixture-forbidden'}, {...good,origin:42},{...good,issuerPublicKey:true},{...good,profileId:1},
 ...['http://fixture.workers.dev','https://fixture.workers.dev/','https://fixture.workers.dev/path','https://fixture.workers.dev:443','https://user@fixture.workers.dev','https://fixture.workers.dev?issuer=x','https://fixture.workers.dev#x','https://fixture.workers.dev.evil.test','https://workers.dev','https://FIXTURE.workers.dev','https://-bad.workers.dev','https://bad..workers.dev','https://localhost','https://'+ 'x'.repeat(64)+'.workers.dev'].map(origin=>({...good,origin})),
 {...good,profileId:good.profileId.toUpperCase()},{...good,issuerPublicKey:good.issuerPublicKey+'='},{...good,issuerPublicKey:Buffer.concat([Buffer.from([4]),Buffer.alloc(64)]).toString('base64url')},{...good,issuerPublicKey:Buffer.alloc(65).toString('base64url')}];
const scratch=mkdtempSync(join(tmpdir(),'agentstoz-public-config-check-')),config=join(scratch,'public.json'),profile=join(scratch,'fixture.provisionprofile'),probe=join(scratch,'config-probe');
beforeAll(()=>{writeFileSync(config,JSON.stringify(good,null,2));writeFileSync(profile,'fixture');});
afterAll(()=>rmSync(scratch,{recursive:true,force:true}));
describe('sealed public community build configuration',()=>{
 test('only the exact public triple, canonical origin/key and real P-256 point are accepted',()=>{
  expect(parseCommunityBuildConfig(good)).toEqual(good);expect(Object.isFrozen(parseCommunityBuildConfig(good))).toBe(true);
  for(const value of invalid)expect(()=>parseCommunityBuildConfig(value)).toThrow();
  expect(communityBuildConfigPlistEntry(undefined)).toBe('');expect(communityBuildConfigPlistEntry(good)).toContain(`<key>${COMMUNITY_CONFIG_INFO_KEY}</key><dict>`);
  expect(JSON.parse(serializeCommunityBuildConfig(good))).toEqual(good);
 });
 test('only one bounded explicit file is read and duplicate/escaped/unknown fields cannot hide input',()=>{
  expect(readCommunityBuildConfig(config)).toEqual(good);
  const bad=join(scratch,'bad.json');
  for(const raw of [JSON.stringify(good).replace('"origin":','"origin":"https://other.workers.dev","origin":'),JSON.stringify({...good,secret:'fixture-forbidden'}),' '.repeat(4097),JSON.stringify(good).replace('https','\\u0068ttps'),'{"malformed-private-fixture":']){
   writeFileSync(bad,raw);expect(()=>readCommunityBuildConfig(bad)).toThrow('Invalid public community build configuration');
  }
  const link=join(scratch,'link.json');symlinkSync(config,link);expect(()=>readCommunityBuildConfig(link)).toThrow();expect(()=>readCommunityBuildConfig('relative.json')).toThrow();
 });
 test('Viewer and Control builders seal the same validated snapshot and reject QA mixing/unsigned Control',()=>{
  const args=['--sign','fixture','--profile',profile,'--output',join(scratch,'AgentsToZViewer.app'),'--bundle-version','0.1.1'];
  expect(parseViewerBuildOptions([...args,'--community-config',config]).communityConfig).toEqual(good);
  expect(()=>parseViewerBuildOptions([...args,'--community-config',config,'--community-qa'])).toThrow();
  expect(()=>parseViewerBuildOptions([...args,'--community-config',config,'--community-config',config])).toThrow();
  const control=['--sign','fixture','--profile',profile,'--community-config',config];
  expect(parseControlBuildArgs(control,'/tmp/AgentsToZ Control.app').communityConfig).toEqual(good);
  expect(()=>parseControlBuildArgs([...control,'--community-qa'],'/tmp/AgentsToZ Control.app')).toThrow();
  expect(()=>parseControlBuildArgs(['--community-config',config],'/tmp/AgentsToZ Control.app')).toThrow();
  expect(controlBuildInfoPlist('0.1.1',false,good)).toContain(communityBuildConfigPlistEntry(good));expect(()=>controlBuildInfoPlist('0.1.1',true,good)).toThrow();
 });
 test('Screen rejects invalid config or QA mixing before any Swift build/signing step',()=>{
  const bad=join(scratch,'screen-invalid.json');writeFileSync(bad,JSON.stringify({...good,issuerPublicKey:'invalid'}));
  for(const [extra,error] of [
   [['--community-config',bad],'Invalid public community build configuration'],
   [['--community-config',config,'--community-qa'],'Community QA and public configuration cannot be combined'],
   [['--community-config'],'Choose one explicit public community config file'],
  ] as const){
   const child=Bun.spawnSync([process.execPath,'--env-file=/dev/null',resolve(ROOT,'scripts/build-screen-app.ts'),...extra],{env:{PATH:'/usr/bin:/bin'},stdout:'pipe',stderr:'pipe'});
   expect(child.exitCode).not.toBe(0);expect(child.stderr.toString()).toContain(error);expect(child.stderr.toString()).not.toContain('swift build');
  }
 });
 test.skipIf(process.platform!=='darwin')('both real Swift parsers agree, including signed bundles with illegal sealed fields',()=>{
  const child=Bun.spawnSync(['swiftc',resolve(ROOT,'native/screen-control/Sources/ScreenControlCore/ScreenCommunityBundleConfiguration.swift'),resolve(ROOT,'native/computer-use/Sources/ComputerUseApproval/CommunityControlBundleConfiguration.swift'),resolve(ROOT,'tests/fixtures/community-bundle-config-probe.swift'),'-o',probe],{stdout:'pipe',stderr:'pipe'});
  if(child.exitCode!==0)throw Error(child.stderr.toString());
  const matrix=join(scratch,'matrix.json');writeFileSync(matrix,JSON.stringify([good,...invalid].map(config=>({config}))));
  const run=Bun.spawnSync([probe,matrix],{stdout:'pipe',stderr:'pipe'});expect(run.exitCode).toBe(0);expect(JSON.parse(run.stdout.toString())).toEqual([good,...invalid].map((_,i)=>[i===0,i===0]));
  const app=join(scratch,'Fixture.app'),contents=join(app,'Contents'),bin=join(contents,'MacOS');mkdirSync(bin,{recursive:true});copyFileSync(probe,join(bin,'Probe'));
  for(const value of [undefined,good,{...good,secret:'fixture-forbidden'},{...good,issuerPublicKey:Buffer.concat([Buffer.from([4]),Buffer.alloc(64)]).toString('base64url')}]){
   const entry=value===undefined?'':`<key>${COMMUNITY_CONFIG_INFO_KEY}</key><dict>${Object.entries(value).map(([k,v])=>`<key>${k}</key><string>${v}</string>`).join('')}</dict>`;
   writeFileSync(join(contents,'Info.plist'),`<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>fixture.public-config</string><key>CFBundleExecutable</key><string>Probe</string><key>CFBundlePackageType</key><string>APPL</string>${entry}</dict></plist>`);
   expect(Bun.spawnSync(['codesign','--force','--sign','-',app],{stdout:'pipe',stderr:'pipe'}).exitCode).toBe(0);
   const result=Bun.spawnSync([join(bin,'Probe')],{stdout:'pipe',stderr:'pipe'});expect(result.exitCode).toBe(0);expect(result.stdout.toString().trim()).toBe(value===good?'[true, true]':'[false, false]');
  }
 },60_000);
});
