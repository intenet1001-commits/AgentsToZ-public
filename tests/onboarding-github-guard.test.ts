import {expect,test} from 'bun:test';
import {mkdtempSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test.skipIf(process.platform!=='darwin')('login guard strips raw output/env and reaps the login when its parent is killed',async()=>{
 const root=mkdtempSync(join(tmpdir(),'onboarding-guard-'));const executable=join(root,'gh');
 writeFileSync(executable,`#!/bin/sh\necho $$ > '${root}/provider.pid'\n[ -n "$GH_TOKEN" ] && echo inherited-token > '${root}/leaked'\necho 'private-credential-and-account'\necho '! First copy your one-time code: ABCD-1234' >&2\nwhile :; do /bin/sleep 1; done\n`,{mode:0o700});
 const parent=Bun.spawn([process.execPath,join(import.meta.dir,'fixtures/onboarding-github/parent.ts'),executable,root],{cwd:'/',stdout:'pipe',stderr:'pipe',stdin:'pipe'});
 let output='',guard=0,provider=0;
 const pump=(async()=>{for await(const bytes of parent.stdout)output+=new TextDecoder().decode(bytes);})();
 try{
  for(let i=0;i<200&&!output.includes('CODE ABCD-1234');i++)await Bun.sleep(10);
  expect(output).toContain('CODE ABCD-1234');expect(output).not.toContain('private-credential');expect(existsSync(join(root,'leaked'))).toBe(false);
  guard=Number(output.match(/GUARD (\d+)/)?.[1]);provider=Number(readFileSync(join(root,'provider.pid'),'utf8'));
  parent.kill('SIGKILL');await parent.exited;
  let running=true;for(let i=0;i<100;i++){
   const ps=Bun.spawnSync(['/bin/ps','-p',String(provider),'-o','stat='],{stdout:'pipe',stderr:'ignore'});
   running=ps.exitCode===0&&!ps.stdout.toString().trim().startsWith('Z');if(!running)break;await Bun.sleep(20);
  }expect(running).toBe(false);
 }finally{try{parent.kill('SIGKILL');}catch{}if(guard>1){try{process.kill(-guard,'SIGKILL');}catch{}}await parent.exited;await pump;rmSync(root,{recursive:true,force:true});}
},15000);

test.skipIf(process.platform!=='darwin')('cancel before guard claims its receipt prevents any provider launch',async()=>{
 const root=mkdtempSync(join(tmpdir(),'onboarding-guard-cancel-')),executable=join(root,'gh');
 writeFileSync(executable,`#!/bin/sh\necho launched > '${root}/launched'\n`,{mode:0o700});
 const parent=Bun.spawn([process.execPath,join(import.meta.dir,'fixtures/onboarding-github/parent.ts'),executable,root,'cancel-before-claim'],{cwd:'/',stdout:'pipe',stderr:'pipe'});
 try{await parent.exited;expect(existsSync(join(root,'launched'))).toBe(false);}
 finally{try{parent.kill('SIGKILL');}catch{}rmSync(root,{recursive:true,force:true});}
},5000);
