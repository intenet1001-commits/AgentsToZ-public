import React,{useEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {MacSetupPanel,type MacSetupTransport} from './MacSetupPanel';
import OnboardingCodexLoginPanel from './OnboardingCodexLoginPanel';
import {terminalLocalRequest} from './aiTerminalClient';
import {HELPDESK_PATH,HELPDESK_GUIDES,type HelpdeskAction,type HelpdeskProvider} from './helpdeskKnowledge';
import type {HelpdeskView} from './helpdeskHost';
const button='min-h-11 rounded-xl border border-[var(--line)] px-3 py-2 text-sm disabled:opacity-50';
export type HelpdeskTransport=(request:Record<string,unknown>)=>Promise<HelpdeskView>;
const native:HelpdeskTransport=body=>terminalLocalRequest(HELPDESK_PATH,body);
const labels={unknown:'연결 확인 필요',missing:'프로그램 설치 필요','signed-out':'계정 인증 필요',ready:'인증 확인됨',unsupported:'지원 버전 확인 필요'};
export function HelpdeskPanel({onClose,onAction,transport=native,standalone=false,setupTransport,codexLoginTransport}:{onClose:()=>void;onAction:(action:HelpdeskAction)=>void;transport?:HelpdeskTransport;standalone?:boolean;setupTransport?:MacSetupTransport;codexLoginTransport?:(body:Record<string,unknown>)=>Promise<{status:number;body:any}>}){
  const [stage,setStage]=useState<'install'|'auth'|'chat'>('install'),[provider,setProvider]=useState<HelpdeskProvider>('codex');
  const [view,setView]=useState<HelpdeskView|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[question,setQuestion]=useState('');
  const [guide,setGuide]=useState<(typeof HELPDESK_GUIDES)[number]|null>(HELPDESK_GUIDES[0]);
  const dialog=useRef<HTMLDialogElement>(null),lock=useRef(false),alive=useRef(true),request=useRef<Record<string,unknown>|null>(null),sequence=useRef(0);
  async function read(body:Record<string,unknown>){const ticket=++sequence.current,result=await transport(body);if(alive.current&&ticket===sequence.current)setView(result);return result;}
  async function act(body:Record<string,unknown>){
    if(lock.current)return;lock.current=true;setBusy(true);setError('');
    try{const result=await read(body),pending=request.current;if(pending&&result.jobs.some(j=>j.id===pending.requestId))setQuestion(current=>current.trim()===pending.question?'':current);request.current=null;return result;}
    catch(e){setError(e instanceof Error?e.message:'결과를 확인하지 못했습니다. 아래에서 같은 요청 결과를 확인하세요. 자동으로 다시 보내지 않습니다.');}
    finally{lock.current=false;if(alive.current)setBusy(false);}
  }
  useEffect(()=>{alive.current=true;if(!standalone)dialog.current?.showModal();void read({operation:'status'}).then(v=>{if(alive.current&&v.jobs.length)setStage('chat');}).catch(()=>{if(alive.current)setError('지원 상태를 읽지 못했습니다. 기본 안내는 계속 볼 수 있습니다.');});return()=>{alive.current=false;sequence.current++;};},[transport]);
  const running=view?.jobs.find(j=>j.state==='running');
  useEffect(()=>{if(!running)return;const timer=setInterval(()=>{if(!document.hidden)void read({operation:'status'}).catch(()=>{});},2000);return()=>clearInterval(timer);},[running?.id,transport]);
  async function send(){
    if(!view||running||!question.trim()||lock.current)return;
    // A lost acknowledgement is resolved by status, never by allocating a new request ID.
    if(request.current){await act({operation:'status'});return;}
    const body={operation:'ask',provider,question:question.trim(),requestId:crypto.randomUUID(),expectedRevision:view.revision};request.current=body;
    await act(body);
  }
  const body=<>
    <div className="flex items-start justify-between gap-3"><div><h2 id="agentstoz-helpdesk-title" className="text-xl font-bold">아젠투지 헬프데스크</h2><p className="mt-1 text-sm text-[var(--ink-2)]">설치부터 첫 업무까지, 여기서 이어가세요.</p></div><button type="button" className={button} onClick={onClose} aria-label="헬프데스크 닫기">닫기</button></div>
    <nav aria-label="헬프데스크 준비 단계" className="my-4 flex flex-wrap gap-2">{([['install','1. 한 번에 설치'],['auth','2. AI 인증'],['chat','3. 질문·설정 마무리']] as const).map(([id,label])=><button type="button" key={id} className={`${button} ${stage===id?'bg-[var(--accent-soft)]':''}`} aria-current={stage===id?'step':undefined} onClick={()=>setStage(id)}>{label}</button>)}</nav>
    {stage==='install'&&<><p className="mb-3 text-sm">Git·Codex·Claude Code·GitHub CLI를 기본 선택했습니다. 필요한 Node.js·npm도 함께 준비합니다. 사용하지 않을 항목은 해제할 수 있으며, macOS 승인창은 직접 확인하세요. 설치가 중단되면 같은 기록에서 이어갑니다.</p><MacSetupPanel transport={setupTransport} initialSelected={['git','codex','claude','github']} primaryLabel="필요한 프로그램 한 번에 준비"/><button type="button" className={`${button} mt-3`} onClick={()=>setStage('auth')}>준비 결과를 확인하고 AI 인증으로</button></>}
    {stage==='auth'&&<section aria-label="사용할 AI 인증" className="space-y-3"><p className="text-sm">Codex 또는 Claude 중 사용할 AI 하나를 인증하면 됩니다. 본인의 공식 계정을 사용하며 비밀번호·2FA는 공식 화면에서 직접 처리하세요.</p><div className="flex flex-wrap gap-2">{(['codex','claude'] as const).map(p=><button key={p} type="button" className={button} aria-pressed={provider===p} onClick={()=>setProvider(p)}>{p==='codex'?'Codex':'Claude'} · {labels[view?.connections[p]??'unknown']}</button>)}</div>
      {provider==='codex'?<OnboardingCodexLoginPanel transport={codexLoginTransport} onContinue={()=>void act({operation:'check'}).then(v=>{if(v?.connections.codex==='ready')setStage('chat');})}/>:<div className="rounded-xl border border-[var(--line)] p-3"><p className="text-sm">게시된 Claude Code의 공식 로그인으로 연결합니다. 구독·Console·지원하는 제공자 인증은 Claude의 원래 선택을 따릅니다.</p><button type="button" className={`${button} mt-3`} disabled={busy||!!running||view?.connections.claude!=='signed-out'} onClick={()=>{if(!view)return;const b={operation:'login',provider:'claude',requestId:crypto.randomUUID(),expectedRevision:view.revision};request.current=b;void act(b);}}>Claude 공식 로그인 시작</button></div>}
      <button type="button" className={button} disabled={busy||!!running} onClick={()=>void act({operation:'check'})}>인증·연결 다시 확인</button><button type="button" className={button} onClick={()=>setStage('chat')}>헬프데스크로 계속</button>
      {provider==='claude'&&view?.jobs.at(-1)?.kind==='login'&&<p role="status" className="text-sm">{running?'공식 인증 화면의 결과를 기다립니다. 비밀번호·2FA는 그 화면에서 직접 처리하세요.':view.jobs.at(-1)?.answer||view.jobs.at(-1)?.message}</p>}
    </section>}
    {stage==='chat'&&<>
      <p className="text-sm text-[var(--ink-2)]">기본 안내는 AI 설치 전에도 볼 수 있습니다. AI 질문은 선택한 본인 계정으로 실행됩니다. 질문과 최근 지원 대화·프로그램 준비 상태만 전달하며, 프로젝트 기억과 인증 비밀은 포함하지 않습니다.</p>
      <div className="my-3 flex flex-wrap gap-2">{HELPDESK_GUIDES.map(g=><button type="button" key={g.id} className={button} onClick={()=>setGuide(g)}>{g.question}</button>)}</div>
      {guide&&<article className="my-3 rounded-xl border border-[var(--line)] bg-[var(--sunken)] p-4" aria-label="기본 안내"><h3 className="font-semibold">{guide.title}</h3><p className="mt-2 whitespace-pre-wrap text-sm leading-6">{guide.text}</p><p className="mt-2 text-xs text-[var(--ink-3)]">앱 내장 안내 · 현재 앱에 포함된 설명서</p><button type="button" className={`${button} mt-3`} onClick={()=>onAction(guide.action)}>{guide.label}</button></article>}
      <div role="log" aria-label="헬프데스크 대화" className="max-h-80 space-y-3 overflow-y-auto">{view?.jobs.map(j=><article key={j.id} className="rounded-xl border border-[var(--line)] p-3"><p className="text-xs text-[var(--ink-3)]">{j.provider==='codex'?'Codex':'Claude'} · {j.kind==='login'?'공식 인증':'지원 질문'} · {j.state==='running'?'응답 확인 중…':j.state==='answered'?'응답 확인됨':'결과 확인 필요'}</p>{j.question&&<p className="mt-2 whitespace-pre-wrap break-words text-sm font-semibold">{j.question}</p>}<p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6">{j.answer||j.message}</p></article>)}</div>
      <form className="mt-4 space-y-3" onSubmit={e=>{e.preventDefault();void send();}}><label className="block text-sm">도움을 받을 AI<select className="ml-2 min-h-11 rounded border border-[var(--line)] bg-[var(--surface)] px-2" value={provider} disabled={busy||!!running} onChange={e=>setProvider(e.target.value as HelpdeskProvider)}><option value="codex">Codex</option><option value="claude">Claude</option></select><span className="ml-2 text-xs">{labels[view?.connections[provider]??'unknown']}</span></label>
        <label className="block text-sm">무엇을 도와드릴까요?<textarea aria-label="헬프데스크 질문" className="mt-2 min-h-24 w-full rounded-xl border border-[var(--line)] bg-[var(--surface)] p-3 text-base" maxLength={2000} value={question} onChange={e=>setQuestion(e.target.value)} placeholder="예: 프로젝트를 만들었는데 첫 업무는 어디서 시작하나요?"/></label>
        <div className="flex flex-wrap gap-2"><button type="submit" className={button} disabled={busy||!!running||!!request.current||!question.trim()||view?.connections[provider]!=='ready'}>{provider==='codex'?'Codex':'Claude'}에게 질문 보내기</button><button type="button" className={button} disabled={busy||!!running} onClick={()=>void act({operation:'check'})}>AI 연결 확인</button><button type="button" className={button} onClick={()=>setStage('auth')}>설치·인증 이어가기</button></div>
      </form><p className="mt-2 text-xs text-[var(--ink-3)]">최근 지원 요청 12개를 이 기기에 보관합니다. 앱을 다시 열어도 미확정 질문은 자동 재전송하지 않습니다. 실제 업무와 기억 저장은 프로젝트 워크룸에서 확인하세요.</p>
    </>}
    {error&&<p role="alert" className="mt-3 text-sm text-[var(--danger)]">{error}</p>}
    {(error||running)&&<div className="mt-3 flex flex-wrap gap-2"><button type="button" className={button} disabled={busy} onClick={()=>void act({operation:'status'})}>같은 요청 결과 확인</button>{running&&<button type="button" className={button} disabled={busy} onClick={()=>void act({operation:'cancel',id:running.id})}>진행 중인 지원 요청 중지</button>}</div>}
  </>;
  if(standalone)return <section className="mx-auto max-w-3xl bg-[var(--bg-card)] p-5 text-[var(--ink)]">{body}</section>;
  return createPortal(<dialog ref={dialog} aria-labelledby="agentstoz-helpdesk-title" onCancel={onClose} className="m-auto max-h-[calc(100dvh-32px)] w-[min(840px,calc(100vw-24px))] overflow-y-auto rounded-2xl border border-[var(--line)] bg-[var(--bg-card)] p-5 text-[var(--ink)] shadow-[var(--dialog-shadow)] backdrop:bg-[var(--dialog-scrim)]">{body}</dialog>,document.body);
}
