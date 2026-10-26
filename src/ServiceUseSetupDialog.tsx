import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ServiceUseReadiness } from './serviceUseProtocol';
import {SERVICE_USE_CHANGED_EVENT, useMentionLabel} from './projectUseMention';
import {postServiceUse as post, serviceUseConnectRoute} from './serviceUseLocalClient';

/** `turnedOff`: 「USE 끄기」 was used (memory and connection kept), as opposed to a USE that was never turned on. */
type Status = { devMemoryReady?:boolean; turnedOff?:boolean; readiness: ServiceUseReadiness; serviceMemory: { exists: boolean; ready: boolean; problem: string | null; record: { serviceMemoryId: string; serviceKey: string; storage?: 'project-namespace-v1' } | null } };
type Step = 'workroom' | 'connect' | 'enable' | 'disable' | 'status';
/** Activation is independent of a chat channel and never grants a CLI or developer tools. */
export default function ServiceUseSetupDialog({ projects, onClose, initialProjectId, onWorkroom }: {
  projects: Array<{ id: string; name: string; folderPath?: string }>; onClose(): void;
  initialProjectId?:string;
  onWorkroom?:(targetId:string,title:string,prompt:string)=>void;
}) {
  const [projectId, setProjectId] = useState(projects.find(p => p.id===initialProjectId&&p.folderPath)?.id ?? projects.find(p => p.folderPath)?.id ?? '');
  const [status, setStatus] = useState<Status | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState<Step | ''>('');
  const [errorAt, setErrorAt] = useState<Step>('status');
  const [connectionCode,setConnectionCode]=useState('');
  const [goal,setGoal]=useState(''),[notice,setNotice]=useState('');
  const [confirmOff,setConfirmOff]=useState(false);
  const projectName=projects.find(p=>p.id===projectId)?.name??'앱';
  const epoch = useRef(0), mounted = useRef(true), dialog = useRef<HTMLDialogElement>(null), alertRef = useRef<HTMLParagraphElement>(null);
  // The confirmation replaces the 「USE 끄기」 button, so focus is put back where the person can continue.
  const offButton = useRef<HTMLButtonElement>(null), enableButton = useRef<HTMLButtonElement>(null), focusNext = useRef<'off' | 'enable' | null>(null);
  const button = 'min-h-11 rounded-lg border border-[var(--line)] px-3 py-2 text-sm disabled:opacity-40';
  const step = 'mt-4 rounded-xl border border-[var(--line)] p-3', stepTitle = 'm-0 text-sm font-semibold';
  useEffect(() => {
    mounted.current = true; const previous = document.activeElement;
    dialog.current?.showModal();
    return () => { mounted.current = false; epoch.current++; if (previous instanceof HTMLElement) previous.focus(); };
  }, []);
  // The alert sits in the step whose button failed; bring it into view instead of below the fold.
  useEffect(() => { if (error) alertRef.current?.scrollIntoView?.({ block: 'nearest' }); }, [error, errorAt]);
  const fail = (at: Step, e: unknown) => { setErrorAt(at); setError(e instanceof Error ? e.message : String(e)); };
  const refresh = async (id: string) => {
    const mine = ++epoch.current; setStatus(null); setError(''); setConfirmOff(false);
    if (!id) return;
    try { const result = await post('use-status', { portId: id }); if (mounted.current && mine === epoch.current) setStatus(result); }
    catch (e) { if (mounted.current && mine === epoch.current) fail('status', e); }
  };
  useEffect(() => { setConnectionCode('');setGoal('');setNotice('');void refresh(projectId); }, [projectId]);
  const prepareWorkroom=async()=>{
    if(busy||!projectId)return;
    const mine=++epoch.current;setBusy('workroom');setError('');setNotice('');
    try{
      const result=await post('prepare-workroom',{portId:projectId,goal});
      if(!mounted.current||mine!==epoch.current)return;
      if(result.projectId!==projectId||typeof result.prompt!=='string'||typeof result.title!=='string')throw Error('선택한 프로젝트의 USE 준비 요청을 확인하세요.');
      if(onWorkroom){onWorkroom(projectId,result.title,result.prompt);onClose();}
      else{await navigator.clipboard.writeText(result.prompt);if(mounted.current&&mine===epoch.current)setNotice('USE 준비 요청을 복사했습니다. 이 프로젝트의 DEV 워크룸에서 실행하세요.');}
    }catch(e){if(mounted.current&&mine===epoch.current)fail('workroom',e);}
    finally{if(mounted.current&&mine===epoch.current)setBusy('');}
  };
  const connect=async()=>{
    if(busy||!projectId||!connectionCode)return;
    const mine=++epoch.current;setBusy('connect');setError('');
    try{await post(serviceUseConnectRoute(connectionCode,projectName),{portId:projectId,connectionCode:connectionCode.trim(),consent:true});
      const result=await post('use-status',{portId:projectId});
      if(mounted.current&&mine===epoch.current){setConnectionCode('');setStatus(result);}
    }catch(e){if(mounted.current&&mine===epoch.current)fail('connect',e);}
    finally{if(mounted.current&&mine===epoch.current)setBusy('');}
  };
  const prepare = async () => {
    if (busy || !projectId || !status) return;
    const mine = ++epoch.current; setBusy('enable'); setError(''); setConfirmOff(false);
    try {
      // Keep the identity/content; explicitly cut over authority before activation.
      // 「USE 다시 켜기」 takes this same path: the cut-over is already done, so only the flag turns back on.
      await post('prepare-use-memory', { portId: projectId, consent: true });
      await post('enable-use', { portId: projectId, consent: true });
      window.dispatchEvent(new Event(SERVICE_USE_CHANGED_EVENT));
      const result = await post('use-status', { portId: projectId });
      if (mounted.current && mine === epoch.current) setStatus(result);
    } catch (e) { if (mounted.current && mine === epoch.current) fail('enable', e); }
    finally { if (mounted.current && mine === epoch.current) setBusy(''); }
  };
  /** 「USE 끄기」 turns only the flag off. The server keeps the memory, the app connection and earlier results. */
  const turnOff = async () => {
    if (busy || !projectId || !status) return;
    const mine = ++epoch.current; setBusy('disable'); setError('');
    try {
      await post('disable-use', { portId: projectId, consent: true });
      // The @ pickers drop this USE now, even if the status read below fails.
      window.dispatchEvent(new Event(SERVICE_USE_CHANGED_EVENT));
      // It is off on the server from here: never keep asking whether to turn it off, even if the refresh fails.
      if (mounted.current && mine === epoch.current) { focusNext.current = 'enable'; setConfirmOff(false); setStatus(s => s && { ...s, turnedOff: true, readiness: { ...s.readiness, enabled: false, executionReady: false, problem: null } }); }
      try {
        const result = await post('use-status', { portId: projectId });
        if (mounted.current && mine === epoch.current) setStatus(result);
      } catch (e) { if (mounted.current && mine === epoch.current) fail('status', e); }
    } catch (e) { if (mounted.current && mine === epoch.current) fail('disable', e); }
    finally { if (mounted.current && mine === epoch.current) setBusy(''); }
  };
  const cancelOff = () => { focusNext.current = 'off'; setConfirmOff(false); };
  useEffect(() => {
    const next = focusNext.current; if (!next || busy) return;
    focusNext.current = null; (next === 'off' ? offButton : enableButton).current?.focus();
  }, [confirmOff, status, busy]);
  const readiness = status?.readiness;
  const alert = (at: Step) => error && errorAt === at ? <p ref={alertRef} role="alert" className="text-sm text-[var(--danger)]">{error}</p> : null;
  const activated = !!readiness && readiness.enabled && readiness.memoryReady && status.serviceMemory.record?.storage === 'project-namespace-v1';
  const resumable = !!readiness && !readiness.enabled && !!status.turnedOff && readiness.memoryReady && status.serviceMemory.record?.storage === 'project-namespace-v1';
  const useLabel = useMentionLabel(projectName, status?.serviceMemory.record?.serviceKey);
  return createPortal(<dialog ref={dialog} data-testid="service-use-setup" aria-labelledby="service-use-title"
    onCancel={event => { event.preventDefault(); if (busy) return; if (confirmOff) cancelOff(); else onClose(); }}
    className="max-h-[90dvh] w-[min(40rem,calc(100vw-2rem))] overflow-y-auto rounded-2xl border border-[var(--line)] bg-[var(--bg-elevated)] p-5 text-[var(--ink)] backdrop:bg-black/60">
    <header className="flex items-center justify-between gap-3"><h2 id="service-use-title" className="text-lg font-semibold">USE · 제품 사용·운영 준비</h2><button autoFocus type="button" aria-label="USE 준비 닫기" className={button} disabled={!!busy} onClick={onClose}>닫기</button></header>
    <p className="text-sm leading-6 text-[var(--ink-2)]">DEV는 앱을 고치는 AI 작업이고, USE는 완성된 앱의 정해진 기능을 AI가 대신 실행하는 일입니다. 한 프로젝트에서 둘을 함께 쓸 수 있습니다.</p>
    <label className="block text-sm">운영할 제품의 프로젝트<select aria-label="USE 프로젝트" className={button + ' mt-2 w-full bg-[var(--surface)]'} value={projectId} disabled={!!busy} onChange={e => setProjectId(e.target.value)}>
      <option value="">프로젝트 선택</option>{projects.filter(p => p.folderPath).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
    </select></label>
    {projectId&&<section aria-label="워크룸에서 USE 준비" className={step}>
      <h3 className={stepTitle}>1 · 앱에 연결 기능 만들기 (DEV)</h3>
      <p className="mt-1 text-sm leading-6">앱에 ‘AI 운영 연결’ 기능이 없으면 이 프로젝트의 워크룸에서 만듭니다. 이미 있으면 2단계로 넘어가세요.</p>
      <label className="block text-sm">USE로 할 일 (선택)<textarea aria-label="USE로 할 일" rows={2} value={goal} maxLength={1000} disabled={!!busy} onChange={e=>setGoal(e.target.value)} className={button+' mt-2 w-full bg-[var(--surface)]'} placeholder="예: 보고서 만들기, 예약 현황 확인하기"/></label>
      <button type="button" className={button+' mt-3'} disabled={!!busy} onClick={()=>void prepareWorkroom()}>{onWorkroom?'워크룸에서 USE 연결 준비':'USE 준비 요청 복사'}</button>
      <p className="mb-0 mt-2 text-xs">워크룸에서 요청을 확인하고 AI를 골라 시작합니다.</p>
      {alert('workroom')}
    </section>}
    {projectId&&<section aria-label={projectName+' 운영 도구 연결'} className={step}>
      <h3 className={stepTitle}>2 · 앱에서 받은 코드 입력</h3>
      <p className="mt-1 text-sm leading-6">{projectName.toLowerCase()==='shadowloop'?"ShadowLoop 앱의 ‘AI 운영 연결’에서 현재 가족 프로필의 연결 코드를 발급하세요. 이 Mac에서 해당 프로필의 자료·음성·승인된 폰 전송만 허용하며, 연결 해제는 ShadowLoop에서 합니다.":"앱의 ‘AI 운영 연결’에서 사용할 계정과 자료 범위를 확인한 뒤 발급한 코드를 입력하세요. 연결 해제는 해당 앱에서 합니다."}</p>
      <label className="block text-sm">{projectName} 운영 연결 코드<input type="password" autoComplete="off" spellCheck={false} aria-label={projectName+' 운영 연결 코드'} value={connectionCode} disabled={!!busy} onChange={e=>setConnectionCode(e.target.value)} className={button+' mt-2 w-full bg-[var(--surface)]'} /></label>
      <button type="button" className={button+' mt-3'} disabled={!!busy||!connectionCode.trim()||status?.devMemoryReady===false} onClick={()=>void connect()}>{busy==='connect'?'연결 확인 중…':'이 Mac에 운영 도구 연결'}</button>
      {status?.devMemoryReady===false&&readiness?.problem&&<p className="mb-0 mt-2 text-xs text-[var(--warn)]">{readiness.problem}</p>}
      {alert('connect')}
    </section>}
    {readiness && <section aria-label="USE 켜기" className={step}>
      <h3 className={stepTitle}>3 · USE 켜기</h3>
      <dl data-testid="service-use-readiness" className="my-3 grid grid-cols-2 gap-3 rounded-xl bg-[var(--surface)] p-3 text-sm">
        <dt>USE 활성화</dt><dd>{readiness.enabled ? '활성화됨' : status.turnedOff ? readiness.tools === 'verified' && readiness.environmentReady ? '꺼 둠 · 기억·연결 보존' : '꺼 둠 · 기억 보존' : '아직 꺼짐'}</dd>
        <dt>운영기억</dt><dd>{!readiness.memoryReady ? '준비·복구 필요' : status.serviceMemory.record?.storage === 'project-namespace-v1' ? '준비됨' : '이전 위치 · 옮기기 필요'}</dd>
        <dt>운영 도구</dt><dd>{readiness.tools === 'verified' ? readiness.environmentReady ? '검증됨' : '연결됨 · 앱 응답 확인 필요' : '연결 전'}</dd>
        <dt>앱·사용자·운영 권한</dt><dd>{readiness.environmentReady ? '확인됨' : '확인 필요'}</dd>
        <dt>실제 실행</dt><dd>{readiness.executionReady ? '준비됨' : '아직 실행할 수 없음'}</dd>
      </dl>
      {readiness.problem && <p role="status" className="text-sm leading-6 text-[var(--warn)]">{readiness.problem}</p>}
      {readiness.executionReady && <p role="status" className="text-sm leading-6">이제 작업 세션이나 커뮤니티에서 @{useLabel} 로 요청하세요.</p>}
      <div className="flex flex-wrap gap-2">
        <button ref={enableButton} type="button" className={button} data-testid="service-use-enable" disabled={!!busy || status.devMemoryReady===false || activated} onClick={() => void prepare()}>
          {busy==='enable' ? resumable ? 'USE 다시 켜는 중…' : 'USE 준비 중…' : activated ? 'USE 활성화됨' : resumable ? 'USE 다시 켜기' : status.serviceMemory.exists ? '기존 기억을 보존하고 USE 켜기' : '프로젝트 USE 운영기억 준비·활성화'}
        </button>
        {readiness.enabled && !confirmOff && <button ref={offButton} type="button" className={button} data-testid="service-use-disable" disabled={!!busy} onClick={() => setConfirmOff(true)}>USE 끄기</button>}
      </div>
      {readiness.enabled && confirmOff && <div role="alertdialog" aria-label="USE 끄기 확인" aria-describedby="service-use-off-detail" data-testid="service-use-disable-confirm" className="mt-3 rounded-xl border border-[var(--accent)] p-3 text-sm">
        <p id="service-use-off-detail" className="m-0 leading-6">USE를 끌까요? 끄면 @{useLabel}로 새 요청을 맡기거나 실행할 수 없습니다. 운영기억·앱 연결·이전 결과는 그대로 남고, 다시 켜면 그대로 이어집니다.</p>
        <div className="mt-2 flex flex-wrap gap-2">
          <button type="button" className={button} disabled={!!busy} onClick={() => void turnOff()}>{busy==='disable' ? '끄는 중…' : '끄기'}</button>
          <button autoFocus type="button" className={button} disabled={!!busy} onClick={cancelOff}>취소</button>
        </div>
        {alert('disable')}
      </div>}
      {alert('enable')}
      <details className="mt-2 text-xs leading-5 text-[var(--ink-3)]"><summary className="min-h-11 cursor-pointer">운영기억은 어디에 두나요?</summary>
        <p>프로젝트 안의 USE 전용 폴더에 둡니다. 예전 위치는 같은 기억을 가리키는 호환 링크로 남기고 원본은 복구 사본으로 보존합니다. 기존 Buzz가 기억을 쓰는 중이면 먼저 마친 뒤 준비하세요. 중단된 옮기기는 같은 버튼으로 검증·복구하며 충돌은 덮어쓰지 않습니다.</p>
        {status.serviceMemory.record && <p className="break-all">USE memoryId: {status.serviceMemory.record.serviceMemoryId} · serviceKey: {status.serviceMemory.record.serviceKey}</p>}
      </details>
    </section>}
    {!status && projectId && !error && <p role="status">USE 준비 상태 확인 중…</p>}
    {alert('status')}
    {notice && <p role="status" className="text-sm">{notice}</p>}
    <button type="button" className={button + ' mt-3'} disabled={!!busy || !projectId} onClick={() => void refresh(projectId)}>다시 확인</button>
    <p className="mb-0 mt-4 text-xs leading-5 text-[var(--ink-3)]">소스·Git·배포 변경은 USE가 아니라 이 프로젝트의 DEV 작업으로 요청하세요.</p>
  </dialog>, document.body);
}
