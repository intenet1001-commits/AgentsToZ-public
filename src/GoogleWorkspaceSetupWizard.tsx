import {useEffect,useRef,useState} from 'react';
import {GOOGLE_WORKSPACE_APIS,googleSetupConsoleUrl} from './googleWorkspaceSetupSteps';
import {GOOGLE_WORKSPACE_COMPUTER_USE_HANDOFF} from './googleWorkspaceOnboardingGuide';
import {writeOnboardingClipboard} from './onboardingClipboard';
import {openPreferredBrowser} from './openPreferredBrowser';

/** A separate guided page; navigation and self-reported progress never mean verified setup. */
export function GoogleWorkspaceSetupWizard({projectId='',onClose}:{projectId?:string;onClose:()=>void}){
  const dialog=useRef<HTMLDialogElement>(null),[step,setStep]=useState(0),[project,setProject]=useState(projectId);
  const [consent,setConsent]=useState(false),[handoff,setHandoff]=useState(false),[copied,setCopied]=useState<boolean|null>(null);
  const [error,setError]=useState('');
  useEffect(()=>{dialog.current?.showModal();},[]);
  const titles=['쓸 Google 프로젝트 고르기','자주 쓰는 API 준비하기','Google 동의 화면 준비하기','데스크톱 앱 JSON 받기','앱으로 돌아와 연결 확인'];
  const link=(path:string,label:string)=>{const url=googleSetupConsoleUrl(path,project);return url?<a className="helpdesk-button" href={url} target="_blank" rel="noreferrer" onClick={e=>{e.preventDefault();void openPreferredBrowser(url).catch(()=>setError('Google 공식 화면을 열지 못했습니다.'));}}>{label}</a>:<span>{label} · 프로젝트 ID를 확인하세요</span>;};
  return <dialog ref={dialog} aria-label="Google 설정 따라하기" onCancel={onClose} style={{width:'min(900px,95vw)',maxHeight:'90vh',overflow:'auto',background:'var(--bg)',color:'var(--text-primary)',border:'1px solid var(--line)',borderRadius:16,padding:24}}>
    <div className="flex items-center justify-between gap-3"><h2>Google 설정 따라하기</h2><button type="button" className="helpdesk-button" onClick={onClose}>앱으로 돌아가기</button></div>
    <p>같은 Google 계정과 프로젝트를 계속 사용하세요. 이미 준비한 것은 그대로 이용합니다.</p>
    <nav aria-label="Google 설정 단계" className="flex flex-wrap gap-2 my-3">{titles.map((title,index)=><button type="button" className="helpdesk-button" aria-current={step===index?'step':undefined} onClick={()=>setStep(index)} key={title}>{index+1}. {title}</button>)}</nav>
    <article aria-label={titles[step]} className="space-y-3"><h3>{step+1} / 5 · {titles[step]}</h3>
      {step===0&&<><p>상단의 프로젝트 이름을 누르세요 → 기존 프로젝트를 고르세요. 없다면 「새 프로젝트」로 만드세요. 결제 계정 연결은 필요할 때 따로 판단합니다.</p>{link('/projectselector2/home/dashboard','Google Console에서 프로젝트 고르기')}<label className="block">프로젝트 ID · 이미 알면 입력, 몰라도 Console에서 선택 가능<input className="block w-full min-h-[44px] border rounded p-2" value={project} onChange={e=>setProject(e.target.value.trim())} placeholder="my-google-project" autoComplete="off"/></label>{project&&!googleSetupConsoleUrl('/auth/clients',project)&&<p role="alert">프로젝트 이름 대신 영문 프로젝트 ID를 확인하세요. 예: my-google-project</p>}<button type="button" className="helpdesk-button" onClick={onClose}>이미 JSON이 있어요 · 바로 첨부하기</button></>}
      {step===1&&<><p>필요한 서비스의 「사용 설정」 화면을 여세요 → 상단 프로젝트 확인 → 「사용 설정」을 누르세요. 이미 「관리」가 보이면 준비된 상태입니다.</p><div className="grid grid-cols-2 gap-2">{GOOGLE_WORKSPACE_APIS.map(([name,id])=><div key={id}>{link('/apis/library/'+id,name+' API 열기')}</div>)}</div><p>이 10개는 자주 쓰는 서비스의 준비 목록입니다. 필요한 것만 켜세요. API 사용 설정과 내 메일·문서 접근 승인은 별도입니다. 현재 앱의 첫 연결 검사는 Drive 읽기 권한으로 진행합니다. 다른 서비스 권한이 필요하면 해당 업무에서 별도로 승인합니다.</p></>}
      {step===2&&<><ol className="list-decimal pl-5 space-y-2"><li>Branding에서 앱 이름과 본인 지원 이메일을 입력하세요.</li><li>Audience에서 본인 조직용 또는 외부 사용자를 고르세요. 개인 Gmail은 외부 사용자입니다.</li><li>Testing이면 연결할 이메일을 Test users에 추가하세요. 실제 사용할 계정마다 필요합니다.</li></ol><div className="flex gap-2">{link('/auth/branding','앱 이름·지원 이메일 입력')}{link('/auth/audience','사용자·테스트 이메일 추가')}</div><p>조직 정책으로 막히면 관리자 확인이 필요합니다. 공개 앱 검증이나 조직 전체 권한을 대신 승인하지 않습니다.</p></>}
      {step===3&&<><ol className="list-decimal pl-5 space-y-2"><li>Clients → 클라이언트 만들기를 누르세요.</li><li>유형은 「데스크톱 앱」, 이름은 알아보기 쉬운 이름을 입력하세요.</li><li>만들기 → JSON 다운로드 → Mac에 저장하세요. JSON 내용을 열거나 AI 채팅에 붙이지 마세요.</li></ol>{link('/auth/clients','데스크톱 앱 클라이언트 만들기')}<p>모바일 Google 로그인용 「웹 애플리케이션」은 다음 모바일 준비 화면에서 따로 연결합니다. 같은 Cloud 프로젝트를 사용해도 클라이언트 유형은 다릅니다.</p></>}
      {step===4&&<><ol className="list-decimal pl-5 space-y-2"><li>「앱으로 돌아가기」를 누르고 내려받은 JSON을 첨부 영역에 끌어 놓으세요.</li><li>사용할 이메일 입력 → 「브라우저로 계정 연결」 → 본인이 Google 승인을 완료하세요.</li><li>「연결 확인」의 실제 결과를 확인하세요. 파일 첨부와 이 가이드의 다음 버튼만으로 연결 완료가 되지는 않습니다.</li></ol><button type="button" className="helpdesk-button helpdesk-primary" onClick={onClose}>앱으로 돌아가 JSON 첨부</button></>}
    </article>
    <div className="helpdesk-actions mt-4"><button type="button" className="helpdesk-button" disabled={step===0} onClick={()=>setStep(s=>s-1)}>이전</button><button type="button" className="helpdesk-button" disabled={step===4} onClick={()=>setStep(s=>s+1)}>다음 단계 보기</button></div>
    {error&&<p role="alert">{error}</p>}
    <section className="mt-6 border rounded p-3 space-y-2" aria-label="Codex 컴퓨터 사용으로 도움받기"><h3>여전히 어렵다면 · Codex에게 화면 조작 도움받기</h3><p>설치된 컴퓨터 사용 도구로 Console 화면을 함께 진행합니다. 화면 내용은 AI에 보일 수 있습니다. 비밀번호·2단계 인증·최종 권한 승인·JSON 다운로드는 직접 처리하고 파일은 이 앱에만 첨부하세요.</p><label className="block min-h-[44px]"><input type="checkbox" checked={consent} onChange={e=>setConsent(e.target.checked)}/> 이 범위를 확인했고 Codex에 보낼 안내를 준비합니다.</label><button type="button" className="helpdesk-button" disabled={!consent} onClick={()=>{setHandoff(true);void writeOnboardingClipboard(GOOGLE_WORKSPACE_COMPUTER_USE_HANDOFF).then(setCopied);}}>동의하고 Codex 컴퓨터 사용 안내 복사</button>{handoff&&<><p role="status">{copied===null?'안내 준비 중':copied?'복사했습니다. 컴퓨터 사용이 가능한 Codex 대화에 붙여넣으세요.':'복사를 못 했습니다. 아래 안내를 직접 복사하세요.'} 안내 준비만으로 AI나 설정 변경이 시작되지는 않습니다.</p><textarea className="w-full min-h-40" aria-label="Codex Google 설정 안내" readOnly value={GOOGLE_WORKSPACE_COMPUTER_USE_HANDOFF}/></>}</section>
  </dialog>;
}
