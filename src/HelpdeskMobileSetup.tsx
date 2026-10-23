import {useEffect,useRef,useState} from 'react';
import {terminalLocalRequest} from './aiTerminalClient';
import {HELPDESK_MOBILE_GUIDES,HELPDESK_PATH,type HelpdeskAction} from './helpdeskKnowledge';
import {PLATFORM_CLI_PATH,type PlatformCliAccount} from './platformCliProtocol';
import {HelpdeskGoogleLoginSetup} from './HelpdeskGoogleLoginSetup';

/** Provider registration and phone login retain separate, observable evidence. */
export function HelpdeskMobileSetup({onAction,onAccounts}:{onAction:(action:HelpdeskAction)=>void;onAccounts:(provider:'supabase'|'google-workspace')=>void}){
  const [method,setMethod]=useState<'email'|'google'>('email');
  const [configured,setConfigured]=useState<boolean|null>(null),[accounts,setAccounts]=useState<PlatformCliAccount[]|null>(null),[busy,setBusy]=useState(false);
  const generation=useRef(0),lock=useRef(false);
  async function check(){
    if(lock.current)return;lock.current=true;setBusy(true);
    const ticket=++generation.current;
    try{
      const [cloud,cli]=await Promise.allSettled([
        terminalLocalRequest(HELPDESK_PATH,{operation:'cloud-status'}),
        terminalLocalRequest(PLATFORM_CLI_PATH,{operation:'list'}),
      ]);
      if(ticket!==generation.current)return;
      setConfigured(cloud.status==='fulfilled'&&typeof cloud.value.setup?.configured==='boolean'?cloud.value.setup.configured:null);
      setAccounts(cli.status==='fulfilled'&&Array.isArray(cli.value.accounts)?cli.value.accounts:null);
    }finally{lock.current=false;if(ticket===generation.current)setBusy(false);}
  }
  useEffect(()=>{void check();return()=>{generation.current++;};},[]);
  const count=(provider:string)=>accounts?.filter(a=>a.provider===provider&&a.state==='ready'&&!!a.verifiedEmail).length??0;
  const guide=HELPDESK_MOBILE_GUIDES[method];
  const guidance=<section className="helpdesk-bubble" aria-label={guide.title}><h4>{guide.title}</h4><p>{guide.description}</p><ol className="helpdesk-checklist">{guide.steps.map(step=><li key={step}>{step}</li>)}</ol><div className="helpdesk-actions">{guide.links.map(link=><a key={link.url} className="helpdesk-button" href={link.url} target="_blank" rel="noreferrer">{link.label}</a>)}</div></section>;
  return <section className="helpdesk-task" aria-label="모바일 로그인·연결 준비">
    <div className="helpdesk-bubble"><h3>로그인 준비부터 iPhone 연결까지</h3><p>이 Mac의 준비 상태를 보고, 사용할 로그인 방식을 선택하세요. Supabase·Google 공식 화면에서 설정한 뒤 iPhone의 실제 결과까지 확인합니다.</p></div>
    <section className="helpdesk-bubble" aria-label="현재 Mac의 모바일 준비 상태">
      <h4>현재 Mac에서 확인한 설정</h4>
      <ul className="helpdesk-checklist" aria-live="polite">
        <li>앱 데이터 저장소: {busy?'확인 중…':configured===true?'연결 설정 있음 · 모바일 로그인은 별도 확인':configured===false?'설정 필요':'상태 확인 못함'}</li>
        <li>Supabase CLI: {busy?'확인 중…':accounts===null?'상태 확인 못함':count('supabase')?`계정 인증 확인 · ${count('supabase')}개`:'계정 인증 확인 필요'}</li>
        <li>Google Workspace CLI · 선택: {busy?'확인 중…':accounts===null?'상태 확인 못함':count('google-workspace')?`계정 인증 확인 · ${count('google-workspace')}개`:'연결이 필요할 때 준비'}</li>
      </ul>
      <p>Google Provider·메일 발송·이 iPhone 로그인은 아직 확인이 필요합니다. 위 계정 인증이나 저장소 설정만으로 완료로 표시하지 않습니다.</p>
      <div className="helpdesk-actions"><button type="button" className="helpdesk-button" disabled={busy} onClick={()=>void check()}>Mac 준비 상태 다시 확인</button><button type="button" className="helpdesk-button" onClick={()=>onAccounts('supabase')}>Supabase CLI 연결 돕기</button><button type="button" className="helpdesk-button" onClick={()=>onAccounts('google-workspace')}>Google Workspace CLI 연결 돕기</button><button type="button" className="helpdesk-button" onClick={()=>onAction('setup')}>저장소·허용 이메일 설정</button></div>
    </section>
    <div className="helpdesk-provider-choices" role="group" aria-label="모바일 로그인 방식">{(['email','google'] as const).map(id=><button type="button" key={id} className="helpdesk-button" aria-pressed={method===id} onClick={()=>setMethod(id)}>{HELPDESK_MOBILE_GUIDES[id].title}</button>)}</div>
    {method==='google'&&accounts!==null&&<HelpdeskGoogleLoginSetup accounts={accounts}/>}
    {method==='google'?<details><summary className="min-h-11 cursor-pointer">Google 설정을 직접 할 때 · 자세히 보기</summary>{guidance}</details>:guidance}
    <section className="helpdesk-bubble" aria-label="iPhone 실제 연결 확인"><h4>마지막은 iPhone에서 확인하세요</h4><ol className="helpdesk-checklist"><li>선택한 방식으로 로그인하고 프로젝트·기록을 실제로 조회합니다. 로그인 성공 뒤에도 회원 접근이 거절되면 같은 Supabase의 DB 허용 회원을 확인합니다.</li><li>Mac의 iPhone 연결 QR을 스캔하고 같은 기기인지 확인·승인합니다. 데이터 로그인과 Mac 제어 권한은 각각 확인합니다.</li><li>허용한 프로젝트가 열리고 다시 연결해도 같은 작업을 이어가는지 확인합니다.</li></ol><button type="button" className="helpdesk-button helpdesk-primary" onClick={()=>onAction('phone')}>iPhone 연결 QR 열기</button></section>
  </section>;
}
