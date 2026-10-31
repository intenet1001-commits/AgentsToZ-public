/**
 * Run the request-refusal UI journeys against an owned loopback Vite server.
 * No installed app, provider, existing API, or fixed development port is used.
 */
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {createServer} from 'vite';

const root=resolve(import.meta.dirname,'..');
const scratch=await mkdtemp(join(tmpdir(),'agentstoz-submission-refusal-screen-'));
for(const key of Object.keys(process.env))if(key.startsWith('VITE_'))delete process.env[key];
process.env.VITE_SUPABASE_URL='https://workspace-fixture.supabase.co';
process.env.VITE_SUPABASE_ANON_KEY='fixture-anon-key';
let vite,child;
try {
  const contracts=await new Promise((resolve,reject)=>{
    child=spawn('bun',["test", "./tests/workroom-submission.test.ts", "./tests/workroom-conversation-history.test.ts", "./tests/ai-terminal.test.ts", "./tests/workroom-submission-effort-gate.test.ts", "./tests/remote-control-mobile-submission-never-ran.test.ts"],{cwd:root,stdio:'inherit'});
    child.once('error',reject);
    child.once('exit',(code,signal)=>resolve({code,signal}));
  });
  assert.equal(contracts.signal,null,'Submission contract tests were terminated');
  assert.equal(contracts.code,0,'Submission contract tests failed');
  vite=await createServer({
    configFile:join(root,'vite.config.ts'),root,envDir:scratch,
    cacheDir:join(scratch,'node_modules/.vite'),mode:'maintainer-test',logLevel:'warn',
    plugins:[{name:'deny-live-api',configureServer(server){
      server.middlewares.use((request,response,next)=>{
        if(!request.url?.startsWith('/api/'))return next();
        response.statusCode=503;response.end('Unmocked fixture API rejected');
      });
    }}],
    server:{host:'127.0.0.1',port:0,strictPort:false,
      fs:{allow:[root,realpathSync(join(root,'node_modules')),scratch]},
      watch:{ignored:['**/.agentstoz/**']}}
  });
  await vite.listen();
  const address=vite.httpServer.address();
  assert.ok(address&&typeof address!=='string'&&address.port!==3001&&address.port!==9000);
  const origin='http://127.0.0.1:'+address.port;
  const result=await new Promise((resolve,reject)=>{
    child=spawn(process.execPath,['tests/workroom-submission-refusal.e2e.mjs'],{
      cwd:root,stdio:'inherit',env:{...process.env,WORKROOM_REFUSAL_ORIGIN:origin}
    });
    child.once('error',reject);
    child.once('exit',(code,signal)=>resolve({code,signal}));
  });
  assert.equal(result.signal,null,'UI test was terminated');
  assert.equal(result.code,0,'Submission refusal UI journeys failed');
} finally {
  if(child&&child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');
  await vite?.close();
  await rm(scratch,{recursive:true,force:true});
}
