import {existsSync,lstatSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {COMMUNITY_CONFIG_INFO_KEY,parseCommunityBuildConfig,readCommunityBuildConfig,serializeCommunityBuildConfig,type CommunityBuildConfig} from './communityBuildConfig';

/** Build input only. Read once before the normal release-source guard; never inherit a runtime/environment setting. */
export function parseMainCommunityBuildOptions(args:readonly string[]):{buildArguments:string[];communityConfig?:CommunityBuildConfig}{
  const buildArguments:string[]=[];let selected:string|undefined;
  for(let i=0;i<args.length;i++){
    if(args[i]!=='--community-config'){buildArguments.push(args[i]!);continue;}
    const value=args[++i];
    if(selected!==undefined||!value||value.startsWith('--'))throw Error('Choose one explicit public community configuration file');
    selected=resolve(value);
  }
  if(selected===undefined)return {buildArguments};
  if(!buildArguments.includes('--developer-id')||!buildArguments.includes('--with-viewer'))throw Error('Public community configuration requires --developer-id and --with-viewer');
  if(buildArguments.includes('--community-qa'))throw Error('Community QA and public configuration cannot be combined');
  return {buildArguments,communityConfig:readCommunityBuildConfig(selected)};
}

function plistObject(path:string):Record<string,unknown>{
  if(!existsSync(path))throw Error('Community bundle Info.plist is missing');
  const stat=lstatSync(path);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>1_048_576)throw Error('Community bundle Info.plist is not a bounded regular file');
  const read=Bun.spawnSync(['/usr/bin/plutil','-convert','json','-o','-',path],{stdout:'pipe',stderr:'pipe'});
  if(read.exitCode!==0)throw Error('Community bundle Info.plist is unreadable');
  const value=JSON.parse(read.stdout.toString());
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Community bundle Info.plist is not a dictionary');
  return value;
}

/** The signed helper must contain exactly the build snapshot; absent input cannot inherit a previous service. */
export function assertSealedCommunityBuildConfig(infoPath:string,config:CommunityBuildConfig|undefined):void{
  const info=plistObject(infoPath),present=Object.hasOwn(info,COMMUNITY_CONFIG_INFO_KEY);
  if(config===undefined){if(present)throw Error('An unrequested community configuration is present');return;}
  if(!present||serializeCommunityBuildConfig(parseCommunityBuildConfig(info[COMMUNITY_CONFIG_INFO_KEY]))!==serializeCommunityBuildConfig(config))throw Error('Community bundle configuration differs from the build snapshot');
}

/** Only call before the main app's final signature. Helpers are built and signed independently. */
export function sealMainCommunityBuildConfig(infoPath:string,config:CommunityBuildConfig|undefined):void{
  const info=plistObject(infoPath);
  if(Object.hasOwn(info,COMMUNITY_CONFIG_INFO_KEY))throw Error('A fresh main app is required before sealing community configuration');
  if(config!==undefined){
    const insert=Bun.spawnSync(['/usr/bin/plutil','-insert',COMMUNITY_CONFIG_INFO_KEY,'-json',serializeCommunityBuildConfig(config),infoPath],{stdout:'pipe',stderr:'pipe'});
    if(insert.exitCode!==0)throw Error('Could not seal the public community build configuration');
  }
  assertSealedCommunityBuildConfig(infoPath,config);
}

/** An owned temporary snapshot prevents a build-time file change from giving different helpers different issuers. */
export function writeCommunityBuildSnapshot(path:string,config:CommunityBuildConfig|undefined):string|undefined{
  if(config===undefined)return undefined;
  writeFileSync(path,serializeCommunityBuildConfig(config)+'\n',{encoding:'utf8',mode:0o600,flag:'wx'});
  return path;
}
