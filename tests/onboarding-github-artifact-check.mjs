// Deliberate artifact integration check: uses a downloaded official pinned ZIP,
// an isolated HOME and no account login. Never installs into the user's home.
import {mkdtempSync,mkdirSync,copyFileSync,rmSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {createGithubHostEffects} from '../src/onboardingGithubHost.ts';
import {GITHUB_RECIPE} from '../src/onboardingGithub.ts';
if(process.argv[2]==='child'){
 const root=process.argv[3],effects=createGithubHostEffects(join(root,'data'));
 await effects.prepare(new AbortController().signal);
 await effects.installFile(new AbortController().signal);
 const target=join(root,'.local/bin/gh');
 assert.equal(createHash('sha256').update(readFileSync(target)).digest('hex'),GITHUB_RECIPE.binarySha256);
 const version=Bun.spawnSync([target,'--version'],{cwd:'/',env:{HOME:root,PATH:'/usr/bin:/bin'},stdout:'pipe',stderr:'pipe'});
 assert.equal(version.exitCode,0);assert.match(version.stdout.toString(),/gh version 2\.100\.0/);
 await assert.rejects(effects.installFile(new AbortController().signal));
 assert.equal(createHash('sha256').update(readFileSync(target)).digest('hex'),GITHUB_RECIPE.binarySha256);
 console.log('PASS: real pinned ZIP, exact binary extraction, GitHub signature, isolated install, version execution, no replacement');
}else{
 if(process.platform!=='darwin'||process.arch!=='arm64'||!process.argv[2])throw new Error('Requires Apple Silicon Mac and a verified GitHub ZIP path');
 const root=mkdtempSync(join(tmpdir(),'github-artifact-'));
 try{
  mkdirSync(join(root,'data/onboarding'),{recursive:true,mode:0o700});copyFileSync(process.argv[2],join(root,'data/onboarding/github-2.100.0-arm64.zip'));
  const child=Bun.spawn([process.execPath,import.meta.path,'child',root],{cwd:'/',env:{HOME:root,PATH:'/usr/bin:/bin'},stdout:'inherit',stderr:'inherit'});
  assert.equal(await child.exited,0);
 }finally{rmSync(root,{recursive:true,force:true});}
}
