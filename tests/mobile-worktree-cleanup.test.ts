import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync,writeFileSync,existsSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {MobileWorktreeCleanup} from '../src/mobileWorktreeCleanup';
test('worktree cleanup keeps branches, refuses dirty/unmerged/running targets and revalidates review',async()=>{
 const dir=realpathSync(mkdtempSync(join(tmpdir(),'mobile-cleanup-'))),main=join(dir,'main'),work=join(dir,'한글 작업');
 const git=async(cwd:string,args:string[])=>{const p=Bun.spawn(['git',...args],{cwd,stdout:'pipe',stderr:'pipe',env:{...process.env,GIT_CONFIG_NOSYSTEM:'1'}});const [stdout,stderr,code]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited]);return {ok:code===0,stdout,stderr};};
 const must=async(cwd:string,args:string[])=>{const r=await git(cwd,args);if(!r.ok)throw new Error(r.stderr);return r.stdout.trim()};
 let idle=true;
 try{
  await must(dir,['init','-b','main',main]);await must(main,['config','user.email','fixture@example.invalid']);await must(main,['config','user.name','Fixture']);await must(main,['commit','--allow-empty','-m','baseline']);
  const head=await must(main,['rev-parse','HEAD']);await must(main,['update-ref','refs/remotes/origin/main',head]);await must(main,['config','remote.origin.url','https://example.invalid/fixture.git']);await must(main,['config','remote.origin.fetch','+refs/heads/*:refs/remotes/origin/*']);await must(main,['config','branch.main.remote','origin']);await must(main,['config','branch.main.merge','refs/heads/main']);await must(main,['worktree','add','-b','topic',work]);
  const cleanup=new MobileWorktreeCleanup(git,async()=>{if(!idle)throw new Error('running')});
  await expect(cleanup.review('owner','main',main)).rejects.toThrow();
  writeFileSync(join(work,'draft.txt'),'keep me');await expect(cleanup.review('owner','target',work)).rejects.toThrow('미커밋');rmSync(join(work,'draft.txt'));
  idle=false;await expect(cleanup.review('owner','target',work)).rejects.toThrow('running');idle=true;
  const review=await cleanup.review('owner','target',work);
  await expect(cleanup.remove('different','target',work,review.token)).rejects.toThrow();
  await must(work,['commit','--allow-empty','-m','unmerged']);await expect(cleanup.remove('owner','target',work,review.token)).rejects.toThrow('반영되지');expect(existsSync(work)).toBe(true);
  await must(main,['merge','--ff-only','topic']);const next=await must(main,['rev-parse','HEAD']);await must(main,['update-ref','refs/remotes/origin/main',next]);
  await expect(cleanup.remove('owner','target',work,review.token)).rejects.toThrow('바뀌었습니다');
  const fresh=await cleanup.review('owner','target',work);await cleanup.remove('owner','target',work,fresh.token);
  expect(existsSync(work)).toBe(false);expect((await git(main,['show-ref','--verify','refs/heads/topic'])).ok).toBe(true);
  await expect(cleanup.remove('owner','target',work,fresh.token)).rejects.toThrow();
 }finally{rmSync(dir,{recursive:true,force:true})}
});
