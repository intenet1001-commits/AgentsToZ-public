import {restoreDialogFocus} from './dialogFocus';
import {useCallback,useEffect,useLayoutEffect,useRef,useState} from 'react';
import {computerUseApprovalLabel,requestComputerUse,requestComputerUseNative,type ComputerUseManagementRequester,type ComputerUseNativeRequester} from './computerUseClient';
import {controlAdvertisesScreen,type ComputerTarget} from './computerUseProtocol';
import {isDialogDismissKey} from './dialogEscape';
import {ComputerUseModeSelector,ComputerUseScopeForm,ComputerUseScopeGrants,supportsComputerScopes,type ComputerUseMode,type ComputerUseAppChoice} from './ComputerUseScopeControls';

type WindowChoice=ComputerTarget&{title:string;appName:string};
const button='min-h-11 rounded-xl border border-[var(--line)] px-4 py-2 text-sm disabled:opacity-50';
const field='min-h-11 w-full rounded-xl border border-[var(--line)] bg-[var(--bg-input)] px-3 py-2 text-base';
const message=(error:unknown)=>error instanceof Error&&/[가-힣]/.test(error.message)?error.message:'상태를 확인하지 못했습니다. 잠시 뒤 다시 확인하세요.';
const nativeMessage=(code:unknown)=>(code==='signed-main-required'||code==='signed-main-link-required')?'컴퓨터 유즈를 지원하는 최신 Mac 앱으로 업데이트해 주세요.':code==='signed-helper-required'?'AgentsToZ Control 도우미를 설치한 뒤 열어 주세요.':(code==='installed-main-required'||code==='unsupported-platform')?'이 기능은 macOS 14 이상에서 서명된 Mac 앱으로 사용할 수 있습니다.':'AgentsToZ Control 앱을 열고 연결 준비를 완료하세요.';
const helperReady=(native:any)=>native?.success===true&&native.accessibility===true&&native.secureInput!==true;
/**
 * The helper's connection lines. A Control that answers status but does not list capture and click in `operations` is
 * an older build: it is connected, but the window image and point selection fail until it is updated, so say so.
 */
export function ComputerUseHelperStatus({state,nativeState}:{state:Record<string,any>|null;nativeState:Record<string,any>|null}){
  const nativeStatus=state?.native,ready=state?.restartRequired!==true&&helperReady(nativeStatus);
  const updateRequired=state?.restartRequired!==true&&nativeStatus?.success===true&&!controlAdvertisesScreen(nativeStatus);
  return <>
    <p className="font-semibold">{state?.restartRequired?'연결 다시 시작 필요':ready?'도우미 연결됨':nativeStatus?.secureInput?'보안 입력 중 · 제어 대기':'연결 준비가 필요합니다'}</p>
    <p className="mt-1 text-sm text-[var(--text-muted)]">{state?.restartRequired?'제어 연결이 안전하게 종료됐습니다. 결과가 불명인 작업을 확인하고 진행 중인 작업을 저장한 뒤 AgentsToZ를 다시 실행해 주세요.':ready?(supportsComputerScopes(state)?'AI가 일하는 동안 화면 아래 Control 막대에서 「직접 하기」·「AI에게 넘기기」로 제어권을 주고받습니다. 글자 입력과 버튼 누르기는 마우스를 움직이지 않고 그 앱에 직접 보내므로, 그동안 사람도 Mac을 계속 쓸 수 있습니다.':'사람이 입력하면 AI 동작은 보류됩니다. 지원하는 접근성 요소를 조작합니다.'):nativeStatus?.success===true&&!nativeStatus.accessibility?'「권한 켜기」를 누르면 Control이 손쉬운 사용 목록에 스스로 올라갑니다. 열리는 시스템 설정에서 AgentsToZ Control 스위치만 켜세요.':nativeMessage(nativeStatus?.code??nativeState?.code)}</p>
    <p data-testid="computer-use-supported-actions" className="mt-2 text-sm text-[var(--text-muted)]">{supportsComputerScopes(state)?'전체 Mac 또는 선택한 앱에서 화면 보기·클릭·입력·스크롤·끌기를 할 수 있습니다. 오른쪽·두 번 클릭, 스크롤, 끌기는 실제 마우스 포인터를 쓰므로 사람이 마우스를 쓰는 중이면 멈춥니다. 한 창 모드는 접근성 요소의 누르기와 입력만 지원합니다.':'허용한 창의 접근성 버튼 누르기와 일반 입력란 채우기를 지원합니다. 캔버스의 임의 좌표 클릭·드래그·단축키 입력과 Hermes·Orca 등 AI 앱 제어는 아직 지원하지 않습니다.'}</p>
    {nativeStatus?.success===true&&controlAdvertisesScreen(nativeStatus)&&!supportsComputerScopes(state)&&<p data-testid="computer-use-screen-consent" className="mt-2 text-sm text-[var(--text-muted)]">창 화면 확인과 화면 속 버튼 선택은 Control의 해당 창 승인에서 화면 보기를 따로 허용하고, macOS 설정에서 Control의 화면 기록 권한을 켜야 합니다. 도우미 연결만으로 화면 보기가 허용되지는 않습니다.</p>}
    {updateRequired&&<p data-testid="computer-use-control-update" className="mt-2 text-sm">설치된 AgentsToZ Control이 이전 버전이라 창 화면 확인과 좌표 선택은 아직 쓸 수 없습니다. Control 도우미를 최신 버전으로 업데이트해 주세요. 관찰·누르기·입력은 창별 승인과 손쉬운 사용 권한이 있으면 쓸 수 있습니다.</p>}
  </>;
}
/** Control answers but lacks a macOS permission the selected kind of control needs. */
export function computerUsePermissionsMissing(state:Record<string,any>|null):boolean{
  if(state?.restartRequired===true||state?.native?.success!==true)return false;
  return state.native.accessibility!==true||(supportsComputerScopes(state)&&(state?.scoped?.native?.accessibility!==true||state?.scoped?.native?.screenRecording!==true));
}
/**
 * Waiting requests still open at `now`. Control drops a request at its `expiresAt` (10 min), and so does the next status
 * read; a list kept from an earlier read (a failed or slow refresh) must not keep showing it or its review button.
 */
export function liveComputerUsePending<T extends {expiresAt?:unknown}>(pending:readonly T[],now:number):T[]{
  return pending.filter(p=>typeof p?.expiresAt!=='number'||p.expiresAt>now);
}
/** This panel can request or retire control. Only Control's own native window can approve it. */
export function ComputerUsePanel({onClose,request=requestComputerUse,native=requestComputerUseNative,returnFocusTo}:{onClose:()=>void;request?:ComputerUseManagementRequester;native?:ComputerUseNativeRequester;returnFocusTo?:HTMLElement|null}){
  const [state,setState]=useState<Record<string,any>|null>(null),[windows,setWindows]=useState<WindowChoice[]>([]),[nativeState,setNativeState]=useState<Record<string,any>|null>(null);
  const [connection,setConnection]=useState(''),[windowId,setWindowId]=useState(''),[busy,setBusy]=useState(false),[problem,setProblem]=useState(''),[notice,setNotice]=useState('');
  const [reviewed,setReviewed]=useState<Record<string,boolean>>({}),[reviewProblem,setReviewProblem]=useState(''),[clock,setClock]=useState(()=>Date.now());
  const [mode,setMode]=useState<ComputerUseMode>('desktop'),[applications,setApplications]=useState<ComputerUseAppChoice[]>([]);
  const initialMode=useRef(true),modeRef=useRef<ComputerUseMode>('desktop'),queuedCatalog=useRef<ComputerUseMode|null>(null);
  const dialog=useRef<HTMLDivElement>(null),alive=useRef(true),reading=useRef(false);
  useLayoutEffect(()=>{alive.current=true;const opener=returnFocusTo??(document.activeElement instanceof HTMLElement?document.activeElement:null);dialog.current?.focus();return()=>{alive.current=false;restoreDialogFocus(opener);};},[returnFocusTo]);
  const refresh=useCallback(async function refresh(catalog=false,requestedMode?:ComputerUseMode):Promise<void>{
    const wanted=requestedMode??modeRef.current;
    // Only a deliberate mode change/manual refresh waits behind an in-flight read. Keep the latest one,
    // and never repeat the initial StrictMode effect or build an unbounded catalog queue.
    if(reading.current){if(catalog&&requestedMode!==undefined)queuedCatalog.current=wanted;return;}reading.current=true;
    try{
      let status=await request({operation:'status'});if(!alive.current)return;
      if(status.scoped&&(catalog||status.scoped.native?.code==='scope-status-unchecked')){const scopedStatus=await request({operation:'scope-status'});if(!alive.current)return;if(scopedStatus.success===true&&scopedStatus.scoped)status={...status,scoped:scopedStatus.scoped,...(scopedStatus.access?{access:scopedStatus.access}:{})};}
      setState(status);setProblem('');
      let catalogMode=wanted;
      if(initialMode.current){initialMode.current=false;catalogMode=!supportsComputerScopes(status)?'window':status.access?.enabled===true&&status.access.scope?.kind==='application'?'application':'desktop';modeRef.current=catalogMode;setMode(catalogMode);}
      // Desktop consent needs no target enumeration. Each other mode reads only its own catalog;
      // these are choices for display, never cached evidence of permission at action time.
      if(catalog&&catalogMode==='window'){const result=await native('catalog');if(!alive.current)return;setNativeState(result);setWindows(result.success===true&&Array.isArray(result.windows)?result.windows:[]);}
      if(catalog&&catalogMode==='application'&&supportsComputerScopes(status)){const apps=await native('scope-catalog');if(!alive.current)return;setApplications(apps.success===true&&Array.isArray(apps.applications)?apps.applications:[]);}
    }catch(error){if(alive.current)setProblem(message(error));}finally{
      reading.current=false;const next=queuedCatalog.current;queuedCatalog.current=null;
      if(alive.current&&next!==null)void refresh(true,next);
    }
  },[request,native]);
  useEffect(()=>{void refresh(true);},[refresh]);
  // A removed revoke/review button must not leave keyboard focus on body, outside the modal's Escape handler.
  useLayoutEffect(()=>{if(state!==null&&document.hasFocus()&&dialog.current&&!dialog.current.contains(document.activeElement))dialog.current.focus({preventScroll:true});},[state]);
  const listed=[...(state?.pending??[]),...(state?.scoped?.pending??[])],pending=liveComputerUsePending(listed,clock);
  // Re-read the clock while anything is listed, so an expired request leaves even when no new status arrives.
  useEffect(()=>{if(!listed.length)return;setClock(Date.now());const timer=setInterval(()=>setClock(Date.now()),1000);return()=>clearInterval(timer);},[listed.length>0,state]);
  // While switched on, an AI's request can arrive at any time: keep the waiting list current.
  const hasPending=pending.length>0,watching=hasPending||state?.access?.enabled===true||!!state?.grants?.some((g:any)=>!g.halted)||!!state?.scoped?.grants?.some((g:any)=>!g.halted);
  useEffect(()=>{if(!hasPending)setReviewProblem('');},[hasPending]);
  useEffect(()=>{if(!watching)return;const timer=setInterval(()=>{void refresh();},2000);return()=>clearInterval(timer);},[watching,refresh]);
  const run=async(action:()=>Promise<void>)=>{if(busy)return;setBusy(true);setProblem('');try{await action();}catch(error){if(alive.current)setProblem(message(error));}finally{if(alive.current)setBusy(false);}};
  const selected=windows.find(w=>`${w.pid}/${w.processStart}/${w.windowId}`===windowId);
  const ready=state?.restartRequired!==true&&helperReady(state?.native);
  const permissionsMissing=computerUsePermissionsMissing(state);
  return <div className="fixed inset-0 z-[220] flex items-center justify-center bg-[var(--scrim)] p-3" onMouseDown={event=>{if(event.target===event.currentTarget)onClose();}}>
    <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby="computer-use-title" tabIndex={-1} data-testid="computer-use-panel" className="max-h-[90dvh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-5 text-[var(--ink)] shadow-2xl" onKeyDown={event=>{
      if(isDialogDismissKey(event.nativeEvent)){event.preventDefault();event.stopPropagation();onClose();}
      if(event.key==='Tab'){const elements=Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not([disabled]),select:not([disabled]),input:not([disabled]),[tabindex="0"]')??[]).filter(e=>e.getClientRects().length);const first=elements[0],last=elements.at(-1);if(event.shiftKey&&(document.activeElement===first||document.activeElement===dialog.current)){event.preventDefault();last?.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}}
    }}>
      <header className="sticky -top-5 z-10 -mx-5 -mt-5 bg-[var(--surface)] px-5 pb-3 pt-5">
        <div className="flex items-start justify-between gap-3"><div className="min-w-0 flex-1"><h2 id="computer-use-title" className="text-xl font-semibold">컴퓨터 유즈</h2><p className="mt-1 text-sm text-[var(--text-muted)]">범위를 고르고 켜 두세요. AI가 요청하면 Control에서 직접 승인합니다.</p></div><button type="button" className={button+' shrink-0 whitespace-nowrap'} onClick={onClose}>닫기</button></div>
        {hasPending&&<section className="mt-3 rounded-xl border border-[var(--line)] p-3" aria-label="승인 대기">
          <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-semibold">승인 대기</h3><button type="button" className={button+' shrink-0 whitespace-nowrap'} disabled={busy} onClick={()=>void run(async()=>{setReviewProblem('');try{const result=await native('review');if(result.success!==true||result.opened!==true||result.visibilityConfirmed!==true)setReviewProblem(result.code==='review-visibility-unconfirmed'||(result.success===true&&result.opened===true&&result.visibilityConfirmed!==true)?'승인 검토 창이 현재 화면에 보이는지 확인하지 못했습니다. 승인 요청은 대기 중입니다. 메뉴 막대의 AgentsToZ Control에서 검토를 다시 열어 주세요.':'승인 검토 창을 확인하지 못했습니다. 승인 요청은 대기 중입니다. 메뉴 막대의 AgentsToZ Control에서 검토를 열어 주세요.');}catch{setReviewProblem('승인 검토 창을 확인하지 못했습니다. 승인 요청은 대기 중입니다. 메뉴 막대의 AgentsToZ Control에서 검토를 열어 주세요.');}})}>승인 검토 열기</button></div>
          {reviewProblem&&<>
            <button type="button" className={button+' mt-2'} disabled={busy} onClick={()=>void run(async()=>{try{const result=await native('open');setReviewProblem(result.success===true?'Control 앱을 열도록 요청했습니다. 검토 창에서 연결 코드와 범위를 확인한 뒤 직접 인증해 주세요.':'Control 앱을 열지 못했습니다. 메뉴 막대의 AgentsToZ Control에서 검토를 열어 주세요.');}catch{setReviewProblem('Control 앱을 열지 못했습니다. 메뉴 막대의 AgentsToZ Control에서 검토를 열어 주세요.');}})}>Control 앱 직접 열기</button>
            <p role="alert" className="mt-2 max-h-20 overflow-y-auto text-sm">{reviewProblem}</p>
          </>}
          <div className="mt-2 max-h-20 overflow-y-auto text-sm">{pending.map((p:any)=><p key={p.approvalId} className="break-words">{p.label} · Control 앱에서 확인</p>)}</div>
        </section>}
      </header>
      <section className="mt-4 rounded-xl border border-[var(--line)] p-4" aria-label="도우미 연결 상태">
        <ComputerUseHelperStatus state={state} nativeState={nativeState}/>
        <div className="mt-3 flex flex-wrap gap-2"><button type="button" className={button} disabled={busy} onClick={()=>void run(async()=>{const result=await native('open');if(result.success!==true)throw Error(nativeMessage(result.code));setNotice(permissionsMissing?'시스템 설정에서 AgentsToZ Control 스위치를 켠 뒤 상태 다시 확인을 누르세요.':'Control 앱에서 연결 준비 또는 대기 중인 승인을 확인하세요.');})}>{permissionsMissing?'권한 켜기':'도우미 열기'}</button><button type="button" className={button} disabled={busy} onClick={()=>void run(()=>refresh(true,modeRef.current))}>상태 다시 확인</button></div>
      </section>
      {problem&&<p role="alert" className="mt-3 text-sm">{problem}</p>}{notice&&<p role="status" className="mt-3 text-sm">{notice}</p>}
      <ComputerUseModeSelector mode={mode} available={supportsComputerScopes(state)} locked={state?.access?.enabled===true} reason={state?.scoped?.native?.code} onChange={next=>{initialMode.current=false;modeRef.current=next;setMode(next);if(next==='window')setWindows([]);if(next==='application')setApplications([]);void refresh(true,next);}}/>
      {mode!=='window'&&<ComputerUseScopeForm mode={mode} state={state} applications={applications} request={request} refresh={()=>refresh()} busy={busy} run={run} onNotice={setNotice}/>}
      {mode==='window'&&<section className="mt-5" aria-labelledby="computer-use-grant-title"><h3 id="computer-use-grant-title" className="font-semibold">이 창만 AI에 맡기기</h3>
        <ol className="mt-2 list-inside list-decimal space-y-1 text-sm text-[var(--text-muted)]"><li>AI에 “컴퓨터 유즈를 연결해 줘”라고 요청합니다.</li><li>아래에서 AI 연결과 맡길 창을 선택합니다.</li><li>Control 앱에서 대상을 확인하고 승인합니다.</li></ol>
        <p className="mt-2 text-xs text-[var(--text-muted)]">AI 앱에 따라 여러 대화가 한 연결을 함께 사용할 수 있습니다. 허용은 이 연결에 적용되며 최대 10분 뒤 끝납니다. AI가 알려 준 연결 코드와 아래 코드를 확인하세요.</p>
        <div className="mt-3 grid gap-3"><label className="text-sm">AI 연결<select aria-label="AI 연결" className={field} value={connection} onChange={e=>setConnection(e.target.value)}><option value="">연결 선택</option>{(state?.connections??[]).map((c:any)=><option key={c.id} value={c.id}>{c.code} · {c.label}</option>)}</select></label>
          {!!connection&&<p className="text-xs text-[var(--text-muted)]">선택한 연결 코드 <code data-testid="computer-use-selected-code" className="break-all">{state?.connections?.find((c:any)=>c.id===connection)?.code}</code></p>}
          <label className="text-sm">맡길 창<select aria-label="맡길 창" className={field} value={windowId} onChange={e=>setWindowId(e.target.value)}><option value="">창 선택</option>{windows.map(w=><option key={`${w.pid}/${w.processStart}/${w.windowId}`} value={`${w.pid}/${w.processStart}/${w.windowId}`}>{w.appName} · {w.title||`창 ${w.windowId}`}</option>)}</select></label>
          <button type="button" className={button} disabled={busy||!ready||!connection||!selected} onClick={()=>void run(async()=>{
            const w=selected!;const target:ComputerTarget={bundleId:w.bundleId,teamId:w.teamId,codeHash:w.codeHash,pid:w.pid,processStart:w.processStart,windowId:w.windowId};
            const label=computerUseApprovalLabel(state?.connections?.find((c:any)=>c.id===connection)?.label,`${w.appName} · ${w.title||`창 ${w.windowId}`}`);
            await request({operation:'request-approval',connectionId:connection,target,label});setNotice('승인 대기 중입니다. Control 앱에서 같은 창인지 확인해 주세요.');await refresh();
          })}>이 창 허용 요청</button>
        </div>
      </section>}
      {!!state?.grants?.length&&<section className="mt-5" aria-label="현재 제어 허용"><h3 className="font-semibold">현재 허용</h3>{state.grants.map((g:any)=><div key={g.id} className="mt-2 flex items-center justify-between gap-3 rounded-xl border border-[var(--line)] p-3"><div className="min-w-0"><p className="break-words text-sm">{g.label}</p><p className="text-xs text-[var(--text-muted)]">{g.halted?'중지됨':'사용 시 대상과 권한 재확인'} · {g.target.bundleId}</p></div><button type="button" className={button} disabled={busy} onClick={()=>void run(async()=>{await request({operation:'revoke',id:g.id});await refresh();})}>허용 종료</button></div>)}</section>}
      {!!state?.recovery?.length&&<section className="mt-5" aria-label="결과 확인 필요"><h3 className="font-semibold">결과를 확인할 작업</h3><p className="mt-1 text-sm text-[var(--text-muted)]">자동으로 다시 실행하지 않습니다. 해당 앱의 현재 상태를 직접 확인해 주세요.</p>{state.recovery.map((r:any)=><div key={r.id} className="mt-2 rounded-xl border border-[var(--line)] p-3"><p className="break-words text-sm">{r.bundleId} · {r.operation}</p><label className="mt-2 flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={reviewed[r.id]===true} onChange={e=>setReviewed(old=>({...old,[r.id]:e.target.checked}))}/>앱의 현재 상태를 직접 확인했습니다</label><button type="button" className={button} disabled={busy||reviewed[r.id]!==true} onClick={()=>void run(async()=>{await request({operation:'review-recovery',id:r.id,confirmed:true});await refresh();})}>검토 완료</button></div>)}</section>}
      <ComputerUseScopeGrants state={state} busy={busy} run={run} request={request} refresh={()=>refresh()}/>
      <details className="mt-5 border-t border-[var(--line)] pt-3"><summary className="min-h-11 cursor-pointer text-sm">사용 범위와 연결 종료</summary><p className="text-sm text-[var(--text-muted)]">접근성 조작을 지원하지 않는 화면은 사람이 이어서 처리합니다. 보안 입력·사람의 화면 사용·대상 변경·결과 불명에서는 AI 제어가 중지되거나 거부됩니다. 외부 AI 앱의 모델·에포트 자동 변경은 별도의 연결 검증이 필요합니다.</p>{(state?.connections??[]).map((c:any)=><div key={c.id} className="mt-2 flex items-center justify-between gap-3 text-sm"><span className="min-w-0"><code className="block break-all">{c.code}</code><span className="block break-words">표시 이름: {c.label}</span></span><button type="button" className={button} disabled={busy} onClick={()=>void run(async()=>{await request({operation:'disconnect',connectionId:c.id});await refresh();})}>연결 종료</button></div>)}</details>
    </div>
  </div>;
}
