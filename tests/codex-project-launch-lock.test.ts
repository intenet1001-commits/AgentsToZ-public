import {expect,test} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {withCodexProjectLaunchLock} from '../src/codexProjectLaunchLock';

for(const first of ['legacy','v2'] as const) test(`${first} and the other intent cannot race across receipt reservation`,async()=>{
  const dir=mkdtempSync(join(tmpdir(),'codex-project-lock-'));let release!:()=>void;
  const wait=new Promise<void>(resolve=>{release=resolve;});let entered!:()=>void;
  const ready=new Promise<void>(resolve=>{entered=resolve;});const calls:string[]=[];
  try{
    const a=withCodexProjectLaunchLock(dir,'directory-identity',async()=>{calls.push(first);entered();await wait;});
    await ready;
    await expect(withCodexProjectLaunchLock(dir,'directory-identity',async()=>{calls.push('other');})).rejects.toMatchObject({code:'CODEX_NEW_CHAT_BUSY'});
    expect(calls).toEqual([first]);release();await a;
    await withCodexProjectLaunchLock(dir,'directory-identity',async()=>{calls.push('other');});
    expect(calls).toEqual([first,'other']);
  } finally {release?.();rmSync(dir,{recursive:true,force:true});}
});
