import React, { useEffect, useRef, useState } from 'react';
import { isTauri } from './lib/env';
import OnboardingCodexLoginPanel from './OnboardingCodexLoginPanel';
import OnboardingCodexPreparation from './OnboardingCodexPreparation';
import OnboardingCodexInstall from './OnboardingCodexInstaller';
import OnboardingGithubSetup from './OnboardingGithubSetup';
import { ONBOARDING_TOOLS } from './onboardingInfrastructure';
import { ONBOARDING_PROGRESS_PATH, PREPARATION_TOOLS, parseOnboardingProgress,
  type OnboardingProgress, type PreparationState, type PreparationTool } from './onboardingProgress';

const labels: Record<PreparationState,string> = {
  pending:'확인 전', missing:'설치 필요', installed:'설치 확인 · 로그인은 별도 확인',
  configured:'로그인 정보 있음 · 첫 작업 확인 필요',
  'needs-login':'로그인 필요', ready:'설치·로그인 확인', unknown:'현재 상태 확인 필요', deferred:'나중에 준비',
};
const button = 'min-h-11 rounded-xl border border-[var(--line)] px-4 py-2 text-sm disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]';

/** Durable preparation checklist. Installation and first-use verification follow separately. */
export default function OnboardingPreparation({onOpenFirstTask}:{onOpenFirstTask?:()=>void}) {
  const [progress,setProgress] = useState<OnboardingProgress|null>(null);
  const [selected,setSelected] = useState<PreparationTool[]>(['codex']);
  const [loaded,setLoaded] = useState(false);
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState('');
  const [editing,setEditing] = useState(false);
  const mounted = useRef(false);
  const inFlight = useRef(false);
  const controller = useRef<AbortController|null>(null);
  async function request(body?: Record<string,unknown>) {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError('');
    const abort = new AbortController(); controller.current = abort;
    const timer = setTimeout(()=>abort.abort(),15000);
    try {
      const response = await fetch(`${isTauri()?'http://127.0.0.1:3001':''}${ONBOARDING_PROGRESS_PATH}`, {
        method:body?'POST':'GET', headers:body?{'Content-Type':'application/json'}:undefined,
        body:body?JSON.stringify(body):undefined, signal:abort.signal, cache:'no-store',
      });
      // Older installed helpers may return HTML/404. Never treat that as empty progress.
      if (!(response.headers.get('content-type')??'').includes('application/json')) throw new Error('unavailable');
      const data = await response.json();
      if (!response.ok || data.success !== true) {
        if (response.status === 409) throw new Error('conflict');
        throw new Error('unavailable');
      }
      const next = data.progress === null ? null : parseOnboardingProgress(data.progress);
      if (mounted.current && controller.current === abort) {
        setProgress(next); setSelected(next?.steps.map(s=>s.tool)??['codex']); setLoaded(true); setEditing(false);
      }
    } catch (e) {
      if (mounted.current && controller.current === abort) setError(e instanceof Error && e.message === 'conflict'
        ? '다른 창의 변경이나 진행 중인 확인이 있습니다. 상태를 다시 읽고 이어가세요.'
        : '준비 기록을 확인하지 못했습니다. 앱과 연결을 확인한 뒤 다시 읽어 주세요. 기존 기록은 유지됩니다.');
    } finally {
      clearTimeout(timer);
      if (controller.current === abort) {
        inFlight.current = false;
        if (mounted.current) setBusy(false);
      }
    }
  }
  useEffect(()=>{
    mounted.current = true; void request();
    return ()=>{ mounted.current=false; controller.current?.abort(); controller.current=null; inFlight.current=false; };
  },[]);
  const save = () => request({operation:'plan',expectedRevision:progress?.revision??'0',tools:selected});
  const check = () => request({operation:'check',expectedRevision:progress?.revision});
  const defer = (tool:PreparationTool,deferred:boolean) => request({operation:'defer',expectedRevision:progress?.revision,tool,deferred});
  const current = progress?.steps.find(s=>s.state!=='ready' && s.state!=='deferred');
  const definition = ONBOARDING_TOOLS.find(t=>t.id===current?.tool);
  const choose = loaded && (!progress || editing);
  const allChecked = progress?.steps.every(s=>s.state==='ready') === true;
  return <section aria-label="이어서 준비하기" className="rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-5 text-[var(--ink)]">
    <h3 className="text-lg font-bold">필요한 도구부터, 하나씩</h3>
    <p className="mt-2 text-sm text-[var(--ink-2)]">AI 도구 하나로 시작해도 됩니다. 선택한 목록과 확인 결과는 이 기기에 저장됩니다.</p>
    {error && <div role="alert" className="mt-4 text-sm text-[var(--danger)]">{error}</div>}
    {(!loaded || error) && <button type="button" className={`${button} mt-3`} disabled={busy} onClick={()=>void request()}>{busy?'확인 중…':'상태 다시 읽기'}</button>}
    {choose && <>
      <fieldset disabled={busy} className="mt-4 grid gap-2 sm:grid-cols-2">
        <legend className="mb-2 text-sm font-semibold">사용할 도구 선택</legend>
        {PREPARATION_TOOLS.map(tool=><label key={tool} className="flex min-h-11 items-center gap-3 rounded-xl border border-[var(--line)] px-3 py-2">
          <input type="checkbox" checked={selected.includes(tool)} onChange={e=>setSelected(v=>e.target.checked?[...v,tool]:v.filter(t=>t!==tool))}/>
          {ONBOARDING_TOOLS.find(t=>t.id===tool)?.label??tool}
        </label>)}
      </fieldset>
      <button type="button" disabled={busy||!selected.length||!!error} className={`${button} mt-4 bg-[var(--accent)] text-[var(--on-accent)]`} onClick={()=>void save()}>준비 목록 저장</button>
      {progress && <button type="button" disabled={busy} className={`${button} ml-2`} onClick={()=>setEditing(false)}>취소</button>}
    </>}
    {loaded && progress && !editing && <>
      <div className="mt-4 rounded-xl bg-[var(--sunken)] p-4" aria-live="polite">
        <p className="text-sm font-semibold">{current?`지금 할 일 · ${definition?.label??current.tool}`:allChecked?'선택한 도구 상태를 확인했습니다':'남은 도구는 나중에 준비할 수 있습니다'}</p>
        <p className="mt-2 text-sm text-[var(--ink-2)]">{current?.state==='missing'
          ? isTauri()&&current.tool==='codex'?'아래 설치하기에서 Codex를 준비한 뒤 다음 단계로 이어가세요.':'공식 설치 안내에 따라 설치한 뒤, 아래에서 실제 상태를 확인하세요.'
          : current?.state==='configured'
          ? '저장된 로그인 정보가 있습니다. 아래 첫 AI 작업에서 실제 연결과 결과를 확인하세요.'
          : current?.state==='needs-login' || current?.state==='installed'
          ? isTauri()&&current?.tool==='codex'?'아래 ChatGPT 계정 연결에서 로그인을 진행하세요.':'공식 안내에서 로그인을 진행하세요. 설치 버전 확인만으로 로그인이나 첫 작업 성공을 판단하지 않습니다.'
          : current ? '설치와 로그인 상태를 먼저 확인하세요. 연결 문제는 설정을 지우지 않고 다시 확인할 수 있습니다.'
          : '이 목록은 도구 준비 확인입니다. 프로젝트 연결과 첫 작업 성공은 별도로 확인해야 합니다.'}</p>
        <div className="mt-4 flex flex-wrap gap-2">
          <button type="button" className={`${button} bg-[var(--accent)] text-[var(--on-accent)]`} disabled={busy||!!error} onClick={()=>void check()}>{busy?'실제 상태 확인 중…':progress.operation?'이전 확인 상태 다시 확인':'설치·로그인 상태 확인'}</button>
          {definition && <a href={definition.officialUrl} target="_blank" rel="noopener noreferrer" className={button}>공식 설치·로그인 안내</a>}
          {current && <button type="button" className={button} disabled={busy||!!error||!!progress.operation} onClick={()=>void defer(current.tool,true)}>이 도구는 나중에</button>}
        </div>
      </div>
      {isTauri()&&progress.steps.some(s=>s.tool==='codex'&&['pending','missing','unknown'].includes(s.state))&&<OnboardingCodexInstall onContinue={()=>void check()} />}
      {isTauri()&&progress.steps.some(s=>s.tool==='codex'&&['installed','needs-login','configured','ready'].includes(s.state))&&<OnboardingCodexLoginPanel onContinue={onOpenFirstTask??(()=>void check())} />}
      {progress.steps.some(s=>s.tool==='codex'&&s.state!=='deferred')&&<OnboardingCodexPreparation state={progress.steps.find(s=>s.tool==='codex')!.state} platform={progress.platform} onOpenFirstTask={onOpenFirstTask} preferAutomaticInstall={isTauri()&&progress.platform==='mac'} preferAutomaticLogin={isTauri()&&progress.platform==='mac'} />}
      {isTauri() && progress.steps.some(s=>s.tool==='github'&&s.state!=='deferred') && <OnboardingGithubSetup />}
      <ul className="mt-4 space-y-2 text-sm">{progress.steps.map(step=><li key={step.tool} className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--line)] py-2">
        <span>{ONBOARDING_TOOLS.find(t=>t.id===step.tool)?.label??step.tool} · {labels[step.state]}</span>
        {step.state==='deferred' && <button type="button" className={button} disabled={busy||!!error||!!progress.operation} onClick={()=>void defer(step.tool,false)}>이어서 준비</button>}
      </li>)}</ul>
      <button type="button" className={`${button} mt-3`} disabled={busy||!!error||!!progress.operation} onClick={()=>setEditing(true)}>사용할 도구 변경</button>
      <p className="mt-3 text-xs text-[var(--ink-3)]">준비 기록 저장: {new Date(progress.updatedAt).toLocaleString('ko-KR')}. 명령 복사나 안내 열기는 완료로 처리하지 않습니다.</p>
    </>}
  </section>;
}
