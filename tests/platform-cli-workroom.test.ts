import {afterEach,expect,test} from 'bun:test';
import {execFileSync,spawnSync} from 'node:child_process';
import {chmodSync,existsSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,rmSync,statSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PlatformCliStore} from '../src/platformCliStore';
import {PLATFORM_CLI_DEFAULT_ACCOUNT,platformCliNativeGithubId} from '../src/platformCliProtocol';
import {PLATFORM_CLI_SHIM_DIR_ENV,PLATFORM_GIT_FALLBACK_ENV,githubCredentialChain,gitHelperCommand,platformCliRevealsToken,platformCliWorkroomEnvironment,preparePlatformCliShims} from '../src/platformCliWorkroom';

const dirs:string[]=[];afterEach(()=>{for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});});
const server=join(import.meta.dir,'..','agentstoz-use-mcp-server.ts');
const projectToken='gho_'+'f'.repeat(36);
const git=Bun.which('git')!;

/** A registered project with a fake gh (one login, `fakeuser`) and the launcher a Workroom would use. */
function fixture() {
  const dir=realpathSync(mkdtempSync(join(tmpdir(),'atz-cli-workroom-')));dirs.push(dir);
  const app=join(dir,'app'),repo=join(dir,'repo'),bin=join(dir,'bin'),home=join(dir,'home');
  for(const d of [app,repo,bin,home])mkdirSync(d,{recursive:true,mode:0o700});
  execFileSync(git,['init','-q'],{cwd:repo});
  writeFileSync(join(app,'ports.json'),JSON.stringify([{id:'project-1',name:'Project',folderPath:repo}]));
  writeFileSync(join(bin,'gh'),`#!/bin/sh
case "$1 $2" in
  "auth status") echo '{"hosts":{"github.com":[{"state":"success","login":"fakeuser","active":true}]}}';;
  "auth token") echo '${projectToken}';;
  "api user") if [ "$GH_TOKEN" = '${projectToken}' ]; then echo '{"login":"fakeuser","id":7}'; else exit 1; fi;;
  *) echo "ran:$*:token=\${GH_TOKEN:+set}";;
esac
`,{mode:0o755});
  // What `~/.agentstoz/bin/agentstoz-use-mcp` does: run the real binary with the same arguments.
  const launcher=join(bin,'agentstoz-use-mcp');
  writeFileSync(launcher,`#!/bin/sh\nexec '${process.execPath}' '${server}' "$@"\n`,{mode:0o755});
  const env={...process.env,APP_DATA_DIR:app,HOME:home,PATH:`${bin}:${process.env.PATH}`,GIT_CONFIG_GLOBAL:join(home,'.gitconfig'),GIT_CONFIG_NOSYSTEM:'1',GIT_TERMINAL_PROMPT:'0'};
  delete (env as Record<string,unknown>).GH_TOKEN;delete (env as Record<string,unknown>).GITHUB_TOKEN;delete (env as Record<string,unknown>).GIT_CONFIG_COUNT;
  const bind=(accountId:string)=>new PlatformCliStore(app).bind('project-1','github',{accountId,scope:'',resourceId:''},crypto.randomUUID());
  return {dir,app,repo,bin,home,launcher,env,bind};
}
async function workroomEnv(f:ReturnType<typeof fixture>) {
  const patch=await platformCliWorkroomEnvironment({shimDirectory:join(f.app,'platform-cli-v1','shims'),launcher:f.launcher,cwd:f.repo,env:f.env,git,executable:p=>p==='github'?join(f.bin,'gh'):null});
  return {...f.env,...patch};
}
const fill=(env:NodeJS.ProcessEnv,cwd:string)=>spawnSync(git,['credential','fill'],{cwd,env,input:'protocol=https\nhost=github.com\n\n',encoding:'utf8',timeout:30_000});

test('helper chains, helper commands and token-revealing gh commands are read the way git and gh do',()=>{
  expect(githubCredentialChain('credential.helper\nosxkeychain\0credential.https://gitlab.com.helper\nstore\0')).toEqual(['osxkeychain']);
  expect(githubCredentialChain('credential.helper\nosxkeychain\0credential.https://github.com.helper\n\0credential.https://github.com.helper\n!gh auth git-credential\0')).toEqual(['!gh auth git-credential']);
  expect(gitHelperCommand('osxkeychain')).toBe('git credential-osxkeychain');
  expect(gitHelperCommand('cache --timeout=60')).toBe('git credential-cache --timeout=60');
  expect(gitHelperCommand('!gh auth git-credential')).toBe('gh auth git-credential');
  expect(gitHelperCommand('/opt/bin/helper --x')).toBe('/opt/bin/helper --x');
  for(const args of [['auth','token'],['auth','git-credential','get'],['auth','status','-t'],['auth','status','--show-token'],['auth','status','-ht']])expect(platformCliRevealsToken('github',args)).toBe(true);
  for(const args of [['auth','status'],['pr','list'],['api','user']])expect(platformCliRevealsToken('github',args)).toBe(false);
  expect(platformCliRevealsToken('supabase',['auth','token'])).toBe(false);
});

test('a Workroom gets shims first on PATH and git\'s github.com helper after its own config, with no token',async()=>{
  const f=fixture();
  writeFileSync(join(f.home,'.gitconfig'),'[credential]\n\thelper = osxkeychain\n');
  const patch=await platformCliWorkroomEnvironment({shimDirectory:join(f.app,'platform-cli-v1','shims'),launcher:f.launcher,cwd:f.repo,env:{...f.env,GIT_CONFIG_COUNT:'1',GIT_CONFIG_KEY_0:'user.name',GIT_CONFIG_VALUE_0:'x'},git,executable:p=>p==='github'?join(f.bin,'gh'):null});
  const shims=join(f.app,'platform-cli-v1','shims');
  expect(patch.PATH!.split(':')[0]).toBe(shims);expect(patch[PLATFORM_CLI_SHIM_DIR_ENV]).toBe(shims);
  expect(patch).toMatchObject({GIT_CONFIG_COUNT:'3',GIT_CONFIG_KEY_1:'credential.https://github.com.helper',GIT_CONFIG_VALUE_1:'',GIT_CONFIG_KEY_2:'credential.https://github.com.helper'});
  expect(patch.GIT_CONFIG_VALUE_2).toContain('git-credential');
  expect(JSON.parse(patch[PLATFORM_GIT_FALLBACK_ENV]!)).toEqual(['osxkeychain']);
  expect(JSON.stringify(patch)).not.toContain(projectToken);
  // Only installed CLIs get a shim; the shim names the real CLI and falls back to it without the launcher.
  expect(existsSync(join(shims,'gh'))).toBe(true);expect(existsSync(join(shims,'vercel'))).toBe(false);
  expect(statSync(join(shims,'gh')).mode&0o111).not.toBe(0);
  expect(readFileSync(join(shims,'gh'),'utf8')).toContain(`exec '${join(f.bin,'gh')}' "$@"`);
  expect(preparePlatformCliShims(shims,join(f.dir,'missing-launcher'),()=>join(f.bin,'gh'))).toBeNull();
});

test('gh in a Workroom uses the project\'s own account, else runs untouched, and never prints the token',async()=>{
  const f=fixture(),env=await workroomEnv(f),shim=join(f.app,'platform-cli-v1','shims','gh');
  const gh=(...args:string[])=>spawnSync(shim,args,{cwd:f.repo,env,encoding:'utf8',timeout:30_000});
  // Following this Mac: the real CLI, exactly as typed.
  expect(gh('pr','list').stdout.trim()).toBe('ran:pr list:token=');
  await f.bind(platformCliNativeGithubId('fakeuser'));
  expect(gh('pr','list').stdout.trim()).toBe('ran:pr list:token=set');
  const token=gh('auth','token');
  expect(token.status).toBe(1);expect(token.stdout+token.stderr).not.toContain(projectToken);expect(token.stderr).toContain('보여주지 않습니다');
  // Back to this Mac: applies to the very next command, no Workroom restart.
  await f.bind(PLATFORM_CLI_DEFAULT_ACCOUNT);
  expect(gh('pr','list').stdout.trim()).toBe('ran:pr list:token=');
},60_000);

test('git push asks the project account first and this Mac\'s own helpers otherwise; a broken account never falls through',async()=>{
  const f=fixture();
  const helper=join(f.bin,'mac-helper');writeFileSync(helper,'#!/bin/sh\ncat >/dev/null\n[ "$1" = get ] && printf "username=mac\\npassword=mac-keychain\\n"\nexit 0\n',{mode:0o755});chmodSync(helper,0o755);
  writeFileSync(join(f.home,'.gitconfig'),`[credential]\n\thelper = ${helper}\n`);
  const env=await workroomEnv(f);
  expect(fill(env,f.repo).stdout).toContain('password=mac-keychain');
  await f.bind(platformCliNativeGithubId('fakeuser'));
  const bound=fill(env,f.repo);
  expect(bound.stdout).toContain(`password=${projectToken}`);expect(bound.stdout).toContain('username=fakeuser');
  // Another host is not the project's GitHub account.
  expect(spawnSync(git,['credential','fill'],{cwd:f.repo,env,input:'protocol=https\nhost=gitlab.com\n\n',encoding:'utf8'}).stdout).toContain('password=mac-keychain');
  // The login behind the binding is gone: git stops instead of using this Mac's other account.
  writeFileSync(join(f.bin,'gh'),'#!/bin/sh\necho \'{"hosts":{"github.com":[]}}\'\n',{mode:0o755});
  const broken=fill(env,f.repo);
  expect(broken.status).not.toBe(0);expect(broken.stdout).not.toContain('mac-keychain');expect(broken.stderr).toContain('GitHub 계정');
},60_000);
