import {useEffect,useRef,useState} from 'react';
import {terminalLocalRequest} from './aiTerminalClient';
import {PLATFORM_CLI_PATH,type PlatformCliAccount,type PlatformCliProvider} from './platformCliProtocol';
import type {PlatformCliSetupStatus} from './platformCliSetup';
import {PlatformCliSettings} from './PlatformCliSettings';
import {OnboardingCloudPanel} from './OnboardingCloudPanel';
import {HELPDESK_PATH} from './helpdeskKnowledge';

const services=[
  {id:'github',name:'GitHub',required:true,description:'프로젝트 소스와 변경 이력을 보관합니다.'},
  {id:'supabase',name:'Supabase',required:true,description:'아젠투지 데이터와 장기기억 백업을 저장할 본인 클라우드 계정입니다.'},
  {id:'vercel',name:'Vercel',required:false,description:'웹사이트를 배포할 때 선택합니다.'},
  {id:'google-workspace',name:'Google Workspace',required:false,description:'Google 서비스 작업용 CLI 계정입니다. 모바일 Google 로그인 설정은 모바일 연결에서 별도로 안내합니다.'},
] as const;
const button='helpdesk-button';

/** Account inventory is evidence of verified signup/login, never proof of a connected app database. */
export function ServiceAccountOnboarding({onContinue,onOpenSync,onInstall,onCloudConnected,initialProvider='github'}:{onContinue:()=>void;onOpenSync:()=>void;onInstall:()=>void;onCloudConnected?:()=>void;initialProvider?:PlatformCliProvider}){
  const [provider,setProvider]=useState<PlatformCliProvider>(initialProvider);
  const [setup,setSetup]=useState<PlatformCliSetupStatus[]>([]),[accounts,setAccounts]=useState<PlatformCliAccount[]>([]);
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const generation=useRef(0);
  const [cloudReady,setCloudReady]=useState(false);
  const ready=(id:string,rows=setup,known=accounts)=>rows.some(row=>row.provider===id&&row.installed===true)&&known.some(a=>a.provider===id&&a.source!=='default'&&a.state==='ready'&&!!a.verifiedEmail);
  async function check(continueAfter=false){
    const epoch=++generation.current;setBusy(true);setError('');
    try{
      const [inventory,logins]=await Promise.all([terminalLocalRequest(PLATFORM_CLI_PATH,{operation:'setup-status'}),terminalLocalRequest(PLATFORM_CLI_PATH,{operation:'list'})]);
      if(epoch!==generation.current)return;
      const rows:PlatformCliSetupStatus[]=inventory.setup??[],known:PlatformCliAccount[]=logins.accounts??[];
      setSetup(rows);setAccounts(known);
      if(continueAfter&&cloudReady&&services.filter(s=>s.required).every(s=>ready(s.id,rows,known))){const status=await terminalLocalRequest(HELPDESK_PATH,{operation:'cloud-status'});if(epoch===generation.current&&status.setup.connected===true)onContinue();else if(epoch===generation.current){setCloudReady(false);setError('저장소 연결 상태가 바뀌었습니다. 같은 준비 결과를 다시 확인하세요.');}}
    }catch{
      if(epoch===generation.current){setSetup([]);setAccounts([]);setError('가입·인증 결과를 확인하지 못했습니다. 기존 계정을 유지한 채 다시 확인하세요.');}
    }finally{if(epoch===generation.current)setBusy(false);}
  }
  useEffect(()=>{void check();return()=>{generation.current++;};},[]);
  const complete=cloudReady&&services.filter(s=>s.required).every(s=>ready(s.id));
  return <section className="helpdesk-task" aria-label="필수 서비스 계정 준비">
    <div className="helpdesk-bubble"><strong>GitHub·Supabase는 필수, Vercel은 선택이에요.</strong><p>계정이 없으면 회원가입부터, 이미 있으면 CLI 설치와 본인 계정 인증을 이어서 진행하세요. 가입 페이지를 열거나 프로그램만 설치한 상태는 인증 완료로 표시하지 않습니다.</p></div>
    <div className="helpdesk-service-list">{services.map(s=><button type="button" className={button} key={s.id} aria-pressed={provider===s.id} onClick={()=>setProvider(s.id)}><strong>{s.name} · {s.required?'필수':'선택'}</strong><span>{s.description}</span><span>{busy?'확인 중…':ready(s.id)?'CLI 설치·계정 인증 확인됨':setup.some(row=>row.provider===s.id&&row.installed===true)?'계정 가입·인증 확인 필요':'CLI 설치·계정 인증 필요'}</span></button>)}</div>
    <button type="button" className={button} onClick={onInstall}>CLI 설치 화면으로 돌아가기</button>
    <PlatformCliSettings key={provider} expanded newcomer onVerified={()=>void check()} language="ko" projects={[]} initialProvider={provider} purpose={provider==='supabase'?'app-sync-account':'project-cli'} onOpenSync={onOpenSync}/>
    {ready('supabase')&&<OnboardingCloudPanel accounts={accounts} onOpenExisting={onOpenSync} onReady={()=>{setCloudReady(true);onCloudConnected?.();}}/>}
    {error&&<p role="alert">{error}</p>}
    <div className="helpdesk-actions"><button type="button" className={button} disabled={busy} onClick={()=>void check()}>가입·설치·인증 다시 확인</button><button type="button" className={button+' helpdesk-primary'} disabled={busy||!complete} onClick={()=>void check(true)}>다음 · AI 연결</button></div>
    <p role="status">{complete?'필수 계정 인증을 확인했습니다. Supabase 저장소 연결 상태는 별도로 확인하세요.':'GitHub·Supabase 인증과 클라우드 저장소 준비가 모두 확인되면 다음 단계로 이동할 수 있습니다.'}</p>
  </section>;
}
