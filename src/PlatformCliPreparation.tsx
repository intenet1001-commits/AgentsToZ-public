import {useEffect,useState} from 'react';
import {terminalLocalRequest} from './aiTerminalClient';
import {PLATFORM_CLI_LABELS,PLATFORM_CLI_PATH,type PlatformCliProvider,type PlatformCliAccountPurpose} from './platformCliProtocol';
import type {PlatformCliSetupStatus} from './platformCliSetup';
import {buildPlatformCliSetupHandoff,PLATFORM_CLI_INSTALL_URLS} from './platformCliSetupGuide';
import {writeOnboardingClipboard} from './onboardingClipboard';
export function PlatformCliPreparation({provider,ko,reload,onInstalled,onOpenSync,purpose='project-cli',compact=false}:{provider:PlatformCliProvider;ko:boolean;reload:number;onInstalled:(installed:boolean|null)=>void;onOpenSync?:()=>void;purpose?:PlatformCliAccountPurpose;compact?:boolean}){
  const [rows,setRows]=useState<PlatformCliSetupStatus[]>([]),[busy,setBusy]=useState(true),[error,setError]=useState(''),[revision,setRevision]=useState(0),[handoff,setHandoff]=useState(''),[copied,setCopied]=useState(false);
  useEffect(()=>{
    let current=true;setBusy(true);onInstalled(null);setHandoff('');setError('');
    void terminalLocalRequest(PLATFORM_CLI_PATH,{operation:'setup-status'}).then(r=>{if(current){setRows(r.setup);onInstalled(r.setup.find((v:PlatformCliSetupStatus)=>v.provider===provider)?.installed??null);}}).catch(()=>{if(current){setRows([]);setError(ko?'설치 여부를 확인하지 못했습니다. 다시 확인하세요.':'Could not check installation. Retry.');}}).finally(()=>{if(current)setBusy(false);});
    return()=>{current=false;};
  },[provider,reload,revision,ko,onInstalled]);
  const appSync=purpose==='app-sync-account';
  const selected=rows.find(v=>v.provider===provider)??null;
  const button='min-h-[44px] rounded-lg border border-[var(--line)] px-3 py-2 text-xs disabled:opacity-50';
  return <section aria-label={ko?'CLI 설치·계정 연결':'CLI installation and accounts'} className="my-3 space-y-3 rounded-lg border border-[var(--line)] p-3">
    <h4 className="font-semibold">{compact?PLATFORM_CLI_LABELS[provider]+' 프로그램 확인':ko?'처음이라면 이 순서로 시작하세요':'Start here on a new device'}</h4>
    <p className="text-xs leading-5">{compact?'프로그램 설치가 확인되면 아래 공식 화면에서 계정을 인증하세요.':appSync?(ko?'① Supabase CLI 준비 → ② 관리 로그인 연결 → ③ 위에서 사용할 계정 선택. 프로젝트 작업용 CLI 기본 계정과 별도로 선택합니다.':'1. Prepare Supabase CLI. 2. Connect a management login. 3. Select it above, independently of project CLI defaults.') : ko?'① 필요한 CLI만 설치 → ② 기존 로그인 또는 새 계정 연결 → ③ 기본 계정 선택. CLI 없이도 앱을 로컬로 사용할 수 있습니다.':'1. Install only the CLI you need. 2. Connect an existing or new account. 3. Choose a default. Local app use works without these CLIs.'}</p>
    <ul className="space-y-1 text-xs" aria-live="polite">{rows.filter(row=>compact?row.provider===provider:!appSync||row.provider==='supabase').map(row=><li key={row.provider}>{PLATFORM_CLI_LABELS[row.provider]} · {row.installed===true?(ko?'설치됨':'Installed'):row.installed===false?(ko?'설치 필요':'Install needed'):(ko?'확인 필요':'Unknown')} · {ko?'연결 계정':'Connected accounts'} {row.connected}</li>)}</ul>
    <p className="text-xs">{busy?(ko?'설치 상태 확인 중…':'Checking installation…'):error||selected?.installed===false?(error||(ko?'선택한 CLI가 없습니다. 공식 안내 또는 AI 도움으로 설치한 뒤 다시 확인하세요.':'Install the selected CLI using its official guide or AI help, then recheck.')):selected?.installed===true?(ko?'설치 확인됨. 아래에서 이메일을 입력하고 기존 로그인 또는 브라우저 연결을 선택하세요.':'Installed. Enter an email below and choose an existing login or browser connection.'):(ko?'상태 확인이 필요합니다.':'Check the installation status.')}</p>
    <div className="flex flex-wrap gap-2"><button type="button" className={button} disabled={busy} onClick={()=>setRevision(v=>v+1)}>{ko?'설치 상태 다시 확인':'Recheck installation'}</button>{!compact&&<><a className={button} href={PLATFORM_CLI_INSTALL_URLS[provider]} target="_blank" rel="noreferrer">{ko?'공식 설치 안내':'Official installation guide'}</a><button type="button" className={button} disabled={busy} onClick={()=>{const prompt=buildPlatformCliSetupHandoff(provider,selected,navigator.platform,purpose);setHandoff(prompt);setCopied(false);void writeOnboardingClipboard(prompt).then(setCopied);}}>{ko?'AI에게 설치·연결 도움받기':'Get AI help with setup'}</button></>}</div>
    {handoff&&<div><p className="text-xs" role="status">{copied?(ko?'현재 상태가 담긴 안내를 복사했습니다. 로컬 작업이 가능한 AI에 붙여넣으세요.':'Copied. Paste into an AI with local tools.'):(ko?'아래 안내를 선택해 AI에 붙여넣으세요.':'Copy this guide into your AI.')}</p><textarea aria-label={ko?'CLI 설정 AI 인계문':'CLI setup handoff'} readOnly value={handoff} onFocus={e=>e.currentTarget.select()} className="mt-2 min-h-32 w-full rounded-lg border border-[var(--line)] bg-[var(--bg-input)] p-2 text-xs"/></div>}

  </section>;
}
