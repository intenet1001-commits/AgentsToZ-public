import {useCallback,useEffect,useLayoutEffect,useRef,useState} from 'react';
import {restoreDialogFocus} from './dialogFocus';
import {isDialogDismissKey} from './dialogEscape';
import {requestRemoteTeamsPermissions,RemoteTeamsPermissionsError,type RemoteTeamsPermissions as RemoteTeamsPermissionsState,type RemoteTeamsPermissionsRequester} from './remoteTeamsPermissionsClient';

const button='min-h-11 rounded-xl border border-[var(--line)] px-4 py-2 text-sm disabled:opacity-50';
/** Local project selection narrows the existing native Teams grant; it never creates that grant or starts work. */
export function RemoteTeamsPermissions({onClose,returnFocusTo,request=requestRemoteTeamsPermissions}:{onClose:()=>void;returnFocusTo?:HTMLElement|null;request?:RemoteTeamsPermissionsRequester}){
  const [state,setState]=useState<RemoteTeamsPermissionsState|null>(null),[selected,setSelected]=useState<string[]>([]);
  const [busy,setBusy]=useState(false),[problem,setProblem]=useState(''),[notice,setNotice]=useState(''),[reviewRequired,setReviewRequired]=useState(false);
  const alive=useRef(true),reading=useRef(false),dialog=useRef<HTMLDivElement>(null),draft=useRef(selected);
  draft.current=selected;
  useLayoutEffect(()=>{alive.current=true;const opener=returnFocusTo??(document.activeElement instanceof HTMLElement?document.activeElement:null);dialog.current?.focus();return()=>{alive.current=false;restoreDialogFocus(opener);};},[returnFocusTo]);
  // A request can disable the focused button and move focus to the document body.
  useEffect(()=>{const dismiss=(event:KeyboardEvent)=>{if(isDialogDismissKey(event)){event.preventDefault();event.stopPropagation();onClose();}};document.addEventListener('keydown',dismiss);return()=>document.removeEventListener('keydown',dismiss);},[onClose]);
  const refresh=useCallback(async(preserve=false)=>{
    if(reading.current)return;reading.current=true;setBusy(true);
    try{
      const next=await request({operation:'permissions'});if(!alive.current)return;
      const available=new Set(next.projects.map(project=>project.projectId)),previous=draft.current;
      setState(next);setSelected(preserve?previous.filter(id=>available.has(id)):next.projects.filter(project=>project.allowed).map(project=>project.projectId));
      setProblem('');setReviewRequired(false);
      setNotice(preserve?'최신 목록을 불러왔습니다. 선택한 프로젝트를 다시 확인한 뒤 저장하세요.':'');
    }catch(error){if(alive.current){setProblem(error instanceof Error?error.message:'현재 허용 상태를 읽지 못했습니다.');setReviewRequired(true);}}
    finally{reading.current=false;if(alive.current)setBusy(false);}
  },[request]);
  useEffect(()=>{void refresh();},[refresh]);
  const save=async()=>{
    if(busy||!state||!state.configured||reviewRequired)return;
    setBusy(true);setProblem('');setNotice('');
    try{
      const next=await request({operation:'set-permissions',expectedRevision:state.revision,projectIds:selected});if(!alive.current)return;
      setState(next);setSelected(next.projects.filter(project=>project.allowed).map(project=>project.projectId));setReviewRequired(false);
      setNotice('이 Mac에서 원격 Teams 작업을 받을 프로젝트를 저장했습니다. 다른 프로젝트와 새로 등록하는 프로젝트는 자동으로 허용되지 않습니다.');
    }catch(error){if(alive.current){setProblem(error instanceof Error?error.message:'저장 결과를 확인하지 못했습니다.');setReviewRequired(true);if(error instanceof RemoteTeamsPermissionsError&&error.code==='REMOTE_TEAMS_CONSENT_REQUIRED')setState(current=>current?{...current,configured:false}:current);}}
    finally{if(alive.current)setBusy(false);}
  };
  const allowed=state?.projects.filter(project=>project.allowed).map(project=>project.projectId)??[];
  const changed=selected.length!==allowed.length||selected.some(id=>!allowed.includes(id));
  const duplicates=new Set((state?.projects??[]).filter((project,index,list)=>list.findIndex(other=>other.name===project.name)!==index).map(project=>project.name));
  return <div className="fixed inset-0 z-[220] flex items-center justify-center bg-[var(--scrim)] p-3" onMouseDown={event=>{if(event.target===event.currentTarget)onClose();}}>
    <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby="remote-teams-permissions-title" tabIndex={-1} data-testid="remote-teams-permissions" className="max-h-[90dvh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-5 text-[var(--ink)] shadow-2xl" onKeyDown={event=>{
      if(event.key==='Tab'){const nodes=Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),[tabindex="0"]')??[]).filter(node=>node.getClientRects().length);const first=nodes[0],last=nodes.at(-1);if(event.shiftKey&&(document.activeElement===first||document.activeElement===dialog.current)){event.preventDefault();last?.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}}
    }}>
      <div className="flex items-start justify-between gap-3"><h2 id="remote-teams-permissions-title" className="text-xl font-semibold">Teams 원격 작업 허용 프로젝트</h2><button type="button" className={button+' shrink-0'} onClick={onClose}>닫기</button></div>
      <p className="mt-3 text-sm text-[var(--ink-2)]">다른 커뮤니티 기기의 Teams가 이 Mac에서 작업할 프로젝트를 직접 고르세요. 처음에는 아무 프로젝트도 허용하지 않습니다.</p>
      <p className="mt-2 text-sm text-[var(--ink-2)]">기능 전체 선택이나 원격 요청으로 이 목록이 늘어나지 않습니다. 저장해도 팀 작업을 시작하지 않습니다.</p>
      {problem&&<p role="alert" className="mt-3 rounded-xl border border-[var(--danger)] p-3 text-sm">{problem}</p>}
      {notice&&<p role="status" className="mt-3 text-sm">{notice}</p>}
      {state?.configured&&<p className="mt-3 text-sm text-[var(--ink-2)]">이 기기의 Teams 공통 등록을 확인했습니다. 현재 {allowed.length}개 프로젝트를 허용하고 있습니다.</p>}
      {state&&!state.configured&&<p className="mt-3 text-sm" data-testid="remote-teams-consent-required">이 기기의 공통 등록에서 Teams 사용 권한을 먼저 확인하세요. 현재 목록을 볼 수 있지만 허용 설정은 저장할 수 없습니다.</p>}
      {state&&<fieldset disabled={busy||!state.configured||reviewRequired} className="mt-4 min-w-0"><legend className="font-semibold">이 Mac에 등록된 프로젝트 · {selected.length}개 선택</legend>
        {state.projects.length===0?<p className="mt-2 text-sm text-[var(--ink-2)]">등록된 프로젝트가 없습니다. 프로젝트를 등록한 뒤 목록을 다시 확인하세요.</p>:<div className="mt-2 max-h-72 overflow-y-auto rounded-xl border border-[var(--line)] p-2">
          {state.projects.map(project=><label key={project.projectId} className="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg px-2 py-3 text-sm">
            <input type="checkbox" className="mt-1 size-4 shrink-0" checked={selected.includes(project.projectId)} onChange={event=>{const checked=event.target.checked;setSelected(current=>checked?[...current,project.projectId]:current.filter(id=>id!==project.projectId));}}/>
            <span className="min-w-0 break-words">{project.name}{duplicates.has(project.name)&&<span className="mt-1 block break-all text-xs text-[var(--ink-2)]">프로젝트 코드 {project.projectId}</span>}</span>
          </label>)}
        </div>}
      </fieldset>}
      <div className="mt-4 flex flex-wrap gap-2"><button type="button" className={button} disabled={busy} onClick={()=>void refresh(true)}>현재 허용 상태 다시 읽기</button><button type="button" className={button+' bg-[var(--raised)] text-[var(--ink)]'} disabled={busy||!state?.configured||!changed||reviewRequired} onClick={()=>void save()}>{busy?'확인 중…':'선택한 프로젝트 저장'}</button></div>
    </div>
  </div>;
}
