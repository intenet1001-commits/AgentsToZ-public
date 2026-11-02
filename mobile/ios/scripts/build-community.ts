import {closeSync,openSync} from 'node:fs';
import {resolve} from 'node:path';
import {deriveBuildNumber,gitRunner,readBuildNumberFile} from '../../../buildVersion';
import {installedDevelopmentTeams,resolveDevelopmentTeam} from './signingTeam';
import {executeIOSCommunityBuild} from './communityBuild';

// Builds only. Installation, launch, TestFlight archives and upload are deliberately separate commands.
if(import.meta.main){
  if(process.platform!=='darwin')throw Error('iOS community builds require macOS and full Xcode.');
  const root=resolve(import.meta.dir,'../../..'),git=gitRunner(root);
  const receipt=await executeIOSCommunityBuild(root,process.argv.slice(2),{
    source(){
      const status=git(['status','--porcelain=v1','--untracked-files=all']),head=git(['rev-parse','HEAD']);
      if(status.exitCode!==0||status.stdout.trim()||head.exitCode!==0)throw Error('Commit all source before a signed development build.');
      const derived=deriveBuildNumber(readBuildNumberFile(root),git);if(!derived.ok)throw Error('A complete committed build history is required.');
      return {commit:head.stdout.trim(),version:derived.buildNumber};
    },
    team(requested){return resolveDevelopmentTeam(installedDevelopmentTeams(),requested).team;},
    async run(argv,{cwd,env,log}){
      const fd=log?openSync(log,'wx',0o600):undefined;
      try{
        const child=Bun.spawn([...argv],{cwd,env,stdin:'ignore',stdout:fd??'pipe',stderr:fd??'pipe'});
        const text=fd===undefined?Promise.all([child.stdout,child.stderr].map(stream=>{
          if(typeof stream==='number')throw Error('iOS build output stream is unavailable.');
          return new Response(stream).text();
        })):Promise.resolve(['','']);
        const timer=setTimeout(()=>child.kill(),900_000);
        try{const [out,err]=await text;if(await child.exited!==0)throw Error('iOS community build command failed; inspect the private build log.');return out+'\n'+err;}
        finally{clearTimeout(timer);}
      }finally{if(fd!==undefined)closeSync(fd);}
    },
    now:()=>new Date(),env:process.env,
  });
  console.log(JSON.stringify(receipt,null,2));
}
