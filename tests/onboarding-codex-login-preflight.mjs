// Opt-in live device-code issuance/cancellation. Never approve or save a login.
import {mkdtempSync,mkdirSync,rmSync,existsSync} from 'node:fs';
import {join,isAbsolute} from 'node:path';
import {spawn} from 'node:child_process';
import assert from 'node:assert/strict';
const executable=process.argv[2];
if(process.platform!=='darwin'||!executable||!isAbsolute(executable))throw new Error('Provide an inspected absolute Codex executable path on Mac');
const root=mkdtempSync('/tmp/codex-login-preflight-'),codexHome=join(root,'.codex');
let child,deadline,force,total=0,buffer='',issued=false,timedOut=false;
function stop(){
 if(!child?.pid)return;
 try{process.kill(-child.pid,'SIGTERM');}catch{}
 force??=setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}},500);
}
try{
 mkdirSync(codexHome,{mode:0o700});
 child=spawn(executable,['-c','cli_auth_credentials_store="file"','login','--device-auth'],{
  cwd:'/',env:{HOME:root,CODEX_HOME:codexHome,PATH:'/usr/bin:/bin',NO_COLOR:'1'},stdio:['ignore','pipe','pipe'],detached:true,
 });
 const consume=chunk=>{
  total+=chunk.length;if(total>65536){stop();return;}
  buffer=(buffer+chunk.toString('utf8')).slice(-8192);
  const plain=buffer.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'');
  if(plain.includes('https://auth.openai.com/codex/device')&&/\b[A-Z0-9]{4}-[A-Z0-9]{5}\b/.test(plain)){
   issued=true;buffer='';stop();
  }
 };
 child.stdout.on('data',consume);child.stderr.on('data',consume);
 deadline=setTimeout(()=>{timedOut=true;stop();},30000);
 await new Promise((resolve,reject)=>{child.on('close',resolve);child.on('error',reject);});
 assert.equal(existsSync(join(codexHome,'auth.json')),false);
 assert.equal(existsSync(join(codexHome,'config.toml')),false);
 const authPaths=Array.from(new Set((buffer.match(/https:\/\/auth\.openai\.com\/[a-z0-9/_-]+/g)??[]).map(url=>new URL(url).pathname)));
 console.log(JSON.stringify({deviceCodeIssued:issued,cancelledBeforeApproval:issued,timedOut,credentialsCreated:false,configCreated:false,
  outputBytes:total,authPaths,sawDevicePrompt:/device|one-time/i.test(buffer),sawConnectionError:/connection|connect error|certificate|timed out/i.test(buffer)}));
 if(!issued)process.exitCode=1;
}finally{clearTimeout(deadline);clearTimeout(force);buffer='';rmSync(root,{recursive:true,force:true});}
