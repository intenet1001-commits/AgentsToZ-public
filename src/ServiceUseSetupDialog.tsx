import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { isTauri } from './lib/env';
import type { ServiceUseReadiness } from './serviceUseProtocol';
import {SERVICE_USE_CHANGED_EVENT} from './projectUseMention';

type Status = { devMemoryReady?:boolean; readiness: ServiceUseReadiness; serviceMemory: { exists: boolean; ready: boolean; problem: string | null; record: { serviceMemoryId: string; serviceKey: string; storage?: 'project-namespace-v1' } | null } };
async function post(action: string, body: Record<string, unknown>) {
  const response = await fetch(`${isTauri() ? 'http://127.0.0.1:3001' : ''}/api/service-memory/${action}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok || result.success !== true) throw Error(result.error || 'USE 준비 상태를 확인하지 못했습니다.');
  return result;
}
/** Activation is independent of a chat channel and never grants a CLI or developer tools. */
export default function ServiceUseSetupDialog({ projects, onClose, initialProjectId, onWorkroom }: {
  projects: Array<{ id: string; name: string; folderPath?: string }>; onClose(): void;
  initialProjectId?:string;
  onWorkroom?:(targetId:string,title:string,prompt:string)=>void;
}) {
  const [projectId, setProjectId] = useState(projects.find(p => p.id===initialProjectId&&p.folderPath)?.id ?? projects.find(p => p.folderPath)?.id ?? '');
  const [status, setStatus] = useState<Status | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [connectionCode,setConnectionCode]=useState('');
  const [goal,setGoal]=useState(''),[notice,setNotice]=useState('');
  const projectName=projects.find(p=>p.id===projectId)?.name??'앱';
  const epoch = useRef(0), mounted = useRef(true), dialog = useRef<HTMLDialogElement>(null);
  const button = 'min-h-11 rounded-lg border border-[var(--line)] px-3 py-2 text-sm disabled:opacity-40';
  useEffect(() => {
    mounted.current = true; const previous = document.activeElement;
    dialog.current?.showModal();
    return () => { mounted.current = false; epoch.current++; if (previous instanceof HTMLElement) previous.focus(); };
  }, []);
  const refresh = async (id: string) => {
    const mine = ++epoch.current; setStatus(null); setError('');
    if (!id) return;
    try { const result = await post('use-status', { portId: id }); if (mounted.current && mine === epoch.current) setStatus(result); }
    catch (e) { if (mounted.current && mine === epoch.current) setError(e instanceof Error ? e.message : String(e)); }
  };
  useEffect(() => { setConnectionCode('');setGoal('');setNotice('');void refresh(projectId); }, [projectId]);
  const prepareWorkroom=async()=>{
    if(busy||!projectId)return;
    const mine=++epoch.current;setBusy(true);setError('');setNotice('');
    try{
      const result=await post('prepare-workroom',{portId:projectId,goal});
      if(!mounted.current||mine!==epoch.current)return;
      if(result.projectId!==projectId||typeof result.prompt!=='string'||typeof result.title!=='string')throw Error('선택한 프로젝트의 USE 준비 요청을 확인하세요.');
      if(onWorkroom){onWorkroom(projectId,result.title,result.prompt);onClose();}
      else{await navigator.clipboard.writeText(result.prompt);if(mounted.current&&mine===epoch.current)setNotice('USE 준비 요청을 복사했습니다. 이 프로젝트의 DEV 워크룸에서 실행하세요.');}
    }catch(e){if(mounted.current&&mine===epoch.current)setError(e instanceof Error?e.message:String(e));}
    finally{if(mounted.current&&mine===epoch.current)setBusy(false);}
  };
  const connect=async()=>{
    if(busy||!projectId||!connectionCode)return;
    const mine=++epoch.current;setBusy(true);setError('');
    try{await post(projectName.toLowerCase()==='shadowloop'&&!connectionCode.trim().startsWith('ATZUSE1.')?'connect-shadowloop':'connect-app',{portId:projectId,connectionCode:connectionCode.trim(),consent:true});
      const result=await post('use-status',{portId:projectId});
      if(mounted.current&&mine===epoch.current){setConnectionCode('');setStatus(result);}
    }catch(e){if(mounted.current&&mine===epoch.current)setError(e instanceof Error?e.message:String(e));}
    finally{if(mounted.current&&mine===epoch.current)setBusy(false);}
  };
  const prepare = async () => {
    if (busy || !projectId || !status) return;
    const mine = ++epoch.current; setBusy(true); setError('');
    try {
      // Keep the identity/content; explicitly cut over authority before activation.
      await post('prepare-use-memory', { portId: projectId, consent: true });
      await post('enable-use', { portId: projectId, consent: true });
      window.dispatchEvent(new Event(SERVICE_USE_CHANGED_EVENT));
      const result = await post('use-status', { portId: projectId });
      if (mounted.current && mine === epoch.current) setStatus(result);
    } catch (e) { if (mounted.current && mine === epoch.current) setError(e instanceof Error ? e.message : String(e)); }
    finally { if (mounted.current && mine === epoch.current) setBusy(false); }
  };
  const readiness = status?.readiness;
  return createPortal(<dialog ref={dialog} data-testid="service-use-setup" aria-labelledby="service-use-title"
    onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}
    className="max-h-[90dvh] w-[min(40rem,calc(100vw-2rem))] overflow-y-auto rounded-2xl border border-[var(--line)] bg-[var(--bg-elevated)] p-5 text-[var(--ink)] backdrop:bg-black/60">
    <header className="flex items-center justify-between gap-3"><h2 id="service-use-title" className="text-lg font-semibold">USE · 제품 사용·운영 준비</h2><button autoFocus type="button" aria-label="USE 준비 닫기" className={button} disabled={busy} onClick={onClose}>닫기</button></header>
    <p className="text-sm leading-6 text-[var(--ink-2)]">한 프로젝트에서 DEV 개발과 USE 운영을 함께 사용할 수 있습니다. 역할은 업무와 권한을 정하고, 업무 스레드·워크룸·음성·MCP·Buzz·Hermes·Telegram은 연결 채널입니다.</p>
    <label className="block text-sm">운영할 제품의 프로젝트<select aria-label="USE 프로젝트" className={button + ' mt-2 w-full bg-[var(--surface)]'} value={projectId} disabled={busy} onChange={e => setProjectId(e.target.value)}>
      <option value="">프로젝트 선택</option>{projects.filter(p => p.folderPath).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
    </select></label>
    {projectId&&<section aria-label="워크룸에서 USE 준비" className="mt-4 rounded-xl border border-[var(--line)] p-3">
      <p className="mt-0 text-sm leading-6">이 프로젝트의 워크룸에서 앱 사용 기능을 연결합니다. 기존 기능을 확인하고, 필요한 연결 구현과 검증을 진행합니다.</p>
      <label className="block text-sm">USE로 할 일 (선택)<textarea aria-label="USE로 할 일" rows={2} value={goal} maxLength={1000} disabled={busy} onChange={e=>setGoal(e.target.value)} className={button+' mt-2 w-full bg-[var(--surface)]'} placeholder="예: 보고서 만들기, 예약 현황 확인하기"/></label>
      <button type="button" className={button+' mt-3'} disabled={busy} onClick={()=>void prepareWorkroom()}>{onWorkroom?'워크룸에서 USE 연결 준비':'USE 준비 요청 복사'}</button>
      <p className="mb-0 mt-2 text-xs">워크룸에서 요청을 확인하고 AI를 선택해 시작합니다. 앱 연결을 확인하면 아래에서 활성화할 수 있습니다.</p>
    </section>}
    {projectId&&<section aria-label={projectName+' 운영 도구 연결'} className="mt-4 rounded-xl border border-[var(--line)] p-3">
      <p className="mt-0 text-sm leading-6">{projectName.toLowerCase()==='shadowloop'?"ShadowLoop 앱의 ‘AI 운영 연결’에서 현재 가족 프로필의 연결 코드를 발급하세요. 이 Mac에서 해당 프로필의 자료·음성·승인된 폰 전송만 허용하며, 연결 해제는 ShadowLoop에서 합니다.":"앱의 ‘AI 운영 연결’에서 사용할 계정과 자료 범위를 확인한 뒤 발급한 코드를 입력하세요. 연결 기능이 없으면 위 워크룸에서 먼저 준비하세요. 연결 해제는 해당 앱에서 합니다."}</p>
      <label className="block text-sm">{projectName} 운영 연결 코드<input type="password" autoComplete="off" spellCheck={false} aria-label={projectName+' 운영 연결 코드'} value={connectionCode} disabled={busy} onChange={e=>setConnectionCode(e.target.value)} className={button+' mt-2 w-full bg-[var(--surface)]'} /></label>
      <button type="button" className={button+' mt-3'} disabled={busy||!connectionCode.trim()||status?.devMemoryReady===false} onClick={()=>void connect()}>이 Mac에 운영 도구 연결</button>
    </section>}
    {readiness && <>
      <dl data-testid="service-use-readiness" className="my-4 grid grid-cols-2 gap-3 rounded-xl bg-[var(--surface)] p-3 text-sm">
        <dt>USE 활성화</dt><dd>{readiness.enabled ? '활성화됨' : '아직 꺼짐'}</dd>
        <dt>운영기억</dt><dd>{!readiness.memoryReady ? '준비·복구 필요' : status.serviceMemory.record?.storage === 'project-namespace-v1' ? '프로젝트 USE namespace' : '구경로 · 정본 전환 필요'}</dd>
        <dt>운영 도구</dt><dd>{readiness.tools === 'verified' ? '검증됨' : readiness.tools === 'draft' ? '초안 · 실행 불가' : '미등록'}</dd>
        <dt>앱·사용자·운영 권한</dt><dd>{readiness.environmentReady ? '확인됨' : '별도 확인 필요'}</dd>
        <dt>실제 실행</dt><dd>{readiness.executionReady ? '준비됨' : '아직 실행할 수 없음'}</dd>
      </dl>
      {status.serviceMemory.record && <details className="text-xs text-[var(--ink-3)]"><summary className="min-h-11 cursor-pointer">운영기억 연결 정보</summary><p className="break-all">USE memoryId: {status.serviceMemory.record.serviceMemoryId} · serviceKey: {status.serviceMemory.record.serviceKey}</p></details>}
      {readiness.problem && <p role="status" className="text-sm leading-6 text-[var(--warn)]">{readiness.problem}</p>}
      <p className="text-xs leading-5">프로젝트의 독립 USE namespace에 기억을 준비합니다. 구경로는 같은 정본을 가리키는 호환 링크로 연결하고 원본은 복구 사본으로 보존합니다. 기존 Buzz가 기억을 쓰는 중이면 먼저 마친 뒤 준비하세요. 중단된 전환은 같은 버튼으로 검증·복구하며 충돌은 덮어쓰지 않습니다.</p>
      <button type="button" className={button} data-testid="service-use-enable" disabled={busy || status.devMemoryReady===false || readiness.enabled && readiness.memoryReady && status.serviceMemory.record?.storage === 'project-namespace-v1'} onClick={() => void prepare()}>
        {busy ? 'USE 준비 중…' : readiness.enabled && readiness.memoryReady && status.serviceMemory.record?.storage === 'project-namespace-v1' ? 'USE 활성화됨' : status.serviceMemory.exists ? '원본 보존·USE 정본 전환 후 활성화' : '프로젝트 USE 운영기억 준비·활성화'}
      </button>
    </>}
    {!status && projectId && !error && <p role="status">USE 준비 상태 확인 중…</p>}
    {error && <p role="alert" className="text-sm text-[var(--danger)]">{error}</p>}
    {notice && <p role="status" className="text-sm">{notice}</p>}
    <button type="button" className={button + ' mt-3 ml-2'} disabled={busy || !projectId} onClick={() => void refresh(projectId)}>다시 확인</button>
    <p className="mb-0 mt-4 text-xs leading-5 text-[var(--ink-3)]">AI 로그인, 앱 준비, 운영 권한, 폰 페어링은 각각 확인합니다. 실행 준비 후 업무 스레드에서 USE 역할과 허용 도구를 선택하세요. 소스·Git·배포·개발 기억 변경은 해당 DEV 담당자에게 인계합니다. Buzz는 프로젝트의 기존 앱 열기에서 사용할 수 있습니다.</p>
  </dialog>, document.body);
}
