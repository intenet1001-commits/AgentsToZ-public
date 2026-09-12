import {useEffect, useId, useMemo, useRef, useState} from 'react';
import {localAiTerminalTransport} from './aiTerminalClient';
import type {AiTerminalAgent, AiTerminalSummary} from './aiTerminalProtocol';
import {AgentRuntimeClient} from '../packages/runtime-sdk/client';
import {AI_INITIAL_PROMPT_MAX_BYTES, aiInitialPromptDraftError, aiInitialPromptError} from './aiInitialPrompt';
import {useDocumentVisible} from './useDocumentVisible';
import {aiWorkTargetDisplayName,buildAiWorkMissionPrompt,type AiWorkMode,type AiWorkOrchestrationPolicy} from './aiWorkOrchestration';

export interface AiWorkRequest {nonce:number;targetId:string;title:string;prompt:string}
type WorkTarget = {targetId:string;label:string};

/** An incomplete Git inventory cannot prove that a previously known target vanished. */
export function mergeAiWorkTargets(current:readonly WorkTarget[], incoming:readonly WorkTarget[], complete:boolean): WorkTarget[] {
  if (complete) return [...incoming];
  const merged = new Map(current.map(project => [project.targetId, project]));
  for (const project of incoming) merged.set(project.targetId, project);
  return [...merged.values()];
}

/** Review a request first; only the explicit start action creates a CLI session. */
export function AiWorkRequestPanel({projects:suppliedProjects, entry, onStarted, onOpenWorkroom, visible}: {
  projects:WorkTarget[];
  visible:boolean;
  entry:AiWorkRequest|null;
  onStarted:(session:AiTerminalSummary)=>void;
  onOpenWorkroom?:()=>void;
}) {
  const client = useMemo(() => new AgentRuntimeClient(), []);
  const documentVisible = useDocumentVisible();
  const observing = visible && documentVisible;
  const [discovered,setDiscovered] = useState<WorkTarget[]|null>(null);
  const [targetReload,setTargetReload] = useState(0);
  const [targetLoading,setTargetLoading] = useState(false);
  const [targetError,setTargetError] = useState('');
  const [targetStatus,setTargetStatus] = useState('');
  const projects = discovered ?? suppliedProjects;
  // Parent status polls must not abort discovery if selectable IDs/labels are unchanged.
  const suppliedKey = JSON.stringify(suppliedProjects.map(({targetId,label}) => [targetId,label]));
  const suppliedRef = useRef(suppliedProjects);
  suppliedRef.current = suppliedProjects;
  useEffect(() => {
    if (!observing) return;
    const controller = new AbortController();
    let stopped = false;
    setTargetLoading(true);
    void client.targets({signal:controller.signal}).then(result => {
      if (stopped) return;
      setDiscovered(current => mergeAiWorkTargets(current ?? suppliedRef.current, result.targets, result.complete));
      setTargetError('');
      setTargetStatus(result.complete ? '' : '일부 워크트리 상태를 확인하지 못해 마지막 목록을 유지합니다. 실행 직전에 대상을 다시 검증합니다.');
    }).catch(() => {
      if (!stopped) setTargetError('프로젝트 목록을 불러오지 못했습니다. 마지막 목록을 유지합니다. 다시 확인해 주세요.');
    }).finally(() => { if (!stopped) setTargetLoading(false); });
    return () => { stopped = true; controller.abort(); };
  }, [client, observing, entry?.nonce, targetReload, suppliedKey]);

  const [target,setTarget] = useState('');
  const [agent,setAgent] = useState<AiTerminalAgent>('codex');
  const [mode,setMode] = useState<AiWorkMode>('direct');
  const [policy,setPolicy] = useState<AiWorkOrchestrationPolicy>('agentstoz');
  const [workers,setWorkers] = useState<AiTerminalAgent[]>(['codex','claude','hermes','agy']);
  const [prompt,setPrompt] = useState('');
  const [title,setTitle] = useState('새 AI 작업');
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState('');
  const [inputError,setInputError] = useState('');
  // Only one previous receipt is retained; terminal inventory owns session history.
  const [receipt,setReceipt] = useState<{session:AiTerminalSummary|null;title:string}|null>(null);
  const pending = useRef<{fingerprint:string;requestId:string}|null>(null);
  const inFlight = useRef(false);
  const revision = useRef(0);
  const appliedEntry = useRef<number|null>(null);
  const latestEntryNonce = useRef(entry?.nonce ?? null);
  latestEntryNonce.current = entry?.nonce ?? null;
  const shown = useRef(observing);
  shown.current = observing;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const field = useRef<HTMLTextAreaElement>(null);
  const focusEntry = useRef<number|null>(null);
  const promptHelpId = useId();
  useEffect(() => {
    if (!entry || appliedEntry.current === entry.nonce) return;
    appliedEntry.current = entry.nonce;
    revision.current += 1;
    const invalid = aiInitialPromptDraftError(entry.prompt);
    if (invalid) {
      setInputError(`전달된 요청을 열지 못했습니다. ${invalid} 현재 초안은 유지했습니다.`);
      return;
    }
    setTarget(entry.targetId);setTitle(entry.title);setPrompt(entry.prompt);setError('');setInputError('');
    focusEntry.current = entry.nonce;
  }, [entry]);
  useEffect(() => {
    if (!observing || busy || focusEntry.current === null) return;
    field.current?.focus();focusEntry.current = null;
  }, [entry,observing,busy]);
  const known = projects.some(project => project.targetId === target);
  const targetProject=projects.find(project=>project.targetId===target);
  const controlProject=projects.find(project=>project.label.split(' · ')[0]?.trim()==='AgentsToZ-Control');
  const executionPrompt=useMemo(()=>mode==='mission'&&targetProject?buildAiWorkMissionPrompt({title,goal:prompt,targetLabel:aiWorkTargetDisplayName(targetProject.label),workers,policy}):prompt,[mode,targetProject,title,prompt,workers,policy]);
  const validationError = useMemo(() => aiInitialPromptError(executionPrompt), [executionPrompt]);
  const bytes = useMemo(() => new TextEncoder().encode(executionPrompt).length, [executionPrompt]);
  const ready=known&&!!prompt.trim()&&(!validationError)&&(!inputError)&&(mode==='direct'||!!controlProject&&workers.length>0);

  const start = async () => {
    if (inFlight.current || !ready) return;
    inFlight.current = true;setBusy(true);setError('');
    const submitted = {revision:revision.current, nonce:latestEntryNonce.current, title};
    const isCurrent = () => submitted.revision === revision.current && submitted.nonce === latestEntryNonce.current;
    try {
      const launchTarget=mode==='mission'?controlProject!.targetId:target;
      const fingerprint = JSON.stringify([launchTarget,agent,executionPrompt]);
      if (pending.current?.fingerprint !== fingerprint) pending.current = {fingerprint,requestId:crypto.randomUUID()};
      const result = await localAiTerminalTransport({operation:'start',requestId:pending.current.requestId,targetId:launchTarget,agent,prompt:executionPrompt,cols:100,rows:28});
      if (!result.session) throw new Error('실행 결과를 확인하지 못했습니다. 같은 요청으로 다시 확인할 수 있습니다.');
      pending.current = null;
      if (!mounted.current) return;
      if (isCurrent()) {
        revision.current += 1;
        setPrompt('');setInputError('');
        if (shown.current) { setReceipt(null);onStarted(result.session);return; }
      }
      // A's late response cannot erase B's draft or take over another tab.
      setReceipt({session:result.session,title:submitted.title});
    } catch (error) {
      if (!mounted.current) return;
      if (isCurrent()) setError(error instanceof Error ? error.message : String(error));
      else setReceipt({session:null,title:submitted.title});
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  return <section data-testid="ai-work-request" className="shrink-0 rounded-xl border border-[var(--line)] bg-[var(--surface)] p-4 text-[var(--ink)]">
    <h2 className="text-sm font-bold">{title}</h2>
    <p className="my-2 text-xs text-[var(--ink-3)]">직접 실행은 한 CLI에 작업을 맡깁니다. 미션 관제는 AgentsToZ-Control에서 여러 Workroom 에이전트에 배정하고 결과를 검증합니다.</p>
    <div className="mb-2 flex flex-wrap gap-2">
      <select aria-label="AI 작업 실행 방식" className="max-w-full bg-[var(--sunken)] p-2" value={mode} disabled={busy} onChange={event=>{revision.current+=1;setMode(event.target.value as AiWorkMode);}}><option value="direct">단일 AI 직접 실행</option><option value="mission">AgentsToZ 미션 관제</option></select>
      {mode==='mission'&&<select aria-label="AI 작업 관제 전략" className="max-w-full bg-[var(--sunken)] p-2" value={policy} disabled={busy} onChange={event=>{revision.current+=1;setPolicy(event.target.value as AiWorkOrchestrationPolicy);}}><option value="agentstoz">AgentsToZ 기본 관제</option><option value="cs-ceo">AgentsToZ + CS-CEO</option></select>}
    </div>
    <div className="flex flex-wrap gap-2">
      <select aria-label="AI 작업 프로젝트" className="min-w-0 max-w-full flex-1 bg-[var(--sunken)] p-2" value={target} disabled={busy} onChange={event=>{revision.current+=1;setTarget(event.target.value);}}>
        <option value="">프로젝트 선택</option>
        {target&&!known&&<option value={target}>프로젝트 등록 확인 필요</option>}
        {projects.map(project=><option key={project.targetId} value={project.targetId}>{project.label}</option>)}
      </select>
      <select aria-label="AI 작업 모델 제공자" className="max-w-full bg-[var(--sunken)] p-2" value={agent} disabled={busy} onChange={event=>{revision.current+=1;setAgent(event.target.value as AiTerminalAgent);}}><option value="codex">Codex CLI</option><option value="claude">Claude Code</option></select>
      <button type="button" data-testid="ai-work-targets-refresh" className="rounded-lg border border-[var(--line)] px-3 py-2 text-xs disabled:opacity-40" disabled={targetLoading||!observing} onClick={()=>setTargetReload(value=>value+1)}>{targetLoading?'확인 중…':'프로젝트 다시 확인'}</button>
    </div>
    {targetError&&<p role="alert" className="my-2 text-xs text-red-400">{targetError}</p>}
    {targetStatus&&<p role="status" className="my-2 text-xs text-[var(--ink-3)]">{targetStatus}</p>}
    {mode==='mission'&&<fieldset className="my-2 rounded-lg border border-[var(--line)] p-2 text-xs"><legend>하위 에이전트</legend><div className="flex flex-wrap gap-3">{(['codex','claude','hermes','agy'] as AiTerminalAgent[]).map(value=><label key={value}><input type="checkbox" checked={workers.includes(value)} disabled={busy} onChange={event=>{revision.current+=1;setWorkers(current=>event.target.checked?[...current,value]:current.filter(agent=>agent!==value));}}/> {value==='codex'?'Codex':value==='claude'?'Claude Code':value==='hermes'?'Hermes':'Antigravity'}</label>)}</div></fieldset>}
    {mode==='mission'&&<p className="mb-2 text-xs text-[var(--ink-3)]">Control·대상 프로젝트 기억을 읽고, 선택한 CLI의 Workroom 세션을 사용합니다. 중단 후에는 자동 재전송하지 않고 미션 기록을 확인해 재개합니다.</p>}
    {mode==='mission'&&!controlProject&&<p role="alert" className="my-2 text-xs text-red-400">등록된 AgentsToZ-Control 프로젝트가 필요합니다.</p>}
    <textarea ref={field} aria-label="AI 작업 요청" aria-describedby={promptHelpId} aria-invalid={!!(inputError||validationError)} className="my-2 min-h-28 w-full resize-y rounded-lg bg-[var(--sunken)] p-3 text-sm" value={prompt} disabled={busy} onChange={event=>{
      const invalid=aiInitialPromptDraftError(event.target.value);
      if(invalid){setInputError(`${invalid} 현재 초안은 유지했습니다.`);return;}
      revision.current+=1;setPrompt(event.target.value);setInputError('');setError('');
    }} placeholder="AI에게 요청할 작업을 입력하세요."/>
    <p id={promptHelpId} className="mb-2 text-xs text-[var(--ink-3)]">{bytes.toLocaleString('ko-KR')} / {AI_INITIAL_PROMPT_MAX_BYTES.toLocaleString('ko-KR')}바이트 실행 한도 · 한글과 이모지는 여러 바이트를 사용합니다.</p>
    {(inputError||validationError)&&<p role="alert" className="my-2 text-sm text-red-400">{inputError||validationError}</p>}
    {error&&<p role="alert" className="my-2 text-sm text-red-400">{error}</p>}
    <button type="button" data-testid="ai-work-request-start" className="rounded-lg border border-[var(--line)] px-3 py-2 text-sm disabled:opacity-40" disabled={busy||!ready} onClick={()=>void start()}>{busy?'시작 중…':mode==='mission'?'관제 미션 시작':'워크룸에서 실행'}</button>
    {receipt&&<div data-testid="ai-work-previous-receipt" className="mt-3 rounded-lg border border-[var(--line)] p-3 text-xs">
      <p role="status" className="break-words">{receipt.session?`이전 요청 “${receipt.title}”이 시작되었습니다. 워크룸에서 이어서 확인할 수 있습니다.`:`이전 요청 “${receipt.title}”의 시작 결과를 확인하지 못했습니다. 다시 실행하기 전에 워크룸의 세션을 확인해 주세요.`}</p>
      {(receipt.session||onOpenWorkroom)&&<button type="button" className="mt-2 rounded border border-[var(--line)] px-2 py-1" onClick={()=>{if(receipt.session)onStarted(receipt.session);else onOpenWorkroom?.();}}>이전 요청 워크룸 열기</button>}
      <button type="button" aria-label="이전 요청 알림 닫기" className="ml-2 mt-2 rounded border border-[var(--line)] px-2 py-1" onClick={()=>setReceipt(null)}>알림 닫기</button>
    </div>}
  </section>;
}
