import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
// Opt-in live model call; not part of the automatic Bun test suite.
const executable=process.argv[2];
if(process.platform==='win32'||!executable?.startsWith('/'))throw new Error('Pass an installed POSIX Codex executable');
const root=mkdtempSync(join(tmpdir(),'agentstoz-first-response-'));
const output=join(root,'answer.txt');
const child=Bun.spawn([executable,'exec','--ephemeral','--skip-git-repo-check','--sandbox','read-only','-C',root,'-o',output,'Reply with a short Korean checklist of three steps for starting a new project. Do not use tools or read or write files. This is an onboarding connection test.'],{cwd:'/',stdin:'ignore',stdout:'ignore',stderr:'ignore',detached:true});
let timedOut=false;const timer=setTimeout(()=>{timedOut=true;try{process.kill(-child.pid,'SIGTERM');}catch{}},90000);
const hard=setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}},93000);
try{const exit=await child.exited;let answer='';try{answer=readFileSync(output,'utf8');}catch{}
 console.log(JSON.stringify({exitCode:exit,timedOut,nonemptyAnswer:!!answer.trim(),answerBytes:Buffer.byteLength(answer),ephemeral:true,sandbox:'read-only'}));
 if(exit!==0||timedOut||!answer.trim())process.exitCode=1;
}finally{clearTimeout(timer);clearTimeout(hard);try{process.kill(-child.pid,'SIGKILL');}catch{}rmSync(root,{recursive:true,force:true});}
