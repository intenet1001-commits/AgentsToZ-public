import {useEffect,useRef,useState} from 'react';
import {invoke} from '@tauri-apps/api/core';
import {MAC_SETUP_TOOLS,macSetupHandoff,type MacSetupView,type MacSetupToolId,type MacSetupState} from './macSetupCatalog';
import {writeOnboardingClipboard} from './onboardingClipboard';
const button='min-h-11 rounded-xl border border-[var(--line)] px-4 py-2 text-sm disabled:opacity-50';
const labels:Record<MacSetupState,string>={unknown:'미확인',missing:'설치 필요',installed:'실행 확인됨',running:'앱 실행 확인됨',checking:'확인 중',installing:'설치 중','needs-action':'사용자 확인 필요',failed:'확인 실패',cancelled:'중지됨'};
export type MacSetupTransport=(body:Record<string,unknown>)=>Promise<{status:number;body:any}>;
const native:MacSetupTransport=body=>invoke('onboarding_management_request',{tool:'mac-setup',body});
/** Works before any AI exists. The host, rather than this view, owns the durable queue. */
export function MacSetupPanel({transport=native,initialSelected,primaryLabel,compact=false}:{transport?:MacSetupTransport;initialSelected?:MacSetupToolId[];primaryLabel?:string;compact?:boolean}){
  const [view,setView]=useState<MacSetupView|null>(null),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
  const [selected,setSelected]=useState<MacSetupToolId[]>(()=>initialSelected??MAC_SETUP_TOOLS.map(t=>t.id));
  const [handoff,setHandoff]=useState('');const lock=useRef(false),alive=useRef(true);
  const read=async(body:Record<string,unknown>)=>{const r=await transport(body);if(r.status!==200||r.body.success!==true)throw Error(r.body.error??'준비 상태를 읽지 못했습니다. 같은 요청 결과를 다시 확인하세요.');if(alive.current)setView(r.body.view);return r.body.view as MacSetupView;};
  useEffect(()=>{alive.current=true;void read({operation:'status'}).catch(e=>{if(alive.current)setMessage(e.message);});return()=>{alive.current=false;};},[transport]);
  useEffect(()=>{
    if(!view?.active)return;let timer:ReturnType<typeof setTimeout>,current=true;
    const poll=async()=>{if(!current)return;if(!document.hidden)await read({operation:'status'}).catch(()=>{if(current)setMessage('결과를 읽지 못했습니다. 같은 요청 결과를 다시 확인하세요. 새 설치를 시작하지 않았습니다.');});if(current)timer=setTimeout(poll,2000);};
    timer=setTimeout(poll,1000);return()=>{current=false;clearTimeout(timer);};
  },[view?.active,transport]);
  async function act(operation:'inspect'|'start'|'cancel'|'launch'|'focus',ids?:MacSetupToolId[]){
    if(lock.current||!view)return;lock.current=true;setBusy(true);setMessage('');
    try{await read({operation,expectedRevision:view.revision,...(operation==='cancel'?{}:{requestId:crypto.randomUUID()}),...(ids?{selected:ids}:{})});return true;}
    catch(e){setMessage(e instanceof Error?e.message:'결과 확인이 필요합니다. 다시 시작 전에 같은 요청 결과를 읽어 주세요.');await read({operation:'status'}).catch(()=>{});return false;}
    finally{lock.current=false;if(alive.current)setBusy(false);}
  }
  const settled=selected.length>0&&view?.rows.filter(r=>selected.includes(r.id)).every(r=>r.id.endsWith('-app')?r.state==='running':r.state==='installed');
  return <section aria-label="Mac 준비" data-testid="mac-setup-panel" className="space-y-4 rounded-2xl border border-[var(--accent-line)] bg-[var(--accent-soft)] p-5">
    <h3 className="text-base font-bold">{compact?'이 Mac의 프로그램 준비':'1. 이 Mac의 프로그램 준비'}</h3>
    {!compact&&<p className="text-sm leading-6">AI 앱이 없어도 여기서 시작할 수 있습니다. 필요한 항목을 선택하면 누락된 것만 차례로 설치하고 실제 실행을 확인합니다. 이미 설치된 프로그램과 계정은 보존합니다.</p>}
    {!compact&&<p className="text-xs leading-5">선택한 CLI에 필요한 Node.js·npm 또는 Git도 함께 확인합니다. macOS 설치·첫 실행 승인창은 직접 확인해 주세요. Node.js는 공식 설치 화면에서 npm과 함께 준비하며, Git은 Apple 개발자 도구로 준비합니다. 설치 중 창을 닫아도 같은 기록으로 이어갑니다.</p>}
    {compact&&<p className="text-sm">기본 선택: Git · Codex · Claude Code · GitHub CLI. 필요한 Node.js·npm도 함께 확인합니다. 선택은 아래에서 바꿀 수 있습니다.</p>}
    <div className="flex flex-wrap gap-2">
      <button className={button+' bg-[var(--accent)] text-[var(--on-accent)]'} disabled={!view||busy||view.active||!selected.length} onClick={()=>void act('start',selected)}>{primaryLabel??'선택한 프로그램 준비 · 이어하기'}</button>
      <button className={button} disabled={!view||busy||view.active} onClick={()=>void act('inspect')}>설치·실행 다시 검사</button>
      {view?.active&&<button className={button} disabled={busy} onClick={()=>void act('cancel')}>중지 요청</button>}
      <button className={button} disabled={busy} onClick={()=>void read({operation:'status'}).catch(e=>setMessage(e.message))}>같은 요청 결과 보기</button>
    </div>
    <details open={compact?undefined:true}><summary className="cursor-pointer text-sm">준비할 프로그램 선택·상세 상태</summary>
    {[...new Set(MAC_SETUP_TOOLS.map(t=>t.group))].map(group=><fieldset key={group} disabled={busy||view?.active} className="rounded-xl border border-[var(--line)] p-3"><legend className="px-2 text-xs font-semibold">{group}</legend><div className="space-y-2">{MAC_SETUP_TOOLS.filter(t=>t.group===group).map(t=>{const r=view?.rows.find(r=>r.id===t.id);return <label key={t.id} className="flex items-start gap-3 text-sm"><input type="checkbox" className="mt-1" checked={selected.includes(t.id)} onChange={e=>setSelected(s=>e.target.checked?[...s,t.id]:s.filter(id=>id!==t.id))}/><span className="min-w-0 flex-1"><strong>{t.label}</strong><span className="ml-2 text-xs">{t.id.endsWith('-app')&&r?.state==='installed'?'설치됨 · 실행 확인 필요':labels[r?.state??'unknown']}</span><span className="block break-words text-xs leading-5 text-[var(--ink-2)]">{r?.message??'아직 확인하지 않았습니다.'}</span>{(r?.state==='failed'||r?.state==='needs-action')&&<a href={t.url} target="_blank" rel="noreferrer" className="inline-block py-2 text-xs underline">공식 안내</a>}</span></label>;})}</div></fieldset>)}</details>
    <p role="status" className="text-sm leading-6">{view?.active?'진행 중입니다. OS 확인창을 기다리는 동안에도 같은 요청 결과를 확인할 수 있습니다.':settled?'프로그램 실행을 확인했습니다. 다음은 사용할 서비스의 계정 인증입니다.':'설치와 로그인은 별도입니다. 확인이 끝난 항목부터 사용할 수 있습니다.'} {message}</p>
    {view&&(['codex-app','claude-app'] as const).filter(id=>view.rows.some(r=>r.id===id&&r.state==='running')).map(id=><button key={id} className={button} disabled={busy} onClick={()=>{const prompt=macSetupHandoff(view);setHandoff(prompt);void writeOnboardingClipboard(prompt).then(async copied=>{if(await act('focus',[id]))setMessage(copied?'이어갈 안내를 복사했습니다. 열린 AI 앱에 붙여넣으세요.':'아래 안내를 직접 복사해 열린 AI 앱에 붙여넣으세요.');});}}>{id==='codex-app'?'Codex':'Claude'} 앱에서 이어가기 · 안내 복사</button>)}
    {handoff&&<textarea aria-label="Mac 준비 AI 인계문" readOnly value={handoff} onFocus={e=>e.currentTarget.select()} className="min-h-32 w-full rounded-xl border border-[var(--line)] bg-[var(--bg-input)] p-3 text-xs"/>}
    {!compact&&<p className="text-xs leading-5">2. 아래 ‘프로젝트 작업용 서비스 계정’에서 사용할 이메일을 하나씩 연결하세요. 비밀번호·2FA·키체인 승인은 공식 화면에서 직접 처리하며, JSON·토큰·키는 AI 채팅으로 보내지 않습니다.</p>}
  </section>;
}
