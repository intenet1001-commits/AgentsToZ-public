import type {MobileWorkspaceScope} from './mobileWorkspaceProtocol';
import {singleFlight} from './singleFlight';
import {AgentRuntimeClient} from '../packages/runtime-sdk/client';
import React, {useCallback,useEffect,useId,useMemo,useRef,useState} from 'react';
import {Plus, Square, RotateCw} from 'lucide-react';
import {Terminal} from '@xterm/xterm';
import {FitAddon} from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import './AiTerminalPanel.css';
import {AI_TERMINAL_AGENTS, AI_TERMINAL_PREFIX, type AiTerminalAgent,type AiTerminalRequest,type AiTerminalSummary} from './aiTerminalProtocol';
import {splitTerminalInput} from './aiTerminalInput';
import {localAiTerminalTransport,terminalLocalRequest,type AiTerminalTransport} from './aiTerminalClient';
import {TerminalMemoryStatus} from './TerminalMemoryStatus';
import {createTerminalRequester,createTerminalReadCadence} from './aiTerminalScheduling';
import {AI_INITIAL_PROMPT_MAX_BYTES,aiInitialPromptError,aiInitialPromptDraftError} from './aiInitialPrompt';
export interface AiTerminalEntry {nonce:number;targetId:string;prompt?:string;title?:string;agent?:AiTerminalAgent;sessionId?:string;resumeLatest?:boolean}
export function AiTerminalPanel({visible=true,projects:suppliedProjects,transport=localAiTerminalTransport,remote=false,entry,onManageProject,onWhatISaid,onRememberSession,sessionScope='local'}: {
 visible?:boolean;projects:{targetId:string;label:string}[];transport?:AiTerminalTransport;remote?:boolean;entry?:AiTerminalEntry|null;onManageProject?:(id:string)=>void;onWhatISaid?:()=>void;onRememberSession?:(id:string)=>void;sessionScope?:string;
}) {
 const promptId=useId();const promptField=useRef<HTMLTextAreaElement>(null);
 const [focusRequest,setFocusRequest]=useState(0);
 useEffect(()=>{if(visible&&focusRequest)promptField.current?.focus();},[visible,focusRequest]);
 const [targetReload,setTargetReload]=useState(0);const [targetError,setTargetError]=useState(false);
 const requestTargets=useMemo(()=>singleFlight(()=>new AgentRuntimeClient().targets()),[]);
 const [discovered,setDiscovered]=useState<{targetId:string;label:string;projectTargetId?:string}[]>([]);
 const projects=remote||!discovered.length?suppliedProjects:discovered;
 useEffect(()=>{
  if(remote||!visible)return;let stopped=false;let retry:ReturnType<typeof setTimeout>|undefined;let retryDelay=5000;
  const load=async()=>{try{const r=await requestTargets();if(!stopped){setDiscovered(r.targets);setTargetError(false)}}catch{if(!stopped){setTargetError(true);retry=setTimeout(load,retryDelay);retryDelay=Math.min(30000,retryDelay*2)}}};
  void load();return()=>{stopped=true;clearTimeout(retry)};
 },[remote,visible,targetReload,requestTargets]);
 const [sessions,setSessions]=useState<AiTerminalSummary[]>([]);const [selected,setSelected]=useState(()=>{try{return sessionStorage.getItem('agentstoz-terminal-selection:'+sessionScope)??''}catch{return ''}});
 const [showEnded,setShowEnded]=useState(false);
 const [dismissed,setDismissed]=useState<string[]>(()=>{try{const value=JSON.parse(sessionStorage.getItem('agentstoz-terminal-dismissed:'+sessionScope)??'[]');return Array.isArray(value)?value.filter(id=>typeof id==='string').slice(-24):[]}catch{return []}});
 useEffect(()=>{try{sessionStorage.setItem('agentstoz-terminal-dismissed:'+sessionScope,JSON.stringify(dismissed))}catch{}},[dismissed,sessionScope]);
 const sessionsRef=useRef(sessions);sessionsRef.current=sessions;
 const closing=useRef(new Set<string>());
 const inputPaused=useRef(new Set<string>());
 const inventoryEpoch=useRef(0);
 useEffect(()=>{try{sessionStorage.setItem('agentstoz-terminal-selection:'+sessionScope,selected)}catch{}},[selected,sessionScope]);
 const [target,setTarget]=useState(()=>{try{return sessionStorage.getItem('agentstoz-terminal-target:'+sessionScope)??''}catch{return ''}});
 const [agent,setAgent]=useState<AiTerminalAgent>(()=>{try{const saved=sessionStorage.getItem('agentstoz-terminal-agent:'+sessionScope);return AI_TERMINAL_AGENTS.includes(saved as AiTerminalAgent)?saved as AiTerminalAgent:'codex'}catch{return 'codex'}});
 useEffect(()=>{try{sessionStorage.setItem('agentstoz-terminal-target:'+sessionScope,target);sessionStorage.setItem('agentstoz-terminal-agent:'+sessionScope,agent)}catch{}},[target,agent,sessionScope]);
 const [prompt,setPrompt]=useState('');const [error,setError]=useState('');const [connectionError,setConnectionError]=useState('');const [readError,setReadError]=useState('');const [busy,setBusy]=useState(false);
 const [composerOpen,setComposerOpen]=useState(false);const [requestTitle,setRequestTitle]=useState('');
 const startBusy=useRef(false),draftGeneration=useRef(0),selectionGeneration=useRef(0);
 const pendingResume=useRef<{targetId:string;selection:number}|null>(null);
 const [resuming,setResuming]=useState(false);
 const latestEntryNonce=useRef(entry?.nonce);latestEntryNonce.current=entry?.nonce;
 const activeSession=sessions.find(s=>s.id===selected);
 const targetProject=projects.find(p=>p.targetId===target);
 const supportsPrompt=agent==='codex'||agent==='claude';
 const promptError=aiInitialPromptError(prompt);
 const canStart=!!targetProject&&(!prompt.trim()||supportsPrompt)&&!promptError&&!busy&&!resuming;
 const [connections,setConnections]=useState<{id:string;label:string;allowed:boolean;durable?:boolean;expiresAt?:string|null;workspaceScopes?:MobileWorkspaceScope[]}[]>([]);
 const [grantRoots,setGrantRoots]=useState<{workspaceRootId:string;name:string}[]>([]);
 const [workspaceScopes,setWorkspaceScopes]=useState<MobileWorkspaceScope[]>([]);
 const [grantRoot,setGrantRoot]=useState('');
 const host=useRef<HTMLDivElement>(null);const terminal=useRef<Terminal|null>(null);const fit=useRef<FitAddon|null>(null);
 const sendInput=useRef<((data:string)=>void)|null>(null);
 const flushInput=useRef<(()=>void)|null>(null);const wakeRead=useRef<(()=>void)|null>(null);
 const cursor=useRef(0);const generation=useRef(0);const applied=useRef<number|null>(null);
 const request=useMemo(()=>createTerminalRequester(transport,remote),[transport,remote]);
 const canWrite=useCallback((id:string)=>!closing.current.has(id)&&sessionsRef.current.some(s=>s.id===id&&s.state==='running'),[]);
 const refreshConnections=useMemo(()=>singleFlight(()=>terminalLocalRequest(AI_TERMINAL_PREFIX+'/access',{}).then(r=>{setConnections(r.connections??[]);setGrantRoots(r.workspaceRoots??[])}).catch(()=>{})),[]);
 useEffect(()=>{if(!target && projects.length)setTarget(projects[0]!.targetId)},[target,projects]);
 useEffect(()=>{if(entry && applied.current!==entry.nonce){if(entry.prompt&&prompt.trim()&&entry.prompt!==prompt&&!startBusy.current){applied.current=entry.nonce;setError('작성 중인 요청을 유지했습니다. 초안을 비운 뒤 발언을 다시 가져오세요.');return;}draftGeneration.current++;applied.current=entry.nonce;const invalid=aiInitialPromptDraftError(entry.prompt??'');if(invalid){setError(invalid+' 현재 초안은 유지했습니다.');return;}setTarget(entry.targetId);setPrompt(entry.prompt??'');setRequestTitle(entry.title??'');setComposerOpen(!!entry.prompt);if(entry.prompt)setFocusRequest(value=>value+1);setSelected(entry.sessionId??'');if(entry.agent)setAgent(entry.agent);
   pendingResume.current=entry.resumeLatest?{targetId:entry.targetId,selection:selectionGeneration.current}:null;
   setResuming(!!entry.resumeLatest);
 }},[entry]);
 const refresh=useMemo(()=>singleFlight(async(clearError=true)=>{const epoch=inventoryEpoch.current;try{const r=await request({operation:'list'});if(epoch!==inventoryEpoch.current)return;setSessions(old=>(r.sessions??[]).map(s=>old.find(prior=>prior.id===s.id&&prior.state==='exited')??s));
   const resume=pendingResume.current;pendingResume.current=null;setResuming(false);
   if(resume&&resume.selection===selectionGeneration.current){
    const latest=(r.sessions??[]).filter(s=>s.targetId===resume.targetId&&s.state==='running').sort((a,b)=>b.createdAt.localeCompare(a.createdAt))[0];
    setSelected(latest?.id??'');if(latest)setAgent(latest.agent);
   }else setSelected(current=>current && !(r.sessions??[]).some(s=>s.id===current)?'':current);
   setConnectionError('');if(clearError)setError('');
 }catch(e){if(epoch===inventoryEpoch.current)setConnectionError(String(e instanceof Error?e.message:e));}}),[request]);
 useEffect(()=>{
   if(!showEnded&&sessions.some(s=>s.id===selected&&s.state==='exited')){
     // A CLI can fail during startup. Keep its final output mounted so a
     // mobile user sees the reason instead of a terminal that disappears.
     setShowEnded(true);
   }
 },[sessions,selected,showEnded]);
 useEffect(()=>{if(!visible)return;void refresh();if(!remote){void refreshConnections();setTargetReload(value=>value+1)};const timer=!remote?setInterval(()=>void refreshConnections(),5000):undefined;return()=>clearInterval(timer);},[visible,refresh,remote,refreshConnections,entry?.nonce]);
 useEffect(()=>{if(!visible)return;const timer=setInterval(()=>void refresh(false),remote?5000:2000);return()=>clearInterval(timer);},[visible,remote,refresh]);
 const enqueue=useCallback((r:Omit<AiTerminalRequest,'requestId'>)=>{
   if(!r.sessionId||!canWrite(r.sessionId)||inputPaused.current.has(r.sessionId))return;
   // The requester owns the bounded FIFO. A second Promise chain here would
   // retain arbitrary pasted input and prevent close from reaching that FIFO.
   void request(r).then(()=>{if(r.operation==='input')wakeRead.current?.();})
    .catch(e=>{if(r.sessionId&&canWrite(r.sessionId))setError(e.message);});
 },[request,canWrite]);
 useEffect(()=>{
  if(!visible||!host.current||!activeSession)return;
  const t=new Terminal({fontFamily:'ui-monospace, SFMono-Regular, Menlo, monospace',fontSize:13,scrollback:2000,allowProposedApi:false,theme:{background:'#111315',foreground:'#e5e7eb'},cursorBlink:true,allowTransparency:false,disableStdin:activeSession.state!=='running'});
  const f=new FitAddon();t.loadAddon(f);t.open(host.current);terminal.current=t;fit.current=f;
  let pending='',inputTimer:ReturnType<typeof setTimeout>|undefined;
  const flush=()=>{clearTimeout(inputTimer);const data=pending;pending='';inputTimer=undefined;if(selected&&canWrite(selected))for(const part of splitTerminalInput(data))enqueue({operation:'input',sessionId:selected,data:part});};
  const acceptInput=(data:string)=>{if(!selected||inputPaused.current.has(selected)||!canWrite(selected))return;pending+=data;if(!inputTimer)inputTimer=setTimeout(flush,remote?180:8);};
  sendInput.current=acceptInput;flushInput.current=flush;const input=t.onData(acceptInput);
  let dimensions='';
  const resize=new ResizeObserver(()=>{if(!visible||!host.current?.clientWidth)return;f.fit();const next=t.cols+'x'+t.rows;if(selected&&canWrite(selected)&&next!==dimensions){dimensions=next;enqueue({operation:'resize',sessionId:selected,cols:Math.max(20,Math.min(300,t.cols)),rows:Math.max(5,Math.min(150,t.rows))});}});
  resize.observe(host.current);
  return()=>{sendInput.current=null;flushInput.current=null;flush();input.dispose();resize.disconnect();t.dispose();terminal.current=null;};
 },[selected,activeSession?.id,enqueue,visible,remote,canWrite]);
 useEffect(()=>{
  cursor.current=0;terminal.current?.reset();setReadError('');const mine=++generation.current;
  if(!visible||!activeSession)return;
  const cadence=createTerminalReadCadence(remote);
  let stopped=false,inFlight=false,wakePending=false;let timer:ReturnType<typeof setTimeout>;let releaseWrite:(()=>void)|undefined;let nextDelay=remote?700:120;let failures=0;
  const poll=async()=>{
   if(stopped||inFlight)return;inFlight=true;clearTimeout(timer);
   try {const r=await request({operation:'read',sessionId:selected,after:cursor.current});
    if(stopped||generation.current!==mine)return;
    setReadError('');failures=0;
    if(r.truncated){terminal.current?.reset();setError('이전 출력 일부가 보관 범위를 넘었습니다. Ctrl+L로 화면을 다시 그릴 수 있습니다.');}
    const chunks=(r.chunks??[]).filter(c=>c.seq>cursor.current);
    if(chunks.length){const screen=terminal.current;await new Promise<void>(resolve=>{releaseWrite=resolve;if(screen)screen.write(chunks.map(c=>c.text).join(''),resolve);else resolve();});releaseWrite=undefined;if(stopped||generation.current!==mine)return;cursor.current=chunks.at(-1)!.seq;}
    nextDelay=cadence.next(chunks.length>0,!!r.hasMore);
    if(r.session){setSessions(old=>old.map(s=>s.id===selected&&s.state!=='exited'?r.session!:s));if(r.session.state==='exited'&&!r.hasMore)return;}
   }catch(e){if(!stopped){setReadError(e instanceof Error?e.message:String(e));failures=Math.min(5,failures+1);nextDelay=Math.min(remote?10000:5000,500*2**(failures-1));}}
   finally{inFlight=false;}
   if(!stopped){timer=setTimeout(poll,wakePending?0:nextDelay);wakePending=false;}
  };wakeRead.current=()=>{if(stopped)return;cadence.wake();if(inFlight){wakePending=true;return;}clearTimeout(timer);timer=setTimeout(poll,0)};void poll();return()=>{stopped=true;wakeRead.current=null;clearTimeout(timer);releaseWrite?.()};
 },[selected,activeSession?.id,visible,request,remote]);
 const start=async()=>{
  if(!canStart||startBusy.current)return;
  startBusy.current=true;
  const draft=draftGeneration.current,nonce=latestEntryNonce.current,selection=selectionGeneration.current;
  const current=()=>draft===draftGeneration.current&&nonce===latestEntryNonce.current;
  inventoryEpoch.current++;setBusy(true);setError('');
  try{
   const r=await request({operation:'start',targetId:target,agent,cols:100,rows:28,...(prompt.trim()?{prompt}: {})});
   if(r.session){
    inventoryEpoch.current++;setSessions(s=>[...s.filter(x=>x.id!==r.session!.id),r.session!]);
    if(current()){
     // A response belongs to the submitted draft, not a newer explicit session
     // selection. Keep that terminal and its pending input mounted unchanged.
     if(selection===selectionGeneration.current)setSelected(r.session.id);
     setPrompt('');setRequestTitle('');setComposerOpen(false);
    }
   }
  }catch(e){if(current()&&selection===selectionGeneration.current)setError(e instanceof Error?e.message:String(e));}
  finally{inventoryEpoch.current++;startBusy.current=false;setBusy(false);}
 };
 const close=async()=>{
  inventoryEpoch.current++;const id=selected;const screen=terminal.current;
  if(!id||closing.current.has(id))return;
  setBusy(true);setError('');inputPaused.current.add(id);if(screen)screen.options.disableStdin=true;
  // An explicit stop cancels text not yet sent. A stalled input response must
  // not prevent the close request or block the next session's input chain.
  closing.current.add(id);flushInput.current?.();
  try{
   const response=await request({operation:'close',sessionId:id});
   const ended=response.session;
   if(!ended||ended.id!==id||ended.state!=='exited')throw new Error('세션 종료 상태를 확인하지 못했습니다. 새로고침해 주세요.');
   inventoryEpoch.current++;
   // React may not have rendered the refreshed list when queued callbacks run.
   // Fence those callbacks with the confirmed close result immediately.
   sessionsRef.current=sessionsRef.current.map(s=>s.id===id?ended:s);
   setSessions(old=>old.map(s=>s.id===id?ended:s));setError('');setShowEnded(false);
   setSelected(current=>current===id?sessionsRef.current.filter(s=>s.id!==id&&s.state==='running').at(-1)?.id??'':current);
   await refresh();
  }catch(e){setError(e instanceof Error?e.message:String(e));}
  finally{
   inventoryEpoch.current++;closing.current.delete(id);inputPaused.current.delete(id);
   if(screen&&terminal.current===screen)screen.options.disableStdin=!canWrite(id);setBusy(false);
  }
 };
 const runningSessions=sessions.filter(s=>s.state==='running'), endedSessions=sessions.filter(s=>s.state==='exited'&&!dismissed.includes(s.id));
 const visibleSessions=showEnded?sessions.filter(s=>s.state==='running'||!dismissed.includes(s.id)):runningSessions;
 useEffect(()=>{const screen=terminal.current;if(!screen)return;screen.options.disableStdin=!activeSession||activeSession.state!=='running';if(activeSession?.state==='running'){fit.current?.fit();enqueue({operation:'resize',sessionId:activeSession.id,cols:Math.max(20,Math.min(300,screen.cols)),rows:Math.max(5,Math.min(150,screen.rows))});}},[activeSession?.id,activeSession?.state,enqueue,visible]);
 const activeProject=projects.find(p=>p.targetId===(activeSession?.targetId??target));
 const remoteMemoryDraft=()=>{
  if(!activeProject||busy)return;
  if(prompt.trim()){setError('작성 중인 요청을 유지했습니다. 먼저 내용을 실행하거나 비운 뒤 세션 기억 요청을 여세요.');setComposerOpen(true);return;}
  draftGeneration.current++;setTarget(activeProject.targetId);setAgent(activeSession?.agent==='claude'?'claude':'codex');setComposerOpen(true);setFocusRequest(value=>value+1);setRequestTitle('세션 기억하기 · 실행 전 확인');setError('');
  setPrompt('이 프로젝트의 remember-session 스킬을 실행해 완료된 작업과 검증된 결정을 장기기억에 저장하세요. 실제 저장소와 기존 기억을 먼저 확인하고, 진행 중인 작업이나 잠금 또는 미확정 저장이 있으면 강제로 해제하거나 덮어쓰거나 재실행하지 말고 현재 상태를 설명하세요.');
 };
 const reviewMemory=(targetId:string)=>{if(prompt.trim()){setError('작성 중인 요청을 유지했습니다. 먼저 내용을 실행하거나 비운 뒤 저장 확인 요청을 여세요.');setComposerOpen(true);return;}draftGeneration.current++;setTarget(targetId);setSelected('');setAgent('codex');setComposerOpen(true);setFocusRequest(value=>value+1);setRequestTitle('세션 저장 확인');setPrompt('이 프로젝트의 워크룸 종료 후 세션 기억 저장 또는 백업이 완료되지 않았습니다. 실제 저장소 루트와 장기기억 상태를 읽고 원인을 확인하세요. 기존 기억과 Git 변경을 보존하고, 충돌은 양쪽 근거를 비교하여 초안을 제시하세요. 임의 force push, reset, 기억 덮어쓰기나 저장 재시도는 하지 말고 필요한 조치를 먼저 설명하세요.');};
 return <section className="ai-terminal-panel" data-testid="ai-terminal-panel">
  <header className="ai-terminal-head">
   <h2 className="ai-terminal-title">워크룸 <span className="ai-terminal-hint">AI 터미널</span></h2>
   <div className="ai-terminal-context-actions">
    {!remote&&onManageProject&&activeProject&&<button className="ai-terminal-btn" title={activeProject.label} onClick={()=>onManageProject(('projectTargetId' in activeProject ? activeProject.projectTargetId as string : undefined)??activeProject.targetId)}>프로젝트·장기기억</button>}
    {!remote&&onRememberSession&&activeProject&&<button data-testid="workroom-remember-session" className="ai-terminal-btn" onClick={()=>onRememberSession(activeProject.targetId)}>세션 기억하기…</button>}
    {remote&&activeProject&&<button data-testid="workroom-remote-remember-session" disabled={busy} className="ai-terminal-btn" onClick={()=>onRememberSession?onRememberSession(activeProject!.targetId):remoteMemoryDraft()}>세션 기억하기…</button>}
    {onWhatISaid&&<button className="ai-terminal-btn" onClick={onWhatISaid}>내가 한 말</button>}
   </div>
   <p className="ai-terminal-caption">프로젝트와 AI를 골라 작업을 시작하세요. 화면을 닫거나 탭을 옮겨도 실행 중인 세션은 유지됩니다.</p>
   <div className="ai-terminal-toolbar">
    <label className="ai-terminal-field ai-terminal-field--project"><span className="ai-terminal-label">프로젝트·워크트리</span>
     <select aria-label="터미널 프로젝트" value={target} disabled={busy} onChange={e=>setTarget(e.target.value)} className="ai-terminal-select ai-terminal-select--project"><option value="">프로젝트 선택</option>{target&&!targetProject&&<option value={target}>프로젝트 연결 확인 필요</option>}{projects.map(p=><option key={p.targetId} value={p.targetId}>{p.label}</option>)}</select>
    </label>
    <label className="ai-terminal-field"><span className="ai-terminal-label">AI</span>
     <select aria-label="터미널 AI" value={agent} disabled={busy} onChange={e=>setAgent(e.target.value as AiTerminalAgent)} className="ai-terminal-select">{AI_TERMINAL_AGENTS.map(a=><option key={a} value={a}>{a==='claude'?'Claude Code':a==='codex'?'Codex CLI':a==='agy'?'Antigravity': 'Hermes'}</option>)}</select>
    </label>
    <button disabled={!canStart} onClick={()=>void start()} className="ai-terminal-btn ai-terminal-start"><Plus size={14}/>{busy?'처리 중…':'새 터미널'}</button>
    <button disabled={busy} onClick={()=>{void refresh();if(!remote){void refreshConnections();setTargetReload(value=>value+1)}}} aria-label="터미널 새로고침" className="ai-terminal-btn ai-terminal-btn--icon"><RotateCw size={14}/></button>
   </div>
   {activeSession&&<p className="ai-terminal-caption" data-testid="workroom-target-context">현재 세션: {activeProject?.label??'프로젝트'} · 새 터미널: {targetProject?.label??'프로젝트 선택 필요'}</p>}
   {activeSession&&<button className="ai-terminal-btn" aria-expanded={composerOpen} onClick={()=>{if(!composerOpen)setFocusRequest(value=>value+1);setComposerOpen(value=>!value)}}>{composerOpen?'작업 요청 접기':prompt.trim()?'작성 중인 요청 다시 보기':'새 작업 요청 작성'}</button>}
   {activeSession&&!composerOpen&&!!prompt.trim()&&<p className="ai-terminal-caption">작성 중인 요청이 있습니다. 새 터미널을 열면 이 요청을 전달합니다.</p>}
   {!supportsPrompt&&!!prompt.trim()&&<p className="ai-terminal-caption" data-testid="workroom-prompt-support">작업 자동 전달은 Codex CLI·Claude Code에서 지원합니다. 입력한 내용은 유지됩니다. AI를 바꾸거나 내용을 비운 뒤 터미널을 열어 직접 입력하세요.</p>}
   {targetError&&<p className="ai-terminal-caption" role="alert">프로젝트·워크트리 목록을 갱신하지 못했습니다. 터미널 새로고침으로 다시 확인하세요.</p>}
  </header>
  {(error||connectionError||readError)&&<p role="alert" className="ai-terminal-error ai-terminal-launch-error">{error||connectionError||readError}</p>}
  {resuming&&<p className="ai-terminal-caption" role="status">{targetProject?.label??'선택한 프로젝트'}의 실행 중인 세션을 확인하고 있습니다. 연결이 지연되면 터미널 새로고침으로 다시 확인하세요.</p>}
  {(!activeSession||composerOpen)&&<div className="ai-terminal-prompt" data-testid="workroom-composer">
   <label className="ai-terminal-label" htmlFor={promptId}>{requestTitle||'어떤 작업을 할까요?'}</label>
   <textarea ref={promptField} id={promptId} aria-label="터미널에 전달할 작업" value={prompt} disabled={busy} onChange={e=>{const invalid=aiInitialPromptDraftError(e.target.value);if(invalid){setError(invalid+' 현재 초안은 유지했습니다.');return;}draftGeneration.current++;setPrompt(e.target.value)}} placeholder="작업을 적으면 선택한 AI에 전달합니다. 비워 두고 터미널만 열어도 됩니다." className="ai-terminal-textarea"/>
   <p className="ai-terminal-hint">{prompt.length>AI_INITIAL_PROMPT_MAX_BYTES?'24,000 초과':new TextEncoder().encode(prompt).length.toLocaleString('ko-KR')} / 24,000바이트</p>
   {promptError&&<p role="alert" className="ai-terminal-error">{promptError}</p>}
   {remote&&requestTitle==='세션 기억하기 · 실행 전 확인'&&<p className="ai-terminal-hint" data-testid="workroom-remote-memory-guide">요청과 프로젝트를 확인하고 ‘선택한 AI로 시작’을 누르세요. 새 AI 세션에서 저장을 요청하며, 버튼을 누르는 것만으로 저장이 완료되지는 않습니다.</p>}
   <p className="ai-terminal-hint">{targetProject?`${targetProject.label}에서 ${agent==='codex'?'Codex CLI':agent==='claude'?'Claude Code':agent==='agy'?'Antigravity':'Hermes'}로 시작합니다.`:'등록된 프로젝트·워크트리를 선택해 주세요.'}</p>
   {agent==='codex'&&<p className="ai-terminal-hint">Codex의 $ 스킬 목록은 새 터미널을 연 뒤 터미널 안에서 사용할 수 있습니다. 이 입력칸은 작업 내용을 전달합니다.</p>}
   {!!prompt.trim()&&<button className="ai-terminal-btn ai-terminal-start" disabled={!canStart} onClick={()=>void start()}>선택한 AI로 시작</button>}
  </div>}
  {!!sessions.length&&<div className={`ai-terminal-workspace${activeSession?'':' ai-terminal-workspace--idle'}`}>
  <aside className="ai-terminal-session-list"><h3>작업 세션 <span>{runningSessions.length}</span></h3>
  {!!endedSessions.length&&<button className="ai-terminal-btn" aria-pressed={showEnded} onClick={()=>setShowEnded(value=>!value)}>{showEnded?'종료된 세션 숨기기':'종료된 세션 보기'} ({endedSessions.length})</button>}
  <div className="ai-terminal-tabs" role="tablist" aria-label="터미널 세션">{visibleSessions.map(s=><button role="tab" aria-selected={s.id===selected} key={s.id} onClick={()=>{selectionGeneration.current++;setError('');setSelected(s.id)}} className={`ai-terminal-tab${s.state==='running'?'':' ai-terminal-tab--ended'}`}><span className={`ai-terminal-dot${s.state==='running'?' ai-terminal-dot--running':''}`} aria-hidden="true"/>{projects.find(p=>p.targetId===s.targetId)?.label??'프로젝트'} · {s.agent}<span className="ai-terminal-tab-state">{s.state==='running'?'실행 중':`종료 ${s.exitCode??''}`}</span></button>)}</div></aside>
  <div className="ai-terminal-body">
   {activeSession?<>
   <div className="ai-terminal-current">{activeProject?.label??'프로젝트'} · {activeSession.agent}</div>
   {activeSession.state==='exited'&&<p className="ai-terminal-hint" role="status">터미널이 종료되었습니다 (종료 코드 {activeSession.exitCode??'확인 중'}). 위 설정에서 새 터미널을 열 수 있습니다. 마지막 출력과 세션 저장 기록은 유지됩니다.</p>}
   {activeSession.state==='exited'&&<button data-testid="workroom-dismiss-session" className="ai-terminal-btn" onClick={()=>{setDismissed(ids=>[...ids.filter(id=>id!==selected),selected].slice(-24));setSelected('')}}>종료된 세션 목록에서 제거</button>}
   <div className="ai-terminal-surface" style={{height:remote?400:'55vh'}}><div ref={host} className="ai-terminal-screen"/></div>
   <div className="ai-terminal-keys">{['Esc','Tab','↑','↓','Ctrl+C','Ctrl+L','Enter'].map(key=><button disabled={activeSession.state!=='running'||busy} key={key} className="ai-terminal-key" onClick={()=>sendInput.current?.(({'Esc':'\x1b','Tab':'\t','↑':'\x1b[A','↓':'\x1b[B','Ctrl+C':'\x03','Ctrl+L':'\x0c','Enter':'\r'} as Record<string,string>)[key]!)}>{key}</button>)}<button disabled={activeSession.state!=='running'||busy} onClick={()=>void close()} className="ai-terminal-btn ai-terminal-btn--danger ai-terminal-close"><Square size={12}/>세션 종료</button></div>
   </>:<p className="ai-terminal-hint">{runningSessions.length?'작업 세션을 선택하면 이어서 입력할 수 있습니다.':'실행 중인 세션이 없습니다. 종료된 세션은 기록만 확인할 수 있습니다.'}</p>}
  </div>
  </div>}
  {!remote&&<TerminalMemoryStatus visible={visible} projects={projects} observationTargetId={activeSession?.targetId||target||undefined} onReview={reviewMemory} onManageProject={onManageProject}/>}
  {!remote&&connections.length>0&&<details className="ai-terminal-access"><summary>이 기기의 워크룸 작업 허용</summary><p>선택한 프로젝트에서 CLI 입력과 출력을 허용합니다. 연결의 남은 유효기간 동안 최대 30일 유지되며, 화면 잠금이나 앱 재시작 후에도 다시 승인하지 않습니다. 터미널에 표시되는 경로·계정 정보도 전송될 수 있습니다.</p><label>허용 범위<select value={grantRoot} onChange={e=>setGrantRoot(e.target.value)}><option value="">선택 프로젝트: {targetProject?.label??'프로젝트를 먼저 선택하세요'}</option>{grantRoots.map(r=><option key={r.workspaceRootId} value={r.workspaceRootId}>{r.name} · 이 기기가 새로 만든 프로젝트</option>)}</select></label><fieldset><legend>이 프로젝트에서 함께 허용할 모바일 기능</legend>{([['records.read','내가 한 말 조회'],['memory.save','세션 기억 저장'],['duty.manage','승인된 대직 방 관리'],['worktree.manage','병합된 워크트리 정리']] as const).map(([scope,label])=><label key={scope}><input type="checkbox" checked={workspaceScopes.includes(scope)} onChange={e=>setWorkspaceScopes(current=>e.target.checked?[...current,scope]:current.filter(s=>s!==scope))}/>{label}</label>)}</fieldset>{connections.map(c=><label key={c.id}><input type="checkbox" checked={c.allowed} disabled={!grantRoot&&!targetProject&&!c.allowed} onChange={async e=>{try{const r=await terminalLocalRequest(AI_TERMINAL_PREFIX+'/access',{owner:c.id,enabled:e.target.checked,rememberDevice:true,workspaceScopes,...(grantRoot?{workspaceRootIds:[grantRoot]}:{targetIds:target?[target]:[]})});setConnections(r.connections)}catch(e){setError(String(e))}}}/>{c.label}{c.durable&&c.expiresAt&&<span> · {new Date(c.expiresAt).toLocaleDateString()}까지</span>}<span> · 기록 {c.workspaceScopes?.includes('records.read')?'허용':'미허용'} · 저장 {c.workspaceScopes?.includes('memory.save')?'허용':'미허용'} · 대직 {c.workspaceScopes?.includes('duty.manage')?'허용':'미허용'}</span><button type="button" disabled={!grantRoot&&!targetProject} onClick={async()=>{try{const r=await terminalLocalRequest(AI_TERMINAL_PREFIX+'/access',{owner:c.id,enabled:true,rememberDevice:true,workspaceScopes,...(grantRoot?{workspaceRootIds:[grantRoot]}:{targetIds:target?[target]:[]})});setConnections(r.connections)}catch(e){setError(String(e))}}}>선택한 범위·권한 적용</button></label>)}</details>}
 </section>;
}
