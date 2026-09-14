// Opt-in real package check. Installs only into a disposable HOME; no login approval.
import {mkdtempSync,mkdirSync,copyFileSync,rmSync,readFileSync,readlinkSync,symlinkSync,unlinkSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import assert from 'node:assert/strict';
import {createCodexInstallEffects} from '../src/onboardingCodexInstallEffects.ts';
import {CODEX_INSTALL_RECIPE as recipe} from '../src/onboardingCodexInstall.ts';
if(process.argv[2]==='child'){
 const root=process.argv[3],target=join(root,'.local/bin/codex');
 const effects=createCodexInstallEffects(join(root,'data'),{home:root,candidates:[target]});
 assert.equal(await effects.probe(),'missing');
 await effects.prepare(new AbortController().signal);await effects.install(new AbortController().signal);
 assert.equal(await effects.probe(),'installed');
 const version=Bun.spawnSync([target,'--version'],{cwd:'/',env:{HOME:root,PATH:'/usr/bin:/bin'},stdout:'pipe',stderr:'pipe'});
 assert.equal(version.exitCode,0);assert.match(version.stdout.toString(),/codex-cli 0\.154\.0/);
 const expected=readlinkSync(target);await effects.install(new AbortController().signal);assert.equal(readlinkSync(target),expected);
 // Simulate interrupted publication: prepared package/helper retained, CLI link absent.
 unlinkSync(target);await effects.install(new AbortController().signal);assert.equal(readlinkSync(target),expected);
 // A different installation, even dangling, cannot be replaced.
 unlinkSync(target);symlinkSync('/different-codex-installation',target);
 await assert.rejects(effects.install(new AbortController().signal));assert.equal(readlinkSync(target),'/different-codex-installation');
 assert.equal(existsSync(join(root,'.codex/auth.json')),false);
 assert.equal(existsSync(join(root,'.codex/config.toml')),false);
 const manifest=JSON.parse(readFileSync(join(root,'.local/share/agentstoz/tools',recipe.id,'codex-package.json'),'utf8'));
 assert.equal(manifest.version,recipe.version);
 console.log('PASS: complete official package, fixed-entry extraction, both OpenAI signatures, isolated install/version/auth-status, interrupted publication resume, no replacement, no credential/config creation');
}else{
 if(process.platform!=='darwin'||process.arch!=='arm64'||!process.argv[2])throw new Error('Requires Apple Silicon Mac and the official pinned package path or --download');
 // Codex intentionally refuses helper aliases when CODEX_HOME is inside the OS
 // per-user temporary directory. /tmp is separate from that macOS directory.
 const root=mkdtempSync('/tmp/codex-artifact-');
 try{
  mkdirSync(join(root,'data/onboarding'),{recursive:true,mode:0o700});
  if(process.argv[2]!=='--download')copyFileSync(process.argv[2],join(root,'data/onboarding/codex-0.154.0-arm64.tar.gz'));
  const child=Bun.spawn([process.execPath,import.meta.path,'child',root],{cwd:'/',env:{HOME:root,PATH:'/usr/bin:/bin'},stdout:'inherit',stderr:'inherit'});
  assert.equal(await child.exited,0);
 }finally{rmSync(root,{recursive:true,force:true});}
}
