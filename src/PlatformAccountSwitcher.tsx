import {useEffect,useRef,useState} from 'react';
import {terminalLocalRequest} from './aiTerminalClient';
import {PLATFORM_CLI_DEFAULT_ACCOUNT,PLATFORM_CLI_PATH,PLATFORM_CLI_PROVIDERS,PLATFORM_CLI_LABELS,type PlatformCliAccount,type PlatformCliProvider,type PlatformCliBinding,type PlatformCliDeviceDefaults} from './platformCliProtocol';
import type {PlatformNativeState} from './platformCliNativeSwitch';
import type {PlatformCliEverywhereStatus} from './platformCliEverywhere';
import type {PlatformCliLoginView} from './platformCliLogin';
import {platformCliAccountOptions} from './platformCliAccountOptions';
import {PlatformCliLoginPanel} from './PlatformCliLoginPanel';
import {openPreferredBrowser} from './openPreferredBrowser';
import {writeOnboardingClipboard} from './onboardingClipboard';
import {openHelpdeskAssist} from './helpdeskAssistClient';
import {ASSIST_BUTTON,type AssistOrigin,type AssistScope} from './helpdeskAssistProtocol';

/**
 * Easy CLI account switching. Three places, one account list:
 * - this Mac (MacCliAccountSwitcher): the gh·supabase·vercel login every terminal and app uses;
 * - one project (ProjectCliAccounts): wins over this Mac; picking an account applies at once, no new sign-in;
 * - a project being created (NewProjectCliAccounts): the same choice, applied once it is registered.
 */
const ADD='__add';
const control='min-h-[44px] w-full min-w-0 rounded-lg border border-[var(--line)] bg-[var(--bg-input)] px-3 py-2 text-sm';
const small='min-h-[36px] rounded-lg border border-[var(--line)] px-3 py-1.5 text-xs disabled:opacity-50';
const request=(body:Record<string,unknown>)=>terminalLocalRequest(PLATFORM_CLI_PATH,body);
const failure=(error:unknown,ko:boolean)=>error instanceof Error&&error.message?error.message:(ko?'결과를 확인하지 못했습니다. 목록을 다시 읽은 뒤 시도하세요.':'Result unavailable. Reload the list before retrying.');
const lower=(v:string|null|undefined)=>(v??'').trim().toLowerCase();
const addLabel=(ko:boolean)=>ko?'＋ 다른 계정 로그인해서 추가…':'＋ Sign in to add another account…';
const accountName=(a:PlatformCliAccount)=>a.source==='native'?(a.identity??a.label):a.verifiedEmail&&a.identity&&lower(a.identity)!==lower(a.verifiedEmail)?`${a.identity} · ${a.verifiedEmail}`:(a.verifiedEmail??a.identity??a.label);
/** Who "this Mac" means for a provider, in the words a person reads in the picker. */
function macAccountName(provider:PlatformCliProvider,accounts:PlatformCliAccount[],defaults:PlatformCliDeviceDefaults,ko:boolean){
  const chosen=defaults[provider];if(chosen)return chosen.email;
  return accounts.find(a=>a.provider===provider&&a.source==='default')?.identity??(ko?'현재 로그인':'current login');
}

/** Adds an account through the official sign-in in the browser; nothing to type in the app. */
/** Where 헬프데스크 도움받기 started here applies: an added account changes no Mac default; a project's help binds only it. */
type QuickAssist={scope:AssistScope;origin:AssistOrigin};
// The quick login stays open under the helpdesk; closing the helpdesk returns here with the same choice on screen.
const assistEntry=(provider:PlatformCliProvider,assist:QuickAssist|undefined,ko:boolean)=>assist?<button type="button" className={small} onClick={()=>openHelpdeskAssist({service:provider,goal:'connect',stage:'account',scope:assist.scope,origin:assist.origin})}>{ko?ASSIST_BUTTON:'Helpdesk assist'}</button>:null;
export function QuickCliLogin({provider,ko,onAdded,onClose,assist}:{provider:PlatformCliProvider;ko:boolean;onAdded:(account:PlatformCliAccount)=>void;onClose:()=>void;assist?:QuickAssist}) {
  const key=`agentstoz-cli-quick-login:${provider}`;
  const [view,setView]=useState<PlatformCliLoginView|null>(null),[message,setMessage]=useState(''),[code,setCode]=useState('');
  const opened=useRef(new Set<string>()),reported=useRef(new Set<string>());
  const forget=()=>{try{localStorage.removeItem(key);}catch{}};
  const accept=(next:PlatformCliLoginView)=>{
    setView(next);
    if(next.state==='completed'&&next.account&&!reported.current.has(next.id)){reported.current.add(next.id);forget();onAdded(next.account);}
    if(['failed','cancelled','interrupted'].includes(next.state))forget();
  };
  // A sign-in started before a reload is that same sign-in: read it, never start another.
  useEffect(()=>{
    if(provider==='google-workspace')return;let id:string|null=null;try{id=localStorage.getItem(key);}catch{}if(!id)return;
    let live=true;opened.current.add(id);
    void request({operation:'login-status',loginId:id}).then(r=>{if(live)accept(r.login);}).catch(()=>{if(live)forget();});
    return()=>{live=false;};
  },[provider]);
  useEffect(()=>{
    if(!view||!['waiting','checking'].includes(view.state))return;
    let live=true,timer:ReturnType<typeof setTimeout>;const id=view.id;
    const read=async()=>{
      try{const r=await request({operation:'login-status',loginId:id});if(live)accept(r.login);}
      catch{if(live)setMessage(ko?'로그인 상태를 확인하지 못했습니다. 잠시 뒤 다시 확인합니다.':'Could not read the sign-in. Checking again shortly.');}
      if(live)timer=setTimeout(read,1500);
    };
    timer=setTimeout(read,1200);return()=>{live=false;clearTimeout(timer);};
  },[view?.id,view?.state]);
  useEffect(()=>{
    if(!view?.url||view.state!=='waiting'||opened.current.has(view.id))return;opened.current.add(view.id);
    void openPreferredBrowser(view.url).catch(()=>setMessage(ko?'브라우저를 열지 못했습니다. 아래 「로그인 화면 열기」를 눌러 주세요.':'Could not open the browser. Use “Open sign-in page” below.'));
  },[view?.id,view?.url,view?.state]);
  async function start(){
    const id=crypto.randomUUID();try{localStorage.setItem(key,id);}catch{}
    setMessage('');setView({id,provider,email:'',state:'waiting',expiresAt:Date.now()+600_000});
    try{accept((await request({operation:'login-add-start',provider,requestId:id})).login);}
    catch(error){setMessage(failure(error,ko));}
  }
  async function send(operation:'login-code'|'login-cancel'){
    if(!view)return;const value=code.trim();setCode('');
    try{const r=await request({operation,loginId:view.id,...(operation==='login-code'?{code:value}:{})});accept(r.login?.cancelled?{...view,state:'cancelled'}:r.login);}
    catch(error){setMessage(failure(error,ko));}
  }
  if(provider==='google-workspace')return <div className="mt-2 space-y-2" data-testid="cli-quick-login">
    <PlatformCliLoginPanel provider={provider} email="" ko={ko} onVerificationStarted={()=>{}} onConnected={account=>{if(account)onAdded(account);}}/>
    <div className="flex flex-wrap gap-2">{assistEntry(provider,assist,ko)}<button type="button" className={small} onClick={onClose}>{ko?'닫기':'Close'}</button></div>
  </div>;
  const active=!!view&&['waiting','checking'].includes(view.state);
  return <div className="mt-2 space-y-2 rounded-lg border border-[var(--line)] p-3 text-xs leading-5" data-testid="cli-quick-login">
    {!active&&<>
      <p>{ko?`${PLATFORM_CLI_LABELS[provider]} 공식 로그인 화면이 브라우저에 열립니다. 추가할 계정으로 로그인해 승인하면 끝입니다. 이메일은 자동으로 확인합니다.`:`The official ${PLATFORM_CLI_LABELS[provider]} sign-in opens in your browser. Sign in with the account to add and approve; the email is read automatically.`}</p>
      {view&&view.state!=='completed'&&<p role="status">{view.message??(view.state==='cancelled'?(ko?'로그인을 취소했습니다.':'Sign-in cancelled.'):(ko?'로그인이 끝나지 않았습니다. 다시 시작할 수 있습니다.':'Sign-in did not finish. You can start again.'))}</p>}
      <div className="flex flex-wrap gap-2">
        <button type="button" className={small+' font-semibold'} data-testid="cli-quick-login-start" onClick={()=>void start()}>{ko?'브라우저에서 로그인':'Sign in in the browser'}</button>
        {assistEntry(provider,assist,ko)}<button type="button" className={small} onClick={onClose}>{ko?'닫기':'Close'}</button>
      </div>
    </>}
    {active&&view&&<>
      <p role="status">{view.state==='checking'?(ko?'로그인한 계정을 확인하는 중…':'Checking the account…'):(ko?'브라우저에서 계정을 고르고 승인하세요. 끝나면 자동으로 추가됩니다.':'Choose the account and approve in the browser. It is added automatically.')}</p>
      {view.code&&<p className="text-sm">{ko?'브라우저에 입력할 코드':'Code for the browser'}: <strong className="select-all font-mono">{view.code}</strong> <button type="button" className={small} onClick={()=>void writeOnboardingClipboard(view.code!).then(ok=>setMessage(ok?(ko?'코드를 복사했습니다.':'Code copied.'):(ko?'코드를 직접 복사하세요.':'Copy the code manually.')))}>{ko?'복사':'Copy'}</button></p>}
      {view.url&&<a href={view.url} target="_blank" rel="noreferrer" className="inline-block min-h-[36px] py-2 underline" onClick={e=>{e.preventDefault();void openPreferredBrowser(view.url!).catch(error=>setMessage(failure(error,ko)));}}>{ko?'로그인 화면 열기':'Open sign-in page'}</a>}
      {view.needsCode&&<form className="flex gap-2" onSubmit={e=>{e.preventDefault();if(code.trim())void send('login-code');}}>
        <input className={control} aria-label={ko?'Supabase 확인 코드':'Supabase verification code'} placeholder={ko?'브라우저에 나온 확인 코드':'Code shown in the browser'} value={code} autoComplete="one-time-code" onChange={e=>setCode(e.target.value)}/>
        <button type="submit" className={small} disabled={!code.trim()}>{ko?'보내기':'Send'}</button>
      </form>}
      <button type="button" className={small} disabled={view.state==='checking'} onClick={()=>void send('login-cancel')}>{ko?'로그인 취소':'Cancel sign-in'}</button>
    </>}
    {message&&<p role="status">{message}</p>}
  </div>;
}

/** This Mac's own login per CLI — what plain terminals, apps and AgentsToZ use when a project has no account of its own. */
export function MacCliAccountSwitcher({language,compact=false}:{language:string;compact?:boolean}) {
  const ko=language==='ko';
  const [states,setStates]=useState<PlatformNativeState[]|null>(null),[accounts,setAccounts]=useState<PlatformCliAccount[]>([]),[defaults,setDefaults]=useState<PlatformCliDeviceDefaults>({});
  const [busy,setBusy]=useState<PlatformCliProvider|null>(null),[adding,setAdding]=useState<PlatformCliProvider|null>(null),[removing,setRemoving]=useState('');
  const [notes,setNotes]=useState<Partial<Record<PlatformCliProvider,string>>>({}),[error,setError]=useState('');
  const [everywhere,setEverywhere]=useState<PlatformCliEverywhereStatus|null>(null),[everywhereNote,setEverywhereNote]=useState(''),[everywhereBusy,setEverywhereBusy]=useState(false);
  const note=(p:PlatformCliProvider,text:string)=>setNotes(n=>({...n,[p]:text}));
  async function load():Promise<PlatformNativeState[]|null> {
    try{
      const [n,l]=await Promise.all([request({operation:'native-status'}),request({operation:'list'})]);
      setStates(n.native);setEverywhere(n.everywhere??null);setAccounts(l.accounts??[]);setDefaults(l.deviceDefaults??{});setError('');return n.native;
    }catch(e){setError(failure(e,ko));return null;}
  }
  useEffect(()=>{void load();},[]);
  async function choose(provider:PlatformCliProvider,accountId:string) {
    if(busy)return;setBusy(provider);note(provider,'');
    try{
      if(provider==='google-workspace'){
        const a=accounts.find(x=>x.id===accountId);
        await request({operation:'set-default',provider,email:a?.verifiedEmail,accountId,requestId:crypto.randomUUID()});
      }else await request({operation:'native-switch',provider,accountId,requestId:crypto.randomUUID()});
      const next=await load(),who=provider==='google-workspace'?accountName(accounts.find(x=>x.id===accountId)!):next?.find(s=>s.provider===provider)?.identity;
      note(provider,ko?`✓ 이 Mac 전체가 ${who??'선택한 계정'}을(를) 씁니다.`:`✓ This Mac now uses ${who??'the selected account'}.`);
    }catch(e){note(provider,failure(e,ko));void load();}
    finally{setBusy(null);}
  }
  async function setEverywhereOn(enabled:boolean) {
    if(everywhereBusy)return;setEverywhereBusy(true);setEverywhereNote('');
    try{
      const r=await request({operation:'everywhere-set',enabled});setEverywhere(r.everywhere??null);
      setEverywhereNote(r.everywhere?.message??(enabled?(ko?'✓ 켰습니다. git은 바로, 터미널은 새로 여는 창부터 적용됩니다.':'✓ On. git applies now; terminals from the next window.'):(ko?'껐습니다. 새로 여는 터미널부터 이 Mac 계정만 씁니다.':'Off. New terminals use this Mac’s accounts only.')));
    }catch(e){setEverywhereNote(failure(e,ko));}
    finally{setEverywhereBusy(false);}
  }
  async function gitSetup() {
    if(busy)return;setBusy('github');note('github','');
    try{await request({operation:'native-git-setup',requestId:crypto.randomUUID()});await load();note('github',ko?'✓ 이제 git push도 GitHub 전환을 따라갑니다.':'✓ git push now follows the GitHub switch.');}
    catch(e){note('github',failure(e,ko));}
    finally{setBusy(null);}
  }
  async function remove(account:PlatformCliAccount) {
    if(removing!==account.id){setRemoving(account.id);return;}
    setRemoving('');setBusy(account.provider);
    try{await request({operation:'archive',accountId:account.id,requestId:crypto.randomUUID()});await load();note(account.provider,ko?'목록에서 제외했습니다. 이 계정을 쓰던 프로젝트는 다른 계정으로 바뀌지 않고 멈춥니다.':'Removed. Projects that used it stop instead of switching to another account.');}
    catch(e){note(account.provider,failure(e,ko));}
    finally{setBusy(null);}
  }
  const managed=accounts.filter(a=>(!a.source||a.source==='managed'));
  return <section className={compact?'space-y-3':'mt-5 space-y-3 border-t border-[var(--line)] pt-4'} data-testid="mac-cli-account-switcher" aria-label={ko?'이 Mac 전체 CLI 계정':'CLI accounts for this whole Mac'}>
    {!compact&&<div><h3 className="font-semibold">{ko?'CLI 계정 전환 · 이 Mac 전체':'CLI accounts · this whole Mac'}</h3>
      <p className="mt-1 text-xs leading-5 text-[var(--ink-3)]">{ko?'고르면 바로 바뀝니다. 터미널·다른 앱·아젠투지 모두 이 계정을 씁니다. 프로젝트에 따로 고른 계정이 있으면 그 프로젝트에서는 그쪽이 우선입니다.':'Pick to switch at once. Terminals, other apps and AgentsToZ all use it. A project’s own account still wins inside that project.'}</p></div>}
    {error&&<p role="status" className="text-xs">{error} <button type="button" className={small} onClick={()=>void load()}>{ko?'다시 읽기':'Reload'}</button></p>}
    {!states&&!error&&<p className="text-xs text-[var(--ink-3)]">{ko?'현재 로그인을 확인하는 중…':'Reading current logins…'}</p>}
    {everywhere&&everywhere.state!=='unsupported'&&<div className="rounded-lg border border-[var(--line)] px-3 py-2 text-xs leading-5" data-testid="cli-everywhere">
      <p><span>{everywhere.state==='on'?(ko?'✓ 등록된 프로젝트 폴더에서는 터미널·VS Code·git 어디서든 그 프로젝트가 고른 계정을 씁니다.':'✓ In a registered project’s folders, every terminal, VS Code and git use that project’s accounts.')
        :everywhere.state==='off'?(ko?'프로젝트 계정은 아젠투지 워크룸에서만 씁니다.':'Project accounts apply in AgentsToZ Workrooms only.')
        :everywhere.state==='pending'?(ko?'프로젝트에 계정을 고르면 그 폴더에서는 터미널·VS Code·git 어디서든 그 계정을 씁니다.':'Once a project has its own account, every terminal, VS Code and git use it in that folder.')
        :(everywhere.message??(ko?'일부만 적용되어 있습니다.':'Partly applied.'))}</span>
        {' '}{everywhere.state==='on'||everywhere.state==='partial'?<button type="button" className={small} disabled={everywhereBusy} onClick={()=>void setEverywhereOn(false)}>{ko?'워크룸에서만 쓰기':'Workrooms only'}</button>:null}
        {everywhere.state==='partial'?<button type="button" className={small+' ml-1'} disabled={everywhereBusy} onClick={()=>void setEverywhereOn(true)}>{ko?'다시 적용':'Apply again'}</button>:null}
        {everywhere.state==='off'?<button type="button" className={small} disabled={everywhereBusy} onClick={()=>void setEverywhereOn(true)}>{ko?'어디서든 쓰기':'Use everywhere'}</button>:null}</p>
      {(everywhere.shell.length>0||everywhere.git)&&<p className="text-[var(--ink-3)]">{ko?'적용한 곳':'Applied in'}: {[...everywhere.shell,...(everywhere.git?[ko?'git 전역 설정':'global git config']:[])].join(' · ')}</p>}
      {everywhereNote&&<p role="status">{everywhereNote}</p>}
    </div>}
    {states&&PLATFORM_CLI_PROVIDERS.map(provider=>{
      const s=states.find(x=>x.provider===provider);if(!s)return null;
      const gws=provider==='google-workspace',gwsOptions=accounts.filter(a=>a.provider===provider&&a.state==='ready'&&a.verifiedEmail&&a.source!=='default'&&a.source!=='native');
      const options=gws?gwsOptions.map(a=>({id:a.id,label:accountName(a),current:defaults[provider]?.accountId===a.id})):s.options;
      const currentId=gws?(defaults[provider]?.accountId??null):s.currentId,selected=currentId&&options.some(o=>o.id===currentId)?currentId:'';
      // AgentsToZ runs use the device default; once the Mac-wide login moved elsewhere, offer to line them up again.
      const appDefault=defaults[provider],appAccount=appDefault?.accountId?accounts.find(a=>a.id===appDefault.accountId):undefined;
      const appWho=appAccount?(provider==='github'?appAccount.identity:appAccount.verifiedEmail):appDefault?.email;
      const drift=!gws&&s.state==='ready'&&!!appDefault&&!!s.identity&&!!appWho&&lower(appWho)!==lower(s.identity)&&!!s.currentId;
      return <div key={provider} className="space-y-1" data-testid={`mac-cli-row-${provider}`}>
        <div className="grid gap-1 sm:grid-cols-[140px_1fr] sm:items-center">
          <span className="text-xs font-semibold">{PLATFORM_CLI_LABELS[provider]}</span>
          {s.state==='not-installed'?<span className="text-xs text-[var(--ink-3)]">{ko?'CLI가 설치되어 있지 않습니다.':'CLI not installed.'}</span>
          :s.state==='unknown'?<span className="text-xs">{s.message}</span>
          :<select aria-label={ko?`${PLATFORM_CLI_LABELS[provider]} 이 Mac 계정`:`${PLATFORM_CLI_LABELS[provider]} account for this Mac`} className={control} disabled={busy!==null} value={selected}
            onChange={e=>{const v=e.target.value;if(v===ADD)setAdding(provider);else if(v)void choose(provider,v);}}>
            {!selected&&<option value="">{gws?(ko?'gws 자체 로그인 사용':'gws’s own login'):s.identity?`${s.identity}${ko?' · 앱에 연결 안 됨':' · not connected'}`:(ko?'로그인 없음':'Not signed in')}</option>}
            {options.map(o=><option key={o.id} value={o.id}>{o.label}{o.current?(ko?' (사용 중)':' (current)'):''}</option>)}
            <option value={ADD}>{addLabel(ko)}</option>
          </select>}
        </div>
        {busy===provider&&<p role="status" className="text-xs">{ko?'바꾸는 중…':'Switching…'}</p>}
        {gws&&s.state!=='not-installed'&&<p className="text-xs text-[var(--ink-3)]">{ko?'gws는 계정 전환 기능이 없어 아젠투지·워크룸 실행에만 적용됩니다.':'gws has no account switching; this applies to AgentsToZ and Workroom runs.'}</p>}
        {provider==='github'&&s.state==='ready'&&s.gitFollows===false&&<p className="text-xs leading-5">{ko?'git push는 아직 macOS 키체인에 저장된 계정을 먼저 씁니다.':'git push still uses the account saved in the macOS Keychain first.'} <button type="button" className={small} disabled={busy!==null} onClick={()=>void gitSetup()}>{ko?'git push도 이 전환을 따르게':'Make git push follow'}</button></p>}
        {drift&&<p className="text-xs leading-5">{ko?`아젠투지 작업은 아직 ${appWho} 계정으로 실행됩니다.`:`AgentsToZ work still runs as ${appWho}.`} <button type="button" className={small} disabled={busy!==null} onClick={()=>void choose(provider,s.currentId!)}>{ko?'이 Mac 계정으로 맞추기':'Use this Mac’s account'}</button></p>}
        {s.message&&s.state==='ready'&&<p className="text-xs text-[var(--ink-3)]">{s.message}</p>}
        {notes[provider]&&<p role="status" className="break-words text-xs">{notes[provider]}</p>}
        {adding===provider&&<QuickCliLogin provider={provider} ko={ko} assist={{scope:{kind:'account-add'},origin:'quick-cli-login-mac'}} onClose={()=>setAdding(null)} onAdded={account=>{setAdding(null);void (gws?load():choose(provider,account.id));}}/>}
      </div>;
    })}
    {states&&managed.length>0&&<details className="text-xs">
      <summary className="min-h-[36px] cursor-pointer py-2">{ko?`연결해 둔 계정 관리 (${managed.length})`:`Manage connected accounts (${managed.length})`}</summary>
      <ul className="mt-1 space-y-1">{managed.map(a=><li key={a.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--line)] px-3 py-2">
        <span className="min-w-0 break-words">{PLATFORM_CLI_LABELS[a.provider]} · {accountName(a)}{a.state!=='ready'?(ko?' · 확인 필요':' · needs check'):''}</span>
        <button type="button" className={small} disabled={busy!==null} onClick={()=>void remove(a)}>{removing===a.id?(ko?'한 번 더 눌러 제외':'Press again to remove'):(ko?'목록에서 제외':'Remove')}</button>
      </li>)}</ul>
      <p className="mt-2 text-[var(--ink-3)]">{ko?'제외해도 서비스의 로그인 권한은 취소되지 않습니다. 완전히 끊으려면 각 서비스의 보안 설정에서 해제하세요.':'Removing does not revoke the service token; revoke it in the service’s security settings.'}</p>
    </details>}
  </section>;
}

type ProjectAccounts={accounts:PlatformCliAccount[];deviceDefaults:PlatformCliDeviceDefaults;bindings:Partial<Record<PlatformCliProvider,PlatformCliBinding|null>>;everywhere:PlatformCliEverywhereStatus|null};
/** One project's account per CLI. Picking an account that is already signed in applies at once. */
export function ProjectCliAccounts({targetId,language}:{targetId:string;language:string}) {
  const ko=language==='ko';
  const [data,setData]=useState<ProjectAccounts|null>(null),[busy,setBusy]=useState<PlatformCliProvider|null>(null),[adding,setAdding]=useState<PlatformCliProvider|null>(null);
  const [notes,setNotes]=useState<Partial<Record<PlatformCliProvider,string>>>({}),[error,setError]=useState(''),[macOpen,setMacOpen]=useState(false);
  const target=useRef(targetId);target.current=targetId;
  async function load(){
    const id=targetId;
    try{const r=await request({operation:'project',targetId:id});if(target.current===id){setData({accounts:r.accounts??[],deviceDefaults:r.deviceDefaults??{},bindings:r.bindings??{},everywhere:r.everywhere??null});setError('');}}
    catch(e){if(target.current===id)setError(failure(e,ko));}
  }
  useEffect(()=>{setData(null);setNotes({});setAdding(null);void load();},[targetId]);
  async function choose(provider:PlatformCliProvider,accountId:string,accounts=data?.accounts??[]) {
    if(busy)return;const id=targetId,previous=data?.bindings[provider];setBusy(provider);setNotes(n=>({...n,[provider]:''}));
    try{
      await request({operation:'bind',targetId:id,provider,binding:{accountId,scope:previous?.scope??'',resourceId:previous?.resourceId??''},requestId:crypto.randomUUID()});
      await load();
      const a=accounts.find(x=>x.id===accountId);
      if(target.current===id)setNotes(n=>({...n,[provider]:accountId===PLATFORM_CLI_DEFAULT_ACCOUNT?(ko?'✓ 이 프로젝트는 이 Mac 계정을 따릅니다.':'✓ This project follows this Mac’s account.'):(ko?`✓ 이 프로젝트는 이제 ${a?accountName(a):'선택한 계정'}을(를) 씁니다.`:`✓ This project now uses ${a?accountName(a):'the selected account'}.`)}));
    }catch(e){if(target.current===id)setNotes(n=>({...n,[provider]:failure(e,ko)}));}
    finally{setBusy(null);}
  }
  return <section className="mb-6 rounded-lg border border-[var(--line)] p-3" data-testid="project-cli-accounts" aria-label={ko?'이 프로젝트의 CLI 계정':'CLI accounts for this project'}>
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <h3 className="text-sm font-semibold">{ko?'CLI 계정 · 이 프로젝트':'CLI accounts · this project'}</h3>
      <span className="text-xs text-[var(--ink-3)]" data-testid="project-cli-scope">{data?.everywhere&&['off','unsupported'].includes(data.everywhere.state)?(ko?'고르면 바로 적용 · 아젠투지 워크룸에서':'Applies at once · in AgentsToZ Workrooms'):(ko?'고르면 바로 적용 · 이 폴더의 터미널·VS Code·git 어디서든':'Applies at once · every terminal, VS Code and git in this folder')}</span>
    </div>
    {error&&<p role="status" className="mt-2 text-xs">{error} <button type="button" className={small} onClick={()=>void load()}>{ko?'다시 읽기':'Reload'}</button></p>}
    {!data&&!error&&<p className="mt-2 text-xs text-[var(--ink-3)]">{ko?'계정을 확인하는 중…':'Reading accounts…'}</p>}
    {data&&<div className="mt-2 space-y-2">{PLATFORM_CLI_PROVIDERS.map(provider=>{
      const bound=data.bindings[provider]?.accountId??PLATFORM_CLI_DEFAULT_ACCOUNT;
      const options=platformCliAccountOptions(data.accounts,provider,bound);
      const value=options.some(o=>o.id===bound)?bound:'';
      return <div key={provider} className="space-y-1" data-testid={`project-cli-row-${provider}`}>
        <div className="grid gap-1 sm:grid-cols-[140px_1fr] sm:items-center">
          <span className="text-xs font-semibold">{PLATFORM_CLI_LABELS[provider]}</span>
          <select aria-label={ko?`${PLATFORM_CLI_LABELS[provider]} 프로젝트 계정`:`${PLATFORM_CLI_LABELS[provider]} project account`} className={control} disabled={busy!==null} value={value}
            onChange={e=>{const v=e.target.value;if(v===ADD)setAdding(provider);else if(v)void choose(provider,v);}}>
            {!value&&<option value="">{ko?'선택한 계정을 찾지 못함 · 다시 고르세요':'Selected account missing · choose again'}</option>}
            {options.map(a=><option key={a.id} value={a.id}>{a.source==='default'?`${ko?'이 Mac 계정 따르기':'Follow this Mac'} · ${macAccountName(provider,data.accounts,data.deviceDefaults,ko)}${a.state==='login-required'?(ko?' · 로그인 필요':' · sign-in required'):''}`:accountName(a)}</option>)}
            <option value={ADD}>{addLabel(ko)}</option>
          </select>
        </div>
        {busy===provider&&<p role="status" className="text-xs">{ko?'적용하는 중…':'Applying…'}</p>}
        {notes[provider]&&<p role="status" className="break-words text-xs">{notes[provider]}</p>}
        {adding===provider&&<QuickCliLogin provider={provider} ko={ko} assist={/^[A-Za-z0-9_-]{8,128}$/.test(targetId)?{scope:{kind:'project',projectId:targetId},origin:'quick-cli-login-project'}:undefined} onClose={()=>setAdding(null)} onAdded={account=>{setAdding(null);void choose(provider,account.id,[...data.accounts,account]);}}/>}
      </div>;
    })}</div>}
    <details className="mt-3 text-xs" onToggle={e=>setMacOpen(e.currentTarget.open)}>
      <summary className="min-h-[36px] cursor-pointer py-2">{ko?'이 Mac 전체 계정 바꾸기':'Switch this whole Mac’s accounts'}</summary>
      {macOpen&&<MacCliAccountSwitcher language={language} compact/>}
    </details>
  </section>;
}

export type NewProjectCliChoice=Partial<Record<PlatformCliProvider,string>>;
export const NEW_PROJECT_CLI_PROVIDERS=['github','supabase','vercel'] as const satisfies readonly PlatformCliProvider[];
/** The accounts a new project will use, chosen before it exists. Following this Mac is the default. */
export function NewProjectCliAccounts({language,value,onChange}:{language:string;value:NewProjectCliChoice;onChange:(next:NewProjectCliChoice)=>void}) {
  const ko=language==='ko';
  const [accounts,setAccounts]=useState<PlatformCliAccount[]|null>(null),[defaults,setDefaults]=useState<PlatformCliDeviceDefaults>({}),[adding,setAdding]=useState<PlatformCliProvider|null>(null),[error,setError]=useState('');
  const latest=useRef(value);latest.current=value;
  async function load(){try{const r=await request({operation:'list'});setAccounts(r.accounts??[]);setDefaults(r.deviceDefaults??{});setError('');}catch(e){setError(failure(e,ko));}}
  useEffect(()=>{void load();},[]);
  const chosen=(provider:PlatformCliProvider)=>value[provider]&&value[provider]!==PLATFORM_CLI_DEFAULT_ACCOUNT?accounts?.find(a=>a.id===value[provider]):undefined;
  const summary=NEW_PROJECT_CLI_PROVIDERS.map(p=>{const a=chosen(p);return `${PLATFORM_CLI_LABELS[p]} ${a?accountName(a):(ko?'이 Mac 계정':'this Mac')}`;}).join(' · ');
  return <details className="rounded-lg border border-[var(--line)] p-3 text-xs" data-testid="new-project-cli-accounts">
    <summary className="cursor-pointer leading-5"><span className="font-semibold">{ko?'계정':'Accounts'}</span> <span className="text-[var(--ink-3)]">{summary}</span></summary>
    <p className="mt-2 leading-5 text-[var(--ink-3)]">{ko?'이 프로젝트에서 쓸 GitHub·Supabase·Vercel 계정입니다. 고르지 않으면 이 Mac 계정을 따릅니다. 만든 뒤에도 프로젝트 화면에서 바로 바꿀 수 있습니다.':'GitHub, Supabase and Vercel accounts for this project. Unchosen ones follow this Mac. Change them any time on the project screen.'}</p>
    {error&&<p role="status" className="mt-2">{error} <button type="button" className={small} onClick={()=>void load()}>{ko?'다시 읽기':'Reload'}</button></p>}
    {accounts&&<div className="mt-2 space-y-2">{NEW_PROJECT_CLI_PROVIDERS.map(provider=>{
      const selected=value[provider]??PLATFORM_CLI_DEFAULT_ACCOUNT,options=platformCliAccountOptions(accounts,provider,selected);
      return <div key={provider} className="space-y-1">
        <label className="grid gap-1 sm:grid-cols-[110px_1fr] sm:items-center"><span className="font-semibold">{PLATFORM_CLI_LABELS[provider]}</span>
          <select aria-label={ko?`새 프로젝트 ${PLATFORM_CLI_LABELS[provider]} 계정`:`New project ${PLATFORM_CLI_LABELS[provider]} account`} className={control} value={options.some(o=>o.id===selected)?selected:PLATFORM_CLI_DEFAULT_ACCOUNT}
            onChange={e=>{const v=e.target.value;if(v===ADD)setAdding(provider);else onChange({...latest.current,[provider]:v});}}>
            {options.map(a=><option key={a.id} value={a.id}>{a.source==='default'?`${ko?'이 Mac 계정':'This Mac'} · ${macAccountName(provider,accounts,defaults,ko)}`:accountName(a)}</option>)}
            <option value={ADD}>{addLabel(ko)}</option>
          </select>
        </label>
        {adding===provider&&<QuickCliLogin provider={provider} ko={ko} assist={{scope:{kind:'new-project'},origin:'quick-cli-login-new-project'}} onClose={()=>setAdding(null)} onAdded={account=>{setAdding(null);onChange({...latest.current,[provider]:account.id});void load();}}/>}
      </div>;
    })}</div>}
  </details>;
}
/** Applies a new project's choices once it is registered. Returns what could not be applied, in words. */
export async function applyNewProjectCliAccounts(targetId:string,choice:NewProjectCliChoice,ko=true):Promise<string[]> {
  const failed:string[]=[];
  for(const [provider,accountId] of Object.entries(choice) as [PlatformCliProvider,string][]){
    if(!accountId||accountId===PLATFORM_CLI_DEFAULT_ACCOUNT)continue;
    try{await request({operation:'bind',targetId,provider,binding:{accountId,scope:'',resourceId:''},requestId:crypto.randomUUID()});}
    catch(e){failed.push(`${PLATFORM_CLI_LABELS[provider]}: ${failure(e,ko)}`);}
  }
  return failed;
}
