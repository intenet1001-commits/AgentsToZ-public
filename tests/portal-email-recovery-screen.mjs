/** Build current portal assets with fixture-only settings; exercise real SDK/UI, never real email. */
import {build} from 'vite';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
const root=resolve(import.meta.dir,'..'),scratch=await mkdtemp(join(tmpdir(),'agentstoz-email-recovery-'));
const prior=Object.fromEntries(Object.entries(process.env).filter(([key])=>key.startsWith('VITE_')));
try{
  for(const key of Object.keys(process.env))if(key.startsWith('VITE_'))delete process.env[key];
  process.env.VITE_SUPABASE_URL='https://workspace-fixture.supabase.co';
  process.env.VITE_SUPABASE_ANON_KEY='fixture-anon-key';
  await build({root,configFile:join(root,'vite.portal.config.ts'),envDir:scratch,logLevel:'error',build:{outDir:join(scratch,'dist'),emptyOutDir:true}});
  const child=Bun.spawn([process.execPath,'tests/portal-email-code-login.e2e.mjs'],{cwd:root,env:{...process.env,NAV_FIXTURE_DIST:join(scratch,'dist')},stdout:'inherit',stderr:'inherit'});
  if(await child.exited!==0)process.exitCode=1;
}finally{
  for(const key of Object.keys(process.env))if(key.startsWith('VITE_'))delete process.env[key];
  Object.assign(process.env,prior);
  await rm(scratch,{recursive:true,force:true});
}
