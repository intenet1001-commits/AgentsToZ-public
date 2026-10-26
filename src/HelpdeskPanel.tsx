import React,{useEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {LifeBuoy,Send,X} from 'lucide-react';
import {MacSetupPanel,type MacSetupTransport} from './MacSetupPanel';
import {MAC_SETUP_DEFAULT_SELECTION} from './macSetupCatalog';
import {ServiceAccountOnboarding} from './ServiceAccountOnboarding';
import {HelpdeskMobileSetup} from './HelpdeskMobileSetup';
import {PlatformCliSettings} from './PlatformCliSettings';
import type {PlatformCliProvider} from './platformCliProtocol';
import OnboardingCodexLoginPanel from './OnboardingCodexLoginPanel';
import {terminalLocalRequest} from './aiTerminalClient';
import {HELPDESK_PATH,HELPDESK_GUIDES,type HelpdeskAction,type HelpdeskProvider} from './helpdeskKnowledge';
import type {HelpdeskView} from './helpdeskHost';
import './HelpdeskPanel.css';
const button='helpdesk-button';
export type HelpdeskTransport=(request:Record<string,unknown>)=>Promise<HelpdeskView>;
const native:HelpdeskTransport=body=>terminalLocalRequest(HELPDESK_PATH,body);
const labels={unknown:'연결 확인 필요',missing:'프로그램 설치 필요','signed-out':'계정 연결 필요',ready:'연결 확인됨',unsupported:'프로그램 업데이트 필요'};
type Guide=(typeof HELPDESK_GUIDES)[number];
type LocalTurn={question:string;answer:string;createdAt:number};
export function HelpdeskPanel({onClose,onAction,transport=native,standalone=false,setupTransport,codexLoginTransport,onCloudConnected}:{onClose:()=>void;onAction:(action:HelpdeskAction)=>void;transport?:HelpdeskTransport;standalone?:boolean;onCloudConnected?:()=>void;setupTransport?:MacSetupTransport;codexLoginTransport?:(body:Record<string,unknown>)=>Promise<{status:number;body:any}>}){
  const [stage,setStage]=useState<'install'|'services'|'auth'|'mobile'|'gws'|'chat'>('chat'),[provider,setProvider]=useState<HelpdeskProvider>('codex');
  const [gwsPreparation,setGwsPreparation]=useState(0);
  const [serviceProvider,setServiceProvider]=useState<PlatformCliProvider>('github');
  const [view,setView]=useState<HelpdeskView|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[question,setQuestion]=useState('');
  const [guideSelection,setGuideSelection]=useState<{item:Guide;createdAt:number}|null>(null),[showGuides,setShowGuides]=useState(false),[localTurns,setLocalTurns]=useState<LocalTurn[]>([]);
  const dialog=useRef<HTMLDialogElement>(null),log=useRef<HTMLDivElement>(null),input=useRef<HTMLTextAreaElement>(null);
  const lock=useRef(false),alive=useRef(true),request=useRef<Record<string,unknown>|null>(null),sequence=useRef(0),follow=useRef(false);
  async function read(body:Record<string,unknown>){const ticket=++sequence.current,result=await transport(body);if(alive.current&&ticket===sequence.current)setView(result);return result;}
  async function act(body:Record<string,unknown>){
    if(lock.current)return;lock.current=true;setBusy(true);setError('');
    try{const result=await read(body),pending=request.current;if(pending&&result.jobs.some(j=>j.id===pending.requestId))setQuestion(current=>current.trim()===pending.question?'':current);request.current=null;return result;}
    catch(e){setError(e instanceof Error?e.message:'결과를 확인하지 못했습니다. 같은 요청 결과를 확인하세요. 자동으로 다시 보내지 않습니다.' );}
    finally{lock.current=false;if(alive.current)setBusy(false);}
  }
  useEffect(()=>{alive.current=true;if(!standalone&&!dialog.current?.open)dialog.current?.showModal();void read({operation:'status'}).then(v=>{if(alive.current&&v.connections.codex!=='ready'&&v.connections.claude==='ready')setProvider('claude');}).catch(()=>{if(alive.current)setError('지원 상태를 읽지 못했습니다. 기본 안내는 계속 볼 수 있습니다.');});return()=>{alive.current=false;sequence.current++;};},[transport]);
  const running=view?.jobs.find(j=>j.state==='running'),ready=view?.connections[provider]==='ready';
  useEffect(()=>{if(!running)return;const timer=setInterval(()=>{if(!document.hidden)void read({operation:'status'}).catch(()=>{});},2000);return()=>clearInterval(timer);},[running?.id,transport]);
  useEffect(()=>{if(stage==='chat')input.current?.focus();},[stage]);
  useEffect(()=>{if(follow.current&&log.current)log.current.scrollTop=log.current.scrollHeight;},[view?.revision,localTurns.length,guideSelection,showGuides,stage]);
  function chooseGuide(g:Guide){follow.current=true;setGuideSelection({item:g,createdAt:Date.now()});}
  async function send(){
    if(!question.trim()||running||lock.current)return;
    follow.current=true;
    if(!ready){
      setLocalTurns(turns=>[...turns.slice(-7),{question:question.trim(),createdAt:Date.now(),answer:'AI 답변을 받으려면 Codex 또는 Claude를 연결해 주세요. 지금은 앱에 포함된 기본 안내로 도와드릴게요.'}]);
      setQuestion('');setShowGuides(true);return;
    }
    if(!view)return;
    // A lost acknowledgement is resolved by status, never by allocating a new request ID.
    if(request.current){await act({operation:'status'});return;}
    const body={operation:'ask',provider,question:question.trim(),requestId:crypto.randomUUID(),expectedRevision:view.revision};request.current=body;
    await act(body);
  }
  function guideAction(g:Guide){if(g.id==='start')setStage('install');else if(g.id==='phone')setStage('mobile');else if(g.id==='gws')setStage('gws');else onAction(g.action);}
  const timeline:{id:string;at:number;node:React.ReactNode}[]=[];
  const guide=guideSelection?.item;
  if(guide&&guideSelection)timeline.push({id:'guide',at:guideSelection.createdAt,node:<article className="helpdesk-message helpdesk-message--assistant" aria-label="기본 안내"><span className="helpdesk-speaker">헬프데스크 · 기본 안내</span><div className="helpdesk-bubble"><h3>{guide.title}</h3><p>{guide.text}</p>{guide.id==='error'?<div className="helpdesk-intents"><button type="button" onClick={()=>setStage('install')}>설치가 멈췄어요</button><button type="button" onClick={()=>setStage('auth')}>로그인이 안 돼요</button><button type="button" onClick={()=>onAction('report')}>오류 신고·개선 요청</button></div>:<button type="button" className={button+' helpdesk-primary'} onClick={()=>guideAction(guide)}>{guide.id==='start'?'프로그램 준비 시작':guide.label}</button>}</div></article>});
  localTurns.forEach((turn,i)=>timeline.push({id:'local-'+i,at:turn.createdAt,node:<React.Fragment><article className="helpdesk-message helpdesk-message--user"><span className="helpdesk-speaker">나</span><p className="helpdesk-bubble">{turn.question}</p></article><article className="helpdesk-message helpdesk-message--assistant"><span className="helpdesk-speaker">헬프데스크 · 기본 안내</span><div className="helpdesk-bubble"><p>{turn.answer}</p><button type="button" className={button} onClick={()=>setStage('auth')}>AI 연결하기</button></div></article></React.Fragment>}));
  view?.jobs.forEach(j=>timeline.push({id:j.id,at:j.createdAt,node:<React.Fragment>{j.question&&<article className="helpdesk-message helpdesk-message--user"><span className="helpdesk-speaker">나</span><p className="helpdesk-bubble">{j.question}</p></article>}<article className="helpdesk-message helpdesk-message--assistant" data-request-id={j.id}><span className="helpdesk-speaker">헬프데스크 · {j.provider==='codex'?'Codex':'Claude'}{j.kind==='login'?' · 공식 인증':''}</span><div className="helpdesk-bubble">{j.state==='running'?<p role="status">{j.kind==='login'?'공식 로그인 화면에서 마무리해 주세요.':'답변을 준비하고 있어요…'}</p>:<p>{j.answer||j.message}</p>}</div></article></React.Fragment>}));
  timeline.sort((a,b)=>a.at-b.at);
  const body=<>
    <header className="helpdesk-header"><span className="helpdesk-avatar" aria-hidden="true"><LifeBuoy size={24}/></span><div><h2 id="agentstoz-helpdesk-title">아젠투지 헬프데스크</h2><p>설치와 사용을 한 단계씩 도와드려요</p></div><button type="button" className="helpdesk-close" onClick={onClose} aria-label="헬프데스크 닫기"><X size={18}/></button></header>
    <nav aria-label="헬프데스크 준비 단계" className="helpdesk-steps">{([['install','프로그램'],['services','서비스 계정'],['auth','AI 연결'],['mobile','모바일 연결'],['chat','도움받기']] as const).map(([id,label],i)=><button type="button" key={id} aria-current={stage===id||(stage==='gws'&&id==='services')?'step':undefined} onClick={()=>setStage(id)}><span aria-hidden="true">{i+1}</span>{label}</button>)}</nav>
    {stage==='install'&&<div className="helpdesk-task"><div className="helpdesk-bubble"><strong>먼저, 필요한 프로그램을 준비할게요.</strong><p>아래 버튼을 한 번 누르면 빠진 프로그램만 차례로 준비해요. Mac의 승인 창이 나오면 직접 확인해 주세요.</p><p>폴더 등록은 서비스 계정 없이 시작할 수 있어요. 클라우드 백업·기기 동기화를 준비할 때는 아래 프로그램과 필수 계정 연결을 이어가 주세요.</p><button type="button" className={button} onClick={()=>onAction('projects')}>로컬 프로젝트부터 시작</button></div><MacSetupPanel compact transport={setupTransport} initialSelected={MAC_SETUP_DEFAULT_SELECTION} primaryLabel="필요한 프로그램 한 번에 준비"/><button type="button" className={button+' helpdesk-primary'} onClick={()=>setStage('services')}>다음 · 필수 서비스 계정 연결</button></div>}
    {stage==='services'&&<ServiceAccountOnboarding initialProvider={serviceProvider} onCloudConnected={onCloudConnected} onInstall={()=>setStage('install')} onOpenSync={()=>onAction('setup')} onContinue={()=>setStage('auth')}/>}
    {stage==='mobile'&&<HelpdeskMobileSetup onAction={onAction} onAccounts={p=>{if(p==='google-workspace')setStage('gws');else{setServiceProvider(p);setStage('services');}}}/>}
    {stage==='gws'&&<section className="helpdesk-task" aria-label="Google Workspace 연결 준비"><div className="helpdesk-bubble"><h3>Google Workspace 연결</h3><p>준비된 프로그램·클라이언트·계정을 그대로 사용해요. 아직 준비하지 않았다면 아래에서 필요한 단계부터 이어가 주세요.</p><button type="button" className={button} onClick={()=>setStage('mobile')}>모바일 준비로 돌아가기</button></div><MacSetupPanel transport={setupTransport} focusedTool="google-workspace" primaryLabel="Google 프로그램 준비 · 이어하기" onPrepared={()=>setGwsPreparation(v=>v+1)}/><PlatformCliSettings preparationRevision={gwsPreparation} expanded newcomer initialProvider="google-workspace" language="ko" projects={[]} purpose="project-cli" onOpenSync={()=>onAction('setup')}/></section>}
    {stage==='auth'&&<section aria-label="사용할 AI 인증" className="helpdesk-task"><div className="helpdesk-bubble"><strong>사용할 AI 하나만 연결하면 돼요.</strong><p>이미 쓰는 Codex나 Claude 계정을 선택해 주세요. 비밀번호·인증 코드는 공식 로그인 화면에서만 입력해 주세요.</p></div><div className="helpdesk-provider-choices">{(['codex','claude'] as const).map(p=><button key={p} type="button" className={button} aria-pressed={provider===p} onClick={()=>setProvider(p)}>{p==='codex'?'Codex':'Claude'} · {labels[view?.connections[p]??'unknown']}</button>)}</div>
      {provider==='codex'?<OnboardingCodexLoginPanel continueLabel="헬프데스크에서 질문하기" transport={codexLoginTransport} onContinue={()=>void act({operation:'check'}).then(v=>{if(v?.connections.codex==='ready')setStage('chat');})}/>:<div className="helpdesk-bubble"><p>Claude Code의 공식 로그인 화면을 열어요. 이미 연결했다면 아래에서 연결을 다시 확인해 주세요.</p><button type="button" className={button} disabled={busy||!!running||view?.connections.claude!=='signed-out'} onClick={()=>{if(!view)return;const b={operation:'login',provider:'claude',requestId:crypto.randomUUID(),expectedRevision:view.revision};request.current=b;void act(b);}}>Claude 공식 로그인 시작</button></div>}
      <div className="helpdesk-actions"><button type="button" className={button} disabled={busy||!!running} onClick={()=>void act({operation:'check'})}>인증·연결 다시 확인</button><button type="button" className={button+' helpdesk-primary'} onClick={()=>setStage('chat')}>질문으로 돌아가기</button></div>
      {provider==='claude'&&view?.jobs.at(-1)?.kind==='login'&&<p role="status">{running?'공식 로그인 화면에서 마무리해 주세요.':view.jobs.at(-1)?.answer||view.jobs.at(-1)?.message}</p>}
    </section>}
    {stage==='chat'&&<>
      <div ref={log} role="log" aria-label="헬프데스크 대화" aria-live="polite" className="helpdesk-log" onScroll={()=>{const n=log.current;if(n)follow.current=n.scrollHeight-n.scrollTop-n.clientHeight<80;}}>
        <article className="helpdesk-message helpdesk-message--assistant"><span className="helpdesk-speaker">헬프데스크 · 기본 안내</span><div className="helpdesk-bubble"><p className="helpdesk-greeting">안녕하세요! 아젠투지를 처음 쓰시나요?</p><p>어려운 용어를 몰라도 괜찮아요. 아래에서 고르거나, 궁금한 점을 편하게 적어 주세요.</p><div className="helpdesk-intents"><button type="button" onClick={()=>setStage('install')}>처음 설치해요</button><button type="button" onClick={()=>{setShowGuides(true);chooseGuide(HELPDESK_GUIDES[1]);}}>사용법이 궁금해요</button><button type="button" onClick={()=>setStage('mobile')}>iPhone 로그인·연결 도와주세요</button><button type="button" onClick={()=>{setShowGuides(true);chooseGuide(HELPDESK_GUIDES[6]);}}>문제가 생겼어요</button></div></div></article>
        {showGuides&&<div className="helpdesk-suggestions" aria-label="자주 묻는 질문">{HELPDESK_GUIDES.map(g=><button type="button" key={g.id} onClick={()=>chooseGuide(g)}>{g.question}</button>)}</div>}
        {timeline.map(item=><React.Fragment key={item.id}>{item.node}</React.Fragment>)}
      </div>
      <form className="helpdesk-composer" onSubmit={e=>{e.preventDefault();void send();}}>
        <div className="helpdesk-input"><label htmlFor="helpdesk-question" className="sr-only">헬프데스크 질문</label><textarea ref={input} id="helpdesk-question" aria-label="헬프데스크 질문" maxLength={2000} value={question} onChange={e=>setQuestion(e.target.value)} placeholder="무엇부터 해야 할지 모르겠어요" onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.nativeEvent.isComposing&&e.nativeEvent.keyCode!==229){e.preventDefault();void send();}}}/><button type="submit" aria-label="보내기" disabled={busy||!!running||!!request.current||!question.trim()}><Send size={18}/><span>보내기</span></button></div>
        <div className="helpdesk-composer-tools"><label>답변 AI <select aria-label="도움을 받을 AI" value={provider} disabled={busy||!!running} onChange={e=>setProvider(e.target.value as HelpdeskProvider)}><option value="codex">Codex</option><option value="claude">Claude</option></select></label><span>{ready?'연결 확인됨':'지금은 기본 안내로 도와드려요'}</span><button type="button" disabled={busy||!!running} onClick={()=>void act({operation:'check'})}>AI 연결 확인</button>{!ready&&<button type="button" onClick={()=>setStage('auth')}>AI 연결하기</button>}</div>
      </form>
      <details className="helpdesk-privacy"><summary>대화 보관과 개인정보 안내</summary><p>AI 질문은 선택한 본인 계정으로 실행됩니다. 질문·최근 지원 대화·프로그램 준비 상태만 전달하며 프로젝트 기억과 인증 비밀은 포함하지 않습니다. 최근 지원 요청 12개를 이 기기에 보관합니다. 기본 안내 대화는 이 창에서만 보이며, 실제 업무와 기억 저장은 프로젝트 워크룸에서 확인하세요.</p></details>
    </>}
    {error&&<p role="alert" className="helpdesk-error">{error}</p>}
    {(error||running)&&<div className="helpdesk-recovery"><button type="button" className={button} disabled={busy} onClick={()=>void act({operation:'status'})}>같은 요청 결과 확인</button>{running&&<button type="button" className={button} disabled={busy} onClick={()=>void act({operation:'cancel',id:running.id})}>진행 중인 지원 요청 중지</button>}</div>}
  </>;
  if(standalone)return <section className="helpdesk-shell helpdesk-shell--standalone">{body}</section>;
  return createPortal(<dialog ref={dialog} aria-labelledby="agentstoz-helpdesk-title" onCancel={e=>{e.preventDefault();onClose();}} className="helpdesk-shell">{body}</dialog>,document.body);
}
