import {expect,test} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,chmodSync,rmSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {startTestApiServer} from './startTestApiServer';

test('real API protects progress origin and Vercel status never invokes an installer',async()=>{
 const root=mkdtempSync(join(tmpdir(),'onboarding-http-'));
 const bin=join(root,'.bun','bin');mkdirSync(bin,{recursive:true});
 const vercel=join(bin,'vercel'), npx=join(bin,'npx');
 writeFileSync(vercel,'#!/bin/sh\nif [ "$1" = "--version" ]; then echo 49.0.0; exit 0; fi\necho "ENOTFOUND: please log in" >&2\nexit 1\n');chmodSync(vercel,0o755);
 writeFileSync(npx,'#!/bin/sh\ntouch "$HOME/installer-was-called"\nexit 99\n');chmodSync(npx,0o755);
 let child: Bun.Subprocess|undefined;
 try {
  const started=await startTestApiServer({cwd:join(import.meta.dir,'..'),env:{...process.env,
   HOME:root,USERPROFILE:root,APP_DATA_DIR:join(root,'data'),APPDATA:join(root,'roaming'),XDG_CONFIG_HOME:join(root,'.config'),
   PORTMGR_ONBOARDING_CAPABILITY:'a'.repeat(64),
   PATH:`${bin}:/usr/bin:/bin`,AGENTSTOZ_SKIP_HERMES_SYNC:'1',AGENTSTOZ_SKIP_OUTPUT_STYLE_SYNC:'1',
  }});child=started.child;
  const url=started.baseUrl+'/api/onboarding/progress';
  expect((await fetch(url,{headers:{Origin:'https://untrusted.example'}})).status).toBe(403);
  const p=await (await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({operation:'plan',expectedRevision:'0',tools:['vercel']})})).json();
  expect(p.success).toBe(true);
  expect((await (await fetch(url)).json()).progress).toEqual(p.progress);
  const status=await (await fetch(started.baseUrl+'/api/vercel-cli/status')).json();
  expect(status).toMatchObject({installed:true,loggedIn:null,state:'unknown'});
  expect(JSON.stringify(status)).not.toContain('ENOTFOUND');
  expect(existsSync(join(root,'installer-was-called'))).toBe(false);
  const setupUrl=started.baseUrl+'/api/onboarding/github';
  const payload=JSON.stringify({operation:'status'});
  expect((await fetch(setupUrl,{method:'POST',headers:{'Content-Type':'application/json'},body:payload})).status).toBe(403);
  const setup=await fetch(setupUrl,{method:'POST',headers:{'Content-Type':'application/json','x-agentstoz-onboarding-capability':'a'.repeat(64)},body:payload});
  expect(setup.status).toBe(200);expect((await setup.json()).receipt).toBeNull();
  expect((await fetch(setupUrl,{method:'POST',headers:{'Content-Type':'application/json','x-agentstoz-agent-runtime-capability':'a'.repeat(64)},body:payload})).status).toBe(403);

 }finally{child?.kill();await child?.exited;rmSync(root,{recursive:true,force:true});}
},20000);
