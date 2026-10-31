import {useCallback,useEffect,useLayoutEffect,useRef,useState} from 'react';
import {restoreDialogFocus} from './dialogFocus';
import {isDialogDismissKey} from './dialogEscape';
import {requestDesktopEffort,type DesktopEffortRequester} from './desktopEffortClient';
import type {DesktopEffortStatus,DesktopEffortManagementRequest} from './desktopEffortProtocol';
const button='min-h-11 rounded-xl border border-[var(--line)] px-3 py-2 text-sm disabled:opacity-50';
const field='min-h-11 rounded-lg border border-[var(--line)] bg-[var(--bg-input)] px-2 text-base';
export function DesktopEffortPanel({onClose,returnFocusTo,request=requestDesktopEffort}:{onClose:()=>void;returnFocusTo?:HTMLElement|null;request?:DesktopEffortRequester}){
  const dialog=useRef<HTMLDivElement>(null),epoch=useRef(0),pending=useRef(false);
  const [state,setState]=useState<DesktopEffortStatus|null>(null),[problem,setProblem]=useState(''),[busy,setBusy]=useState(false);
  const [choices,setChoices]=useState<Record<string,{mode:'auto'|'recommend'|'off';consent:boolean;allowLowering:boolean;fixed:string;minimum:string}>>({});
  useEffect(()=>{dialog.current?.focus();return()=>restoreDialogFocus(returnFocusTo??null);},[returnFocusTo]);
  const refresh=useCallback(async()=>{if(pending.current)return;pending.current=true;const revision=epoch.current;try{const value=await request({operation:'status'});if(revision===epoch.current){setState(value);setProblem('');}}catch(e){if(revision===epoch.current)setProblem(e instanceof Error?e.message:'외부 앱 연결을 확인하지 못했습니다.');}finally{if(revision===epoch.current)pending.current=false;}},[request]);
  useEffect(()=>{epoch.current++;void refresh();return()=>{epoch.current++;pending.current=false;};},[refresh]);
  useLayoutEffect(()=>{if(state&&document.hasFocus()&&dialog.current&&!dialog.current.contains(document.activeElement))dialog.current.focus({preventScroll:true});},[state]);
  const apply=async(body:DesktopEffortManagementRequest)=>{if(pending.current||busy)return;const generation=epoch.current;setBusy(true);pending.current=true;setProblem('');try{await request(body);if(generation===epoch.current)setChoices({});}catch(e){if(generation===epoch.current)setProblem(e instanceof Error?e.message:'변경 결과를 확인하세요. 자동으로 다시 적용하지 않습니다.');}finally{if(generation===epoch.current){pending.current=false;setBusy(false);void refresh();}}};
  return <div className="fixed inset-0 z-[220] flex items-center justify-center bg-[var(--scrim)] p-3" onMouseDown={e=>{if(e.target===e.currentTarget)onClose();}}>
    <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby="desktop-effort-title" data-testid="desktop-effort-panel" tabIndex={-1} className="max-h-[90dvh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-5 text-[var(--ink)]" onKeyDown={e=>{
      if(isDialogDismissKey(e.nativeEvent)){e.preventDefault();e.stopPropagation();onClose();}
      if(e.key==='Tab'){const nodes=Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex="0"]')??[]).filter(n=>n.getClientRects().length);const first=nodes[0],last=nodes.at(-1);if(e.shiftKey&&(document.activeElement===first||document.activeElement===dialog.current)){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}}
    }}>
      <header className="flex items-start justify-between gap-3"><div><h2 id="desktop-effort-title" className="text-xl font-semibold">외부 앱 에포트</h2><p className="mt-2 text-sm text-[var(--text-muted)]">확인된 앱 세션에만 자동 조절을 허용합니다. 모델·공급자·계정과 다른 대화의 설정을 유지합니다.</p></div><button type="button" className={button+' shrink-0'} onClick={onClose}>닫기</button></header>
      {problem&&<p role="alert" className="mt-3 text-sm">{problem}</p>}
      <div className="mt-4 space-y-2" aria-label="앱별 지원 상태">{state?.adapters.map(a=><div key={a.id} className="rounded-xl border border-[var(--line)] p-3 text-sm"><strong>{a.label} · {a.available?'세션 연결됨':'자동 변경 연결 필요'}</strong><p className="mt-1 text-[var(--text-muted)]">{a.available?'아래에서 연결된 세션을 확인하고 별도로 동의하세요.':a.reason}</p></div>)}</div>
      {state&&!state.sessions.length&&<p className="mt-4 text-sm" role="status">자동 변경을 지원하는 네이티브 세션이 연결되어 있지 않습니다. 추천 표시와 내부 워크룸의 에포트 설정은 기존 방식으로 사용할 수 있습니다.</p>}
      <div className="mt-4 space-y-3">{state?.sessions.map(s=>{const c=choices[s.id]??{mode:s.mode,consent:false,allowLowering:false,fixed:s.fixed??'',minimum:s.minimum??''};const change=(p:Partial<typeof c>)=>setChoices(old=>({...old,[s.id]:{...c,...p}}));return <section key={s.id} aria-label={s.label} className="rounded-xl border border-[var(--line)] p-3">
        <h3 className="font-semibold">{s.label}</h3><p className="mt-1 break-all text-sm">{s.binding.model} · {s.binding.provider} · {s.binding.accountId}</p>
        <p className="mt-1 text-sm" role="status">현재 {s.mode==='auto'?'자동 조절':s.mode==='off'?'꺼짐':'추천만'}{s.expiresAt?` · ${new Date(s.expiresAt).toLocaleTimeString()}까지`:''}</p>
        {(s.fixed||s.minimum||s.preserved)&&<p className="mt-1 text-sm">{s.fixed?`고정 ${s.fixed}`:s.preserved?`현재 ${s.preserved} 유지`:''}{s.minimum?` · 최소 ${s.minimum}`:''}</p>}
        <div className="mt-3 grid gap-3 sm:grid-cols-3"><label className="grid gap-1 text-sm">모드<select aria-label="모드" className={field} value={c.mode} onChange={e=>change({mode:e.target.value as typeof c.mode,consent:false})}><option value="recommend">추천만</option><option value="auto">이 세션 자동 조절</option><option value="off">꺼짐</option></select></label>
          <label className="grid gap-1 text-sm">고정 강도<select aria-label="고정 강도" className={field} value={c.fixed} onChange={e=>change({fixed:e.target.value})}><option value="">고정하지 않음</option>{['low','medium','high','xhigh','max','ultra'].map(v=><option key={v}>{v}</option>)}</select></label>
          <label className="grid gap-1 text-sm">최소 강도<select aria-label="최소 강도" className={field} value={c.minimum} onChange={e=>change({minimum:e.target.value})}><option value="">지정하지 않음</option>{['low','medium','high','xhigh','max','ultra'].map(v=><option key={v}>{v}</option>)}</select></label></div>
        {c.mode==='auto'&&<><label className="mt-2 flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={c.consent} onChange={e=>change({consent:e.target.checked})}/>이 세션에서 최대 10분 동안 자동 변경을 허용합니다.</label><label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={c.allowLowering} onChange={e=>change({allowLowering:e.target.checked})}/>현재 Max·xhigh 등의 강도를 낮추는 것도 허용합니다.</label></>}
        <div className="mt-2 flex flex-wrap gap-2"><button type="button" className={button} disabled={busy||c.mode==='auto'&&!c.consent} onClick={()=>void apply({operation:'configure',id:s.id,expectedRevision:s.revision,mode:c.mode,...(c.consent?{consent:true}:{}),allowLowering:c.allowLowering,...(c.fixed?{fixed:c.fixed}:{}),...(c.minimum?{minimum:c.minimum}:{})})}>이 세션에 적용</button><button type="button" className={button} disabled={busy} onClick={()=>void apply({operation:'disconnect',id:s.id})}>연결 해제</button></div>
      </section>;})}</div>
      <p className="mt-4 text-sm text-[var(--text-muted)]">입력·선택창 사용 중에는 변경하지 않습니다. 앱 재시작·세션 변경·확인되지 않은 결과가 생기면 자동 변경을 멈춥니다. 이 설정은 데스크톱 앱의 공통 추천/끄기 설정과 별개입니다.</p>
      <button type="button" className={button+' mt-4'} disabled={busy} onClick={()=>void refresh()}>연결 상태 다시 확인</button>
    </div>
  </div>;
}
