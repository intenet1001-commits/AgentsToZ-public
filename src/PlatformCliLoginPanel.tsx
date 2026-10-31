import {invoke} from '@tauri-apps/api/core';
import {isTauri} from './lib/env';
import {useEffect,useRef,useState} from 'react';
import {terminalLocalRequest} from './aiTerminalClient';
import {PLATFORM_CLI_PATH,type PlatformCliAccount,type PlatformCliProvider,type PlatformCliAccountPurpose} from './platformCliProtocol';
import type {PlatformCliLoginView} from './platformCliLogin';
import {platformConnectionOperation} from './platformCliOperationClient';
import {openPreferredBrowser} from './openPreferredBrowser';
import type {BrowserProfile} from './browserProfile';
import {browserProfileOptionLabel} from './browserProfile';
import {PlatformGoogleClientSetup} from './PlatformGoogleClientSetup';
import {PLATFORM_SIGNUP_URLS} from './platformCliSetupGuide';
import {PLATFORM_CLI_LABELS} from './platformCliProtocol';
import {writeOnboardingClipboard} from './onboardingClipboard';
const button='min-h-[44px] rounded-lg border border-[var(--line)] px-3 py-2 text-xs disabled:opacity-50';
export function PlatformCliLoginPanel({provider,email,ko,disabled=false,onConnected,onVerificationStarted,onLoginStarted,purpose='project-cli',discoverEmail=false}:{provider:PlatformCliProvider;email:string;ko:boolean;disabled?:boolean;purpose?:PlatformCliAccountPurpose;discoverEmail?:boolean;onConnected:(account?:PlatformCliAccount)=>void;onVerificationStarted:(id:string)=>void;
  /** The id of a sign-in this panel just asked for, before its answer: the helpdesk's help links its run to it. */
  onLoginStarted?:(loginId:string)=>void}){
  const views=useRef<Partial<Record<PlatformCliProvider,PlatformCliLoginView>>>({});
  const [loginEmail,setLoginEmail]=useState(email);
  useEffect(()=>{setLoginEmail(email);},[provider,email]);
  const [login,setLogin]=useState<PlatformCliLoginView|null>(null),[message,setMessage]=useState(''),[code,setCode]=useState('');
  const [googleReady,setGoogleReady]=useState(false);
  const [profiles,setProfiles]=useState<BrowserProfile[]>([]),[profileId,setProfileId]=useState('');
  useEffect(()=>{let current=true;void (isTauri()?invoke<BrowserProfile[]>('list_browser_profiles'):fetch('/api/browser-profiles').then(r=>r.json()).then(r=>r.profiles??[])).then(rows=>{if(current)setProfiles(rows);}).catch(()=>{});return()=>{current=false;};},[]);
  const [nativeBusy,setNativeBusy]=useState(false);
  const epoch=useRef(0),generation=useRef(0),actionLock=useRef(false);
  const openAfterAdmission=useRef(new Set<string>());
  const request=(body:unknown)=>terminalLocalRequest(PLATFORM_CLI_PATH,body);
  useEffect(()=>{generation.current++;setLogin(views.current[provider]??null);setMessage('');setCode('');return()=>{generation.current++;};},[provider]);
  useEffect(()=>{const current=generation.current;let id:string|null=null;try{id=localStorage.getItem(`agentstoz-cli-login:${purpose}:${provider}`);}catch{}if(id)void request({operation:'login-status',loginId:id}).then(r=>{if(generation.current===current)accept(r.login);}).catch(()=>{if(generation.current===current)setMessage(ko?'이전 로그인 결과를 확인하지 못했습니다. 기존 계정 목록을 먼저 확인하세요.':'Read the existing account list before starting another login.');});},[provider,purpose]);
  const accept=(view:PlatformCliLoginView)=>{views.current[view.provider]=view;setLogin(view);if(view.state==='completed')onConnected(view.account);};
  useEffect(()=>{
    if(!login||login.provider!==provider||!['waiting','checking'].includes(login.state))return;
    let current=true,timer:ReturnType<typeof setTimeout>;const id=login.id;
    const read=async()=>{
      if(!current)return;
      if(Date.now()>login.expiresAt+5000){setMessage(ko?'로그인 시간이 지났습니다. 결과를 확인한 뒤 새로 시작하세요.':'Login expired. Check its result before starting again.');return;}
      if(document.hidden){timer=setTimeout(read,2000);return;}
      try{const r=await request({operation:'login-status',loginId:id});if(!current)return;accept(r.login);}
      catch{if(current)setMessage(ko?'로그인 상태를 확인하지 못했습니다. 새 로그인을 시작하기 전에 같은 요청의 결과를 확인하세요.':'Login status unavailable. Check this request before starting another.');}
      if(current)timer=setTimeout(read,2000);
    };
    timer=setTimeout(read,1000);return()=>{current=false;clearTimeout(timer);};
  },[login?.id,login?.state,provider,ko]);
  async function action(operation:'login-start'|'login-code'|'login-cancel'|'login-status'){
    if(actionLock.current)return;
    const current=generation.current,turn=++epoch.current;setMessage('');
    const id=operation==='login-start'?crypto.randomUUID():login?.id;if(!id)return;actionLock.current=true;
    if(operation==='login-start'){
      if(discoverEmail)openAfterAdmission.current.add(id);
      try{localStorage.setItem(`agentstoz-cli-login:${purpose}:${provider}`,id);}catch{}
      // Retain the exact request even if the admission reply is lost.
      const initial:PlatformCliLoginView={id,provider,purpose,email:discoverEmail?'':loginEmail.trim(),state:'waiting',expiresAt:Date.now()+600_000};views.current[provider]=initial;setLogin(initial);onLoginStarted?.(id);
    }
    const value=code;setCode('');
    try{const r=await request(operation==='login-start'?(discoverEmail?{operation:'login-onboarding-start',provider,purpose,requestId:id}:{operation,provider,purpose,email:loginEmail.trim(),requestId:id}):{operation,loginId:id,...(operation==='login-code'?{code:value}:{})});if(generation.current===current&&epoch.current===turn)accept(r.login.cancelled?{...views.current[provider]!,state:'cancelled'}:r.login);}
    catch(error){if(generation.current===current)setMessage(error instanceof Error?error.message:(ko?'로그인 결과를 확인하세요.':'Check the login result.'));}
    finally{actionLock.current=false;}
  }
  const active=login?.provider===provider&&['waiting','checking'].includes(login.state);
  useEffect(()=>{
    if(!discoverEmail||!login?.url||!active||!openAfterAdmission.current.delete(login.id))return;
    void openPreferredBrowser(login.url,profiles.find(p=>p.id===profileId)).catch(()=>setMessage(ko?'공식 로그인 화면을 열지 못했습니다. 아래 로그인 페이지 열기를 눌러 주세요.':'Could not open the official sign-in page. Use Open sign-in page below.'));
  },[discoverEmail,login?.id,login?.url,active]);
  return <section className="my-3 space-y-2 rounded-lg border border-[var(--line)] p-3" aria-label={ko?'브라우저 로그인':'Browser login'}>
    <p className="text-xs leading-5">{ko?'계정이 없다면 먼저 가입하세요. 이미 가입했다면 아래에서 기존 로그인 또는 브라우저 인증으로 연결하세요.':'Create an account first if needed, or connect your existing account below.'}</p>
    <a className={button+' inline-block'} href={PLATFORM_SIGNUP_URLS[provider]} target="_blank" rel="noreferrer" onClick={e=>{e.preventDefault();void openPreferredBrowser(PLATFORM_SIGNUP_URLS[provider],profiles.find(p=>p.id===profileId)).catch(e=>setMessage(e.message));}}>{PLATFORM_CLI_LABELS[provider]} {ko?'회원가입':'sign up'}</a>
    <p className="text-xs leading-5">{ko?'공식 CLI가 시작하는 브라우저에서 직접 계정을 선택하고 접근을 승인하세요. 승인 후 이메일을 확인하며 전역 활성 로그인은 바꾸지 않습니다.':'Choose your account and approve access in the browser flow started by the CLI. We verify the email and preserve global logins.'}</p>
    {provider==='google-workspace'&&<><PlatformGoogleClientSetup ko={ko} disabled={!!active} onReady={setGoogleReady}/><h4 className="text-sm font-semibold">{ko?'2. Google 계정 연결':'2. Connect a Google account'}</h4><p className="text-xs leading-5">{ko?'Drive 읽기 권한을 요청합니다. gws는 Google의 공식 지원 제품이 아닙니다.':'This requests Drive read access. gws is not an officially supported Google product.'}</p></>}
    {provider==='supabase'&&!discoverEmail&&<p className="text-xs leading-5">{purpose==='app-sync-account'?(ko?'브라우저로 새 로그인 시 계정 전체의 CLI 관리 토큰을 만듭니다. 이미 로그인했다면 기존 로그인 확인·연결을 선택할 수 있습니다.':'A new browser login creates an account-wide CLI management token. You can connect an existing login instead.') : ko?'Supabase CLI 브라우저 로그인은 계정 전체의 classic 토큰을 만듭니다. 제한된 권한이 필요하면 고급 등록에서 scoped PAT를 사용하세요.':'Supabase CLI browser login creates an account-wide classic token. Use a scoped PAT in advanced registration when needed.'}</p>}
    {!discoverEmail&&<label className="block text-xs">{ko?'연결할 이메일':'Email to connect'}<input type="email" className="min-h-[44px] w-full rounded-lg border border-[var(--line)] bg-[var(--bg-input)] p-2 text-base" disabled={!!active} value={loginEmail} onChange={e=>setLoginEmail(e.target.value)}/></label>}
    {!discoverEmail&&<button type="button" className={button} disabled={disabled||nativeBusy||!!active||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(loginEmail.trim())} onClick={()=>{setNativeBusy(true);setMessage('');void platformConnectionOperation({operation:'connect-native-start',provider,purpose,email:loginEmail.trim()},onVerificationStarted).then(()=>setMessage(ko?'계정 확인을 시작했습니다. 키체인 확인창을 처리한 뒤 같은 요청 결과를 확인하세요.':'Verification started. Handle the Keychain prompt, then read this same result.')).catch(e=>setMessage(e.message)).finally(()=>setNativeBusy(false));}}>{nativeBusy?(ko?'기존 계정 확인 중…':'Checking existing login…'):(ko?'기존 로그인 확인·연결':'Connect existing login')}</button>}
    <button type="button" className={button} disabled={disabled||nativeBusy||!discoverEmail&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(loginEmail.trim())||!!active||provider==='google-workspace'&&!googleReady} onClick={()=>void action('login-start')}>{ko?(discoverEmail?'공식 화면에서 로그인·인증':'브라우저로 계정 연결'):'Connect through browser'}</button>
    <p className="text-xs leading-5">{discoverEmail?(ko?'공식 인증 뒤 서비스가 확인한 이메일을 자동으로 읽습니다. 기존 연결 계정이 위에 있다면 다시 가입할 필요가 없습니다.':'After official sign-in, the verified email is read automatically. No new sign-up is needed if your account is already listed above.'):ko?'기존 로그인은 위 이메일과 일치할 때만 연결합니다. 계정이 없으면 브라우저 로그인 화면에서 새 계정을 만든 뒤 이어가세요.':'An existing login is connected only if its email matches. If you do not have an account, sign up on the provider’s browser page and continue.'}</p>
    {provider==='google-workspace'&&<p className="text-xs leading-5">{ko?'3. Google 승인 뒤 실제 이메일을 확인한 계정만 아래 목록에 표시됩니다. 다른 이메일도 위 과정을 반복해 추가하세요.':'3. After Google approval, only accounts with a verified email appear below. Repeat these steps to add another email.'}</p>}
    {profiles.length>0&&<label className="block text-xs">{ko?'로그인할 브라우저 프로필':'Browser profile for sign-in'}<select aria-label={ko?'로그인할 브라우저 프로필':'Browser profile for sign-in'} className="min-h-11 w-full rounded-lg border border-[var(--line)] bg-[var(--bg-input)] p-2" value={profileId} onChange={e=>setProfileId(e.target.value)}><option value="">{ko?'앱에 설정한 브라우저':'Preferred browser'}</option>{profiles.map(p=><option key={p.id} value={p.id}>{browserProfileOptionLabel(p)}</option>)}</select></label>}
    {login&&<>
      <p className="break-words text-xs" role="status">{login.email} · {login.state==='completed'?(ko?'이메일 인증 완료':'Email verified'):login.state==='interrupted'?(ko?'중단 · 결과 확인 필요':'Interrupted · verify the result'):login.state==='failed'?(ko?'로그인 실패':'Login failed'):login.state==='cancelled'?(ko?'취소됨':'Cancelled'):login.state==='checking'?(ko?'인증 계정 확인 중':'Checking identity'):(ko?'사용자 승인 대기':'Waiting for your approval')}</p>
      {login.url&&<a href={login.url} target="_blank" rel="noreferrer" className="inline-block min-h-[44px] break-all py-3 text-sm underline" onClick={e=>{e.preventDefault();void openPreferredBrowser(login.url!,profiles.find(p=>p.id===profileId)).catch(e=>setMessage(e.message));}}>{ko?'로그인 페이지 열기':'Open sign-in page'}</a>}
      {login.code&&<p className="select-all text-sm"><span>{ko?'브라우저 입력 코드':'Browser code'}: {login.code}</span> <button type="button" className={button} onClick={()=>void writeOnboardingClipboard(login.code!).then(copied=>setMessage(copied?(ko?'인증 코드를 복사했습니다. 공식 화면에 붙여넣으세요.':'Code copied. Paste it on the official page.'):(ko?'코드를 직접 복사하세요.':'Copy the code manually.')))}>{ko?'인증 코드 복사':'Copy code'}</button></p>}
      {login.needsCode&&<label className="block text-xs">{ko?'Supabase 확인 코드':'Supabase verification code'}<input className="min-h-[44px] w-full rounded-lg border border-[var(--line)] bg-[var(--bg-input)] p-2 text-base" value={code} autoComplete="one-time-code" onChange={e=>setCode(e.target.value)}/><button type="button" className={button} disabled={!code} onClick={()=>void action('login-code')}>{ko?'확인 코드 전송':'Submit code'}</button></label>}
      <button type="button" className={button} onClick={()=>void action('login-status')}>{ko?'같은 로그인 결과 확인':'Check this login'}</button>
      {active&&<button type="button" className={button} disabled={login.state==='checking'} onClick={()=>void action('login-cancel')}>{ko?'로그인 취소':'Cancel login'}</button>}
      {login.message&&<p className="text-xs" role="status">{login.message}</p>}
    </>}
    {message&&<p className="text-xs" role="status">{message}</p>}
  </section>;
}
