import {useLayoutEffect,useRef,useState} from 'react';
import {terminalLocalRequest} from './aiTerminalClient';
import {PLATFORM_CLI_DEFAULT_ACCOUNT,PLATFORM_CLI_PATH,PLATFORM_CLI_PROVIDERS,PLATFORM_CLI_LABELS,type PlatformCliAccount,type PlatformCliProvider,type PlatformCliBinding,type PlatformCliDeviceDefaults,type PlatformCliAccountPurpose} from './platformCliProtocol';
import {PlatformCliLoginPanel} from './PlatformCliLoginPanel';
import {PlatformCliPreparation} from './PlatformCliPreparation';
import {platformConnectionOperation,pendingPlatformConnection} from './platformCliOperationClient';
import {PlatformConnectionProgress} from './PlatformConnectionProgress';
import {platformCliAccountOptions} from './platformCliAccountOptions';
import type {Lang} from './i18n';
const links:Record<PlatformCliProvider,string>={github:'https://github.com/settings/personal-access-tokens',vercel:'https://vercel.com/account/settings/tokens',supabase:'https://supabase.com/dashboard/account/tokens','google-workspace':'https://github.com/googleworkspace/cli#authentication'};
const button='min-h-[44px] rounded-lg border border-[var(--line)] px-3 py-2 text-xs disabled:opacity-50';
const input='min-h-[44px] w-full min-w-0 rounded-lg border border-[var(--line)] bg-[var(--bg-input)] px-3 py-2 text-sm';
export function PlatformCliSettings({language,projects,onOpenSync,initialProvider='github',purpose='project-cli',expanded=false,newcomer=false,onVerified}:{language:Lang;projects:{id:string;name:string}[];onOpenSync?:()=>void;initialProvider?:PlatformCliProvider;purpose?:PlatformCliAccountPurpose;expanded?:boolean;newcomer?:boolean;onVerified?:()=>void}) {
  const ko=language==='ko',appSync=purpose==='app-sync-account';
  const [provider,setProvider]=useState<PlatformCliProvider>(appSync?'supabase':initialProvider),[accounts,setAccounts]=useState<PlatformCliAccount[]>([]);
  const [label,setLabel]=useState(''),[credential,setCredential]=useState(''),[targetId,setTargetId]=useState('');
  const [binding,setBinding]=useState<PlatformCliBinding>({accountId:PLATFORM_CLI_DEFAULT_ACCOUNT,scope:'',resourceId:''});
  const [defaults,setDefaults]=useState<PlatformCliDeviceDefaults>({}),[defaultEmail,setDefaultEmail]=useState(''),[defaultAccount,setDefaultAccount]=useState('');
  const [reload,setReload]=useState(0);
  const [installed,setInstalled]=useState<boolean|null>(null);
  const [connectionId,setConnectionId]=useState<string|null>(pendingPlatformConnection());
  const [busy,setBusy]=useState(false),[message,setMessage]=useState('');
  const generation=useRef(0);
  const request=(body:unknown)=>terminalLocalRequest(PLATFORM_CLI_PATH,body);
  useLayoutEffect(()=>{
    // Reset before the new provider can receive input; a late effect must not erase new text.
    const epoch=++generation.current;setMessage('');setCredential('');setBusy(true);setAccounts([]);setBinding({accountId:PLATFORM_CLI_DEFAULT_ACCOUNT,scope:'',resourceId:''});
    void request(targetId?{operation:'project',targetId}:{operation:'list',...(appSync?{provider:'supabase'}:{})}).then(r=>{
      if(generation.current!==epoch)return;setAccounts(r.accounts??[]);setDefaults(r.deviceDefaults??{});setDefaultEmail(r.deviceDefaults?.[provider]?.email??'');setDefaultAccount(r.deviceDefaults?.[provider]?.accountId??'');
      if(targetId)setBinding(r.bindings?.[provider]??{accountId:PLATFORM_CLI_DEFAULT_ACCOUNT,scope:'',resourceId:''});
    }).catch(()=>{if(generation.current===epoch)setMessage(ko?'CLI 계정 목록을 확인하지 못했습니다. 연결한 Mac 앱을 업데이트해 주세요.':'Could not load CLI accounts. Update the connected Mac app.');}).finally(()=>{if(generation.current===epoch)setBusy(false);});
    return()=>{generation.current++;};
  },[targetId,provider,ko,reload,appSync]);
  async function perform(body:Record<string,unknown>) {
    if(busy)return;const epoch=generation.current;setBusy(true);setMessage('');
    try {
      const r=body.operation==='check'?await platformConnectionOperation({...body,operation:'check-start'},setConnectionId):await request({...body,requestId:crypto.randomUUID()});
      if(body.operation==='check'){if(generation.current===epoch)setMessage(ko?'이 계정의 실제 연결을 확인하고 있습니다. 아래에서 같은 요청 결과를 확인하세요.':'Checking this account. Read the same result below.');return;}
      if(generation.current!==epoch)return;
      const next=await request({operation:'list',...(appSync?{provider:'supabase'}:{})});if(generation.current!==epoch)return;setAccounts(next.accounts??[]);setDefaults(next.deviceDefaults??{});if(body.operation==='set-default'){setDefaultAccount(next.deviceDefaults?.[provider]?.accountId??'');setDefaultEmail(next.deviceDefaults?.[provider]?.email??'');}
      setMessage(body.operation==='native-github-accounts'?(ko?`연결 가능한 GitHub 로그인 ${r.logins?.length??0}개`:`${r.logins?.length??0} GitHub logins available`):body.operation==='connect-github'?(ko?'선택한 GitHub 로그인을 연결했습니다. 기존 CLI의 활성 계정은 바꾸지 않았습니다.':'GitHub login connected. The CLI’s active account was preserved.'):body.operation==='create'?(ko?'계정을 저장했습니다. 연결 확인 후 프로젝트에 지정하세요.':'Account saved. Check the connection, then assign it to a project.'):
        body.operation==='set-default'?(ko?'이 기기의 기본 계정을 저장했습니다. 프로젝트에서 지정한 계정은 유지됩니다.':'Device default saved. Project overrides are preserved.'):body.operation==='check'?(ko?`연결 확인: ${r.account?.identity??label}`:`Connection checked: ${r.account?.identity??label}`):body.operation==='bind'?(ko?'이 프로젝트의 모든 연결 에이전트가 같은 계정 설정을 사용합니다.':'Connected agents now share this project account setting.'):(ko?'목록에서 제외했습니다. 기존 연결은 실행을 멈추며 다른 계정으로 대체하지 않습니다.':'Removed from the list. Existing bindings stop and never fall back to another account.'));
    }catch(error){if(generation.current===epoch)setMessage(error instanceof Error?error.message:(ko?'결과를 확인하지 못했습니다. 다시 실행하기 전에 목록을 확인하세요.':'Result unavailable. Check the account list before retrying.'));}
    finally{if(generation.current===epoch)setBusy(false);}
  }
  return <details open={expanded||undefined} className="mt-5 border-t border-[var(--line)] pt-4" data-testid="platform-cli-settings">
    <summary className="cursor-pointer font-semibold">{newcomer?PLATFORM_CLI_LABELS[provider]+' 계정 연결':appSync?(ko?'Supabase 관리 로그인 추가':'Add a Supabase management login'):(ko?'프로젝트 작업용 CLI 계정 관리':'Project CLI accounts')}</summary>
    <p className="my-3 text-xs leading-5 text-[var(--ink-3)]">{newcomer?'본인 계정으로 공식 인증을 진행하면 확인된 이메일과 연결 상태를 표시합니다.':appSync?(ko?'이곳에서는 아젠투지 데이터 저장소를 관리할 로그인만 추가합니다. 연결 뒤 위에서 계정과 프로젝트를 선택하세요. 프로젝트 작업용 CLI 기본 계정이나 기존 데이터 저장소는 바뀌지 않습니다.':'Add a management login for AgentsToZ data, then select the account and project above. Project CLI defaults and the existing data connection stay unchanged.') : ko?'이 영역 전체는 개발 프로젝트 작업용 CLI 설정입니다. 아젠투지 앱 데이터 저장소는 별도 ‘앱 데이터 저장·기기 동기화’에서 설정합니다. 프로젝트에서 지정한 계정이 이 기기 기본값보다 우선합니다. 기본값을 따르는 프로젝트는 같은 기기의 연결 에이전트와 계정 설정을 공유합니다. 실행 중인 작업은 시작할 때 선택한 계정을 유지합니다.':'Project overrides take priority over this device’s default. Connected agents on this device share the setting. Running work keeps the account selected at its start.'}</p>
    {!appSync&&!newcomer&&<label className="block text-xs">CLI<select aria-label="CLI" className={input+' mt-1'} value={provider} disabled={busy} onChange={e=>setProvider(e.target.value as PlatformCliProvider)}>{PLATFORM_CLI_PROVIDERS.map(p=><option key={p} value={p}>{PLATFORM_CLI_LABELS[p]}</option>)}</select></label>}
    <PlatformCliPreparation compact={newcomer} purpose={purpose} provider={provider} ko={ko} reload={reload} onInstalled={setInstalled} onOpenSync={onOpenSync}/>
    <PlatformCliLoginPanel discoverEmail={newcomer} onVerificationStarted={setConnectionId} purpose={purpose} provider={provider} email={appSync?'':defaultEmail.trim()} ko={ko} disabled={installed!==true} onConnected={()=>{setReload(v=>v+1);onVerified?.();}}/>
    {!appSync&&provider==='supabase'&&<p className="mt-3 text-xs leading-5 text-[var(--ink-3)]">{ko?'로컬 프로젝트의 Supabase 계정·배포 연결입니다. 아젠투지 자체 데이터 저장·동기화용 DB 설정과 별개입니다.':'This connects Supabase accounts and deployment targets for local projects. It is separate from the database used for AgentsToZ’s own data and sync.'}</p>}
    {provider==='github'&&!newcomer&&<div className="my-3 space-y-2 rounded-lg border border-[var(--line)] p-3">
      <button type="button" className={button} disabled={busy} onClick={()=>void perform({operation:'native-github-accounts'})}>{ko?'기존 GitHub 로그인 찾기':'Find existing GitHub logins'}</button>
      <p className="text-xs text-[var(--ink-3)]">{ko?'기존 로그인은 아래 ‘사용할 계정’에서 바로 선택할 수 있습니다. 전역 활성 계정은 바꾸지 않습니다.':'Select an existing login under Account below. The global active account stays unchanged.'}</p>
    </div>}
    <div className="mt-3 space-y-2">{accounts.filter(a=>a.provider===provider&&(!a.source||a.source==='managed')).map(a=><div key={a.id} className="rounded-lg border border-[var(--line)] p-3 text-xs">
      <strong>{a.label}</strong><span className="ml-2 text-[var(--ink-3)]">{a.identity??(a.state==='ready'?(a.verifiedEmail??a.label):(ko?'신규 계정':'New account'))} · {a.state==='ready'?(ko?'확인됨':'Checked'):(ko?'연결 확인 필요':'Needs check')}</span>
      {!newcomer&&<div className="mt-2 flex flex-wrap gap-2"><button type="button" className={button} disabled={busy} onClick={()=>void perform({operation:'check',accountId:a.id})}>{ko?'연결 확인':'Check connection'}</button>{!appSync&&a.state==='ready'&&a.verifiedEmail&&<button type="button" className={button} disabled={busy||defaults[provider]?.accountId===a.id} onClick={()=>void perform({operation:'set-default',provider,email:a.verifiedEmail,accountId:a.id})}>{defaults[provider]?.accountId===a.id?(ko?'현재 기본 계정':'Current default'):(ko?'기본 계정으로 사용':'Use as default')}</button>}{!appSync&&<button type="button" className={button} disabled={busy} onClick={()=>void perform({operation:'archive',accountId:a.id})}>{ko?'목록에서 제외':'Remove from list'}</button>}</div>}
    </div>)}</div>
    {!appSync&&!newcomer&&<fieldset className="my-3 space-y-2 rounded-lg border border-[var(--line)] p-3" disabled={busy}>
      <legend className="px-1 text-xs font-semibold">{ko?'3. 이 Mac에서 프로젝트 작업에 쓸 기본 계정':'3. Default account for project work on this Mac'}</legend>
      <label className="block text-xs">{ko?'계정 이메일':'Account email'}<input type="email" className={input+' mt-1'} value={defaultEmail} maxLength={120} onChange={e=>{setDefaultEmail(e.target.value);setDefaultAccount('');}}/></label>
      <label className="block text-xs">{ko?'인증된 기본 계정':'Verified default account'}<select aria-label={ko?'인증된 기본 계정':'Verified default account'} className={input+' mt-1'} value={defaultAccount} onChange={e=>setDefaultAccount(e.target.value)}><option value="">{ko?'로그인 필요 · 다른 계정으로 대체 안 함':'Sign-in required · no fallback'}</option>{accounts.filter(a=>a.provider===provider&&a.verifiedEmail===defaultEmail.trim().toLowerCase()&&a.state==='ready').map(a=><option key={a.id} value={a.id}>{a.label}{a.identity?' · '+a.identity:''}</option>)}</select></label>
      <button type="button" className={button} disabled={!defaultEmail.trim()||busy} onClick={()=>void perform({operation:'set-default',provider,email:defaultEmail.trim(),accountId:defaultAccount||null})}>{ko?'기기 기본값 저장':'Save device default'}</button>
      <p className="break-words text-xs">{defaults[provider]?.email??(ko?'현재 CLI 로그인 사용':'Use current CLI login')} · {defaults[provider]?.accountId?(ko?'연결됨':'Connected'):defaults[provider]?(ko?'로그인 필요':'Sign-in required'):(ko?'기기 기본값 미지정':'No device default')}</p>
    </fieldset>}
    {!appSync&&!newcomer&&<details><summary className="cursor-pointer text-xs">{ko?`고급 · ${PLATFORM_CLI_LABELS[provider]} 작업 계정 직접 등록`:`Advanced · register a ${PLATFORM_CLI_LABELS[provider]} work account`}</summary><p className="mt-3 text-xs leading-5">{ko?`적용 대상: 위에서 선택한 ${PLATFORM_CLI_LABELS[provider]}의 프로젝트 작업용 계정입니다. 브라우저 로그인 대신 토큰·사용자 인증 JSON으로 등록할 때만 사용하세요. 계정 추가 → 연결 확인 → 기기 기본값 또는 프로젝트 선택 순서로 적용합니다. 아젠투지 자체 데이터 저장소와 iPhone·웹 로그인 허용 이메일은 여기서 바뀌지 않습니다.`:`Applies to ${PLATFORM_CLI_LABELS[provider]} accounts for project work. Use this instead of browser sign-in. Add the account, verify it, then select a device default or project. AgentsToZ data storage and phone/web access remain separate.`}</p><form className="my-4 space-y-2 rounded-lg border border-[var(--line)] p-3" onSubmit={e=>{e.preventDefault();const value=credential;setCredential('');void perform({operation:'create',provider,label:label.trim(),credential:value});}}>
      <label className="block text-xs">{ko?'계정 이름':'Account name'}<input className={input+' mt-1'} value={label} maxLength={64} disabled={busy} autoComplete="off" placeholder={ko?'예: 회사 개발 계정':'e.g. Work development'} onInput={e=>setLabel(e.currentTarget.value)}/></label>
      {provider==='google-workspace'?<label className="block text-xs">{ko?'기존 사용자 인증 JSON (고급)':'Existing user authorization JSON (advanced)'}<input type="file" accept=".json,application/json" className="mt-2 block max-w-full text-xs" disabled={busy} onChange={e=>{const file=e.target.files?.[0],epoch=generation.current;if(!file)return;if(file.size>16_384){setMessage(ko?'16KB 이하의 사용자 OAuth JSON을 선택하세요.':'Choose a user OAuth JSON file below 16 KB.');return;}void file.text().then(v=>{if(generation.current===epoch)setCredential(v);}).catch(()=>{if(generation.current===epoch)setMessage(ko?'OAuth JSON 파일을 읽지 못했습니다.':'Could not read the OAuth JSON file.');});e.target.value='';}}/></label>:
      <label className="block text-xs">{ko?'액세스 토큰':'Access token'}<input type="password" className={input+' mt-1'} value={credential} disabled={busy} autoComplete="new-password" spellCheck={false} onInput={e=>setCredential(e.currentTarget.value)} /></label>}
      <p className="text-xs text-[var(--ink-3)]">{provider==='google-workspace'?(ko?'본인 계정의 gws OAuth 내보내기 JSON을 사용하세요. 서비스 계정 키는 받지 않습니다.':'Use your gws user OAuth export JSON. Service-account keys are not accepted.'):(ko?'작업할 저장소·프로젝트에 필요한 권한의 토큰을 사용하세요.':'Use a token with the required repository or project permissions.')}</p>
      <a className="inline-block text-xs underline" href={links[provider]} target="_blank" rel="noreferrer">{ko?'인증 정보 준비 안내':'Credential setup guide'}</a>
      <button type="submit" className={button+' ml-2'} disabled={busy||!label.trim()||!credential}>{ko?'계정 추가':'Add account'}</button>
    </form></details>}
    {!appSync&&projects.length>0&&<fieldset className="space-y-2 rounded-lg border border-[var(--line)] p-3" disabled={busy}>
      <legend className="px-1 text-xs font-semibold">{ko?'4. 선택한 프로젝트의 작업 계정·대상':'4. Work account and target for one project'}</legend><p className="text-xs leading-5">{ko?'이 설정은 실행할 계정·대상을 고릅니다. 실제 프로젝트 접근 권한은 작업할 때 별도로 확인합니다. 선택 저장만으로 권한 확인이 완료되지는 않습니다.':'This selects a work account and target. Access is verified separately when the project is used. Saving a selection does not prove permission.'}</p>
      <label className="block text-xs">{ko?'프로젝트':'Project'}<select aria-label={ko?'프로젝트':'Project'} className={input+' mt-1'} value={targetId} onChange={e=>setTargetId(e.target.value)}><option value="">{ko?'프로젝트 선택':'Choose a project'}</option>{projects.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
      <label className="block text-xs">{ko?'사용할 계정':'Account'}<select aria-label={ko?'사용할 계정':'Account'} className={input+' mt-1'} value={binding.accountId} onChange={e=>setBinding(b=>({...b,accountId:e.target.value}))}>{platformCliAccountOptions(accounts,provider,binding.accountId).map(a=><option key={a.id} value={a.id}>{a.source==='default'?(ko?'기기 기본값 따르기':'Follow device default')+' · '+(defaults[provider]?.email??(ko?'현재 CLI 로그인':'Current CLI login'))+(a.state==='login-required'?(ko?' · 로그인 필요':' · Sign-in required'):''):a.label}{a.identity?' · '+a.identity:''}</option>)}</select></label>
      {provider==='vercel'&&<label className="block text-xs">{ko?'팀 slug':'Team slug'}<input className={input+' mt-1'} value={binding.scope} onChange={e=>setBinding(b=>({...b,scope:e.target.value}))}/></label>}
      <label className="block text-xs">{provider==='github'?(ko?'기본 저장소 · owner/repo (선택)':'Default repository · owner/repo (optional)'):provider==='supabase'?(ko?'프로젝트 ref':'Project ref'):provider==='vercel'?'Vercel Project ID':(ko?'Google Cloud 프로젝트 ID (선택)':'Google Cloud project ID (optional)')}<input className={input+' mt-1'} placeholder={provider==='github'?'origin':ko?'프로젝트의 기존 연결 사용':'Use the project’s existing link'} value={binding.resourceId} onInput={e=>{const resourceId=e.currentTarget.value;setBinding(b=>({...b,resourceId}));}}/></label>
      <p className="text-xs">{binding.accountId===PLATFORM_CLI_DEFAULT_ACCOUNT?(ko?'기기 기본값을 따름':'Following device default'):(ko?'이 프로젝트에서 계정 지정':'Account fixed for this project')}</p>
      <button type="button" className={button} disabled={!targetId||!binding.accountId||busy} onClick={()=>void perform({operation:'bind',targetId,provider,binding})}>{ko?'프로젝트에 연결':'Connect to project'}</button>
    </fieldset>}
    {!appSync&&projects.length===0&&<p className="mt-3 text-xs leading-5">{ko?'프로젝트별 계정·대상은 프로젝트를 등록한 뒤 해당 프로젝트의 CLI 설정에서 선택하세요.':'After registering a project, choose its work account and target in that project’s CLI settings.'}</p>}
    <PlatformConnectionProgress requestId={connectionId} ko={ko} onComplete={v=>{setMessage(ko?`연결 확인: ${v.account?.identity??label}`:`Connection checked: ${v.account?.identity??label}`);setReload(n=>n+1);}}/>
    {message&&<p role="status" className="mt-3 break-words text-xs leading-5">{message}</p>}
  </details>;
}
