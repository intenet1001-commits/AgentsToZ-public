/** Native bridge and real SDK against synthetic Auth; no live Google/OTP/relay. */
import {build} from 'vite';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
const root=resolve(import.meta.dir,'..'),scratch=await mkdtemp(join(tmpdir(),'agentstoz-native-google-'));
const prior=Object.fromEntries(Object.entries(process.env).filter(([key])=>key.startsWith('VITE_')));
try{
  for(const key of Object.keys(process.env))if(key.startsWith('VITE_'))delete process.env[key];
  process.env.VITE_SUPABASE_URL='';process.env.VITE_SUPABASE_ANON_KEY='';
  await build({root,envDir:scratch,configFile:join(root,'vite.portal.config.ts'),logLevel:'error',build:{outDir:join(scratch,'dist'),emptyOutDir:true}});
  const child=Bun.spawn([process.execPath,'tests/bundled-portal-linked.e2e.mjs'],{cwd:root,env:{...process.env,BUNDLED_PORTAL_DIST:join(scratch,'dist')},stdout:'inherit',stderr:'inherit'});
  if(await child.exited!==0)process.exitCode=1;
}finally{
  for(const key of Object.keys(process.env))if(key.startsWith('VITE_'))delete process.env[key];Object.assign(process.env,prior);
  await rm(scratch,{recursive:true,force:true});
}
