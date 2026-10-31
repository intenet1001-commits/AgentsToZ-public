import {afterEach,expect,test} from 'bun:test';
import {execFileSync,spawnSync} from 'node:child_process';
import {existsSync,lstatSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PlatformCliStore} from '../src/platformCliStore';
import {PLATFORM_CLI_DEFAULT_ACCOUNT,platformCliNativeGithubId} from '../src/platformCliProtocol';
import {PLATFORM_CLI_SHELL_BEGIN,PlatformCliEverywhere,macGithubCredentialChain,platformCliGitFiles,withShellBlock} from '../src/platformCliEverywhere';

// Real git, zsh and bash in a private HOME; this Mac's own startup files and git config are never touched.
const dirs:string[]=[];afterEach(()=>{for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});});
const server=join(import.meta.dir,'..','agentstoz-use-mcp-server.ts');
const projectToken='gho_'+'e'.repeat(36);
const git=Bun.which('git')!,zsh=Bun.which('zsh'),bash='/bin/bash';

function fixture() {
  const dir=realpathSync(mkdtempSync(join(tmpdir(),'atz-cli-everywhere-')));dirs.push(dir);
  const app=join(dir,'app'),home=join(dir,'home'),bin=join(dir,'bin'),repo=join(dir,'repo'),other=join(dir,'other');
  for(const d of [app,home,bin,repo,other])mkdirSync(d,{recursive:true,mode:0o700});
  for(const d of [repo,other])execFileSync(git,['init','-q',d]);
  writeFileSync(join(app,'ports.json'),JSON.stringify([{id:'project-1',name:'Project',folderPath:repo}]));
  writeFileSync(join(bin,'gh'),`#!/bin/sh
case "$1 $2" in
  "auth status") echo '{"hosts":{"github.com":[{"state":"success","login":"fakeuser","active":true}]}}';;
  "auth token") echo '${projectToken}';;
  "api user") if [ "$GH_TOKEN" = '${projectToken}' ]; then echo '{"login":"fakeuser","id":7}'; else exit 1; fi;;
  *) echo "ran:$*:token=\${GH_TOKEN:+set}";;
esac
`,{mode:0o755});
  const launcher=join(bin,'agentstoz-use-mcp');writeFileSync(launcher,`#!/bin/sh\nexec '${process.execPath}' '${server}' "$@"\n`,{mode:0o755});
  const macHelper=join(bin,'mac-helper');writeFileSync(macHelper,'#!/bin/sh\ncat >/dev/null\n[ "$1" = get ] && printf "username=mac\\npassword=mac-keychain\\n"\nexit 0\n',{mode:0o755});
  writeFileSync(join(home,'.gitconfig'),`[user]\n\tname = Someone\n[credential]\n\thelper = ${macHelper}\n`);
  // What a fresh terminal starts with: no AgentsToZ in its environment.
  const env:NodeJS.ProcessEnv={HOME:home,PATH:`${bin}:/usr/bin:/bin`,APP_DATA_DIR:app,GIT_CONFIG_GLOBAL:join(home,'.gitconfig'),GIT_CONFIG_NOSYSTEM:'1',GIT_TERMINAL_PROMPT:'0',LANG:'en_US.UTF-8'};
  const store=new PlatformCliStore(app);
  const everywhere=new PlatformCliEverywhere({store,launcher,git,executable:p=>p==='github'?join(bin,'gh'):null,home,env,shell:'/bin/zsh',autoApply:true});
  const bind=(accountId:string)=>store.bind('project-1','github',{accountId,scope:'',resourceId:''},crypto.randomUUID());
  const shell=(program:string,args:string[],cwd=home)=>spawnSync(program,args,{cwd,env,encoding:'utf8',timeout:30_000});
  const fill=(cwd:string,host='github.com')=>spawnSync(git,['credential','fill'],{cwd,env,input:`protocol=https\nhost=${host}\n\n`,encoding:'utf8',timeout:30_000});
  return {dir,app,home,bin,repo,other,launcher,env,store,everywhere,bind,shell,fill,shims:join(app,'platform-cli-v1','shims')};
}

test('the managed block is appended last, moved back to the end, and removed without touching anything else',()=>{
  const before='export PATH="/opt/homebrew/bin:$PATH"\nalias ll="ls -l"\n',block=`${PLATFORM_CLI_SHELL_BEGIN}\nX\n# <<< AgentsToZ CLI accounts <<<`;
  const on=withShellBlock(before,block)!;expect(on).toBe(before+'\n'+block+'\n');
  expect(withShellBlock(on,block)).toBe(on);
  const later=on+'eval "$(other shellenv)"\n';expect(withShellBlock(later,block)).toBe(before+'eval "$(other shellenv)"\n\n'+block+'\n');
  expect(withShellBlock(on,null)).toBe(before);
  expect(withShellBlock(`${PLATFORM_CLI_SHELL_BEGIN}\nunfinished\n`,block)).toBeNull();
});

test('this Mac\'s own git helpers leave out AgentsToZ\'s routing, so nothing ever calls back into itself',()=>{
  const own={include:'/app/platform-cli-v1/git/github.gitconfig',helper:'/app/platform-cli-v1/git/credential-helper',launcher:'/home/.agentstoz/bin/agentstoz-use-mcp'};
  const entry=(origin:string,key:string,value:string)=>`${origin}\0${key}\n${value}\0`;
  const config=entry('file:/Library/gitconfig','credential.helper','osxkeychain')+entry('file:/home/.gitconfig','credential.https://github.com.helper','')
    +entry('file:/home/.gitconfig','credential.https://github.com.helper','!/opt/homebrew/bin/gh auth git-credential')
    +entry('file:'+own.include,'credential.https://github.com.helper','')+entry('file:'+own.include,'credential.https://github.com.helper',`!'${own.helper}'`)
    +entry('command line:','credential.https://github.com.helper',`!'${own.launcher}' git-credential`);
  expect(macGithubCredentialChain(config,own)).toEqual(['!/opt/homebrew/bin/gh auth git-credential']);
});

test('a project account applies in every new terminal and in git, outside Workrooms; elsewhere nothing changes',async()=>{
  if(!zsh)return;
  const f=fixture();
  writeFileSync(join(f.home,'.zshrc'),'# mine\nexport EDITOR=vim\n');writeFileSync(join(f.home,'.bash_profile'),'# bash user\n');
  // Nothing happens until a project has its own account.
  expect((await f.everywhere.reconcile('start')).state).toBe('pending');
  expect(existsSync(join(f.home,'.zprofile'))).toBe(false);expect(readFileSync(join(f.home,'.gitconfig'),'utf8')).not.toContain('include');

  await f.bind(platformCliNativeGithubId('fakeuser'));
  const on=await f.everywhere.reconcile('bind');
  expect(on).toMatchObject({state:'on',git:true});expect(on.shell).toEqual(['~/.zprofile','~/.zshrc','~/.bash_profile']);
  expect(readFileSync(join(f.home,'.zshrc'),'utf8').startsWith('# mine\nexport EDITOR=vim\n\n'+PLATFORM_CLI_SHELL_BEGIN)).toBe(true);
  expect(existsSync(join(f.home,'.bashrc'))).toBe(false);

  // Login shells (Terminal, an AI app's `zsh -lc`), interactive shells (an IDE terminal) and bash all find the shim first.
  for(const [program,args] of [[zsh,['-lc','command -v gh']],[zsh,['-ic','command -v gh']],[bash,['-lc','command -v gh']]] as const)
    expect(f.shell(program,[...args]).stdout.trim()).toBe(join(f.shims,'gh'));
  expect(f.shell(zsh,['-lc','gh pr list'],f.repo).stdout.trim()).toBe('ran:pr list:token=set');
  expect(f.shell(zsh,['-lc','gh pr list'],f.other).stdout.trim()).toBe('ran:pr list:token=');
  const reveal=f.shell(zsh,['-lc','gh auth token'],f.repo);expect(reveal.stdout).not.toContain(projectToken);expect(reveal.status).not.toBe(0);

  // git from any terminal or app: the project's account in its folder, this Mac's helpers everywhere else.
  expect(f.fill(f.repo).stdout).toContain(`password=${projectToken}`);
  expect(f.fill(f.other).stdout).toContain('password=mac-keychain');
  expect(f.fill(f.repo,'gitlab.com').stdout).toContain('password=mac-keychain');

  // Following this Mac again applies to the next command, with nothing rewritten.
  const zshrc=readFileSync(join(f.home,'.zshrc'),'utf8');
  await f.bind(PLATFORM_CLI_DEFAULT_ACCOUNT);
  expect(f.shell(zsh,['-lc','gh pr list'],f.repo).stdout.trim()).toBe('ran:pr list:token=');
  expect(f.fill(f.repo).stdout).toContain('password=mac-keychain');
  await f.everywhere.reconcile('start');expect(readFileSync(join(f.home,'.zshrc'),'utf8')).toBe(zshrc);
},60_000);

test('later tools cannot quietly take priority, a symlinked startup file stays a link, and off restores everything',async()=>{
  const f=fixture();
  const real=join(f.dir,'dotfiles-zshrc');writeFileSync(real,'# managed elsewhere\n');symlinkSync(real,join(f.home,'.zshrc'));
  const gitconfig=readFileSync(join(f.home,'.gitconfig'),'utf8');
  await f.bind(platformCliNativeGithubId('fakeuser'));await f.everywhere.reconcile('bind');
  expect(lstatSync(join(f.home,'.zshrc')).isSymbolicLink()).toBe(true);expect(readFileSync(real,'utf8')).toContain(PLATFORM_CLI_SHELL_BEGIN);

  // Another tool adds its own github.com helper after AgentsToZ (as `gh auth setup-git` does), and a PATH line after the block.
  execFileSync(git,['config','--global','--add','credential.https://github.com.helper',''],{env:f.env});
  execFileSync(git,['config','--global','--add','credential.https://github.com.helper','!other-helper'],{env:f.env});
  writeFileSync(real,readFileSync(real,'utf8')+'export PATH="/elsewhere:$PATH"\n');
  expect((await f.everywhere.status()).state).toBe('partial');
  expect((await f.everywhere.reconcile('git-setup')).state).toBe('on');
  expect(readFileSync(real,'utf8').trimEnd().endsWith('# <<< AgentsToZ CLI accounts <<<')).toBe(true);
  expect(f.fill(f.repo).stdout).toContain(`password=${projectToken}`);

  // Off: AgentsToZ's block, include and files are gone; git uses this Mac's helpers again, also for the project.
  const off=await f.everywhere.set(false);expect(off).toMatchObject({state:'off',git:false,shell:[]});
  expect(readFileSync(real,'utf8')).toBe('# managed elsewhere\nexport PATH="/elsewhere:$PATH"\n');
  expect(readFileSync(join(f.home,'.gitconfig'),'utf8')).not.toContain('platform-cli-v1');
  expect(readFileSync(join(f.home,'.gitconfig'),'utf8').startsWith(gitconfig)).toBe(true);
  expect(existsSync(platformCliGitFiles(join(f.app,'platform-cli-v1')).helper)).toBe(false);
  // A new binding does not turn it back on once the person turned it off.
  await f.bind(platformCliNativeGithubId('fakeuser'));expect((await f.everywhere.reconcile('bind')).state).toBe('off');
  expect(f.fill(f.repo).stdout).not.toContain(projectToken);
},60_000);

test('without AgentsToZ the git helper falls back to this Mac\'s own helpers instead of breaking git',async()=>{
  const f=fixture();
  await f.bind(platformCliNativeGithubId('fakeuser'));await f.everywhere.reconcile('bind');
  rmSync(f.launcher);
  expect(f.fill(f.other).stdout).toContain('password=mac-keychain');
},60_000);
