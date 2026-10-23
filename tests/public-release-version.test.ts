import {afterEach, expect, test} from 'bun:test';
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {deriveBuildNumber, gitRunner, readBuildNumberFile} from '../buildVersion';
import {createBuildInfo} from '../build-info';
import {PUBLIC_RELEASE_VERSION_FILES, publicReleaseVersionFiles} from '../src/publicReleaseVersion';

const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
const git=(root:string,args:string[])=>{const r=gitRunner(root)(args);if(r.exitCode)throw Error(r.stderr);return r.stdout.trim();};
const sources=()=>new Map(PUBLIC_RELEASE_VERSION_FILES.map(path=>[path,readFileSync(resolve(import.meta.dir,'..',path),'utf8')]));

test('a published orphan keeps the exact source build number without needing private ancestry',()=>{
  const root=mkdtempSync(join(tmpdir(),'atz-public-version-'));roots.push(root);
  git(root,['init','-b','main']);git(root,['config','user.name','Test']);git(root,['config','user.email','test@example.com']);
  writeFileSync(join(root,'README.md'),'initial\n');git(root,['add','.']);git(root,['commit','-m','anchor']);
  const anchor=git(root,['rev-parse','HEAD']);
  for(const [path,text]of sources()){
    mkdirSync(dirname(join(root,path)),{recursive:true});
    writeFileSync(join(root,path),path==='build-number.json'?JSON.stringify({buildNumber:100,baseCommit:anchor}):text);
  }
  git(root,['add','.']);git(root,['commit','-m','release']);
  git(root,['remote','add','publish','https://github.com/example/public.git']);
  const original=readFileSync(join(root,'build-number.json'),'utf8');
  const r=Bun.spawnSync([process.execPath,resolve(import.meta.dir,'../scripts/publish.ts'),'--dry-run'],{cwd:root,stdout:'pipe',stderr:'pipe'});
  expect(r.exitCode,r.stderr.toString()).toBe(0);
  const candidate=/candidate: [^ ]+ @ ([0-9a-f]{40})/.exec(r.stdout.toString())![1]!;
  expect(git(root,['show','-s','--format=%P',candidate])).toBe('');
  const checkout=join(root,'public');git(root,['worktree','add','--detach',checkout,candidate]);
  expect(readBuildNumberFile(checkout)).toEqual({buildNumber:101});
  expect(deriveBuildNumber(readBuildNumberFile(checkout),gitRunner(checkout))).toMatchObject({ok:true,buildNumber:101});
  expect(createBuildInfo({root:checkout,command:'build'})).toMatchObject({version:'101.0.0',buildNumber:101});
  for(const path of ['src-tauri/Cargo.toml','src-tauri/Cargo.lock','src-tauri/windows-contain/Cargo.lock'])expect(readFileSync(join(checkout,path),'utf8')).toContain('version = "101.0.0"');
  expect(readFileSync(join(root,'build-number.json'),'utf8')).toBe(original);
});

test('missing or changed version fields stop publication rather than silently shipping stale versions',()=>{
  const files=sources();files.delete('src-tauri/Cargo.lock');
  expect(()=>publicReleaseVersionFiles(100,files)).toThrow('missing');
  const changed=sources();changed.set('src-tauri/Cargo.lock','[[package]]\nname = "other"\nversion = "1.0.0"');
  expect(()=>publicReleaseVersionFiles(100,changed)).toThrow('field count');
  for(const number of [0,-1,1.5,Infinity])expect(()=>publicReleaseVersionFiles(number,sources())).toThrow();
});
