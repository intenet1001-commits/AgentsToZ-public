import {afterEach, expect, test} from 'bun:test';
import {chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CliAccountStore} from '../src/cliAccountStore';
import {CliAccountManager, classifyCliAccountProbe, cliAccountEnvironment, type CliAccountLogin} from '../src/cliAccountManager';
import {HOST_CLI_ACCOUNT_ID, normalizeCliAccountAdminRequest} from '../src/cliAccountProtocol';
import {AiTerminalService} from '../src/aiTerminalService';
import {normalizeAiTerminalRequest, normalizeAiTerminalResponse} from '../src/aiTerminalProtocol';
import {createAiTerminalRemoteGateway} from '../src/aiTerminalRemoteGateway';
import {parseAgentsToZUseActionRequest} from '../src/agentstozUseControl';
import {AGENTSTOZ_USE_MCP_TOOLS, agentsToZUseMcpActionForTool} from '../agentstoz-use-mcp-server';

const dirs:string[]=[], services:AiTerminalService[]=[], managers:CliAccountManager[]=[];
afterEach(async()=>{await Promise.all(services.splice(0).map(s=>s.shutdown()));await Promise.all(managers.splice(0).map(m=>m.shutdown()));for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
function fixture() {const dir=mkdtempSync(join(tmpdir(),'atz-accounts-'));dirs.push(dir);return {dir,store:new CliAccountStore(dir)};}
const rid=()=>crypto.randomUUID();
const project='project-account-one', other='project-account-two';
test('listing does not create files or inspect/copy the existing host credentials',()=>{
  const {dir,store}=fixture();const host=join(dir,'host-auth');writeFileSync(host,'PRIVATE');
  const manager=new CliAccountManager({store,executable:()=>null});managers.push(manager);
  expect(manager.list('codex')).toEqual([{id:HOST_CLI_ACCOUNT_ID,agent:'codex',label:'현재 CLI 계정',authState:'unknown',checkedAt:null,loginState:'idle'}]);
  expect(store.selected(project,'codex')).toBe(HOST_CLI_ACCOUNT_ID);
  expect(existsSync(store.root)).toBe(false);expect(readFileSync(host,'utf8')).toBe('PRIVATE');
});
test('concurrent registration and a retry after restart create one isolated account',async()=>{
  const {store}=fixture(), requestId=rid();
  const accounts=await Promise.all([store.create('codex','업무',requestId),new CliAccountStore(store.root+'/..').create('codex','업무',requestId)]);
  expect(accounts[0]!.id).toBe(accounts[1]!.id);expect(store.profiles('codex')).toHaveLength(1);
  expect(lstatSync(store.directory(accounts[0]!.id)).isDirectory()).toBe(true);
  if(process.platform!=='win32'){expect(lstatSync(store.file).mode&0o777).toBe(0o600);expect(lstatSync(store.root).mode&0o777).toBe(0o700);}
  await expect(store.create('claude','다른 계정',requestId)).rejects.toThrow('요청 ID');
});
test('selection persists per project and CLI, and retry cannot reverse a later selection',async()=>{
  const {dir,store}=fixture();const a=await store.create('codex','A',rid()),b=await store.create('codex','B',rid()),c=await store.create('claude','C',rid()), switchId=rid();
  await store.select(project,'codex',a.id,switchId);await store.select(project,'codex',b.id,rid());
  await new CliAccountStore(dir).select(project,'codex',a.id,switchId);
  expect(store.selected(project,'codex')).toBe(b.id);expect(store.selected(other,'codex')).toBe(HOST_CLI_ACCOUNT_ID);expect(store.selected(project,'claude')).toBe(HOST_CLI_ACCOUNT_ID);
  await expect(store.select(project,'codex',c.id,rid())).rejects.toThrow('CLI');
  await expect(store.select(project,'codex','../../auth.json',rid())).rejects.toThrow();
  await store.edit(b.id,null,rid(),()=>false);expect(store.selected(project,'codex')).toBe(HOST_CLI_ACCOUNT_ID);
  expect(existsSync(join(store.root,b.id))).toBe(true); // archival never deletes provider credentials/history.
});
test('in-use accounts cannot be archived, and duplicate labels cannot silently change identity',async()=>{
  const {store}=fixture();const a=await store.create('claude','A',rid());await store.create('claude','B',rid());
  await expect(store.edit(a.id,null,rid(),()=>true)).rejects.toThrow('실행 중');
  await expect(store.edit(a.id,'B',rid(),()=>false)).rejects.toThrow('계정 이름');
  await store.edit(a.id,'회사',rid(),()=>false);expect(store.record(a.id).label).toBe('회사');
});
test('unsafe credential files, directory replacement and registry symlinks fail closed',async()=>{
  if(process.platform==='win32')return;
  const {dir,store}=fixture();const a=await store.create('codex','A',rid()),path=store.directory(a.id);
  const secret=join(path,'auth.json');writeFileSync(secret,'PRIVATE',{mode:0o644});
  expect(()=>store.directory(a.id)).toThrow('접근 권한');chmodSync(secret,0o600);
  renameSync(path,path+'.old');mkdirSync(path,{mode:0o700});expect(()=>store.directory(a.id)).toThrow('변경');
  renameSync(store.file,store.file+'.old');symlinkSync(store.file+'.old',store.file);expect(()=>store.profiles('codex')).toThrow('읽을 수');
  expect(readFileSync(join(dir,'cli-accounts-v1',a.id+'.old','auth.json'),'utf8')).toBe('PRIVATE');
});
test('provider tokens, alternate gateways and sidecar capabilities do not override an explicit account',()=>{
  const env=cliAccountEnvironment('claude','/private/profile',{HOME:'/user',PATH:'/bin',OPENAI_API_KEY:'SECRET',CODEX_HOME:'/old',ANTHROPIC_API_KEY:'SECRET',CLAUDE_CODE_OAUTH_TOKEN:'SECRET',CLAUDE_CODE_USE_BEDROCK:'1',ANTHROPIC_BASE_URL:'https://example.invalid',AGENTSTOZ_RUNTIME_CAPABILITY:'SECRET',SUPABASE_SERVICE_ROLE_KEY:'SECRET',SSH_TTY:'tty'});
  expect(env).toEqual({HOME:'/user',PATH:'/bin',CLAUDE_CONFIG_DIR:'/private/profile',LANG:'en_US.UTF-8'});
});
test('only verified subscription login status counts; provider output cannot enter a public summary',()=>{
  expect(classifyCliAccountProbe('codex',true,'Logged in using ChatGPT\n')).toBe('signed-in');
  expect(classifyCliAccountProbe('codex',false,'Not logged in')).toBe('signed-out');
  expect(classifyCliAccountProbe('codex',true,'Logged in using an API key: SECRET')).toBe('unknown');
  expect(classifyCliAccountProbe('claude',true,JSON.stringify({loggedIn:true,authMethod:'claude.ai',email:'private@example.com',token:'SECRET'}))).toBe('signed-in');
  expect(classifyCliAccountProbe('claude',true,JSON.stringify({loggedIn:true,authMethod:'api_key'}))).toBe('unknown');
  expect(classifyCliAccountProbe('claude',false,'broken SECRET')).toBe('unknown');
});
test('login is single-flight, cancellation is not success, and registration stays after restart',async()=>{
  const {store}=fixture();const a=await store.create('codex','A',rid()),b=await store.create('claude','B',rid());let finish!:(v:boolean)=>void, starts=0;
  const manager=new CliAccountManager({store,executable:()=>'/fixture/cli',probe:async()=> 'signed-in',login:()=>{starts++;const finished=new Promise<boolean>(r=>finish=r);return {finished,stop:async()=>{finish(false);await finished;}};}});managers.push(manager);
  const login={operation:'login',accountId:a.id,requestId:rid()};await manager.manage(login);await manager.manage(login);expect(starts).toBe(1);
  await expect(manager.manage({operation:'login',accountId:b.id,requestId:rid()})).rejects.toThrow('진행 중');
  await manager.manage({operation:'cancel-login',accountId:a.id,requestId:rid()});expect(manager.list('codex')[1]).toMatchObject({authState:'unknown',loginState:'failed'});
  expect(JSON.stringify(manager.list('codex'))).not.toContain(store.root);
  expect(new CliAccountManager({store,executable:()=>null}).list('codex')[1]).toMatchObject({id:a.id,authState:'unknown',loginState:'idle'});
});
function terminalFixture(probeGate?:()=>Promise<void>,login?:()=>CliAccountLogin) {
  const {dir,store}=fixture();let pid=100_000;const children=new Map<number,()=>void>();const launches:{args:string[];env:Record<string,string|undefined>}[]=[];
  let service:AiTerminalService;
  const manager=new CliAccountManager({store,executable:()=>'/fixture/cli',probe:async()=>{await probeGate?.();return 'signed-in';},inUse:id=>service.accountInUse(id),login});managers.push(manager);
  service=new AiTerminalService({accounts:manager,resolveTarget:async id=>{if(![project,other].includes(id))throw Error('unregistered');return {cwd:dir};},executable:()=>'/fixture/cli',env:{HOME:dir,OPENAI_API_KEY:'HOST_SECRET'},headlessScreen:false,codexHookTrustSupported:async()=>false,resume:async()=>null,
    signalGroup:p=>children.get(p)?.(),spawn:(args,options:any)=>{
      const n=++pid;launches.push({args,env:options.env});let finish!:(v:number)=>void;const exited=new Promise<number>(r=>finish=r);
      const stop=()=>{finish(0);options.terminal.exit();};children.set(n,stop);
      return {pid:n,exited,kill:stop,terminal:{write:s=>s.length,resize:()=>{},close:()=>{}}};
    }});services.push(service);
  const call=(r:object)=>service.perform({requestId:rid(),...r});
  const start=(accountId?:string)=>call({operation:'start',targetId:project,agent:'codex',cols:80,rows:24,...(accountId?{accountId}:{})});
  return {store,manager,service,launches,call,start};
}
test('new starts use the selected profile; running sessions and restart keep their original account',async()=>{
  const f=terminalFixture(),a=await f.store.create('codex','A',rid()),b=await f.store.create('codex','B',rid());
  const host=(await f.start()).session!;expect(f.launches[0]!.env.OPENAI_API_KEY).toBe('HOST_SECRET');
  await f.call({operation:'accounts',accountAction:'select',targetId:project,agent:'codex',accountId:a.id});
  const first=(await f.start()).session!;expect(first).toMatchObject({accountId:a.id,accountLabel:'A'});expect(f.launches[1]!.env.OPENAI_API_KEY).toBeUndefined();
  expect(f.launches[1]!.env.CODEX_HOME).toBe(f.store.directory(a.id));expect(f.launches[1]!.args).toContain('cli_auth_credentials_store="file"');
  await f.call({operation:'accounts',accountAction:'select',targetId:project,agent:'codex',accountId:b.id});
  const second=(await f.start()).session!;expect(second.accountId).toBe(b.id);expect(f.service.runningSession(first.id)?.accountId).toBe(a.id);
  const restarted=await f.call({operation:'start',targetId:project,agent:'codex',cols:80,rows:24,resumeFrom:first.id});
  expect(restarted.session?.accountId).toBe(a.id);expect(f.launches.at(-1)!.env.CODEX_HOME).toBe(f.store.directory(a.id));
  expect(f.service.runningSession(host.id)?.accountId).toBe(HOST_CLI_ACCOUNT_ID);
  await expect(f.manager.manage({operation:'archive',accountId:b.id,requestId:rid()})).rejects.toThrow('실행 중');
  normalizeAiTerminalResponse(await f.call({operation:'accounts',accountAction:'list',targetId:project,agent:'codex'}));
});
test('restricted host-only launches cannot inherit a project account choice',async()=>{
  const f=terminalFixture(),a=await f.store.create('claude','A',rid());await f.store.select(project,'claude',a.id,rid());
  const r=await f.service.perform({operation:'start',requestId:rid(),targetId:project,agent:'claude',cols:80,rows:24},undefined,{launchProfile:{permissionMode:'dontAsk',tools:[],allowedTools:[],disallowedTools:[]}});
  expect(r.session!.accountId).toBe(HOST_CLI_ACCOUNT_ID);expect(f.launches[0]!.env.CLAUDE_CONFIG_DIR).toBeUndefined();
});
test('remote account access requires its separate grant and uses the mapped project on the host',async()=>{
  const f=terminalFixture();let granted=false,active=true;
  const gateway=createAiTerminalRemoteGateway({service:f.service,active:()=>active,resolve:async()=>[{controlId:'control-account-one',runtimeTargetId:project}],consent:async()=>({targetIds:new Set([project]),workspaceScopes:granted?['account.select']:[],isActive:()=>active})});
  const request={operation:'accounts' as const,accountAction:'list' as const,requestId:rid(),agent:'codex' as const,targetId:'control-account-one'};
  await expect(gateway(request,[],'owner')).rejects.toThrow('별도로');granted=true;
  const r=await gateway(request,[],'owner');expect(r.accounts?.selectedAccountId).toBe(HOST_CLI_ACCOUNT_ID);expect(JSON.stringify(r)).not.toContain(f.store.root);
  await expect(gateway({...request,targetId:other},[],'owner')).rejects.toThrow();active=false;await expect(gateway(request,[],'owner')).rejects.toThrow();
});
test('revocation during the login-status probe prevents the selection write and any new process',async()=>{
  let release!:()=>void;let reached!:()=>void;const waiting=new Promise<void>(r=>release=r),seen=new Promise<void>(r=>reached=r);
  const f=terminalFixture(async()=>{reached();await waiting;}),a=await f.store.create('codex','A',rid());let granted=true;
  const result=f.service.perform({operation:'accounts',accountAction:'select',targetId:project,agent:'codex',accountId:a.id,requestId:rid()},
    {owner:'remote-owner',targets:new Set([project]),deviceConsentActive:()=>true,isActive:()=>true,accountSelectionAllowed:()=>granted});
  await seen;granted=false;release();await expect(result).rejects.toThrow('권한');expect(f.store.selected(project,'codex')).toBe(HOST_CLI_ACCOUNT_ID);expect(f.launches).toHaveLength(0);
});
test('wire requests refuse paths, credentials, unsupported agents and account changes on resume',()=>{
  const r={operation:'accounts',accountAction:'list',targetId:project,agent:'codex',requestId:rid()};normalizeAiTerminalRequest(r);
  for(const bad of [{...r,path:'/private'},{...r,token:'SECRET'},{...r,agent:'hermes'},{...r,accountId:HOST_CLI_ACCOUNT_ID},{...r,accountAction:'select'}])expect(()=>normalizeAiTerminalRequest(bad)).toThrow();
  expect(()=>normalizeCliAccountAdminRequest({operation:'login',accountId:HOST_CLI_ACCOUNT_ID,requestId:rid(),env:{TOKEN:'SECRET'}})).toThrow();
  expect(()=>normalizeAiTerminalRequest({operation:'start',targetId:project,agent:'codex',requestId:rid(),cols:80,rows:24,resumeFrom:'session-example',accountId:HOST_CLI_ACCOUNT_ID})).toThrow();
});
test('legacy remote requests keep the strict v1 session shape after a host account feature upgrade',async()=>{
  const f=terminalFixture();const gateway=createAiTerminalRemoteGateway({service:f.service,active:()=>true,resolve:async()=>[{controlId:'control-account-one',runtimeTargetId:project}],consent:async()=>({targetIds:new Set([project]),workspaceScopes:['account.select'],isActive:()=>true})});
  const r=await gateway({operation:'start',targetId:'control-account-one',agent:'codex',cols:80,rows:24,requestId:rid()},[],'owner');
  expect(r.session?.targetId).toBe('control-account-one');expect(r.session).not.toHaveProperty('accountId');expect(r.session).not.toHaveProperty('accountLabel');
  const explicit=await gateway({operation:'start',targetId:'control-account-one',agent:'codex',cols:80,rows:24,accountId:HOST_CLI_ACCOUNT_ID,requestId:rid()},[],'owner');
  expect(explicit.session).toMatchObject({accountId:HOST_CLI_ACCOUNT_ID});
});
test('a login admitted during a pending account probe cannot race a new session into that profile',async()=>{
  let release!:()=>void,reached!:()=>void,finish!:(ok:boolean)=>void;
  const gate=new Promise<void>(r=>release=r),seen=new Promise<void>(r=>reached=r),finished=new Promise<boolean>(r=>finish=r);
  const f=terminalFixture(async()=>{reached();await gate;},()=>({finished,stop:async()=>{finish(false);await finished;}}));
  const a=await f.store.create('codex','A',rid());const start=f.start(a.id);await seen;
  await f.manager.manage({operation:'login',accountId:a.id,requestId:rid()});release();
  await expect(start).rejects.toThrow('로그인');expect(f.launches).toHaveLength(0);
  await f.manager.manage({operation:'cancel-login',accountId:a.id,requestId:rid()});
});
test('MCP exposes only registered account metadata and selection; start accepts an explicit account ID',()=>{
  expect(AGENTSTOZ_USE_MCP_TOOLS.map(t=>t.name)).toContain('agentstoz_use_select_workroom_account');
  const args={portId:project,agent:'codex',accountId:HOST_CLI_ACCOUNT_ID,requestId:rid()};
  const r=agentsToZUseMcpActionForTool('agentstoz_use_select_workroom_account',args,'controller-fixture');expect(parseAgentsToZUseActionRequest(r)).toMatchObject({action:'select-workroom-account',accountId:HOST_CLI_ACCOUNT_ID});
  expect(parseAgentsToZUseActionRequest(agentsToZUseMcpActionForTool('agentstoz_use_start_workroom_session',args,'controller-fixture'))).toMatchObject({accountId:HOST_CLI_ACCOUNT_ID});
  expect(()=>agentsToZUseMcpActionForTool('agentstoz_use_select_workroom_account',{...args,token:'SECRET'},'controller-fixture')).toThrow();
  expect(()=>parseAgentsToZUseActionRequest({...r,accountId:'../../secret'})).toThrow();
});
