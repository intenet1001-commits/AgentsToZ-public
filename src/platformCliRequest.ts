import {PlatformCliError} from './platformCliProtocol';
import type {PlatformCliHost} from './platformCliHost';
import type {PlatformGithubPush} from './platformGithubPush';
import {PlatformCliLoginHost} from './platformCliLogin';
import {PlatformCliOperations} from './platformCliOperation';
import {platformCliSetupStatus,connectNativePlatformAccount,readSupabaseSetup,readSupabasePublicSetupKey} from './platformCliSetup';
import {platformCliProvider,platformCliText,PLATFORM_CLI_PROVIDERS} from './platformCliProtocol';

import {validatePlatformCliRequest} from './platformCliRequestValidation';
import {withOwnedPortalFileLock} from './portalFileLock';
import {join} from 'node:path';
import {ONBOARDING_OPERATION_LOCK} from './onboardingOperationLock';
import {PlatformNativeSwitch} from './platformCliNativeSwitch';
import {platformCliEverywhere,type PlatformCliEverywhereStatus} from './platformCliEverywhere';
export {validatePlatformCliRequest,PLATFORM_CLI_AGENT_OPERATIONS} from './platformCliRequestValidation';

const loginHosts=new WeakMap<PlatformCliHost,PlatformCliLoginHost>();
const connectionHosts=new WeakMap<PlatformCliHost,PlatformCliOperations>();
const nativeSwitches=new WeakMap<PlatformCliHost,PlatformNativeSwitch>();
/** The host's Mac-wide switcher; the app registers its own (with the Git path), tests a fixture. */
export function registerPlatformNativeSwitch(host:PlatformCliHost,native:PlatformNativeSwitch){nativeSwitches.set(host,native);return native;}
export function platformNativeSwitch(host:PlatformCliHost):PlatformNativeSwitch {
  return nativeSwitches.get(host)??registerPlatformNativeSwitch(host,new PlatformNativeSwitch(host,{git:typeof Bun==='undefined'?null:Bun.which('git')}));
}
export async function handlePlatformCliRequest(host:PlatformCliHost,push:PlatformGithubPush,value:unknown,agent=false,loginHost?:PlatformCliLoginHost):Promise<Record<string,unknown>> {
  const r=validatePlatformCliRequest(value,agent);
  if(['check-start','connect-native-start','login-start','login-add-start'].includes(r.operation)){
    host.store.ensureDirectory();
    return withOwnedPortalFileLock(join(host.store.root,'interactive-admission.lock'),()=>{
      const operations=connectionHosts.get(host),login=loginHost??loginHosts.get(host);
      // Exact retries read their own receipt inside the individual host; new work waits.
      const signIn=r.operation==='login-start'||r.operation==='login-add-start';
      if(signIn&&operations?.busy()||!signIn&&login?.busy())throw new PlatformCliError('진행 중인 계정 확인·로그인을 먼저 마치세요. 키체인 확인창이 보이면 직접 승인하고 같은 요청 결과를 확인하세요.');
      return executePlatformCliRequest(host,push,r,loginHost);
    },{...ONBOARDING_OPERATION_LOCK,label:'CLI interactive admission'});
  }
  return executePlatformCliRequest(host,push,r,loginHost);
}
async function executePlatformCliRequest(host:PlatformCliHost,push:PlatformGithubPush,r:Record<string,any>,loginHost?:PlatformCliLoginHost):Promise<Record<string,unknown>> {
  if(['check-start','connect-native-start','connection-status'].includes(r.operation)){
    let operations=connectionHosts.get(host);if(!operations){operations=new PlatformCliOperations(host);connectionHosts.set(host,operations);}
    return {connection:r.operation==='connection-status'?operations.status(r.requestId):await operations.start(r)};
  }
  if(r.operation==='native-status')return {native:await platformNativeSwitch(host).status(),everywhere:await everywhereStatus(host)};
  if(r.operation==='native-switch')return {native:await platformNativeSwitch(host).switch(r.provider,r.accountId,r.requestId)};
  if(r.operation==='native-git-setup'){
    const native=await platformNativeSwitch(host).setupGit(r.requestId);
    // gh appends its helper after AgentsToZ's routing; put the routing last again.
    return {native,everywhere:await everywhereAfter(host,'git-setup')};
  }
  if(r.operation==='everywhere-set'){
    const everywhere=platformCliEverywhere(host);if(!everywhere)throw new PlatformCliError('이 실행 환경에서는 바꿀 수 없습니다. 아젠투지 앱에서 바꾸세요.');
    return {everywhere:await everywhere.set(r.enabled)};
  }
  if(r.operation==='setup-status')return {setup:platformCliSetupStatus(host)};
  if(r.operation==='connect-native')return {account:await connectNativePlatformAccount(host,r.provider,r.email,r.requestId,undefined,r.purpose)};
  if(r.operation==='supabase-projects')return {projects:await readSupabaseSetup(host,r.accountId)};
  if(r.operation==='supabase-client-key')return readSupabasePublicSetupKey(host,r.accountId,r.ref);
  if(r.operation==='google-client-status')return {googleClient:await host.store.googleClient.status(host.deps.env??process.env)};
  if(r.operation==='google-client-save')return {googleClient:await host.store.googleClient.save(r.clientJson)};
  if(r.operation.startsWith('login-')){
    let login=loginHost??loginHosts.get(host);if(!login){login=new PlatformCliLoginHost(host);loginHosts.set(host,login);}
    if(r.operation==='login-start')return {login:await login.start(r.provider,r.email,r.requestId,r.purpose)};
    if(r.operation==='login-onboarding-start')return {login:await login.start(r.provider,undefined,r.requestId,r.purpose,true)};
    // Adding another account never changes which account this Mac uses; the person picks where it applies.
    if(r.operation==='login-add-start')return {login:await login.start(r.provider,undefined,r.requestId,r.purpose,true,false)};
    if(r.operation==='login-status')return {login:login.status(r.loginId)};
    if(r.operation==='login-code')return {login:login.code(r.loginId,r.code)};
    return {login:await login.cancel(r.loginId)};
  }
  if(r.operation==='set-default')return {deviceDefault:await host.store.setDefault(r.provider,r.email,r.accountId,r.requestId)};
  if(r.operation==='native-github-accounts')return {logins:await host.nativeGithubAccounts()};
  if(r.operation==='connect-github')return {account:await host.connectNativeGithub(r.login,r.requestId)};
  if(r.operation==='list')return {accounts:await host.accounts(r.provider),deviceDefaults:host.store.deviceDefaults()};
  if(r.operation==='create')return {account:await host.store.create(r.provider,r.label,r.credential,r.requestId)};
  if(r.operation==='check')return {account:await host.check(r.accountId,r.requestId)};
  if(r.operation==='archive'){await host.store.archive(r.accountId,r.requestId);return {archived:true};}
  // Resolve every project before reading bindings, even for a read-only agent request.
  const project=await host.deps.resolveProject(r.targetId);
  if(r.operation==='project')return {targetId:r.targetId,projectLabel:project.label,everywhere:await everywhereStatus(host),accounts:await host.accounts(),deviceDefaults:host.store.deviceDefaults(),bindings:Object.fromEntries(PLATFORM_CLI_PROVIDERS.map(provider=>[provider,host.store.binding(r.targetId,provider)]))};
  if(r.operation==='bind'){
    if(!platformCliProvider(r.provider))throw new PlatformCliError('지원하는 CLI를 선택하세요.');
    const binding=await host.bind(r.targetId,r.provider,r.binding,r.requestId);
    // The first project account turns on its use in terminals and git as well (unless the person turned that off).
    return {binding,everywhere:await everywhereAfter(host,'bind')};
  }
  if(r.operation==='push-options')return {options:await push.options(r.targetId,r.folderPath)};
  if(r.operation==='prepare-push'){
    const options=await push.options(r.targetId,r.folderPath);
    const accountId=r.accountId??options.defaultAccountId;
    const remote=r.remote??options.defaultRemote;
    if(!accountId||!remote)return {selectionRequired:true,options};
    return {plan:await push.prepare(r.targetId,accountId,remote,r.folderPath)};
  }
  if(r.operation==='execute-push')return {receipt:await push.execute(r.targetId,r.planId,r.requestId)};
  throw new PlatformCliError('지원하지 않는 CLI 동작입니다.');
}
async function everywhereStatus(host:PlatformCliHost):Promise<PlatformCliEverywhereStatus|null> {
  try{return await platformCliEverywhere(host)?.status()??null;}catch{return null;}
}
/** Never fails the request it follows: the binding or git setup already happened. */
async function everywhereAfter(host:PlatformCliHost,trigger:'bind'|'git-setup'):Promise<PlatformCliEverywhereStatus|null> {
  try{return await platformCliEverywhere(host)?.reconcile(trigger)??null;}catch{return everywhereStatus(host);}
}
