/** Actual iOS WKWebView + shipped Mac LAN page + real WS/PTY, on a disposable
 * simulator with fake registered targets/CLI only. No app data, API3001 or AI.
 *
 *   bun scripts/emulator-e2e.ts j1-pty                                    owned simulator (emulator lane J1-LAN-PTY)
 *   bun mobile/ios/scripts/check-workroom.ts --compile-only [simulator|device]   the compile step only; nothing starts
 *   bun mobile/ios/scripts/check-workroom.ts --device <id> <signed-isolated-app> <signing identity>
 *   --evidence-dir <new folder>  where run-status.json and the screenshots go (default mobile/ios/build/workroom-evidence,
 *                                or workroom-device-evidence for --device). A given folder must be new, empty, or hold an earlier run's evidence.
 *   --portal-url <https origin>  explicit anonymous portal smoke. The simulator run never reads an inherited
 *                                AGENTSTOZ_IOS_PORTAL_URL; the device run still honours it (NATIVE-EXECUTION.md).
 *   --lan-address <private IPv4> --lan-ports <server>,<foreign>,<redirect>
 *                                where the three LAN listeners bind (the pairing server, a foreign origin and a redirect
 *                                to it). Required for the simulator journey; the j1-pty lane passes them.
 *
 * The simulator journey binds a live pairing listener on the LAN and runs a PTY and Python, so it starts only inside
 * the emulator harness sandbox (design §2.3): scripts/emulator-e2e/workroomPty.ts runs it under WP1's profile with
 * LAN inbound declared on the three ports, asserts with lsof that nothing else listens off loopback, and this
 * script refuses to start unless the OS confirms a sandbox that also refuses a write into the worktree.
 * Isolation: the script runs itself again with an environment built from empty — scratch HOME, TMPDIR and app data
 * outside the real home, a plain PATH — and only that child imports the host modules. The simulator is
 * created in an owned device set inside the scratch root, so Simulator.app never shows it and no existing simulator
 * is touched; it is deleted at the end and the deletion is verified.
 *
 * Exit 0 passed, 1 failed (or refused), 78 blocked (a missing capability). run-status.json (state passed | failed |
 * blocked) is replaced with `failed` before any check can refuse, so an earlier run's verdict never outlives this one.
 * A pass also needs design §2.5's three isolation facts: earlier simulators unchanged, the owned one deleted, and no
 * new Simulator.app. TMPDIR must resolve outside the real home. */
import {mkdtempSync, mkdirSync, chmodSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, cpSync, realpathSync} from 'node:fs';
import {tmpdir, homedir, networkInterfaces} from 'node:os';
import {resolve, join, relative, isAbsolute, dirname} from 'node:path';
import {createHash} from 'node:crypto';
import type {RemoteControlLanServer} from '../../../src/remoteControlLanServer';
import type {AiTerminalService} from '../../../src/aiTerminalService';
import type {TesterAgentHost} from '../../../src/testerAgentHost';
import {USAGE,UsageError,bestEffortEvidenceDir,claimEvidenceDir,evidenceDirFor,isolationFailures,parseCheckWorkroomArgs,processSandboxed,readRunStatus,
 sandboxRefusal,settleRunStatus,startupRunStatus,sweepDeviceSet,writeRunStatus,writeProbe,BLOCKED_EXIT,type CheckWorkroomArgs} from './checkWorkroomSupport';
import {workroomFixtureCompileCommands,workroomFixtureSdk,workroomFixtureTarget} from './workroomFixtureCompile';
const root = resolve(import.meta.dir,'../../..');
const ISOLATED_ROOT='AGENTSTOZ_WORKROOM_FIXTURE_ROOT';
// The account database, not $HOME: Bun's homedir() and even userInfo().homedir follow HOME (measured), and the
// inherited HOME may already be a scratch path.
const account=Bun.spawnSync(['/usr/bin/id','-P'],{stdout:'pipe',stderr:'ignore'}).stdout.toString().trim().split(':');
const realHome=account.at(-2)??'', accountName=account[0]??'';
if(!isAbsolute(realHome)||!accountName)throw Error('Cannot read this account from the user database');
const within=(path:string,parent:string)=>{const r=relative(parent,path);return r===''||(!r.startsWith('..')&&!isAbsolute(r));};
const isParent=process.env[ISOLATED_ROOT]===undefined;
let parsed:CheckWorkroomArgs;
try{parsed=parseCheckWorkroomArgs(process.argv.slice(2));}
catch(error){
 const reason=(error instanceof UsageError?'Usage error: ':'')+String((error as Error)?.message??error);
 // Even a call that does not parse must not leave an earlier pass in the folder it was aimed at — also when that folder
 // holds files of someone else's and is otherwise left alone (claimEvidenceDir, the same path a parsed call takes).
 const target=isParent?bestEffortEvidenceDir(root,process.argv.slice(2)):undefined;
 if(target){try{claimEvidenceDir(target.dir,target.explicit,refusal=>startupRunStatus(undefined,refusal?reason+'; '+refusal:reason));}catch{}}
 console.error(reason+'\n'+USAGE);
 process.exit(1);
}
const args=parsed;
const physicalDevice=args.mode==='device'?args.device:undefined;
const signedTemplate=args.mode==='device'?args.template:undefined;
const signingIdentity=args.mode==='device'?args.identity:undefined;
const compileOnly=args.mode==='compile-only'?args.target:undefined;
const deviceTarget=Boolean(physicalDevice)||compileOnly==='device';
const evidence=evidenceDirFor(root,args);
const SKIP_SYNC=['AGENTSTOZ_SKIP_HERMES_SYNC','AGENTSTOZ_SKIP_OUTPUT_STYLE_SYNC','AGENTSTOZ_SKIP_CONTROL_BOOTSTRAP','AGENTSTOZ_SKIP_MCP_CONNECTION_SYNC'];
const ISOLATED_KEYS=['PATH','HOME','TMPDIR','APP_DATA_DIR','XDG_CONFIG_HOME','HERMES_HOME','APPDATA','USERPROFILE','NODE_ENV','LANG','USER','LOGNAME',...SKIP_SYNC,ISOLATED_ROOT];
/** A refusal before the run: the verdict file says failed with the reason, never an earlier run's pass. */
const refuse=(reason:string):never=>{if(evidence){try{writeRunStatus(evidence,startupRunStatus(args,reason));}catch{}}console.error('REFUSED: '+reason);process.exit(1);};

if(isParent){
 // Parent: never import host code here. Build the child's environment from empty, run it, then remove the scratch root.
 if(evidence){
  // The folder holds something else and is left alone, except an earlier verdict of ours: it must not outlive this refusal.
  const refusal=claimEvidenceDir(evidence,args.mode!=='compile-only'&&args.evidenceDir!==undefined,why=>startupRunStatus(args,why??'refused or stopped before the run started'));
  if(refusal){console.error('REFUSED: '+refusal);process.exit(1);}
 }
 const base=realpathSync(tmpdir());
 if(within(base,realHome))refuse('The temporary directory resolves under the real home; set TMPDIR outside it');
 if(args.mode==='simulator'){
  const why=sandboxRefusal(root);if(why)refuse(why);
  // WP1's profile declares LAN inbound per port and the lane asserts with lsof that only <en0>:<those ports> listen,
  // so the lane names them (and the en0 address).
  if(!args.lan)refuse('The simulator journey needs --lan-address and --lan-ports: its sandbox allows LAN inbound on those three ports only (the j1-pty lane passes them)');
 }
 const scratch=realpathSync(mkdtempSync(join(base,'agentstoz-ios-workroom-')));chmodSync(scratch,0o700);
 const home=join(scratch,'home'), user=accountName;
 const env:Record<string,string>={PATH:['/usr/bin','/bin','/usr/sbin','/sbin',dirname(process.execPath)].join(':'),HOME:home,TMPDIR:join(scratch,'tmp')+'/',
  APP_DATA_DIR:join(home,'Library/Application Support/com.portmanager.portmanager'),XDG_CONFIG_HOME:join(home,'.config'),HERMES_HOME:join(home,'.hermes'),
  APPDATA:join(scratch,'roaming'),USERPROFILE:home,NODE_ENV:'test',LANG:'en_US.UTF-8',USER:user,LOGNAME:user,...Object.fromEntries(SKIP_SYNC.map(k=>[k,'1'])),[ISOLATED_ROOT]:scratch};
 for(const dir of [env.TMPDIR!,env.APP_DATA_DIR!])mkdirSync(dir,{recursive:true,mode:0o700});
 const inheritedPortal=process.env.AGENTSTOZ_IOS_PORTAL_URL;
 if(inheritedPortal&&physicalDevice)env.AGENTSTOZ_IOS_PORTAL_URL=inheritedPortal;
 else if(inheritedPortal)console.log('Ignoring the inherited AGENTSTOZ_IOS_PORTAL_URL: this run contacts no real portal unless --portal-url is given.');
 console.log('Isolated environment (names only): '+Object.keys(env).sort().join(','));
 const child=Bun.spawn([process.execPath,import.meta.path,...process.argv.slice(2)],{cwd:process.cwd(),env,stdin:'ignore',stdout:'inherit',stderr:'inherit'});
 for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>{try{child.kill(signal)}catch{}});
 let code=await child.exited;
 // Safety net for a child killed before its own cleanup: only this run's device set lives here.
 const sims=join(scratch,'sims');
 if(existsSync(sims)&&readdirSync(sims).some(name=>/^[0-9A-F]{8}-[0-9A-F-]{27}$/.test(name))){
  const swept=sweepDeviceSet(sims,realHome,cmd=>{const r=Bun.spawnSync(cmd,{env,stdout:'pipe',stderr:'ignore'});return{exitCode:r.exitCode??1,stdout:r.stdout.toString()};});
  console.log('Removed simulators the child left in its owned device set (left: '+swept.remaining+')');
 }
 rmSync(scratch,{recursive:true,force:true});
 if(evidence){
  const settled=settleRunStatus(readRunStatus(evidence),typeof code==='number'?code:1,startupRunStatus(args,'stopped before the run started'));
  if(settled.status)writeRunStatus(evidence,settled.status);
  code=settled.exitCode;
 }
 process.exit(typeof code==='number'?code:1);
}

// Child: refuse anything but the environment the parent built.
const scratch=process.env[ISOLATED_ROOT]!;
const allowedKeys=new Set([...ISOLATED_KEYS,'__CF_USER_TEXT_ENCODING',...(physicalDevice?['AGENTSTOZ_IOS_PORTAL_URL']:[])]);
const unexpected=Object.keys(process.env).filter(key=>!allowedKeys.has(key));
if(unexpected.length)refuse('Refusing a non-isolated environment (unexpected: '+unexpected.sort().join(', ')+')');
const {resolveAppDataDir,resolveAppDataDirFromEnvironment}=await import('../../../src/appDataDir');
for(const [label,path] of [['home',homedir()],['app data',resolveAppDataDir()],['app data override',resolveAppDataDirFromEnvironment()],['temporary directory',tmpdir()]] as const)
 if(!within(path,scratch)||within(path,realHome))refuse('Isolated '+label+' is outside the scratch root');
// The sandbox is inherited from the parent. Recorded here too, and the journey refuses to go on without it.
const sandbox=args.mode==='simulator'?{sandboxed:processSandboxed(),worktreeWrite:writeProbe(root).code}:undefined;
if(sandbox&&(!sandbox.sandboxed||sandbox.worktreeWrite==='CREATED'))refuse('The simulator journey lost its sandbox between parent and child');
class Blocked extends Error {}
let stopRequested=false;
const active=new Set<{kill():void}>();
for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>{stopRequested=true;for(const child of active)try{child.kill()}catch{}});
// Hashes of every Swift file handed to swiftc, taken right before it compiles.
const compiledSources:Record<string,string>={};
const sha256=(path:string)=>createHash('sha256').update(readFileSync(path)).digest('hex');
function check(value:unknown,label:string):asserts value {if(!value)throw Error(label);}
async function command(args:string[],timeoutMs=120_000,options:{cleanup?:boolean;realHome?:boolean}={}) {
 if(stopRequested&&!options.cleanup)throw Error('Stopped by its owner');
 if(args[1]==='swiftc')for(const arg of args)if(arg.endsWith('.swift'))compiledSources[relative(root,arg)]=sha256(arg);
 // Only the device run's CoreDevice/keychain tools see the real home; the simulator run never does.
 const child=Bun.spawn(args,{cwd:root,stdin:'ignore',stdout:'pipe',stderr:'pipe',env:options.realHome?{...process.env,HOME:realHome}:process.env});
 active.add(child);
 const timer=setTimeout(()=>child.kill(),timeoutMs);
 try {const [code,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
  if(stopRequested&&!options.cleanup)throw Error('Stopped by its owner (SIGINT/SIGTERM) during '+args.slice(0,3).join(' '));
  check(code===0,'Fixture command failed (exit '+code+'): '+args.slice(0,3).join(' ')+'\n'+err.slice(-6000));return out.trim();
 }finally{clearTimeout(timer);active.delete(child)}
}
const temp = mkdtempSync(join(tmpdir(),'agentstoz-ios-workroom-')); chmodSync(temp,0o700);
async function compileFixture(app:string,executable:string){
 const platform=deviceTarget?'device':'simulator';
 const sdkPath=await command(['xcrun','--sdk',workroomFixtureSdk(platform),'--show-sdk-path']);
 // One recipe for the three LANWorkroomView fixtures (workroomFixtureCompile.ts); its module caches stay in `temp`.
 for(const args of workroomFixtureCompileCommands({root,sdkPath,target:workroomFixtureTarget(platform),buildDir:temp,probe:'workroom',output:join(app,executable),nestedInSandbox:processSandboxed()}))
  await command(args,300_000);
}
if(compileOnly!==undefined){
 try{
  const started=Date.now(), app=join(temp,'CompileOnly.app');mkdirSync(app);
  await compileFixture(app,'WorkroomFixture');
  console.log(JSON.stringify({compiled:true,target:compileOnly,swiftVersion:6,seconds:Math.round((Date.now()-started)/1000),swiftSources:Object.keys(compiledSources).length}));
 }finally{rmSync(temp,{recursive:true,force:true});}
 process.exit(0);
}
if(!evidence)throw Error('A journey always has an evidence folder');

const {RemoteControlLanServer:LanServer,isPrivateRemoteControlIpv4}=await import('../../../src/remoteControlLanServer');
const {AiTerminalService:TerminalService}=await import('../../../src/aiTerminalService');
const {createAiTerminalRemoteGateway}=await import('../../../src/aiTerminalRemoteGateway');
const {TesterAgentHost:TesterHost}=await import('../../../src/testerAgentHost');
const {createMobileWorkspaceGateway}=await import('../../../src/mobileWorkspaceGateway');
const {performMobileTester}=await import('../../../src/mobileTesterHost');
// Optional anonymous HTTPS smoke. Supply a personal deployment only via local
// environment; never commit the address or include it in evidence/log output.
const portalInput = (args.mode!=='compile-only' ? args.portalUrl : undefined) ?? (physicalDevice ? process.env.AGENTSTOZ_IOS_PORTAL_URL : undefined);
let portalURL: string | undefined;
if (portalInput) {
 let portal: URL | undefined;
 try { portal = new URL(portalInput); } catch {}
 if(!portal || portal.protocol !== 'https:' || portal.username || portal.password || portal.search || portal.hash || (portal.port && portal.port !== '443') || !['/','/remote/'].includes(portal.pathname)) refuse('Expected a plain HTTPS portal origin');
 portalURL = portal!.origin + '/remote/';
}
if(physicalDevice && (!signedTemplate || !existsSync(signedTemplate) || !signingIdentity)) refuse('Physical fixture requires a signed isolated test app template');
// The parent emptied the evidence folder before any check could refuse: no earlier screenshot sits beside this verdict.
const bundleId=physicalDevice?'com.intenet.agentstoz.workspacetest':'com.intenet.agentstoz.workroomfixture';
// Snapshot the exercised source before compilation, not after a concurrent edit.
const sourceHashes=Object.fromEntries(['mobile/ios/App/LANWorkroomView.swift','mobile/ios/App/WorkroomStoreWipe.swift','mobile/ios/AgentsToZCore/Sources/AgentsToZCore/WorkroomAddress.swift','mobile/ios/AgentsToZCore/Sources/AgentsToZCore/NativeOAuthRequest.swift','mobile/ios/scripts/fixtures/WorkroomProbe.swift','src/remoteControlMobilePage.ts'].map(path=>[path,sha256(join(root,path))]));
const gitHead=Bun.spawnSync(['git','rev-parse','HEAD'],{cwd:root,stdout:'pipe',stderr:'ignore'}).stdout.toString().trim()||null;
const runStartedAt=Date.now(), seconds:Record<string,number>={};
const timed=async<T>(label:string,work:()=>Promise<T>)=>{const at=Date.now();try{return await work()}finally{seconds[label]=Math.round((Date.now()-at)/100)/10}};
let deviceInstalled=false;
let lastStage="startup";
// Written to run-status.json as soon as the simulator exists, so a run killed before its cleanup (the maintainer
// sends SIGKILL two seconds after SIGTERM) still names the set and UDID to sweep (scripts/emulator-e2e/workroomPty.ts).
let ownedSimulator:{deviceSet:string;udid:string|null;runtime:string|null;ownerPid:number;created:boolean;deleted:boolean|null}|undefined;
let preexisting:{count:number;unchanged:boolean|null}|undefined, simulatorApp:{before:number[];after:number[]|null}|undefined;
const runStatus=(state:string,extra:Record<string,unknown>={})=>writeRunStatus(evidence,{state,stage:lastStage,at:new Date().toISOString(),mode:args.mode,actualIPhone:Boolean(physicalDevice),realAI:false,productionData:false,
 gitHead,environment:Object.keys(process.env).sort(),...(sandbox?{sandbox}:{}),...(ownedSimulator?{ownedSimulator}:{}),...(preexisting?{preexistingSimulators:preexisting}:{}),...(simulatorApp?{simulatorApp}:{}),
 seconds:{...seconds,total:Math.round((Date.now()-runStartedAt)/100)/10},...extra,sources:sourceHashes,compiledSources});
runStatus("running");
// Read-only views of the shared simulator set and Simulator.app; this run never changes either.
const defaultSetStates=async()=>Object.fromEntries(Object.values(JSON.parse(await command(['xcrun','simctl','list','devices','--json'],60_000,{cleanup:true})).devices as Record<string,{udid:string;state:string}[]>).flat().map(d=>[d.udid,d.state]));
const simulatorAppPids=()=>Bun.spawnSync(['pgrep','-x','Simulator'],{stdout:'pipe',stderr:'ignore'}).stdout.toString().split(/\s+/).filter(Boolean).map(Number).sort((a,b)=>a-b);
const deviceSet=join(scratch,'sims');
const simctl=(...rest:string[])=>['xcrun','simctl','--set',deviceSet,...rest];
let simulator:string|undefined, server:RemoteControlLanServer|undefined, service:AiTerminalService|undefined;
let tester:TesterAgentHost|undefined;
let forbidden:ReturnType<typeof Bun.serve>|undefined, redirector:ReturnType<typeof Bun.serve>|undefined;
let before:Record<string,string>|undefined, failure:unknown, projectMutationAttempts=0;
const request=(operation:'list')=>({requestId:crypto.randomUUID(),operation});
try {
 if(physicalDevice)check(await command(['/usr/libexec/PlistBuddy','-c','Print CFBundleIdentifier',join(signedTemplate!,'Info.plist')])===bundleId,'Physical fixture refuses a non-isolated bundle identifier');
 const privateAddresses=Object.values(networkInterfaces()).flat().filter(row=>row&&!row.internal&&row.family==='IPv4'&&isPrivateRemoteControlIpv4(row.address)).map(row=>row!.address);
 const lan=args.mode==='compile-only'?undefined:args.lan;
 if(lan&&!privateAddresses.includes(lan.address))throw Error('--lan-address '+lan.address+' is not a private IPv4 address of this Mac (it has: '+(privateAddresses.join(', ')||'none')+')');
 const address=lan?.address??privateAddresses[0];
 if(!address)throw new Blocked('No private LAN interface; no public/wildcard fallback');
 const app=join(temp,'WorkroomFixture.app');
 if(signedTemplate)cpSync(signedTemplate,app,{recursive:true});else mkdirSync(app);
 // Compile before any listener opens: a broken build never exposes a pairing on the LAN.
 lastStage='compile';
 await timed('compile',()=>compileFixture(app,physicalDevice?'AgentsToZMobile':'WorkroomFixture'));
 let phone:{name:string;identifier?:string}={name:'Physical iPhone'},runtime:{version:string;identifier?:string}={version:'device'};
 if(!physicalDevice){
  // Boot before any listener opens, too: a missing runtime or a failed boot never exposes the LAN pairing.
  const runtimes=JSON.parse(await command(['xcrun','simctl','list','runtimes','--json'])).runtimes;
  runtime=runtimes.filter((r:any)=>r.isAvailable&&r.identifier.includes('.iOS-')).at(-1);
  if(!runtime)throw new Blocked('No available iOS simulator runtime');
  const types=JSON.parse(await command(['xcrun','simctl','list','devicetypes','--json'])).devicetypes;
  phone=types.find((t:any)=>t.name==='iPhone 17 Pro')??types.find((t:any)=>t.name.startsWith('iPhone'));
  if(!phone)throw new Blocked('No available iPhone simulator type');
  before=await defaultSetStates();
  preexisting={count:Object.keys(before).length,unchanged:null};
  simulatorApp={before:simulatorAppPids(),after:null};
  mkdirSync(deviceSet,{mode:0o700});
  ownedSimulator={deviceSet,udid:null,runtime:runtime.identifier??runtime.version,ownerPid:process.pid,created:false,deleted:null};
  // Recorded before `create`: a kill during it still leaves the set's path for the sweep.
  runStatus("running");
  simulator=await command(simctl('create','AgentsToZ Workroom Fixture '+crypto.randomUUID().slice(0,8),phone.identifier!,runtime.identifier!));
  ownedSimulator.created=true;ownedSimulator.udid=simulator;
  lastStage='boot';
  runStatus("running");
  await command(simctl('boot',simulator));
  console.log('Owned iOS simulator booting in a scratch device set; no existing simulator will be modified');
  await timed('boot',()=>command(simctl('bootstatus',simulator!,'-b'),480_000));
 }
 lastStage='startup';
 const cli=join(temp,'fake-cli');writeFileSync(cli,'#!/bin/sh\nstty -echo\nprintf "REMOTE_READY\\n"\nwhile IFS= read -r line; do printf "RESULT:%s\\n" "$line"; done\n',{mode:0o700});
 service=new TerminalService({resolveTarget:async id=>{check(id==='fixture-runtime-A'||id==='fixture-runtime-B','Unknown fixture target');return{cwd:temp}},executable:()=>cli});
 let deviceGranted=false;
 const testerRoot=join(temp,'tester-project');mkdirSync(join(testerRoot,'tests'),{recursive:true});
 writeFileSync(join(testerRoot,'tests/test_core.py'),'import unittest\nclass Core(unittest.TestCase):\n def test_ok(self): self.assertEqual(2+2,4)\n');
 tester=new TesterHost({directory:join(temp,'tester-data'),runner:join(root,'scripts/agentstoz-maintainer.py'),python:()=>Bun.which('python3'),resolve:async r=>{check(r.portId==='fixture-runtime-A','Unknown tester project');return{root:testerRoot,label:'Tester fixture',targets:[{id:r.portId,label:'Tester fixture'}]};},lease:async()=>({release(){}})});
 const plan=await tester.perform({operation:'plan',portId:'fixture-runtime-A'});await tester.perform({operation:'apply',portId:'fixture-runtime-A',revision:plan.plan!.revision});
 const gateway=createAiTerminalRemoteGateway({service,active:()=>true,resolve:async bindings=>bindings.map(b=>({controlId:b.controlId,runtimeTargetId:b.target.internalId==='fixture-A'?'fixture-runtime-A':'fixture-runtime-B'})),
  consent:async()=>deviceGranted?{targetIds:new Set(['fixture-runtime-A','fixture-runtime-B']),isActive:()=>deviceGranted,requestOwner:'fixture-paired-device'}:null});
 const operations:{operation:string;agent?:string;target?:string;bypassPermissions?:boolean}[]=[];
 const workspaceGateway=createMobileWorkspaceGateway({terminal:gateway,testerSupported:true,active:()=>true,resolve:async bindings=>bindings.map(b=>({controlId:b.controlId,runtimeTargetId:b.target.internalId==='fixture-A'?'fixture-runtime-A':'fixture-runtime-B'})),consent:async()=>deviceGranted?{targetIds:new Set(['fixture-runtime-A']),workspaceScopes:['tester.read','tester.run'],isActive:()=>deviceGranted,executionAllowed:()=>deviceGranted,requestOwner:'fixture-paired-device'}:null,perform:async(r,t,o,a,access)=>performMobileTester(tester!,r,t,o,a,access!)});
 // Three origins on one private address: the pairing server, a foreign origin and a redirect to it. Under the j1-pty
 // sandbox their ports are the ones the lane declared; elsewhere (--device) the OS picks.
 server=new LanServer({bindAddress:address,...(lan?{port:lan.serverPort}:{}),hostName:'Isolated iOS fixture',workspaceSupported:true,testerSupported:true,gateway:{
  listRegisteredProjects:()=>['A','B'].map(suffix=>({internalId:'fixture-'+suffix,name:'Fixture project '+suffix,kind:'main' as const,status:'unknown' as const,port:null,command:null,folderPath:temp,actions:[]})),
  executeRegisteredProjectAction:()=>{projectMutationAttempts++;throw Error('Project mutation forbidden')}, listWorkspaceRoots:()=>[],
 },terminalGateway:async(r,b,o)=>{operations.push({operation:r.operation,...('bypassPermissions'in r?{bypassPermissions:r.bypassPermissions}:{}),...('agent'in r?{agent:r.agent}:{}),...(r.targetId?{target:b.find(x=>x.controlId===r.targetId)?.target.internalId}:{})});return workspaceGateway(r,b,o)}});
 const started=server.start();
 let foreignRequests=0;
 forbidden=Bun.serve({hostname:address,port:lan?.foreignPort??0,fetch(){foreignRequests++;return new Response('forbidden')}});
 redirector=Bun.serve({hostname:address,port:lan?.redirectPort??0,fetch(){return Response.redirect(`http://${address}:${forbidden!.port}/remote/`,302)}});
 // The shipped LAN page's CSP is checked by the probe on the phone's own network path (check
 // 'lan-page-csp-default-src-none', asserted at the end): the host's sandbox allows no outbound LAN connection.
 writeFileSync(join(app,'bootstrap.json'),JSON.stringify({pairingURL:started.pairing.pairingUrl,foreignURL:`http://${address}:${forbidden.port}/remote/`,redirectQR:`http://${address}:${redirector.port}/remote/#pair=${"a".repeat(43)}`,...(portalURL?{portalURL}:{})}),{mode:0o600});
 if(physicalDevice){
  await command(['/usr/libexec/PlistBuddy','-c','Set CFBundleDisplayName AgentsToZ Test',join(app,'Info.plist')]);
  const entitlements=await command(['codesign','-d','--entitlements',':-',signedTemplate!]);
  const entitlementFile=join(temp,'entitlements.plist');writeFileSync(entitlementFile,entitlements);
  await command(['codesign','--force','--sign',signingIdentity!,'--entitlements',entitlementFile,'--timestamp=none',app],120_000,{realHome:true});
 }else{
  const plist=readFileSync(join(root,'mobile/ios/App/Info.plist'),'utf8').replaceAll('$(EXECUTABLE_NAME)','WorkroomFixture').replaceAll('$(PRODUCT_BUNDLE_IDENTIFIER)',bundleId).replaceAll('$(PRODUCT_NAME)','WorkroomFixture').replaceAll('$(MARKETING_VERSION)','0.1.0').replaceAll('$(CURRENT_PROJECT_VERSION)','1');
  writeFileSync(join(app,'Info.plist'),plist);
  await command(['codesign','--force','--sign','-','--timestamp=none',app]);
 }
 const docs=join(temp,'device-documents');mkdirSync(docs);
 let simulatorDocuments=docs;
 if(physicalDevice){
  await command(['xcrun','devicectl','device','install','app','--device',physicalDevice,app],120_000,{realHome:true});deviceInstalled=true;
 }else{
 await command(simctl('install',simulator!,app));
 const container=await command(simctl('get_app_container',simulator!,bundleId,'data'));
 simulatorDocuments=join(container,'Documents');mkdirSync(simulatorDocuments,{recursive:true});
 }
 const launch=async(id:string)=>physicalDevice?command(['xcrun','devicectl','device','process','launch','--device',physicalDevice,id],120_000,{realHome:true}):command(simctl('launch',simulator!,id));
 const copyFrom=(source:string,destination:string,timeout=15_000)=>command(['xcrun','devicectl','device','copy','from','--device',physicalDevice!,'--domain-type','appDataContainer','--domain-identifier',bundleId,'--source',source,'--destination',destination],timeout,{realHome:true});
 const answer=async(body:object)=>{const file=join(simulatorDocuments,'command.json');writeFileSync(file,JSON.stringify(body),{mode:0o600});if(physicalDevice)await command(['xcrun','devicectl','device','copy','to','--device',physicalDevice,'--domain-type','appDataContainer','--domain-identifier',bundleId,'--source',file,'--destination','Documents/command.json'],120_000,{realHome:true})};
 const journeyStartedAt=Date.now();
 await launch(bundleId);
 let previous='', complete=false;
 const deadline=Date.now()+200_000;
 while(Date.now()<deadline){
  check(!stopRequested,'Stopped by its owner');
  await Bun.sleep(150);
  const file=join(simulatorDocuments,'result.json');
  if(physicalDevice){try{await copyFrom('Documents/result.json',file)}catch{continue}}
  if(!existsSync(file))continue;
  let result:any;try{result=JSON.parse(readFileSync(file,'utf8'))}catch{continue}
  if(result.failed){
   if(physicalDevice){try{await copyFrom('Documents/diagnostic.json',join(simulatorDocuments,'diagnostic.json'))}catch{}}
   if(physicalDevice){
    for(const file of ['native-failure.txt','failure-screen.png'])try{await copyFrom('Documents/'+file,join(evidence,file))}catch{}
    if(existsSync(join(evidence,'native-failure.txt')))console.log('Native connection detail: '+readFileSync(join(evidence,'native-failure.txt'),'utf8'));
   }
   const d=join(simulatorDocuments,'diagnostic.json'); if(existsSync(d))console.log('Fixed fixture diagnostics: '+readFileSync(d,'utf8'));
   const ownSessions=(await service.perform(request('list'))).sessions??[];
   const ownRead=ownSessions[0]?await service.perform({requestId:crypto.randomUUID(),operation:'read',sessionId:ownSessions[0].id,after:0}):null;
   console.log(JSON.stringify({fixtureInputRequests:operations.filter(r=>r.operation==='input').length,fixtureMacHasExpectedOutput:ownRead?.chunks?.some(c=>c.text.includes('RESULT:native-safe-fixture'))??false}));
  }
  check(!result.failed,'WKWebView fixture failed at '+result.stage);
  if(result.stage===previous)continue;previous=result.stage;lastStage=result.stage;
  console.log('WKWebView fixture: '+result.stage);
  if(physicalDevice&&['memory-draft-ready','visible-workroom'].includes(result.stage)){
   const basename=result.stage==='memory-draft-ready'?'draft-screen':'workroom-screen';
   for(const ext of ['png','json'])await copyFrom('Documents/'+basename+'.'+ext,join(evidence,basename+'.'+ext));
  }
  if(result.stage==='grant-request'){
   check(server.status().sessions.length===1,'Expected one isolated LAN connection');
   deviceGranted=true;service.setRemoteAccess('lan:'+server.status().sessions[0]!.id,true);await answer({stage:'granted'});
  }else if(result.stage==='memory-draft-ready'){
   check(operations.filter(r=>r.operation==='start').length===1,'Double start escaped UI fence');
   check(operations.find(r=>r.operation==='start')?.bypassPermissions===true,'LAN bypass default did not reach host');
   check(operations.find(r=>r.operation==='start')?.target==='fixture-B','Selected project was not sent');
   check(operations.filter(r=>r.operation==='input').length===0,'Remember draft executed automatically');
   await answer({stage:'draft-checked'});
  }else if(result.stage==='tester-completed'){
   const status=(await tester.perform({operation:'status',portId:'fixture-runtime-A'})).status!;
   check(status.latestRun?.id===result.testerRunID&&status.latestRun?.state==='passed','iPhone result and Python host run differ');
   await answer({stage:'tester-checked'});
  }else if(result.stage==='visible-workroom'){
   check(operations.filter(r=>r.operation==='input').length===1,'Duplicate input escaped UI fence');
   check(operations.filter(r=>r.operation==='close').length===1,'Explicit stop did not deduplicate');
   check(foreignRequests===0,'Foreign document/popup escaped WKNavigationDelegate');
   if(!physicalDevice)await command(simctl('io',simulator!,'screenshot',join(evidence,'workroom.png')));
   await launch('com.apple.Preferences');
   await Bun.sleep(800);
   await launch(bundleId);
   await answer({stage:'screenshot-taken'});
  }else if(result.stage==='resumed'){
   check(server.status().sessions.length===1,'Tab/background created an additional controller');
   const sessions=(await service.perform(request('list'))).sessions!;
   check(sessions.filter(s=>s.state==='running').length===1,'Background stopped the running fake AI');
   check(operations.filter(r=>r.operation==='close').length===1,'Background sent terminal close');
   check(operations.filter(r=>r.operation==='start').length===2,'Cold resume started another CLI');
   check(operations.filter(r=>r.operation==='input').length===1,'Cold resume replayed input');
   if(!physicalDevice)await command(simctl('io',simulator!,'screenshot',join(evidence,'resumed.png')));
   await answer({stage:'disconnect-now'});
  }else if(result.stage==='client-disconnected'){
   for(let n=0;n<100&&server.status().sessions.length;n++)await Bun.sleep(50);
   check(server.status().sessions.length===0,'Native disconnect did not revoke host pairing');deviceGranted=false;
   await answer({stage:'fresh-qr',pairingURL:server.rotatePairing().pairingUrl});
  }else if(result.stage==='revoke-request'){
   check(server.status().sessions.length===1,'Expected one new fixture connection');
   server.revokeSession(server.status().sessions[0]!.id);await answer({stage:'revoked'});
  }else if(result.stage==='portal-visible'){
   if(!physicalDevice)await command(simctl('io',simulator!,'screenshot',join(evidence,'portal.png')));
   await launch('com.apple.Preferences');await Bun.sleep(800);await launch(bundleId);
   await answer({stage:'portal-returned'});
  }else if(result.done){
   check(foreignRequests===0,'HTTP redirect contacted a different origin');
   check(projectMutationAttempts===0,'The workroom asked the host to change a registered project');
   check(Array.isArray(result.checks)&&result.checks.includes('lan-page-csp-default-src-none'),"LAN CSP missing: the phone saw no default-src 'none' on /remote/");
   complete=true;
   writeFileSync(join(evidence,'result.json'),JSON.stringify({...result,simulator:phone.name,runtime:runtime.version,...(physicalDevice?{}:{deviceSet:'owned-scratch',udid:simulator}),
    actualIPhone:Boolean(physicalDevice),realAI:false,productionData:false,anonymousPortal:Boolean(portalURL),foreignRequests,projectMutationAttempts,operations,
    sources:sourceHashes},null,2)+'\n',{mode:0o600});
   break;
  }
 }
 seconds.journey=Math.round((Date.now()-journeyStartedAt)/100)/10;
 check(complete,'WKWebView fixture timed out');
 console.log('Actual iOS WKWebView LAN/terminal/consent/draft/lifecycle checks passed');
}catch(error){
 failure=error;
 if(simulator){try{await command(simctl('io',simulator,'screenshot',join(evidence,'failure.png')),15_000,{cleanup:true})}catch{}}
}finally{
 if(physicalDevice&&deviceInstalled){try{await command(['xcrun','devicectl','device','uninstall','app','--device',physicalDevice,bundleId],30_000,{cleanup:true,realHome:true})}catch{}}
 // Clean up only the simulator, listeners and fake PTYs created by this runner.
 if(simulator){try{await command(simctl('shutdown',simulator),30_000,{cleanup:true})}catch{}try{await command(simctl('delete',simulator),30_000,{cleanup:true})}catch{}}
 try{await server?.stop();await forbidden?.stop(true);await redirector?.stop(true);await service?.shutdown();await tester?.shutdown();tester?.store.close();}catch(error){failure??=error;}
 rmSync(temp,{recursive:true,force:true});
}
// Verdict after cleanup: a pass also needs the owned simulator provably gone and the shared set untouched.
if(ownedSimulator){
 try{
  const left=Object.values(JSON.parse(await command(simctl('list','devices','--json'),60_000,{cleanup:true})).devices as Record<string,{udid:string}[]>).flat();
  ownedSimulator.deleted=!left.some(d=>d.udid===simulator);
  if(ownedSimulator.deleted&&!left.length)rmSync(deviceSet,{recursive:true,force:true});
 }catch{ownedSimulator.deleted=false;}
}
let isolation:string[]=[];
if(before&&preexisting&&simulatorApp){
 const after=await defaultSetStates().catch(()=>null);
 preexisting.unchanged=after?Object.entries(before).every(([udid,state])=>after[udid]===state):null;
 let pids:number[]|null=null;try{pids=simulatorAppPids();}catch{}
 simulatorApp.after=pids;
 // Design §2.5: these are verdict facts, not warnings. A change most likely came from outside this run (it only reads
 // the shared set), but then the run cannot show that it left the Mac as it found it.
 isolation=isolationFailures({preexistingUnchanged:preexisting.unchanged,simulatorAppBefore:simulatorApp.before,simulatorAppAfter:pids});
}
const reason=failure?String((failure as Error)?.message??failure).replace(/#pair=[^\s"'&]+/g,'#pair=<redacted>').slice(0,2000):undefined;
const cleanupFailed=ownedSimulator!==undefined&&ownedSimulator.created&&ownedSimulator.deleted!==true;
const reasons=[...(reason?[reason]:[]),...(cleanupFailed?['owned simulator deletion not verified']:[]),...isolation];
const state=cleanupFailed||isolation.length?'failed':failure instanceof Blocked?'blocked':failure?'failed':'passed';
runStatus(state,{...(reasons.length?{reason:reasons.join('; ')}:{}),...(cleanupFailed?{cleanup:'owned simulator deletion not verified'}:{}),...(isolation.length?{isolation}:{})});
if(state==='blocked'){console.error('BLOCKED: '+reason);process.exit(BLOCKED_EXIT);}
if(failure)throw failure;
if(cleanupFailed)throw Error('Owned simulator deletion could not be verified');
if(isolation.length)throw Error(isolation.join('; '));
console.log('run-status: passed; owned simulator deleted; earlier simulators and Simulator.app unchanged');
