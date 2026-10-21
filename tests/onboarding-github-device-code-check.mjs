// Opt-in live check: requests one public GitHub device code, NEVER approves it or
// exposes it. An isolated HOME does not isolate macOS Keychain; cancel before consent.
import {createHash} from 'node:crypto';
import {mkdtempSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import assert from 'node:assert/strict';
import {GITHUB_RECIPE} from '../src/onboardingGithub.ts';
if(process.platform!=='darwin'||!process.argv[2])throw new Error('Requires Mac and the pinned official gh binary');
assert.equal(createHash('sha256').update(readFileSync(process.argv[2])).digest('hex'),GITHUB_RECIPE.binarySha256);
const root=mkdtempSync(join(tmpdir(),'github-live-code-'));
const parent=Bun.spawn([process.execPath,join(import.meta.dir,'fixtures/onboarding-github/parent.ts'),process.argv[2],root],{cwd:'/',env:{HOME:root,PATH:'/usr/bin:/bin'},stdin:'pipe',stdout:'pipe',stderr:'ignore'});
let received=false,guard=0,buffer='';
const pump=(async()=>{for await(const chunk of parent.stdout){buffer+=new TextDecoder().decode(chunk);guard=Number(buffer.match(/GUARD (\d+)/)?.[1]??guard);if(/CODE [A-Z0-9]{4}-[A-Z0-9]{4}/.test(buffer)){received=true;buffer='';parent.kill('SIGKILL');}if(buffer.length>4096)throw new Error('Unexpected output');}})();
try{
 for(let i=0;i<1500&&!received;i++)await Bun.sleep(20);
 assert.equal(received,true,'Official CLI did not produce a device code within 30 seconds');
 await parent.exited;await pump;
 let running=true;for(let i=0;i<100;i++){
  const ps=Bun.spawnSync(['/bin/ps','-g',String(guard),'-o','stat='],{stdout:'pipe',stderr:'ignore'});
  running=ps.exitCode===0&&ps.stdout.toString().split('\n').some(s=>s.trim()&&!s.trim().startsWith('Z'));if(!running)break;await Bun.sleep(20);
 }
 assert.equal(running,false,'Guard process group must exit after parent death');
 assert.equal(existsSync(join(root,'.config/gh/hosts.yml')),false);
 console.log('PASS: official CLI device code received, withheld, cancelled before approval, process group ended, no login config created');
}finally{try{parent.kill('SIGKILL');}catch{}if(guard>1){try{process.kill(-guard,'SIGKILL');}catch{}}await parent.exited;await pump;buffer='';rmSync(root,{recursive:true,force:true});}
