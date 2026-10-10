// Opt-in: real CLI browser-start and cancellation, no browser open/account approval.
import {mkdtempSync,rmSync,existsSync,readdirSync,readlinkSync} from 'node:fs';
import {homedir} from 'node:os';
import {join,isAbsolute} from 'node:path';
import assert from 'node:assert/strict';
const executable=process.argv[2];assert.ok(executable&&isAbsolute(executable));
const root=mkdtempSync(join(homedir(),'.agentstoz-codex-browser-test-'));
const parent=Bun.spawn([process.execPath,join(import.meta.dir,'fixtures/onboarding-codex-login/parent.ts'),executable,root,'live-cancel'],{cwd:'/',stdin:'pipe',stdout:'pipe',stderr:'ignore'});
let output='',guard=0;const timer=setTimeout(()=>{parent.kill('SIGKILL');if(guard>1)try{process.kill(-guard,'SIGKILL');}catch{}},20000);
try{
 for await(const bytes of parent.stdout){output+=new TextDecoder().decode(bytes);guard=Number(output.match(/GUARD (\d+)/)?.[1]);}
 await parent.exited;assert.ok(output.includes('BROWSER_READY'),'Browser preparation did not complete');
 assert.equal(output.includes('https:'),false);assert.equal(existsSync(join(root,'.codex/auth.json')),false);assert.equal(existsSync(join(root,'.codex/config.toml')),false);
 const sink=join(root,'onboarding/codex-login-output');assert.deepEqual(readdirSync(sink),['codex-login.log']);assert.equal(readlinkSync(join(sink,'codex-login.log')),'/dev/null');
 console.log('PASS: official CLI browser URL validated privately; cancelled before opening/approval; no auth/config created; login log discarded');
}finally{clearTimeout(timer);try{parent.kill('SIGKILL');}catch{}if(guard>1)try{process.kill(-guard,'SIGKILL');}catch{}await parent.exited;rmSync(root,{recursive:true,force:true});}
