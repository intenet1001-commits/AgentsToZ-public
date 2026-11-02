import {test,expect} from 'bun:test';
import {createECDH} from 'node:crypto';
import {mkdtempSync,readFileSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {COMMUNITY_CONFIG_INFO_KEY,serializeCommunityBuildConfig} from '../scripts/communityBuildConfig';
import {assertSealedCommunityBuildConfig,parseMainCommunityBuildOptions,sealMainCommunityBuildConfig,writeCommunityBuildSnapshot} from '../scripts/mainCommunityBuildConfig';

function fixture(){
  const root=mkdtempSync(join(tmpdir(),'community-main-packaging-')),key=createECDH('prime256v1');key.generateKeys();
  const config=Object.freeze({origin:'https://fixture.workers.dev',issuerPublicKey:key.getPublicKey().toString('base64url'),profileId:'11111111-2222-4333-8444-555555555555'});
  const input=join(root,'public.json');writeFileSync(input,serializeCommunityBuildConfig(config));
  return {root,input,config,close:()=>rmSync(root,{recursive:true,force:true})};
}
test('Main consumes one explicit configuration without changing release or signing options',()=>{
  const f=fixture();try{
    const args=['--developer-id','--with-viewer','--community-config',f.input,'--notary-profile','fixture-profile','--embedded-browser'];
    const selected=parseMainCommunityBuildOptions(args);
    expect(selected.buildArguments).toEqual(['--developer-id','--with-viewer','--notary-profile','fixture-profile','--embedded-browser']);
    expect(selected.communityConfig).toEqual(f.config);expect(Object.isFrozen(selected.communityConfig)).toBe(true);
    expect(parseMainCommunityBuildOptions(['--allow-unpublished-source'])).toEqual({buildArguments:['--allow-unpublished-source']});
    for(const invalid of [[],['--developer-id'],['--with-viewer']])expect(()=>parseMainCommunityBuildOptions([...invalid,'--community-config',f.input])).toThrow();
    for(const invalid of [
      ['--developer-id','--with-viewer','--community-config'],
      ['--developer-id','--with-viewer','--community-config','--dmg'],
      ['--developer-id','--with-viewer','--community-config',f.input,'--community-config',f.input],
      ['--developer-id','--with-viewer','--community-qa','--community-config',f.input],
    ])expect(()=>parseMainCommunityBuildOptions(invalid)).toThrow();
  }finally{f.close();}
});
test('all helper snapshots retain the original issuer after the input file changes and refuse overwrite',()=>{
  const f=fixture();try{
    const selected=parseMainCommunityBuildOptions(['--developer-id','--with-viewer','--community-config',f.input]);
    writeFileSync(f.input,JSON.stringify({...f.config,origin:'https://changed.workers.dev'}));
    for(const helper of ['screen','viewer','control']){
      const path=join(f.root,helper+'.json');expect(writeCommunityBuildSnapshot(path,selected.communityConfig)).toBe(path);
      expect(JSON.parse(readFileSync(path,'utf8'))).toEqual(f.config);
      expect(()=>writeCommunityBuildSnapshot(path,selected.communityConfig)).toThrow();
    }
    expect(writeCommunityBuildSnapshot(join(f.root,'absent.json'),undefined)).toBeUndefined();
  }finally{f.close();}
});
test.if(process.platform==='darwin')('Main seals only a fresh Info and verifies exact helper configuration, including absence',()=>{
  const f=fixture();try{
    const info=join(f.root,'Info.plist');
    writeFileSync(info,'<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>test.fixture</string></dict></plist>');
    assertSealedCommunityBuildConfig(info,undefined);sealMainCommunityBuildConfig(info,f.config);
    assertSealedCommunityBuildConfig(info,f.config);
    expect(()=>assertSealedCommunityBuildConfig(info,undefined)).toThrow();
    expect(()=>assertSealedCommunityBuildConfig(info,{...f.config,origin:'https://other.workers.dev'})).toThrow();
    expect(()=>sealMainCommunityBuildConfig(info,f.config)).toThrow('fresh main app');
    expect(readFileSync(info,'utf8')).toContain(COMMUNITY_CONFIG_INFO_KEY);
    const link=join(f.root,'linked.plist');symlinkSync(info,link);
    expect(()=>sealMainCommunityBuildConfig(link,f.config)).toThrow('regular file');
  }finally{f.close();}
});
